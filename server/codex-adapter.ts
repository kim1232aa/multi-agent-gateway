/**
 * CodexAdapter — wraps `codex app-server` (Codex CLI 0.147.x, JSON-RPC over
 * newline-delimited stdio) behind a ProviderAdapter-shaped interface so the
 * gateway can treat Codex like any other provider.
 *
 * Protocol notes (verified against /home/ubuntu/temp/proto-recon/codex-schema):
 * - Handshake: client → {id, method:'initialize', params:{clientInfo,
 *   capabilities:{experimentalApi:true}}} → server result → client sends
 *   {method:'initialized'} notification.
 * - Messages have NO `jsonrpc:'2.0'` field. A message with both `id` and
 *   `method` is a server→client *request* (approvals, user-input) that must be
 *   answered with {id, result} / {id, error}. `{method, params}` is a
 *   notification; `{id, result|error}` is a response to a client request.
 * - Threads: thread/start | thread/list | thread/read(includeTurns) |
 *   thread/resume. Turns: turn/start({threadId, input:[{type:'text',text}]}),
 *   streaming via item/* and turn/* notifications, turn/interrupt to abort.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { z } from 'zod';
import { findCodexRollout } from './local-transcript.js';
import { ProviderError } from './types.js';

// ---------------------------------------------------------------------------
// Wire schemas (loose on purpose: unknown fields are kept via catchall so the
// adapter survives protocol additions; only the fields we rely on are typed).
// ---------------------------------------------------------------------------

const RequestIdSchema = z.union([z.string(), z.number()]);
export type CodexRequestId = z.infer<typeof RequestIdSchema>;

const ThreadItemSchema = z
  .object({ id: z.string(), type: z.string() })
  .catchall(z.unknown());
export type CodexThreadItem = z.infer<typeof ThreadItemSchema>;

const TurnErrorSchema = z
  .object({ message: z.string() })
  .catchall(z.unknown());

const TurnSchema = z
  .object({
    id: z.string(),
    status: z.string(), // 'inProgress' | 'completed' | 'interrupted' | 'failed'
    error: TurnErrorSchema.nullish(),
    items: z.array(ThreadItemSchema).nullish(),
  })
  .catchall(z.unknown());
export type CodexTurn = z.infer<typeof TurnSchema>;

const ThreadSchema = z
  .object({
    id: z.string(),
    preview: z.string().nullish(),
    name: z.string().nullish(),
    cwd: z.string().nullish(),
    createdAt: z.number().nullish(),
    updatedAt: z.number().nullish(),
    modelProvider: z.string().nullish(),
    cliVersion: z.string().nullish(),
    status: z.unknown().nullish(),
    turns: z.array(TurnSchema).nullish(),
  })
  .catchall(z.unknown());
export type CodexThread = z.infer<typeof ThreadSchema>;

const ThreadStartResponseSchema = z
  .object({ thread: ThreadSchema, model: z.string().nullish() })
  .catchall(z.unknown());

const ThreadListResponseSchema = z.object({
  data: z.array(ThreadSchema),
  nextCursor: z.string().nullish(),
  backwardsCursor: z.string().nullish(),
});

const ThreadReadResponseSchema = z.object({ thread: ThreadSchema });
const ThreadResumeResponseSchema = z
  .object({ thread: ThreadSchema, model: z.string().nullish() })
  .catchall(z.unknown());
const TurnStartResponseSchema = z.object({ turn: TurnSchema });

const ItemRefSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
});

const ApprovalRequestParamsSchema = ItemRefSchema.extend({
  reason: z.string().nullish(),
  command: z.string().nullish(),
  approvalId: z.string().nullish(),
  grantRoot: z.string().nullish(),
}).catchall(z.unknown());

const UserInputRequestParamsSchema = ItemRefSchema.extend({
  questions: z.array(z.unknown()),
  isBlocking: z.boolean().nullish(),
}).catchall(z.unknown());

// ---------------------------------------------------------------------------
// Public event surface.
// ---------------------------------------------------------------------------

export type ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | Record<string, unknown>; // e.g. {acceptWithExecpolicyAmendment:{...}}

export type CodexEvent =
  | { type: 'connected' }
  | { type: 'disconnected'; code: number | null; signal: string | null }
  | { type: 'log'; line: string }
  | { type: 'thread-started'; thread: CodexThread }
  | { type: 'turn-started'; threadId: string; turnId: string; turn: CodexTurn }
  | { type: 'text-delta'; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: 'reasoning-delta'; threadId: string; turnId: string; itemId: string; contentIndex: number; delta: string }
  | { type: 'command-output-delta'; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: 'item-started'; threadId: string; turnId: string; item: CodexThreadItem }
  | { type: 'item-completed'; threadId: string; turnId: string; item: CodexThreadItem }
  | { type: 'turn-completed'; threadId: string; turnId: string; turn: CodexTurn }
  | {
      type: 'approval-request';
      requestId: CodexRequestId;
      kind: 'commandExecution' | 'fileChange';
      threadId: string;
      turnId: string;
      itemId: string;
      command?: string;
      reason?: string;
      params: Record<string, unknown>;
    }
  | { type: 'question-request';
      requestId: CodexRequestId;
      threadId: string;
      turnId: string;
      itemId: string;
      questions: unknown[];
      params: Record<string, unknown>;
    }
  | { type: 'server-request'; requestId: CodexRequestId; method: string; params: unknown }
  /** thread/tokenUsage/updated(0.147.0 实测通知名):last=本 turn,total=累计。 */
  | {
      type: 'token-usage';
      threadId: string;
      turnId: string;
      usage: {
        last: Record<string, unknown>;
        total: Record<string, unknown>;
        modelContextWindow: number | null;
      };
    }
  /** thread/goal/updated:set/clear 后广播(goal 为 null = 已清除)。 */
  | { type: 'goal-updated'; threadId: string; goal: Record<string, unknown> | null }
  /** thread/archived / thread/unarchived。 */
  | { type: 'thread-archived-changed'; threadId: string; archived: boolean }
  | { type: 'error'; message: string; threadId?: string; turnId?: string; willRetry?: boolean; raw?: unknown };

export type CodexEventHandler = (event: CodexEvent) => void;

export interface CodexAdapterOptions {
  /** Path to the codex binary. Defaults to $CODEX_PATH or 'codex' on PATH. */
  codexPath?: string;
  /** Extra CLI args after `app-server` (default stdio transport). */
  args?: string[];
  /** Environment overrides for the child process. */
  env?: NodeJS.ProcessEnv;
  /** clientInfo sent during initialize. */
  clientInfo?: { name: string; title?: string; version: string };
  /** Timeout for individual JSON-RPC requests (ms). Default 120_000. */
  requestTimeoutMs?: number;
  /**
   * Recycle the app-server after this much idle time (ms). thread/resume
   * acquires codex's single-writer lock and only process exit releases it;
   * without recycling, viewing a session in the web UI blocks `codex resume`
   * in the CLI until the gateway restarts. Default 60_000; 0 disables.
   */
  recycleGraceMs?: number;
  /**
   * When true, approval requests are answered immediately with 'accept' and
   * user-input questions with empty answers instead of being parked until
   * resolveApproval/resolveQuestion is called. Default false (park + emit).
   */
  autoApprove?: boolean;
  /** Called with each raw stderr line from the codex process. */
  onStderr?: (line: string) => void;
}

export type ThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'subAgent'
  | 'subAgentReview'
  | 'subAgentCompact'
  | 'subAgentThreadSpawn'
  | 'subAgentOther'
  | 'unknown';

export interface ThreadListOptions {
  cursor?: string;
  limit?: number;
  cwd?: string;
  archived?: boolean;
  searchTerm?: string;
  sourceKinds?: ThreadSourceKind[];
}

export interface ThreadStartOptions {
  cwd?: string;
  model?: string;
  approvalPolicy?: 'untrusted' | 'on-request' | 'never' | Record<string, unknown>;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  serviceName?: string;
  baseInstructions?: string;
  developerInstructions?: string;
  config?: Record<string, unknown>;
  ephemeral?: boolean;
}

export interface TurnStartOptions {
  model?: string;
  effort?: string;
  cwd?: string;
  approvalPolicy?: 'untrusted' | 'on-request' | 'never' | Record<string, unknown>;
  sandboxPolicy?: Record<string, unknown>;
  clientUserMessageId?: string;
}

export interface CodexTurnHandle {
  threadId: string;
  turnId: string;
  /** Events for this turn; ends after 'turn-completed' (or errors/close). */
  events: AsyncIterable<CodexEvent>;
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

interface PendingClientRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingServerRequest {
  /** 线上回包要用的原始 id(可能是数字);Map 键统一 String(id),防止
   * 数字 id 的 parked 请求在 resolve 时因键类型不匹配找不到(审查发现)。 */
  id: CodexRequestId;
  method: string;
  params: unknown;
}

class TurnEventQueue implements AsyncIterable<CodexEvent> {
  private buffer: CodexEvent[] = [];
  private waiter: {
    resolve: (r: IteratorResult<CodexEvent>) => void;
    reject: (err: Error) => void;
  } | null = null;
  private done = false;
  private failure: Error | null = null;

  push(event: CodexEvent): void {
    if (this.done) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve({ value: event, done: false });
    } else {
      this.buffer.push(event);
    }
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve({ value: undefined as unknown as CodexEvent, done: true });
    }
  }

  fail(err: Error): void {
    if (this.done) return;
    this.failure = err;
    this.done = true;
    // 有人在等下一帧时必须 reject,不能走 close() 的 done:true——
    // 否则 driveTurn 会把进程崩溃收成假成功。
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexEvent> {
    return {
      next: (): Promise<IteratorResult<CodexEvent>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.failure) return Promise.reject(this.failure);
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as CodexEvent, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// CodexAdapter
// ---------------------------------------------------------------------------

export class CodexAdapter {
  readonly provider = 'codex' as const;
  /** 未落盘线程的回收保护期:覆盖"新建会话→想一下→发首条消息"的正常间隔。 */
  private static readonly UNPERSISTED_PROTECT_MS = 15 * 60_000;

  private opts: Required<Pick<CodexAdapterOptions, 'requestTimeoutMs' | 'recycleGraceMs'>> & CodexAdapterOptions;
  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pendingClient = new Map<CodexRequestId, PendingClientRequest>();
  private pendingServer = new Map<string, PendingServerRequest>(); // 键统一 String(requestId)
  private listeners = new Set<CodexEventHandler>();
  private turnQueues = new Map<string, TurnEventQueue>(); // key: `${threadId}:${turnId}`
  // queue 注册前到达的 turn 事件缓冲:startTurn 的 queue 注册在 request 响应
  // 之后(多个微任务跳),app-server 同一 chunk 内"响应行之后"的通知在那之前
  // 就派发,直接路由会静默丢掉(turn/completed 丢失挂死消费方)。注册时按序
  // drain;永不注册的外部 turn 由 FIFO/单 key 上限兜底,内存有界。
  private pendingTurnEvents = new Map<string, CodexEvent[]>();
  private seenTurnStarts = new Set<string>(); // dedupe synthesized vs server turn-started
  /**
   * 本进程内已激活的 thread(thread/start|resume 过)。app-server 是有状态的:
   * 进程重启后内存里的 thread 全丢,turn/start 直打会以 "thread not found"
   * 失败(实测)——跨重启续聊必须先 thread/resume。
   */
  private liveThreads = new Set<string>();
  /** 线程启动/恢复时显式指定的模型(thread/settings/update 的 model 必填,要用它)。 */
  private threadModels = new Map<string, string>();
  private configModelCache: string | null = null;
  private readyPromise: Promise<void> | null = null;
  private closed = false;
  private recycleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * thread/start 创建但未落盘的线程(codex 要等首个 turn 才写 rollout)及其
   * 创建时间。回收会杀掉 app-server,这类线程随之蒸发("no rollout found",
   * 且从会话列表消失)——保护期内禁止回收;首个 turn 后 rollout 出现,
   * recycleIfIdle 自查文件并移出。超过保护期(用户建了就走)放弃保护,
   * 否则一个废弃草稿线程会把回收永久钉死,CLI 锁又回不来。
   */
  private unpersistedThreads = new Map<string, number>();

  constructor(options: CodexAdapterOptions = {}) {
    this.opts = { requestTimeoutMs: 120_000, recycleGraceMs: 60_000, ...options };
  }

  // -- lifecycle ------------------------------------------------------------

  /** Spawn `codex app-server` and run the initialize handshake. Idempotent. */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('CodexAdapter is closed'));
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.doConnect().catch((err) => {
      this.readyPromise = null;
      throw err;
    });
    return this.readyPromise;
  }

  private async doConnect(): Promise<void> {
    const bin = this.opts.codexPath ?? process.env.CODEX_PATH ?? 'codex';
    const args = ['app-server', ...(this.opts.args ?? [])];
    this.child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.opts.env ?? {}) },
    });
    this.child.on('error', (err) => this.handleProcessExit(err));
    this.child.on('exit', (code, signal) => this.handleProcessExit(null, code, signal));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.opts.onStderr?.(line);
        this.emit({ type: 'log', line });
      }
    });
    this.rl = readline.createInterface({ input: this.child.stdout! });
    this.rl.on('line', (line) => this.handleLine(line));

    const initParams = {
      clientInfo: this.opts.clientInfo ?? {
        name: 'multi-agent-gateway',
        title: 'Multi Agent Gateway',
        version: '0.1.0',
      },
      capabilities: { experimentalApi: true },
    };
    await this.request('initialize', initParams);
    this.notify('initialized', {});
    this.emit({ type: 'connected' });
  }

  /** Terminate the app-server process and fail all pending state. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.recycleTimer) {
      clearTimeout(this.recycleTimer);
      this.recycleTimer = null;
    }
    this.rl?.close();
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
          res();
        }, 3_000);
        child.once('exit', () => {
          clearTimeout(t);
          res();
        });
      });
    }
    this.handleProcessExit(null, child?.exitCode ?? null, null);
  }

  // -- event subscription ----------------------------------------------------

  /** Subscribe to every adapter event. Returns an unsubscribe function. */
  onEvent(handler: CodexEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  private emit(event: CodexEvent): void {
    this.notifyListeners(event);
    const key = this.eventTurnKey(event);
    if (!key) return;
    this.lastTurnActivityAt = Date.now();
    const q = this.turnQueues.get(key);
    if (q) {
      q.push(event);
      if (event.type === 'turn-completed') {
        q.close();
        this.turnQueues.delete(key);
      }
      return;
    }
    // queue 还没注册(startTurn 的响应 continuation 还没跑完):缓冲,注册时 drain。
    let pending = this.pendingTurnEvents.get(key);
    if (!pending) {
      pending = [];
      this.pendingTurnEvents.set(key, pending);
      // 外部 client 的 turn 永远不会注册:淘汰最旧 key,防缓慢泄漏。
      if (this.pendingTurnEvents.size > 50) {
        const oldest = this.pendingTurnEvents.keys().next().value;
        if (oldest !== undefined) this.pendingTurnEvents.delete(oldest);
      }
    }
    if (pending.length < 500) pending.push(event);
  }

  private notifyListeners(event: CodexEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        // listener errors must not break the dispatch loop
      }
    }
  }

  private eventTurnKey(event: CodexEvent): string | null {
    if ('threadId' in event && 'turnId' in event && event.threadId && event.turnId) {
      return `${event.threadId}:${event.turnId}`;
    }
    return null;
  }

  // -- JSON-RPC plumbing ------------------------------------------------------

  private write(msg: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new Error('codex app-server is not running');
    stdin.write(JSON.stringify(msg) + '\n');
  }

  private notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  private request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const budget = timeoutMs ?? this.opts.requestTimeoutMs;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingClient.delete(id);
        reject(new Error(`codex request '${method}' timed out after ${budget}ms`));
      }, budget);
      this.pendingClient.set(id, { method, resolve, reject, timer });
      try {
        this.write(params === undefined ? { id, method } : { id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pendingClient.delete(id);
        reject(err);
      }
    });
  }

  private respond(id: CodexRequestId, result: unknown): void {
    this.write({ id, result });
  }

  private respondError(id: CodexRequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit({ type: 'log', line: `[non-json stdout] ${line}` });
      return;
    }
    const id = msg.id as CodexRequestId | undefined;
    const method = msg.method as string | undefined;

    if (id !== undefined && method !== undefined) {
      this.handleServerRequest(id, method, msg.params);
    } else if (id !== undefined) {
      this.handleResponse(id, msg);
    } else if (method !== undefined) {
      this.handleNotification(method, msg.params);
    }
  }

  private handleResponse(id: CodexRequestId, msg: Record<string, unknown>): void {
    const pending = this.pendingClient.get(id);
    if (!pending) return;
    this.pendingClient.delete(id);
    clearTimeout(pending.timer);
    const err = msg.error as { code?: number; message?: string } | undefined;
    if (err) {
      pending.reject(new Error(`codex '${pending.method}' failed (${err.code ?? '?'}): ${err.message ?? 'unknown error'}`));
    } else {
      pending.resolve(msg.result);
    }
    // 任何请求落定都是潜在空闲点(thread/resume 也会占写手锁,不能只看 turn)。
    this.scheduleRecycleWhenIdle();
  }

  // -- server → client reverse requests ----------------------------------------

  private handleServerRequest(id: CodexRequestId, method: string, params: unknown): void {
    const key = String(id);
    const parked: PendingServerRequest = { id, method, params };
    this.pendingServer.set(key, parked);

    const approvalMethod =
      method === 'item/commandExecution/requestApproval'
        ? 'commandExecution'
        : method === 'item/fileChange/requestApproval'
          ? 'fileChange'
          : null;

    if (approvalMethod) {
      const parsed = ApprovalRequestParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.pendingServer.delete(key);
        this.respondError(id, -32602, `invalid ${method} params: ${parsed.error.message}`);
        return;
      }
      const p = parsed.data;
      if (this.opts.autoApprove) {
        this.pendingServer.delete(key);
        this.respond(id, { decision: 'accept' });
        return;
      }
      this.emit({
        type: 'approval-request',
        requestId: id,
        kind: approvalMethod,
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        command: p.command ?? undefined,
        reason: p.reason ?? undefined,
        params: p as Record<string, unknown>,
      });
      return;
    }

    if (method === 'item/tool/requestUserInput') {
      const parsed = UserInputRequestParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.pendingServer.delete(key);
        this.respondError(id, -32602, `invalid ${method} params: ${parsed.error.message}`);
        return;
      }
      const p = parsed.data;
      if (this.opts.autoApprove) {
        this.pendingServer.delete(key);
        this.respond(id, { answers: {} });
        return;
      }
      this.emit({
        type: 'question-request',
        requestId: id,
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        questions: p.questions,
        params: p as Record<string, unknown>,
      });
      return;
    }

    // Unknown reverse request: surface it; caller may answer via respondTo().
    this.emit({ type: 'server-request', requestId: id, method, params });
  }

  /**
   * Answer a parked approval request. decision maps to the protocol's
   * CommandExecutionApprovalDecision / FileChangeApprovalDecision.
   */
  resolveApproval(requestId: CodexRequestId, decision: ApprovalDecision): void {
    const key = String(requestId);
    const parked = this.pendingServer.get(key);
    if (!parked) throw new Error(`no pending server request with id ${key}`);
    if (
      parked.method !== 'item/commandExecution/requestApproval' &&
      parked.method !== 'item/fileChange/requestApproval'
    ) {
      throw new Error(`pending request ${key} is '${parked.method}', not an approval`);
    }
    this.pendingServer.delete(key);
    this.respond(parked.id, { decision });
  }

  /**
   * Answer a parked item/tool/requestUserInput request.
   * Accepts {questionId: string[]} and wraps it into the protocol shape
   * {answers: {questionId: {answers: string[]}}}.
   */
  resolveQuestion(requestId: CodexRequestId, answers: Record<string, string[]>): void {
    const key = String(requestId);
    const parked = this.pendingServer.get(key);
    if (!parked) throw new Error(`no pending server request with id ${key}`);
    if (parked.method !== 'item/tool/requestUserInput') {
      throw new Error(`pending request ${key} is '${parked.method}', not a user-input request`);
    }
    this.pendingServer.delete(key);
    const wrapped: Record<string, { answers: string[] }> = {};
    for (const [qid, ans] of Object.entries(answers)) wrapped[qid] = { answers: ans };
    this.respond(parked.id, { answers: wrapped });
  }

  /** Escape hatch for reverse requests not covered by the helpers above. */
  respondTo(requestId: CodexRequestId, result: unknown): void {
    const key = String(requestId);
    const parked = this.pendingServer.get(key);
    if (!parked) throw new Error(`no pending server request with id ${key}`);
    this.pendingServer.delete(key);
    this.respond(parked.id, result);
  }

  // -- notifications -------------------------------------------------------------

  private handleNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'thread/started': {
        const parsed = ThreadSchema.safeParse(p.thread);
        if (parsed.success) this.emit({ type: 'thread-started', thread: parsed.data });
        break;
      }
      case 'turn/started': {
        const turn = TurnSchema.safeParse(p.turn);
        if (turn.success && typeof p.threadId === 'string') {
          const key = `${p.threadId}:${turn.data.id}`;
          // startTurn() already emits a synthesized turn-started when it
          // registers the queue; suppress the duplicate from the server.
          if (!this.seenTurnStarts.has(key)) {
            this.seenTurnStarts.add(key);
            this.emit({ type: 'turn-started', threadId: p.threadId, turnId: turn.data.id, turn: turn.data });
          }
        }
        break;
      }
      case 'turn/completed': {
        const turn = TurnSchema.safeParse(p.turn);
        if (turn.success && typeof p.threadId === 'string') {
          // turn 结束,去重记录一并清掉,防 seenTurnStarts 无限增长。
          this.seenTurnStarts.delete(`${p.threadId}:${turn.data.id}`);
          this.emit({ type: 'turn-completed', threadId: p.threadId, turnId: turn.data.id, turn: turn.data });
          this.scheduleRecycleWhenIdle();
        }
        break;
      }
      case 'item/agentMessage/delta': {
        const r = ItemRefSchema.extend({ delta: z.string() }).safeParse(p);
        if (r.success) this.emit({ type: 'text-delta', ...r.data });
        break;
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const r = ItemRefSchema.extend({ delta: z.string(), contentIndex: z.number().nullish() }).safeParse(p);
        if (r.success) {
          this.emit({ type: 'reasoning-delta', ...r.data, contentIndex: r.data.contentIndex ?? 0 });
        }
        break;
      }
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta': {
        const r = ItemRefSchema.extend({ delta: z.string() }).safeParse(p);
        if (r.success) this.emit({ type: 'command-output-delta', ...r.data });
        break;
      }
      case 'item/started': {
        const item = ThreadItemSchema.safeParse(p.item);
        if (item.success && typeof p.threadId === 'string' && typeof p.turnId === 'string') {
          this.emit({ type: 'item-started', threadId: p.threadId, turnId: p.turnId, item: item.data });
        }
        break;
      }
      case 'item/completed': {
        const item = ThreadItemSchema.safeParse(p.item);
        if (item.success && typeof p.threadId === 'string' && typeof p.turnId === 'string') {
          this.emit({ type: 'item-completed', threadId: p.threadId, turnId: p.turnId, item: item.data });
        }
        break;
      }
      case 'error': {
        const err = (p.error ?? {}) as Record<string, unknown>;
        this.emit({
          type: 'error',
          message: typeof err.message === 'string' ? err.message : JSON.stringify(p),
          threadId: typeof p.threadId === 'string' ? p.threadId : undefined,
          turnId: typeof p.turnId === 'string' ? p.turnId : undefined,
          willRetry: typeof p.willRetry === 'boolean' ? p.willRetry : undefined,
          raw: p,
        });
        break;
      }
      case 'thread/tokenUsage/updated': {
        if (typeof p.threadId === 'string' && typeof p.turnId === 'string') {
          const u = (p.tokenUsage ?? {}) as Record<string, unknown>;
          this.emit({
            type: 'token-usage',
            threadId: p.threadId,
            turnId: p.turnId,
            usage: {
              last: (u.last ?? {}) as Record<string, unknown>,
              total: (u.total ?? {}) as Record<string, unknown>,
              modelContextWindow: typeof u.modelContextWindow === 'number' ? u.modelContextWindow : null,
            },
          });
        }
        break;
      }
      case 'thread/goal/updated': {
        if (typeof p.threadId === 'string') {
          this.emit({
            type: 'goal-updated',
            threadId: p.threadId,
            goal: (p.goal as Record<string, unknown> | null) ?? null,
          });
        }
        break;
      }
      case 'thread/archived':
      case 'thread/unarchived': {
        if (typeof p.threadId === 'string') {
          this.emit({ type: 'thread-archived-changed', threadId: p.threadId, archived: method === 'thread/archived' });
        }
        break;
      }
      default:
        // Dozens of informational notifications exist (token usage, plan
        // updates, hooks, ...); they are intentionally not surfaced.
        break;
    }
  }

  // -- process exit ----------------------------------------------------------------

  private handleProcessExit(err: Error | null, code: number | null = null, signal: string | null = null): void {
    const reason = err ?? (code !== null || signal !== null
      ? new Error(`codex app-server exited (code=${code}, signal=${signal})`)
      : new Error('codex app-server closed'));
    for (const [, pending] of this.pendingClient) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pendingClient.clear();
    this.pendingServer.clear();
    for (const q of this.turnQueues.values()) q.fail(reason);
    this.turnQueues.clear();
    this.pendingTurnEvents.clear();
    // 进程死了,内存里的激活 thread 一并失效;下次 connect 后需重新 resume。
    this.liveThreads.clear();
    this.seenTurnStarts.clear();
    // 未落盘线程随进程蒸发,保护记录一并清掉(它们已不可恢复)。
    this.unpersistedThreads.clear();
    // config/read 的模型缓存属于旧进程语境,重连后必须重读。
    this.configModelCache = null;
    if (this.readyPromise) {
      this.readyPromise = null;
      this.emit({ type: 'disconnected', code, signal });
    }
  }

  // -- idle recycle --------------------------------------------------------------
  // thread/resume 会拿下 codex 的单写者锁,只有进程退出才释放(codex 0.147 无
  // unload/release RPC)。不回收的话,web 端看一眼会话,CLI 的 codex resume 就被
  // 锁到网关重启。回收走既有 'exit' → handleProcessExit 路径;重连由下次请求的
  // connect()/ensureLive 惰性完成(进程退出重连已有测试覆盖)。

  private scheduleRecycleWhenIdle(): void {
    const grace = this.opts.recycleGraceMs;
    if (grace <= 0 || this.closed || !this.child) return;
    if (this.recycleTimer) clearTimeout(this.recycleTimer);
    this.recycleTimer = setTimeout(() => {
      this.recycleTimer = null;
      this.recycleIfIdle();
    }, grace);
    this.recycleTimer.unref?.();
  }

  /** turn 静默超过该时长就主动探活(实测慢上游 TTFT 71s,阈值须远大于它)。 */
  private static readonly TURN_STALL_MS = 5 * 60_000;
  /** 看门狗 thread/read 探测的预算(901MB 大会话正常 ~9s,wedged 会挂死)。 */
  private static readonly STALL_PROBE_TIMEOUT_MS = 45_000;

  private lastTurnActivityAt = 0;
  private stallProbeInflight = false;

  private recycleIfIdle(): void {
    if (this.closed || !this.child || this.child.exitCode !== null) return;
    // pendingServer(parked 审批/提问)也算 busy:审批是 turn 中段的反向请求,
    // 用户在斟酌的 60s 里进程被回收,审批会静默蒸发。
    const busy =
      this.pendingClient.size > 0 ||
      this.pendingServer.size > 0 ||
      this.turnQueues.size > 0 ||
      this.pendingTurnEvents.size > 0;
    if (busy) {
      // turn 流长期静默:可能 app-server  wedge(实测:rollout 已写
      // task_complete,但 turn/completed 始终不上线,写者锁被一直占着,
      // CLI resume 被拒)。探活区分"慢但活着"与"卡死"。
      if (this.turnQueues.size > 0 && Date.now() - this.lastTurnActivityAt > CodexAdapter.TURN_STALL_MS) {
        void this.probeStalledTurn().catch((err) => {
          this.emit({ type: 'log', line: `stall probe failed: ${err}` });
        });
      }
      // 有在途请求/活跃 turn 流,过个 grace 再看(不 cancel 只 re-check)。
      this.scheduleRecycleWhenIdle();
      return;
    }
    void this.guardUnpersistedThenKill().catch((err) => {
      this.emit({ type: 'log', line: `recycle guard failed: ${err}` });
    });
  }

  /**
   * 卡死 turn 探活:用短预算 thread/read 问 app-server 该 turn 的真实状态。
   * - 服务端已终态但通知没到 → 补发 turn-completed(走正常通知路径收口,
   *   前端拿到终帧,busy 清除,下个 grace 可回收)。
   * - 读不动/超时 → 判定 wedge,杀进程(handleProcessExit 会让队列以
   *   disconnected 失败收尾,是响亮错误而非静默挂起,同时释放写者锁)。
   * - 仍在跑 → 更新活动时间,下个周期再看。
   */
  private async probeStalledTurn(): Promise<void> {
    if (this.stallProbeInflight) return;
    this.stallProbeInflight = true;
    try {
      const key = this.turnQueues.keys().next().value;
      if (!key) return;
      const sep = key.indexOf(':');
      const threadId = key.slice(0, sep);
      const turnId = key.slice(sep + 1);
      const raw = await this.request(
        'thread/read',
        { threadId, includeTurns: true },
        CodexAdapter.STALL_PROBE_TIMEOUT_MS,
      ).catch(() => null);
      if (raw === null) {
        // 探测本身失败:进程 wedge 或已死。死进程由 exit 路径收尾;活着才杀。
        if (this.child && this.child.exitCode === null) {
          this.emit({ type: 'log', line: `turn ${turnId} stalled and probe unreadable; killing wedged app-server` });
          this.terminateChild();
        }
        return;
      }
      const turn = (ThreadReadResponseSchema.parse(raw).thread.turns ?? []).find((t) => t.id === turnId);
      if (turn && turn.status !== 'inProgress') {
        this.emit({ type: 'log', line: `turn ${turnId} terminal on server (${turn.status}) but notification never arrived; synthesizing turn-completed` });
        this.handleNotification('turn/completed', { threadId, turn });
      } else {
        // 服务端确认还在跑:不是 wedge,是慢。重置活动时间,避免误杀。
        this.lastTurnActivityAt = Date.now();
      }
    } finally {
      this.stallProbeInflight = false;
    }
  }

  /** 未落盘线程保护 + 杀进程;文件检查是异步的,单独拆出来。 */
  private async guardUnpersistedThenKill(): Promise<void> {
    const now = Date.now();
    for (const [id, createdAt] of this.unpersistedThreads) {
      if (now - createdAt > CodexAdapter.UNPERSISTED_PROTECT_MS) {
        this.unpersistedThreads.delete(id); // 废弃草稿,放弃保护
      } else if (await findCodexRollout(id)) {
        this.unpersistedThreads.delete(id); // 首个 turn 已落盘
      }
    }
    if (this.closed || !this.child || this.child.exitCode !== null) return;
    // await 窗口内可能来了新请求:杀之前按与 recycleIfIdle 相同的口径重检,
    // 否则在飞请求会被无谓杀掉(虽能 reject 兜底,但用户看到的是偶发失败)。
    const busy =
      this.pendingClient.size > 0 ||
      this.pendingServer.size > 0 ||
      this.turnQueues.size > 0 ||
      this.pendingTurnEvents.size > 0;
    if (busy) {
      this.scheduleRecycleWhenIdle();
      return;
    }
    if (this.unpersistedThreads.size > 0) {
      // 有新建未落盘的线程,回收会让它蒸发;顺延。
      this.scheduleRecycleWhenIdle();
      return;
    }
    this.emit({ type: 'log', line: `codex app-server idle ${this.opts.recycleGraceMs}ms, recycling to release writer lock` });
    this.terminateChild();
  }

  /** 杀 app-server:SIGTERM,3s 不退升级 SIGKILL(close 的同款兜底,回收/wedge 共用)。 */
  private terminateChild(): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 3_000).unref?.();
  }

  // -- public API: threads & turns -------------------------------------------------

  /** List known threads (thread/list). */
  async list(options: ThreadListOptions = {}): Promise<{
    threads: CodexThread[];
    nextCursor: string | null;
    backwardsCursor: string | null;
  }> {
    await this.connect();
    const raw = await this.request('thread/list', {
      cursor: options.cursor ?? null,
      limit: options.limit ?? null,
      cwd: options.cwd ?? null,
      archived: options.archived ?? null,
      searchTerm: options.searchTerm ?? null,
      sourceKinds: options.sourceKinds ?? null,
    });
    const parsed = ThreadListResponseSchema.parse(raw);
    return {
      threads: parsed.data,
      nextCursor: parsed.nextCursor ?? null,
      backwardsCursor: parsed.backwardsCursor ?? null,
    };
  }

  /** Create a new thread (thread/start). Returns the Thread object. */
  async create(options: ThreadStartOptions = {}): Promise<CodexThread> {
    await this.connect();
    const raw = await this.request('thread/start', {
      cwd: options.cwd ?? null,
      model: options.model ?? null,
      approvalPolicy: options.approvalPolicy ?? null,
      sandbox: options.sandbox ?? null,
      serviceName: options.serviceName ?? null,
      baseInstructions: options.baseInstructions ?? null,
      developerInstructions: options.developerInstructions ?? null,
      config: options.config ?? null,
      ephemeral: options.ephemeral ?? null,
    });
    const thread = ThreadStartResponseSchema.parse(raw).thread;
    this.liveThreads.add(thread.id);
    this.unpersistedThreads.set(thread.id, Date.now());
    if (options.model) this.threadModels.set(thread.id, options.model);
    return thread;
  }

  /** Resume an existing thread (thread/resume) so turns can be sent to it. */
  async resume(threadId: string, options: ThreadStartOptions = {}): Promise<CodexThread> {
    await this.connect();
    let raw: unknown;
    try {
      raw = await this.request('thread/resume', {
        threadId,
        cwd: options.cwd ?? null,
        model: options.model ?? null,
        approvalPolicy: options.approvalPolicy ?? null,
        sandbox: options.sandbox ?? null,
        baseInstructions: options.baseInstructions ?? null,
        developerInstructions: options.developerInstructions ?? null,
        config: options.config ?? null,
      });
    } catch (err) {
      // codex 单写者语义:另一个客户端(常见是 codex CLI resume 了同一
      // thread)持有写入者时,app-server 报 -32600 already has an active
      // writer。对齐 kap-server 的 busy 模型(409 + busy 子码):这是"会话
      // 正忙"而非服务器故障,前端可按 busy 形态展示并提示稍后再试。
      if (err instanceof Error && /already has an active writer/i.test(err.message)) {
        throw new ProviderError(
          'busy',
          '会话正忙：该 codex 会话被另一个客户端占用(codex 同一时间只允许一个写入者,通常是 codex CLI 里 resume 了同一会话)。请先退出占用方,或稍后再试。',
          409,
        );
      }
      throw err;
    }
    const thread = ThreadResumeResponseSchema.parse(raw).thread;
    this.liveThreads.add(threadId);
    if (options.model) this.threadModels.set(threadId, options.model);
    return thread;
  }

  /**
   * 确保 thread 在本进程是激活的;未激活先 thread/resume。turn 级 RPC
   * (turn/start、turn/steer、compact、rollback、review)都打它。
   */
  private async ensureLive(threadId: string): Promise<void> {
    if (this.liveThreads.has(threadId)) return;
    await this.resume(threadId);
  }

  /** "thread not found" 重试兜底:标记失效 → resume → 重放一次调用。 */
  private async withThreadRetry<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    await this.ensureLive(threadId);
    try {
      return await fn();
    } catch (err) {
      // codex 线程级串行:上一个操作(rollback/turn/compact)没做完时,-32600
      // "X already in progress"。对齐 kap-server 的 busy 模型(409+子码),
      // 别当 500 服务器故障抛给前端。
      if (err instanceof Error && /already in progress/i.test(err.message)) {
        throw new ProviderError(
          'busy',
          '会话正忙：该 codex 会话上有操作仍在执行(codex 同一线程的操作是串行的,常见是上一次撤销/压缩还没完成)。请等它完成后再试。',
          409,
        );
      }
      if (!(err instanceof Error) || !/thread not found/i.test(err.message)) throw err;
      this.liveThreads.delete(threadId);
      await this.ensureLive(threadId);
      return fn();
    }
  }

  /** Read a thread with full turn history (thread/read includeTurns:true). */
  async getHistory(threadId: string): Promise<CodexTurn[]> {
    await this.connect();
    const raw = await this.request('thread/read', { threadId, includeTurns: true });
    const thread = ThreadReadResponseSchema.parse(raw).thread;
    return thread.turns ?? [];
  }

  /**
   * Start a turn (turn/start) with text input. Returns the turnId plus an
   * async-iterable event stream scoped to this turn; the stream terminates
   * after the 'turn-completed' event.
   */
  async startTurn(
    threadId: string,
    input: string | Array<Record<string, unknown>>,
    options: TurnStartOptions = {},
  ): Promise<CodexTurnHandle> {
    await this.connect();
    const items =
      typeof input === 'string' ? [{ type: 'text', text: input, text_elements: [] }] : input;
    const turn = await this.withThreadRetry(threadId, async () => {
      const raw = await this.request('turn/start', {
        threadId,
        input: items,
        model: options.model ?? null,
        effort: options.effort ?? null,
        cwd: options.cwd ?? null,
        approvalPolicy: options.approvalPolicy ?? null,
        sandboxPolicy: options.sandboxPolicy ?? null,
        clientUserMessageId: options.clientUserMessageId ?? null,
      });
      return TurnStartResponseSchema.parse(raw).turn;
    });
    const key = `${threadId}:${turn.id}`;
    const queue = new TurnEventQueue();
    this.turnQueues.set(key, queue);
    this.seenTurnStarts.add(key);
    // 合成的 turn-started 必须先进 queue:缓冲 drain 的事件才能按真实到达序跟在后面。
    const started: CodexEvent = { type: 'turn-started', threadId, turnId: turn.id, turn };
    queue.push(started);
    this.notifyListeners(started);
    this.lastTurnActivityAt = Date.now();
    // 注册前到达的同 chunk 事件(含可能的 turn/completed)按序补进 queue。
    const pending = this.pendingTurnEvents.get(key);
    if (pending) {
      this.pendingTurnEvents.delete(key);
      for (const ev of pending) {
        if (ev.type === 'turn-started') continue; // 服务器通知与合成事件重复
        queue.push(ev);
        if (ev.type === 'turn-completed') {
          this.seenTurnStarts.delete(key);
          queue.close();
          this.turnQueues.delete(key);
        }
      }
    }
    return { threadId, turnId: turn.id, events: queue };
  }

  /** List available models (model/list). 返回原始行(字段为 camelCase)。 */
  async listModels(): Promise<Array<Record<string, unknown>>> {
    await this.connect();
    const raw = await this.request('model/list', {});
    const data = (raw as { data?: unknown }).data;
    return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  }

  /** Interrupt a running turn (turn/interrupt). */
  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.connect();
    await this.request('turn/interrupt', { threadId, turnId });
  }

  // -- 扩展 RPC(0.147.0 schema + 实测验证) ------------------------------------

  /**
   * 插话(turn/steer):向进行中的 turn 注入一条用户消息。
   * expectedTurnId 是前置条件,不匹配时服务端报错。
   */
  async steerTurn(threadId: string, turnId: string, text: string): Promise<void> {
    await this.connect();
    await this.withThreadRetry(threadId, () =>
      this.request('turn/steer', {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: 'text', text, text_elements: [] }],
      }),
    );
  }

  /** 压缩会话(thread/compact/start);空会话同样成功(幂等)。 */
  async compact(threadId: string): Promise<void> {
    await this.connect();
    await this.withThreadRetry(threadId, () => this.request('thread/compact/start', { threadId }));
    // thread/compact/start 立即返回 {};真完成信号是 item/completed 且
    // item.type==='contextCompaction'(0.147.0 schema 复核)。等到再返回,
    // 网关才能把 compaction.completed 广播在真实完成点。超时兜底不卡死。
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(onEvent);
        resolve();
      }, 180_000);
      timer.unref?.();
      const onEvent: CodexEventHandler = (ev) => {
        // 进程死亡:compaction 的完成事件永不到达。假报成功会让用户以为
        // 上下文已压缩,实际没有——必须响亮失败(审查实测)。
        if (ev.type === 'disconnected') {
          clearTimeout(timer);
          this.listeners.delete(onEvent);
          reject(new Error('codex app-server disconnected during thread compact'));
          return;
        }
        if (ev.type !== 'item-completed') return;
        const e = ev as { threadId?: string; item?: Record<string, unknown> };
        if (e.threadId !== threadId || e.item?.type !== 'contextCompaction') return;
        clearTimeout(timer);
        this.listeners.delete(onEvent);
        resolve();
      };
      this.listeners.add(onEvent);
    });
  }

  /** 归档/取消归档(thread/archive|unarchive)。 */
  async setArchived(threadId: string, archived: boolean): Promise<void> {
    await this.connect();
    await this.request(archived ? 'thread/archive' : 'thread/unarchive', { threadId });
  }

  /** 删除线程(thread/delete)——真删,不可恢复。 */
  async deleteThread(threadId: string): Promise<void> {
    await this.connect();
    await this.request('thread/delete', { threadId });
  }

  /** 持久改名(thread/name/set;schema 里的 thread/setName 已实测不存在)。 */
  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.connect();
    await this.request('thread/name/set', { threadId, name });
  }

  /** 分叉线程(thread/fork),返回新 thread。 */
  async forkThread(threadId: string): Promise<Record<string, unknown>> {
    await this.connect();
    const raw = await this.request('thread/fork', { threadId });
    return (raw as { thread?: Record<string, unknown> }).thread ?? (raw as Record<string, unknown>);
  }

  /** 回滚最后 numTurns 轮(thread/rollback;已标记 DEPRECATED 但 0.147.0 可用)。 */
  async rollback(threadId: string, numTurns = 1): Promise<void> {
    await this.connect();
    await this.withThreadRetry(threadId, () => this.request('thread/rollback', { threadId, numTurns }));
  }

  /** 目标(thread/goal/set);objective/status 传 null 表示不改动该字段。 */
  async goalSet(threadId: string, objective?: string | null, status?: string | null): Promise<Record<string, unknown> | null> {
    await this.connect();
    const raw = await this.request('thread/goal/set', { threadId, objective: objective ?? null, status: status ?? null });
    return ((raw as { goal?: Record<string, unknown> | null }).goal ?? null) as Record<string, unknown> | null;
  }

  /** 目标回读(thread/goal/get),无目标返回 null。 */
  async goalGet(threadId: string): Promise<Record<string, unknown> | null> {
    await this.connect();
    const raw = await this.request('thread/goal/get', { threadId });
    return ((raw as { goal?: Record<string, unknown> | null }).goal ?? null) as Record<string, unknown> | null;
  }

  /** 目标控制(thread/goal/set 的 status 通路:paused/active/complete)。 */
  async goalClear(threadId: string): Promise<void> {
    await this.connect();
    await this.request('thread/goal/clear', { threadId });
  }

  /** 原生 skills 目录(skills/list):{name,description,path,scope,enabled}[],过滤 disabled。 */
  async listSkills(): Promise<Array<{ name: string; description: string; path: string; scope: string; enabled: boolean }>> {
    await this.connect();
    const raw = await this.request('skills/list', {});
    const groups = (raw as { data?: unknown }).data;
    const out: Array<{ name: string; description: string; path: string; scope: string; enabled: boolean }> = [];
    if (!Array.isArray(groups)) return out;
    for (const g of groups as Record<string, unknown>[]) {
      for (const s of (g.skills as Record<string, unknown>[]) ?? []) {
        if (s.enabled === false) continue;
        if (typeof s.name !== 'string' || typeof s.path !== 'string') continue;
        out.push({
          name: s.name,
          description: typeof s.description === 'string' ? s.description : s.name,
          path: s.path,
          scope: typeof s.scope === 'string' ? s.scope : 'user',
          enabled: s.enabled !== false,
        });
      }
    }
    return out;
  }

  /** MCP 服务器状态(mcpServerStatus/list)。 */
  async mcpStatus(): Promise<Array<Record<string, unknown>>> {
    await this.connect();
    const raw = await this.request('mcpServerStatus/list', {});
    const data = (raw as { data?: unknown }).data;
    return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  }

  /** 后台终端(thread/backgroundTerminals/list)。 */
  async backgroundTerminals(threadId: string): Promise<Array<Record<string, unknown>>> {
    await this.connect();
    const raw = await this.request('thread/backgroundTerminals/list', { threadId, cursor: null, limit: null });
    const data = (raw as { data?: unknown }).data;
    return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  }

  /**
   * 会话级 plan 模式(thread/settings/update 的 collaborationMode,0.147.0
   * 实测需 experimentalApi——本网关 initialize 已开)。plan 模式下模型只出
   * 计划(plan ThreadItem),不直接执行。
   */
  /** 线程有效模型:显式设置过的优先,否则读 config/read 的全局默认(缓存)。 */
  private async effectiveModel(threadId: string): Promise<string> {
    const explicit = this.threadModels.get(threadId);
    if (explicit) return explicit;
    if (!this.configModelCache) {
      const raw = (await this.request('config/read', {})) as { config?: { model?: unknown } };
      const m = raw?.config?.model;
      if (typeof m !== 'string' || !m) throw new Error('config/read 未返回 model');
      this.configModelCache = m;
    }
    return this.configModelCache;
  }

  async setCollaborationMode(threadId: string, mode: 'plan' | 'default'): Promise<void> {
    await this.connect();
    // 0.147.0 实测:必填的是 collaborationMode.settings.model(非空字符串,
    // null/缺省都报 missing field `model`);给当前有效模型 = 不换模型只切模式。
    const model = await this.effectiveModel(threadId);
    await this.withThreadRetry(threadId, () =>
      this.request('thread/settings/update', {
        threadId,
        collaborationMode: { mode, settings: { model, reasoningEffort: null, developerInstructions: null } },
      }),
    );
  }

  /**
   * 发起一次 inline review(review/start,target=未提交改动)。
   * 响应本身不含 turnId。实测(0.147.0):review 的 turn/started 通知到的
   * turnId(记 A)与实际干活的 item/error 事件携带的 turnId(记 B)不一致,
   * B 从不被 turn/started 宣告——按 turnId 精确路由会一个事件都收不到,
   * 队列永不关闭、busy 永久卡死。因此 review 的事件流按 THREAD 收集:
   * review/start 成功后该线程的所有事件都进队列,该线程第一个
   * turn/completed(任意 turnId)到来时关流。30s 没等到任何 turn 算失败。
   */
  async reviewTurn(threadId: string): Promise<CodexTurnHandle> {
    await this.connect();
    const queue = new TurnEventQueue();
    let off: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let firstTurnId = '';
    const turnStarted = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => {
        off();
        reject(new Error('review turn did not start within 30s'));
      }, 30_000);
      timer.unref?.();
      off = this.onEvent((ev) => {
        // 进程死亡(handleProcessExit 广播):turn-started 前后都必须收口——
        // review 的 queue 不在 turnQueues 里,不收口则监听器/队列永久泄漏,
        // 消费方永久挂起(审查实测)。
        if (ev.type === 'disconnected') {
          clearTimeout(timer);
          off();
          this.pendingTurnEvents.delete(`${threadId}:${firstTurnId}`);
          const error = new Error('codex app-server disconnected during review turn');
          reject(error); // 已 resolve 时是 no-op
          queue.fail(error);
          return;
        }
        if (!('threadId' in ev) || ev.threadId !== threadId) return;
        if (ev.type === 'turn-started') {
          if (!firstTurnId) {
            firstTurnId = ev.turnId;
            clearTimeout(timer);
            resolve(ev.turnId);
          }
          queue.push(ev);
          return;
        }
        if (firstTurnId) queue.push(ev);
        if (ev.type === 'turn-completed') {
          off();
          this.pendingTurnEvents.delete(`${threadId}:${firstTurnId}`);
          queue.close();
        }
      });
    });
    // review/start 失败必须摘掉监听器并清掉 30s 计时器——否则定时器空转、
    // turnStarted 的 rejection 无人处理(审查发现)。
    try {
      await this.withThreadRetry(threadId, () =>
        this.request('review/start', { threadId, target: { type: 'uncommittedChanges' }, delivery: 'inline' }),
      );
    } catch (err) {
      clearTimeout(timer);
      off();
      turnStarted.catch(() => undefined);
      throw err;
    }
    const turnId = await turnStarted;
    return { threadId, turnId, events: queue };
  }
}

export default CodexAdapter;
