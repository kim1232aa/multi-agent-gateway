/**
 * Grok ACP client — one long-lived `grok agent stdio` JSON-RPC process.
 *
 * Verified against xai-org/grok-build (newline JSON-RPC 2.0 on stdio):
 *   grok agent stdio [--always-approve]
 *
 * Handshake: initialize (protocolVersion "0.1") → initialized notification.
 * Sessions: session/new, session/load, session/prompt, session/cancel.
 * Extensions: x.ai/compact_conversation, x.ai/session/fork, x.ai/rewind.
 * Agent→client request: session/request_permission (parked until resolved).
 *
 * Recycle on crash. Multiple sessions share the process. `--always-approve`
 * is only passed when the caller asks for yolo/bypassPermissions.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as readline from 'node:readline';

export type JsonRpcId = string | number;

export interface GrokAcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export type GrokAcpEvent =
  | { type: 'message_chunk'; sessionId: string; text: string }
  | { type: 'thought_chunk'; sessionId: string; text: string }
  | {
      type: 'tool_call';
      sessionId: string;
      toolCallId: string;
      title: string;
      kind?: string;
      status?: string;
      rawInput?: unknown;
    }
  | {
      type: 'tool_call_update';
      sessionId: string;
      toolCallId: string;
      title?: string;
      status?: string;
      rawOutput?: unknown;
    }
  | {
      type: 'permission_request';
      sessionId: string;
      requestId: JsonRpcId;
      toolCall?: Record<string, unknown>;
      options: GrokAcpPermissionOption[];
    }
  | { type: 'usage'; sessionId: string; usage: Record<string, unknown> }
  | { type: 'available_commands'; sessionId: string; commands: unknown[] }
  | { type: 'disconnected'; code: number | null; signal: string | null }
  | { type: 'error'; message: string; sessionId?: string };

export type GrokAcpEventHandler = (event: GrokAcpEvent) => void;

export interface GrokAcpOptions {
  grokBin: string;
  env?: Record<string, string>;
  /** Pass `--always-approve` (yolo / bypassPermissions only). */
  alwaysApprove?: boolean;
  /** Timeout for initialize / session/new / load. Default 15_000. */
  requestTimeoutMs?: number;
  /** Timeout for session/prompt. 0 = none. Default 0. */
  promptTimeoutMs?: number;
  onStderr?: (line: string) => void;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export interface PendingPermission {
  id: JsonRpcId;
  sessionId: string;
  options: GrokAcpPermissionOption[];
  toolCall?: Record<string, unknown>;
}

const INIT_PARAMS = {
  // Grok 1.0.13 replies with numeric protocolVersion 1 and still accepts "0.1".
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  clientInfo: { name: 'multi-agent-gateway', version: '0.1.0' },
  _meta: { clientIdentifier: 'multi-agent-gateway' },
};

export class GrokAcpClient {
  private readonly grokBin: string;
  private readonly env: Record<string, string>;
  private readonly alwaysApprove: boolean;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly onStderr?: (line: string) => void;

  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly listeners = new Set<GrokAcpEventHandler>();
  private readyPromise: Promise<void> | null = null;
  private connected = false;
  private closed = false;

  constructor(options: GrokAcpOptions) {
    this.grokBin = options.grokBin;
    this.env = options.env ?? {};
    this.alwaysApprove = options.alwaysApprove === true;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 0;
    this.onStderr = options.onStderr;
  }

  get ready(): boolean {
    return this.connected && this.child != null && this.child.exitCode === null;
  }

  get alwaysApproveEnabled(): boolean {
    return this.alwaysApprove;
  }

  onEvent(handler: GrokAcpEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  getPendingPermission(approvalId: string): PendingPermission | undefined {
    return this.permissions.get(approvalId);
  }

  /** Spawn `grok agent stdio` and run the initialize handshake. Idempotent. */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('GrokAcpClient is closed'));
    if (this.ready) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.doConnect().catch((err) => {
      this.readyPromise = null;
      this.connected = false;
      throw err;
    });
    return this.readyPromise;
  }

  async sessionNew(params: {
    cwd: string;
    mcpServers?: unknown[];
    sessionId?: string;
    yoloMode?: boolean;
    planMode?: boolean;
    model?: string;
    effort?: string;
  }): Promise<{ sessionId: string }> {
    await this.connect();
    const meta: Record<string, unknown> = {};
    if (params.yoloMode) meta.yoloMode = true;
    if (params.planMode) meta.planMode = true;
    if (params.model) meta.model = params.model;
    if (params.effort) meta.effort = params.effort;
    const result = await this.request('session/new', {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    });
    const rec = (result ?? {}) as Record<string, unknown>;
    const sessionId = pickSessionId(rec) ?? params.sessionId;
    if (!sessionId) throw new Error('ACP session/new did not return sessionId');
    return { sessionId };
  }

  async sessionLoad(params: { sessionId: string; cwd: string; mcpServers?: unknown[] }): Promise<void> {
    await this.connect();
    await this.request('session/load', {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    });
  }

  async sessionPrompt(params: {
    sessionId: string;
    prompt: Array<Record<string, unknown>>;
  }): Promise<{ stopReason?: string }> {
    await this.connect();
    const result = await this.request(
      'session/prompt',
      { sessionId: params.sessionId, prompt: params.prompt },
      this.promptTimeoutMs,
    );
    const rec = (result ?? {}) as Record<string, unknown>;
    const stopReason = typeof rec.stopReason === 'string' ? rec.stopReason : undefined;
    return { stopReason };
  }

  async sessionCancel(sessionId: string): Promise<void> {
    if (!this.ready) return;
    this.notify('session/cancel', { sessionId });
  }

  async compact(sessionId: string): Promise<void> {
    await this.connect();
    await this.request('x.ai/compact_conversation', { sessionId });
  }

  async fork(sessionId: string): Promise<{ sessionId: string }> {
    await this.connect();
    const result = await this.request('x.ai/session/fork', { sessionId });
    const rec = (result ?? {}) as Record<string, unknown>;
    const newId = pickSessionId(rec);
    if (!newId) throw new Error('ACP x.ai/session/fork did not return sessionId');
    return { sessionId: newId };
  }

  /**
   * Rewind `numTurns` user turns. Tries `x.ai/rewind` then `x.ai/rewind/to`.
   * Throws if both RPCs fail — callers must not fall back to `-p /rewind`.
   */
  async rewind(sessionId: string, numTurns: number): Promise<void> {
    await this.connect();
    try {
      await this.request('x.ai/rewind', { sessionId, numTurns });
      return;
    } catch (first) {
      try {
        await this.request('x.ai/rewind/to', { sessionId, numTurns });
      } catch {
        throw first instanceof Error ? first : new Error(String(first));
      }
    }
  }

  resolvePermission(requestId: JsonRpcId, optionId: string): void {
    const key = String(requestId);
    this.permissions.delete(key);
    this.respond(requestId, { outcome: { outcome: 'selected', optionId } });
  }

  cancelPermission(requestId: JsonRpcId): void {
    const key = String(requestId);
    this.permissions.delete(key);
    this.respond(requestId, { outcome: { outcome: 'cancelled' } });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.readyPromise = null;
    this.rl?.close();
    this.rl = null;
    const child = this.child;
    this.child = null;
    this.rejectAll(new Error('Grok ACP client closed'));
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          try {
            if (child.exitCode === null) child.kill('SIGKILL');
          } catch {
            // ignore
          }
          res();
        }, 3_000);
        t.unref?.();
        child.once('exit', () => {
          clearTimeout(t);
          res();
        });
      });
    }
  }

  private async doConnect(): Promise<void> {
    const args = ['agent', 'stdio'];
    if (this.alwaysApprove) args.push('--always-approve');
    const child = spawn(this.grokBin, args, {
      cwd: os.homedir(),
      env: this.childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.on('error', (err) => this.handleExit(err));
    child.on('exit', (code, signal) => this.handleExit(null, code, signal));
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.onStderr?.(line);
      }
    });
    this.rl = readline.createInterface({ input: child.stdout! });
    this.rl.on('line', (line) => this.handleLine(line));

    try {
      await this.request('initialize', INIT_PARAMS, this.requestTimeoutMs);
      this.notify('initialized', {});
      this.connected = true;
    } catch (err) {
      this.connected = false;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.child = null;
      this.rl?.close();
      this.rl = null;
      throw err;
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const id = msg.id as JsonRpcId | undefined;
    const method = msg.method as string | undefined;

    if (id !== undefined && method !== undefined) {
      this.handleServerRequest(id, method, msg.params);
    } else if (id !== undefined) {
      this.handleResponse(id, msg);
    } else if (method !== undefined) {
      this.handleNotification(method, msg.params);
    }
  }

  private handleResponse(id: JsonRpcId, msg: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    const err = msg.error as { code?: number; message?: string } | undefined;
    if (err) {
      pending.reject(new Error(`ACP '${pending.method}' failed (${err.code ?? '?'}): ${err.message ?? 'unknown error'}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (method === 'session/request_permission') {
      const p = (params ?? {}) as Record<string, unknown>;
      const sessionId = String(p.sessionId ?? '');
      const options = normalizePermissionOptions(p.options);
      const toolCall = isRecord(p.toolCall) ? p.toolCall : undefined;
      const parked: PendingPermission = { id, sessionId, options, toolCall };
      this.permissions.set(String(id), parked);
      this.emit({
        type: 'permission_request',
        sessionId,
        requestId: id,
        toolCall,
        options,
      });
      return;
    }
    this.respondError(id, -32601, `Method not found: ${method}`);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return;
    const p = (params ?? {}) as Record<string, unknown>;
    const sessionId = String(p.sessionId ?? '');
    const update = isRecord(p.update) ? p.update : p;
    const kind = String(update.sessionUpdate ?? '');
    switch (kind) {
      case 'agent_message_chunk': {
        const text = textOfContent(update.content);
        if (text) this.emit({ type: 'message_chunk', sessionId, text });
        break;
      }
      case 'agent_thought_chunk': {
        const text = textOfContent(update.content);
        if (text) this.emit({ type: 'thought_chunk', sessionId, text });
        break;
      }
      case 'tool_call': {
        this.emit({
          type: 'tool_call',
          sessionId,
          toolCallId: String(update.toolCallId ?? ''),
          title: String(update.title ?? update.kind ?? 'tool'),
          kind: typeof update.kind === 'string' ? update.kind : undefined,
          status: typeof update.status === 'string' ? update.status : undefined,
          rawInput: update.rawInput,
        });
        break;
      }
      case 'tool_call_update': {
        this.emit({
          type: 'tool_call_update',
          sessionId,
          toolCallId: String(update.toolCallId ?? ''),
          title: typeof update.title === 'string' ? update.title : undefined,
          status: typeof update.status === 'string' ? update.status : undefined,
          rawOutput: update.rawOutput ?? update.content,
        });
        break;
      }
      case 'available_commands_update': {
        const commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
        this.emit({ type: 'available_commands', sessionId, commands });
        break;
      }
      case 'usage_update':
      case 'current_usage_update': {
        this.emit({ type: 'usage', sessionId, usage: update });
        break;
      }
      default: {
        if (looksLikeUsage(update)) {
          this.emit({ type: 'usage', sessionId, usage: update });
        }
        break;
      }
    }
  }

  private request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const budget = timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      if (budget > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP '${method}' timed out after ${budget}ms`));
        }, budget);
        timer.unref?.();
      }
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params: params ?? {} });
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private write(msg: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new Error('Grok ACP process is not running');
    stdin.write(JSON.stringify(msg) + '\n');
  }

  private emit(event: GrokAcpEvent): void {
    for (const handler of [...this.listeners]) {
      try {
        handler(event);
      } catch {
        // listener errors must not break dispatch
      }
    }
  }

  private handleExit(err: Error | null, code?: number | null, signal?: NodeJS.Signals | null): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.readyPromise = null;
    this.child = null;
    this.rl?.close();
    this.rl = null;
    const message = err
      ? `Grok ACP spawn failed: ${err.message}`
      : `Grok ACP exited (code=${code ?? null}, signal=${signal ?? null})`;
    this.rejectAll(new Error(message));
    for (const parked of this.permissions.values()) {
      // process gone — nothing to respond to
      this.permissions.delete(String(parked.id));
    }
    if (wasConnected || err) {
      this.emit({ type: 'disconnected', code: code ?? null, signal: signal ?? null });
    }
  }

  private rejectAll(err: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.env, PYTHONUNBUFFERED: '1' };
    const extra = ['127.0.0.1', 'localhost', '::1'];
    const current = String(env.NO_PROXY ?? env.no_proxy ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    env.NO_PROXY = [...new Set([...current, ...extra])].join(',');
    env.no_proxy = env.NO_PROXY;
    return env;
  }
}

export function pickPermissionOption(
  options: GrokAcpPermissionOption[],
  decision: 'approve' | 'approve_always' | 'reject',
): string | undefined {
  const hay = (o: GrokAcpPermissionOption): string =>
    `${o.kind ?? ''} ${o.name ?? ''} ${o.optionId ?? ''}`.toLowerCase();
  if (decision === 'approve_always') {
    return options.find((o) => /allow[_-]?always/.test(hay(o)))?.optionId
      ?? options.find((o) => hay(o).includes('allow'))?.optionId;
  }
  if (decision === 'approve') {
    return options.find((o) => /allow[_-]?once/.test(hay(o)))?.optionId
      ?? options.find((o) => hay(o).includes('allow'))?.optionId;
  }
  return options.find((o) => hay(o).includes('reject'))?.optionId;
}

function pickSessionId(rec: Record<string, unknown>): string | undefined {
  for (const key of ['sessionId', 'session_id', 'id']) {
    const value = rec[key];
    if (typeof value === 'string' && value) return value;
  }
  if (isRecord(rec.session)) return pickSessionId(rec.session);
  return undefined;
}

function normalizePermissionOptions(raw: unknown): GrokAcpPermissionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: GrokAcpPermissionOption[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const optionId = String(item.optionId ?? item.id ?? '');
    if (!optionId) continue;
    out.push({
      optionId,
      name: typeof item.name === 'string' ? item.name : undefined,
      kind: typeof item.kind === 'string' ? item.kind : undefined,
    });
  }
  return out;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  if (Array.isArray(content)) {
    return content.map((c) => textOfContent(c)).join('');
  }
  return '';
}

function looksLikeUsage(update: Record<string, unknown>): boolean {
  return 'used' in update
    || 'input_tokens' in update
    || 'inputTokens' in update
    || 'total_cost_usd' in update;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
