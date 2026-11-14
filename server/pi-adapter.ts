/**
 * PiAdapter + PiProviderAdapter — wraps `@earendil-works/pi-coding-agent` (`pi --mode rpc`)
 * as a ProviderAdapter for the multi-agent gateway.
 *
 * Protocol notes (verified against `@earendil-works/pi-coding-agent@1.5.2`):
 * - Long-lived child process per active session: `pi --mode rpc`.
 * - Strict LF-only JSONL framing on stdin/stdout (`\n` only; strips optional `\r`;
 *   never uses Node `readline` because `readline` splits on U+2028 / U+2029).
 * - Commands use string `id` correlation (`{ id, type: "response", command, success, data?, error? }`).
 * - Prompt acceptance returns `data.disposition` (`"started"` | `"queued"` | `"handled"`).
 * - Session-level runs settle on `agent_settled` (not `agent_end`, which can precede retries,
 *   compaction recovery, or extension boundaries).
 * - `extension_ui_request`: fire-and-forget methods (`notify`, `setStatus`, `setWidget`,
 *   `setTitle`, `set_editor_text`) expect no response; `select`/`confirm`/`input` bridge
 *   to gateway `question`; `editor`/unknown/timeout/disconnect/invalid fail closed `{ cancelled: true }`.
 * - Sessions live under `~/.pi/agent/sessions/--<encoded-cwd>--/*.jsonl` (tree via `id`/`parentId`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { listPiCommands, type PiNativeCommandInput } from './native-commands.js';
import { SettingsStore } from './settings-store.js';
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
  type NativeCommand,
  type NativeModel,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderName,
  type Session,
  type SessionPage,
  type SessionUsage,
  type StartTurnInput,
  type SteerInput,
  type TurnAttachment,
  type TurnHandle,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_HISTORY_TAIL_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_COMPACT_TIMEOUT_MS = 120_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const MODELS_TTL_MS = 5 * 60_000;
const COMMANDS_TTL_MS = 5 * 60_000;
const SUMMARY_HEAD_BYTES = 64 * 1024;
const SUMMARY_TAIL_BYTES = 256 * 1024;

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const VALID_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const EXTENDED_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const FIRE_AND_FORGET_UI_METHODS = new Set([
  'notify',
  'setStatus',
  'setWidget',
  'setTitle',
  'set_editor_text',
]);

const CONFIRM_YES_VALUES = new Set(['yes', 'y', 'true', '1', 'confirm', 'confirmed', 'allow', 'ok', '是', '确认']);
const CONFIRM_NO_VALUES = new Set(['no', 'n', 'false', '0', 'reject', 'deny', '否']);

const SAFE_OPEN_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_NONBLOCK ?? 0) |
  (fsConstants.O_NOFOLLOW ?? 0);

const OPEN_DIR_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_DIRECTORY ?? 0) |
  (fsConstants.O_NONBLOCK ?? 0) |
  (fsConstants.O_NOFOLLOW ?? 0);

const HAS_PROC_SELF_FD = process.platform === 'linux' && fs.existsSync('/proc/self/fd');

const VALID_SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export interface PiImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface PiModelInfo {
  id: string;
  name?: string;
  api?: string;
  provider: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, unknown>;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  [key: string]: unknown;
}

export interface PiSessionState {
  model?: PiModelInfo;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  steeringMode?: string;
  followUpMode?: string;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
}

export interface PiSessionStats {
  sessionFile?: string;
  sessionId: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalMessages?: number;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

export interface PiSessionSummary {
  sessionId: string;
  sessionFile: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  parentSession?: string;
}

export interface PiAdapterOptions {
  /** Explicit Pi binary path (overrides PI_BIN, ~/.local/bin/pi, and PATH). */
  piBin?: string;
  /** Extra environment variables for spawned Pi processes (`GATEWAY_*` keys are stripped). */
  env?: Record<string, string>;
  /** Override Pi sessions root directory (default: `$PI_CODING_AGENT_DIR/sessions` or `~/.pi/agent/sessions`). */
  sessionsDir?: string;
  /** Override SettingsStore path for sidecar persistence (archive/model/thinking). */
  settingsPath?: string;
  /** Extra CLI flags appended after `--mode rpc` (e.g., `['--no-extensions']` for isolated tests). */
  extraArgs?: string[];
  /** Timeout for standard RPC commands in ms. Default 30_000. */
  requestTimeoutMs?: number;
  /** Timeout for `compact` RPC in ms. Default 120_000. */
  compactTimeoutMs?: number;
  /** Grace period after stdin EOF before SIGTERM on shutdown. Default 2_000. */
  shutdownGraceMs?: number;
  /** Grace period after SIGTERM before SIGKILL on shutdown. Default 2_000. */
  killGraceMs?: number;
  /** Optional fallback timeout for extension UI dialogs without an explicit `timeout`. 0 = none. */
  dialogTimeoutMs?: number;
  /** Maximum decoded byte size for image attachments. Default 10 MiB. */
  maxImageBytes?: number;
  /** Maximum tail window size when reading session JSONL history. Default 16 MiB. */
  maxHistoryTailBytes?: number;
  /** Optional stderr line callback for diagnostics. */
  onStderr?: (line: string) => void;
  /** Optional preference resolver (used by PiProviderAdapter to sync SettingsStore). */
  resolveSessionPreferences?: (sessionId: string) => { model?: string; thinking?: string };
}

export interface PiStartTurnResult {
  turnId: string;
  disposition: 'started' | 'queued' | 'handled';
  events: AsyncIterable<GatewayEvent>;
}

// ---------------------------------------------------------------------------
// Strict LF-only JSONL Framer (avoids Node readline U+2028/U+2029 splitting)
// ---------------------------------------------------------------------------

/**
 * Strict LF-only buffered JSONL record framer.
 * Preserves Unicode U+2028 and U+2029 inside JSON string literals,
 * handles multi-byte UTF-8 sequences split across chunks, and strips trailing `\r`.
 */
export class JsonlLineFramer {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf('\n', start);
      if (nl === -1) break;
      let line = this.buffer.slice(start, nl);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) lines.push(line);
      start = nl + 1;
    }
    if (start > 0) {
      this.buffer = this.buffer.slice(start);
    }
    return lines;
  }

  flush(): string[] {
    this.buffer += this.decoder.end();
    if (this.buffer.length === 0) return [];
    let line = this.buffer;
    this.buffer = '';
    if (line.endsWith('\r')) line = line.slice(0, -1);
    return line.length > 0 ? [line] : [];
  }
}

// ---------------------------------------------------------------------------
// Backpressure-safe Stdin Line Writer
// ---------------------------------------------------------------------------

interface PendingWrite {
  line: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class StdinLineWriter {
  private readonly queue: PendingWrite[] = [];
  private readonly idleWaiters: Array<() => void> = [];
  private inFlight: PendingWrite | null = null;
  private inFlightReject: ((err: Error) => void) | null = null;
  private flushing = false;
  private closed = false;
  private closeError: Error | null = null;
  private drainWake: (() => void) | null = null;
  private drainedSinceWrite = false;

  constructor(private readonly stdin: NodeJS.WritableStream) {
    this.stdin.on('error', this.onStreamClosed);
    this.stdin.on('close', this.onStreamClosed);
    this.stdin.on('drain', this.onDrain);
  }

  writeLine(line: string): Promise<void> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error('stdin is closed'));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      this.queue.push({
        line,
        resolve: () => {
          if (settled) return;
          settled = true;
          resolve();
        },
        reject: (err: Error) => {
          if (settled) return;
          settled = true;
          reject(err);
        },
      });
      if (!this.flushing) {
        void this.pump();
      }
    });
  }

  abort(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = err;
    const active = this.inFlight;
    const activeReject = this.inFlightReject;
    this.inFlight = null;
    this.inFlightReject = null;
    active?.reject(err);
    activeReject?.(err);
    this.wakeDrain();
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      item.reject(err);
    }
    this.wakeIdle();
    this.detach();
  }

  async endAndFlush(timeoutMs = 500): Promise<void> {
    if (!this.closed && (this.flushing || this.queue.length > 0 || this.inFlight !== null)) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          this.waitUntilIdle(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (!this.closed && (this.flushing || this.queue.length > 0 || this.inFlight !== null)) {
      this.abort(new Error('stdin closed before flush completed'));
    } else if (!this.closed) {
      this.closed = true;
      this.wakeDrain();
      this.wakeIdle();
      this.detach();
    }
    const writable = this.stdin as NodeJS.WritableStream & {
      destroyed?: boolean;
      writableEnded?: boolean;
      end?: () => void;
    };
    if (!writable.destroyed && !writable.writableEnded && typeof writable.end === 'function') {
      try {
        writable.end();
      } catch {
        // already ended
      }
    }
  }

  private waitUntilIdle(): Promise<void> {
    if (this.closed || (!this.flushing && this.queue.length === 0 && this.inFlight === null)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private async pump(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        if (this.closed) break;
        const item = this.queue.shift()!;
        const writable = this.stdin as NodeJS.WritableStream & {
          destroyed?: boolean;
          writableEnded?: boolean;
          writable?: boolean;
          write: (chunk: string, encoding: BufferEncoding, cb: (err?: Error | null) => void) => boolean;
        };
        if (writable.destroyed || writable.writableEnded || writable.writable === false) {
          item.reject(this.closeError ?? new Error('Pi process stdin is not writable'));
          continue;
        }
        let ok = false;
        this.drainedSinceWrite = false;
        this.inFlight = item;
        try {
          await new Promise<void>((resolveWrite, rejectWrite) => {
            this.inFlightReject = rejectWrite;
            ok = writable.write(item.line, 'utf8', (err) => {
              if (this.inFlight === item) {
                this.inFlight = null;
                this.inFlightReject = null;
              }
              if (err) {
                const writeErr = err instanceof Error ? err : new Error(String(err));
                item.reject(writeErr);
                rejectWrite(writeErr);
              } else {
                item.resolve();
                resolveWrite();
              }
            });
          });
        } catch (err) {
          if (this.inFlight === item) {
            this.inFlight = null;
            this.inFlightReject = null;
          }
          const writeErr = err instanceof Error ? err : new Error(String(err));
          item.reject(writeErr);
          continue;
        }
        if (!ok && !this.closed && !this.drainedSinceWrite && !writable.destroyed) {
          await new Promise<void>((resolveDrain) => {
            this.drainWake = resolveDrain;
          });
        }
      }
    } finally {
      this.flushing = false;
      if (this.queue.length === 0 && this.inFlight === null) {
        this.wakeIdle();
      }
    }
  }

  private wakeIdle(): void {
    while (this.idleWaiters.length > 0) {
      const resolve = this.idleWaiters.shift()!;
      resolve();
    }
  }

  private readonly onDrain = (): void => {
    this.drainedSinceWrite = true;
    this.wakeDrain();
  };

  private readonly onStreamClosed = (err?: unknown): void => {
    const error = err instanceof Error ? err : new Error('Pi process stdin closed');
    this.abort(error);
  };

  private wakeDrain(): void {
    const wake = this.drainWake;
    if (wake) {
      this.drainWake = null;
      wake();
    }
  }

  private detach(): void {
    this.stdin.off('error', this.onStreamClosed);
    this.stdin.off('close', this.onStreamClosed);
    this.stdin.off('drain', this.onDrain);
  }
}

// ---------------------------------------------------------------------------
// PiRpcClient — single `pi --mode rpc` subprocess
// ---------------------------------------------------------------------------

interface PendingRpcRequest {
  command: string;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export type PiRpcClientEvent =
  | { kind: 'rpc_event'; event: Record<string, unknown> }
  | { kind: 'ui_request'; request: Record<string, unknown> }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null; intentional: boolean; error?: Error };

export interface PiRpcClientOptions {
  piBin: string;
  cwd?: string;
  env?: Record<string, string>;
  args?: string[];
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
  killGraceMs?: number;
  onStderr?: (line: string) => void;
}

export class PiRpcClient {
  private readonly piBin: string;
  private readonly cwd: string;
  private readonly env: Record<string, string>;
  private readonly args: string[];
  private readonly requestTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly killGraceMs: number;
  private readonly onStderr?: (line: string) => void;

  private child: ChildProcess | null = null;
  private writer: StdinLineWriter | null = null;
  private readonly framer = new JsonlLineFramer();
  private readonly pending = new Map<string, PendingRpcRequest>();
  private readonly listeners = new Set<(ev: PiRpcClientEvent) => void>();
  private reqSeq = 0;
  private stderrTail = '';
  private started = false;
  private closing = false;
  private exited = false;
  private exitError: Error | null = null;
  private exitPromise: Promise<void> | null = null;
  private resolveExitPromise: (() => void) | null = null;

  constructor(options: PiRpcClientOptions) {
    this.piBin = options.piBin;
    this.cwd = options.cwd ?? os.homedir();
    this.env = options.env ?? {};
    this.args = options.args ?? [];
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.onStderr = options.onStderr;
  }

  get isAlive(): boolean {
    return (
      this.started &&
      !this.exited &&
      !this.closing &&
      this.child !== null &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }

  get canWriteStdin(): boolean {
    const stdin = this.child?.stdin;
    return Boolean(
      this.started &&
      !this.exited &&
      this.child &&
      stdin &&
      !stdin.destroyed &&
      !stdin.writableEnded &&
      stdin.writable,
    );
  }

  getStderrTail(): string {
    return this.stderrTail.trim();
  }

  onEvent(handler: (ev: PiRpcClientEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  start(): void {
    if (this.started) return;
    if (this.closing || this.exited) {
      throw new ProviderError('upstream_error', 'Pi RPC client is already closed', 502);
    }
    this.started = true;
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExitPromise = resolve;
    });

    const child = spawn(this.piBin, ['--mode', 'rpc', ...this.args], {
      cwd: this.cwd,
      env: buildPiChildEnv(this.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.child = child;
    this.writer = new StdinLineWriter(child.stdin!);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      for (const line of this.framer.push(chunk)) {
        this.handleLine(line);
      }
    });
    child.stdout?.on('end', () => {
      for (const line of this.framer.flush()) {
        this.handleLine(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.stderrTail = (this.stderrTail + text).slice(-4000);
      if (this.onStderr) {
        for (const l of text.split(/\r?\n/)) {
          if (l.trim()) this.onStderr(l);
        }
      }
    });

    child.once('error', (err) => {
      this.handleProcessExit(null, null, err);
    });
    child.once('close', (code, signal) => {
      for (const line of this.framer.flush()) {
        this.handleLine(line);
      }
      this.handleProcessExit(code, signal);
    });
  }

  async request<T = unknown>(command: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (!this.started) this.start();
    if (this.exited || this.closing || !this.writer) {
      throw this.exitError ?? new ProviderError('upstream_error', 'Pi RPC process is not running', 502);
    }
    const id = `pi_req_${++this.reqSeq}`;
    const cmdName = String(command.type ?? 'unknown');
    const payload = { ...command, id };
    const line = `${JSON.stringify(payload)}\n`;

    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new ProviderError('upstream_error', `Pi RPC '${cmdName}' timed out after ${timeoutMs}ms`, 504));
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, {
        command: cmdName,
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      });

      this.writer!.writeLine(line).catch((err: unknown) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        const message = err instanceof Error ? err.message : String(err);
        reject(new ProviderError('upstream_error', `Pi RPC '${cmdName}' write failed: ${message}`, 502, err));
      });
    });
  }

  async sendExtensionUiResponse(response: Record<string, unknown>): Promise<void> {
    if (!this.canWriteStdin || !this.writer) return;
    await this.writer.writeLine(`${JSON.stringify(response)}\n`);
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.exitPromise;
      return;
    }
    this.closing = true;
    const child = this.child;
    if (!this.started || !child) {
      this.exited = true;
      this.resolveExitPromise?.();
      return;
    }

    await this.writer?.endAndFlush().catch(() => undefined);

    if (child.exitCode === null && child.signalCode === null) {
      await this.waitForExit(this.shutdownGraceMs);
    }
    if (child.exitCode === null && child.signalCode === null) {
      killProcessGroup(child, 'SIGTERM');
      await this.waitForExit(this.killGraceMs);
    }
    if (child.exitCode === null && child.signalCode === null) {
      killProcessGroup(child, 'SIGKILL');
      await this.waitForExit(1_000);
    }
  }

  private waitForExit(ms: number): Promise<void> {
    if (this.exited || !this.exitPromise) return Promise.resolve();
    return Promise.race([
      this.exitPromise,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        t.unref?.();
      }),
    ]);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(msg)) return;

    if (msg.type === 'response') {
      const id = typeof msg.id === 'string' ? msg.id : undefined;
      if (id && this.pending.has(id)) {
        const pending = this.pending.get(id)!;
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        if (msg.success === true) {
          pending.resolve(msg.data);
        } else {
          const errText = typeof msg.error === 'string' && msg.error
            ? msg.error
            : `Pi RPC command '${String(msg.command ?? pending.command)}' failed`;
          pending.reject(new ProviderError('upstream_error', errText, 502));
        }
      }
      return;
    }

    if (msg.type === 'extension_ui_request') {
      this.emit({ kind: 'ui_request', request: msg });
      return;
    }

    this.emit({ kind: 'rpc_event', event: msg });
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null, err?: Error): void {
    if (this.exited) return;
    this.exited = true;
    const intentional = this.closing;
    const tail = this.stderrTail.trim();
    const detail = err
      ? `Pi RPC spawn error: ${err.message}`
      : `Pi RPC exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})${tail ? `: ${tail}` : ''}`;
    const exitErr = new ProviderError('upstream_error', detail, 502, err);
    this.exitError = exitErr;

    this.writer?.abort(exitErr);
    this.writer = null;

    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(exitErr);
    }
    this.pending.clear();

    this.emit({ kind: 'exit', code, signal, intentional, error: err ?? exitErr });
    this.resolveExitPromise?.();
  }

  private emit(ev: PiRpcClientEvent): void {
    for (const handler of [...this.listeners]) {
      try {
        handler(ev);
      } catch {
        // isolate listener errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PiAdapter — RPC orchestration + ~/.pi/agent/sessions store + active-branch reader
// ---------------------------------------------------------------------------

interface ParkedQuestion {
  id: string;
  sessionId: string;
  method: 'select' | 'confirm' | 'input';
  options?: string[];
  timer: ReturnType<typeof setTimeout> | null;
  stream: EventStream<GatewayEvent>;
  turnId: string;
}

interface ActiveTurnState {
  sessionId: string;
  turnId: string;
  client: PiRpcClient;
  stream: EventStream<GatewayEvent>;
  settled: boolean;
  abortRequested: boolean;
  inAgentRun: boolean;
  sawAgentStart: boolean;
  streamedTextIndices: Set<number>;
  streamedThinkingIndices: Set<number>;
  startedTools: Set<string>;
  endedTools: Set<string>;
  lastToolPartial: Map<string, string>;
  lastAssistantMessage: Record<string, unknown> | null;
  lastError: string | null;
  unsubscribe: (() => void) | null;
}

export class PiAdapter {
  private readonly piBinOverride?: string;
  private readonly env: Record<string, string>;
  private readonly sessionsDir: string;
  private readonly extraArgs: string[];
  private readonly requestTimeoutMs: number;
  private readonly compactTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly killGraceMs: number;
  private readonly dialogTimeoutMs: number;
  private readonly maxImageBytes: number;
  private readonly maxHistoryTailBytes: number;
  private readonly onStderr?: (line: string) => void;
  private readonly resolveSessionPreferences?: (sessionId: string) => { model?: string; thinking?: string };

  private readonly processes = new Map<string, PiRpcClient>();
  private readonly clientToSession = new WeakMap<PiRpcClient, string>();
  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private readonly parkedQuestions = new Map<string, ParkedQuestion>();
  private readonly sessionCwd = new Map<string, string>();
  private readonly sessionFiles = new Map<string, string>();
  private readonly sessionNames = new Map<string, string>();
  private readonly draftSessions = new Set<string>();
  private readonly sessionUsage = new Map<string, SessionUsage>();
  private readonly sessionModels = new Map<string, string>();
  private readonly sessionThinkings = new Map<string, string>();
  private readonly appliedPreferences = new Map<string, { model?: string; thinking?: string }>();

  private modelsCache: { ts: number; models: PiModelInfo[] } | null = null;
  private modelsInflight: Promise<PiModelInfo[]> | null = null;
  private readonly commandsCache = new Map<string, { ts: number; commands: PiNativeCommandInput[] }>();
  private readonly commandsInflight = new Map<string, Promise<PiNativeCommandInput[]>>();

  constructor(options: PiAdapterOptions = {}) {
    this.piBinOverride = options.piBin;
    this.env = { ...(options.env ?? {}) };
    this.sessionsDir = options.sessionsDir ?? resolveDefaultPiSessionsDir(this.env);
    this.extraArgs = [...(options.extraArgs ?? [])];
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.compactTimeoutMs = options.compactTimeoutMs ?? DEFAULT_COMPACT_TIMEOUT_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.dialogTimeoutMs = options.dialogTimeoutMs ?? 0;
    this.maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    this.maxHistoryTailBytes = options.maxHistoryTailBytes ?? DEFAULT_HISTORY_TAIL_BYTES;
    this.onStderr = options.onStderr;
    this.resolveSessionPreferences = options.resolveSessionPreferences;
  }

  getPiBin(): string {
    return resolvePiBin(this.piBinOverride, this.env);
  }

  getSessionsDir(): string {
    return this.sessionsDir;
  }

  getCwd(sessionId: string): string | undefined {
    return this.sessionCwd.get(sessionId);
  }

  getCachedModel(sessionId: string): string | undefined {
    return this.sessionModels.get(sessionId);
  }

  getCachedThinking(sessionId: string): string | undefined {
    return this.sessionThinkings.get(sessionId);
  }

  getCachedUsage(sessionId: string): SessionUsage | undefined {
    return this.sessionUsage.get(sessionId);
  }

  getCachedSessionName(sessionId: string): string | undefined {
    return this.sessionNames.get(sessionId);
  }

  isBusy(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }

  hasDraft(sessionId: string): boolean {
    return this.draftSessions.has(sessionId);
  }

  // -- Session discovery & reading ------------------------------------------

  async list(cwdFilter?: string): Promise<PiSessionSummary[]> {
    const out: PiSessionSummary[] = [];
    const realRoot = await safeRealpath(this.sessionsDir);
    if (!realRoot) return out;

    let cwdDirs: fs.Dirent[];
    try {
      cwdDirs = await fsp.readdir(realRoot, { withFileTypes: true });
    } catch {
      return out;
    }

    const resolvedFilter = cwdFilter ? path.resolve(cwdFilter).replace(/\/+$/, '') : undefined;
    for (const cwdEnt of cwdDirs) {
      if (!cwdEnt.isDirectory() || cwdEnt.isSymbolicLink()) continue;
      const cwdDirPath = path.join(realRoot, cwdEnt.name);
      const realCwdDir = await verifyDirInsideRoot(realRoot, cwdDirPath);
      if (!realCwdDir) continue;

      let files: fs.Dirent[];
      try {
        files = await fsp.readdir(realCwdDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const fileEnt of files) {
        if (!fileEnt.name.endsWith('.jsonl') || fileEnt.isSymbolicLink() || !fileEnt.isFile()) continue;
        const fullPath = path.join(realCwdDir, fileEnt.name);
        const summary = await summarizePiSessionFile(fullPath, realRoot);
        if (!summary) continue;
        if (resolvedFilter && summary.cwd.replace(/\/+$/, '') !== resolvedFilter) continue;
        this.sessionCwd.set(summary.sessionId, summary.cwd);
        this.sessionFiles.set(summary.sessionId, summary.sessionFile);
        out.push(summary);
      }
    }

    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return out;
  }

  create(cwd?: string, title?: string): { sessionId: string; cwd: string } {
    const sessionId = randomUUID();
    const resolvedCwd = path.resolve(cwd ?? process.cwd());
    this.sessionCwd.set(sessionId, resolvedCwd);
    this.draftSessions.add(sessionId);
    if (title?.trim()) {
      this.sessionNames.set(sessionId, title.trim());
    }
    return { sessionId, cwd: resolvedCwd };
  }

  async getHistory(sessionId: string): Promise<Message[]> {
    assertSafeSessionId(sessionId);
    const filePath = await this.locateSessionFile(sessionId);
    if (!filePath) {
      if (this.draftSessions.has(sessionId)) return [];
      throw new ProviderError('not_found', `pi-adapter: session not found: ${sessionId}`, 404);
    }
    const realRoot = await safeRealpath(this.sessionsDir);
    if (!realRoot) {
      throw new ProviderError('not_found', `pi-adapter: session not found: ${sessionId}`, 404);
    }
    return readPiActiveBranchHistory(filePath, {
      sessionId,
      sessionsRoot: realRoot,
      maxTailBytes: this.maxHistoryTailBytes,
    });
  }

  // -- Catalogs & Session State ---------------------------------------------

  async getAvailableModels(): Promise<PiModelInfo[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.ts < MODELS_TTL_MS) {
      return this.modelsCache.models;
    }
    if (this.modelsInflight) return this.modelsInflight;
    const inflight = this.runEphemeralRpc(async (client) => {
      const data = await client.request<{ models?: PiModelInfo[] }>({ type: 'get_available_models' });
      const models = Array.isArray(data?.models) ? data.models : [];
      this.modelsCache = { ts: Date.now(), models };
      return models;
    }).finally(() => {
      this.modelsInflight = null;
    });
    this.modelsInflight = inflight;
    return inflight;
  }

  async getCommands(sessionId?: string): Promise<PiNativeCommandInput[]> {
    const cwd = sessionId ? await this.resolveSessionCwd(sessionId) : process.cwd();
    const cacheKey = cwd;
    const hit = this.commandsCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < COMMANDS_TTL_MS) {
      return hit.commands;
    }
    const inflight = this.commandsInflight.get(cacheKey);
    if (inflight) return inflight;

    const task = (async () => {
      const existing = sessionId ? this.processes.get(sessionId) : undefined;
      let cmds: PiNativeCommandInput[];
      if (existing?.isAlive) {
        const data = await existing.request<{ commands?: PiNativeCommandInput[] }>({ type: 'get_commands' });
        cmds = Array.isArray(data?.commands) ? data.commands : [];
      } else {
        cmds = await this.runEphemeralRpc(async (client) => {
          const data = await client.request<{ commands?: PiNativeCommandInput[] }>({ type: 'get_commands' });
          return Array.isArray(data?.commands) ? data.commands : [];
        }, cwd);
      }
      this.commandsCache.set(cacheKey, { ts: Date.now(), commands: cmds });
      return cmds;
    })().finally(() => {
      this.commandsInflight.delete(cacheKey);
    });

    this.commandsInflight.set(cacheKey, task);
    return task;
  }

  async getState(sessionId: string): Promise<PiSessionState> {
    const client = await this.ensureSessionProcess(sessionId);
    const state = await client.request<PiSessionState>({ type: 'get_state' });
    this.recordState(sessionId, state);
    return state;
  }

  async getAvailableThinkingLevels(sessionId: string): Promise<string[]> {
    const client = await this.ensureSessionProcess(sessionId);
    const data = await client.request<{ levels?: string[] }>({ type: 'get_available_thinking_levels' });
    return Array.isArray(data?.levels) ? data.levels.filter((l): l is string => typeof l === 'string') : [];
  }

  async setModel(sessionId: string, encodedModel: string): Promise<PiModelInfo> {
    const known = this.modelsCache?.models;
    const parsed = decodePiModelId(encodedModel, known);
    if (!parsed) {
      throw new ProviderError('invalid_request', `Invalid Pi model identifier: ${encodedModel}`, 400);
    }
    const client = await this.ensureSessionProcess(sessionId, { skipModelSync: true });
    const model = await client.request<PiModelInfo>({
      type: 'set_model',
      provider: parsed.provider,
      modelId: parsed.modelId,
    });
    const state = await client.request<PiSessionState>({ type: 'get_state' });
    this.recordState(sessionId, state);
    const resolvedEncoded = encodePiModelId(model.provider || parsed.provider, model.id || parsed.modelId);
    const prevApplied = this.appliedPreferences.get(sessionId);
    this.appliedPreferences.set(sessionId, {
      ...prevApplied,
      model: resolvedEncoded,
      ...(state.thinkingLevel ? { thinking: state.thinkingLevel } : {}),
    });
    return model;
  }

  async setThinkingLevel(sessionId: string, level: string): Promise<string> {
    const normalized = level.trim();
    if (!VALID_THINKING_LEVELS.has(normalized)) {
      throw new ProviderError('invalid_request', `Unsupported thinking level: ${level}`, 400);
    }
    const client = await this.ensureSessionProcess(sessionId, { skipThinkingSync: true });
    await client.request({ type: 'set_thinking_level', level: normalized });
    const state = await client.request<PiSessionState>({ type: 'get_state' });
    this.recordState(sessionId, state);
    const effective = state.thinkingLevel ?? normalized;
    const prevApplied = this.appliedPreferences.get(sessionId);
    this.appliedPreferences.set(sessionId, { ...prevApplied, thinking: normalized });
    return effective;
  }

  async getSessionStats(sessionId: string): Promise<PiSessionStats> {
    const client = await this.ensureSessionProcess(sessionId);
    const stats = await client.request<PiSessionStats>({ type: 'get_session_stats' });
    const usage = mapPiStatsToUsage(stats, this.sessionModels.get(sessionId), this.modelsCache?.models);
    this.sessionUsage.set(sessionId, usage);
    return stats;
  }

  async refreshUsage(sessionId: string): Promise<SessionUsage> {
    const stats = await this.getSessionStats(sessionId);
    return mapPiStatsToUsage(stats, this.sessionModels.get(sessionId), this.modelsCache?.models);
  }

  async compact(sessionId: string, customInstructions?: string): Promise<void> {
    if (this.activeTurns.has(sessionId)) {
      throw new ProviderError('busy', `pi-adapter: session ${sessionId} is busy`, 409);
    }
    const client = await this.ensureSessionProcess(sessionId);
    await client.request(
      {
        type: 'compact',
        ...(customInstructions?.trim() ? { customInstructions: customInstructions.trim() } : {}),
      },
      this.compactTimeoutMs,
    );
    const stats = await client.request<PiSessionStats>({ type: 'get_session_stats' }).catch(() => null);
    if (stats) {
      this.sessionUsage.set(sessionId, mapPiStatsToUsage(stats, this.sessionModels.get(sessionId), this.modelsCache?.models));
    } else {
      const prev = this.sessionUsage.get(sessionId);
      this.sessionUsage.set(sessionId, {
        input_tokens: prev?.input_tokens ?? 0,
        output_tokens: prev?.output_tokens ?? 0,
        cache_read_tokens: prev?.cache_read_tokens ?? 0,
        cache_creation_tokens: prev?.cache_creation_tokens ?? 0,
        total_cost_usd: prev?.total_cost_usd ?? 0,
        context_tokens: 0,
        context_limit: prev?.context_limit ?? 0,
        turn_count: prev?.turn_count ?? 0,
        authoritative: true,
        context_unavailable: true,
      });
    }
  }

  async setSessionName(sessionId: string, name: string): Promise<void> {
    const trimmed = name.replace(/[\r\n]+/g, ' ').trim();
    if (!trimmed) {
      throw new ProviderError('invalid_request', 'Session name cannot be empty', 400);
    }
    this.sessionNames.set(sessionId, trimmed);
    const existing = this.processes.get(sessionId);
    if (existing?.isAlive) {
      await existing.request({ type: 'set_session_name', name: trimmed }).catch(() => undefined);
      return;
    }
    const filePath = await this.locateSessionFile(sessionId);
    if (filePath) {
      await this.runEphemeralRpc(async (client) => {
        await client.request({ type: 'set_session_name', name: trimmed });
      }, await this.resolveSessionCwd(sessionId), ['--session', filePath]).catch(() => undefined);
    }
  }

  // -- Clone & Fork (isolated processes) ------------------------------------

  async getForkMessages(sessionId: string): Promise<Array<{ entryId: string; text: string }>> {
    const client = await this.ensureSessionProcess(sessionId);
    const data = await client.request<{ messages?: Array<{ entryId: string; text: string }> }>({
      type: 'get_fork_messages',
    });
    return Array.isArray(data?.messages) ? data.messages : [];
  }

  async clone(sessionId: string): Promise<PiSessionSummary> {
    return this.cloneOrForkIsolated(sessionId, 'clone');
  }

  async fork(sessionId: string, entryId?: string): Promise<PiSessionSummary> {
    if (entryId) {
      return this.cloneOrForkIsolated(sessionId, 'fork', entryId);
    }
    return this.cloneOrForkIsolated(sessionId, 'clone');
  }

  private async cloneOrForkIsolated(
    sourceSessionId: string,
    mode: 'clone' | 'fork',
    entryId?: string,
  ): Promise<PiSessionSummary> {
    assertSafeSessionId(sourceSessionId);
    if (this.activeTurns.has(sourceSessionId)) {
      throw new ProviderError('busy', `pi-adapter: cannot ${mode} busy session ${sourceSessionId}`, 409);
    }

    // Reject unsaved empty drafts immediately before spawning a clone process.
    const sourceFile = await this.locateSessionFile(sourceSessionId);
    const existingSourceProc = this.processes.get(sourceSessionId);
    if (existingSourceProc?.isAlive) {
      const sourceState = await existingSourceProc.request<PiSessionState>({ type: 'get_state' });
      this.recordState(sourceSessionId, sourceState);
      if ((sourceState.messageCount ?? 0) === 0 && !sourceFile) {
        throw new ProviderError(
          'invalid_request',
          'Cannot clone or fork an empty unsaved Pi session: send a message first',
          400,
        );
      }
    } else if (!sourceFile) {
      throw new ProviderError(
        'invalid_request',
        `Cannot clone or fork unsaved or missing Pi session: ${sourceSessionId}`,
        400,
      );
    }

    const sourceCwd = await this.resolveSessionCwd(sourceSessionId);
    const resolvedSourceFile = sourceFile ?? this.sessionFiles.get(sourceSessionId);
    const launchArgs = resolvedSourceFile
      ? ['--session', resolvedSourceFile]
      : ['--session-id', sourceSessionId];

    // Spawn an isolated RPC process for the cloned/forked session so the source
    // session's running process is never switched or mutated.
    const newClient = this.createClient(sourceCwd, launchArgs);
    try {
      newClient.start();
      const preState = await newClient.request<PiSessionState>({ type: 'get_state' });
      if ((preState.messageCount ?? 0) === 0) {
        throw new ProviderError(
          'invalid_request',
          'Cannot clone or fork an empty unsaved Pi session: send a message first',
          400,
        );
      }

      if (mode === 'fork') {
        let targetEntryId = entryId;
        if (!targetEntryId) {
          const forkMsgs = await newClient.request<{ messages?: Array<{ entryId: string; text: string }> }>({
            type: 'get_fork_messages',
          });
          const msgs = Array.isArray(forkMsgs?.messages) ? forkMsgs.messages : [];
          if (msgs.length === 0) {
            throw new ProviderError('invalid_request', 'No user messages available to fork from', 400);
          }
          targetEntryId = msgs[msgs.length - 1]!.entryId;
        }
        const forkRes = await newClient.request<{ text?: string; cancelled?: boolean }>({
          type: 'fork',
          entryId: targetEntryId,
        });
        if (forkRes?.cancelled) {
          throw new ProviderError('invalid_request', 'Pi fork was cancelled by an extension', 400);
        }
      } else {
        const cloneRes = await newClient.request<{ cancelled?: boolean }>({ type: 'clone' });
        if (cloneRes?.cancelled) {
          throw new ProviderError('invalid_request', 'Pi clone was cancelled by an extension', 400);
        }
      }

      let newState = await newClient.request<PiSessionState>({ type: 'get_state' });
      const newSessionId = newState.sessionId;
      const newSessionFile = newState.sessionFile ?? '';
      if (!newSessionId || newSessionId === sourceSessionId) {
        throw new ProviderError('upstream_error', 'Pi clone did not yield a distinct sessionId', 502);
      }

      const sourcePrefs = this.resolveSessionPreferences?.(sourceSessionId);
      const sourceModel = this.sessionModels.get(sourceSessionId) ?? sourcePrefs?.model;
      const sourceThinking = this.sessionThinkings.get(sourceSessionId) ?? sourcePrefs?.thinking;
      const clonedModel = newState.model?.provider && newState.model?.id && newState.model.id !== 'unknown'
        ? encodePiModelId(newState.model.provider, newState.model.id)
        : undefined;
      let stateNeedsRefresh = false;
      if (sourceModel && sourceModel !== clonedModel) {
        const parsed = decodePiModelId(sourceModel, this.modelsCache?.models);
        if (parsed) {
          await newClient.request({ type: 'set_model', provider: parsed.provider, modelId: parsed.modelId }).catch(() => undefined);
          stateNeedsRefresh = true;
        }
      }
      if (sourceThinking && sourceThinking !== newState.thinkingLevel && VALID_THINKING_LEVELS.has(sourceThinking)) {
        await newClient.request({ type: 'set_thinking_level', level: sourceThinking }).catch(() => undefined);
        stateNeedsRefresh = true;
      }
      if (stateNeedsRefresh) {
        newState = await newClient.request<PiSessionState>({ type: 'get_state' });
      }

      this.clientToSession.set(newClient, newSessionId);
      this.processes.set(newSessionId, newClient);
      this.sessionCwd.set(newSessionId, sourceCwd);
      if ((newState.messageCount ?? 0) > 0) {
        if (newSessionFile) this.sessionFiles.set(newSessionId, newSessionFile);
        this.draftSessions.delete(newSessionId);
      } else {
        this.sessionFiles.delete(newSessionId);
        this.draftSessions.add(newSessionId);
      }
      this.recordState(newSessionId, newState);
      if (sourceModel || sourceThinking) {
        this.appliedPreferences.set(newSessionId, {
          ...(sourceModel ? { model: sourceModel } : {}),
          ...(sourceThinking ? { thinking: sourceThinking } : {}),
        });
      }

      const now = new Date().toISOString();
      const title =
        newState.sessionName ||
        this.sessionNames.get(sourceSessionId) ||
        `Pi ${newSessionId.slice(0, 8)}`;

      return {
        sessionId: newSessionId,
        sessionFile: (newState.messageCount ?? 0) > 0 ? newSessionFile : '',
        title,
        cwd: sourceCwd,
        createdAt: now,
        updatedAt: now,
        parentSession: resolvedSourceFile,
      };
    } catch (err) {
      await newClient.close().catch(() => undefined);
      throw err;
    }
  }

  // -- Turn execution, streaming, steer, followUp, abort --------------------

  async startTurn(
    sessionId: string,
    input: string | MessageContentPart[],
    attachments: TurnAttachment[] = [],
  ): Promise<PiStartTurnResult> {
    if (this.activeTurns.has(sessionId)) {
      throw new ProviderError('busy', `pi-adapter: a turn is already running for session ${sessionId}`, 409);
    }
    const { message, images } = await normalizePiPromptInput(input, attachments, this.maxImageBytes);
    if (!message.trim() && images.length === 0) {
      throw new ProviderError('invalid_request', 'Pi prompt cannot be empty', 400);
    }

    const client = await this.ensureSessionProcess(sessionId);
    const turnId = randomUUID();
    const stream = new EventStream<GatewayEvent>();

    const turn: ActiveTurnState = {
      sessionId,
      turnId,
      client,
      stream,
      settled: false,
      abortRequested: false,
      inAgentRun: false,
      sawAgentStart: false,
      streamedTextIndices: new Set(),
      streamedThinkingIndices: new Set(),
      startedTools: new Set(),
      endedTools: new Set(),
      lastToolPartial: new Map(),
      lastAssistantMessage: null,
      lastError: null,
      unsubscribe: null,
    };
    this.activeTurns.set(sessionId, turn);

    // Subscribe BEFORE sending `prompt` so fast emissions are never missed.
    turn.unsubscribe = client.onEvent((ev) => {
      this.handleClientEvent(turn, ev);
    });

    try {
      const response = await client.request<{ disposition?: 'started' | 'queued' | 'handled' }>({
        type: 'prompt',
        message,
        ...(images.length > 0 ? { images } : {}),
      });
      const disposition = response?.disposition ?? 'started';

      // If an extension command/input handler handled the prompt synchronously and no
      // agent run is active, complete the turn immediately without waiting for agent_settled.
      if (disposition === 'handled' && !turn.inAgentRun && !turn.settled) {
        this.settleTurn(turn, 'completed');
      }

      return { turnId, disposition, events: stream };
    } catch (err) {
      if (!turn.settled) {
        this.cleanupTurn(turn);
      }
      throw err;
    }
  }

  async steer(
    sessionId: string,
    input: string | MessageContentPart[] | SteerInput,
    attachments: TurnAttachment[] = [],
  ): Promise<'queued' | 'handled'> {
    const client = this.processes.get(sessionId);
    if (!client || !client.isAlive || !this.activeTurns.has(sessionId)) {
      throw new ProviderError('not_found', `pi-adapter: no active turn to steer for session ${sessionId}`, 404);
    }
    const { rawInput, mergedAttachments } = unpackSteerInput(input, attachments);
    const { message, images } = await normalizePiPromptInput(rawInput, mergedAttachments, this.maxImageBytes);
    if (!message.trim() && images.length === 0) {
      throw new ProviderError('invalid_request', 'steer message cannot be empty', 400);
    }
    const res = await client.request<{ disposition?: 'queued' | 'handled' }>({
      type: 'steer',
      message,
      ...(images.length > 0 ? { images } : {}),
    });
    return res?.disposition ?? 'queued';
  }

  async followUp(
    sessionId: string,
    input: string | MessageContentPart[] | SteerInput,
    attachments: TurnAttachment[] = [],
  ): Promise<'queued' | 'handled'> {
    const client = this.processes.get(sessionId);
    if (!client || !client.isAlive) {
      throw new ProviderError('not_found', `pi-adapter: no running process for session ${sessionId}`, 404);
    }
    const { rawInput, mergedAttachments } = unpackSteerInput(input, attachments);
    const { message, images } = await normalizePiPromptInput(rawInput, mergedAttachments, this.maxImageBytes);
    if (!message.trim() && images.length === 0) {
      throw new ProviderError('invalid_request', 'followUp message cannot be empty', 400);
    }
    const res = await client.request<{ disposition?: 'queued' | 'handled' }>({
      type: 'follow_up',
      message,
      ...(images.length > 0 ? { images } : {}),
    });
    return res?.disposition ?? 'queued';
  }

  async abort(sessionId: string): Promise<void> {
    const turn = this.activeTurns.get(sessionId);
    if (turn) {
      turn.abortRequested = true;
    }
    this.failCloseSessionQuestions(sessionId);

    const client = this.processes.get(sessionId);
    if (!client || !client.isAlive) return;
    try {
      await client.request({ type: 'abort' });
    } catch {
      if (turn && !turn.settled) {
        this.settleTurn(turn, 'cancelled');
      }
    }
  }

  // -- Extension UI question bridging ---------------------------------------

  async resolveQuestion(
    sessionId: string,
    questionId: string,
    answer: string | Record<string, string[]>,
  ): Promise<void> {
    const parked = this.parkedQuestions.get(questionId);
    if (!parked || parked.sessionId !== sessionId) {
      throw new ProviderError('not_found', `pi-adapter: no pending question ${questionId} for session ${sessionId}`, 404);
    }
    this.parkedQuestions.delete(questionId);
    if (parked.timer) clearTimeout(parked.timer);

    const client = this.processes.get(sessionId);
    const response = buildExtensionUiResponse(parked, answer);
    if (client?.canWriteStdin) {
      await client.sendExtensionUiResponse(response).catch(() => undefined);
    }
    const resolvedKind = 'cancelled' in response && response.cancelled ? 'cancelled' : 'completed';
    parked.stream.push({
      kind: 'interaction_resolved',
      status: resolvedKind,
      sessionId,
      turnId: parked.turnId,
      timestamp: Date.now(),
      payload: {
        interactionId: questionId,
        interactionKind: 'question',
        resolution: 'cancelled' in response && response.cancelled ? 'cancelled' : 'answered',
      },
    });
  }

  // -- Safe delete & lifecycle ----------------------------------------------

  async delete(sessionId: string): Promise<void> {
    assertSafeSessionId(sessionId);
    if (this.activeTurns.has(sessionId)) {
      throw new ProviderError('busy', `pi-adapter: cannot delete busy session ${sessionId}`, 409);
    }

    await this.close(sessionId);

    const realRoot = await safeRealpath(this.sessionsDir);
    if (realRoot) {
      const matches = await findMatchingSessionFilesSafe(realRoot, sessionId);
      for (const filePath of matches) {
        await safeUnlinkWithinRoot(realRoot, filePath);
      }
      const cached = this.sessionFiles.get(sessionId);
      if (cached) {
        await safeUnlinkWithinRoot(realRoot, cached).catch(() => undefined);
      }
    }

    this.draftSessions.delete(sessionId);
    this.sessionFiles.delete(sessionId);
    this.sessionCwd.delete(sessionId);
    this.sessionNames.delete(sessionId);
    this.sessionUsage.delete(sessionId);
    this.sessionModels.delete(sessionId);
    this.sessionThinkings.delete(sessionId);
    this.appliedPreferences.delete(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const turn = this.activeTurns.get(sessionId);
    this.failCloseSessionQuestions(sessionId);
    const client = this.processes.get(sessionId);
    this.processes.delete(sessionId);
    if (client) {
      this.clientToSession.delete(client);
      await client.close().catch(() => undefined);
    }
    if (turn && !turn.settled) {
      this.settleTurn(turn, turn.abortRequested ? 'cancelled' : 'failed', 'Pi session closed');
    }
  }

  async dispose(): Promise<void> {
    const sessionIds = new Set([...this.processes.keys(), ...this.activeTurns.keys()]);
    await Promise.allSettled([...sessionIds].map((id) => this.close(id)));
    this.processes.clear();
    this.activeTurns.clear();
    for (const [, q] of this.parkedQuestions) {
      if (q.timer) clearTimeout(q.timer);
    }
    this.parkedQuestions.clear();
  }

  // -- Internals ------------------------------------------------------------

  private createClient(cwd: string, args: string[]): PiRpcClient {
    const client = new PiRpcClient({
      piBin: this.getPiBin(),
      cwd,
      env: this.env,
      args: [...args, ...this.extraArgs],
      requestTimeoutMs: this.requestTimeoutMs,
      shutdownGraceMs: this.shutdownGraceMs,
      killGraceMs: this.killGraceMs,
      onStderr: this.onStderr,
    });
    // Persistent client-level fallback: any extension_ui_request outside an active
    // unsettled turn fails closed `{ cancelled: true }` (fire-and-forget stays a no-op).
    client.onEvent((ev) => {
      if (ev.kind === 'ui_request') {
        const sid = this.clientToSession.get(client);
        const activeTurn = sid ? this.activeTurns.get(sid) : undefined;
        if (activeTurn && !activeTurn.settled && activeTurn.client === client) {
          return;
        }
        this.failCloseExtensionUiRequest(client, ev.request);
        return;
      }
      if (ev.kind === 'exit') {
        const sid = this.clientToSession.get(client);
        this.clientToSession.delete(client);
        if (sid && this.processes.get(sid) === client) {
          this.processes.delete(sid);
        }
      }
    });
    return client;
  }

  private async ensureSessionProcess(
    sessionId: string,
    opts?: { skipModelSync?: boolean; skipThinkingSync?: boolean },
  ): Promise<PiRpcClient> {
    const existing = this.processes.get(sessionId);
    if (existing?.isAlive) {
      await this.syncSessionPreferencesToClient(existing, sessionId, undefined, opts);
      return existing;
    }
    if (existing) {
      this.processes.delete(sessionId);
      this.clientToSession.delete(existing);
      await existing.close().catch(() => undefined);
    }

    assertSafeSessionId(sessionId);
    const cwd = await this.resolveSessionCwd(sessionId);
    const existingFile = await this.locateSessionFile(sessionId);
    const args: string[] = existingFile
      ? ['--session', existingFile]
      : ['--session-id', sessionId];

    const pendingName = this.sessionNames.get(sessionId);
    if (!existingFile && pendingName) {
      args.push('--name', pendingName);
    }

    const client = this.createClient(cwd, args);
    this.clientToSession.set(client, sessionId);
    client.start();
    this.processes.set(sessionId, client);

    try {
      const initialState = await client.request<PiSessionState>({ type: 'get_state' });
      this.recordState(sessionId, initialState);
      await this.syncSessionPreferencesToClient(client, sessionId, initialState, opts);
      return client;
    } catch (err) {
      this.processes.delete(sessionId);
      this.clientToSession.delete(client);
      await client.close().catch(() => undefined);
      throw err;
    }
  }

  private async syncSessionPreferencesToClient(
    client: PiRpcClient,
    sessionId: string,
    initialState?: PiSessionState,
    opts?: { skipModelSync?: boolean; skipThinkingSync?: boolean },
  ): Promise<void> {
    const resolved = this.resolveSessionPreferences?.(sessionId);
    const desiredModel = resolved?.model ?? this.sessionModels.get(sessionId);
    const desiredThinking = resolved?.thinking ?? this.sessionThinkings.get(sessionId);
    const applied = this.appliedPreferences.get(sessionId);

    const currentModel = initialState?.model?.provider && initialState?.model?.id && initialState.model.id !== 'unknown'
      ? encodePiModelId(initialState.model.provider, initialState.model.id)
      : this.sessionModels.get(sessionId);
    const currentThinking = initialState?.thinkingLevel ?? this.sessionThinkings.get(sessionId);

    let changed = false;
    const isStartup = initialState !== undefined;
    const shouldSyncModel = Boolean(
      !opts?.skipModelSync &&
      desiredModel &&
      desiredModel !== currentModel &&
      (isStartup || desiredModel !== applied?.model),
    );
    if (shouldSyncModel && desiredModel) {
      const parsed = decodePiModelId(desiredModel, this.modelsCache?.models);
      if (parsed) {
        await client.request({ type: 'set_model', provider: parsed.provider, modelId: parsed.modelId }).catch(() => undefined);
        changed = true;
      }
    }

    const shouldSyncThinking = Boolean(
      !opts?.skipThinkingSync &&
      desiredThinking &&
      VALID_THINKING_LEVELS.has(desiredThinking) &&
      (changed || (desiredThinking !== currentThinking && (isStartup || desiredThinking !== applied?.thinking))),
    );
    if (shouldSyncThinking && desiredThinking) {
      await client.request({ type: 'set_thinking_level', level: desiredThinking }).catch(() => undefined);
      changed = true;
    }

    if (changed) {
      const refreshed = await client.request<PiSessionState>({ type: 'get_state' });
      this.recordState(sessionId, refreshed);
    }

    this.appliedPreferences.set(sessionId, {
      model: opts?.skipModelSync ? applied?.model : (desiredModel ?? applied?.model),
      thinking: opts?.skipThinkingSync ? applied?.thinking : (desiredThinking ?? applied?.thinking),
    });
  }

  private async runEphemeralRpc<T>(
    fn: (client: PiRpcClient) => Promise<T>,
    cwd?: string,
    args: string[] = ['--no-session'],
  ): Promise<T> {
    const client = this.createClient(cwd ?? process.cwd(), args);
    client.start();
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private async resolveSessionCwd(sessionId: string): Promise<string> {
    const known = this.sessionCwd.get(sessionId);
    if (known) return known;
    const file = await this.locateSessionFile(sessionId);
    if (file) {
      const realRoot = await safeRealpath(this.sessionsDir);
      if (realRoot) {
        const summary = await summarizePiSessionFile(file, realRoot);
        if (summary?.cwd) {
          this.sessionCwd.set(sessionId, summary.cwd);
          return summary.cwd;
        }
      }
    }
    return process.cwd();
  }

  private async locateSessionFile(sessionId: string): Promise<string | null> {
    const cached = this.sessionFiles.get(sessionId);
    const realRoot = await safeRealpath(this.sessionsDir);
    if (!realRoot) return null;

    if (cached && (await verifyRegularFileWithinRoot(realRoot, cached))) {
      return cached;
    }
    const matches = await findMatchingSessionFilesSafe(realRoot, sessionId);
    if (matches.length === 0) return null;
    this.sessionFiles.set(sessionId, matches[0]!);
    return matches[0]!;
  }

  private recordState(sessionId: string, state: PiSessionState): void {
    if (state.sessionFile && (state.messageCount ?? 0) > 0) {
      this.sessionFiles.set(sessionId, state.sessionFile);
      this.draftSessions.delete(sessionId);
    }
    if (state.model?.provider && state.model?.id && state.model.id !== 'unknown') {
      this.sessionModels.set(sessionId, encodePiModelId(state.model.provider, state.model.id));
    }
    if (typeof state.thinkingLevel === 'string' && state.thinkingLevel) {
      this.sessionThinkings.set(sessionId, state.thinkingLevel);
    }
    if (typeof state.sessionName === 'string' && state.sessionName.trim()) {
      this.sessionNames.set(sessionId, state.sessionName.trim());
    }
  }

  private emitToolStartedIfNeeded(
    turn: ActiveTurnState,
    toolCallId: string,
    name: string,
    ts: number,
    input?: unknown,
    parentToolCallId?: string,
  ): void {
    if (!toolCallId || turn.startedTools.has(toolCallId)) return;
    turn.startedTools.add(toolCallId);
    turn.stream.push({
      kind: 'tool',
      status: 'started',
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      timestamp: ts,
      payload: {
        toolCallId,
        name,
        ...(input !== undefined ? { input } : {}),
        ...(parentToolCallId ? { parentToolUseId: parentToolCallId } : {}),
      },
    });
  }

  private handleClientEvent(turn: ActiveTurnState, ev: PiRpcClientEvent): void {
    if (turn.settled) {
      if (ev.kind === 'ui_request') {
        this.failCloseExtensionUiRequest(turn.client, ev.request);
      }
      return;
    }

    if (ev.kind === 'exit') {
      this.failCloseSessionQuestions(turn.sessionId);
      if (this.processes.get(turn.sessionId) === turn.client) {
        this.processes.delete(turn.sessionId);
      }
      this.clientToSession.delete(turn.client);
      const reason = turn.abortRequested ? 'cancelled' : 'failed';
      const errorMsg = reason === 'failed'
        ? (ev.error?.message ?? 'Pi RPC process terminated unexpectedly')
        : undefined;
      this.settleTurn(turn, reason, errorMsg);
      return;
    }

    if (ev.kind === 'ui_request') {
      this.handleExtensionUiRequest(turn, ev.request);
      return;
    }

    const msg = ev.event;
    const type = typeof msg.type === 'string' ? msg.type : '';
    const ts = Date.now();

    switch (type) {
      case 'agent_start':
        turn.inAgentRun = true;
        turn.sawAgentStart = true;
        break;

      case 'message_start':
        if (isRecord(msg.message) && msg.message.role === 'assistant') {
          turn.streamedTextIndices.clear();
          turn.streamedThinkingIndices.clear();
        }
        break;

      case 'message_update':
        this.handleMessageUpdate(turn, msg, ts);
        break;

      case 'tool_execution_start': {
        const toolCallId = String(msg.toolCallId ?? '');
        const name = String(msg.toolName ?? 'tool');
        const parentToolCallId = typeof msg.parentToolCallId === 'string' ? msg.parentToolCallId : undefined;
        this.emitToolStartedIfNeeded(turn, toolCallId, name, ts, msg.args, parentToolCallId);
        break;
      }

      case 'tool_execution_update': {
        const toolCallId = String(msg.toolCallId ?? '');
        const name = String(msg.toolName ?? 'tool');
        if (!toolCallId) break;
        const parentToolCallId = typeof msg.parentToolCallId === 'string' ? msg.parentToolCallId : undefined;
        this.emitToolStartedIfNeeded(turn, toolCallId, name, ts, msg.args, parentToolCallId);
        const full = extractToolContentText(msg.partialResult);
        const prev = turn.lastToolPartial.get(toolCallId);
        const delta = prev !== undefined && full.startsWith(prev) ? full.slice(prev.length) : full;
        turn.lastToolPartial.set(toolCallId, full);
        if (delta) {
          turn.stream.push({
            kind: 'tool',
            status: 'delta',
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            timestamp: ts,
            payload: {
              toolCallId,
              name,
              output: delta,
              ...(parentToolCallId ? { parentToolUseId: parentToolCallId } : {}),
            },
          });
        }
        break;
      }

      case 'tool_execution_end': {
        const toolCallId = String(msg.toolCallId ?? '');
        const name = String(msg.toolName ?? 'tool');
        if (!toolCallId) break;
        const parentToolCallId = typeof msg.parentToolCallId === 'string' ? msg.parentToolCallId : undefined;
        this.emitToolStartedIfNeeded(turn, toolCallId, name, ts, undefined, parentToolCallId);
        if (!turn.endedTools.has(toolCallId)) {
          turn.endedTools.add(toolCallId);
          const isError = msg.isError === true;
          const output = extractToolContentText(msg.result);
          const structured = isRecord(msg.result) && msg.result.details !== undefined ? msg.result.details : undefined;
          turn.stream.push({
            kind: 'tool',
            status: isError ? 'failed' : 'completed',
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            timestamp: ts,
            payload: {
              toolCallId,
              name,
              output,
              ...(structured !== undefined ? { structuredOutput: structured } : {}),
              is_error: isError,
              ...(parentToolCallId ? { parentToolUseId: parentToolCallId } : {}),
            },
          });
        }
        break;
      }

      case 'message_end':
        this.handleMessageEnd(turn, msg, ts);
        break;

      case 'compaction_end':
        if (msg.aborted !== true && isRecord(msg.result)) {
          this.recordUsageAfterCompaction(turn.sessionId, msg.result);
        }
        break;

      case 'auto_retry_end':
        if (msg.success === false && typeof msg.finalError === 'string' && msg.finalError) {
          turn.lastError = msg.finalError;
        } else if (msg.success === true) {
          turn.lastError = null;
        }
        break;

      case 'extension_error':
        turn.stream.push({
          kind: 'notice',
          status: 'completed',
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          timestamp: ts,
          payload: {
            level: 'warning',
            code: 'extension_error',
            message: `Extension error (${String(msg.event ?? 'unknown')}): ${String(msg.error ?? '')}`,
          },
        });
        break;

      case 'session_info_changed':
        if (typeof msg.name === 'string' && msg.name.trim()) {
          this.sessionNames.set(turn.sessionId, msg.name.trim());
        } else {
          this.sessionNames.delete(turn.sessionId);
        }
        break;

      case 'thinking_level_changed':
        if (typeof msg.level === 'string' && msg.level) {
          this.sessionThinkings.set(turn.sessionId, msg.level);
        }
        break;

      case 'agent_end':
        // `agent_end` only ends one low-level loop; retries/compaction/queued turns
        // can continue until `agent_settled`. Update lastAssistantMessage fallback only.
        if (Array.isArray(msg.messages)) {
          for (let i = msg.messages.length - 1; i >= 0; i--) {
            const candidate = msg.messages[i];
            if (isRecord(candidate) && candidate.role === 'assistant') {
              turn.lastAssistantMessage = candidate;
              break;
            }
          }
        }
        break;

      case 'agent_settled': {
        turn.inAgentRun = false;
        this.draftSessions.delete(turn.sessionId);
        const aborted = msg.aborted === true || turn.abortRequested || turn.lastAssistantMessage?.stopReason === 'aborted';
        if (aborted) {
          this.settleTurn(turn, 'cancelled');
          break;
        }
        const stopReason = typeof turn.lastAssistantMessage?.stopReason === 'string'
          ? turn.lastAssistantMessage.stopReason
          : undefined;
        const msgErr = typeof turn.lastAssistantMessage?.errorMessage === 'string'
          ? turn.lastAssistantMessage.errorMessage
          : undefined;
        if (stopReason === 'error' || (msgErr && msgErr.length > 0) || turn.lastError) {
          this.settleTurn(turn, 'failed', msgErr || turn.lastError || 'Pi turn failed');
        } else {
          this.settleTurn(turn, 'completed');
        }
        break;
      }

      default:
        break;
    }
  }

  private handleMessageUpdate(turn: ActiveTurnState, msg: Record<string, unknown>, ts: number): void {
    const ame = isRecord(msg.assistantMessageEvent) ? msg.assistantMessageEvent : null;
    if (!ame) return;
    const ameType = typeof ame.type === 'string' ? ame.type : '';
    const idx = typeof ame.contentIndex === 'number' ? ame.contentIndex : 0;

    switch (ameType) {
      case 'text_delta': {
        const delta = typeof ame.delta === 'string' ? ame.delta : '';
        if (!delta) break;
        turn.streamedTextIndices.add(idx);
        turn.stream.push({
          kind: 'message',
          status: 'delta',
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          timestamp: ts,
          payload: { delta, message: emptyAssistantMessage(turn.sessionId) },
        });
        break;
      }
      case 'text_end': {
        if (!turn.streamedTextIndices.has(idx) && typeof ame.content === 'string' && ame.content.length > 0) {
          turn.streamedTextIndices.add(idx);
          turn.stream.push({
            kind: 'message',
            status: 'delta',
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            timestamp: ts,
            payload: { delta: ame.content, message: emptyAssistantMessage(turn.sessionId) },
          });
        }
        break;
      }
      case 'thinking_delta': {
        const delta = typeof ame.delta === 'string' ? ame.delta : '';
        if (!delta) break;
        turn.streamedThinkingIndices.add(idx);
        turn.stream.push({
          kind: 'thinking',
          status: 'delta',
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          timestamp: ts,
          payload: { text: '', delta },
        });
        break;
      }
      case 'thinking_end': {
        if (!turn.streamedThinkingIndices.has(idx) && typeof ame.content === 'string' && ame.content.length > 0) {
          turn.streamedThinkingIndices.add(idx);
          turn.stream.push({
            kind: 'thinking',
            status: 'delta',
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            timestamp: ts,
            payload: { text: '', delta: ame.content },
          });
        }
        break;
      }
      case 'error': {
        if (isRecord(ame.error)) {
          turn.lastAssistantMessage = ame.error;
          if (typeof ame.error.errorMessage === 'string' && ame.error.errorMessage) {
            turn.lastError = ame.error.errorMessage;
          }
        }
        break;
      }
      default:
        // toolcall_start / toolcall_delta / toolcall_end are represented authoritatively
        // via tool_execution_start / tool_execution_update / tool_execution_end once executed.
        break;
    }
  }

  private handleMessageEnd(turn: ActiveTurnState, msg: Record<string, unknown>, ts: number): void {
    const message = isRecord(msg.message) ? msg.message : null;
    if (!message) return;
    const role = typeof message.role === 'string' ? message.role : '';

    if (role === 'assistant') {
      turn.lastAssistantMessage = message;
      if (message.stopReason !== 'error' && message.stopReason !== 'aborted') {
        turn.lastError = null;
      }
      this.recordUsageFromAssistantMessage(turn.sessionId, message);

      // Deduplicated fallback: emit text/thinking only if no streaming deltas arrived for them.
      if (Array.isArray(message.content)) {
        const emitFallbackText = turn.streamedTextIndices.size === 0;
        const emitFallbackThinking = turn.streamedThinkingIndices.size === 0;
        for (const block of message.content) {
          if (!isRecord(block)) continue;
          if (block.type === 'thinking' && emitFallbackThinking && typeof block.thinking === 'string' && block.thinking) {
            turn.stream.push({
              kind: 'thinking',
              status: 'delta',
              sessionId: turn.sessionId,
              turnId: turn.turnId,
              timestamp: ts,
              payload: { text: '', delta: block.thinking },
            });
          } else if (block.type === 'text' && emitFallbackText && typeof block.text === 'string' && block.text) {
            turn.stream.push({
              kind: 'message',
              status: 'delta',
              sessionId: turn.sessionId,
              turnId: turn.turnId,
              timestamp: ts,
              payload: { delta: block.text, message: emptyAssistantMessage(turn.sessionId) },
            });
          }
        }
      }
      turn.streamedTextIndices.clear();
      turn.streamedThinkingIndices.clear();
      return;
    }

    if (role === 'toolResult') {
      const toolCallId = String(message.toolCallId ?? '');
      if (!toolCallId || turn.endedTools.has(toolCallId)) return;
      const toolName = String(message.toolName ?? 'tool');
      this.emitToolStartedIfNeeded(turn, toolCallId, toolName, ts);
      turn.endedTools.add(toolCallId);
      const isError = message.isError === true;
      turn.stream.push({
        kind: 'tool',
        status: isError ? 'failed' : 'completed',
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        timestamp: ts,
        payload: {
          toolCallId,
          name: toolName,
          output: extractToolContentText(message),
          is_error: isError,
        },
      });
    }
  }

  private recordUsageAfterCompaction(sessionId: string, result: Record<string, unknown>): void {
    const prev = this.sessionUsage.get(sessionId);
    const usage = isRecord(result.usage) ? result.usage : null;
    const costObj = usage && isRecord(usage.cost) ? usage.cost : null;
    const input = usage ? num(usage.input) : 0;
    const output = usage ? num(usage.output) : 0;
    const cacheRead = usage ? num(usage.cacheRead) : 0;
    const cacheWrite = usage ? num(usage.cacheWrite) : 0;
    const costTotal = costObj ? num(costObj.total) : 0;
    const contextLimit = prev?.context_limit
      || lookupPiContextWindow(this.sessionModels.get(sessionId), this.modelsCache?.models);

    // After compaction, Pi's actual context token count is unknown until a fresh
    // post-compaction assistant response supplies usage (`context_unavailable: true`).
    this.sessionUsage.set(sessionId, {
      input_tokens: (prev?.input_tokens ?? 0) + input,
      output_tokens: (prev?.output_tokens ?? 0) + output,
      cache_read_tokens: (prev?.cache_read_tokens ?? 0) + cacheRead,
      cache_creation_tokens: (prev?.cache_creation_tokens ?? 0) + cacheWrite,
      total_cost_usd: (prev?.total_cost_usd ?? 0) + costTotal,
      context_tokens: 0,
      context_limit: contextLimit,
      turn_count: prev?.turn_count ?? 0,
      ...(prev?.reasoning_output_tokens !== undefined ? { reasoning_output_tokens: prev.reasoning_output_tokens } : {}),
      authoritative: true,
      context_unavailable: true,
    });
  }

  private recordUsageFromAssistantMessage(sessionId: string, message: Record<string, unknown>): void {
    const usage = isRecord(message.usage) ? message.usage : null;
    if (!usage) return;
    const prev = this.sessionUsage.get(sessionId);
    const input = num(usage.input);
    const output = num(usage.output);
    const cacheRead = num(usage.cacheRead);
    const cacheWrite = num(usage.cacheWrite);
    const costObj = isRecord(usage.cost) ? usage.cost : null;
    const costTotal = costObj ? num(costObj.total) : 0;
    const contextTokens = input + output + cacheRead + cacheWrite;
    const modelId = typeof message.provider === 'string' && typeof message.model === 'string'
      ? encodePiModelId(message.provider, message.model)
      : this.sessionModels.get(sessionId);
    const contextLimit = prev?.context_limit
      || lookupPiContextWindow(modelId, this.modelsCache?.models);

    this.sessionUsage.set(sessionId, {
      input_tokens: (prev?.input_tokens ?? 0) + input,
      output_tokens: (prev?.output_tokens ?? 0) + output,
      cache_read_tokens: (prev?.cache_read_tokens ?? 0) + cacheRead,
      cache_creation_tokens: (prev?.cache_creation_tokens ?? 0) + cacheWrite,
      total_cost_usd: (prev?.total_cost_usd ?? 0) + costTotal,
      context_tokens: contextTokens,
      context_limit: contextLimit,
      turn_count: (prev?.turn_count ?? 0) + 1,
      ...(typeof usage.reasoning === 'number' ? { reasoning_output_tokens: (prev?.reasoning_output_tokens ?? 0) + usage.reasoning } : {}),
      authoritative: false,
      ...(contextLimit <= 0 && contextTokens <= 0 ? { context_unavailable: true } : { context_unavailable: false }),
    });
  }

  private failCloseExtensionUiRequest(client: PiRpcClient, req: Record<string, unknown>): void {
    const method = typeof req.method === 'string' ? req.method : '';
    const id = typeof req.id === 'string' ? req.id : '';
    if (!id || FIRE_AND_FORGET_UI_METHODS.has(method)) return;
    if (client.canWriteStdin) {
      void client.sendExtensionUiResponse({ type: 'extension_ui_response', id, cancelled: true }).catch(() => undefined);
    }
  }

  private handleExtensionUiRequest(turn: ActiveTurnState, req: Record<string, unknown>): void {
    const method = typeof req.method === 'string' ? req.method : '';
    const id = typeof req.id === 'string' ? req.id : '';

    if (FIRE_AND_FORGET_UI_METHODS.has(method)) {
      if (method === 'notify' && typeof req.message === 'string' && req.message) {
        const level = req.notifyType === 'warning' || req.notifyType === 'error' ? req.notifyType : 'info';
        turn.stream.push({
          kind: 'notice',
          status: 'completed',
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          timestamp: Date.now(),
          payload: { level, message: req.message, code: 'extension_notify' },
        });
      }
      return;
    }

    if (!id) return;

    // Unsupported UI dialogs (including `editor`) and aborted/unwritable turns fail closed.
    if (
      (method !== 'select' && method !== 'confirm' && method !== 'input') ||
      turn.abortRequested ||
      !turn.client.canWriteStdin
    ) {
      this.failCloseExtensionUiRequest(turn.client, req);
      return;
    }

    const title = typeof req.title === 'string' ? req.title : '';
    let promptText = title;
    let options: string[] | undefined;
    let rawQuestions: unknown[];

    if (method === 'select') {
      const validOptions = Array.isArray(req.options)
        ? req.options.filter((o): o is string => typeof o === 'string')
        : [];
      if (validOptions.length === 0) {
        this.failCloseExtensionUiRequest(turn.client, req);
        return;
      }
      options = validOptions;
      rawQuestions = [
        {
          id: 'q_0',
          question: title || 'Select an option',
          header: title || 'Select',
          options: validOptions.map((opt) => ({ id: opt, label: opt })),
        },
      ];
    } else if (method === 'confirm') {
      const msgBody = typeof req.message === 'string' ? req.message : '';
      promptText = msgBody ? (title ? `${title}\n${msgBody}` : msgBody) : title || 'Confirm';
      options = ['Yes', 'No'];
      rawQuestions = [
        {
          id: 'q_0',
          question: promptText,
          header: title || 'Confirm',
          options: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
        },
      ];
    } else {
      const placeholder = typeof req.placeholder === 'string' && req.placeholder ? req.placeholder : undefined;
      promptText = placeholder ? (title ? `${title} (${placeholder})` : placeholder) : title || 'Input';
      rawQuestions = [
        {
          id: 'q_0',
          question: promptText,
          header: title || 'Input',
          options: [],
          isOther: true,
        },
      ];
    }

    const reqTimeout = typeof req.timeout === 'number' && Number.isFinite(req.timeout) && req.timeout > 0
      ? req.timeout
      : 0;
    const effectiveTimeout = reqTimeout > 0
      ? (this.dialogTimeoutMs > 0 ? Math.min(reqTimeout, this.dialogTimeoutMs) : reqTimeout)
      : this.dialogTimeoutMs;

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (effectiveTimeout > 0) {
      timer = setTimeout(() => {
        const entry = this.parkedQuestions.get(id);
        if (!entry) return;
        this.parkedQuestions.delete(id);
        if (turn.client.canWriteStdin) {
          void turn.client.sendExtensionUiResponse({ type: 'extension_ui_response', id, cancelled: true }).catch(() => undefined);
        }
        if (!turn.settled) {
          turn.stream.push({
            kind: 'interaction_resolved',
            status: 'cancelled',
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            timestamp: Date.now(),
            payload: { interactionId: id, interactionKind: 'question', resolution: 'cancelled' },
          });
        }
      }, effectiveTimeout);
      timer.unref?.();
    }

    this.parkedQuestions.set(id, {
      id,
      sessionId: turn.sessionId,
      method,
      options,
      timer,
      stream: turn.stream,
      turnId: turn.turnId,
    });

    turn.stream.push({
      kind: 'question',
      status: 'started',
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      timestamp: Date.now(),
      payload: {
        questionId: id,
        prompt: promptText,
        ...(options ? { options } : {}),
        isBlocking: true,
        rawQuestions,
      },
    });
  }

  private failCloseSessionQuestions(sessionId: string): void {
    const client = this.processes.get(sessionId);
    for (const [qid, parked] of [...this.parkedQuestions.entries()]) {
      if (parked.sessionId !== sessionId) continue;
      this.parkedQuestions.delete(qid);
      if (parked.timer) clearTimeout(parked.timer);
      if (client?.canWriteStdin) {
        void client.sendExtensionUiResponse({ type: 'extension_ui_response', id: parked.id, cancelled: true }).catch(() => undefined);
      }
      parked.stream.push({
        kind: 'interaction_resolved',
        status: 'cancelled',
        sessionId,
        turnId: parked.turnId,
        timestamp: Date.now(),
        payload: { interactionId: qid, interactionKind: 'question', resolution: 'cancelled' },
      });
    }
  }

  private settleTurn(
    turn: ActiveTurnState,
    reason: 'completed' | 'cancelled' | 'failed',
    error?: string,
  ): void {
    if (turn.settled) return;
    turn.settled = true;
    this.cleanupTurn(turn);

    turn.stream.push({
      kind: 'turn',
      status: reason,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      timestamp: Date.now(),
      payload: {
        reason,
        ...(reason === 'failed' && error ? { error } : {}),
      },
    });
    turn.stream.end();
  }

  private cleanupTurn(turn: ActiveTurnState): void {
    turn.unsubscribe?.();
    turn.unsubscribe = null;
    if (this.activeTurns.get(turn.sessionId) === turn) {
      this.activeTurns.delete(turn.sessionId);
    }
    this.failCloseSessionQuestions(turn.sessionId);
  }
}

// ---------------------------------------------------------------------------
// PiProviderAdapter — unified gateway ProviderAdapter
// ---------------------------------------------------------------------------

export class PiProviderAdapter implements ProviderAdapter {
  readonly name = 'pi' as ProviderName;
  private readonly inner: PiAdapter;
  private readonly settings: SettingsStore;
  private readonly renames = new Map<string, string>();
  private readonly sessionCwd = new Map<string, string>();

  constructor(options?: PiAdapterOptions) {
    this.settings = new SettingsStore(options?.settingsPath);
    this.inner = new PiAdapter({
      ...options,
      resolveSessionPreferences: (sessionId) => ({
        model: this.settings.getString('model', sessionId) ?? this.settings.getString('model', '__default__'),
        thinking: this.settings.getString('thinking', sessionId) ?? this.settings.getString('thinking', '__default__'),
      }),
    });
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      thinking: true,
      tools: true,
      approvals: false,
      questions: true,
      interrupt: true,
      history: true,
      steer: true,
      steerAttachments: true,
      attachments: true,
      compact: true,
      fork: true,
      clone: true,
      rollback: false,
      rename: true,
      archive: true,
      nativeArchive: false,
      delete: true,
      planMode: false,
      manualApproval: false,
      goals: false,
      swarm: false,
      tower: false,
      btw: false,
      models: true,
      thinkingLevels: true,
      commands: true,
      skills: true,
      usage: true,
      elicitation: false,
    };
  }

  async list(query: ListSessionsQuery = {}): Promise<SessionPage> {
    const sessions = (await this.inner.list(query.cwd)).filter((s) => {
      const isArchived = this.settings.getBoolean('archived', s.sessionId) === true;
      return query.archived === true ? isArchived : !isArchived;
    });

    const start = query.cursor ? sessions.findIndex((s) => s.sessionId === query.cursor) + 1 : 0;
    if (query.cursor && start === 0) return { items: [] };

    const limit = Math.max(1, query.limit ?? 50);
    const page = sessions.slice(start, start + limit);
    const items = page.map((s) => this.toSession(s));
    return {
      items,
      ...(start + limit < sessions.length && page.length > 0
        ? { next_cursor: page[page.length - 1]!.sessionId }
        : {}),
    };
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const cwd = input.cwd ?? (input.metadata?.cwd as string | undefined) ?? process.cwd();
    const { sessionId, cwd: resolvedCwd } = this.inner.create(cwd, input.title);
    this.sessionCwd.set(sessionId, resolvedCwd);
    const title = input.title?.trim() || `Pi ${sessionId.slice(0, 8)}`;
    const now = nowIso();
    return {
      id: sessionId,
      workspace_id: workspaceIdFromCwd(resolvedCwd, 'pi'),
      title,
      created_at: now,
      updated_at: now,
      busy: false,
      metadata: { cwd: resolvedCwd },
      provider: this.name,
    };
  }

  async getHistory(sessionId: string, _query: HistoryQuery = {}): Promise<Message[]> {
    return this.inner.getHistory(sessionId);
  }

  async startTurn(input: StartTurnInput): Promise<TurnHandle> {
    const { turnId, events } = await this.inner.startTurn(
      input.sessionId,
      input.input,
      input.attachments ?? [],
    );
    return { turnId, events };
  }

  async interrupt(sessionId: string, _turnId?: string): Promise<void> {
    await this.inner.abort(sessionId);
  }

  async steer(
    sessionId: string,
    _turnId: string,
    input: string | MessageContentPart[] | SteerInput,
    attachments?: TurnAttachment[],
  ): Promise<void> {
    await this.inner.steer(sessionId, input, attachments ?? []);
  }

  async resolveApproval(
    _sessionId: string,
    _approvalId: string,
    _decision: ApprovalDecision,
    _details?: GranularApprovalDetails,
  ): Promise<void> {
    throw new ProviderError('unsupported', 'Pi RPC mode does not support manual tool approvals', 400);
  }

  async resolveQuestion(
    sessionId: string,
    questionId: string,
    answer: string | Record<string, string[]>,
  ): Promise<void> {
    await this.inner.resolveQuestion(sessionId, questionId, answer);
  }

  async listModels(): Promise<NativeModel[]> {
    const models = await this.inner.getAvailableModels();
    return models.map((m) => {
      const encoded = encodePiModelId(m.provider, m.id);
      const levels = piModelSupportedThinkingLevels(m);
      const caps: string[] = [];
      if (Array.isArray(m.input) && m.input.includes('image')) caps.push('vision');
      if (m.reasoning) caps.push('thinking');
      return {
        provider: 'pi',
        model: encoded,
        display_name: m.name ? `${m.name} (${m.provider})` : encoded,
        max_context_size: num(m.contextWindow),
        ...(typeof m.maxTokens === 'number' && m.maxTokens > 0 ? { max_output_tokens: m.maxTokens } : {}),
        capabilities: caps,
        support_efforts: levels,
        supportsThinkingOff: levels.includes('off'),
        ...(levels.length > 0 ? { default_effort: levels.includes('medium') ? 'medium' : levels[0] } : {}),
        raw: m,
      };
    });
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    if (sessionId === '__default__') {
      this.settings.set('model', '__default__', model);
      return;
    }
    const resolved = await this.inner.setModel(sessionId, model);
    const encoded = encodePiModelId(resolved.provider, resolved.id);
    this.settings.set('model', sessionId, encoded);
  }

  getModel(sessionId: string): string | undefined {
    return (
      this.inner.getCachedModel(sessionId) ??
      this.settings.getString('model', sessionId) ??
      this.settings.getString('model', '__default__')
    );
  }

  async listThinkingLevels(sessionId: string): Promise<string[]> {
    return this.inner.getAvailableThinkingLevels(sessionId);
  }

  async setThinking(sessionId: string, thinking: string): Promise<void> {
    if (sessionId === '__default__') {
      const normalized = thinking.trim();
      if (!VALID_THINKING_LEVELS.has(normalized)) {
        throw new ProviderError('invalid_request', `Unsupported thinking level: ${thinking}`, 400);
      }
      this.settings.set('thinking', '__default__', normalized);
      return;
    }
    const effective = await this.inner.setThinkingLevel(sessionId, thinking);
    this.settings.set('thinking', sessionId, effective);
  }

  getThinking(sessionId: string): string | undefined {
    return (
      this.inner.getCachedThinking(sessionId) ??
      this.settings.getString('thinking', sessionId) ??
      this.settings.getString('thinking', '__default__')
    );
  }

  async listCommands(sessionId?: string): Promise<NativeCommand[]> {
    const cmds = await this.inner.getCommands(sessionId);
    return listPiCommands(cmds);
  }

  async listSkills(sessionId?: string): Promise<Array<{ name: string; description: string; path?: string; scope?: string; enabled?: boolean }>> {
    const cmds = await this.inner.getCommands(sessionId);
    const out: Array<{ name: string; description: string; path?: string; scope?: string; enabled?: boolean }> = [];
    const seen = new Set<string>();
    for (const cmd of cmds) {
      if (cmd.source !== 'skill' || !cmd.name || seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      const cmdPath = cmd.path ?? cmd.sourceInfo?.path;
      const scope = cmd.scope ?? cmd.sourceInfo?.scope;
      out.push({
        name: cmd.name,
        description: cmd.description || cmd.name,
        ...(cmdPath ? { path: cmdPath } : {}),
        ...(scope ? { scope } : {}),
        enabled: true,
      });
    }
    return out;
  }

  async compact(sessionId: string, customInstructions?: string): Promise<void> {
    await this.inner.compact(sessionId, customInstructions);
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const trimmed = title.replace(/[\r\n]+/g, ' ').trim();
    if (!trimmed) {
      throw new ProviderError('invalid_request', 'Session title cannot be empty', 400);
    }
    this.renames.set(sessionId, trimmed);
    await this.inner.setSessionName(sessionId, trimmed);
  }

  async clone(sessionId: string): Promise<Session> {
    const cloned = await this.inner.clone(sessionId);
    this.sessionCwd.set(cloned.sessionId, cloned.cwd);
    this.settings.copySession(sessionId, cloned.sessionId);
    return this.toSession(cloned);
  }

  async fork(sessionId: string): Promise<Session> {
    const forked = await this.inner.fork(sessionId);
    this.sessionCwd.set(forked.sessionId, forked.cwd);
    this.settings.copySession(sessionId, forked.sessionId);
    return this.toSession(forked);
  }

  async rollback(_sessionId: string, _numTurns: number): Promise<void> {
    throw new ProviderError('unsupported', 'Pi does not support undo/rollback', 400);
  }

  async setGoal(): Promise<Record<string, unknown> | null> {
    throw new ProviderError('unsupported', 'Pi does not support goal operations', 400);
  }

  async getGoal(): Promise<Record<string, unknown> | null> {
    throw new ProviderError('unsupported', 'Pi does not support goal operations', 400);
  }

  async controlGoal(): Promise<Record<string, unknown> | null> {
    throw new ProviderError('unsupported', 'Pi does not support goal operations', 400);
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    if (archived) this.settings.set('archived', sessionId, true);
    else this.settings.delete('archived', sessionId);
  }

  async delete(sessionId: string): Promise<void> {
    await this.inner.delete(sessionId);
    this.renames.delete(sessionId);
    this.sessionCwd.delete(sessionId);
    this.settings.delete('model', sessionId);
    this.settings.delete('thinking', sessionId);
    this.settings.delete('archived', sessionId);
  }

  getUsage(sessionId: string): SessionUsage | undefined {
    return this.inner.getCachedUsage(sessionId);
  }

  async refreshUsage(sessionId: string): Promise<SessionUsage> {
    return this.inner.refreshUsage(sessionId);
  }

  getCwd(sessionId: string): string | undefined {
    return this.sessionCwd.get(sessionId) ?? this.inner.getCwd(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    await this.inner.close(sessionId);
  }

  async dispose(): Promise<void> {
    await this.inner.dispose();
    this.settings.close();
  }

  private toSession(s: PiSessionSummary): Session {
    if (s.cwd) this.sessionCwd.set(s.sessionId, s.cwd);
    const title =
      this.renames.get(s.sessionId) ??
      this.inner.getCachedSessionName(s.sessionId) ??
      (s.title || `Pi ${s.sessionId.slice(0, 8)}`);
    const archived = this.settings.getBoolean('archived', s.sessionId) === true;
    return {
      id: s.sessionId,
      workspace_id: workspaceIdFromCwd(s.cwd, 'pi'),
      title,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
      busy: this.inner.isBusy(s.sessionId),
      archived,
      extras: {
        last_prompt: title,
        ...(s.parentSession ? { parent_session: s.parentSession } : {}),
      },
      metadata: { cwd: s.cwd },
      provider: this.name,
    };
  }
}

// ---------------------------------------------------------------------------
// Exported Helpers (reversible model encoding, cwd encoding, history reader)
// ---------------------------------------------------------------------------

/**
 * Reversibly encode `(provider, modelId)` into a single wire string.
 * Providers containing `/` or `%` escape them so decoding on the first `/` is exact,
 * while ordinary providers remain plain `provider/modelId` (even when `modelId` contains `/`).
 */
export function encodePiModelId(provider: string, modelId: string): string {
  const safeProvider = provider.includes('%') || provider.includes('/')
    ? provider.replaceAll('%', '%25').replaceAll('/', '%2F')
    : provider;
  return `${safeProvider}/${modelId}`;
}

export function decodePiModelId(
  encoded: string,
  knownModels?: PiModelInfo[],
): { provider: string; modelId: string } | null {
  const trimmed = encoded.trim();
  if (!trimmed) return null;

  if (knownModels && knownModels.length > 0) {
    const exactEncoded = knownModels.find(
      (m) => encodePiModelId(m.provider, m.id) === trimmed || `${m.provider}/${m.id}` === trimmed,
    );
    if (exactEncoded) {
      return { provider: exactEncoded.provider, modelId: exactEncoded.id };
    }
  }

  const slash = trimmed.indexOf('/');
  if (slash > 0 && slash < trimmed.length - 1) {
    const rawProvider = trimmed.slice(0, slash);
    const modelId = trimmed.slice(slash + 1);
    const provider = decodePercentProvider(rawProvider);
    if (provider && modelId) {
      return { provider, modelId };
    }
  }

  if (knownModels && knownModels.length > 0) {
    const byId = knownModels.filter((m) => m.id === trimmed);
    if (byId.length === 1) {
      return { provider: byId[0]!.provider, modelId: byId[0]!.id };
    }
  }

  return null;
}

/**
 * Compute Pi's encoded session directory name for a working directory:
 * `--<cwd-without-leading-sep-with-slashes-replaced-by-dash>--`.
 */
export function encodePiCwdDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

export function piModelSupportedThinkingLevels(model: PiModelInfo): string[] {
  if (!model.reasoning) {
    const map = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : null;
    return map && map.off === null ? [] : ['off'];
  }
  const map = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : null;
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = map ? map[level] : undefined;
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

export function mapPiStatsToUsage(
  stats: PiSessionStats,
  activeModelId?: string,
  knownModels?: PiModelInfo[],
): SessionUsage {
  const tokens = stats.tokens ?? {};
  const ctx = stats.contextUsage;
  const fallbackLimit = lookupPiContextWindow(activeModelId, knownModels);
  const contextUnavailable =
    !ctx ||
    ctx.tokens === null ||
    ctx.tokens === undefined ||
    typeof ctx.tokens !== 'number' ||
    !Number.isFinite(ctx.tokens);

  return {
    input_tokens: num(tokens.input),
    output_tokens: num(tokens.output),
    cache_read_tokens: num(tokens.cacheRead),
    cache_creation_tokens: num(tokens.cacheWrite),
    total_cost_usd: num(stats.cost),
    context_tokens: contextUnavailable ? 0 : num(ctx?.tokens),
    context_limit: ctx && typeof ctx.contextWindow === 'number' && ctx.contextWindow > 0
      ? ctx.contextWindow
      : fallbackLimit,
    turn_count: num(stats.assistantMessages) || num(stats.userMessages),
    authoritative: true,
    context_unavailable: contextUnavailable,
  };
}

export interface ReadPiHistoryOptions {
  sessionId: string;
  sessionsRoot?: string;
  maxTailBytes?: number;
  leafId?: string | null;
}

/**
 * 16 MiB tail-windowed, `O_NOFOLLOW`-guarded active-branch (`leafId`/`parentId`)
 * JSONL history reader for Pi sessions.
 */
export async function readPiActiveBranchHistory(
  filePath: string,
  options: ReadPiHistoryOptions,
): Promise<Message[]> {
  const maxTailBytes = Math.max(1024, options.maxTailBytes ?? DEFAULT_HISTORY_TAIL_BYTES);
  const resolvedRoot = options.sessionsRoot
    ? ((await safeRealpath(options.sessionsRoot)) ?? path.resolve(options.sessionsRoot))
    : undefined;
  const rawLines = await readTailWindowLinesNoFollow(filePath, maxTailBytes, resolvedRoot, options.sessionsRoot);

  const entriesById = new Map<string, Record<string, unknown>>();
  let lastEntryId: string | null = null;
  let legacySeq = 0;

  for (const line of rawLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type === 'session') continue;
    let entry: Record<string, unknown> = parsed;
    let id = typeof entry.id === 'string' ? entry.id : '';
    if (!id) {
      // Legacy v1 sessions had linear entries without id/parentId.
      id = `legacy_${++legacySeq}`;
      entry = { ...entry, id, parentId: lastEntryId };
    }
    entriesById.set(id, entry);
    lastEntryId = id;
  }

  const targetLeafId = options.leafId === undefined ? lastEntryId : options.leafId;
  if (!targetLeafId) return [];

  // Walk from leaf back to root via parentId (excluding abandoned sibling branches).
  const activeBranch: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let curId: string | null = targetLeafId;
  while (curId && !visited.has(curId)) {
    visited.add(curId);
    const entry = entriesById.get(curId);
    if (!entry) break;
    activeBranch.push(entry);
    curId = typeof entry.parentId === 'string' && entry.parentId ? entry.parentId : null;
  }
  activeBranch.reverse();

  // Apply latest context_edit per targetId on the active branch.
  const editsByTarget = new Map<string, Record<string, unknown>>();
  for (const entry of activeBranch) {
    if (entry.type === 'context_edit' && typeof entry.targetId === 'string') {
      editsByTarget.set(entry.targetId, entry);
    }
  }

  const messages: Message[] = [];
  for (const entry of activeBranch) {
    const entryId = String(entry.id);
    const edit = editsByTarget.get(entryId);
    if (edit && edit.replacement === null) continue;

    const mapped = mapPiHistoryEntry(entry, options.sessionId, edit);
    if (mapped) messages.push(mapped);
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

export function resolvePiBin(piBin?: string, env?: Record<string, string | undefined>): string {
  const explicit = piBin?.trim();
  if (explicit) return explicit;

  const fromEnv = (env?.PI_BIN ?? process.env.PI_BIN)?.trim();
  if (fromEnv) return fromEnv;

  const homeDir = env?.HOME ?? process.env.HOME ?? os.homedir();
  const localPi = path.join(homeDir, '.local', 'bin', 'pi');
  try {
    fs.accessSync(localPi, fsConstants.X_OK);
    return localPi;
  } catch {
    // Fall back to PATH lookup.
  }

  return 'pi';
}

export function buildPiChildEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const merged: Record<string, string | undefined> = { ...process.env, ...(extraEnv ?? {}) };
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    if (key.startsWith('GATEWAY_')) continue;
    clean[key] = value;
  }
  const hasProxy = Boolean(
    clean.HTTP_PROXY || clean.http_proxy || clean.HTTPS_PROXY || clean.https_proxy || clean.ALL_PROXY || clean.all_proxy,
  );
  if (hasProxy) {
    const extra = ['127.0.0.1', 'localhost', '::1'];
    const current = String(clean.NO_PROXY ?? clean.no_proxy ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const noProxy = [...new Set([...current, ...extra])].join(',');
    clean.NO_PROXY = noProxy;
    clean.no_proxy = noProxy;
  }
  return clean;
}

function resolveDefaultPiSessionsDir(env: Record<string, string | undefined>): string {
  const agentDirEnv = (env.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR)?.trim();
  const homeDir = env.HOME ?? process.env.HOME ?? os.homedir();
  if (agentDirEnv) {
    const expanded = agentDirEnv === '~'
      ? homeDir
      : agentDirEnv.startsWith('~/')
        ? path.join(homeDir, agentDirEnv.slice(2))
        : agentDirEnv;
    return path.join(path.resolve(expanded), 'sessions');
  }
  return path.join(homeDir, '.pi', 'agent', 'sessions');
}

function assertSafeSessionId(sessionId: string): void {
  if (!sessionId || !VALID_SESSION_ID_RE.test(sessionId) || sessionId.includes('..')) {
    throw new ProviderError('not_found', `pi-adapter: session not found: ${sessionId}`, 404);
  }
}

function isPathWithin(realParent: string, realTarget: string): boolean {
  if (realTarget === realParent) return true;
  const prefix = realParent.endsWith(path.sep) ? realParent : `${realParent}${path.sep}`;
  return realTarget.startsWith(prefix);
}

async function safeRealpath(targetPath: string): Promise<string | null> {
  try {
    return await fsp.realpath(targetPath);
  } catch {
    return null;
  }
}

async function verifyDirInsideRoot(realRoot: string, candidateDir: string): Promise<string | null> {
  try {
    const lst = await fsp.lstat(candidateDir);
    if (lst.isSymbolicLink() || !lst.isDirectory()) return null;
    const realDir = await fsp.realpath(candidateDir);
    return isPathWithin(realRoot, realDir) ? realDir : null;
  } catch {
    return null;
  }
}

function splitSafeSegments(rel: string): string[] {
  if (!rel || rel === '.') return [];
  const parts = rel.split(path.sep).filter(Boolean);
  for (const seg of parts) {
    if (seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\') || seg.includes('\0')) {
      throw new ProviderError('not_found', `pi-adapter: invalid path segment`, 404);
    }
  }
  return parts;
}

async function openAnchoredParentDir(
  filePath: string,
  expectedRoot?: string,
  rawRoot?: string,
): Promise<{ anchoredPath: string; close: () => Promise<void> }> {
  const resolvedFile = path.resolve(filePath);
  if (expectedRoot) {
    const realRoot = (await safeRealpath(expectedRoot)) ?? path.resolve(expectedRoot);
    const resolvedRawRoot = rawRoot ? path.resolve(rawRoot) : undefined;
    let rel: string | null = null;
    if (isPathWithin(realRoot, resolvedFile)) {
      rel = path.relative(realRoot, resolvedFile);
    } else if (resolvedRawRoot && isPathWithin(resolvedRawRoot, resolvedFile)) {
      rel = path.relative(resolvedRawRoot, resolvedFile);
    }
    if (rel === null) {
      throw new ProviderError('not_found', `pi-adapter: invalid or outside-root session path`, 404);
    }
    const segments = splitSafeSegments(rel);
    if (segments.length === 0) {
      throw new ProviderError('not_found', `pi-adapter: invalid session file path`, 404);
    }

    if (HAS_PROC_SELF_FD) {
      const baseLst = await fsp.lstat(realRoot).catch(() => {
        throw new ProviderError('not_found', `pi-adapter: session root not found`, 404);
      });
      if (!baseLst.isDirectory()) {
        throw new ProviderError('not_found', `pi-adapter: session root is not a directory`, 404);
      }
      const baseFd = await fsp.open(realRoot, OPEN_DIR_FLAGS).catch(() => {
        throw new ProviderError('not_found', `pi-adapter: cannot open session root`, 404);
      });
      let curFd: fsp.FileHandle = baseFd;
      try {
        const baseSt = await baseFd.stat();
        if (!baseSt.isDirectory() || baseSt.dev !== baseLst.dev || baseSt.ino !== baseLst.ino) {
          throw new ProviderError('not_found', `pi-adapter: session root changed during open`, 404);
        }
        for (let i = 0; i < segments.length - 1; i += 1) {
          const seg = segments[i]!;
          const nextFd = await fsp.open(`/proc/self/fd/${curFd.fd}/${seg}`, OPEN_DIR_FLAGS).catch(() => {
            throw new ProviderError('not_found', `pi-adapter: invalid or symlinked session directory`, 404);
          });
          await curFd.close().catch(() => undefined);
          curFd = nextFd;
        }
        const finalSeg = segments[segments.length - 1]!;
        return {
          anchoredPath: `/proc/self/fd/${curFd.fd}/${finalSeg}`,
          close: () => curFd.close(),
        };
      } catch (err) {
        await curFd.close().catch(() => undefined);
        throw err;
      }
    }

    let curDir = realRoot;
    for (let i = 0; i < segments.length - 1; i += 1) {
      curDir = path.join(curDir, segments[i]!);
      const lst = await fsp.lstat(curDir).catch(() => {
        throw new ProviderError('not_found', `pi-adapter: session directory not found`, 404);
      });
      if (lst.isSymbolicLink() || !lst.isDirectory()) {
        throw new ProviderError('not_found', `pi-adapter: invalid or symlinked session directory`, 404);
      }
    }
    return {
      anchoredPath: path.join(curDir, segments[segments.length - 1]!),
      close: async () => undefined,
    };
  }

  const baseName = path.basename(resolvedFile);
  if (!baseName || baseName === '.' || baseName === '..') {
    throw new ProviderError('not_found', `pi-adapter: invalid file path`, 404);
  }
  if (HAS_PROC_SELF_FD) {
    const realParent = await safeRealpath(path.dirname(resolvedFile));
    if (!realParent) {
      throw new ProviderError('not_found', `pi-adapter: parent directory not found`, 404);
    }
    const parentLst = await fsp.lstat(realParent).catch(() => {
      throw new ProviderError('not_found', `pi-adapter: parent directory not found`, 404);
    });
    const parentFd = await fsp.open(realParent, OPEN_DIR_FLAGS).catch(() => {
      throw new ProviderError('not_found', `pi-adapter: cannot open parent directory`, 404);
    });
    try {
      const pSt = await parentFd.stat();
      if (!pSt.isDirectory() || pSt.dev !== parentLst.dev || pSt.ino !== parentLst.ino) {
        throw new ProviderError('not_found', `pi-adapter: parent directory changed during open`, 404);
      }
      return {
        anchoredPath: `/proc/self/fd/${parentFd.fd}/${baseName}`,
        close: () => parentFd.close(),
      };
    } catch (err) {
      await parentFd.close().catch(() => undefined);
      throw err;
    }
  }
  return { anchoredPath: resolvedFile, close: async () => undefined };
}

async function verifyRegularFileWithinRoot(realRoot: string, filePath: string): Promise<boolean> {
  try {
    const anchor = await openAnchoredParentDir(filePath, realRoot);
    try {
      const lst = await fsp.lstat(anchor.anchoredPath);
      return !lst.isSymbolicLink() && lst.isFile();
    } finally {
      await anchor.close().catch(() => undefined);
    }
  } catch {
    return false;
  }
}

async function openFileNoFollowVerified(
  filePath: string,
  expectedRoot?: string,
  rawRoot?: string,
): Promise<{ fh: fsp.FileHandle; stat: fs.Stats }> {
  const anchor = await openAnchoredParentDir(filePath, expectedRoot, rawRoot);
  try {
    const lst = await fsp.lstat(anchor.anchoredPath).catch(() => {
      throw new ProviderError('not_found', `pi-adapter: session file not found`, 404);
    });
    if (lst.isSymbolicLink() || !lst.isFile()) {
      throw new ProviderError('not_found', `pi-adapter: refusing symlink or non-regular file`, 404);
    }

    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(anchor.anchoredPath, SAFE_OPEN_FLAGS);
    } catch {
      throw new ProviderError('not_found', `pi-adapter: failed to open session file`, 404);
    }

    try {
      const st = await fh.stat();
      if (!st.isFile() || st.dev !== lst.dev || (process.platform !== 'win32' && st.ino !== lst.ino)) {
        throw new ProviderError('not_found', `pi-adapter: file identity changed during open`, 404);
      }
      return { fh, stat: st };
    } catch (err) {
      await fh.close().catch(() => undefined);
      throw err;
    }
  } finally {
    await anchor.close().catch(() => undefined);
  }
}

async function readTailWindowLinesNoFollow(
  filePath: string,
  maxBytes: number,
  expectedRoot?: string,
  rawRoot?: string,
): Promise<string[]> {
  const { fh, stat } = await openFileNoFollowVerified(filePath, expectedRoot, rawRoot);
  try {
    const size = stat.size;
    if (size === 0) return [];
    const startOffset = size > maxBytes ? size - maxBytes : 0;
    let remaining = size - startOffset;
    let pos = startOffset;
    let skipUntilFirstNewline = startOffset > 0;

    const chunkSize = Math.min(remaining, 1024 * 1024);
    const buf = Buffer.allocUnsafe(chunkSize);
    const framer = new JsonlLineFramer();
    const lines: string[] = [];

    while (remaining > 0) {
      const toRead = Math.min(remaining, chunkSize);
      const { bytesRead } = await fh.read(buf, 0, toRead, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      remaining -= bytesRead;

      let slice = buf.subarray(0, bytesRead);
      if (skipUntilFirstNewline) {
        const nl = slice.indexOf(0x0a);
        if (nl === -1) continue;
        slice = slice.subarray(nl + 1);
        skipUntilFirstNewline = false;
      }
      if (slice.length > 0) {
        lines.push(...framer.push(slice));
      }
    }
    if (!skipUntilFirstNewline) {
      lines.push(...framer.flush());
    }
    return lines;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

async function readHeadChunkNoFollow(
  filePath: string,
  maxBytes: number,
  expectedRoot?: string,
): Promise<string> {
  const { fh, stat } = await openFileNoFollowVerified(filePath, expectedRoot);
  try {
    const toRead = Math.min(stat.size, maxBytes);
    if (toRead <= 0) return '';
    const buf = Buffer.allocUnsafe(toRead);
    let offset = 0;
    while (offset < toRead) {
      const { bytesRead } = await fh.read(buf, offset, toRead - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buf.subarray(0, offset).toString('utf8');
  } finally {
    await fh.close().catch(() => undefined);
  }
}

async function findMatchingSessionFilesSafe(realRoot: string, sessionId: string): Promise<string[]> {
  const matches: string[] = [];
  let cwdDirs: fs.Dirent[];
  try {
    cwdDirs = await fsp.readdir(realRoot, { withFileTypes: true });
  } catch {
    return matches;
  }

  for (const cwdEnt of cwdDirs) {
    if (!cwdEnt.isDirectory() || cwdEnt.isSymbolicLink()) continue;
    const realCwdDir = await verifyDirInsideRoot(realRoot, path.join(realRoot, cwdEnt.name));
    if (!realCwdDir) continue;

    let files: fs.Dirent[];
    try {
      files = await fsp.readdir(realCwdDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const fileEnt of files) {
      if (!fileEnt.name.endsWith('.jsonl') || fileEnt.isSymbolicLink() || !fileEnt.isFile()) continue;
      const fullPath = path.join(realCwdDir, fileEnt.name);
      const header = await readPiSessionHeader(fullPath, realRoot);
      if (header?.id === sessionId) {
        matches.push(fullPath);
      }
    }
  }
  return matches;
}

async function readPiSessionHeader(
  filePath: string,
  realRoot: string,
): Promise<{ id: string; cwd?: string; timestamp?: string; parentSession?: string } | null> {
  try {
    const head = await readHeadChunkNoFollow(filePath, SUMMARY_HEAD_BYTES, realRoot);
    const framer = new JsonlLineFramer();
    const lines = [...framer.push(head), ...framer.flush()];
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;
      if (parsed.type === 'session' && typeof parsed.id === 'string' && parsed.id) {
        return {
          id: parsed.id,
          cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
          timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
          parentSession: typeof parsed.parentSession === 'string' ? parsed.parentSession : undefined,
        };
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

async function summarizePiSessionFile(filePath: string, realRoot: string): Promise<PiSessionSummary | null> {
  try {
    const header = await readPiSessionHeader(filePath, realRoot);
    if (!header) return null;

    const { fh, stat } = await openFileNoFollowVerified(filePath, realRoot);
    let headText = '';
    let tailText = '';
    try {
      const size = stat.size;
      const headLen = Math.min(size, SUMMARY_HEAD_BYTES);
      if (headLen > 0) {
        const hb = Buffer.allocUnsafe(headLen);
        const { bytesRead } = await fh.read(hb, 0, headLen, 0);
        headText = hb.subarray(0, bytesRead).toString('utf8');
      }
      if (size > SUMMARY_HEAD_BYTES) {
        const tailStart = Math.max(0, size - SUMMARY_TAIL_BYTES);
        const tailLen = size - tailStart;
        const tb = Buffer.allocUnsafe(tailLen);
        const { bytesRead } = await fh.read(tb, 0, tailLen, tailStart);
        let tailSlice = tb.subarray(0, bytesRead);
        if (tailStart > 0) {
          const nl = tailSlice.indexOf(0x0a);
          tailSlice = nl >= 0 ? tailSlice.subarray(nl + 1) : Buffer.alloc(0);
        }
        tailText = tailSlice.toString('utf8');
      }
    } finally {
      await fh.close().catch(() => undefined);
    }

    let firstUserPrompt = '';
    let sessionName = '';
    let lastTimestamp = header.timestamp || stat.mtime.toISOString();

    const scanChunk = (chunk: string, isTail: boolean): void => {
      const framer = new JsonlLineFramer();
      for (const line of [...framer.push(chunk), ...framer.flush()]) {
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(entry) || entry.type === 'session') continue;
        if (typeof entry.timestamp === 'string' && entry.timestamp) {
          lastTimestamp = entry.timestamp;
        }
        if (entry.type === 'session_info') {
          const name = typeof entry.name === 'string' ? entry.name.trim() : '';
          if (name || isTail) sessionName = name;
        } else if (entry.type === 'message' && isRecord(entry.message)) {
          if (entry.message.role === 'user' && !firstUserPrompt) {
            const text = extractMessageText(entry.message.content);
            if (text) firstUserPrompt = text;
          }
        }
      }
    };

    scanChunk(headText, false);
    if (tailText) scanChunk(tailText, true);

    const cwd = header.cwd || path.dirname(filePath);
    const title = (sessionName || firstUserPrompt || `Pi ${header.id.slice(0, 8)}`)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);

    return {
      sessionId: header.id,
      sessionFile: filePath,
      title,
      cwd,
      createdAt: header.timestamp || stat.birthtime.toISOString(),
      updatedAt: lastTimestamp,
      ...(header.parentSession ? { parentSession: header.parentSession } : {}),
    };
  } catch {
    return null;
  }
}

async function safeUnlinkWithinRoot(realRoot: string, targetPath: string): Promise<void> {
  let anchor: { anchoredPath: string; close: () => Promise<void> };
  try {
    anchor = await openAnchoredParentDir(targetPath, realRoot);
  } catch (err) {
    throw new ProviderError(
      'invalid_request',
      `Refusing to delete non-regular or outside-root file: ${targetPath}`,
      400,
      err,
    );
  }
  try {
    const lst = await fsp.lstat(anchor.anchoredPath).catch((err: unknown) => {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return null;
      throw err;
    });
    if (!lst) return;
    if (lst.isSymbolicLink() || !lst.isFile()) {
      throw new ProviderError('invalid_request', `Refusing to delete non-regular or outside-root file: ${targetPath}`, 400);
    }
    await fsp.unlink(anchor.anchoredPath);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') throw err;
  } finally {
    await anchor.close().catch(() => undefined);
  }
}

function mapPiHistoryEntry(
  entry: Record<string, unknown>,
  sessionId: string,
  edit?: Record<string, unknown>,
): Message | null {
  const entryId = String(entry.id ?? randomUUID());
  const createdAt = typeof entry.timestamp === 'string' && entry.timestamp ? entry.timestamp : nowIso();
  const type = typeof entry.type === 'string' ? entry.type : '';

  if (type === 'message' && isRecord(entry.message)) {
    const rawMsg = entry.message;
    const msg = edit && isRecord(edit.replacement) && 'content' in edit.replacement
      ? { ...rawMsg, content: edit.replacement.content }
      : rawMsg;
    const role = typeof msg.role === 'string' ? msg.role : '';
    const msgCreatedAt = typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)
      ? new Date(msg.timestamp).toISOString()
      : createdAt;

    if (role === 'system') return null;

    if (role === 'user') {
      const content = mapPiContentToGateway(msg.content, false);
      if (content.length === 0) return null;
      return {
        id: entryId,
        session_id: sessionId,
        role: 'user',
        content,
        created_at: msgCreatedAt,
      };
    }

    if (role === 'assistant') {
      const content = mapPiContentToGateway(msg.content, true);
      if (content.length === 0) return null;
      const model = typeof msg.provider === 'string' && typeof msg.model === 'string'
        ? encodePiModelId(msg.provider, msg.model)
        : typeof msg.model === 'string'
          ? msg.model
          : undefined;
      const isError = msg.stopReason === 'error' || msg.stopReason === 'aborted';
      return {
        id: entryId,
        session_id: sessionId,
        role: 'assistant',
        content,
        created_at: msgCreatedAt,
        ...(model || isError
          ? {
              metadata: {
                ...(model ? { model } : {}),
                ...(isError ? { is_error: true } : {}),
              },
            }
          : {}),
      };
    }

    if (role === 'toolResult') {
      const toolCallId = String(msg.toolCallId ?? '');
      const output = extractToolContentText(msg);
      return {
        id: entryId,
        session_id: sessionId,
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            tool_call_id: toolCallId,
            output,
            is_error: msg.isError === true,
          },
        ],
        created_at: msgCreatedAt,
      };
    }

    if (role === 'bashExecution') {
      const cmd = typeof msg.command === 'string' ? msg.command : '';
      const out = typeof msg.output === 'string' ? msg.output : '';
      const text = out ? `$ ${cmd}\n${out}` : `$ ${cmd}`;
      return {
        id: entryId,
        session_id: sessionId,
        role: 'user',
        content: [{ type: 'text', text }],
        created_at: msgCreatedAt,
      };
    }

    if (role === 'custom' || role === 'hookMessage') {
      if (msg.display === false) return null;
      const content = mapPiContentToGateway(msg.content, false);
      if (content.length === 0) return null;
      return {
        id: entryId,
        session_id: sessionId,
        role: 'assistant',
        content,
        created_at: msgCreatedAt,
      };
    }
    return null;
  }

  if (type === 'custom_message') {
    if (entry.display === false) return null;
    const rawContent = edit && isRecord(edit.replacement) && 'content' in edit.replacement
      ? edit.replacement.content
      : entry.content;
    const content = mapPiContentToGateway(rawContent, false);
    if (content.length === 0) return null;
    return {
      id: entryId,
      session_id: sessionId,
      role: 'assistant',
      content,
      created_at: createdAt,
    };
  }

  if (type === 'compaction' && typeof entry.summary === 'string' && entry.summary) {
    return {
      id: entryId,
      session_id: sessionId,
      role: 'system',
      content: [{ type: 'text', text: entry.summary }],
      created_at: createdAt,
      metadata: { notice: true, notice_level: 'info', notice_source: 'compact' },
    };
  }

  if (type === 'branch_summary' && typeof entry.summary === 'string' && entry.summary) {
    return {
      id: entryId,
      session_id: sessionId,
      role: 'system',
      content: [{ type: 'text', text: entry.summary }],
      created_at: createdAt,
      metadata: { notice: true, notice_level: 'info', notice_source: 'branch_summary' },
    };
  }

  return null;
}

function mapPiContentToGateway(raw: unknown, allowAssistantBlocks: boolean): MessageContentPart[] {
  if (typeof raw === 'string') {
    return raw ? [{ type: 'text', text: raw }] : [];
  }
  if (!Array.isArray(raw)) return [];
  const parts: MessageContentPart[] = [];
  for (const block of raw) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      parts.push({ type: 'image', mimeType: block.mimeType, data: block.data });
    } else if (allowAssistantBlocks && block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      parts.push({ type: 'thinking', thinking: block.thinking });
    } else if (allowAssistantBlocks && block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
      parts.push({
        type: 'tool_use',
        tool_call_id: block.id,
        tool_name: block.name,
        input: block.arguments ?? {},
      });
    }
  }
  return parts;
}

function buildExtensionUiResponse(
  parked: ParkedQuestion,
  answer: string | Record<string, string[]>,
): Record<string, unknown> {
  const fail = (): Record<string, unknown> => ({
    type: 'extension_ui_response',
    id: parked.id,
    cancelled: true,
  });

  const extracted = extractSingleAnswer(answer);
  if (extracted === null) return fail();

  if (parked.method === 'confirm') {
    const normalized = extracted.trim().toLowerCase();
    if (!normalized) return fail();
    if (CONFIRM_YES_VALUES.has(normalized)) {
      return { type: 'extension_ui_response', id: parked.id, confirmed: true };
    }
    if (CONFIRM_NO_VALUES.has(normalized)) {
      return { type: 'extension_ui_response', id: parked.id, confirmed: false };
    }
    return fail();
  }

  if (parked.method === 'select') {
    const options = parked.options ?? [];
    if (options.includes(extracted)) {
      return { type: 'extension_ui_response', id: parked.id, value: extracted };
    }
    const trimmed = extracted.trim();
    const matched = options.find((o) => o === trimmed);
    if (matched !== undefined) {
      return { type: 'extension_ui_response', id: parked.id, value: matched };
    }
    return fail();
  }

  // `input` dialog: reject empty/blank dismisses fail-closed.
  if (extracted.length === 0) return fail();
  return { type: 'extension_ui_response', id: parked.id, value: extracted };
}

function extractSingleAnswer(answer: string | Record<string, string[]>): string | null {
  if (typeof answer === 'string') {
    return answer.length > 0 ? answer : null;
  }
  if (!isRecord(answer)) return null;
  const entries = Object.entries(answer);
  if (entries.length === 0) return null;
  for (const [, values] of entries) {
    if (!Array.isArray(values) || values.length === 0) continue;
    const first = values.find((v): v is string => typeof v === 'string' && v.length > 0);
    if (first !== undefined) return first;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompt / Image / Attachment Validation
// ---------------------------------------------------------------------------

function isSteerInput(value: unknown): value is SteerInput {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'input' in value;
}

function unpackSteerInput(
  input: string | MessageContentPart[] | SteerInput,
  attachments: TurnAttachment[],
): { rawInput: string | MessageContentPart[]; mergedAttachments: TurnAttachment[] } {
  if (isSteerInput(input)) {
    return {
      rawInput: input.input,
      mergedAttachments: [...(input.attachments ?? []), ...attachments],
    };
  }
  return { rawInput: input, mergedAttachments: attachments };
}

async function normalizePiPromptInput(
  input: string | MessageContentPart[],
  attachments: TurnAttachment[],
  maxImageBytes: number,
): Promise<{ message: string; images: PiImageContent[] }> {
  const textParts: string[] = [];
  const images: PiImageContent[] = [];

  if (typeof input === 'string') {
    if (input) textParts.push(input);
  } else if (Array.isArray(input)) {
    for (const part of input) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string' && part.text) {
        textParts.push(part.text);
      } else if (part.type === 'image') {
        if (typeof part.data === 'string' && part.data) {
          const mime = normalizeImageMime(part.mimeType ?? part.mime_type);
          images.push(validateBase64Image(part.data, mime, maxImageBytes));
        } else if (typeof part.image_url === 'string' || typeof part.url === 'string') {
          const rawUrl = part.image_url ?? part.url ?? '';
          if (rawUrl.startsWith('data:')) {
            images.push(parseAndValidateDataUrl(rawUrl, part.mimeType ?? part.mime_type, maxImageBytes));
          } else if (rawUrl) {
            textParts.push(`[attached image: ${sanitizePromptText(rawUrl)}]`);
          }
        } else if (typeof part.path === 'string' && part.path) {
          images.push(await readAndValidateLocalImage(part.path, part.mimeType ?? part.mime_type, maxImageBytes));
        }
      } else if ((part.type === 'file' || part.type === 'document' || part.type === 'audio')) {
        if (part.path) {
          textParts.push(formatSafeFilePathText({
            kind: 'filePathText',
            path: part.path,
            name: part.name,
            mediaType: part.mimeType ?? part.mime_type,
          }));
        } else if (typeof part.text === 'string' && part.text) {
          textParts.push(part.text);
        }
      }
    }
  }

  for (const att of attachments) {
    if (att.kind === 'imageDataUrl' && att.dataUrl) {
      images.push(parseAndValidateDataUrl(att.dataUrl, att.mediaType, maxImageBytes));
    } else if (att.kind === 'localImage' && att.path) {
      images.push(await readAndValidateLocalImage(att.path, att.mediaType, maxImageBytes));
    } else if (att.kind === 'filePathText') {
      textParts.push(formatSafeFilePathText(att));
    }
  }

  return {
    message: textParts.filter((s) => s.length > 0).join('\n'),
    images,
  };
}

function normalizeImageMime(rawMime: string | undefined): string {
  const base = (rawMime ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'image/jpg') return 'image/jpeg';
  return base;
}

function inferImageMimeFromPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    default: return '';
  }
}

function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return 'image/gif';
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return '';
}

function validateBase64Image(rawBase64: string, mimeType: string, maxImageBytes: number): PiImageContent {
  const mime = normalizeImageMime(mimeType);
  if (!ALLOWED_IMAGE_MIMES.has(mime)) {
    throw new ProviderError('invalid_request', `Unsupported image MIME type: ${mimeType || 'unknown'}`, 400);
  }
  const cleaned = rawBase64.replace(/\s+/g, '');
  if (!cleaned || cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new ProviderError('invalid_request', 'Invalid base64 image payload', 400);
  }
  const decodedLen = Buffer.byteLength(cleaned, 'base64');
  if (decodedLen <= 0) {
    throw new ProviderError('invalid_request', 'Empty image payload', 400);
  }
  if (decodedLen > maxImageBytes) {
    throw new ProviderError(
      'invalid_request',
      `Image exceeds maximum size (${decodedLen} > ${maxImageBytes} bytes)`,
      400,
    );
  }
  return { type: 'image', data: cleaned, mimeType: mime };
}

function parseAndValidateDataUrl(
  dataUrl: string,
  fallbackMime: string | undefined,
  maxImageBytes: number,
): PiImageContent {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new ProviderError('invalid_request', 'Invalid image data URL (expected base64 data URL)', 400);
  }
  const mime = normalizeImageMime(match[1] || fallbackMime);
  return validateBase64Image(match[2] ?? '', mime, maxImageBytes);
}

async function readAndValidateLocalImage(
  filePath: string,
  declaredMime: string | undefined,
  maxImageBytes: number,
): Promise<PiImageContent> {
  const { fh, stat } = await openFileNoFollowVerified(filePath).catch((err) => {
    if (err instanceof ProviderError) {
      throw new ProviderError('invalid_request', `Cannot read image attachment ${sanitizePromptText(filePath)}: ${err.message}`, 400);
    }
    throw err;
  });
  try {
    if (stat.size <= 0) {
      throw new ProviderError('invalid_request', `Image file is empty: ${sanitizePromptText(filePath)}`, 400);
    }
    if (stat.size > maxImageBytes) {
      throw new ProviderError(
        'invalid_request',
        `Image file exceeds maximum size (${stat.size} > ${maxImageBytes} bytes)`,
        400,
      );
    }
    const buf = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await fh.read(buf, offset, stat.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const dataBuf = buf.subarray(0, offset);
    const mime = normalizeImageMime(declaredMime) || inferImageMimeFromPath(filePath) || sniffImageMime(dataBuf);
    if (!ALLOWED_IMAGE_MIMES.has(mime)) {
      throw new ProviderError('invalid_request', `Unsupported image MIME type: ${declaredMime || mime || 'unknown'}`, 400);
    }
    return { type: 'image', data: dataBuf.toString('base64'), mimeType: mime };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

function sanitizePromptText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
}

function formatSafeFilePathText(att: TurnAttachment): string {
  const safeMime = sanitizePromptText(att.mediaType ?? 'application/octet-stream') || 'application/octet-stream';
  const safeSize = typeof att.size === 'number' && Number.isFinite(att.size) && att.size >= 0
    ? Math.trunc(att.size)
    : 0;
  const rawName = att.name ?? (att.path ? path.posix.basename(att.path.replace(/\\/g, '/')) : 'file');
  const safeName = sanitizePromptText(rawName) || 'file';
  const safePath = att.path ? sanitizePromptText(att.path) : '';
  if (!safePath) {
    return `[attached file "${safeName}" (${safeMime}, ${safeSize} bytes) unavailable]`;
  }
  return `Attached file "${safeName}" (${safeMime}, ${safeSize} bytes): ${safePath} — open it with the Read tool`;
}

// ---------------------------------------------------------------------------
// Misc Helpers
// ---------------------------------------------------------------------------

function lookupPiContextWindow(modelId: string | undefined, knownModels?: PiModelInfo[]): number {
  if (!modelId || !knownModels || knownModels.length === 0) return 0;
  const parsed = decodePiModelId(modelId, knownModels);
  if (parsed) {
    const hit = knownModels.find((m) => m.provider === parsed.provider && m.id === parsed.modelId);
    if (hit && typeof hit.contextWindow === 'number' && hit.contextWindow > 0) return hit.contextWindow;
  }
  const byId = knownModels.find((m) => m.id === modelId);
  return byId && typeof byId.contextWindow === 'number' ? byId.contextWindow : 0;
}

function decodePercentProvider(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // process already exited
    }
  }
}

function extractToolContentText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (isRecord(item) && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (isRecord(raw)) {
    if (typeof raw.content === 'string') {
      return raw.content;
    }
    if (Array.isArray(raw.content)) {
      return extractToolContentText(raw.content);
    }
    if (typeof raw.text === 'string') return raw.text;
    if (typeof raw.output === 'string') return raw.output;
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  return '';
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('').trim();
}

function emptyAssistantMessage(sessionId: string): Message {
  return {
    id: randomUUID(),
    session_id: sessionId,
    role: 'assistant',
    content: [],
    created_at: nowIso(),
  };
}

function workspaceIdFromCwd(cwd: string, provider: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root';
  return `wd_${provider}_${slug}`.slice(0, 60);
}

function nowIso(): string {
  return new Date().toISOString();
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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
