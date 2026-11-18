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
import { composeDshProviderPatch } from './dsh-patch.js';
import type { CliProviders } from './provider-store.js';

function buildChildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GATEWAY_')) delete env[key];
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'];
  const current = String(env.NO_PROXY ?? env.no_proxy ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const merged = [...new Set([...current, ...loopback])].join(',');
  env.NO_PROXY = merged;
  env.no_proxy = merged;
  return env;
}

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
  permissionModeForSession?: (sessionId: string) => string | undefined;
  onStderr?: (line: string) => void;
  providers?: CliProviders;
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
  private readonly permissionModeForSession?: (sessionId: string) => string | undefined;
  private readonly onStderr?: (line: string) => void;
  private readonly providers?: CliProviders;
  private providerFingerprint?: string;
  private recycleRequested = false;
  private secrets: string[] = [];
  private readonly sessionConfigs = new Map<string, unknown>();

  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private readonly permissions = new Map<string, PendingDshPermission>();
  private readonly listeners = new Set<DshAcpEventHandler>();
  private readonly activeSessions = new Set<string>();
  private readyPromise: Promise<void> | null = null;
  private connected = false;
  private closed = false;
  private activeTurns = 0;
  private inFlightRequests = 0;
  private childGeneration = 0;
  private recycleTimer: NodeJS.Timeout | null = null;

  constructor(options: DshAcpOptions) {
    this.dshBin = options.dshBin;
    this.env = options.env ?? {};
    this.alwaysApprove = Boolean(options.alwaysApprove);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 25_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 0;
    this.recycleGraceMs = options.recycleGraceMs ?? 60_000;
    this.providers = options.providers;
    this.permissionModeForSession = options.permissionModeForSession;
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

  isClosed(): boolean {
    return this.closed;
  }

  isBusy(): boolean {
    return this.activeTurns > 0 || this.inFlightRequests > 0 || this.permissions.size > 0;
  }

  async ensureReady(): Promise<void> {
    if (this.closed) throw new Error('DshAcpClient is closed');
    if (this.child && this.providerFingerprint !== this.providers?.fingerprint()) this.recycleSoon();
    if (this.isConnected()) {
      this.cancelRecycleTimer();
      return;
    }
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = this.spawnAndHandshake().finally(() => {
      this.readyPromise = null;
    });
    return this.readyPromise;
  }

  private async spawnAndHandshake(): Promise<void> {
    this.cancelRecycleTimer();
    const generation = ++this.childGeneration;
    this.providerFingerprint = this.providers?.fingerprint();
    this.recycleRequested = false;
    const injected = this.providers?.injection() ?? { args: [], env: {} };
    const env = buildChildEnv({ ...this.env, ...injected.env });
    this.secrets = Object.entries(env).filter(([key, value]) => /^MAG_DSH_|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && value).map(([, value]) => value as string);
    const args = await this.providerPatchArgs(injected.args, env);
    if (generation !== this.childGeneration || this.closed) throw new Error('dsh client closed while preparing the provider patch');
    const child = spawn(this.dshBin, ['--profile', 'acp', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    this.child = child;
    this.connected = false;
    child.stdin?.on('error', () => {});

    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    this.rl = rl;
    rl.on('line', (line) => this.handleStdoutLine(line, child, generation));
    let stderrLine = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (generation !== this.childGeneration || child !== this.child) return;
      stderrLine += chunk.toString();
      const lines = stderrLine.split(/\r?\n/);
      stderrLine = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) this.onStderr?.(this.redact(line));
      if (stderrLine.length > 65536) stderrLine = '';
    });
    child.on('error', (err) => {
      if (generation !== this.childGeneration) return;
      this.emit({ type: 'error', message: `dsh process error: ${this.redact(err.message)}` });
      this.cleanupProcess(child, generation, null, null);
    });
    child.on('close', (code, signal) => this.cleanupProcess(child, generation, code, signal));

    try {
      await this.sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          imagePrompt: false,
          fs: { readTextFile: false, writeTextFile: false },
        },
        clientInfo: { name: 'multi-agent-gateway', version: '0.1.0' },
      }, undefined, child, generation);
      if (generation !== this.childGeneration || this.closed) throw new Error('dsh process disconnected during initialize');
      this.connected = true;
    } catch (err) {
      await this.terminateChild(child);
      this.cleanupProcess(child, generation, null, null);
      throw err;
    }
  }

  /**
   * A `--patch` replaces `llm-pi-ai`'s whole config, so the gateway providers are merged into the
   * user's own routes first (see dsh-patch.ts). If the user's config cannot be read, start DSH
   * without the gateway providers instead of replacing the user's.
   */
  private async providerPatchArgs(args: string[], env: NodeJS.ProcessEnv): Promise<string[]> {
    const at = args.indexOf('--patch');
    const file = at >= 0 ? args[at + 1] : undefined;
    if (!file) return args;
    try {
      const merged = await composeDshProviderPatch(this.dshBin, file, env);
      return [...args.slice(0, at), '--patch', merged, ...args.slice(at + 2)];
    } catch (err) {
      const reason = this.redact(err instanceof Error ? err.message : String(err));
      this.onStderr?.(`gateway providers skipped: cannot read the acp profile's llm-pi-ai config (${reason})`);
      console.warn(`[dsh-acp] gateway providers skipped: ${reason}`);
      return [...args.slice(0, at), ...args.slice(at + 2)];
    }
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    if (child.exitCode != null || child.signalCode != null) return;
    try { child.stdin?.end(); } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        finish();
      }, 250);
      timer.unref?.();
      child.once('close', finish);
      try { child.kill('SIGTERM'); } catch { finish(); }
    });
  }

  private cleanupProcess(child: ChildProcess, generation: number, code: number | null, signal: string | null): void {
    if (generation !== this.childGeneration || child !== this.child) return;
    const wasConnected = this.connected;
    this.connected = false;
    this.child = null;
    if (this.rl) {
      try { this.rl.close(); } catch { /* ignore */ }
      this.rl = null;
    }
    for (const [id, req] of this.pending) {
      if (req.timer) clearTimeout(req.timer);
      req.reject(new Error(`dsh process disconnected before response (id=${id})`));
    }
    this.pending.clear();
    this.permissions.clear();
    this.activeSessions.clear();
    this.sessionConfigs.clear();
    if (wasConnected) this.emit({ type: 'disconnected', code, signal });
  }

  private redact(text: string): string {
    for (const secret of this.secrets) text = text.split(secret).join('[redacted]');
    return text;
  }

  private handleStdoutLine(line: string, child: ChildProcess, generation: number): void {
    if (generation !== this.childGeneration || child !== this.child) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: any;
    try {
      message = JSON.parse(trimmed, (_key, value) => typeof value === 'string' ? this.redact(value) : value);
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

      const sessionMode = this.permissionModeForSession?.(sessionId);
      const autoApprove = this.alwaysApprove || sessionMode === 'auto' || sessionMode === 'bypassPermissions';

      if (autoApprove) {
        const allowOpt = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')
          ?? options.find((o) => o.optionId.includes('allow'))
          ?? options[0];
        const optionId = allowOpt?.optionId ?? 'allow-once';
        this.respond(id, { outcome: { outcome: 'selected', optionId } });
        return;
      }

      this.permissions.set(String(id), { id, sessionId, options, toolCall });
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
          rawOutput: update.content ?? update.rawOutput,
        });
      }
    }
  }

  private sendRequest<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
    child?: ChildProcess,
    generation?: number,
  ): Promise<T> {
    const id = this.nextId++;
    const actualTimeout = timeoutMs !== undefined ? timeoutMs : this.requestTimeoutMs;
    this.inFlightRequests++;
    this.cancelRecycleTimer();

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (fn: (value?: unknown) => void, value?: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
        (fn as (v?: unknown) => void)(value);
        this.scheduleRecycleIfIdle();
      };
      if (actualTimeout > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          finish(reject, new Error(`dsh request timed out after ${actualTimeout}ms: ${method} (id=${id})`));
        }, actualTimeout);
      }

      this.pending.set(id, {
        method,
        resolve: (value) => finish(resolve as (v?: unknown) => void, value),
        reject: (error) => finish(reject as (v?: unknown) => void, error),
        timer,
      });

      try {
        this.sendJson({ jsonrpc: '2.0', id, method, params }, child, generation);
      } catch (error) {
        this.pending.delete(id);
        finish(reject, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    await this.ensureReady();
    return this.sendRequest<T>(method, params, timeoutMs);
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.sendJson({ jsonrpc: '2.0', id, result });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.sendJson({ jsonrpc: '2.0', method, params });
  }

  private sendJson(payload: Record<string, unknown>, targetChild?: ChildProcess, targetGeneration?: number): void {
    const child = targetChild ?? this.child;
    if (targetGeneration !== undefined && targetGeneration !== this.childGeneration) {
      throw new Error('Cannot write to dsh process: generation mismatch');
    }
    if (!child || !child.stdin || child.stdin.destroyed) {
      throw new Error('Cannot write to dsh process: stdin not writable');
    }
    child.stdin.write(JSON.stringify(payload) + '\n');
  }

  async newSession(cwd: string): Promise<{ sessionId: string; configOptions?: unknown }> {
    const res = await this.request<{ sessionId: string; configOptions?: unknown }>('session/new', {
      cwd,
      mcpServers: [],
    });
    this.activeSessions.add(res.sessionId);
    this.sessionConfigs.set(res.sessionId, res.configOptions);
    return res;
  }

  async resumeSession(sessionId: string, cwd: string): Promise<{ configOptions?: unknown }> {
    if (this.activeSessions.has(sessionId)) {
      await this.ensureReady();
      if (this.activeSessions.has(sessionId)) return { configOptions: this.sessionConfigs.get(sessionId) };
    }
    try {
      const res = await this.request<{ configOptions?: unknown }>('session/resume', {
        sessionId,
        cwd,
        mcpServers: [],
      });
      this.activeSessions.add(sessionId);
      this.sessionConfigs.set(sessionId, res.configOptions);
      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('already active')) {
        this.activeSessions.add(sessionId);
        return {};
      }
      throw err;
    }
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<{ configOptions?: unknown }> {
    const res = await this.request<{ configOptions?: unknown }>('session/set_config_option', {
      sessionId,
      configId,
      value,
    });
    if (res.configOptions) this.sessionConfigs.set(sessionId, res.configOptions);
    return res;
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
    for (const [key, perm] of this.permissions.entries()) {
      if (perm.sessionId === sessionId) {
        this.permissions.delete(key);
        this.respond(perm.id, { outcome: { outcome: 'cancelled' } });
      }
    }
  }

  resolvePermission(approvalIdOrSessionId: string, decision: string | boolean, expectedSessionId?: string): boolean {
    const key = String(approvalIdOrSessionId);
    let pending = this.permissions.get(key);
    if (!pending) {
      for (const [k, p] of this.permissions.entries()) {
        if (p.sessionId === key) {
          if (expectedSessionId && p.sessionId !== expectedSessionId) continue;
          pending = p;
          this.permissions.delete(k);
          break;
        }
      }
    } else {
      if (expectedSessionId && pending.sessionId !== expectedSessionId) {
        return false;
      }
      this.permissions.delete(key);
    }
    if (!pending) return false;

    let matched: DshAcpPermissionOption | undefined;
    if (decision === 'approve_always') {
      matched = pending.options.find((o) => o.kind === 'allow_always')
        ?? pending.options.find((o) => o.kind === 'allow_once')
        ?? pending.options.find((o) => o.optionId.includes('allow'));
    } else if (decision === 'approve' || decision === true) {
      matched = pending.options.find((o) => o.kind === 'allow_once')
        ?? pending.options.find((o) => o.kind === 'allow_always')
        ?? pending.options.find((o) => o.optionId.includes('allow'));
    } else {
      matched = pending.options.find((o) => o.kind === 'reject_once')
        ?? pending.options.find((o) => o.kind?.startsWith('reject'))
        ?? pending.options.find((o) => o.optionId.includes('reject'));
    }
    const optionId = matched?.optionId ?? (decision === 'approve' || decision === 'approve_always' || decision === true ? 'allow-once' : 'reject-once');
    this.respond(pending.id, {
      outcome: { outcome: 'selected', optionId },
    });
    this.scheduleRecycleIfIdle();
    return true;
  }

  /** Provider config changed: drop the process now if idle; the next request respawns with it. */
  recycleSoon(): void {
    this.recycleRequested = true;
    this.scheduleRecycleIfIdle();
  }

  private scheduleRecycleIfIdle(): void {
    if (this.closed || this.isBusy()) return;
    if (this.recycleRequested || (this.child && this.providerFingerprint !== this.providers?.fingerprint())) {
      this.closeProcess();
      return;
    }
    if (this.recycleGraceMs <= 0) return;

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
    this.activeSessions.clear();
    this.sessionConfigs.clear();
  }

  close(): void {
    this.closed = true;
    this.closeProcess();
  }
}
