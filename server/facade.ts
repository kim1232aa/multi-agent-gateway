/**
 * facade:把 Codex / Claude 两个风格不同的 adapter 统一包成 types.ts 的
 * ProviderAdapter 接口。Kimi 路径不走这里(由 kimi-proxy 无损代理)。
 *
 * - Codex:常驻 JSON-RPC 进程,startTurn 返回流式事件队列。
 * - Claude:每 turn spawn 一次 CLI,回调式事件;facade 把回调聚成 AsyncIterable。
 *
 * 只在这里做协议映射,不改两个 adapter 的内部实现(它们已各自实测通过)。
 */

import { randomUUID } from 'node:crypto';
import { CodexAdapter, type CodexEvent } from './codex-adapter.js';
import { ClaudeAdapter, type ClaudeAdapterEvent } from './claude-adapter.js';
import { expandCodexSkill, listClaudeCommands, listCodexCommands } from './native-commands.js';
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

  constructor(options?: ConstructorParameters<typeof CodexAdapter>[0]) {
    this.inner = new CodexAdapter(options);
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
    const want = query.limit ?? 50;
    if (query.cursor == null && query.archived == null) {
      const full = await this.cachedFullPage();
      // limit>100(如网关聚合用的 500)也能由缓存服务,只要缓存页是完整页
      // (next_cursor 为空)。本机 ~73 线程 < 100,一次扫描后所有 limit 全命中,
      // 否则 /sessions 聚合每次都要 2-3 次 ~4s 的 RPC 全扫(实测 15-20s)。
      if (want <= 100 || !full.next_cursor) {
        const page: SessionPage = { items: full.items.slice(0, want) };
        if (want >= full.items.length && full.next_cursor) page.next_cursor = full.next_cursor;
        return page;
      }
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
      cwd: undefined,
      archived: query.archived,
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
    this.invalidateListCache(); // 新线程,列表缓存失效
    return this.toSession(thread, cwd);
  }

  async getHistory(sessionId: string, _query: HistoryQuery = {}): Promise<Message[]> {
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
    const thinking = this.sessionThinking.get(input.sessionId);
    const handle = await this.inner.startTurn(input.sessionId, prompt, {
      model: this.sessionModels.get(input.sessionId),
      effort: thinking && thinking !== 'off' ? thinking : undefined,
      approvalPolicy: codexApprovalPolicy(this.sessionPermission.get(input.sessionId)),
    });
    this.invalidateListCache(); // turn 会改动 preview/updatedAt,列表缓存失效
    const events = this.mapCodexEvents(input.sessionId, handle.turnId, handle.events);
    return { turnId: handle.turnId, events };
  }

  // -- 原生目录与模型选择 ----------------------------------------------------

  private readonly sessionModels = new Map<string, string>();
  /** model/list 的 isDefault 行,作为未显式选择时 DTO 的展示回退。 */
  private defaultModel: string | undefined;

  async setModel(sessionId: string, model: string): Promise<void> {
    this.sessionModels.set(sessionId, model);
  }

  getModel(sessionId: string): string | undefined {
    return this.sessionModels.get(sessionId) ?? this.defaultModel;
  }

  // -- thinking(effort)与改名 -------------------------------------------------

  private readonly sessionThinking = new Map<string, string>();
  private readonly renames = new Map<string, string>();
  private readonly sessionPermission = new Map<string, string>();
  private readonly sessionUsage = new Map<string, SessionUsage>();

  async setThinking(sessionId: string, thinking: string): Promise<void> {
    this.sessionThinking.set(sessionId, thinking);
  }

  getThinking(sessionId: string): string | undefined {
    return this.sessionThinking.get(sessionId);
  }

  async rename(sessionId: string, title: string): Promise<void> {
    this.renames.set(sessionId, title);
    // thread/name/set 是持久改名(0.147.0 实测 thread/setName 不存在,
    // 正确方法名是 thread/name/set);失败只留内存态。
    await this.inner.setThreadName(sessionId, title).catch(() => undefined);
    this.invalidateListCache();
  }

  async setPermission(sessionId: string, mode: string): Promise<void> {
    this.sessionPermission.set(sessionId, mode);
  }

  getPermission(sessionId: string): string | undefined {
    return this.sessionPermission.get(sessionId);
  }

  // -- plan 模式(collaborationMode,0.147.0 实测需 experimentalApi) --------------

  private readonly sessionPlan = new Map<string, boolean>();

  async setPlanMode(sessionId: string, on: boolean): Promise<void> {
    // 先落 RPC(失败不记内存态,UI 不会显示假开关)。
    await this.inner.setCollaborationMode(sessionId, on ? 'plan' : 'default');
    if (on) this.sessionPlan.set(sessionId, true);
    else this.sessionPlan.delete(sessionId);
  }

  getPlanMode(sessionId: string): boolean | undefined {
    return this.sessionPlan.get(sessionId);
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
    this.inner.resolveApproval(approvalId, map[decision]);
  }

  async resolveQuestion(_sessionId: string, questionId: string, answer: string | Record<string, string[]>): Promise<void> {
    // 简单文本答案走 q_0(单列提问);结构化答案的键就是 codex 提问的
    // question id(网关 questionDto 已按原样透出)。
    this.inner.resolveQuestion(questionId, typeof answer === 'string' ? { q_0: [answer] } : answer);
  }

  async close(_sessionId: string): Promise<void> {
    // Codex 进程常驻;会话级 close 为空操作(进程由进程级 close 管理)。
  }

  private toSession(thread: Record<string, unknown>, cwdOverride?: string): Session {
    const cwd = cwdOverride ?? (thread.cwd as string) ?? process.cwd();
    const id = thread.id as string;
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
        case 'item-started': {
          const item = ev.item as Record<string, unknown>;
          if (item.type === 'commandExecution' || item.type === 'mcpToolCall') {
            yield {
              kind: 'tool',
              status: 'started',
              sessionId,
              turnId,
              timestamp: ts,
              payload: {
                toolCallId: (item.id as string) ?? '',
                name: item.type as string,
                input: item.command ?? item.arguments,
              },
            };
          }
          break;
        }
        case 'item-completed': {
          const item = ev.item as Record<string, unknown>;
          if (item.type === 'commandExecution' || item.type === 'mcpToolCall') {
            yield {
              kind: 'tool',
              status: 'completed',
              sessionId,
              turnId,
              timestamp: ts,
              payload: {
                toolCallId: (item.id as string) ?? '',
                name: item.type as string,
                output: (item.aggregatedOutput as string) ?? '',
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
  private readonly created = new Set<string>();

  constructor(options?: ConstructorParameters<typeof ClaudeAdapter>[0]) {
    this.inner = new ClaudeAdapter(options);
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
    const sessions = await this.inner.list();
    const items = sessions.map((s) => this.toSession(s));
    return { items };
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const { sessionId } = await this.inner.create();
    const cwd = input.cwd ?? (input.metadata?.cwd as string | undefined) ?? process.cwd();
    this.created.add(sessionId);
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
    return history.map((m) => ({
      id: randomUUID(),
      session_id: sessionId,
      role: m.role,
      content: [{ type: 'text', text: m.text }],
      created_at: m.timestamp ?? nowIso(),
      ...(m.model ? { metadata: { model: m.model } } : {}),
    }));
  }

  async startTurn(input: StartTurnInput): Promise<TurnHandle> {
    const sessionId = input.sessionId;
    // claude CLI 在 -p stream-json 模式下自己执行 "/name args"(2.1.226
    // 实测 /compact /mcp 均产生真实输出),网关不展开、不拦截,原样直通。
    const prompt = textOfInput(input.input);
    // isNew 是一次性的:首轮用 --session-id 建档,之后必须 --resume,
    // 否则 CLI 以 "session id 已存在" 直接退出(实测,turn 静默空转)。
    const isNew = this.created.delete(sessionId);
    const cwd = this.sessionCwd.get(sessionId);
    const model = this.sessionModels.get(sessionId);
    // thinking 'off' = 用户显式关闭 → 不传 --effort(CLI 无 off 档)。
    const thinking = this.sessionThinking.get(sessionId);
    const effort = thinking && thinking !== 'off' ? thinking : undefined;
    // plan 模式优先:CLI 的 plan 是 --permission-mode 的一个取值,与权限
    // 三档互斥,开启时直接覆盖。
    const permissionMode = this.sessionPlan.get(sessionId)
      ? 'plan'
      : claudePermissionMode(this.sessionPermission.get(sessionId));
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
    void this.inner
      .startTurn({ sessionId, prompt, cwd, isNew, model, effort, permissionMode, onEvent: emit })
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

  // -- 原生目录与模型选择 ----------------------------------------------------

  private readonly sessionModels = new Map<string, string>();
  private readonly renames = new Map<string, string>();

  async setModel(sessionId: string, model: string): Promise<void> {
    this.sessionModels.set(sessionId, model);
  }

  async rename(sessionId: string, title: string): Promise<void> {
    this.renames.set(sessionId, title);
  }

  // -- thinking / permission / plan / usage(内存态,turn 启动时透传 CLI 旗标) --

  private readonly sessionThinking = new Map<string, string>();
  private readonly sessionPermission = new Map<string, string>();
  private readonly sessionPlan = new Map<string, boolean>();
  private readonly sessionUsage = new Map<string, SessionUsage>();

  async setThinking(sessionId: string, thinking: string): Promise<void> {
    this.sessionThinking.set(sessionId, thinking);
  }

  getThinking(sessionId: string): string | undefined {
    return this.sessionThinking.get(sessionId);
  }

  async setPermission(sessionId: string, mode: string): Promise<void> {
    this.sessionPermission.set(sessionId, mode);
  }

  getPermission(sessionId: string): string | undefined {
    return this.sessionPermission.get(sessionId);
  }

  async setPlanMode(sessionId: string, on: boolean): Promise<void> {
    if (on) this.sessionPlan.set(sessionId, true);
    else this.sessionPlan.delete(sessionId);
  }

  getPlanMode(sessionId: string): boolean | undefined {
    return this.sessionPlan.get(sessionId);
  }

  getUsage(sessionId: string): SessionUsage | undefined {
    return this.sessionUsage.get(sessionId);
  }

  getModel(sessionId: string): string | undefined {
    // 未显式选择时,CLI 实际会用 ANTHROPIC_MODEL(优先级:CLI 参数 > 环境变量
    // > settings,2.1.226 产物取证),DTO 如实展示它。
    return this.sessionModels.get(sessionId) ?? process.env.ANTHROPIC_MODEL;
  }

  /**
   * 原生模型目录:claude TUI 的 /model 选择器在本环境变量下实际会用的模型
   * —— ANTHROPIC_MODEL + OPUS/SONNET/HAIKU 别名解析后的原始模型 id
   * (2.1.226 产物里 _wu/vwu/Awu 三个 picker 行的取证结论)。同一模型被多个
   * 别名指向时合并成一行,display_name 标注别名来源。
   */
  listModels(): Promise<NativeModel[]> {
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
    const items = [...byModel.entries()].map(([model, aliases]) => ({
      provider: 'claude',
      model,
      display_name: `${model}(${aliases.join('/')})`,
      // [1m] 后缀是该接入方约定的一百万上下文命名;否则按 200K 展示。
      max_context_size: model.includes('[1m]') ? 1_000_000 : 200_000,
      // CLI --effort choices 实测 low/medium/high/xhigh/max(2.1.226);
      // 上游是否真按档位推理取决于接入方,这里如实暴露 CLI 能力面。
      capabilities: ['thinking'],
      support_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    }));
    return Promise.resolve(items);
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
    const catalog = await this.inner.listSlashCommands(cwd).catch(() => []);
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
