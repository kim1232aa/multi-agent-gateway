/**
 * facade:把 Codex / Claude 两个风格不同的 adapter 统一包成 types.ts 的
 * ProviderAdapter 接口。Kimi 路径不走这里(由 kimi-proxy 无损代理)。
 *
 * - Codex:常驻 JSON-RPC 进程,startTurn 返回流式事件队列。
 * - Claude:每 turn spawn 一次 CLI,回调式事件;facade 把回调聚成 AsyncIterable。
 *
 * 只在这里做协议映射,不改两个 adapter 的内部实现(它们已各自实测通过)。
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { CodexAdapter, type CodexEvent } from './codex-adapter.js';
import { ClaudeAdapter, type ClaudeAdapterEvent } from './claude-adapter.js';
import { expandCodexSkill, listClaudeCommands, listCodexCommands } from './native-commands.js';
import { findCodexRollout } from './local-transcript.js';
import { SettingsStore } from './settings-store.js';
import {
  ProviderError,
  type ApprovalDecision,
  type CreateSessionInput,
  type GatewayEvent,
  type HistoryQuery,
  type ListSessionsQuery,
  type Message,
  type MessageContentPart,
  type NativeCommand,
  type NativeModel,
  type ProviderAdapter,
  type ProviderCapabilities,
  type Session,
  type SessionPage,
  type SessionUsage,
  type StartTurnInput,
  type TurnAttachment,
  type TurnHandle,
} from './types.js';

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function workspaceIdFromCwd(cwd: string, provider: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root';
  return `wd_${provider}_${slug}`.slice(0, 60);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isCodexToolItem(type: unknown): boolean {
  return type === 'commandExecution'
    || type === 'mcpToolCall'
    || type === 'fileChange'
    || type === 'webSearch'
    || type === 'dynamicToolCall'
    || type === 'imageView'
    || type === 'collabToolCall';
}

/**
 * kap-server 的附件物化话术:目标 provider 没有对应输入项时(文件/视频),
 * 以路径文本交给模型,让它自己用 Read 工具打开。
 */
function fileAttachText(a: TurnAttachment): string {
  const mime = a.mediaType ?? 'application/octet-stream';
  const size = a.size ?? 0;
  const name = a.name ?? a.path?.split('/').pop() ?? 'file';
  return `Attached file "${name}" (${mime}, ${size} bytes): ${a.path} — open it with the Read tool`;
}

/**
 * 把网关附件翻译成 codex turn/start 的 input items:
 * localImage/image 是原生项;filePathText 物化成文本项。prompt 文本殿后。
 */
function codexInputItems(prompt: string, attachments: TurnAttachment[]): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const a of attachments) {
    if (a.kind === 'localImage' && a.path) {
      items.push({ type: 'localImage', path: a.path });
    } else if (a.kind === 'imageDataUrl' && a.dataUrl) {
      items.push({ type: 'image', url: a.dataUrl });
    } else if (a.kind === 'filePathText' && a.path) {
      items.push({ type: 'text', text: fileAttachText(a), text_elements: [] });
    }
  }
  if (prompt.trim()) items.push({ type: 'text', text: prompt, text_elements: [] });
  return items;
}

/** 把一个事件 push 队列包装成 AsyncIterable,终态后结束。 */
class EventStream<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiter: ((r: IteratorResult<T>) => void) | null = null;
  private finished = false;

  push(event: T): void {
    if (this.finished) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: event, done: false });
    } else {
      this.buffer.push(event);
    }
  }

  end(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve) => {
          const buffered = this.buffer.shift();
          if (buffered !== undefined) return resolve({ value: buffered, done: false });
          if (this.finished) return resolve({ value: undefined as never, done: true });
          this.waiter = resolve;
        }),
    };
  }
}

function textOfInput(input: StartTurnInput['input']): string {
  if (typeof input === 'string') return input;
  return input
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Codex → ProviderAdapter
// ---------------------------------------------------------------------------

export class CodexProviderAdapter implements ProviderAdapter {
  readonly name = 'codex' as const;
  private readonly inner: CodexAdapter;
  /** 会话级设置持久化(重启不丢;只读路径回落 undefined = 未设置)。 */
  private readonly settings: SettingsStore;

  constructor(options?: ConstructorParameters<typeof CodexAdapter>[0] & { settingsPath?: string }) {
    const { settingsPath, ...innerOptions } = options ?? {};
    this.inner = new CodexAdapter(innerOptions);
    this.settings = new SettingsStore(settingsPath);
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      thinking: true,
      tools: true,
      approvals: true,
      questions: true,
      interrupt: true,
      history: true,
    };
  }

  /**
   * thread/list 服务端每次全扫 rollout 文件,本机 73 线程实测 ~4s。
   * 常见查询(无 cursor、limit≤100)共享同一份全量页缓存(10s TTL),
   * 并合并并发冷调用;create/startTurn 使缓存失效。
   */
  private fullPage: { ts: number; page: SessionPage } | null = null;
  private fullPageInflight: Promise<SessionPage> | null = null;
  /** 缓存代际:create/startTurn 使缓存失效时递增,防止在飞旧请求写回过期页。 */
  private fullPageGen = 0;
  private static readonly LIST_TTL_MS = 30_000;

  async list(query: ListSessionsQuery = {}): Promise<SessionPage> {
    if (query.limit === 100 && query.cursor == null && query.archived == null && query.cwd == null) {
      return this.cachedFullPage();
    }
    return this.fetchPage(query);
  }

  private cachedFullPage(): Promise<SessionPage> {
    if (this.fullPage && Date.now() - this.fullPage.ts < CodexProviderAdapter.LIST_TTL_MS) {
      return Promise.resolve(this.fullPage.page);
    }
    const gen = this.fullPageGen;
    this.fullPageInflight ??= this.fetchPage({ limit: 100 }).then(
      (page) => {
        // 空页不入缓存:app-server 刚 spawn 时索引未就绪可能暂时返回 0 条
        // (实测预热阶段出现过),缓存空页会把"没有会话"的假象扩散 10s。
        // 代际已变(create/startTurn 失效过)的在飞结果同样不写回,否则过期
        // 页会再顶 30s(审查发现)。
        if (gen === this.fullPageGen && (page.items.length > 0 || page.next_cursor)) {
          this.fullPage = { ts: Date.now(), page };
        }
        this.fullPageInflight = null;
        return page;
      },
      (err) => {
        this.fullPageInflight = null;
        throw err;
      },
    );
    return this.fullPageInflight;
  }

  /** 列表缓存失效(create/startTurn 后列表内容已变)。 */
  private invalidateListCache(): void {
    this.fullPage = null;
    this.fullPageGen += 1;
  }

  private async fetchPage(query: ListSessionsQuery): Promise<SessionPage> {
    const { threads, nextCursor } = await this.inner.list({
      cursor: query.cursor,
      limit: query.limit,
      cwd: query.cwd,
      archived: query.archived,
      sourceKinds: ['cli'],
    });
    // 只列主会话,对齐 `codex resume` 的行为:parentThreadId 非空的是子 agent
    // 线程,ephemeral 是临时线程,都不应出现在列表里(字段名来自 thread/list
    // 原始响应,已实测 0.147.0)。
    const items = threads
      .filter((t) => {
        const raw = t as Record<string, unknown>;
        return raw.parentThreadId == null && raw.ephemeral !== true;
      })
      .map((t) => this.toSession(t));
    return { items, ...(nextCursor ? { next_cursor: nextCursor } : {}) };
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const cwd = input.cwd ?? (input.metadata?.cwd as string | undefined) ?? process.cwd();
    const thread = await this.inner.create({ cwd });
    // app-server 的 thread/start 不带标题参数;用户指定的标题存 renames,
    // toSession 优先取它(否则 create 响应和列表都退回 preview/截断 id)。
    if (input.title) this.renames.set(thread.id as string, input.title);
    // 空 thread 不落盘、不进 thread/list(实测 0.147.0):cwd 记内存,网关
    // getSession 兜底才不会造 HOME 假目录(F9)。
    this.threadCwd.set(thread.id as string, cwd);
    this.invalidateListCache(); // 新线程,列表缓存失效
    return this.toSession(thread, cwd);
  }

  /** 网关 getSession 兜底用:新建未落盘的会话也能拿到真实 cwd。 */
  getCwd(sessionId: string): string | undefined {
    return this.threadCwd.get(sessionId);
  }

  // thread/read 对大会话是秒级(901MB rollout 实测 9.4s),而页面加载会并发打
  // 2-3 个 getHistory。rollout 文件是真相源:按 mtimeMs:size 做缓存键,没变就
  // 复用同一个 Promise(并发合并),变了自然失效;失败删缓存不毒化。
  private historyCache = new Map<string, { key: string; p: Promise<Message[]> }>();

  async getHistory(sessionId: string, _query: HistoryQuery = {}): Promise<Message[]> {
    const rollout = await findCodexRollout(sessionId);
    const stat = rollout ? await fsp.stat(rollout).catch(() => null) : null;
    if (!stat) return this.readCodexHistory(sessionId); // 未落盘新线程,不缓存
    const key = `${stat.mtimeMs}:${stat.size}`;
    const hit = this.historyCache.get(sessionId);
    if (hit && hit.key === key) return hit.p;
    const p = this.readCodexHistory(sessionId);
    this.historyCache.set(sessionId, { key, p });
    p.catch(() => {
      if (this.historyCache.get(sessionId)?.p === p) this.historyCache.delete(sessionId);
    });
    return p;
  }

  private async readCodexHistory(sessionId: string): Promise<Message[]> {
    const turns = await this.inner.getHistory(sessionId);
    const messages: Message[] = [];
    for (const turn of turns) {
      for (const item of (turn as { items?: unknown[] }).items ?? []) {
        const it = item as Record<string, unknown>;
        const type = it.type as string;
        if (type === 'userMessage') {
          messages.push({
            id: (it.id as string) ?? randomUUID(),
            session_id: sessionId,
            role: 'user',
            content: [{ type: 'text', text: extractCodexText(it) }],
            created_at: nowIso(),
          });
        } else if (type === 'agentMessage') {
          messages.push({
            id: (it.id as string) ?? randomUUID(),
            session_id: sessionId,
            role: 'assistant',
            content: [{ type: 'text', text: (it.text as string) ?? '' }],
            created_at: nowIso(),
          });
        }
      }
    }
    return messages;
  }

  async startTurn(input: StartTurnInput): Promise<TurnHandle> {
    let prompt = textOfInput(input.input);
    // "/skill 参数" 命中 skills/list 目录时展开成 SKILL.md 正文再发(同
    // codex TUI 语义);网关代执行命令(compact/fork/...)在 gateway 层
    // 已被拦截,到这里仍未命中的原样发送。
    if (prompt.trimStart().startsWith('/')) {
      const expanded = expandCodexSkill(prompt, await this.codexSkills());
      if (expanded != null) prompt = expanded;
    }
    // 'off' = 用户显式关掉 thinking 控制;codex 没有"关闭推理"的概念,
    // 诚实做法是回落到服务端默认 effort(不传),而不是造假一个档位。
    const thinking = this.settings.getString('thinking', input.sessionId);
    const attachments = input.attachments ?? [];
    const turnInput: string | Array<Record<string, unknown>> =
      attachments.length > 0 ? codexInputItems(prompt, attachments) : prompt;
    const handle = await this.inner.startTurn(input.sessionId, turnInput, {
      model: this.settings.getString('model', input.sessionId),
      effort: thinking && thinking !== 'off' ? thinking : undefined,
      approvalPolicy: codexApprovalPolicy(this.settings.getString('permission', input.sessionId)),
    });
    this.invalidateListCache(); // turn 会改动 preview/updatedAt,列表缓存失效
    const events = this.mapCodexEvents(input.sessionId, handle.turnId, handle.events);
    return { turnId: handle.turnId, events };
  }

  // -- 原生目录与模型选择 ----------------------------------------------------

  /** model/list 的 isDefault 行,作为未显式选择时 DTO 的展示回退。 */
  private defaultModel: string | undefined;

  async setModel(sessionId: string, model: string): Promise<void> {
    this.settings.set('model', sessionId, model);
  }

  getModel(sessionId: string): string | undefined {
    return this.settings.getString('model', sessionId)
      ?? this.settings.getString('model', '__default__')
      ?? this.defaultModel;
  }

  // -- thinking(effort)与改名 -------------------------------------------------

  private readonly renames = new Map<string, string>();
  private readonly threadCwd = new Map<string, string>();
  private readonly sessionUsage = new Map<string, SessionUsage>();

  async setThinking(sessionId: string, thinking: string): Promise<void> {
    this.settings.set('thinking', sessionId, thinking);
  }

  getThinking(sessionId: string): string | undefined {
    return this.settings.getString('thinking', sessionId);
  }

  async rename(sessionId: string, title: string): Promise<void> {
    this.renames.set(sessionId, title);
    // thread/name/set 是持久改名(0.147.0 实测 thread/setName 不存在,
    // 正确方法名是 thread/name/set);失败只留内存态。
    await this.inner.setThreadName(sessionId, title).catch(() => undefined);
    this.invalidateListCache();
  }

  async setPermission(sessionId: string, mode: string): Promise<void> {
    this.settings.set('permission', sessionId, mode);
  }

  getPermission(sessionId: string): string | undefined {
    return this.settings.getString('permission', sessionId);
  }

  // -- plan 模式(collaborationMode,0.147.0 实测需 experimentalApi) --------------

  async setPlanMode(sessionId: string, on: boolean): Promise<void> {
    // 先落 RPC(失败不记持久态,UI 不会显示假开关)。
    await this.inner.setCollaborationMode(sessionId, on ? 'plan' : 'default');
    if (on) this.settings.set('plan', sessionId, true);
    else this.settings.delete('plan', sessionId);
  }

  getPlanMode(sessionId: string): boolean | undefined {
    return this.settings.getBoolean('plan', sessionId);
  }

  // -- 会话操作(RPC 直通,全部 0.147.0 实测存在) --------------------------------

  async steer(sessionId: string, turnId: string, text: string): Promise<void> {
    await this.inner.steerTurn(sessionId, turnId, text);
  }

  async compact(sessionId: string): Promise<void> {
    await this.inner.compact(sessionId);
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    await this.inner.setArchived(sessionId, archived);
    this.invalidateListCache();
  }

  async delete(sessionId: string): Promise<void> {
    await this.inner.deleteThread(sessionId);
    this.renames.delete(sessionId);
    this.threadCwd.delete(sessionId);
    this.settings.delete('model', sessionId);
    this.settings.delete('thinking', sessionId);
    this.settings.delete('permission', sessionId);
    this.settings.delete('plan', sessionId);
    this.sessionUsage.delete(sessionId);
    this.invalidateListCache();
  }

  async fork(sessionId: string): Promise<Session> {
    const thread = await this.inner.forkThread(sessionId);
    this.invalidateListCache();
    return this.toSession(thread);
  }

  async rollback(sessionId: string, numTurns: number): Promise<void> {
    await this.inner.rollback(sessionId, numTurns);
    this.invalidateListCache();
  }

  /**
   * inline review(review/start):review 以新 turn 运行,事件流经
   * mapCodexEvents 后与普通 turn 同形,网关按正常 turn 驱动 UI。
   */
  async review(sessionId: string): Promise<TurnHandle> {
    const handle = await this.inner.reviewTurn(sessionId);
    this.invalidateListCache();
    return { turnId: handle.turnId, events: this.mapCodexEvents(sessionId, handle.turnId, handle.events) };
  }

  // -- goal(codex 原生 thread/goal/*) -------------------------------------------

  async setGoal(sessionId: string, objective: string): Promise<Record<string, unknown> | null> {
    return this.inner.goalSet(sessionId, objective);
  }

  async getGoal(sessionId: string): Promise<Record<string, unknown> | null> {
    return this.inner.goalGet(sessionId).catch(() => null);
  }

  async controlGoal(sessionId: string, control: 'pause' | 'resume' | 'cancel'): Promise<Record<string, unknown> | null> {
    if (control === 'cancel') {
      await this.inner.goalClear(sessionId);
      return null;
    }
    // objective 传 null = 不改动(thread/goal/set 字段可空),只切状态。
    return this.inner.goalSet(sessionId, null, control === 'pause' ? 'paused' : 'active');
  }

  getUsage(sessionId: string): SessionUsage | undefined {
    return this.sessionUsage.get(sessionId);
  }

  async listMcpServers(): Promise<Array<Record<string, unknown>>> {
    return this.inner.mcpStatus();
  }

  async listTerminals(sessionId: string): Promise<Array<Record<string, unknown>>> {
    return this.inner.backgroundTerminals(sessionId);
  }

  /** 原生模型目录:codex app-server 的 model/list(0.147.0 实测存在)。 */
  async listModels(): Promise<NativeModel[]> {
    const rows = await this.inner.listModels();
    const out: NativeModel[] = [];
    for (const r of rows) {
      // hidden=true 的是内部模型(如 codex-auto-review),不进选择器。
      if (r.hidden === true) continue;
      const model =
        typeof r.model === 'string' ? r.model : typeof r.id === 'string' ? r.id : '';
      if (!model) continue;
      if (r.isDefault === true) this.defaultModel = model;
      const efforts = Array.isArray(r.supportedReasoningEfforts)
        ? (r.supportedReasoningEfforts as { reasoningEffort?: unknown }[])
            .map((e) => String(e.reasoningEffort ?? ''))
            .filter(Boolean)
        : undefined;
      const modalities = Array.isArray(r.inputModalities)
        ? (r.inputModalities as unknown[]).map(String)
        : [];
      // 前端 modelThinkingAvailability:capabilities 含 'thinking' 才渲染
      // effort 选择器;档位列表来自 support_efforts。
      const caps = [
        ...(modalities.includes('image') ? ['vision'] : []),
        ...(efforts?.length ? ['thinking'] : []),
      ];
      out.push({
        provider: 'codex',
        model,
        display_name: typeof r.displayName === 'string' ? r.displayName : model,
        // model/list 不给上下文窗口大小;0 = 未知,前端不展示该字段。
        max_context_size: 0,
        capabilities: caps.length ? caps : undefined,
        support_efforts: efforts?.length ? efforts : undefined,
        default_effort:
          typeof r.defaultReasoningEffort === 'string' ? r.defaultReasoningEffort : undefined,
      });
    }
    return out;
  }

  /**
   * skills/list 目录(5 分钟 TTL):listCommands 展示 + startTurn 里的
   * skill 展开都要用。失败返回空数组,不阻断主流程。
   */
  private skillsCache: { ts: number; skills: Array<{ name: string; description: string; path: string }> } | null = null;

  private async codexSkills(): Promise<Array<{ name: string; description: string; path: string }>> {
    if (this.skillsCache && Date.now() - this.skillsCache.ts < 5 * 60_000) {
      return this.skillsCache.skills;
    }
    // 失败(如 app-server 还没起)只当场回空,不入缓存——否则一次瞬断会把
    // 空目录扩散 5 分钟,期间 /命令面板和 skill 展开全空(审查发现)。
    const rows = await this.inner.listSkills().catch(() => null);
    if (rows === null) return [];
    const skills = rows
      .filter((s) => s && typeof s.name === 'string' && typeof s.path === 'string' && s.enabled !== false)
      .map((s) => ({ name: s.name as string, description: (s.description as string) ?? '', path: s.path as string }));
    this.skillsCache = { ts: Date.now(), skills };
    return skills;
  }

  /** 原生 skills 目录(透传 codex skills/list,带 5 分钟缓存)。 */
  async listSkills(): Promise<Array<{ name: string; description: string; path: string; scope: string; enabled: boolean }>> {
    return this.inner.listSkills();
  }

  /** 完整目录:client 命令 + 网关代执行命令 + skills(0.147.0 实测 93 条)。 */
  async listCommands(): Promise<NativeCommand[]> {
    return listCodexCommands(await this.codexSkills());
  }

  async interrupt(sessionId: string, turnId?: string): Promise<void> {
    if (!turnId) return;
    await this.inner.interrupt(sessionId, turnId);
  }

  async resolveApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const map: Record<ApprovalDecision, 'accept' | 'acceptForSession' | 'decline'> = {
      approve: 'accept',
      approve_always: 'acceptForSession',
      reject: 'decline',
    };
    // 重复点击/重试时 codex 侧 parked 请求已不存在:幂等成功而非 500(审查发现);
    // 此前不 await,同步 throw 会变成未捕获异常。
    try {
      this.inner.resolveApproval(approvalId, map[decision]);
    } catch (err) {
      if (err instanceof Error && /no pending server request/.test(err.message)) return;
      throw err;
    }
  }

  async resolveQuestion(_sessionId: string, questionId: string, answer: string | Record<string, string[]>): Promise<void> {
    // 简单文本答案走 q_0(单列提问);结构化答案的键就是 codex 提问的
    // question id(网关 questionDto 已按原样透出)。
    try {
      this.inner.resolveQuestion(questionId, typeof answer === 'string' ? { q_0: [answer] } : answer);
    } catch (err) {
      if (err instanceof Error && /no pending server request/.test(err.message)) return;
      throw err;
    }
  }

  async close(_sessionId: string): Promise<void> {
    // Codex 进程常驻;会话级 close 为空操作(进程由进程级 close 管理)。
  }

  /** 进程级清理:杀 codex app-server。网关 shutdown 时调用(此前无调用方,
   *  预热拉起的常驻进程在网关退出后成孤儿)。 */
  async dispose(): Promise<void> {
    await this.inner.close();
  }

  private toSession(thread: Record<string, unknown>, cwdOverride?: string): Session {
    const cwd = cwdOverride ?? (thread.cwd as string) ?? process.cwd();
    const id = thread.id as string;
    // 列表扫到的历史会话也回填 cwd,充实 getCwd 兜底。
    if (thread.cwd || cwdOverride) this.threadCwd.set(id, cwd);
    return {
      id,
      workspace_id: workspaceIdFromCwd(cwd, 'codex'),
      title:
        this.renames.get(id) ??
        (thread.name as string) ?? (thread.preview as string)?.slice(0, 60) ?? `Codex ${id.slice(0, 8)}`,
      created_at: isoFromCodexTime(thread.createdAt),
      updated_at: isoFromCodexTime(thread.updatedAt),
      busy: false,
      metadata: { cwd },
      provider: 'codex',
    };
  }

  private async *mapCodexEvents(
    sessionId: string,
    turnId: string,
    source: AsyncIterable<CodexEvent>,
  ): AsyncIterable<GatewayEvent> {
    for await (const ev of source) {
      const ts = Date.now();
      switch (ev.type) {
        case 'text-delta':
          yield {
            kind: 'message',
            status: 'delta',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { delta: ev.delta, message: emptyAssistantMessage(sessionId) },
          };
          break;
        case 'reasoning-delta':
          yield {
            kind: 'thinking',
            status: 'delta',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { text: '', delta: ev.delta },
          };
          break;
        case 'command-output-delta':
          yield {
            kind: 'tool',
            status: 'delta',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { toolCallId: ev.itemId, name: 'commandExecution', output: ev.delta },
          };
          break;
        case 'item-started': {
          const item = ev.item as Record<string, unknown>;
          if (isCodexToolItem(item.type)) {
            yield {
              kind: 'tool',
              status: 'started',
              sessionId,
              turnId,
              timestamp: ts,
              payload: {
                toolCallId: (item.id as string) ?? '',
                name: item.type as string,
                input: item.command ?? item.arguments ?? item.query ?? item.changes ?? item,
              },
            };
          }
          break;
        }
        case 'item-completed': {
          const item = ev.item as Record<string, unknown>;
          if (isCodexToolItem(item.type)) {
            const output = (item.aggregatedOutput as string)
              ?? (typeof item.result === 'string' ? item.result : '')
              ?? (typeof item.output === 'string' ? item.output : '');
            yield {
              kind: 'tool',
              status: 'completed',
              sessionId,
              turnId,
              timestamp: ts,
              payload: {
                toolCallId: (item.id as string) ?? '',
                name: item.type as string,
                output,
                is_error: (item.exitCode as number) !== 0 && item.exitCode !== undefined,
              },
            };
          }
          break;
        }
        case 'approval-request':
          yield {
            kind: 'approval',
            status: 'started',
            sessionId,
            turnId,
            timestamp: ts,
            payload: {
              approvalId: String(ev.requestId),
              tool: ev.kind,
              input: ev.command ?? ev.params,
              itemId: ev.itemId,
            },
          };
          break;
        case 'question-request':
          yield {
            kind: 'question',
            status: 'started',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { questionId: String(ev.requestId), prompt: JSON.stringify(ev.questions), rawQuestions: ev.questions },
          };
          break;
        case 'token-usage': {
          // 会话级用量(累计 + 最近一次 turn + 上下文窗口),sessionDto/step 用。
          const t = ev.usage.total;
          const last = ev.usage.last;
          this.sessionUsage.set(sessionId, {
            input_tokens: num(t.inputTokens),
            output_tokens: num(t.outputTokens),
            cache_read_tokens: num(t.cachedInputTokens),
            cache_creation_tokens: num(t.cacheWriteInputTokens),
            total_cost_usd: 0,
            context_tokens: num(last.totalTokens),
            context_limit: ev.usage.modelContextWindow ?? 0,
            turn_count: 0,
          });
          break;
        }
        case 'turn-completed': {
          const status = (ev.turn as Record<string, unknown>).status as string;
          const reason = status === 'completed' ? 'completed' : status === 'interrupted' ? 'cancelled' : 'failed';
          yield {
            kind: 'turn',
            status: reason === 'completed' ? 'completed' : reason === 'cancelled' ? 'cancelled' : 'failed',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { reason },
          };
          break;
        }
        case 'error':
          // codexError 通知带 willRetry:true 的是瞬时上游错误(代理 502 重试
          // 等,实测 PONG 已产出后仍补发),不是 turn 终态——终态由
          // turn-completed 给出,锁存瞬时错误会把成功 turn 误报为 failed。
          if (ev.willRetry === true) break;
          yield {
            kind: 'turn',
            status: 'failed',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { reason: 'failed', error: ev.message },
          };
          break;
        default:
          break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Claude → ProviderAdapter
// ---------------------------------------------------------------------------

export class ClaudeProviderAdapter implements ProviderAdapter {
  readonly name = 'claude' as const;
  private readonly inner: ClaudeAdapter;
  /** 记录每个会话最近一次 turn 的 cwd,供 resume 时复用。 */
  private readonly sessionCwd = new Map<string, string>();
  /** 会话级设置持久化(重启不丢;只读路径回落 undefined = 未设置)。 */
  private readonly settings: SettingsStore;

  constructor(options?: ConstructorParameters<typeof ClaudeAdapter>[0] & { settingsPath?: string }) {
    const { settingsPath, ...innerOptions } = options ?? {};
    this.inner = new ClaudeAdapter(innerOptions);
    this.settings = new SettingsStore(settingsPath);
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      thinking: true,
      tools: true,
      approvals: false, // 实测:非交互 stream-json 下无法代答审批
      questions: false, // 实测:同上
      interrupt: true,
      history: true,
    };
  }

  async list(query: ListSessionsQuery = {}): Promise<SessionPage> {
    const sessions = (await this.inner.list()).filter((session) => !query.cwd || session.cwd === query.cwd);
    const start = query.cursor ? sessions.findIndex((session) => session.sessionId === query.cursor) + 1 : 0;
    if (query.cursor && start === 0) return { items: [] };
    const limit = query.limit ?? 50;
    const page = sessions.slice(start, start + limit);
    const items = page.map((session) => this.toSession(session));
    return {
      items,
      ...(start + limit < sessions.length && page.length > 0
        ? { next_cursor: page[page.length - 1].sessionId }
        : {}),
    };
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const { sessionId } = await this.inner.create();
    const cwd = input.cwd ?? (input.metadata?.cwd as string | undefined) ?? process.cwd();
    this.sessionCwd.set(sessionId, cwd);
    return {
      id: sessionId,
      workspace_id: workspaceIdFromCwd(cwd, 'claude'),
      title: input.title ?? `Claude ${sessionId.slice(0, 8)}`,
      created_at: nowIso(),
      updated_at: nowIso(),
      busy: false,
      metadata: { cwd },
      provider: 'claude',
    };
  }

  async getHistory(sessionId: string, _query: HistoryQuery = {}): Promise<Message[]> {
    const history = await this.inner.getHistory(sessionId);
    return history.map((m, index) => ({
      id: `msg_${createHash('sha256')
        .update(JSON.stringify([sessionId, index, m.role, m.timestamp ?? '', m.text]))
        .digest('hex')
        .slice(0, 24)}`,
      session_id: sessionId,
      role: m.role,
      content: [{ type: 'text', text: m.text }],
      created_at: m.timestamp ?? nowIso(),
      ...(m.model || m.isError ? {
        metadata: {
          ...(m.model ? { model: m.model } : {}),
          ...(m.isError ? { is_error: true } : {}),
        },
      } : {}),
    }));
  }

  async startTurn(input: StartTurnInput): Promise<TurnHandle> {
    const sessionId = input.sessionId;
    // claude CLI 在 -p stream-json 模式下自己执行 "/name args"(2.1.226
    // 实测 /compact /mcp 均产生真实输出),网关不展开、不拦截,原样直通。
    let prompt = textOfInput(input.input);
    // 附件翻译(2.1.226 复核:stream-json user message 支持 image/document
    // base64 block):图片/PDF 内联成原生块;读盘失败或其他类型物化成路径
    // 文本(kap-server 话术),让模型自己用 Read 打开。
    const blocks: Array<Record<string, unknown>> = [];
    const notes: string[] = [];
    for (const a of input.attachments ?? []) {
      if (a.kind === 'localImage' && a.path) {
        const data = await fsp.readFile(a.path).catch(() => null);
        if (data) blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType ?? 'image/png', data: data.toString('base64') } });
        else notes.push(fileAttachText(a));
      } else if (a.kind === 'imageDataUrl' && a.dataUrl) {
        const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(a.dataUrl);
        if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      } else if (a.kind === 'filePathText' && a.path) {
        const data = a.mediaType === 'application/pdf' ? await fsp.readFile(a.path).catch(() => null) : null;
        if (data) blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } });
        else notes.push(fileAttachText(a));
      }
    }
    if (notes.length > 0) prompt = [...notes, prompt].filter((s) => s.trim()).join('\n');
    // isNew 看 transcript 文件是否已落盘,而不是一次性内存标记(审查发现:
    // 首轮 spawn 失败/网关重启后标记已丢,重试走 --resume 不存在的会话必败)。
    // 文件不在 → --session-id 建档;文件在 → --resume(重复 --session-id 会被
    // CLI 以 "session id 已存在" 直接退出,实测 turn 静默空转)。
    const isNew = !this.inner.hasSessionFile(sessionId);
    const cwd = this.sessionCwd.get(sessionId);
    const model = this.settings.getString('model', sessionId);
    // thinking 'off' = 用户显式关闭 → 不传 --effort(CLI 无 off 档)。
    const thinking = this.settings.getString('thinking', sessionId);
    const effort = thinking && thinking !== 'off' ? thinking : undefined;
    // plan 模式优先:CLI 的 plan 是 --permission-mode 的一个取值,与权限
    // 三档互斥,开启时直接覆盖。
    const permissionMode = this.settings.getBoolean('plan', sessionId)
      ? 'plan'
      : claudePermissionMode(this.settings.getString('permission', sessionId));
    const turnId = randomUUID();
    const stream = new EventStream<GatewayEvent>();

    const emit = (ev: ClaudeAdapterEvent): void => {
      const ts = Date.now();
      switch (ev.type) {
        case 'text_delta':
          stream.push({
            kind: 'message',
            status: 'delta',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { delta: ev.text, message: emptyAssistantMessage(sessionId) },
          });
          break;
        case 'thinking_delta':
          stream.push({
            kind: 'thinking',
            status: 'delta',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { text: '', delta: ev.text },
          });
          break;
        case 'synthetic_text':
          // 本地命令(/mcp /usage 等)的整段输出:无 stream delta,一次性
          // 作为完整消息文本推给前端。
          stream.push({
            kind: 'message',
            status: 'delta',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { delta: ev.text, message: emptyAssistantMessage(sessionId) },
          });
          break;
        case 'tool_use':
          stream.push({
            kind: 'tool',
            status: 'started',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { toolCallId: ev.toolUseId, name: ev.name, input: ev.input },
          });
          break;
        case 'tool_result':
          stream.push({
            kind: 'tool',
            status: 'completed',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { toolCallId: ev.toolUseId, name: '', output: ev.content, is_error: ev.isError },
          });
          break;
        case 'permission_denied':
          stream.push({
            kind: 'tool',
            status: 'failed',
            sessionId,
            turnId,
            timestamp: ts,
            payload: {
              toolCallId: ev.denials[0]?.tool_use_id ?? '',
              name: ev.denials[0]?.tool_name ?? 'permission',
              output: '工具需要权限,Claude 非交互模式自动拒绝(网关未开启写权限)',
              is_error: true,
            },
          });
          break;
        case 'done': {
          // result 事件的 usage 是单 turn 量(input_tokens /
          // cache_read_input_tokens / output_tokens / total_cost_usd,
          // 2.1.226 产物实测),累计成会话级 SessionUsage 供 /status 展示。
          const u = ev.usage;
          if (u) {
            const prev = this.sessionUsage.get(sessionId) ?? {
              input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
              cache_creation_tokens: 0, total_cost_usd: 0, context_tokens: 0,
              context_limit: 0, turn_count: 0,
            };
            const input = num(u.input_tokens);
            const cacheRead = num(u.cache_read_input_tokens);
            const cacheCreate = num(u.cache_creation_input_tokens);
            const model = this.getModel(sessionId) ?? '';
            this.sessionUsage.set(sessionId, {
              input_tokens: prev.input_tokens + input,
              output_tokens: prev.output_tokens + num(u.output_tokens),
              cache_read_tokens: prev.cache_read_tokens + cacheRead,
              cache_creation_tokens: prev.cache_creation_tokens + cacheCreate,
              total_cost_usd: prev.total_cost_usd + num(u.total_cost_usd),
              // 上下文占用 = 本 turn 输入侧总量;窗口大小按模型目录约定。
              context_tokens: input + cacheRead + cacheCreate,
              context_limit: model.includes('[1m]') ? 1_000_000 : 200_000,
              turn_count: prev.turn_count + 1,
            });
          }
          stream.push({
            kind: 'turn',
            status: ev.isError ? 'failed' : 'completed',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { reason: ev.isError ? 'failed' : 'completed', ...(ev.isError ? { error: ev.result } : {}) },
          });
          stream.end();
          break;
        }
        case 'interrupted':
          stream.push({
            kind: 'turn',
            status: 'cancelled',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { reason: 'cancelled' },
          });
          stream.end();
          break;
        case 'error':
          stream.push({
            kind: 'turn',
            status: 'failed',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { reason: 'failed', error: ev.message },
          });
          stream.end();
          break;
        default:
          break;
      }
    };

    // startTurn 在 result 事件后 resolve;不 await,后台跑。
    const contentBlocks =
      blocks.length > 0 ? [...blocks, ...(prompt.trim() ? [{ type: 'text', text: prompt }] : [])] : undefined;
    void this.inner
      .startTurn({ sessionId, prompt, cwd, isNew, model, effort, permissionMode, contentBlocks, onEvent: emit })
      .catch((err: unknown) => {
        stream.push({
          kind: 'turn',
          status: 'failed',
          sessionId,
          turnId,
          timestamp: Date.now(),
          payload: { reason: 'failed', error: err instanceof Error ? err.message : String(err) },
        });
        stream.end();
      });

    return { turnId, events: stream };
  }

  async interrupt(sessionId: string): Promise<void> {
    this.inner.interrupt(sessionId);
  }

  async resolveApproval(): Promise<void> {
    throw new ProviderError('unsupported', 'Claude 非交互模式不支持代答审批(实测)', 400);
  }

  async resolveQuestion(): Promise<void> {
    throw new ProviderError('unsupported', 'Claude 非交互模式不支持代答提问(实测)', 400);
  }

  async close(_sessionId: string): Promise<void> {
    // Claude 每 turn 独立进程;会话级 close 为空操作。
  }

  /** 进程级清理:杀所有 running turn 进程。网关 shutdown 时调用。 */
  async dispose(): Promise<void> {
    await this.inner.close();
  }

  // -- 原生目录与模型选择 ----------------------------------------------------

  private readonly renames = new Map<string, string>();

  async setModel(sessionId: string, model: string): Promise<void> {
    this.settings.set('model', sessionId, model);
  }

  async rename(sessionId: string, title: string): Promise<void> {
    this.renames.set(sessionId, title);
  }

  // -- thinking / permission / plan / usage(持久态,turn 启动时透传 CLI 旗标) --

  private readonly sessionUsage = new Map<string, SessionUsage>();

  async setThinking(sessionId: string, thinking: string): Promise<void> {
    this.settings.set('thinking', sessionId, thinking);
  }

  getThinking(sessionId: string): string | undefined {
    return this.settings.getString('thinking', sessionId);
  }

  async setPermission(sessionId: string, mode: string): Promise<void> {
    this.settings.set('permission', sessionId, mode);
  }

  getPermission(sessionId: string): string | undefined {
    return this.settings.getString('permission', sessionId);
  }

  async setPlanMode(sessionId: string, on: boolean): Promise<void> {
    if (on) this.settings.set('plan', sessionId, true);
    else this.settings.delete('plan', sessionId);
  }

  getPlanMode(sessionId: string): boolean | undefined {
    return this.settings.getBoolean('plan', sessionId);
  }

  getUsage(sessionId: string): SessionUsage | undefined {
    return this.sessionUsage.get(sessionId);
  }

  getModel(sessionId: string): string | undefined {
    // 未显式选择时,CLI 实际会用 ANTHROPIC_MODEL(优先级:CLI 参数 > 环境变量
    // > settings,2.1.226 产物取证),DTO 如实展示它。
    return this.settings.getString('model', sessionId)
      ?? this.settings.getString('model', '__default__')
      ?? process.env.ANTHROPIC_MODEL;
  }

  /**
   * 原生模型目录,两种真实情形:
   * - 配了自定义端点(ANTHROPIC_MODEL 等):env 里的模型就是该端点实际可用的,
   *   同一模型被多个别名指向时合并成一行,display_name 标注别名来源。
   * - 没配(未登录/官方默认):展示 CLI initialize 握手返回的内置目录
   *   (default/opus/fable/sonnet/haiku,2.1.226 实测);握手失败如实抛错,
   *   不伪造空目录,也不进缓存。
   */
  async listModels(): Promise<NativeModel[]> {
    const rows: Array<[string, string | undefined]> = [
      ['default', process.env.ANTHROPIC_MODEL],
      ['opus', process.env.ANTHROPIC_DEFAULT_OPUS_MODEL],
      ['sonnet', process.env.ANTHROPIC_DEFAULT_SONNET_MODEL],
      ['haiku', process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL],
    ];
    const byModel = new Map<string, string[]>();
    for (const [alias, model] of rows) {
      if (!model) continue;
      const aliases = byModel.get(model) ?? [];
      aliases.push(alias);
      byModel.set(model, aliases);
    }
    if (byModel.size > 0) {
      return [...byModel.entries()].map(([model, aliases]) => ({
        provider: 'claude',
        model,
        display_name: `${model}(${aliases.join('/')})`,
        // [1m] 后缀是该接入方约定的一百万上下文命名;否则按 200K 展示。
        max_context_size: model.includes('[1m]') ? 1_000_000 : 200_000,
        capabilities: ['thinking'],
        support_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      }));
    }

    const builtin = await this.inner.listBuiltinModels();
    return builtin.map((model) => ({
      provider: 'claude',
      model: model.value,
      display_name: model.displayName ?? model.value,
      // resolvedModel 的 [1m] 后缀 = 一百万上下文变体;否则按 200K 展示。
      max_context_size: (model.resolvedModel ?? model.value).includes('[1m]') ? 1_000_000 : 200_000,
      capabilities: model.supportsEffort ? ['thinking'] : [],
      ...(model.supportedEffortLevels?.length ? { support_efforts: model.supportedEffortLevels } : {}),
    }));
  }

  async listCommands(sessionId?: string): Promise<NativeCommand[]> {
    // 项目级命令发现需要 cwd:本进程新建的会话在 sessionCwd 里;历史会话
    // 从 transcript 摘要列表查(热态 ~15ms)。
    let cwd = sessionId ? this.sessionCwd.get(sessionId) : undefined;
    if (!cwd && sessionId) {
      const sessions = await this.inner.list().catch(() => []);
      cwd = sessions.find((s) => s.sessionId === sessionId)?.cwd;
    }
    // 权威目录 = CLI initialize 握手回包(154 条:插件命令 + skills +
    // 内置 compact/usage/mcp 等,2.1.226 实测),短命进程带 5 分钟缓存。
    // 握手失败如实抛错(/commands 500),不吞成空目录冒充"没有命令"。
    const catalog = await this.inner.listSlashCommands(cwd);
    return listClaudeCommands(catalog);
  }

  private toSession(s: {
    sessionId: string;
    title: string;
    cwd: string;
    updatedAt: string;
  }): Session {
    // 历史会话(transcript 扫描而来)也回填 cwd——否则 resume 时 startTurn
    // 只能退回 HOME 目录启动 CLI(审查发现),项目级命令发现同样依赖它。
    if (s.cwd) this.sessionCwd.set(s.sessionId, s.cwd);
    return {
      id: s.sessionId,
      workspace_id: workspaceIdFromCwd(s.cwd, 'claude'),
      title: this.renames.get(s.sessionId) ?? (s.title || `Claude ${s.sessionId.slice(0, 8)}`),
      created_at: s.updatedAt,
      updated_at: s.updatedAt,
      busy: false,
      metadata: { cwd: s.cwd },
      provider: 'claude',
    };
  }

  /** 网关 getSession 兜底用:新建未落盘的会话也能拿到真实 cwd,不造 HOME 假目录。 */
  getCwd(sessionId: string): string | undefined {
    return this.sessionCwd.get(sessionId);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function emptyAssistantMessage(sessionId: string): Message {
  return {
    id: randomUUID(),
    session_id: sessionId,
    role: 'assistant',
    content: [],
    created_at: nowIso(),
  };
}

function extractCodexText(item: Record<string, unknown>): string {
  const content = item.content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c as Record<string, unknown>).text as string)
      .filter(Boolean)
      .join('');
  }
  return (item.text as string) ?? '';
}

function isoFromCodexTime(value: unknown): string {
  // Codex thread/list(0.147.0 实测)的 createdAt/updatedAt 是 epoch **秒**
  // (10 位,如 1786289601);当初误判为毫秒导致全部落到 1970 年、排序沉底被
  // slice 截掉。按量级区分:<1e12 视为秒,否则视为毫秒。
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === 'string') return value;
  return nowIso();
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * kimi wire 权限值 → codex approvalPolicy(0.147.0 schema:untrusted/on-request/
 * never 三档 + granular;codex 没有 auto 的中间档,auto 取最靠近的 untrusted
 * ——可信命令自动过,不可信的仍然问)。
 */
function codexApprovalPolicy(mode: string | undefined): 'untrusted' | 'on-request' | 'never' | undefined {
  switch (mode) {
    case 'manual': return 'on-request';
    case 'auto': return 'untrusted';
    case 'yolo': return 'never';
    default: return undefined;
  }
}

/** kimi wire 权限值 → claude --permission-mode(2.1.226 choices 实测)。 */
export function claudePermissionMode(mode: string | undefined): string | undefined {
  switch (mode) {
    case 'manual': return 'manual';
    case 'auto': return 'auto';
    case 'yolo': return 'bypassPermissions';
    default: return undefined;
  }
}
