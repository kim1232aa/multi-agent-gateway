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
import { constants as fsConstants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  CodexAdapter,
  extractCodexReasoningSummary,
  stripCodexMemoryCitations,
  stripCodexSystemTags,
  type CodexEvent,
  type ReviewStartOptions,
} from './codex-adapter.js';
import {
  ClaudeAdapter,
  type ClaudeAdapterEvent,
  type ResolveClaudeApprovalOptions,
} from './claude-adapter.js';
import { expandCodexSkill, listClaudeCommands, listCodexCommands } from './native-commands.js';
import { extractSubagentIdFromOutput, findCodexRollout } from './local-transcript.js';
import { SettingsStore } from './settings-store.js';
import { encodeModelRef, parseModelRef, type CliProviders } from './provider-store.js';
import { readSubagentTail, subagentStatus } from './subagents.js';
import { supportsUltracode, THINKING_PROFILES } from './thinking-levels.js';
import {
  ProviderError,
  type ApprovalDecision,
  type CreateSessionInput,
  type GatewayEvent,
  type GranularApprovalDetails,
  type HistoryQuery,
  type ListSessionsQuery,
  type Message,
  type MessageContentPart,
  type ModelUsageEntry,
  type NativeCommand,
  type NativeModel,
  type ProviderAdapter,
  type ProviderCapabilities,
  type Session,
  type SessionPage,
  type SessionUsage,
  type StartTurnInput,
  type SteerInput,
  type StructuredQuestion,
  type SubagentInfo,
  type SubagentStatus,
  type TurnAttachment,
  type TurnHandle,
} from './types.js';

export { GrokProviderAdapter } from './grok-adapter.js';
export { PiProviderAdapter } from './pi-adapter.js';
export { DshProviderAdapter } from './dsh-adapter.js';

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

export function workspaceIdFromCwd(cwd: string, provider: string): string {
  const resolved = path.resolve(cwd);
  const normalized = (process.platform === 'win32' ? resolved.toLowerCase() : resolved)
    .replace(/[\\/]+$/, '') || '/';
  const slug = normalized.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root';
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  const prefix = `wd_${provider}_`;
  const maxSlug = Math.max(1, 60 - prefix.length - 1 - hash.length);
  return `${prefix}${slug.slice(0, maxSlug)}_${hash}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 前端 formatTokens 按 1024 进制:1_048_576 才显示 1M,1_000_000 会显示 977k。 */
const CLAUDE_CONTEXT_1M = 1_048_576;
const CLAUDE_CONTEXT_200K = 200_000;

export function claudeContextWindow(...labels: Array<string | undefined>): number {
  const text = labels.filter((part): part is string => Boolean(part)).join('\0').toLowerCase();
  if (text.includes('[1m]') || text.includes('claude-fable') || /(^|\0)fable(\0|$)/.test(text)) {
    return CLAUDE_CONTEXT_1M;
  }
  return CLAUDE_CONTEXT_200K;
}

/** Official Claude picker aliases. Env endpoint names (qwen, custom ids) stay out. */
const CLAUDE_CATALOG_DISPLAY_NAME = {
  default: 'Default (recommended)',
  sonnet: 'Sonnet',
  fable: 'Fable',
  opus: 'Opus',
  haiku: 'Haiku',
} as const;

export type ClaudeCatalogAlias = keyof typeof CLAUDE_CATALOG_DISPLAY_NAME;

export function isClaudeCatalogModel(model: string | undefined): model is string {
  return claudeCatalogAlias(model) !== undefined;
}

/** Map a CLI model id onto the official picker alias, or undefined if it is not a catalog entry. */
export function claudeCatalogAlias(model: string | undefined): ClaudeCatalogAlias | undefined {
  if (!model) return undefined;
  const id = model.trim().toLowerCase();
  if (!id || /qwen/i.test(id)) return undefined;
  if (/^default(\b|[-[]|$)/.test(id)) return 'default';
  if (/^sonnet(\b|[-[]|$)/.test(id) || id.startsWith('claude-sonnet')) return 'sonnet';
  if (/^fable(\b|[-[]|$)/.test(id) || id.startsWith('claude-fable')) return 'fable';
  if (/^opus(\b|[-[]|$)/.test(id) || id.startsWith('claude-opus')) return 'opus';
  if (/^haiku(\b|[-[]|$)/.test(id) || id.startsWith('claude-haiku')) return 'haiku';
  return undefined;
}

function isCodexToolItem(type: unknown): boolean {
  return type === 'commandExecution'
    || type === 'exec_command'
    || type === 'mcpToolCall'
    || type === 'fileChange'
    || type === 'webSearch'
    || type === 'dynamicToolCall'
    || type === 'imageView'
    || type === 'collabToolCall'
    || type === 'collabAgentToolCall'
    || type === 'custom_tool_call';
}

function extractCodexContentItemsText(items: unknown): string | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const parts: string[] = [];
  for (const entry of items) {
    if (typeof entry === 'string' && entry) {
      parts.push(entry);
    } else if (entry && typeof entry === 'object') {
      const rec = entry as Record<string, unknown>;
      if (typeof rec.text === 'string' && rec.text) parts.push(rec.text);
      else if (typeof rec.imageUrl === 'string' && rec.imageUrl) parts.push(`[image: ${rec.imageUrl}]`);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/** codex 历史/事件 item 的输出文本:支持 aggregatedOutput / result / output / contentItems / agentsStates / error，不让空字符串屏蔽 output。 */
function extractCodexToolOutput(item: Record<string, unknown>): string | null {
  if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.length > 0) {
    return item.aggregatedOutput;
  }
  if (typeof item.result === 'string' && item.result.length > 0) {
    return item.result;
  }
  if (typeof item.output === 'string' && item.output.length > 0) {
    return item.output;
  }
  if (Array.isArray(item.output)) {
    const text = (item.output as Array<Record<string, unknown>>)
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  const contentItemsText = extractCodexContentItemsText(item.contentItems);
  if (contentItemsText !== null) return contentItemsText;
  if (item.agentsStates && typeof item.agentsStates === 'object') {
    return JSON.stringify(item.agentsStates);
  }
  if (item.result !== undefined && item.result !== null) {
    return typeof item.result === 'string' ? item.result : JSON.stringify(item.result);
  }
  if (item.output !== undefined && item.output !== null && !Array.isArray(item.output)) {
    return typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
  }
  if (item.error !== undefined && item.error !== null) {
    if (typeof item.error === 'string') return item.error;
    if (typeof item.error === 'object' && typeof (item.error as { message?: unknown }).message === 'string') {
      return (item.error as { message: string }).message;
    }
    return JSON.stringify(item.error);
  }
  if (typeof item.aggregatedOutput === 'string') return item.aggregatedOutput;
  return null;
}

function extractCodexStructuredOutput(item: Record<string, unknown>): unknown {
  if (item.structuredContent !== undefined) return item.structuredContent;
  if (Array.isArray(item.contentItems) && item.contentItems.length > 0) return item.contentItems;
  if (item.result && typeof item.result === 'object') return item.result;
  if (item.agentsStates && typeof item.agentsStates === 'object') return item.agentsStates;
  return undefined;
}

function isCodexToolItemError(item: Record<string, unknown>): boolean {
  const exitCode = item.exitCode as number | undefined;
  return item.status === 'failed'
    || (exitCode !== undefined && exitCode !== 0)
    || Boolean(item.error);
}

function extractCodexTurnId(entry: any, it: any): string | undefined {
  return (
    (typeof it?.internal_chat_message_metadata_passthrough?.turn_id === 'string' && it.internal_chat_message_metadata_passthrough.turn_id) ||
    (typeof it?.turn_id === 'string' && it.turn_id) ||
    (typeof it?.turnId === 'string' && it.turnId) ||
    (typeof entry?.payload?.turn_id === 'string' && entry.payload.turn_id) ||
    (typeof entry?.payload?.turnId === 'string' && entry.payload.turnId) ||
    (typeof entry?.payload?.turn_attribution?.turn_id === 'string' && entry.payload.turn_attribution.turn_id) ||
    (typeof entry?.payload?.root_turn_id === 'string' && entry.payload.root_turn_id) ||
    (typeof entry?.turn_id === 'string' && entry.turn_id) ||
    undefined
  );
}

function normalizeCodexQuestions(raw: unknown): {
  prompt: string;
  options: string[];
  questions: StructuredQuestion[];
} {
  if (!Array.isArray(raw)) {
    return { prompt: '', options: [], questions: [] };
  }
  const questions: StructuredQuestion[] = [];
  const flatOptions: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') continue;
    const q = entry as Record<string, unknown>;
    const id = typeof q.id === 'string' && q.id ? q.id : `q_${i}`;
    const question =
      typeof q.question === 'string'
        ? q.question
        : typeof q.header === 'string'
          ? q.header
          : '';
    const options = Array.isArray(q.options)
      ? (q.options as Array<Record<string, unknown>>)
          .filter((o) => Boolean(o && typeof o === 'object'))
          .map((o, j) => {
            const label = String(o.label ?? o.id ?? `Option ${j + 1}`);
            if (i === 0) flatOptions.push(label);
            return {
              id: String(o.id ?? o.label ?? `opt_${j}`),
              label,
              ...(typeof o.description === 'string' ? { description: o.description } : {}),
            };
          })
      : [];
    questions.push({
      id,
      question,
      ...(typeof q.header === 'string' ? { header: q.header } : {}),
      options,
      ...(q.multiSelect === true || q.multi_select === true ? { multiSelect: true } : {}),
      ...(q.isOther === true || q.allow_other === true ? { isOther: true } : {}),
      ...(q.isSecret === true ? { isSecret: true } : {}),
    });
  }
  const prompt = questions[0]?.question || JSON.stringify(raw);
  return { prompt, options: flatOptions, questions };
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

function textOfInput(input: StartTurnInput['input'] | SteerInput): string {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    return input
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
  }
  if (input && typeof input === 'object' && 'input' in input) {
    return textOfInput(input.input);
  }
  return '';
}

/** 历史消息的内容字段按 Kimi Web wire 约定,与内部 adapter 类型不同。 */
type KimiHistoryContentPart =
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; tool_call_id: string; tool_name: string; input: unknown }
  | { type: 'tool_result'; tool_call_id: string; output: string; is_error: boolean };

function kimiHistoryPart(part: KimiHistoryContentPart): MessageContentPart {
  return part;
}

// ---------------------------------------------------------------------------
// Codex → ProviderAdapter
// ---------------------------------------------------------------------------

export class CodexProviderAdapter implements ProviderAdapter {
  readonly name = 'codex' as const;
  private readonly inner: CodexAdapter;
  /** 会话级设置持久化(重启不丢;只读路径回落 undefined = 未设置)。 */
  private readonly settings: SettingsStore;
  private readonly syncedPlanThreads = new Set<string>();
  private cachedModels: NativeModel[] | null = null;
  private readonly providers?: CliProviders;

  constructor(options?: ConstructorParameters<typeof CodexAdapter>[0] & { settingsPath?: string }) {
    const { settingsPath, ...innerOptions } = options ?? {};
    this.inner = new CodexAdapter(innerOptions);
    this.providers = innerOptions.providers;
    this.settings = new SettingsStore(settingsPath);
    this.inner.restoreThreadAliases(this.settings.listStrings('nativeThreadId'));
    if (typeof (this.inner as any).onEvent === 'function') {
      (this.inner as any).onEvent((ev: any) => {
        if (ev && ev.type === 'disconnected') {
          this.syncedPlanThreads.clear();
        }
      });
    }
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
      steer: true,
      steerAttachments: true,
      attachments: true,
      compact: true,
      fork: true,
      clone: false,
      rollback: true,
      rename: true,
      archive: true,
      nativeArchive: true,
      delete: true,
      planMode: true,
      permissionModes: ['manual', 'auto', 'yolo'],
      manualApproval: true,
      goals: true,
      swarm: false,
      tower: false,
      btw: false,
      subagents: true,
      mcp: true,
      terminals: true,
      review: true,
      models: true,
      thinkingLevels: true,
      commands: true,
      skills: true,
      usage: true,
      elicitation: true,
    };
  }

  /**
   * thread/list 服务端每次全扫 rollout 文件,本机实测 ~4.7s。
   * 前端首页常用 page_size=50,工作区聚合用 100——以前缓存只认 limit===100,
   * 导致切到 Codex 每次都冷扫。现在无 cursor/cwd/archived 的首屏请求
   * (limit≤100)共用一份 limit=100 暖页,再按需切片;切片游标用 __slice__:N,
   * 吃完暖页后再接原生 next_cursor。
   */
  private fullPage: { ts: number; page: SessionPage } | null = null;
  private fullPageInflight: Promise<SessionPage> | null = null;
  /** 缓存代际:create/startTurn 使缓存失效时递增,防止在飞旧请求写回过期页。 */
  private fullPageGen = 0;
  private static readonly LIST_TTL_MS = 30_000;
  /** 切片游标格式:__slice__:{gen}:{offset} —— gen 对不上就回退原生翻页,避免漂移。 */
  private static readonly SLICE_CURSOR_PREFIX = '__slice__:';

  async list(query: ListSessionsQuery = {}): Promise<SessionPage> {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 100);
    let sliceOffset: number | null = null;
    let sliceGen: number | null = null;
    if (typeof query.cursor === 'string' && query.cursor.startsWith(CodexProviderAdapter.SLICE_CURSOR_PREFIX)) {
      const parts = query.cursor.slice(CodexProviderAdapter.SLICE_CURSOR_PREFIX.length).split(':');
      if (parts.length === 2) {
        sliceGen = Number(parts[0]);
        sliceOffset = Number(parts[1]);
      } else if (parts.length === 1) {
        // 兼容旧格式 __slice__:N(无代际):当作当前代。
        sliceGen = this.fullPageGen;
        sliceOffset = Number(parts[0]);
      }
    }

    if (
      query.archived == null
      && query.cwd == null
      && (query.limit ?? 100) <= 100
      && (
        query.cursor == null
        || (
          sliceOffset !== null
          && sliceGen !== null
          && Number.isFinite(sliceOffset)
          && Number.isFinite(sliceGen)
          && sliceOffset >= 0
        )
      )
    ) {
      // 代际不符:暖页已重建,旧偏移不可信 → 回退原生游标路径。
      if (sliceGen !== null && sliceGen !== this.fullPageGen) {
        return this.fetchPage({ ...query, cursor: undefined, limit });
      }
      const full = await this.cachedFullPage();
      // cachedFullPage 可能在等待期间被 invalidate,再核一次代际。
      if (sliceGen !== null && sliceGen !== this.fullPageGen) {
        return this.fetchPage({ ...query, cursor: undefined, limit });
      }
      const offset = sliceOffset ?? 0;
      if (offset >= full.items.length) {
        // 暖页已耗尽:若还有原生游标,从原生继续;否则空页。
        if (!full.next_cursor) return { items: [] };
        return this.fetchPage({ ...query, cursor: full.next_cursor, limit });
      }
      const items = full.items.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      if (nextOffset < full.items.length) {
        return {
          items,
          next_cursor: `${CodexProviderAdapter.SLICE_CURSOR_PREFIX}${this.fullPageGen}:${nextOffset}`,
        };
      }
      return { items, ...(full.next_cursor ? { next_cursor: full.next_cursor } : {}) };
    }
    return this.fetchPage(query);
  }

  private cachedFullPage(): Promise<SessionPage> {
    if (this.fullPage && Date.now() - this.fullPage.ts < CodexProviderAdapter.LIST_TTL_MS) {
      return Promise.resolve(this.fullPage.page);
    }
    if (this.fullPageInflight) return this.fullPageInflight;
    const gen = this.fullPageGen;
    this.fullPageInflight = this.fetchPage({ limit: 100 }).then(
      (page) => {
        // 空页不入缓存:app-server 刚 spawn 时索引未就绪可能暂时返回 0 条
        // (实测预热阶段出现过),缓存空页会把"没有会话"的假象扩散 30s。
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
      // 网关 thread/start 走 app-server,source 实测是 vscode 而非 cli;
      // 只滤 cli 会把本网关新建的会话从列表里藏掉。子 agent / ephemeral 仍丢弃。
      sourceKinds: ['cli', 'vscode', 'appServer'],
    });
    // 只列主会话,对齐 `codex resume` 的行为:parentThreadId 非空的是子 agent
    // 线程,ephemeral 是临时线程,都不应出现在列表里(字段名来自 thread/list
    // 原始响应,已实测 0.147.0)。
    const items = threads
      .filter((t) => {
        const raw = t as Record<string, unknown>;
        return raw.parentThreadId == null && raw.ephemeral !== true;
      })
      .map((t) => this.toSession(t, undefined, query.archived === true));
    return { items, ...(nextCursor ? { next_cursor: nextCursor } : {}) };
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const cwd = input.cwd ?? (input.metadata?.cwd as string | undefined) ?? process.cwd();
    const model = this.settings.getString('model', '__default__') ?? this.providers?.defaultModelRef();
    const thread = await this.inner.create({ cwd, ...(model ? { model } : {}) });
    if (model) this.settings.set('model', thread.id, model);
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

  private static readonly MAX_LIVE_SUBAGENT_SESSIONS = 64;
  private static readonly MAX_LIVE_SUBAGENTS_PER_SESSION = 64;
  private static readonly LIVE_SUBAGENT_TERMINAL_TTL_MS = 5 * 60_000;
  private readonly activeThreadTurns = new Set<string>();
  private readonly liveSubagents = new Map<
    string,
    Map<string, { agentId: string; parentToolUseId?: string; description?: string; subagentType?: string; status: SubagentStatus; completedAt?: number }>
  >();

  private pruneLiveSubagents(sessionId?: string): void {
    const now = Date.now();
    const pruneBucket = (
      bucket: Map<string, { agentId: string; parentToolUseId?: string; description?: string; subagentType?: string; status: SubagentStatus; completedAt?: number }>,
    ): void => {
      for (const [id, entry] of bucket) {
        if (
          entry.completedAt !== undefined &&
          now - entry.completedAt >= CodexProviderAdapter.LIVE_SUBAGENT_TERMINAL_TTL_MS
        ) {
          bucket.delete(id);
        }
      }
      while (bucket.size > CodexProviderAdapter.MAX_LIVE_SUBAGENTS_PER_SESSION) {
        const oldest = bucket.keys().next().value;
        if (oldest === undefined) break;
        bucket.delete(oldest);
      }
    };
    if (sessionId) {
      const bucket = this.liveSubagents.get(sessionId);
      if (!bucket) return;
      pruneBucket(bucket);
      if (bucket.size === 0) this.liveSubagents.delete(sessionId);
      return;
    }
    for (const [sid, bucket] of this.liveSubagents) {
      pruneBucket(bucket);
      if (bucket.size === 0) this.liveSubagents.delete(sid);
    }
  }

  private recordLiveSubagent(
    sessionId: string,
    agentId: string | undefined,
    parentToolUseId?: string,
    description?: string,
    subagentType?: string,
    status?: SubagentStatus,
  ): void {
    if (!agentId || agentId === sessionId) return;
    let bucket = this.liveSubagents.get(sessionId);
    if (!bucket) {
      while (this.liveSubagents.size >= CodexProviderAdapter.MAX_LIVE_SUBAGENT_SESSIONS) {
        const oldestSid = this.liveSubagents.keys().next().value;
        if (oldestSid === undefined) break;
        this.liveSubagents.delete(oldestSid);
      }
      bucket = new Map();
      this.liveSubagents.set(sessionId, bucket);
    } else {
      this.liveSubagents.delete(sessionId);
      this.liveSubagents.set(sessionId, bucket);
    }
    const existing = bucket.get(agentId);
    // 显式 unknown(如 agentsStates 里的未知状态)不覆盖既有 running;其余按传入状态。
    const nextStatus = status === 'unknown'
      ? existing?.status ?? 'unknown'
      : status ?? existing?.status ?? 'running';
    const terminal = nextStatus === 'completed' || nextStatus === 'failed' || nextStatus === 'cancelled';
    bucket.delete(agentId);
    bucket.set(agentId, {
      agentId,
      parentToolUseId: parentToolUseId ?? existing?.parentToolUseId,
      description: description ?? existing?.description,
      subagentType: subagentType ?? existing?.subagentType,
      status: nextStatus,
      completedAt: terminal ? (existing?.completedAt ?? Date.now()) : undefined,
    });
    this.pruneLiveSubagents(sessionId);
  }

  // thread/read 对大会话是秒级(901MB rollout 实测 9.4s),而页面加载会并发打
  // 2-3 个 getHistory。rollout 文件是真相源:按 mtimeMs:size 做缓存键,没变就
  // 复用同一个 Promise(并发合并),变了自然失效;失败删缓存不毒化。
  // 有界 LRU 缓存 (最大 64 条,TTL 5 分钟)。
  private static readonly MAX_HISTORY_CACHE_ENTRIES = 64;
  private static readonly HISTORY_CACHE_TTL_MS = 5 * 60_000;
  private historyCache = new Map<string, { key: string; p: Promise<Message[]>; ts: number }>();

  private static readonly MAX_ROLLOUT_CACHE_ENTRIES = 64;
  private static readonly ROLLOUT_CACHE_TTL_MS = 5 * 60_000;
  private rolloutParsedCache = new Map<string, { key: string; p: Promise<Message[]>; ts: number }>();

  /** 优先复用 inner.locateRollout / getCachedRolloutPath(O(1)),未命中回退 findCodexRollout 递归扫描。 */
  private async resolveCodexRolloutPath(sessionId: string): Promise<string | null> {
    try {
      if (typeof (this.inner as any).locateRollout === 'function') {
        const found = await (this.inner as any).locateRollout(sessionId, findCodexRollout);
        if (found) return found;
      }
      if (typeof (this.inner as any).getCachedRolloutPath === 'function') {
        const cached = (this.inner as any).getCachedRolloutPath(sessionId);
        if (cached) return cached;
      }
    } catch {
      // duck typing 降级
    }
    return findCodexRollout(sessionId).catch(() => null);
  }

  /** 带 mtime+size 缓存和 inflight coalesce 解析 rollout,避免活跃历史每次重复扫描和解析 16MiB。 */
  private async getCachedRolloutHistory(rolloutPath: string, sessionId: string, size: number, mtimeMs: number): Promise<Message[]> {
    const key = `${rolloutPath}:${mtimeMs}:${size}`;
    const now = Date.now();
    const hit = this.rolloutParsedCache.get(sessionId);
    if (hit && hit.key === key && now - hit.ts < CodexProviderAdapter.ROLLOUT_CACHE_TTL_MS) {
      this.rolloutParsedCache.delete(sessionId);
      this.rolloutParsedCache.set(sessionId, hit);
      return hit.p;
    }
    const p = this.readCodexRolloutHistory(rolloutPath, sessionId, size);
    if (this.rolloutParsedCache.has(sessionId)) {
      this.rolloutParsedCache.delete(sessionId);
    } else if (this.rolloutParsedCache.size >= CodexProviderAdapter.MAX_ROLLOUT_CACHE_ENTRIES) {
      const oldest = this.rolloutParsedCache.keys().next().value;
      if (oldest !== undefined) this.rolloutParsedCache.delete(oldest);
    }
    this.rolloutParsedCache.set(sessionId, { key, p, ts: now });
    p.catch(() => {
      if (this.rolloutParsedCache.get(sessionId)?.p === p) this.rolloutParsedCache.delete(sessionId);
    });
    return p;
  }

  async getHistory(sessionId: string, _query: HistoryQuery = {}): Promise<Message[]> {
    const isLive =
      this.activeThreadTurns.has(sessionId) ||
      (typeof (this.inner as any).findActiveTurnId === 'function' &&
        Boolean((this.inner as any).findActiveTurnId(sessionId)));
    const rollout = !isLive ? await this.resolveCodexRolloutPath(sessionId) : null;
    const stat = rollout ? await fsp.stat(rollout).catch(() => null) : null;
    if (!rollout || !stat) return this.readCodexHistory(sessionId); // 未落盘新线程或有进行中 turn,走 readCodexHistory
    const key = `${stat.mtimeMs}:${stat.size}`;
    const now = Date.now();
    const hit = this.historyCache.get(sessionId);
    if (hit && hit.key === key && now - hit.ts < CodexProviderAdapter.HISTORY_CACHE_TTL_MS) {
      this.historyCache.delete(sessionId);
      this.historyCache.set(sessionId, hit);
      return hit.p;
    }
    const p = (async () => {
      const parsed = await this.getCachedRolloutHistory(rollout, sessionId, stat.size, stat.mtimeMs);
      if (parsed.length > 0) return parsed;
      return this.readCodexHistory(sessionId);
    })();
    if (this.historyCache.has(sessionId)) {
      this.historyCache.delete(sessionId);
    } else if (this.historyCache.size >= CodexProviderAdapter.MAX_HISTORY_CACHE_ENTRIES) {
      const oldest = this.historyCache.keys().next().value;
      if (oldest !== undefined) this.historyCache.delete(oldest);
    }
    this.historyCache.set(sessionId, { key, p, ts: now });
    p.catch(() => {
      if (this.historyCache.get(sessionId)?.p === p) this.historyCache.delete(sessionId);
    });
    return p;
  }

  private async readCodexRolloutHistory(
    rolloutPath: string,
    sessionId: string,
    size: number,
  ): Promise<Message[]> {
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(rolloutPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch {
      return [];
    }

    let text = '';
    try {
      const MAX_ROLLOUT_TAIL_BYTES = 16 * 1024 * 1024;
      const startOffset = size > MAX_ROLLOUT_TAIL_BYTES ? size - MAX_ROLLOUT_TAIL_BYTES : 0;
      const targetBytes = size - startOffset;
      const buf = Buffer.allocUnsafe(targetBytes);
      let totalRead = 0;
      while (totalRead < targetBytes) {
        const { bytesRead } = await fh.read(buf, totalRead, targetBytes - totalRead, startOffset + totalRead);
        if (bytesRead === 0) break;
        totalRead += bytesRead;
      }
      let slice = buf.subarray(0, totalRead);
      if (startOffset > 0) {
        const firstNl = slice.indexOf(0x0a);
        slice = firstNl >= 0 ? slice.subarray(firstNl + 1) : Buffer.alloc(0);
      }
      text = slice.toString('utf8');
    } finally {
      await fh.close().catch(() => undefined);
    }

    if (!text.trim()) return [];

    const messages: Message[] = [];
    const seenItemIds = new Set<string>();
    const seenToolCalls = new Set<string>();
    const seenToolResults = new Set<string>();
    const toolMetaByCallId = new Map<string, { agentId?: string; callMsg?: Message; resultMsg?: Message }>();
    let lastAssistantMsg: Message | null = null;
    let currentTurnId: string | null = null;
    let pendingUserMsg: { msg: Message; turnId?: string; text: string; isResponseItem: boolean } | null = null;
    let lastReasoningText: string | null = null;

    const attachAgentToCall = (callId: string, agentId: string): void => {
      if (!callId || !agentId) return;
      const entry = toolMetaByCallId.get(callId) ?? {};
      entry.agentId = agentId;
      toolMetaByCallId.set(callId, entry);
      if (entry.callMsg) {
        entry.callMsg.metadata = { ...(entry.callMsg.metadata ?? {}), agent_id: agentId, agentId };
      }
      if (entry.resultMsg) {
        entry.resultMsg.metadata = { ...(entry.resultMsg.metadata ?? {}), agent_id: agentId, agentId };
        const part = entry.resultMsg.content[0] as Record<string, unknown> | undefined;
        if (part && part.type === 'tool_result') {
          const cur = typeof part.output === 'string' ? part.output : '';
          if (!cur.includes('agent_id:')) {
            part.output = cur ? `agent_id: ${agentId}\n${cur}` : `agent_id: ${agentId}`;
          }
        }
      }
    };

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      // Skip pure control / telemetry / developer records
      if (
        entry.type === 'session_meta'
        || entry.type === 'world_state'
        || entry.type === 'turn_context'
        || entry.type === 'token_usage_record'
        || entry.type === 'inter_agent_communication_metadata'
      ) {
        continue;
      }

      let it: Record<string, unknown>;
      if (entry.type === 'event_msg' && entry.payload && typeof entry.payload === 'object') {
        const p = entry.payload as Record<string, unknown>;
        if (p.type === 'item_completed' && p.item && typeof p.item === 'object') {
          it = p.item as Record<string, unknown>;
        } else if (
          p.type === 'task_started'
          || p.type === 'task_complete'
          || p.type === 'token_count'
          || p.type === 'thread_settings_applied'
        ) {
          if (p.type === 'task_started' || p.type === 'task_complete') {
            const boundaryTurnId = extractCodexTurnId(entry, p);
            if (boundaryTurnId && boundaryTurnId !== currentTurnId) {
              currentTurnId = boundaryTurnId;
            }
            pendingUserMsg = null;
          }
          continue;
        } else {
          it = p;
        }
      } else if (entry.type === 'response_item' && entry.payload && typeof entry.payload === 'object') {
        it = entry.payload as Record<string, unknown>;
      } else {
        it = entry as Record<string, unknown>;
      }

      const entryTurnId = extractCodexTurnId(entry, it);
      if (entryTurnId && entryTurnId !== currentTurnId) {
        currentTurnId = entryTurnId;
        pendingUserMsg = null;
      }

      const rawType = (typeof it.type === 'string'
        ? it.type
        : typeof entry.type === 'string'
          ? entry.type
          : '') as string;
      const normType = rawType.toLowerCase();
      const createdAt = isoFromCodexTime(
        it.createdAt ?? it.updatedAt ?? it.startedAtMs ?? it.completedAtMs ?? entry.createdAt ?? entry.timestamp,
      );
      const itemId =
        (typeof it.id === 'string' && it.id) || (typeof it.call_id === 'string' && it.call_id) || undefined;

      // Skip developer / system / inter-agent messages in response_item
      if (normType === 'additional_tools' || normType === 'agent_message' && entry.type === 'response_item') {
        continue;
      }
      if (normType === 'message' && (it.role === 'developer' || it.role === 'system')) {
        continue;
      }

      // User messages
      if (normType === 'usermessage' || normType === 'user_message' || (normType === 'message' && it.role === 'user')) {
        if (itemId && seenItemIds.has(itemId)) continue;
        let userText = extractCodexText(it);
        if (!userText && typeof it.message === 'string') userText = it.message;
        userText = stripCodexSystemTags(userText).trim();
        if (!userText) continue;

        const isUserMessageEvent = normType === 'usermessage' || normType === 'user_message';
        const msgTurnId = entryTurnId || currentTurnId;

        // 同一 turn 内的用户提问 pair 识别 (禁止跨 turn 关联)
        let isMatchingPair = false;
        if (pendingUserMsg && pendingUserMsg.text === userText) {
          if (pendingUserMsg.turnId && msgTurnId) {
            isMatchingPair = (pendingUserMsg.turnId === msgTurnId);
          } else {
            // 无边界场景 (缺少 turnId): 在当前未切换 turn 的上下文内视为同 pair
            isMatchingPair = true;
          }
        }

        if (isMatchingPair && pendingUserMsg) {
          if (isUserMessageEvent && pendingUserMsg.isResponseItem) {
            // 用 UserMessage 原生 UUID 替换先前的 response_item id
            if (itemId) {
              pendingUserMsg.msg.id = itemId;
              seenItemIds.add(itemId);
            }
            if (msgTurnId && !pendingUserMsg.msg.metadata?.turnId) {
              pendingUserMsg.msg.metadata = { ...(pendingUserMsg.msg.metadata ?? {}), turnId: msgTurnId };
            }
            pendingUserMsg = null;
            continue;
          }
          if (!isUserMessageEvent && !pendingUserMsg.isResponseItem) {
            if (itemId) seenItemIds.add(itemId);
            pendingUserMsg = null;
            continue;
          }
        }

        const msgId = itemId ?? `msg_${randomUUID()}`;
        if (itemId) seenItemIds.add(itemId);
        const userMsg: Message = {
          id: msgId,
          session_id: sessionId,
          role: 'user',
          content: [{ type: 'text', text: userText }],
          created_at: createdAt,
          ...(msgTurnId ? { metadata: { turnId: msgTurnId } } : {}),
        };
        messages.push(userMsg);
        pendingUserMsg = {
          msg: userMsg,
          turnId: msgTurnId ?? undefined,
          text: userText,
          isResponseItem: !isUserMessageEvent,
        };
        lastAssistantMsg = null;
        continue;
      }

      // Assistant messages (AgentMessage / agent_message / response_item message role=assistant)
      if (normType === 'agentmessage' || normType === 'agent_message' || (normType === 'message' && it.role === 'assistant')) {
        pendingUserMsg = null;
        let agentText = typeof it.text === 'string' ? it.text : typeof it.message === 'string' ? it.message : '';
        if (!agentText && Array.isArray(it.content)) {
          agentText = it.content
            .map((c: any) => (typeof c === 'string' ? c : (c?.text ?? '')))
            .filter(Boolean)
            .join('');
        }
        agentText = stripCodexSystemTags(agentText);
        agentText = stripCodexMemoryCitations(agentText).trim();
        const phase = typeof it.phase === 'string' ? it.phase : undefined;

        if (itemId && seenItemIds.has(itemId)) {
          if (phase && lastAssistantMsg?.metadata && !lastAssistantMsg.metadata.phase) {
            lastAssistantMsg.metadata.phase = phase;
          }
          continue;
        }

        if (
          lastAssistantMsg &&
          lastAssistantMsg.role === 'assistant' &&
          lastAssistantMsg.content.length === 1 &&
          lastAssistantMsg.content[0].type === 'text' &&
          lastAssistantMsg.content[0].text === agentText
        ) {
          if (phase && lastAssistantMsg.metadata && !lastAssistantMsg.metadata.phase) {
            lastAssistantMsg.metadata.phase = phase;
          }
          if (itemId) seenItemIds.add(itemId);
          continue;
        }

        if (!agentText && !phase) continue;
        if (itemId) seenItemIds.add(itemId);
        const msg: Message = {
          id: itemId ?? `msg_${randomUUID()}`,
          session_id: sessionId,
          role: 'assistant',
          content: [{ type: 'text', text: agentText, ...(phase ? { phase } : {}) }],
          created_at: createdAt,
          ...(phase ? { metadata: { phase } } : {}),
        };
        messages.push(msg);
        lastAssistantMsg = msg;
        continue;
      }

      // Reasoning
      if (normType === 'reasoning') {
        if (itemId && seenItemIds.has(itemId)) continue;
        const summarySource: Record<string, unknown> = Array.isArray(it.summary_text) && !Array.isArray(it.summary)
          ? { ...it, summary: it.summary_text }
          : it;
        let summary =
          typeof it.summaryText === 'string' && it.summaryText.trim()
            ? it.summaryText.trim()
            : extractCodexReasoningSummary(summarySource);
        if (summary) summary = stripCodexMemoryCitations(summary).replace(/ {2,}/g, ' ').trim();
        if (!summary) continue;
        if (lastReasoningText === summary) {
          if (itemId) seenItemIds.add(itemId);
          continue;
        }
        if (itemId) seenItemIds.add(itemId);
        lastReasoningText = summary;
        messages.push({
          id: itemId ?? `msg_${randomUUID()}`,
          session_id: sessionId,
          role: 'assistant',
          content: [kimiHistoryPart({ type: 'thinking', thinking: summary })],
          created_at: createdAt,
        });
        lastAssistantMsg = null;
        continue;
      }

      // Plan
      if (normType === 'plan') {
        if (itemId && seenItemIds.has(itemId)) continue;
        let planText = typeof it.text === 'string' ? it.text.trim() : '';
        if (planText) planText = stripCodexMemoryCitations(planText).trim();
        if (!planText) continue;
        if (itemId) seenItemIds.add(itemId);
        messages.push({
          id: itemId ?? `msg_${randomUUID()}`,
          session_id: sessionId,
          role: 'assistant',
          content: [{ type: 'text', text: planText }],
          created_at: createdAt,
          metadata: { item_type: 'plan' },
        });
        lastAssistantMsg = null;
        continue;
      }

      // Codex 0.169 SubAgentActivity links child thread ID back to the spawn_agent call_id
      if (normType === 'subagentactivity') {
        const callId = typeof it.id === 'string' ? it.id : '';
        const childThreadId =
          (typeof it.agent_thread_id === 'string' && it.agent_thread_id)
          || (typeof it.agentThreadId === 'string' && it.agentThreadId)
          || (typeof it.agentId === 'string' && it.agentId)
          || '';
        if (callId && childThreadId) {
          attachAgentToCall(callId, childThreadId);
        }
        continue;
      }

      // Codex 0.169 response_item function_call / custom_tool_call
      if (normType === 'function_call' || normType === 'custom_tool_call') {
        const callId = (typeof it.call_id === 'string' && it.call_id) || (typeof it.id === 'string' && it.id) || randomUUID();
        if (seenToolCalls.has(callId)) continue;
        seenToolCalls.add(callId);
        const rawName = (typeof it.name === 'string' && it.name) || 'tool';
        let parsedArgs: unknown = it.arguments ?? it.input ?? {};
        if (typeof parsedArgs === 'string') {
          try { parsedArgs = JSON.parse(parsedArgs); } catch { /* keep string */ }
        }
        const linked = toolMetaByCallId.get(callId);
        const callTurnId = entryTurnId || currentTurnId;
        const callMsg: Message = {
          id: `${callId}_call`,
          session_id: sessionId,
          role: 'assistant',
          content: [kimiHistoryPart({
            type: 'tool_use',
            tool_call_id: callId,
            tool_name: rawName,
            input: parsedArgs,
          })],
          created_at: createdAt,
          metadata: {
            ...(linked?.agentId ? { agent_id: linked.agentId, agentId: linked.agentId } : {}),
            ...(callTurnId ? { turnId: callTurnId } : {}),
          },
        };
        toolMetaByCallId.set(callId, { ...linked, callMsg });
        messages.push(callMsg);
        lastAssistantMsg = null;
        continue;
      }

      // Codex 0.169 response_item function_call_output / custom_tool_call_output
      if (normType === 'function_call_output' || normType === 'custom_tool_call_output') {
        const callId = (typeof it.call_id === 'string' && it.call_id) || (typeof it.id === 'string' && it.id) || '';
        if (!callId || seenToolResults.has(callId)) continue;
        seenToolResults.add(callId);
        const rawOut = it.output;
        let outText = typeof rawOut === 'string'
          ? rawOut
          : extractCodexContentItemsText(rawOut) ?? (rawOut !== undefined ? JSON.stringify(rawOut) : '');
        const linked = toolMetaByCallId.get(callId);
        if (linked?.agentId && !outText.includes('agent_id:')) {
          outText = outText ? `agent_id: ${linked.agentId}\n${outText}` : `agent_id: ${linked.agentId}`;
        }
        const resTurnId = entryTurnId || currentTurnId;
        const resultMsg: Message = {
          id: `${callId}_result`,
          session_id: sessionId,
          role: 'assistant',
          content: [kimiHistoryPart({
            type: 'tool_result',
            tool_call_id: callId,
            output: outText,
            is_error: isCodexToolItemError(it),
          })],
          created_at: createdAt,
          metadata: {
            ...(linked?.agentId ? { agent_id: linked.agentId, agentId: linked.agentId } : {}),
            ...(resTurnId ? { turnId: resTurnId } : {}),
          },
        };
        toolMetaByCallId.set(callId, { ...linked, resultMsg });
        messages.push(resultMsg);
        lastAssistantMsg = null;
        continue;
      }

      // ThreadItem tool items (commandExecution, collabAgentToolCall, etc. - both camelCase and PascalCase)
      const mappedItemType =
        normType === 'commandexecution' || normType === 'exec_command' ? 'commandExecution'
          : normType === 'collabagenttoolcall' || normType === 'collabtoolcall' ? 'collabAgentToolCall'
            : normType === 'filechange' ? 'fileChange'
              : normType === 'mcptoolcall' ? 'mcpToolCall'
                : normType === 'websearch' ? 'webSearch'
                  : normType === 'dynamictoolcall' ? 'dynamicToolCall'
                    : normType === 'imageview' ? 'imageView'
                      : rawType;
      if (isCodexToolItem(mappedItemType)) {
        const callId = (it.call_id as string) ?? (it.id as string) ?? randomUUID();
        const rawName = (it.name as string) ?? (it.tool as string) ?? mappedItemType;
        const input = it.input ?? it.command ?? it.arguments ?? it.query ?? it.changes ?? {};
        const phase = typeof it.phase === 'string' ? it.phase : undefined;
        const parentToolUseId = typeof it.parentToolUseId === 'string' ? it.parentToolUseId : undefined;

        const receiverThreadIds = Array.isArray(it.receiverThreadIds)
          ? (it.receiverThreadIds as string[])
          : Array.isArray(it.receiver_thread_ids)
            ? (it.receiver_thread_ids as string[])
            : undefined;
        const linked = toolMetaByCallId.get(callId);
        const agentId =
          (typeof it.agentId === 'string' && it.agentId) ||
          (typeof it.agentThreadId === 'string' && it.agentThreadId) ||
          (typeof it.agent_thread_id === 'string' && it.agent_thread_id) ||
          (typeof it.receiverThreadId === 'string' && it.receiverThreadId) ||
          receiverThreadIds?.[0] ||
          linked?.agentId ||
          undefined;

        if (agentId && (mappedItemType === 'collabAgentToolCall' || rawName === 'spawn_agent')) {
          attachAgentToCall(callId, agentId);
        }

        const hasToolMeta = Boolean(phase || agentId || receiverThreadIds);

        if (!seenToolCalls.has(callId)) {
          seenToolCalls.add(callId);
          const callMsg: Message = {
            id: `${callId}_call`,
            session_id: sessionId,
            role: 'assistant',
            content: [kimiHistoryPart({
              type: 'tool_use',
              tool_call_id: callId,
              tool_name: rawName,
              input,
              ...(phase ? { phase } : {}),
              ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
            })],
            created_at: createdAt,
            ...(hasToolMeta ? {
              metadata: {
                ...(phase ? { phase } : {}),
                ...(agentId ? { agent_id: agentId, agentId } : {}),
                ...(receiverThreadIds ? { receiverThreadIds } : {}),
              },
            } : {}),
          };
          toolMetaByCallId.set(callId, { ...linked, ...(agentId ? { agentId } : {}), callMsg });
          messages.push(callMsg);
        }

        let outputText = extractCodexToolOutput({
          ...it,
          ...(it.agents_states && !it.agentsStates ? { agentsStates: it.agents_states } : {}),
        });
        if (mappedItemType === 'collabAgentToolCall' || rawName === 'collabAgentToolCall') {
          if (agentId) {
            if (outputText === null || outputText === undefined || outputText === '') {
              outputText = `agent_id: ${agentId}`;
            } else if (!outputText.includes('agent_id:')) {
              outputText = `agent_id: ${agentId}\n${outputText}`;
            }
          }
        }
        const structuredOutput = extractCodexStructuredOutput(it);
        if ((outputText !== null || structuredOutput !== undefined) && !seenToolResults.has(callId)) {
          seenToolResults.add(callId);
          const resultMsg: Message = {
            id: `${callId}_result`,
            session_id: sessionId,
            role: 'assistant',
            content: [kimiHistoryPart({
              type: 'tool_result',
              tool_call_id: callId,
              output: outputText ?? '',
              is_error: isCodexToolItemError(it),
              ...(structuredOutput !== undefined ? { structuredOutput } : {}),
              ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
            })],
            created_at: createdAt,
            ...(hasToolMeta ? {
              metadata: {
                ...(phase ? { phase } : {}),
                ...(agentId ? { agent_id: agentId, agentId } : {}),
                ...(receiverThreadIds ? { receiverThreadIds } : {}),
              },
            } : {}),
          };
          toolMetaByCallId.set(callId, { ...toolMetaByCallId.get(callId), ...(agentId ? { agentId } : {}), resultMsg });
          messages.push(resultMsg);
        }
        lastAssistantMsg = null;
        continue;
      }
    }

    return messages;
  }

  private async readCodexHistory(sessionId: string): Promise<Message[]> {
    const turns = await this.inner.getHistory(sessionId);
    const messages: Message[] = [];

    // 预取 rollout 并按 callId+partType 筛选出在线缺失的工具消息;位置由 rollout 里的相邻消息锚定。
    let rolloutOrder: Message[] = [];
    const missingTools = new Map<Message, string | undefined>();
    try {
      const rollout = await this.resolveCodexRolloutPath(sessionId);
      if (rollout) {
        const stat = await fsp.stat(rollout).catch(() => null);
        if (stat && stat.size > 0) {
          const rolloutMessages = await this.getCachedRolloutHistory(rollout, sessionId, stat.size, stat.mtimeMs);

          // 收集在线已有的工具部件: callId:tool_use / callId:tool_result
          const existingParts = new Set<string>();
          for (const turn of turns) {
            for (const item of (turn as { items?: unknown[] }).items ?? []) {
              const it = item as Record<string, unknown>;
              const callId = (it.call_id as string) ?? (it.id as string);
              const type = it.type as string;
              if (callId && (type === 'custom_tool_call' || isCodexToolItem(type))) {
                existingParts.add(`${callId}:tool_use`);
                if (extractCodexToolOutput(it) !== null || extractCodexStructuredOutput(it) !== undefined) {
                  existingParts.add(`${callId}:tool_result`);
                }
              }
            }
          }

          rolloutOrder = rolloutMessages;
          for (const msg of rolloutMessages) {
            const part = msg.content[0];
            if (part && (part.type === 'tool_use' || part.type === 'tool_result') && part.tool_call_id) {
              const partKey = `${part.tool_call_id}:${part.type}`;
              if (!existingParts.has(partKey)) {
                existingParts.add(partKey);
                const tId = (msg.metadata?.turnId as string) || (msg.metadata?.turn_id as string);
                missingTools.set(msg, tId || undefined);
              }
            }
          }
        }
      }
    } catch {
      // rollout 预取安全降级
    }

    const turnRanges = new Map<string, { start: number; end: number }>();
    for (const turn of turns) {
      const turnId = (turn as any).id;
      const turnStart = messages.length;

      for (const item of (turn as { items?: unknown[] }).items ?? []) {
        const it = item as Record<string, unknown>;
        const type = it.type as string;
        const turnRec = turn as { startedAt?: unknown; completedAt?: unknown };
        const createdAt = isoFromCodexTime(
          it.createdAt ?? it.updatedAt ?? it.startedAtMs ?? it.completedAtMs ?? turnRec.startedAt ?? turnRec.completedAt,
        );
        if (type === 'userMessage') {
          messages.push({
            id: (it.id as string) ?? randomUUID(),
            session_id: sessionId,
            role: 'user',
            content: [{ type: 'text', text: extractCodexText(it) }],
            created_at: createdAt,
            metadata: { turnId },
          });
        } else if (type === 'agentMessage') {
          const phase = typeof it.phase === 'string' ? it.phase : undefined;
          messages.push({
            id: (it.id as string) ?? randomUUID(),
            session_id: sessionId,
            role: 'assistant',
            content: [{ type: 'text', text: (it.text as string) ?? '' }],
            created_at: createdAt,
            metadata: { ...(phase ? { phase } : {}), turnId },
          });
        } else if (type === 'reasoning') {
          const summary =
            typeof it.summaryText === 'string' && it.summaryText.trim()
              ? it.summaryText.trim()
              : extractCodexReasoningSummary(it);
          if (!summary) continue;
          messages.push({
            id: (it.id as string) ?? randomUUID(),
            session_id: sessionId,
            role: 'assistant',
            content: [kimiHistoryPart({ type: 'thinking', thinking: summary })],
            created_at: createdAt,
          });
        } else if (type === 'plan') {
          const text = typeof it.text === 'string' ? it.text.trim() : '';
          if (!text) continue;
          messages.push({
            id: (it.id as string) ?? randomUUID(),
            session_id: sessionId,
            role: 'assistant',
            content: [{ type: 'text', text }],
            created_at: createdAt,
            metadata: { item_type: 'plan' },
          });
        } else if (type === 'enteredReviewMode' || type === 'exitedReviewMode') {
          const text =
            typeof it.text === 'string' && it.text.trim()
              ? it.text.trim()
              : typeof it.review === 'string' && it.review.trim()
                ? it.review.trim()
                : '';
          if (!text) continue;
          messages.push({
            id: (it.id as string) ?? randomUUID(),
            session_id: sessionId,
            role: 'assistant',
            content: [{ type: 'text', text }],
            created_at: createdAt,
            metadata: { item_type: type },
          });
        } else if (type === 'subAgentActivity') {
          const receiverThreadIds = Array.isArray(it.receiverThreadIds)
            ? (it.receiverThreadIds as string[])
            : undefined;
          const agentId =
            (typeof it.agentId === 'string' && it.agentId) ||
            (typeof it.agentThreadId === 'string' && it.agentThreadId) ||
            (typeof it.agent_thread_id === 'string' && it.agent_thread_id) ||
            (typeof it.agentPath === 'string' && it.agentPath) ||
            (typeof it.receiverThreadId === 'string' && it.receiverThreadId) ||
            receiverThreadIds?.[0] ||
            undefined;
          const explicitParentId =
            (typeof it.parentToolUseId === 'string' && it.parentToolUseId) ||
            (typeof it.call_id === 'string' && it.call_id) ||
            undefined;
          const matchCallId = explicitParentId ?? (typeof it.id === 'string' && it.id ? it.id : undefined);
          let matchedExisting = false;
          if (agentId && matchCallId) {
            for (const msg of messages) {
              const hasMatchingTool = msg.content.some(
                (part) => (part.type === 'tool_use' || part.type === 'tool_result') && part.tool_call_id === matchCallId,
              );
              if (!hasMatchingTool) continue;
              matchedExisting = true;
              msg.metadata = { ...(msg.metadata ?? {}), agent_id: agentId, agentId };
              for (const part of msg.content) {
                if (part.type === 'tool_result') {
                  const cur = typeof part.output === 'string' ? part.output : '';
                  if (!cur.includes('agent_id:')) {
                    part.output = cur ? `agent_id: ${agentId}\n${cur}` : `agent_id: ${agentId}`;
                  }
                }
              }
            }
          }
          if (!matchedExisting && agentId) {
            const callId = explicitParentId ?? (typeof it.id === 'string' && it.id ? it.id : `subagent_${agentId}`);
            const summary = typeof it.summary === 'string' ? it.summary : '';
            const label = (typeof it.name === 'string' && it.name) || 'Subagent';
            messages.push({
              id: `${callId}_call`,
              session_id: sessionId,
              role: 'assistant',
              content: [kimiHistoryPart({
                type: 'tool_use',
                tool_call_id: callId,
                tool_name: 'Agent',
                input: { description: summary || label },
                ...(explicitParentId ? { parent_tool_use_id: explicitParentId } : {}),
              })],
              created_at: createdAt,
              metadata: {
                agent_id: agentId,
                agentId,
                ...(explicitParentId ? { parent_tool_use_id: explicitParentId, parentToolUseId: explicitParentId } : {}),
                ...(summary ? { description: summary } : {}),
                ...(typeof it.name === 'string' && it.name ? { subagentType: it.name } : {}),
              },
            });
            const outText = summary ? `agent_id: ${agentId}\n${summary}` : `agent_id: ${agentId}`;
            messages.push({
              id: `${callId}_result`,
              session_id: sessionId,
              role: 'assistant',
              content: [kimiHistoryPart({
                type: 'tool_result',
                tool_call_id: callId,
                output: outText,
                is_error: isCodexToolItemError(it),
                ...(explicitParentId ? { parent_tool_use_id: explicitParentId } : {}),
              })],
              created_at: createdAt,
              metadata: {
                agent_id: agentId,
                agentId,
                ...(explicitParentId ? { parent_tool_use_id: explicitParentId, parentToolUseId: explicitParentId } : {}),
              },
            });
          }
        } else if (isCodexToolItem(type)) {
          const callId = (it.call_id as string) ?? (it.id as string) ?? randomUUID();
          const name = (it.name as string) ?? (it.tool as string) ?? (type as string);
          const input = it.input ?? it.command ?? it.arguments ?? it.query ?? it.changes ?? {};
          const phase = typeof it.phase === 'string' ? it.phase : undefined;
          const parentToolUseId = typeof it.parentToolUseId === 'string' ? it.parentToolUseId : undefined;

          const receiverThreadIds = Array.isArray(it.receiverThreadIds)
            ? (it.receiverThreadIds as string[])
            : undefined;
          const agentId =
            (typeof it.agentId === 'string' && it.agentId) ||
            (typeof it.agentThreadId === 'string' && it.agentThreadId) ||
            (typeof it.receiverThreadId === 'string' && it.receiverThreadId) ||
            receiverThreadIds?.[0] ||
            undefined;
          const hasToolMeta = Boolean(phase || agentId || receiverThreadIds);

          messages.push({
            id: `${callId}_call`,
            session_id: sessionId,
            role: 'assistant',
            content: [kimiHistoryPart({
              type: 'tool_use',
              tool_call_id: callId,
              tool_name: name,
              input,
              ...(phase ? { phase } : {}),
              ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
            })],
            created_at: createdAt,
            ...(hasToolMeta ? {
              metadata: {
                ...(phase ? { phase } : {}),
                ...(agentId ? { agent_id: agentId, agentId } : {}),
                ...(receiverThreadIds ? { receiverThreadIds } : {}),
              },
            } : {}),
          });
          let outputText = extractCodexToolOutput(it);
          if (type === 'collabAgentToolCall' || type === 'subAgentActivity' || name === 'collabAgentToolCall') {
            if (agentId) {
              if (outputText === null || outputText === undefined || outputText === '') {
                outputText = `agent_id: ${agentId}`;
              } else if (!outputText.includes('agent_id:')) {
                outputText = `agent_id: ${agentId}\n${outputText}`;
              }
            }
          }
          const structuredOutput = extractCodexStructuredOutput(it);
          if (outputText !== null || structuredOutput !== undefined) {
            messages.push({
              id: `${callId}_result`,
              session_id: sessionId,
              role: 'assistant',
              content: [kimiHistoryPart({
                type: 'tool_result',
                tool_call_id: callId,
                output: outputText ?? '',
                is_error: isCodexToolItemError(it),
                ...(structuredOutput !== undefined ? { structuredOutput } : {}),
                ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
              })],
              created_at: createdAt,
              ...(hasToolMeta ? {
                metadata: {
                  ...(phase ? { phase } : {}),
                  ...(agentId ? { agent_id: agentId, agentId } : {}),
                  ...(receiverThreadIds ? { receiverThreadIds } : {}),
                },
              } : {}),
            });
          }
        }
      }
      if (typeof turnId === 'string' && turnId) turnRanges.set(turnId, { start: turnStart, end: messages.length });
    }

    return mergeRolloutToolsIntoHistory(messages, rolloutOrder, missingTools, turnRanges);
  }

  async startTurn(input: StartTurnInput): Promise<TurnHandle> {
    let prompt = textOfInput(input.input);
    const cwd = this.threadCwd.get(input.sessionId);
    // "/skill 参数" 命中 skills/list 目录时展开成 SKILL.md 正文再发(同
    // codex TUI 语义);网关代执行命令(compact/fork/...)在 gateway 层
    // 已被拦截,到这里仍未命中的原样发送。
    if (prompt.trimStart().startsWith('/')) {
      const expanded = expandCodexSkill(prompt, await this.codexSkills(cwd));
      if (expanded != null) prompt = expanded;
    }
    if (this.getPlanMode(input.sessionId) === true && !this.syncedPlanThreads.has(input.sessionId)) {
      const model = this.getModel(input.sessionId);
      const reasoningEffort = this.resolveEffectiveEffort(input.sessionId);
      try {
        await this.inner.setCollaborationMode(input.sessionId, 'plan', {
          ...(model ? { model } : {}),
          reasoningEffort,
        });
        this.syncedPlanThreads.add(input.sessionId);
      } catch {
        // Retry syncing plan mode on the next turn when RPC fails.
      }
    }
    // 'off' / 'auto' = 用户显式关掉 thinking 控制或自适应;codex 没有"关闭推理"的概念,
    // 诚实做法是回落到服务端默认 effort(不传)。'on' 从已缓存的模型中解析 default_effort。
    const thinking = this.getThinking(input.sessionId);
    let effort: string | undefined;
    if (!thinking || thinking === 'off' || thinking === 'auto') {
      effort = undefined;
    } else if (thinking === 'on') {
      if (!this.cachedModels) {
        await this.listModels().catch(() => []);
      }
      const selectedModel = this.getModel(input.sessionId);
      const m = this.cachedModels?.find((row) => row.model === selectedModel || (row.isDefault && !selectedModel));
      effort = m?.default_effort;
    } else {
      effort = thinking;
    }
    const attachments = input.attachments ?? [];
    const turnInput: string | Array<Record<string, unknown>> =
      attachments.length > 0 ? codexInputItems(prompt, attachments) : prompt;
    const serviceTier =
      typeof this.inner.getThreadServiceTier === 'function'
        ? this.inner.getThreadServiceTier(input.sessionId)
        : undefined;
    const handle = await this.inner.startTurn(input.sessionId, turnInput, {
      ...(cwd ? { cwd } : {}),
      model: this.settings.getString('model', input.sessionId),
      effort,
      ...(serviceTier !== undefined ? { serviceTier } : {}),
      approvalPolicy: codexApprovalPolicy(this.settings.getString('permission', input.sessionId)),
    });
    const nativeId = this.inner.nativeThreadId(input.sessionId);
    if (nativeId) this.settings.set('nativeThreadId', input.sessionId, nativeId);
    this.activeThreadTurns.add(input.sessionId);
    this.invalidateListCache(); // turn 会改动 preview/updatedAt,列表缓存失效
    const events = this.mapCodexEvents(input.sessionId, handle.turnId, handle.events);
    return { turnId: handle.turnId, events };
  }

  // -- 原生目录与模型选择 ----------------------------------------------------

  /** model/list 的 isDefault 行,作为未显式选择时 DTO 的展示回退。 */
  private defaultModel: string | undefined;

  async setModel(sessionId: string, model: string): Promise<void> {
    const nativeId = await this.inner.setModel(sessionId, model);
    if (nativeId) this.settings.set('nativeThreadId', sessionId, nativeId);
    this.settings.set('model', sessionId, model);
  }

  getModel(sessionId: string): string | undefined {
    return this.settings.getString('model', sessionId)
      ?? this.settings.getString('model', '__default__')
      ?? this.providers?.defaultModelRef()
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
    return this.settings.getString('thinking', sessionId)
      ?? this.settings.getString('thinking', '__default__');
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

  private resolveEffectiveEffort(sessionId: string): string | null {
    const thinking = this.getThinking(sessionId);
    if (!thinking || thinking === 'off' || thinking === 'auto') return null;
    if (thinking === 'on') {
      const selectedModel = this.getModel(sessionId);
      const m = this.cachedModels?.find((row) => row.model === selectedModel || (row.isDefault && !selectedModel));
      return m?.default_effort ?? null;
    }
    return thinking;
  }

  // -- plan 模式(collaborationMode,0.147.0 实测需 experimentalApi) --------------

  async setPlanMode(sessionId: string, on: boolean): Promise<void> {
    const model = this.getModel(sessionId);
    const reasoningEffort = this.resolveEffectiveEffort(sessionId);
    // 先落 RPC(失败不记持久态,UI 不会显示假开关)。
    await this.inner.setCollaborationMode(sessionId, on ? 'plan' : 'default', {
      ...(model ? { model } : {}),
      reasoningEffort,
    });
    if (on) {
      this.settings.set('plan', sessionId, true);
      this.syncedPlanThreads.add(sessionId);
    } else {
      this.settings.delete('plan', sessionId);
      this.syncedPlanThreads.delete(sessionId);
    }
  }

  getPlanMode(sessionId: string): boolean | undefined {
    return this.settings.getBoolean('plan', sessionId);
  }

  // -- 会话操作(RPC 直通,全部 0.147.0 实测存在) --------------------------------

  async steer(
    sessionId: string,
    turnId: string,
    input: string | MessageContentPart[] | SteerInput,
    attachments?: TurnAttachment[],
  ): Promise<void> {
    const rawInput =
      input && typeof input === 'object' && !Array.isArray(input) && 'input' in input
        ? input.input
        : input;
    const extraAttachments =
      input && typeof input === 'object' && !Array.isArray(input) && 'attachments' in input
        ? input.attachments ?? []
        : [];
    const mergedAttachments = [...extraAttachments, ...(attachments ?? [])];
    const text = textOfInput(rawInput);
    const payload = mergedAttachments.length > 0 ? codexInputItems(text, mergedAttachments) : text;
    await this.inner.steerTurn(sessionId, turnId, payload);
  }

  async compact(sessionId: string): Promise<void> {
    await this.inner.compact(sessionId);
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    await this.inner.setArchived(sessionId, archived);
    this.rolloutParsedCache.delete(sessionId);
    if (archived) {
      this.historyCache.delete(sessionId);
      this.liveSubagents.delete(sessionId);
      this.renames.delete(sessionId);
      this.threadCwd.delete(sessionId);
      this.syncedPlanThreads.delete(sessionId);
      this.sessionUsage.delete(sessionId);
    }
    this.invalidateListCache();
  }

  async delete(sessionId: string): Promise<void> {
    await this.inner.deleteThread(sessionId);
    this.historyCache.delete(sessionId);
    this.rolloutParsedCache.delete(sessionId);
    this.liveSubagents.delete(sessionId);
    this.renames.delete(sessionId);
    this.threadCwd.delete(sessionId);
    this.syncedPlanThreads.delete(sessionId);
    this.settings.delete('model', sessionId);
    this.settings.delete('nativeThreadId', sessionId);
    this.settings.delete('thinking', sessionId);
    this.settings.delete('permission', sessionId);
    this.settings.delete('plan', sessionId);
    this.sessionUsage.delete(sessionId);
    this.invalidateListCache();
  }

  async fork(sessionId: string): Promise<Session> {
    const thread = await this.inner.forkThread(sessionId);
    const forkedId = typeof thread.id === 'string' ? thread.id : '';
    this.settings.copySession(sessionId, forkedId);
    this.settings.delete('nativeThreadId', forkedId);
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
  async review(
    sessionId: string,
    options?: Parameters<NonNullable<ProviderAdapter['review']>>[1],
  ): Promise<TurnHandle> {
    const handle = await this.inner.reviewTurn(sessionId, options as ReviewStartOptions | undefined);
    this.invalidateListCache();
    return { turnId: handle.turnId, events: this.mapCodexEvents(sessionId, handle.turnId, handle.events) };
  }

  // -- goal(codex 原生 thread/goal/*) -------------------------------------------

  async setGoal(sessionId: string, objective: string): Promise<Record<string, unknown> | null> {
    return this.inner.goalSet(sessionId, objective, undefined, { origin: 'user' });
  }

  async getGoal(sessionId: string): Promise<Record<string, unknown> | null> {
    return this.inner.goalGet(sessionId);
  }

  async controlGoal(sessionId: string, control: 'pause' | 'resume' | 'cancel'): Promise<Record<string, unknown> | null> {
    if (control === 'cancel') {
      await this.inner.goalClear(sessionId);
      return null;
    }
    // objective 传 null = 不改动(thread/goal/set 字段可空),只切状态。
    return this.inner.goalSet(sessionId, null, control === 'pause' ? 'paused' : 'active', { origin: 'user' });
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

  async cleanTerminals(sessionId: string): Promise<void> {
    await this.inner.cleanBackgroundTerminals(sessionId);
  }

  async gitDiff(sessionId: string): Promise<{ sha?: string; diff: string } | null> {
    const cwd = this.threadCwd.get(sessionId);
    if (!cwd) return null;
    return this.inner.gitDiffToRemote(cwd);
  }

  async getRateLimits(): Promise<Record<string, unknown> | null> {
    return this.inner.accountRateLimits();
  }

  /** Codex 自己的官方登录接口(网关不读写 ~/.codex 凭据)。 */
  async startLogin(mode?: 'deviceCode' | 'browser' | { apiKey: string }): Promise<Record<string, unknown>> {
    return this.inner.startLogin(mode);
  }

  async cancelLogin(loginId: string): Promise<void> {
    return this.inner.cancelLogin(loginId);
  }

  async readAccount(): Promise<{ account: Record<string, unknown> | null; requiresOpenaiAuth: boolean } | null> {
    return this.inner.readAccount();
  }

  async logoutAccount(): Promise<void> {
    return this.inner.logoutAccount();
  }

  async getAccountUsage(sessionId?: string): Promise<Record<string, unknown> | null> {
    return this.inner.accountUsage(sessionId);
  }

  /** 原生模型目录:codex app-server 的 model/list(0.147.0–0.169.0)。 */
  async listModels(): Promise<NativeModel[]> {
    const rows = await this.inner.listModels();
    const contexts = rows.length ? await this.inner.modelContextWindows() : new Map<string, number>();
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
      const maxContextSize = r.maxContextSize ?? r.contextWindow ?? contexts.get(model);
      const maxOutputTokens = typeof r.maxOutputTokens === 'number' && Number.isFinite(r.maxOutputTokens)
        ? r.maxOutputTokens
        : undefined;
      out.push({
        provider: 'codex',
        model,
        display_name: typeof r.displayName === 'string' ? r.displayName : model,
        ...(typeof r.description === 'string' && r.description ? { description: r.description } : {}),
        ...(typeof maxContextSize === 'number' && maxContextSize > 0 ? { max_context_size: maxContextSize } : {}),
        ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
        capabilities: caps.length ? caps : undefined,
        support_efforts: efforts?.length ? efforts : undefined,
        default_effort:
          typeof r.defaultReasoningEffort === 'string' ? r.defaultReasoningEffort : undefined,
        ...(Array.isArray(r.serviceTiers) ? { serviceTiers: r.serviceTiers as NativeModel['serviceTiers'] } : {}),
        ...(r.defaultServiceTier !== undefined
          ? { defaultServiceTier: r.defaultServiceTier as string | null }
          : {}),
        ...(r.isDefault === true ? { isDefault: true } : {}),
        raw: r,
      } as NativeModel);
    }
    for (const provider of this.providers?.catalog() ?? []) {
      for (const m of provider.models) {
        const efforts = m.support_efforts?.filter((v) => v.length > 0);
        out.push({ provider: provider.label, model: encodeModelRef(provider.key, m.model),
          display_name: m.display_name ?? m.model,
          ...(m.max_context_size ? { max_context_size: m.max_context_size } : {}),
          ...(m.max_output_size ? { max_output_tokens: m.max_output_size } : {}),
          capabilities: m.capabilities,
          ...(efforts?.length ? { support_efforts: efforts } : {}),
          ...(m.default_effort && efforts?.includes(m.default_effort) ? { default_effort: m.default_effort } : {}),
          ...(this.providers?.defaultModelRef() === encodeModelRef(provider.key, m.model) ? { isDefault: true } : {}),
        } as NativeModel);
      }
    }
    this.cachedModels = out;
    return out;
  }

  /** Gateway provider changed: forget the catalog/default and restart app-server once idle. */
  providerChanged(): void {
    this.cachedModels = null;
    this.defaultModel = undefined;
    this.inner.recycleSoon();
  }

  /**
   * skills/list 目录(按 cwd + skillsVersion 缓存,5 分钟 TTL):
   * listCommands 展示 + startTurn 里的 skill 展开都要用。失败返回空数组,不阻断主流程。
   */
  private skillsCache = new Map<
    string,
    { ts: number; version: number; skills: Array<{ name: string; description: string; path: string }> }
  >();

  private async codexSkills(cwd?: string): Promise<Array<{ name: string; description: string; path: string }>> {
    const key = cwd ?? '';
    const version = typeof this.inner.getSkillsVersion === 'function' ? this.inner.getSkillsVersion() : 0;
    const hit = this.skillsCache.get(key);
    if (hit && hit.version === version && Date.now() - hit.ts < 5 * 60_000) {
      return hit.skills;
    }
    if (hit && hit.version !== version) {
      this.skillsCache.clear();
    }
    // 失败(如 app-server 还没起)只当场回空,不入缓存——否则一次瞬断会把
    // 空目录扩散 5 分钟,期间 /命令面板和 skill 展开全空(审查发现)。
    const rows = await this.inner.listSkills(cwd ? { cwd } : undefined).catch(() => null);
    if (rows === null) return [];
    const skills = rows
      .filter((s) => s && typeof s.name === 'string' && typeof s.path === 'string' && s.enabled !== false)
      .map((s) => ({ name: s.name as string, description: (s.description as string) ?? '', path: s.path as string }));
    const postVersion = typeof this.inner.getSkillsVersion === 'function' ? this.inner.getSkillsVersion() : version;
    if (postVersion === version) {
      this.skillsCache.set(key, { ts: Date.now(), version, skills });
    }
    return skills;
  }

  /** 原生 skills 目录(透传 codex skills/list,按 session cwd 作用域)。 */
  async listSkills(
    sessionId?: string,
    cwdOverride?: string,
  ): Promise<Array<{ name: string; description: string; path: string; scope: string; enabled: boolean }>> {
    const cwd = cwdOverride ?? (sessionId ? this.threadCwd.get(sessionId) : undefined);
    return this.inner.listSkills(cwd ? { cwd } : undefined);
  }

  /** 完整目录:client 命令 + 网关代执行命令 + skills。 */
  async listCommands(sessionId?: string, cwdOverride?: string): Promise<NativeCommand[]> {
    const cwd = cwdOverride ?? (sessionId ? this.threadCwd.get(sessionId) : undefined);
    return listCodexCommands(await this.codexSkills(cwd));
  }

  async interrupt(sessionId: string, turnId?: string): Promise<void> {
    if (!turnId) return;
    await this.inner.interrupt(sessionId, turnId);
  }

  async resolveApproval(
    _sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    details?: GranularApprovalDetails,
  ): Promise<void> {
    const map: Record<ApprovalDecision, 'accept' | 'acceptForSession' | 'decline'> = {
      approve: 'accept',
      approve_always: 'acceptForSession',
      reject: 'decline',
    };
    const wireDecision = details?.decision === 'cancel' ? 'cancel' : map[decision];
    try {
      if (details) {
        this.inner.resolveApproval(approvalId, wireDecision, details);
      } else {
        this.inner.resolveApproval(approvalId, wireDecision);
      }
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

  async close(sessionId: string): Promise<void> {
    this.syncedPlanThreads.delete(sessionId);
  }

  /** 进程级清理:杀 codex app-server。网关 shutdown 时调用(此前无调用方,
   *  预热拉起的常驻进程在网关退出后成孤儿)。 */
  async dispose(): Promise<void> {
    this.historyCache.clear();
    this.rolloutParsedCache.clear();
    this.liveSubagents.clear();
    this.renames.clear();
    this.threadCwd.clear();
    this.sessionUsage.clear();
    this.skillsCache.clear();
    this.syncedPlanThreads.clear();
    this.activeThreadTurns.clear();
    this.invalidateListCache();
    this.settings.close();
    await this.inner.close();
  }

  private toSession(thread: Record<string, unknown>, cwdOverride?: string, listedArchived = false): Session {
    const cwd = cwdOverride ?? (thread.cwd as string) ?? process.cwd();
    const id = thread.id as string;
    // 列表扫到的历史会话也回填 cwd,充实 getCwd 兜底。
    if (thread.cwd || cwdOverride) this.threadCwd.set(id, cwd);
    const title =
      this.renames.get(id) ??
      (thread.name as string) ?? (thread.preview as string)?.slice(0, 60) ?? `Codex ${id.slice(0, 8)}`;
    const preview = typeof thread.preview === 'string' ? thread.preview : '';
    return {
      id,
      workspace_id: workspaceIdFromCwd(cwd, 'codex'),
      title,
      created_at: isoFromCodexTime(thread.createdAt),
      updated_at: isoFromCodexTime(thread.updatedAt),
      busy: false,
      // thread/list archived=true 的条目本身就是已归档,但响应经常不带 archived 字段。
      archived: listedArchived || thread.archived === true,
      // 0.37 Done 页过滤空 last_prompt;preview 撑起可见项。
      extras: { last_prompt: preview || (this.renames.get(id) ?? (typeof thread.name === 'string' ? thread.name : '')) },
      metadata: { cwd },
      provider: 'codex',
    };
  }

  private async *mapCodexEvents(
    sessionId: string,
    turnId: string,
    source: AsyncIterable<CodexEvent>,
  ): AsyncIterable<GatewayEvent> {
    try {
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
              payload: { text: '', delta: ev.delta, raw: ev },
            };
            break;
          case 'command-output-delta':
            yield {
              kind: 'tool',
              status: 'delta',
              sessionId,
              turnId,
              timestamp: ts,
              payload: { toolCallId: ev.itemId, name: ev.toolName ?? 'commandExecution', output: ev.delta },
            };
            break;
          case 'item-started': {
            const item = ev.item as Record<string, unknown>;
            const phase = typeof item.phase === 'string' ? item.phase : undefined;
            const receiverThreadIds = Array.isArray(item.receiverThreadIds)
              ? (item.receiverThreadIds as string[])
              : undefined;
            const agentId =
              (typeof item.agentId === 'string' && item.agentId) ||
              (typeof item.agentThreadId === 'string' && item.agentThreadId) ||
              (typeof item.agentPath === 'string' && item.agentPath) ||
              (typeof item.receiverThreadId === 'string' && item.receiverThreadId) ||
              receiverThreadIds?.[0] ||
              (item.type === 'subAgentActivity' ? (typeof item.id === 'string' && item.id ? item.id : undefined) : undefined);
            const parentToolUseId =
              (typeof item.parentToolUseId === 'string' && item.parentToolUseId) ||
              (item.type === 'subAgentActivity' && typeof item.call_id === 'string' && item.call_id
                ? item.call_id
                : undefined);
            if (item.type === 'subAgentActivity') {
              const effectiveAgentId = agentId ?? (typeof item.id === 'string' ? item.id : 'agent');
              const resolvedParentToolUseId =
                parentToolUseId ?? this.liveSubagents.get(sessionId)?.get(effectiveAgentId)?.parentToolUseId;
              this.recordLiveSubagent(
                sessionId,
                effectiveAgentId,
                resolvedParentToolUseId,
                typeof item.summary === 'string' ? item.summary : undefined,
                typeof item.name === 'string' ? item.name : undefined,
                'running',
              );
              yield {
                kind: 'subagent',
                status: 'started',
                sessionId,
                turnId,
                timestamp: ts,
                agentId: effectiveAgentId,
                ...(resolvedParentToolUseId ? { parentToolUseId: resolvedParentToolUseId } : {}),
                payload: {
                  agentId: effectiveAgentId,
                  agent_id: effectiveAgentId,
                  ...(typeof item.agentThreadId === 'string' ? { agentThreadId: item.agentThreadId } : {}),
                  ...(typeof item.agentPath === 'string' ? { agentPath: item.agentPath } : {}),
                  ...(receiverThreadIds ? { receiverThreadIds } : {}),
                  ...(resolvedParentToolUseId ? { parentToolUseId: resolvedParentToolUseId } : {}),
                  name: typeof item.name === 'string' ? item.name : undefined,
                  status: typeof item.status === 'string' ? item.status : 'started',
                  summary: typeof item.summary === 'string' ? item.summary : undefined,
                  raw: item,
                },
              };
            } else if (isCodexToolItem(item.type)) {
              const name =
                (typeof item.name === 'string' && item.name) ||
                (typeof item.tool === 'string' && item.tool) ||
                (item.type as string);
              if (agentId) {
                this.recordLiveSubagent(sessionId, agentId, (item.id as string) ?? parentToolUseId, undefined, undefined, 'running');
              }
              yield {
                kind: 'tool',
                status: 'started',
                sessionId,
                turnId,
                timestamp: ts,
                ...(phase ? { phase } : {}),
                ...(parentToolUseId ? { parentToolUseId } : {}),
                ...(agentId ? { agentId } : {}),
                payload: {
                  toolCallId: (item.id as string) ?? '',
                  name,
                  input: item.input ?? item.command ?? item.arguments ?? item.query ?? item.changes ?? item,
                  ...(phase ? { phase } : {}),
                  ...(parentToolUseId ? { parentToolUseId } : {}),
                  ...(agentId ? { agentId, agent_id: agentId } : {}),
                  ...(receiverThreadIds ? { receiverThreadIds } : {}),
                  raw: item,
                },
              };
            } else if (item.type === 'plan' && typeof item.text === 'string' && item.text) {
              yield {
                kind: 'plan',
                status: 'started',
                sessionId,
                turnId,
                timestamp: ts,
                payload: {
                  planId: typeof item.id === 'string' ? item.id : undefined,
                  text: item.text,
                  raw: item,
                },
              };
            }
            break;
          }
          case 'item-completed': {
            const item = ev.item as Record<string, unknown>;
            const phase = typeof item.phase === 'string' ? item.phase : undefined;
            const receiverThreadIds = Array.isArray(item.receiverThreadIds)
              ? (item.receiverThreadIds as string[])
              : undefined;
            const agentId =
              (typeof item.agentId === 'string' && item.agentId) ||
              (typeof item.agentThreadId === 'string' && item.agentThreadId) ||
              (typeof item.agentPath === 'string' && item.agentPath) ||
              (typeof item.receiverThreadId === 'string' && item.receiverThreadId) ||
              receiverThreadIds?.[0] ||
              (item.type === 'subAgentActivity' ? (typeof item.id === 'string' && item.id ? item.id : undefined) : undefined);
            const parentToolUseId =
              (typeof item.parentToolUseId === 'string' && item.parentToolUseId) ||
              (item.type === 'subAgentActivity' && typeof item.call_id === 'string' && item.call_id
                ? item.call_id
                : undefined);
            if (item.type === 'subAgentActivity') {
              const effectiveAgentId = agentId ?? (typeof item.id === 'string' ? item.id : 'agent');
              const resolvedParentToolUseId =
                parentToolUseId ?? this.liveSubagents.get(sessionId)?.get(effectiveAgentId)?.parentToolUseId;
              this.recordLiveSubagent(
                sessionId,
                effectiveAgentId,
                resolvedParentToolUseId,
                typeof item.summary === 'string' ? item.summary : undefined,
                typeof item.name === 'string' ? item.name : undefined,
                subagentStatus(item.agentStatus ?? item.kind ?? item.status),
              );
              const st = subagentStatus(item.agentStatus ?? item.kind ?? item.status);
              yield {
                kind: 'subagent',
                status: st === 'running' ? 'started' : st === 'unknown' ? 'updated' : st,
                sessionId,
                turnId,
                timestamp: ts,
                agentId: effectiveAgentId,
                ...(resolvedParentToolUseId ? { parentToolUseId: resolvedParentToolUseId } : {}),
                payload: {
                  agentId: effectiveAgentId,
                  agent_id: effectiveAgentId,
                  ...(typeof item.agentThreadId === 'string' ? { agentThreadId: item.agentThreadId } : {}),
                  ...(typeof item.agentPath === 'string' ? { agentPath: item.agentPath } : {}),
                  ...(receiverThreadIds ? { receiverThreadIds } : {}),
                  ...(resolvedParentToolUseId ? { parentToolUseId: resolvedParentToolUseId } : {}),
                  name: typeof item.name === 'string' ? item.name : undefined,
                  status: st,
                  summary: typeof item.summary === 'string' ? item.summary : undefined,
                  raw: item,
                },
              };
            } else if (isCodexToolItem(item.type)) {
              const name =
                (typeof item.name === 'string' && item.name) ||
                (typeof item.tool === 'string' && item.tool) ||
                (item.type as string);
              let output = extractCodexToolOutput(item) ?? '';
              // 只信任原生标注的子代理调用;普通工具输出里的 "agent_id:" 只是文本,
              // 会把无关线程当成子代理并放行其历史读取。
              const subagentSpawnTool = name === 'spawnAgent' || name === 'collabAgentToolCall'
                || name === 'sendInput' || name === 'resumeAgent' || name === 'closeAgent';
              const resolvedAgentId = subagentSpawnTool
                ? (agentId ?? (receiverThreadIds ?? [])[0])
                : agentId;
              if (resolvedAgentId) {
                this.recordLiveSubagent(sessionId, resolvedAgentId, (item.id as string) ?? parentToolUseId);
              }
              const agentStates = item.agentsStates;
              if (agentStates && typeof agentStates === 'object' && !Array.isArray(agentStates)) {
                for (const [childId, rawState] of Object.entries(agentStates).slice(0, 200)) {
                  if (!/^[a-zA-Z0-9_-]+$/.test(childId) || childId === sessionId) continue;
                  const state = rawState && typeof rawState === 'object' ? rawState as Record<string, unknown> : {};
                  const childStatus = subagentStatus(state.status);
                  const previous = this.liveSubagents.get(sessionId)?.get(childId);
                  const status = childStatus === 'unknown' ? previous?.status ?? 'unknown' : childStatus;
                  this.recordLiveSubagent(sessionId, childId, previous?.parentToolUseId ?? (item.id as string), undefined, undefined, status);
                  yield {
                    kind: 'subagent', status: status === 'running' ? 'started' : status === 'unknown' ? 'updated' : status,
                    sessionId, turnId, timestamp: ts, agentId: childId,
                    payload: { agentId: childId, status, summary: typeof state.message === 'string' ? state.message : undefined },
                  };
                }
              }
              if (item.type === 'collabAgentToolCall' || name === 'collabAgentToolCall') {
                if (resolvedAgentId && !output.includes('agent_id:')) {
                  output = output ? `agent_id: ${resolvedAgentId}\n${output}` : `agent_id: ${resolvedAgentId}`;
                }
              }
              const structuredOutput = extractCodexStructuredOutput(item);
              yield {
                kind: 'tool',
                status: 'completed',
                sessionId,
                turnId,
                timestamp: ts,
                ...(phase ? { phase } : {}),
                ...(parentToolUseId ? { parentToolUseId } : {}),
                ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
                payload: {
                  toolCallId: (item.id as string) ?? '',
                  name,
                  output,
                  ...(structuredOutput !== undefined ? { structuredOutput } : {}),
                  is_error: isCodexToolItemError(item),
                  ...(phase ? { phase } : {}),
                  ...(parentToolUseId ? { parentToolUseId } : {}),
                  ...(resolvedAgentId ? { agentId: resolvedAgentId, agent_id: resolvedAgentId } : {}),
                  ...(receiverThreadIds ? { receiverThreadIds } : {}),
                  raw: item,
                },
              };
            } else if (item.type === 'plan') {
            yield {
              kind: 'plan',
              status: 'completed',
              sessionId,
              turnId,
              timestamp: ts,
              payload: {
                planId: typeof item.id === 'string' ? item.id : undefined,
                text: typeof item.text === 'string' ? item.text : '',
                raw: item,
              },
            };
          } else if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
            const message =
              (typeof item.text === 'string' && item.text) ||
              (typeof item.review === 'string' && item.review) ||
              String(item.type);
            yield {
              kind: 'notice',
              status: 'completed',
              sessionId,
              turnId,
              timestamp: ts,
              payload: { level: 'info', code: item.type, message, raw: item },
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
              approvalId: ev.approvalId ?? String(ev.requestId),
              kind: ev.kind,
              tool: ev.kind,
              input: ev.command ?? ev.params,
              itemId: ev.itemId,
              ...(Array.isArray(ev.availableDecisions)
                ? {
                    availableDecisions: ev.availableDecisions as Array<string | Record<string, unknown>>,
                    options: ev.availableDecisions.map((d) => (typeof d === 'string' ? d : JSON.stringify(d))),
                  }
                : {}),
              ...(ev.reason ? { reason: ev.reason } : {}),
              ...(ev.cwd ? { cwd: ev.cwd } : {}),
              ...(ev.commandActions ? { commandActions: ev.commandActions } : {}),
              ...(ev.networkApprovalContext !== undefined ? { networkContext: ev.networkApprovalContext } : {}),
              ...(ev.additionalPermissions !== undefined || ev.permissions !== undefined
                ? { additionalPermissions: ev.additionalPermissions ?? ev.permissions }
                : {}),
              ...(ev.proposedExecpolicyAmendment !== undefined
                ? { proposedExecpolicyAmendment: ev.proposedExecpolicyAmendment }
                : {}),
              ...(ev.proposedNetworkPolicyAmendments
                ? { proposedNetworkPolicyAmendments: ev.proposedNetworkPolicyAmendments }
                : {}),
              ...(ev.elicitation ? { elicitation: ev.elicitation } : {}),
              raw: ev.params,
            },
          };
          break;
        case 'question-request': {
          const normalized = normalizeCodexQuestions(ev.questions);
          yield {
            kind: 'question',
            status: 'started',
            sessionId,
            turnId,
            timestamp: ts,
            payload: {
              questionId: String(ev.requestId),
              prompt: normalized.prompt,
              ...(normalized.options.length > 0 ? { options: normalized.options } : {}),
              ...(typeof ev.isBlocking === 'boolean' ? { isBlocking: ev.isBlocking } : {}),
              ...(normalized.questions.length > 0 ? { questions: normalized.questions } : {}),
              rawQuestions: ev.questions,
              ...(ev.itemId ? { itemId: ev.itemId } : {}),
              raw: ev.params,
            },
          };
          break;
        }
        case 'server-request':
          yield {
            kind: 'passthrough',
            status: 'updated',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { method: ev.method, data: ev.params, source: 'codex' },
            raw: ev,
          };
          break;
        case 'server-request-resolved':
          yield {
            kind: 'interaction_resolved',
            status: 'completed',
            sessionId,
            turnId,
            timestamp: ts,
            payload: {
              interactionId: String(ev.requestId),
              ...(ev.interactionKind ? { interactionKind: ev.interactionKind } : {}),
              resolution: 'resolved',
              raw: ev,
            },
          };
          break;
        case 'plan-updated':
          yield {
            kind: 'plan',
            status: 'updated',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { explanation: ev.explanation, steps: ev.plan, raw: ev },
          };
          break;
        case 'plan-delta':
          yield {
            kind: 'plan',
            status: 'delta',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { planId: ev.itemId, delta: ev.delta, raw: ev },
          };
          break;
        case 'diff-updated':
          yield {
            kind: 'diff',
            status: 'updated',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { diff: ev.diff, raw: ev },
          };
          break;
        case 'patch-updated': {
          // item/fileChange/patchUpdated 是同一 item 的完整快照,只汇总"文件 + 行数增减",
          // 由下游按 itemId 去重,终态 diff 仍以 turn/diff/updated 为准。
          const files = ev.changes.map((c) => {
            const label = c.movePath ? `${c.path} → ${c.movePath}` : c.path;
            return `${label} (+${c.added}/-${c.removed})`;
          });
          yield {
            kind: 'diff',
            status: 'delta',
            sessionId,
            turnId: ev.turnId,
            timestamp: ts,
            payload: { itemId: ev.itemId, files },
          };
          break;
        }
        case 'token-usage': {
          const t = ev.usage.total;
          const last = ev.usage.last;
          const prev = this.sessionUsage.get(sessionId);
          const reasoning =
            num(ev.usage.reasoningOutputTokens) ||
            num(t.reasoningOutputTokens) ||
            num(last.reasoningOutputTokens);
          const nextUsage: SessionUsage = {
            input_tokens: num(t.inputTokens),
            output_tokens: num(t.outputTokens),
            cache_read_tokens: num(t.cachedInputTokens),
            cache_creation_tokens: num(t.cacheWriteInputTokens),
            total_cost_usd: 0,
            context_tokens: num(last.totalTokens),
            context_limit: ev.usage.modelContextWindow ?? 0,
            turn_count: prev?.turn_count ?? 0,
            ...(reasoning > 0 ? { reasoning_output_tokens: reasoning } : {}),
            authoritative: true,
          };
          this.sessionUsage.set(sessionId, nextUsage);
          yield {
            kind: 'usage',
            status: 'updated',
            sessionId,
            turnId,
            timestamp: ts,
            payload: { ...nextUsage },
          };
          break;
        }
        case 'goal-updated':
          yield {
            kind: 'passthrough',
            status: 'updated',
            sessionId,
            turnId,
            timestamp: ts,
            payload: {
              method: ev.cleared ? 'thread/goal/cleared' : 'thread/goal/updated',
              data: { goal: ev.goal, cleared: ev.cleared === true },
              source: 'codex',
            },
          };
          break;
        case 'turn-completed': {
          const status = (ev.turn as Record<string, unknown>).status as string;
          const reason = status === 'completed' ? 'completed' : status === 'interrupted' ? 'cancelled' : 'failed';
          const prevUsage = this.sessionUsage.get(sessionId);
          if (prevUsage) {
            this.sessionUsage.set(sessionId, {
              ...prevUsage,
              turn_count: prevUsage.turn_count + 1,
            });
          }
          const usage = this.sessionUsage.get(sessionId);
          yield {
            kind: 'turn',
            status: reason === 'completed' ? 'completed' : reason === 'cancelled' ? 'cancelled' : 'failed',
            sessionId,
            turnId,
            timestamp: ts,
            payload: {
              reason,
              ...(reason === 'failed' && ev.error ? { error: ev.error } : {}),
              ...(usage ? { usage } : {}),
            },
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
    } finally {
      this.activeThreadTurns.delete(sessionId);
    }
  }

  async listSubagents(sessionId: string): Promise<SubagentInfo[]> {
    this.pruneLiveSubagents(sessionId);
    const rollout = await this.resolveCodexRolloutPath(sessionId);
    const subagentsMap = new Map<string, SubagentInfo>();
    const put = (agentId: unknown, status: SubagentStatus, callId?: string, ts?: string) => {
      if (typeof agentId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(agentId) || agentId === sessionId) return;
      if (!subagentsMap.has(agentId) && subagentsMap.size >= 200) return;
      const previous = subagentsMap.get(agentId);
      const effective = status === 'unknown' ? previous?.status ?? 'unknown' : status;
      subagentsMap.set(agentId, {
        ...previous, agentId, status: effective, subagentType: 'collab',
        ...(callId ? { parentToolUseId: previous?.parentToolUseId ?? callId } : {}),
        ...(effective === 'running' ? { startedAt: ts ?? previous?.startedAt, endedAt: undefined }
          : effective !== 'unknown' ? { endedAt: ts ?? previous?.endedAt } : {}),
      });
    };
    if (rollout) {
      const text = readSubagentTail(path.dirname(rollout), rollout, 1024 * 1024);
      for (const line of text.split('\n')) {
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }
        const payload = entry?.payload ?? entry;
        const item = payload?.item ?? payload;
        if (!item || typeof item !== 'object') continue;
        const callId = typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : undefined;
        const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
        if (String(item.type).toLowerCase() === 'subagentactivity') {
          put(item.agent_thread_id ?? item.agentThreadId ?? item.agentId, subagentStatus(item.kind ?? item.agentStatus), callId, timestamp);
        } else if (item.type === 'spawnAgent' || item.type === 'collabAgentToolCall' || item.type === 'collabToolCall') {
          const children = (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [item.receiverThreadId]).slice(0, 200);
          for (const childId of children) put(childId, 'unknown', callId);
          if (item.agentsStates && typeof item.agentsStates === 'object') {
            for (const [childId, state] of Object.entries(item.agentsStates).slice(0, 200)) {
              put(childId, subagentStatus((state as any)?.status), callId, timestamp);
            }
          }
        }
      }
    }
    const nativeStates = new Map<string, SubagentStatus>();
    for (const child of await this.inner.listSubagentThreadStates(sessionId).catch(() => [])) {
      nativeStates.set(child.threadId, child.status);
      put(child.threadId, child.status);
    }
    for (const live of this.liveSubagents.get(sessionId)?.values() ?? []) {
      const disk = subagentsMap.get(live.agentId);
      const diskEnd = Date.parse(disk?.endedAt ?? '');
      if (live.status === 'running' && disk?.status !== 'running' && Number.isFinite(diskEnd)) continue;
      // 原生 app-server 报告的子线程状态优先于本进程内攒下的 live 状态:
      // live 的 running 只说明"没见过结束",systemError 是原生观测到的终态。
      const nativeChild = nativeStates.get(live.agentId);
      const status = nativeChild && nativeChild !== 'unknown' && nativeChild !== 'running'
        ? nativeChild
        : live.status === 'unknown' ? disk?.status ?? 'unknown' : live.status;
      subagentsMap.set(live.agentId, {
        ...disk, agentId: live.agentId, status,
        ...(live.parentToolUseId ? { parentToolUseId: live.parentToolUseId } : {}),
        ...(live.description ? { description: live.description } : {}),
        ...(live.subagentType ? { subagentType: live.subagentType } : {}),
        ...(live.completedAt ? { endedAt: new Date(live.completedAt).toISOString() } : {}),
      });
    }
    return [...subagentsMap.values()].slice(0, 200);
  }

  async getSubagentMessages(sessionId: string, agentId: string): Promise<Message[]> {
    if (!agentId || agentId === sessionId || !/^[a-zA-Z0-9._-]+$/.test(agentId)) {
      return [];
    }
    const allowed = await this.listSubagents(sessionId);
    if (!allowed.some((s) => s.agentId === agentId)) {
      return [];
    }
    const childHistory = await this.getHistory(agentId);
    return childHistory.map((m) => ({
      ...m,
      metadata: {
        ...(m.metadata ?? {}),
        agent_id: agentId,
        agentId,
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// Claude → ProviderAdapter
// ---------------------------------------------------------------------------

export class ClaudeProviderAdapter implements ProviderAdapter {
  readonly name = 'claude' as const;
  private readonly inner: ClaudeAdapter;
  private readonly providers?: CliProviders;
  /** 记录每个会话最近一次 turn 的 cwd,供 resume 时复用。 */
  private readonly sessionCwd = new Map<string, string>();
  /** `/clear` 在 stream-json 下会生成新 CLI sessionId，保存逻辑 id → 实际 CLI id 映射。 */
  private readonly resetSessionIds = new Map<string, string>();
  /** 从 `system:init` 观察到的 `terminal_slash_commands` 列表。 */
  private lastTerminalSlashCommands: string[] = [];
  /** 会话级设置持久化(重启不丢;只读路径回落 undefined = 未设置)。 */
  private readonly settings: SettingsStore;
  private readonly liveSubagents = new Map<
    string,
    Array<{ agentId: string; parentToolUseId?: string; description?: string; subagentType?: string; taskId?: string; status: SubagentStatus; startedAt?: number; completedAt?: number }>
  >();

  private pruneLiveSubagents(targetSessionId?: string): void {
    const now = Date.now();
    const MAX_ENTRIES_PER_SESSION = 64;
    const TERMINAL_TTL_MS = 5 * 60_000;
    const pruneList = (list: Array<{ agentId: string; parentToolUseId?: string; description?: string; subagentType?: string; taskId?: string; status: SubagentStatus; startedAt?: number; completedAt?: number }>) => {
      const filtered = list.filter((item) => !item.completedAt || now - item.completedAt < TERMINAL_TTL_MS);
      if (filtered.length > MAX_ENTRIES_PER_SESSION) {
        return filtered.slice(filtered.length - MAX_ENTRIES_PER_SESSION);
      }
      return filtered;
    };

    if (targetSessionId) {
      const list = this.liveSubagents.get(targetSessionId);
      if (list) {
        this.liveSubagents.set(targetSessionId, pruneList(list));
      }
    } else {
      for (const [sId, list] of this.liveSubagents.entries()) {
        const pruned = pruneList(list);
        if (pruned.length === 0) {
          this.liveSubagents.delete(sId);
        } else {
          this.liveSubagents.set(sId, pruned);
        }
      }
    }
  }

  private resolveEffectiveSessionId(sessionId: string): string {
    return this.resetSessionIds.get(sessionId) ?? this.settings.getString('resetSessionId', sessionId) ?? sessionId;
  }

  private commitResetSessionId(sessionId: string, newId: string | undefined, cwd?: string): void {
    if (!newId || newId === sessionId) return;
    this.resetSessionIds.set(sessionId, newId);
    this.settings.set('resetSessionId', sessionId, newId);
    if (cwd) this.sessionCwd.set(newId, cwd);
  }

  constructor(options?: ConstructorParameters<typeof ClaudeAdapter>[0] & { settingsPath?: string }) {
    const { settingsPath, ...innerOptions } = options ?? {};
    this.providers = innerOptions.providers;
    const claudeBin = innerOptions.claudeBin ?? process.env.CLAUDE_BIN;
    this.inner = new ClaudeAdapter({
      ...innerOptions,
      ...(claudeBin ? { claudeBin } : {}),
    });
    this.settings = new SettingsStore(settingsPath);
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      thinking: true,
      tools: true,
      approvals: true, // control_request can_use_tool → approval; handler writes control_response
      questions: true, // AskUserQuestion / questions, when the CLI shape is obvious
      interrupt: true,
      history: true,
      steer: true,
      steerAttachments: false,
      attachments: true,
      compact: true,
      fork: true,
      clone: false,
      rollback: false,
      rename: true,
      archive: true,
      nativeArchive: true,
      delete: true,
      planMode: true,
      permissionModes: ['manual', 'auto', 'yolo'],
      manualApproval: true,
      goals: false,
      swarm: false,
      tower: false,
      btw: false,
      subagents: true,
      mcp: true,
      terminals: false,
      review: false,
      models: true,
      thinkingLevels: true,
      commands: true,
      skills: false,
      usage: true,
    };
  }

  async list(query: ListSessionsQuery = {}): Promise<SessionPage> {
    // 兼顾原生 <sessionId>/archived.json 与既有 SettingsStore sidecar 迁移。
    const sessions = (await this.inner.list()).filter((session) => {
      if (query.cwd && session.cwd !== query.cwd) return false;
      const isArchived = session.archived === true || this.settings.getBoolean('archived', session.sessionId) === true;
      return query.archived === true ? isArchived : !isArchived;
    });
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
    const effectiveId = this.resolveEffectiveSessionId(sessionId);
    if (effectiveId !== sessionId && !this.inner.hasSessionFile(effectiveId)) {
      return [];
    }
    const history = await this.inner.getHistory(effectiveId, { followContinuedIn: true });
    const messages: Message[] = [];
    for (let index = 0; index < history.length; index++) {
      const m = history[index];
      const nextM = history[index + 1];

      // Merge adjacent <bash-input> + <bash-stdout>/<bash-stderr> user messages into a structured Bash tool_use + tool_result pair
      if (
        m.role === 'user' &&
        m.text.startsWith('! ') &&
        (!m.blocks || m.blocks.length === 0) &&
        nextM &&
        nextM.role === 'user' &&
        nextM.isLocalBashOutput === true &&
        (!nextM.blocks || nextM.blocks.length === 0) &&
        !nextM.text.startsWith('! ')
      ) {
        const cmd = m.text.slice(2).trim();
        const callId = `bash_${createHash('sha256')
          .update(JSON.stringify([sessionId, index, cmd]))
          .digest('hex')
          .slice(0, 16)}`;
        messages.push({
          id: `msg_${callId}_use`,
          session_id: sessionId,
          role: 'assistant',
          content: [kimiHistoryPart({
            type: 'tool_use',
            tool_call_id: callId,
            tool_name: 'Bash',
            input: { command: cmd },
            ...(m.parentToolUseId ? { parent_tool_use_id: m.parentToolUseId } : {}),
          })],
          created_at: m.timestamp ?? nowIso(),
          ...(m.parentToolUseId ? { metadata: { parent_tool_use_id: m.parentToolUseId } } : {}),
        });
        messages.push({
          id: `msg_${callId}_res`,
          session_id: sessionId,
          role: 'tool',
          content: [kimiHistoryPart({
            type: 'tool_result',
            tool_call_id: callId,
            output: nextM.text,
            is_error: false,
            ...(nextM.parentToolUseId ? { parent_tool_use_id: nextM.parentToolUseId } : {}),
          })],
          created_at: nextM.timestamp ?? nowIso(),
          ...(nextM.parentToolUseId ? { metadata: { parent_tool_use_id: nextM.parentToolUseId } } : {}),
        });
        index++; // consumed nextM
        continue;
      }

      // 优先用结构化块(thinking/tool_use/tool_result),没有才退化成纯文本。
      const content: Message['content'] = m.blocks && m.blocks.length > 0
        ? m.blocks.map((b) => {
            if (b.type === 'thinking') return kimiHistoryPart({ type: 'thinking', thinking: b.text });
            if (b.type === 'tool_use') {
              return kimiHistoryPart({
                type: 'tool_use',
                tool_call_id: b.id,
                tool_name: b.name,
                input: b.input,
                ...(m.parentToolUseId ? { parent_tool_use_id: m.parentToolUseId } : {}),
              });
            }
            if (b.type === 'tool_result') {
              return kimiHistoryPart({
                type: 'tool_result',
                tool_call_id: b.tool_use_id,
                output: b.content,
                is_error: b.is_error === true,
                ...(m.parentToolUseId ? { parent_tool_use_id: m.parentToolUseId } : {}),
              });
            }
            return { type: 'text' as const, text: b.text };
          })
        : [{ type: 'text' as const, text: m.text }];
      const hasMeta = Boolean(m.model || m.isError || m.agentId || m.parentToolUseId || m.isCompactSummary);
      messages.push({
        id: `msg_${createHash('sha256')
          .update(JSON.stringify([sessionId, index, m.role, m.timestamp ?? '', m.text]))
          .digest('hex')
          .slice(0, 24)}`,
        session_id: sessionId,
        // Claude JSONL 把 tool_result 记在 user 消息里;Kimi Web 只把 role=tool
        // 的 toolResult 折进上一张工具卡。纯工具结果不能当用户气泡发出。
        role: content.length > 0 && content.every((part) => part.type === 'tool_result') ? 'tool' : m.role,
        content,
        created_at: m.timestamp ?? nowIso(),
        ...(hasMeta ? {
          metadata: {
            ...(m.model ? { model: m.model } : {}),
            ...(m.isError ? { is_error: true } : {}),
            ...(m.agentId ? { agent_id: m.agentId } : {}),
            ...(m.parentToolUseId ? { parent_tool_use_id: m.parentToolUseId } : {}),
            ...(m.isCompactSummary ? { is_compact_summary: true } : {}),
          },
        } : {}),
      });
    }
    return messages;
  }

  async startTurn(input: StartTurnInput): Promise<TurnHandle> {
    const sessionId = input.sessionId;
    const effectiveId = this.resolveEffectiveSessionId(sessionId);
    // claude CLI 在 -p stream-json 模式下自己执行 "/name args"(2.1.226+
    // 实测 /compact /mcp 均产生真实输出),网关不展开、不拦截,原样直通。
    let prompt = textOfInput(input.input);
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
    const isNew = !this.inner.hasSessionFile(effectiveId);
    const cwd = this.sessionCwd.get(effectiveId) ?? this.sessionCwd.get(sessionId);
    const storedModel = this.getModel(sessionId);
    const model = storedModel === 'default' ? undefined : storedModel;
    // thinking 'off' / 'on' / 'auto' = 不传 --effort(CLI 无 off 档，'on'/'auto' 由 CLI 内部自适应)。
    const thinking = this.getThinking(sessionId);
    const effort = thinking && thinking !== 'off' && thinking !== 'on' && thinking !== 'auto' ? thinking : undefined;
    const permissionMode = this.settings.getBoolean('plan', sessionId)
      ? 'plan'
      : claudePermissionMode(this.settings.getString('permission', sessionId));
    // fast / color 无对应启动 flag,只能经 --settings 注入;否则活 turn 结束后下一轮丢失。
    const flagSettings: Record<string, unknown> = {};
    const fastMode = this.settings.getString('fastMode', sessionId)
      ?? this.settings.getString('fastMode', '__default__');
    if (fastMode === 'on' || fastMode === 'off') flagSettings.fastMode = fastMode === 'on';
    const color = this.settings.getString('color', sessionId)
      ?? this.settings.getString('color', '__default__');
    if (color) flagSettings.color = color;
    const turnSettings = Object.keys(flagSettings).length > 0 ? flagSettings : undefined;
    const turnId = randomUUID();
    const stream = new EventStream<GatewayEvent>();
    const subagentTasks = new Set<string>();
    let sawConversationReset = false;
    let pendingResetId: string | undefined;
    let sawAssistantOutput = false;

    const emit = (ev: ClaudeAdapterEvent): void => {
      const ts = Date.now();
      switch (ev.type) {
        case 'init':
          if (Array.isArray(ev.terminalSlashCommands) && ev.terminalSlashCommands.length > 0) {
            this.lastTerminalSlashCommands = ev.terminalSlashCommands;
          }
          if (sawConversationReset && ev.sessionId && ev.sessionId !== effectiveId) {
            pendingResetId = ev.sessionId;
          }
          break;
        case 'conversation_reset':
          sawConversationReset = true;
          if (ev.newConversationId && ev.newConversationId !== effectiveId) {
            pendingResetId = ev.newConversationId;
          }
          break;
        case 'text_delta':
          sawAssistantOutput = true;
          stream.push({
            kind: 'message',
            status: 'delta',
            sessionId,
            turnId,
            timestamp: ts,
            ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
            ...(ev.agentId ? { agentId: ev.agentId } : {}),
            payload: {
              delta: ev.text,
              message: emptyAssistantMessage(sessionId),
              ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
              ...(ev.agentId ? { agentId: ev.agentId } : {}),
            },
          });
          break;
        case 'thinking_delta':
          stream.push({
            kind: 'thinking',
            status: 'delta',
            sessionId,
            turnId,
            timestamp: ts,
            ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
            ...(ev.agentId ? { agentId: ev.agentId } : {}),
            payload: {
              text: '',
              delta: ev.text,
              ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
              ...(ev.agentId ? { agentId: ev.agentId } : {}),
            },
          });
          break;
        case 'synthetic_text':
          sawAssistantOutput = true;
          stream.push({
            kind: 'message',
            status: 'delta',
            sessionId,
            turnId,
            timestamp: ts,
            ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
            ...(ev.agentId ? { agentId: ev.agentId } : {}),
            payload: {
              delta: ev.text,
              message: emptyAssistantMessage(sessionId),
              ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
              ...(ev.agentId ? { agentId: ev.agentId } : {}),
            },
          });
          break;
        case 'tool_use':
          stream.push({
            kind: 'tool',
            status: 'started',
            sessionId,
            turnId,
            timestamp: ts,
            ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
            ...(ev.agentId ? { agentId: ev.agentId } : {}),
            payload: {
              toolCallId: ev.toolUseId,
              name: ev.name,
              input: ev.input,
              ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
              ...(ev.agentId ? { agentId: ev.agentId } : {}),
            },
          });
          break;
        case 'tool_result':
          stream.push({
            kind: 'tool',
            status: 'completed',
            sessionId,
            turnId,
            timestamp: ts,
            ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
            ...(ev.agentId ? { agentId: ev.agentId } : {}),
            payload: {
              toolCallId: ev.toolUseId,
              name: '',
              output: ev.content,
              ...(ev.toolUseResult !== undefined ? { structuredOutput: ev.toolUseResult } : {}),
              is_error: ev.isError,
              ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
              ...(ev.agentId ? { agentId: ev.agentId } : {}),
            },
          });
          break;
        case 'tool_progress':
          stream.push({
            kind: 'tool',
            status: 'delta',
            sessionId,
            turnId,
            timestamp: ts,
            ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
            payload: {
              toolCallId: ev.toolUseId,
              name: ev.toolName,
              output: `running (${ev.elapsedTimeSeconds}s)`,
              ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
              raw: ev,
            },
          });
          break;
        case 'task_started':
          stream.push({
            kind: 'task',
            status: 'started',
            sessionId,
            turnId,
            timestamp: ts,
            ...(ev.toolUseId ? { parentToolUseId: ev.toolUseId } : {}),
            payload: {
              taskId: ev.taskId,
              description: ev.description,
              ...(ev.toolUseId ? { toolUseId: ev.toolUseId } : {}),
              ...(ev.subagentType ? { subagentType: ev.subagentType } : {}),
              ...(ev.isBackgrounded !== undefined ? { isBackgrounded: ev.isBackgrounded } : {}),
              ...(ev.spawnDepth !== undefined ? { spawnDepth: ev.spawnDepth } : {}),
              ...(ev.parentTaskId ? { parentTaskId: ev.parentTaskId } : {}),
              ...(ev.taskType ? { taskType: ev.taskType } : {}),
              raw: ev,
            },
          });
          if (ev.subagentType || ev.taskType === 'subagent') {
            subagentTasks.add(ev.taskId);
            const liveList = this.liveSubagents.get(effectiveId) ?? [];
            const tracked = liveList.find((l) => l.agentId === ev.taskId || l.taskId === ev.taskId);
            if (tracked) {
              tracked.status = 'running';
              tracked.startedAt = ts;
              tracked.completedAt = undefined;
              tracked.parentToolUseId = ev.toolUseId ?? tracked.parentToolUseId;
            } else {
              liveList.push({
                agentId: ev.taskId, taskId: ev.taskId, parentToolUseId: ev.toolUseId,
                description: ev.description, subagentType: ev.subagentType, status: 'running', startedAt: ts,
              });
            }
            this.liveSubagents.set(effectiveId, liveList);
            this.liveSubagents.set(sessionId, liveList);
            stream.push({
              kind: 'subagent',
              status: 'started',
              sessionId,
              turnId,
              timestamp: ts,
              agentId: ev.taskId,
              ...(ev.toolUseId ? { parentToolUseId: ev.toolUseId } : {}),
              payload: {
                agentId: ev.taskId,
                ...(ev.toolUseId ? { parentToolUseId: ev.toolUseId } : {}),
                name: ev.subagentType,
                status: 'started',
                summary: ev.description,
                raw: ev,
              },
            });
          }
          break;
        case 'task_progress':
        case 'task_updated':
          stream.push({
            kind: 'task',
            status: 'updated',
            sessionId,
            turnId,
            timestamp: ts,
            payload: ev.type === 'task_progress'
              ? {
                  taskId: ev.taskId,
                  description: ev.description,
                  ...(ev.toolUseId ? { toolUseId: ev.toolUseId } : {}),
                  ...(ev.subagentType ? { subagentType: ev.subagentType } : {}),
                  ...(ev.usage ? { usage: ev.usage } : {}),
                  ...(ev.lastToolName ? { lastToolName: ev.lastToolName } : {}),
                  ...(ev.summary ? { summary: ev.summary } : {}),
                  raw: ev,
                }
              : { taskId: ev.taskId, patch: ev.patch, raw: ev },
          });
          break;
        case 'task_notification': {
          const st: SubagentStatus = ev.status === 'completed'
            ? 'completed'
            : ev.status === 'failed' || ev.status === 'error'
              ? 'failed'
              : ev.status === 'stopped' || ev.status === 'cancelled' || ev.status === 'killed'
                ? 'cancelled'
                : 'unknown';
          const liveList = this.liveSubagents.get(effectiveId) ?? this.liveSubagents.get(sessionId) ?? [];
          const tracked = liveList.find((l) => l.taskId === ev.taskId || l.agentId === ev.taskId);
          const resolvedToolUseId = ev.toolUseId ?? tracked?.parentToolUseId;
          const fallbackParentId = resolvedToolUseId ?? ev.taskId;
          const streamStatus = st === 'unknown' ? 'updated' : st;
          stream.push({
            kind: 'task',
            status: streamStatus,
            sessionId,
            turnId,
            timestamp: ts,
            ...(resolvedToolUseId ? { parentToolUseId: resolvedToolUseId } : {}),
            payload: {
              taskId: ev.taskId,
              status: ev.status,
              summary: ev.summary,
              ...(resolvedToolUseId ? { toolUseId: resolvedToolUseId } : {}),
              ...(ev.outputFile ? { outputFile: ev.outputFile } : {}),
              ...(ev.usage ? { usage: ev.usage } : {}),
              raw: ev,
            },
          });
          const wasSubagent = subagentTasks.delete(ev.taskId) || Boolean(tracked);
          if (wasSubagent) {
            stream.push({
              kind: 'subagent',
              status: streamStatus,
              sessionId,
              turnId,
              timestamp: ts,
              agentId: ev.taskId,
              ...(fallbackParentId ? { parentToolUseId: fallbackParentId } : {}),
              payload: {
                agentId: ev.taskId,
                ...(fallbackParentId ? { parentToolUseId: fallbackParentId } : {}),
                status: st,
                summary: ev.summary,
                raw: ev,
              },
            });
            if (tracked) {
              tracked.status = st;
              if (st !== 'unknown') tracked.completedAt = Date.now();
            }
            this.pruneLiveSubagents(effectiveId);
            if (effectiveId !== sessionId) {
              this.pruneLiveSubagents(sessionId);
            }
          }
          break;
        }
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
        case 'approval':
          // bypassPermissions 下 CLI 仍会对少数操作发 can_use_tool(危险 rm、ask 规则等,
          // 见 code.claude.com/docs/en/permission-modes)。用户选了"完全自动"就直接放行;
          // requiresUserInteraction 的工具按官方语义必须由人回答,照常弹卡。
          if (
            ev.requiresUserInteraction !== true &&
            !this.settings.getBoolean('plan', sessionId) &&
            this.getPermission(sessionId) === 'yolo'
          ) {
            void this.inner
              .resolveApproval(this.resolveEffectiveSessionId(sessionId), ev.approvalId, 'allow')
              .catch(() => undefined);
            break;
          }
          stream.push({
            kind: 'approval',
            status: 'started',
            sessionId,
            turnId,
            timestamp: ts,
            ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
            ...(ev.agentId ? { agentId: ev.agentId } : {}),
            payload: {
              approvalId: ev.approvalId,
              tool: ev.tool,
              input: ev.input,
              ...(ev.itemId ? { itemId: ev.itemId } : {}),
              ...(ev.suggestions ? { suggestions: ev.suggestions } : {}),
              ...(ev.blockedPath ? { blockedPath: ev.blockedPath } : {}),
              ...(ev.decisionReason ? { reason: ev.decisionReason } : {}),
              ...(ev.decisionReasonType ? { reasonType: ev.decisionReasonType } : {}),
              ...(ev.suppressAlwaysAllow !== undefined ? { suppressAlwaysAllow: ev.suppressAlwaysAllow } : {}),
              ...(ev.defaultToNo !== undefined ? { defaultToNo: ev.defaultToNo } : {}),
              ...(ev.requiresUserInteraction !== undefined
                ? { requiresUserInteraction: ev.requiresUserInteraction }
                : {}),
              ...(ev.title ? { title: ev.title } : {}),
              ...(ev.displayName ? { displayName: ev.displayName } : {}),
              ...(ev.description ? { description: ev.description } : {}),
              ...(ev.agentId ? { agentId: ev.agentId } : {}),
              ...(ev.mcpServer ? { mcpServer: ev.mcpServer } : {}),
              raw: ev,
            },
          });
          break;
        case 'question':
          stream.push({
            kind: 'question',
            status: 'started',
            sessionId,
            turnId,
            timestamp: ts,
            ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
            ...(ev.agentId ? { agentId: ev.agentId } : {}),
            payload: {
              questionId: ev.questionId,
              prompt: ev.prompt,
              ...(ev.rawQuestions ? { rawQuestions: ev.rawQuestions } : {}),
              ...(ev.itemId ? { itemId: ev.itemId } : {}),
              ...(ev.agentId ? { agentId: ev.agentId } : {}),
              raw: ev,
            },
          });
          break;
        case 'control_cancelled':
          stream.push({
            kind: 'interaction_resolved',
            status: 'cancelled',
            sessionId,
            turnId,
            timestamp: ts,
            payload: {
              interactionId: ev.requestId,
              interactionKind: ev.kind,
              resolution: 'cancelled',
              raw: ev,
            },
          });
          break;
        case 'done': {
          if (sawConversationReset) {
            const finalResetId =
              (ev.sessionId && ev.sessionId !== effectiveId ? ev.sessionId : undefined)
              ?? pendingResetId;
            this.commitResetSessionId(sessionId, finalResetId, cwd);
            if (!sawAssistantOutput) {
              stream.push({
                kind: 'message',
                status: 'delta',
                sessionId,
                turnId,
                timestamp: ts,
                payload: {
                  delta: '✓ 已清空 Claude 会话上下文（/clear）。',
                  message: emptyAssistantMessage(sessionId),
                },
              });
            }
          }
          const u = ev.usage;
          const modelUsage = normalizeClaudeModelUsage(ev.modelUsage);
          const hasAuthoritativeUsage = Boolean(u || modelUsage || ev.totalCostUsd !== undefined);
          let nextUsage: SessionUsage | undefined;
          if (hasAuthoritativeUsage) {
            const prev = this.sessionUsage.get(sessionId) ?? {
              input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
              cache_creation_tokens: 0, total_cost_usd: 0, context_tokens: 0,
              context_limit: 0, turn_count: 0,
            };
            const input = num(u?.input_tokens);
            const output = num(u?.output_tokens);
            const cacheRead = num(u?.cache_read_input_tokens);
            const cacheCreate = num(u?.cache_creation_input_tokens);
            const reasoning = num(u?.thinking_tokens ?? u?.reasoning_output_tokens);
            const turnCost = ev.totalCostUsd !== undefined ? num(ev.totalCostUsd) : num(u?.total_cost_usd);
            const model = this.getModel(sessionId) ?? '';
            const contextTokens = input + cacheRead + cacheCreate;
            const modelLimit = firstPositiveModelWindow(modelUsage);
            const contextLimit = modelLimit > 0 ? modelLimit : claudeContextWindow(model);
            const contextUnavailable = !u || (contextTokens === 0 && output === 0);
            const mergedModelUsage = mergeModelUsage(prev.model_usage, modelUsage);
            nextUsage = {
              input_tokens: prev.input_tokens + input,
              output_tokens: prev.output_tokens + output,
              cache_read_tokens: prev.cache_read_tokens + cacheRead,
              cache_creation_tokens: prev.cache_creation_tokens + cacheCreate,
              total_cost_usd: prev.total_cost_usd + turnCost,
              context_tokens: contextTokens,
              context_limit: contextLimit,
              turn_count: prev.turn_count + (typeof ev.numTurns === 'number' && ev.numTurns > 0 ? ev.numTurns : 1),
              ...((prev.reasoning_output_tokens ?? 0) + reasoning > 0
                ? { reasoning_output_tokens: (prev.reasoning_output_tokens ?? 0) + reasoning }
                : {}),
              ...(mergedModelUsage ? { model_usage: mergedModelUsage } : {}),
              authoritative: true,
              context_unavailable: contextUnavailable,
            };
            this.sessionUsage.set(sessionId, nextUsage);
            stream.push({
              kind: 'usage',
              status: 'updated',
              sessionId,
              turnId,
              timestamp: ts,
              payload: { ...nextUsage },
            });
          }
          stream.push({
            kind: 'turn',
            status: ev.isError ? 'failed' : 'completed',
            sessionId,
            turnId,
            timestamp: ts,
            payload: {
              reason: ev.isError ? 'failed' : 'completed',
              ...(ev.isError ? { error: ev.result } : {}),
              ...(nextUsage ? { usage: nextUsage } : {}),
            },
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
      .startTurn({ sessionId: effectiveId, prompt, cwd, isNew, model, effort, permissionMode, contentBlocks, ...(turnSettings ? { settings: turnSettings } : {}), onEvent: emit })
      .catch((err: unknown) => {
        stream.push({
          kind: 'turn',
          status: 'failed',
          sessionId,
          turnId,
          timestamp: Date.now(),
          payload: { reason: 'failed', error: err instanceof Error ? err.message : String(err) },
        });
      })
      .finally(() => {
        stream.end();
      });

    return { turnId, events: stream };
  }

  async interrupt(sessionId: string): Promise<void> {
    this.inner.interrupt(this.resolveEffectiveSessionId(sessionId));
  }

  async steer(
    sessionId: string,
    _turnId: string,
    input: string | MessageContentPart[] | SteerInput,
  ): Promise<void> {
    const raw =
      input && typeof input === 'object' && !Array.isArray(input) && 'input' in input
        ? input.input
        : input;
    await this.inner.steer(this.resolveEffectiveSessionId(sessionId), textOfInput(raw));
  }

  async resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    details?: GranularApprovalDetails,
  ): Promise<void> {
    const isCancel = details?.decision === 'cancel';
    const behavior =
      decision === 'reject' || isCancel
        ? 'deny'
        : decision === 'approve_always'
          ? 'approve_always'
          : 'allow';
    const opts: ResolveClaudeApprovalOptions = {};
    if (details?.updatedPermissions) opts.updatedPermissions = details.updatedPermissions;
    if (details?.updatedInput && typeof details.updatedInput === 'object' && !Array.isArray(details.updatedInput)) {
      opts.updatedInput = details.updatedInput as Record<string, unknown>;
    }
    if (typeof details?.message === 'string') opts.message = details.message;
    if (typeof details?.scope === 'string') opts.scope = details.scope;
    if (isCancel) opts.interrupt = true;
    if (Object.keys(opts).length > 0) {
      await this.inner.resolveApproval(this.resolveEffectiveSessionId(sessionId), approvalId, behavior, opts);
    } else {
      await this.inner.resolveApproval(this.resolveEffectiveSessionId(sessionId), approvalId, behavior);
    }
  }

  async resolveQuestion(
    sessionId: string,
    questionId: string,
    answer: string | Record<string, string[]>,
  ): Promise<void> {
    await this.inner.resolveQuestion(this.resolveEffectiveSessionId(sessionId), questionId, answer);
  }

  async setGoal(): Promise<Record<string, unknown> | null> {
    throw new ProviderError('unsupported', 'Claude 不支持 goal 能力', 400);
  }

  async getGoal(): Promise<Record<string, unknown> | null> {
    throw new ProviderError('unsupported', 'Claude 不支持 goal 能力', 400);
  }

  async controlGoal(): Promise<Record<string, unknown> | null> {
    throw new ProviderError('unsupported', 'Claude 不支持 goal 能力', 400);
  }

  async close(_sessionId: string): Promise<void> {
    // Claude 每 turn 独立进程;会话级 close 为空操作。
  }

  /** 进程级清理:杀所有 running turn 进程。网关 shutdown 时调用。 */
  async dispose(): Promise<void> {
    this.liveSubagents.clear();
    this.renames.clear();
    this.sessionCwd.clear();
    this.resetSessionIds.clear();
    this.sessionUsage.clear();
    this.settings.close();
    await this.inner.close();
  }

  // -- 原生目录与模型选择 ----------------------------------------------------

  private readonly renames = new Map<string, string>();

  async setModel(sessionId: string, model: string): Promise<void> {
    const ref = parseModelRef(model);
    if (ref && !this.providers?.provider(ref.key)) {
      throw new ProviderError('invalid_request', '所选模型的供应商不在当前目录中，请刷新模型目录后重试。', 400);
    }
    if (!model.trim() || (!ref && /qwen/i.test(model))) {
      throw new ProviderError('invalid_request', 'Claude 自带模型不接受空值或遗留的 qwen 模型名。', 400);
    }
    if (sessionId !== '__default__' && this.inner.isRunning(this.resolveEffectiveSessionId(sessionId))) {
      throw new ProviderError('busy', 'Claude 当前回合仍在进行，请等待结束后切换模型。', 409);
    }
    const value = ref ? encodeModelRef(ref.key, ref.model) : claudeCatalogAlias(model) ?? model.trim();
    this.settings.set('model', sessionId, value);
  }

  async rename(sessionId: string, title: string): Promise<void> {
    this.renames.set(sessionId, title);
    await this.inner.rename(this.resolveEffectiveSessionId(sessionId), title).catch((err: unknown) => {
      if (err instanceof ProviderError && err.code === 'not_found') return;
      throw err;
    });
  }

  // -- thinking / permission / plan / usage(持久态,turn 启动时透传 CLI 旗标) --

  private readonly sessionUsage = new Map<string, SessionUsage>();

  async setThinking(sessionId: string, thinking: string): Promise<void> {
    this.settings.set('thinking', sessionId, thinking);
  }

  getThinking(sessionId: string): string | undefined {
    return this.settings.getString('thinking', sessionId)
      ?? this.settings.getString('thinking', '__default__');
  }

  async setFastMode(sessionId: string, on: boolean): Promise<void> {
    this.settings.set('fastMode', sessionId, on ? 'on' : 'off');
    // 与 permission 同策略:持久化后尽力同步到活 turn;CLI 拒绝(模型不支持/未 opt-in)
    // 只影响当前轮,下一轮由 --settings 注入生效。
    if (sessionId === '__default__') return;
    await this.inner
      .applyFlagSettings(this.resolveEffectiveSessionId(sessionId), { fastMode: on })
      .catch(() => undefined);
  }

  getFastMode(sessionId: string): boolean | undefined {
    const raw = this.settings.getString('fastMode', sessionId)
      ?? this.settings.getString('fastMode', '__default__');
    if (raw === 'on') return true;
    if (raw === 'off') return false;
    return undefined;
  }

  async setColor(sessionId: string, color: string): Promise<void> {
    this.settings.set('color', sessionId, color);
    if (sessionId === '__default__') return;
    await this.inner
      .applyFlagSettings(this.resolveEffectiveSessionId(sessionId), { color })
      .catch(() => undefined);
  }

  getColor(sessionId: string): string | undefined {
    return this.settings.getString('color', sessionId)
      ?? this.settings.getString('color', '__default__');
  }

  async setPermission(sessionId: string, mode: string): Promise<void> {
    this.settings.set('permission', sessionId, mode);
    // 进行中的 turn 用的是启动时的 --permission-mode;同步给活 CLI,否则本轮仍按旧模式问。
    // 计划模式优先,不在这里覆盖。bypassPermissions 需要启动时已允许,CLI 拒绝时下一轮生效。
    if (sessionId === '__default__' || this.settings.getBoolean('plan', sessionId)) return;
    const cliMode = claudePermissionMode(mode);
    if (!cliMode) return;
    void this.inner
      .setPermissionMode(this.resolveEffectiveSessionId(sessionId), cliMode)
      .catch(() => undefined);
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

  async listMcpServers(sessionId?: string): Promise<Array<Record<string, unknown>>> {
    const effectiveId = sessionId ? this.resolveEffectiveSessionId(sessionId) : undefined;
    const cwd = effectiveId ? (this.sessionCwd.get(effectiveId) ?? this.sessionCwd.get(sessionId!)) : undefined;
    return this.inner.mcpStatus(effectiveId, cwd);
  }

  getModel(sessionId: string): string | undefined {
    // 忽略 ANTHROPIC_MODEL 与旧会话里的 qwen 残留值;保留官方别名与合法动态非 qwen 模型 ID。
    const stored = this.settings.getString('model', sessionId)
      ?? this.settings.getString('model', '__default__')
      ?? this.providers?.defaultModelRef();
    if (!stored) return undefined;
    if (parseModelRef(stored)) return stored;
    if (/qwen/i.test(stored)) return undefined;
    return claudeCatalogAlias(stored) ?? stored;
  }

  /**
   * 选择器目录来自 CLI initialize 握手:
   * - 官方别名(default/sonnet/fable/opus/haiku)收敛为官方别名和友好 display_name,
   *   绝不泄漏自定义端点的 qwen 名称;
   * - 其他非 qwen 动态模型保留完整 ID 与能力元数据。
   * 握手失败如实抛错,不伪造空目录,也不进缓存。
   */
  /** Gateway provider changed: each turn spawns a fresh CLI, so only the handshake catalog is stale. */
  providerChanged(): void {
    this.inner.clearHandshakeCache();
  }

  async listModels(): Promise<NativeModel[]> {
    const builtin = await this.inner.listBuiltinModels();
    // 握手回包里已有 claude_code_version;这里顺手触发一次目录读取以填充版本缓存。
    const claudeCliVersion = this.inner.claudeVersion?.();
    // 档位表只在模型自己报了档位、或 CLI 版本与钉子一致时才作为兜底；
    // 两者都没有时留空——不替 CLI 编一套它没声明的档位。
    const pinMatches = Boolean(
      claudeCliVersion && claudeCliVersion.startsWith(THINKING_PROFILES.claude.pinnedVersion),
    );
    const effortProfile = {
      efforts: (pinMatches ? THINKING_PROFILES.claude.levels : []) as readonly string[],
      verified: pinMatches,
      ultracode: supportsUltracode('claude', claudeCliVersion),
    };
    const seen = new Set<string>();
    const out: NativeModel[] = [];
    for (const model of builtin) {
      if (!model.value || /qwen/i.test(model.value)) continue;
      const alias = claudeCatalogAlias(model.value);
      const modelId = alias ?? model.value.trim();
      if (!modelId || seen.has(modelId)) continue;
      seen.add(modelId);
      const safeResolved =
        model.resolvedModel && !/qwen/i.test(model.resolvedModel) ? model.resolvedModel : undefined;
      const safeDescription =
        model.description && !/qwen/i.test(model.description) ? model.description : undefined;
      const { resolvedModel: _rawResolved, displayName: _rawDisplay, description: _rawDesc, ...restModel } = model;
      const displayName = alias
        ? CLAUDE_CATALOG_DISPLAY_NAME[alias]
        : model.displayName && !/qwen/i.test(model.displayName)
          ? model.displayName
          : modelId;
      const caps: string[] = [];
      if (model.supportsEffort || model.supportsAdaptiveThinking) caps.push('thinking');
      if (model.supportsAdaptiveThinking) caps.push('adaptive_thinking');
      if (model.fastMode) caps.push('fast_mode');
      const defaultEffort =
        typeof (model as any).defaultEffort === 'string'
          ? (model as any).defaultEffort
          : typeof (model as any).default_effort === 'string'
            ? (model as any).default_effort
            : (model.supportsEffort ? 'medium' : undefined);
      out.push({
        provider: 'claude',
        model: modelId,
        display_name: displayName,
        ...(safeDescription ? { description: safeDescription } : {}),
        ...(alias ? { max_context_size: claudeContextWindow(modelId, model.value, safeResolved) } : {}),
        capabilities: caps,
        ...(model.supportedEffortLevels?.length ? { support_efforts: model.supportedEffortLevels } : {}),
        ...(defaultEffort ? { default_effort: defaultEffort } : {}),
        ...(!model.supportedEffortLevels?.length && effortProfile.efforts.length
          ? { support_efforts: [...effortProfile.efforts] } : {}),
        ...(effortProfile.verified !== undefined ? { efforts_verified: effortProfile.verified } : {}),
        ...(effortProfile.ultracode !== undefined ? { supports_ultracode: effortProfile.ultracode } : {}),
        ...(model.supportsAdaptiveThinking !== undefined
          ? { supportsAdaptiveThinking: model.supportsAdaptiveThinking }
          : {}),
        ...(model.supportsThinkingOff !== undefined
          ? { supportsThinkingOff: model.supportsThinkingOff }
          : {}),
        ...(model.fastMode !== undefined ? { fastMode: model.fastMode } : {}),
        ...(model.supportsAutoMode !== undefined ? { supportsAutoMode: model.supportsAutoMode } : {}),
        ...(alias === 'default' ? { isDefault: true } : {}),
        raw: {
          ...restModel,
          displayName,
          ...(safeDescription ? { description: safeDescription } : {}),
          ...(safeResolved ? { resolvedModel: safeResolved } : {}),
        },
      } as NativeModel);
    }
    for (const provider of this.providers?.catalog() ?? []) {
      for (const m of provider.models) {
        const efforts = m.support_efforts?.filter((v) => THINKING_PROFILES.claude.levels.includes(v));
        out.push({ provider: provider.label, model: encodeModelRef(provider.key, m.model),
          display_name: m.display_name ?? m.model,
          ...(m.max_context_size ? { max_context_size: m.max_context_size } : {}),
          ...(m.max_output_size ? { max_output_tokens: m.max_output_size } : {}),
          capabilities: m.capabilities,
          ...(efforts?.length ? { support_efforts: efforts } : {}),
          ...(m.default_effort && efforts?.includes(m.default_effort) ? { default_effort: m.default_effort } : {}),
          ...(this.providers?.defaultModelRef() === encodeModelRef(provider.key, m.model) ? { isDefault: true } : {}),
        } as NativeModel);
      }
    }
    return out;
  }

  clearCommandsCache(): void {
    if (typeof (this.inner as any).clearHandshakeCache === 'function') {
      (this.inner as any).clearHandshakeCache();
    }
  }

  async listCommands(sessionId?: string, cwdOverride?: string): Promise<NativeCommand[]> {
    // 项目级命令发现需要 cwd:本进程新建的会话在 sessionCwd 里;历史会话
    // 从 transcript 摘要列表查(热态 ~15ms)。
    const effectiveId = sessionId ? this.resolveEffectiveSessionId(sessionId) : undefined;
    let cwd = cwdOverride ?? (effectiveId ? (this.sessionCwd.get(effectiveId) ?? this.sessionCwd.get(sessionId!)) : undefined);
    if (!cwd && effectiveId) {
      const sessions = await this.inner.list().catch(() => []);
      cwd = sessions.find((s) => s.sessionId === effectiveId || s.sessionId === sessionId)?.cwd;
    }
    // 权威目录 = CLI initialize 握手回包(内置 + 插件 + skills,失败回退零子进程磁盘发现)。
    const catalog = await this.inner.listSlashCommands(cwd);
    return listClaudeCommands(catalog, this.lastTerminalSlashCommands);
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    const effectiveId = this.resolveEffectiveSessionId(sessionId);
    if (archived) {
      this.settings.set('archived', sessionId, true);
      this.liveSubagents.delete(sessionId);
      this.liveSubagents.delete(effectiveId);
    } else {
      this.settings.delete('archived', sessionId);
    }
    await this.inner.setArchived(effectiveId, archived).catch((err: unknown) => {
      if (err instanceof ProviderError && err.code === 'not_found') return;
      throw err;
    });
  }

  async delete(sessionId: string): Promise<void> {
    const effectiveId = this.resolveEffectiveSessionId(sessionId);
    await this.inner.delete(effectiveId);
    if (effectiveId !== sessionId) {
      await this.inner.delete(sessionId).catch(() => undefined);
    }
    this.liveSubagents.delete(sessionId);
    this.liveSubagents.delete(effectiveId);
    this.resetSessionIds.delete(sessionId);
    this.settings.delete('resetSessionId', sessionId);
    this.renames.delete(sessionId);
    this.sessionCwd.delete(sessionId);
    this.sessionCwd.delete(effectiveId);
    this.settings.delete('model', sessionId);
    this.settings.delete('thinking', sessionId);
    this.settings.delete('permission', sessionId);
    this.settings.delete('plan', sessionId);
    this.settings.delete('archived', sessionId);
    this.sessionUsage.delete(sessionId);
  }

  async fork(sessionId: string): Promise<Session> {
    const effectiveId = this.resolveEffectiveSessionId(sessionId);
    let cwd = this.sessionCwd.get(effectiveId) ?? this.sessionCwd.get(sessionId);
    if (!cwd) {
      const sessions = await this.inner.list().catch(() => []);
      cwd = sessions.find((s) => s.sessionId === effectiveId || s.sessionId === sessionId)?.cwd;
    }
    cwd = cwd || process.cwd();
    const { sessionId: newId } = await this.inner.forkSession(effectiveId, cwd);
    this.sessionCwd.set(newId, cwd);
    this.settings.copySession(sessionId, newId);
    this.settings.delete('resetSessionId', newId);
    const title = this.renames.get(sessionId) ?? `Claude ${newId.slice(0, 8)}`;
    return {
      id: newId,
      workspace_id: workspaceIdFromCwd(cwd, 'claude'),
      title,
      created_at: nowIso(),
      updated_at: nowIso(),
      busy: false,
      metadata: { cwd },
      provider: 'claude',
    };
  }

  private toSession(s: {
    sessionId: string;
    title: string;
    cwd: string;
    updatedAt: string;
    createdAt?: string;
    firstPrompt?: string;
    archived?: boolean;
  }): Session {
    // 历史会话(transcript 扫描而来)也回填 cwd——否则 resume 时 startTurn
    // 只能退回 HOME 目录启动 CLI(审查发现),项目级命令发现同样依赖它。
    if (s.cwd) this.sessionCwd.set(s.sessionId, s.cwd);
    const title = this.renames.get(s.sessionId) ?? (s.title || `Claude ${s.sessionId.slice(0, 8)}`);
    const archived = s.archived === true || this.settings.getBoolean('archived', s.sessionId) === true;
    return {
      id: s.sessionId,
      workspace_id: workspaceIdFromCwd(s.cwd, 'claude'),
      title,
      created_at: s.createdAt ?? s.updatedAt,
      updated_at: s.updatedAt,
      busy: false,
      archived,
      extras: { last_prompt: s.firstPrompt || (this.renames.get(s.sessionId) ?? s.title ?? '') },
      metadata: { cwd: s.cwd },
      provider: 'claude',
    };
  }

  /** 网关 getSession 兜底用:新建未落盘的会话也能拿到真实 cwd,不造 HOME 假目录。 */
  getCwd(sessionId: string): string | undefined {
    return this.sessionCwd.get(sessionId);
  }

  async listSubagents(sessionId: string): Promise<SubagentInfo[]> {
    const effectiveId = this.resolveEffectiveSessionId(sessionId);
    this.pruneLiveSubagents(effectiveId);
    const diskDetails: Array<SubagentInfo & { taskId?: string }> = typeof this.inner.listSubagentDetails === 'function'
      ? await this.inner.listSubagentDetails(effectiveId)
      : (await this.inner.listSubagents(effectiveId)).map((id) => ({ agentId: id, status: 'unknown' }));
    const byAgentId = new Map<string, SubagentInfo>();
    const keyOf = new Map<string, string>();
    for (const d of diskDetails) {
      const { taskId, ...info } = d;
      byAgentId.set(d.agentId, info);
      keyOf.set(d.agentId, d.agentId);
      if (taskId) keyOf.set(taskId, d.agentId);
      if (d.parentToolUseId) keyOf.set(`tool:${d.parentToolUseId}`, d.agentId);
    }
    const live = this.liveSubagents.get(effectiveId) ?? this.liveSubagents.get(sessionId) ?? [];
    for (const l of live) {
      const existingKey = keyOf.get(l.agentId) ?? (l.taskId ? keyOf.get(l.taskId) : undefined)
        ?? (l.parentToolUseId ? keyOf.get(`tool:${l.parentToolUseId}`) : undefined);
      const current = existingKey ? byAgentId.get(existingKey) : undefined;
      const info: SubagentInfo = {
        ...current, agentId: current?.agentId ?? l.agentId,
        status: current?.status ?? 'unknown',
        parentToolUseId: current?.parentToolUseId ?? l.parentToolUseId,
        description: current?.description ?? l.description,
        subagentType: current?.subagentType ?? l.subagentType,
      };
      const diskTime = Math.max(Date.parse(current?.startedAt ?? '') || 0, Date.parse(current?.endedAt ?? '') || 0);
      const liveTime = l.completedAt ?? l.startedAt ?? 0;
      if (l.status !== 'unknown' && (!current || current.status === 'unknown' || liveTime >= diskTime)) {
        info.status = l.status;
        info.startedAt = l.startedAt ? new Date(l.startedAt).toISOString() : current?.startedAt;
        info.endedAt = l.status === 'running' ? undefined : l.completedAt ? new Date(l.completedAt).toISOString() : current?.endedAt;
      }
      byAgentId.set(info.agentId, info);
    }
    return [...byAgentId.values()];
  }

  async getSubagentMessages(sessionId: string, agentId: string): Promise<Message[]> {
    const effectiveId = this.resolveEffectiveSessionId(sessionId);
    let resolvedId = agentId;

    const diskDetails: Array<{ agentId: string; parentToolUseId?: string; taskId?: string }> =
      typeof (this.inner as any).listSubagentDetails === 'function'
        ? await (this.inner as any).listSubagentDetails(effectiveId)
        : [];
    const matchedDisk = diskDetails.find(
      (d) => d.agentId === agentId || d.parentToolUseId === agentId || d.taskId === agentId,
    );
    if (matchedDisk) {
      resolvedId = matchedDisk.agentId;
    } else {
      const live = this.liveSubagents.get(effectiveId) ?? this.liveSubagents.get(sessionId) ?? [];
      const matchedLive = live.find(
        (l) => l.agentId === agentId || l.parentToolUseId === agentId || l.taskId === agentId,
      );
      if (matchedLive) {
        resolvedId = matchedLive.agentId;
      }
    }

    const rawMsgs = await this.inner.getSubagentMessages(effectiveId, resolvedId);
    return rawMsgs.map((m, index) => {
      const content: Message['content'] = m.blocks && m.blocks.length > 0
        ? m.blocks.map((b) => {
            if (b.type === 'thinking') return kimiHistoryPart({ type: 'thinking', thinking: b.text });
            if (b.type === 'tool_use') {
              return kimiHistoryPart({
                type: 'tool_use',
                tool_call_id: b.id,
                tool_name: b.name,
                input: b.input,
                ...(m.parentToolUseId ? { parent_tool_use_id: m.parentToolUseId } : {}),
              });
            }
            if (b.type === 'tool_result') {
              return kimiHistoryPart({
                type: 'tool_result',
                tool_call_id: b.tool_use_id,
                output: b.content,
                is_error: b.is_error === true,
                ...(m.parentToolUseId ? { parent_tool_use_id: m.parentToolUseId } : {}),
              });
            }
            return { type: 'text' as const, text: b.text };
          })
        : [{ type: 'text' as const, text: m.text }];

      const hasMeta = Boolean(m.model || m.isError || m.agentId || resolvedId || m.parentToolUseId || m.isCompactSummary);
      return {
        id: `sub_${createHash('sha256')
          .update(JSON.stringify([sessionId, resolvedId, index, m.role, m.timestamp ?? '', m.text]))
          .digest('hex')
          .slice(0, 24)}`,
        session_id: sessionId,
        role: content.length > 0 && content.every((part) => part.type === 'tool_result') ? 'tool' : m.role,
        content,
        created_at: m.timestamp ?? nowIso(),
        ...(hasMeta ? {
          metadata: {
            agent_id: resolvedId,
            agentId: resolvedId,
            ...(m.model ? { model: m.model } : {}),
            ...(m.isError ? { is_error: true } : {}),
            ...(m.parentToolUseId ? { parent_tool_use_id: m.parentToolUseId } : {}),
            ...(m.isCompactSummary ? { is_compact_summary: true } : {}),
          },
        } : {}),
      };
    });
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

function codexAnchorKey(msg: Message): string | null {
  const part = msg.content[0];
  if (!part) return null;
  const squash = (text: unknown): string => (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim();
  if (part.type === 'text') return `${msg.role}:text:${squash(part.text)}`;
  if (part.type === 'thinking') return `${msg.role}:thinking:${squash((part as { thinking?: unknown }).thinking)}`;
  return null;
}

/**
 * The live thread only knows some tool calls; the rollout file knows them all and is the source of truth
 * for ordering. Each tool the live thread lacks is attached right after the nearest preceding rollout
 * message the live thread also has (matched by id, tool call id, or text, never moving backwards). Tools
 * of a known turn stay inside that turn; tools of an unknown turn keep their rollout position, and tools
 * with no anchor at all go to the end instead of being dropped.
 */
function mergeRolloutToolsIntoHistory(
  base: Message[],
  rolloutOrder: Message[],
  missingTools: Map<Message, string | undefined>,
  turnRanges: Map<string, { start: number; end: number }>,
): Message[] {
  if (missingTools.size === 0) return base;
  const byId = new Map<string, number>();
  const byToolPart = new Map<string, number>();
  const byKey = new Map<string, number[]>();
  base.forEach((msg, index) => {
    if (!byId.has(msg.id)) byId.set(msg.id, index);
    const part = msg.content[0];
    if (part && (part.type === 'tool_use' || part.type === 'tool_result') && part.tool_call_id) {
      const key = `${part.tool_call_id}:${part.type}`;
      if (!byToolPart.has(key)) byToolPart.set(key, index);
    }
    const anchorKey = codexAnchorKey(msg);
    if (anchorKey) {
      const list = byKey.get(anchorKey);
      if (list) list.push(index);
      else byKey.set(anchorKey, [index]);
    }
  });
  const locate = (msg: Message, after: number): number => {
    const part = msg.content[0];
    if (part && (part.type === 'tool_use' || part.type === 'tool_result') && part.tool_call_id) {
      return byToolPart.get(`${part.tool_call_id}:${part.type}`) ?? -1;
    }
    const byIdHit = byId.get(msg.id);
    if (byIdHit !== undefined) return byIdHit;
    const anchorKey = codexAnchorKey(msg);
    if (anchorKey) return byKey.get(anchorKey)?.find((index) => index > after) ?? -1;
    return -1;
  };

  const insertions = new Map<number, Message[]>();
  const place = (after: number, msg: Message): void => {
    const list = insertions.get(after);
    if (list) list.push(msg);
    else insertions.set(after, [msg]);
  };
  let last = -1;
  for (const msg of rolloutOrder) {
    if (!missingTools.has(msg)) {
      const hit = locate(msg, last);
      if (hit > last) last = hit;
      continue;
    }
    const turnId = missingTools.get(msg);
    const range = turnId ? turnRanges.get(turnId) : undefined;
    let after: number;
    if (range) {
      if (last < range.start) {
        after = range.end > range.start && base[range.start]?.role === 'user' ? range.start : range.start - 1;
      } else {
        after = Math.min(last, range.end - 1);
      }
    } else {
      after = last >= 0 ? last : base.length - 1;
    }
    place(after, msg);
  }

  const merged: Message[] = [];
  const head = insertions.get(-1);
  if (head) merged.push(...head);
  base.forEach((msg, index) => {
    merged.push(msg);
    const inserted = insertions.get(index);
    if (inserted) merged.push(...inserted);
  });
  return merged;
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

function normalizeClaudeModelUsage(
  raw: Record<string, unknown> | undefined,
): Record<string, ModelUsageEntry> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, ModelUsageEntry> = {};
  for (const [modelName, val] of Object.entries(raw)) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
    const rec = val as Record<string, unknown>;
    const contextWindow = num(rec.contextWindow ?? rec.context_window);
    const maxOutputTokens = num(rec.maxOutputTokens ?? rec.max_output_tokens);
    const cacheRead = num(rec.cacheReadInputTokens ?? rec.cache_read_input_tokens ?? rec.cache_read_tokens);
    const cacheCreate = num(rec.cacheCreationInputTokens ?? rec.cache_creation_input_tokens ?? rec.cache_creation_tokens);
    const reasoning = num(rec.thinkingTokens ?? rec.reasoningOutputTokens ?? rec.reasoning_output_tokens);
    const totalCost = num(rec.costUSD ?? rec.totalCostUsd ?? rec.total_cost_usd);
    out[modelName] = {
      input_tokens: num(rec.inputTokens ?? rec.input_tokens),
      output_tokens: num(rec.outputTokens ?? rec.output_tokens),
      ...(cacheRead > 0 ? { cache_read_tokens: cacheRead } : {}),
      ...(cacheCreate > 0 ? { cache_creation_tokens: cacheCreate } : {}),
      ...(reasoning > 0 ? { reasoning_output_tokens: reasoning } : {}),
      ...(totalCost > 0 ? { total_cost_usd: totalCost } : {}),
      ...(contextWindow > 0 ? { context_window: contextWindow } : {}),
      ...(maxOutputTokens > 0 ? { max_output_tokens: maxOutputTokens } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mergeModelUsage(
  prev: Record<string, ModelUsageEntry | Record<string, unknown>> | undefined,
  next: Record<string, ModelUsageEntry> | undefined,
): Record<string, ModelUsageEntry | Record<string, unknown>> | undefined {
  if (!next) return prev;
  const merged: Record<string, ModelUsageEntry | Record<string, unknown>> = { ...(prev ?? {}) };
  for (const [model, entry] of Object.entries(next)) {
    const old = merged[model] as ModelUsageEntry | undefined;
    if (!old) {
      merged[model] = entry;
      continue;
    }
    merged[model] = {
      ...old,
      ...entry,
      input_tokens: num(old.input_tokens) + entry.input_tokens,
      output_tokens: num(old.output_tokens) + entry.output_tokens,
      cache_read_tokens: num(old.cache_read_tokens) + num(entry.cache_read_tokens),
      cache_creation_tokens: num(old.cache_creation_tokens) + num(entry.cache_creation_tokens),
      ...(num(old.reasoning_output_tokens) + num(entry.reasoning_output_tokens) > 0
        ? { reasoning_output_tokens: num(old.reasoning_output_tokens) + num(entry.reasoning_output_tokens) }
        : {}),
      ...(num(old.total_cost_usd) + num(entry.total_cost_usd) > 0
        ? { total_cost_usd: num(old.total_cost_usd) + num(entry.total_cost_usd) }
        : {}),
    };
  }
  return merged;
}

function firstPositiveModelWindow(modelUsage: Record<string, ModelUsageEntry> | undefined): number {
  if (!modelUsage) return 0;
  for (const entry of Object.values(modelUsage)) {
    if (typeof entry.context_window === 'number' && entry.context_window > 0) {
      return entry.context_window;
    }
  }
  return 0;
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
