/**
 * DSH (DeepSeek Harness) ACP client — runs `dsh --profile acp` over JSON-RPC 2.0 stdio.
 *
 * Implements Agent Client Protocol (ACP) v1.4.0:
 * - Handshake: initialize (protocolVersion: 1)
 * - Session lifecycle: session/new, session/resume, session/prompt, session/cancel
 * - Server notifications: session/update (agent_thought_chunk, agent_message_chunk, tool_call, tool_call_update)
 * - Server requests: session/request_permission -> approve / reject
 * - Idle process auto-recycle after 60s
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

export type JsonRpcId = string | number;

export interface DshAcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface DshAcpModelInfo {
  modelId: string;
  name?: string;
  description?: string;
}

export type DshAcpEvent =
  | { type: 'message_chunk'; sessionId: string; text: string; messageId?: string }
  | { type: 'thought_chunk'; sessionId: string; text: string; messageId?: string }
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
      options: DshAcpPermissionOption[];
    }
  | { type: 'usage'; sessionId: string; usage: Record<string, unknown> }
  | { type: 'disconnected'; code: number | null; signal: string | null }
  | { type: 'error'; message: string; sessionId?: string };

export type DshAcpEventHandler = (event: DshAcpEvent) => void;

export interface DshAcpOptions {
  dshBin: string;
  env?: Record<string, string>;
  alwaysApprove?: boolean;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  recycleGraceMs?: number;
  onStderr?: (line: string) => void;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export interface PendingDshPermission {
  id: JsonRpcId;
  sessionId: string;
  options: DshAcpPermissionOption[];
  toolCall?: Record<string, unknown>;
}

export class DshAcpClient {
  private readonly dshBin: string;
  private readonly env: Record<string, string>;
  private readonly alwaysApprove: boolean;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly recycleGraceMs: number;
  private readonly onStderr?: (line: string) => void;

  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private readonly permissions = new Map<string, PendingDshPermission>();
  private readonly listeners = new Set<DshAcpEventHandler>();
  private readyPromise: Promise<void> | null = null;
  /** True only while spawnAndHandshake() runs — lets request() skip ensureReady(). */
  private handshaking = false;
  private connected = false;
  private closed = false;
  private activeTurns = 0;
  private recycleTimer: NodeJS.Timeout | null = null;

  constructor(options: DshAcpOptions) {
    this.dshBin = options.dshBin;
    this.env = options.env ?? {};
    this.alwaysApprove = Boolean(options.alwaysApprove);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 25_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 0;
    this.recycleGraceMs = options.recycleGraceMs ?? 60_000;
    this.onStderr = options.onStderr;
  }

  on(listener: DshAcpEventHandler): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: DshAcpEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[dsh-acp] listener error:', err);
      }
    }
  }

  isConnected(): boolean {
    return this.connected && Boolean(this.child && !this.child.killed);
  }

  isBusy(): boolean {
    return this.activeTurns > 0 || this.permissions.size > 0;
  }

  async ensureReady(): Promise<void> {
    if (this.closed) throw new Error('DshAcpClient is closed');
    if (this.isConnected()) {
      this.cancelRecycleTimer();
      return;
    }
    if (this.readyPromise) return this.readyPromise;

    this.handshaking = true;
    this.readyPromise = this.spawnAndHandshake().finally(() => {
      this.handshaking = false;
      this.readyPromise = null;
    });
    return this.readyPromise;
  }

  private async spawnAndHandshake(): Promise<void> {
    this.cancelRecycleTimer();
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...this.env,
    };

    const child = spawn(this.dshBin, ['--profile', 'acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.child = child;
    this.connected = false;

    const rl = readline.createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });
    this.rl = rl;

    rl.on('line', (line) => this.handleStdoutLine(line));

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (this.onStderr) this.onStderr(line);
      }
    });

    child.on('error', (err) => {
      this.emit({ type: 'error', message: `dsh process error: ${err.message}` });
      this.cleanupProcess(null, null);
    });

    child.on('close', (code, signal) => {
      this.cleanupProcess(code, signal);
    });

    try {
      await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          imagePrompt: false,
          fs: { readTextFile: false, writeTextFile: false },
        },
        clientInfo: { name: 'multi-agent-gateway', version: '0.1.0' },
      });
      this.connected = true;
    } catch (err) {
      this.cleanupProcess(null, null);
      throw err;
    }
  }

  private cleanupProcess(code: number | null, signal: string | null): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.child = null;
    if (this.rl) {
      try {
        this.rl.close();
      } catch {
        // ignore
      }
      this.rl = null;
    }

    for (const [id, req] of this.pending) {
      if (req.timer) clearTimeout(req.timer);
      req.reject(new Error(`dsh process disconnected before response (id=${id})`));
    }
    this.pending.clear();
    this.permissions.clear();

    if (wasConnected) {
      this.emit({ type: 'disconnected', code, signal });
    }
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (typeof message !== 'object' || message === null) return;

    // 1. Response to our pending request
    if (('result' in message || 'error' in message) && (typeof message.id === 'number' || typeof message.id === 'string')) {
      const req = this.pending.get(message.id);
      if (req) {
        this.pending.delete(message.id);
        if (req.timer) clearTimeout(req.timer);
        if (message.error) {
          req.reject(new Error(message.error.message || JSON.stringify(message.error)));
        } else {
          req.resolve(message.result);
        }
      }
      return;
    }

    // 2. Server request to client
    if (message.method && typeof message.id !== 'undefined') {
      this.handleServerRequest(message.id, message.method, message.params || {});
      return;
    }

    // 3. Server notification to client
    if (message.method) {
      this.handleServerNotification(message.method, message.params || {});
    }
  }

  private handleServerRequest(id: JsonRpcId, method: string, params: any): void {
    if (method === 'session/request_permission') {
      const sessionId = String(params.sessionId ?? '');
      const options: DshAcpPermissionOption[] = Array.isArray(params.options) ? params.options : [];
      const toolCall = params.toolCall;

      if (this.alwaysApprove) {
        this.respond(id, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
        return;
      }

      this.permissions.set(sessionId, { id, sessionId, options, toolCall });
      this.emit({
        type: 'permission_request',
        sessionId,
        requestId: id,
        toolCall,
        options,
      });
      return;
    }

    // Default unknown request reject
    this.sendJson({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  private handleServerNotification(method: string, params: any): void {
    if (method === 'session/update') {
      const sessionId = String(params.sessionId ?? '');
      const update = params.update;
      if (!update || typeof update !== 'object') return;

      const kind = update.sessionUpdate;
      if (kind === 'agent_message_chunk') {
        const text = typeof update.content?.text === 'string' ? update.content.text : '';
        if (text) {
          this.emit({
            type: 'message_chunk',
            sessionId,
            text,
            messageId: update.messageId,
          });
        }
      } else if (kind === 'agent_thought_chunk') {
        const text = typeof update.content?.text === 'string' ? update.content.text : '';
        if (text) {
          this.emit({
            type: 'thought_chunk',
            sessionId,
            text,
            messageId: update.messageId,
          });
        }
      } else if (kind === 'tool_call') {
        this.emit({
          type: 'tool_call',
          sessionId,
          toolCallId: String(update.toolCallId ?? ''),
          title: String(update.title ?? 'tool'),
          kind: update.kind,
          status: update.status ?? 'in_progress',
          rawInput: update.rawInput,
        });
      } else if (kind === 'tool_call_update') {
        this.emit({
          type: 'tool_call_update',
          sessionId,
          toolCallId: String(update.toolCallId ?? ''),
          title: update.title,
          status: update.status ?? 'completed',
          rawOutput: update.content,
        });
      }
    }
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    // Skip ensureReady() during handshake — spawnAndHandshake() itself calls
    // this method for `initialize`, and awaiting our own readyPromise would
    // self-deadlock (the exact bug that once hung the test runner).
    if (!this.handshaking) await this.ensureReady();
    const id = this.nextId++;
    const actualTimeout = timeoutMs !== undefined ? timeoutMs : this.requestTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      if (actualTimeout > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`dsh request timed out after ${actualTimeout}ms: ${method} (id=${id})`));
        }, actualTimeout);
      }

      this.pending.set(id, {
        method,
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
      });

      this.sendJson({ jsonrpc: '2.0', id, method, params });
    });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.sendJson({ jsonrpc: '2.0', id, result });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.sendJson({ jsonrpc: '2.0', method, params });
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error('Cannot write to dsh process: stdin not writable');
    }
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  async newSession(cwd: string): Promise<{ sessionId: string; configOptions?: unknown }> {
    return this.request<{ sessionId: string; configOptions?: unknown }>('session/new', {
      cwd,
      mcpServers: [],
    });
  }

  async resumeSession(sessionId: string, cwd: string): Promise<{ configOptions?: unknown }> {
    return this.request<{ configOptions?: unknown }>('session/resume', {
      sessionId,
      cwd,
      mcpServers: [],
    });
  }

  async prompt(sessionId: string, promptText: string): Promise<{ stopReason?: string }> {
    this.activeTurns++;
    this.cancelRecycleTimer();
    try {
      return await this.request<{ stopReason?: string }>(
        'session/prompt',
        {
          sessionId,
          prompt: [{ type: 'text', text: promptText }],
        },
        this.promptTimeoutMs
      );
    } finally {
      this.activeTurns = Math.max(0, this.activeTurns - 1);
      this.scheduleRecycleIfIdle();
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.notify('session/cancel', { sessionId });
  }

  resolvePermission(sessionId: string, approved: boolean): boolean {
    const pending = this.permissions.get(sessionId);
    if (!pending) return false;
    this.permissions.delete(sessionId);

    const optionId = approved ? 'allow-once' : 'reject-once';
    this.respond(pending.id, {
      outcome: { outcome: 'selected', optionId },
    });
    this.scheduleRecycleIfIdle();
    return true;
  }

  private scheduleRecycleIfIdle(): void {
    if (this.closed || this.recycleGraceMs <= 0) return;
    if (this.isBusy()) return;

    this.cancelRecycleTimer();
    this.recycleTimer = setTimeout(() => {
      if (!this.isBusy() && this.isConnected()) {
        this.closeProcess();
      }
    }, this.recycleGraceMs);
  }

  private cancelRecycleTimer(): void {
    if (this.recycleTimer) {
      clearTimeout(this.recycleTimer);
      this.recycleTimer = null;
    }
  }

  closeProcess(): void {
    this.cancelRecycleTimer();
    if (this.child) {
      try {
        this.child.stdin?.end();
      } catch {
        // ignore
      }
      try {
        this.child.kill();
      } catch {
        // ignore
      }
      this.child = null;
    }
    this.connected = false;
  }

  close(): void {
    this.closed = true;
    this.closeProcess();
  }
}
