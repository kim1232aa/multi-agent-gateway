/**
 * GrokAdapter — wraps the Grok CLI (verified against 1.0.77) as a ProviderAdapter.
 *
 * Main path: ACP (`grok agent stdio`, see grok-acp.ts). One long-lived JSON-RPC
 * process, multiple sessions. Headless `-p` is the fallback when ACP spawn or
 * initialize fails.
 *
 * Headless turn:
 *   grok -p PROMPT --output-format streaming-messages-json --include-partial-messages
 *        [--session-id UUID | --resume UUID] [--model] [--effort] [--permission-mode]
 *
 * The prompt is an argv flag (`-p` / `--prompt-json` / `--prompt-file`). Large
 * prompts / images go through a 0600 temp `--prompt-file` so argv never hits E2BIG.
 * Grok does NOT read a piped stdin user-JSON line as the prompt (unlike Claude
 * stream-json), so stdin is unused (stdio ignore) / never written.
 *
 * Session files live under ~/.grok/sessions/<urlencoded-cwd>/<session-id>/
 * (summary.json + chat_history.jsonl, plus updates.jsonl / usage.json /
 * rewind_points.jsonl / goal/state.json written by the CLI).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {
  discoverClaudeDiskCommands,
  expandGrokSkill,
  listGrokCommands,
  type ClaudeCatalogCommand,
  type GrokNativeCommandInput,
  type SkillCommandInput,
} from './native-commands.js';
import {
  GrokAcpClient,
  pickPermissionOption,
  type GrokAcpEvent,
  type GrokAcpModelInfo,
  type GrokAcpModelState,
} from './grok-acp.js';
import { SettingsStore } from './settings-store.js';
import {
  ProviderError,
  type ApprovalDecision,
  type CreateSessionInput,
  type EventStatus,
  type GatewayEvent,
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
  type TurnAttachment,
  type TurnHandle,
} from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_GROK_BIN = path.join(os.homedir(), '.local', 'bin', 'grok');
/** Prompts / JSON payloads above this many bytes go through --prompt-file (argv E2BIG guard). */
const MAX_INLINE_PROMPT_BYTES = 32 * 1024;
/** getHistory / usage readers only look at the tail of large session files. */
const MAX_SESSION_FILE_TAIL_BYTES = 16 * 1024 * 1024;
const MAX_SMALL_FILE_BYTES = 1024 * 1024;
const FORK_TIMEOUT_MS = 20_000;
const NO_FOLLOW_READ_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Binary priority: explicit option > GROK_BIN > ~/.local/bin/grok > PATH lookup. */
export function resolveGrokBin(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnv = process.env.GROK_BIN?.trim();
  if (fromEnv) return fromEnv;
  if (isExecutableFile(DEFAULT_GROK_BIN)) return DEFAULT_GROK_BIN;
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'grok');
    if (isExecutableFile(candidate)) return candidate;
  }
  return DEFAULT_GROK_BIN;
}

/** Child env: inherit the user's env (incl. proxy), drop gateway secrets, keep loopback out of the proxy. */
function grokChildEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
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

/** Bounded O_NOFOLLOW read of (at most) the last `maxBytes` of a regular file. */
function readTailNoFollow(file: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, NO_FOLLOW_READ_FLAGS);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const start = Math.max(0, st.size - maxBytes);
    const length = st.size - start;
    if (length <= 0) return '';
    const buf = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const n = fs.readSync(fd, buf, offset, length - offset, start + offset);
      if (n === 0) break;
      offset += n;
    }
    let text = buf.subarray(0, offset).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function readHeadNoFollow(file: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, NO_FOLLOW_READ_FLAGS);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const length = Math.min(st.size, maxBytes);
    if (length <= 0) return '';
    const buf = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const n = fs.readSync(fd, buf, offset, length - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buf.subarray(0, offset).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function readJsonNoFollow(file: string): Record<string, unknown> | null {
  const text = readTailNoFollow(file, MAX_SMALL_FILE_BYTES);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonl(text: string | null): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (!text) return out;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      // skip malformed / partial line
    }
  }
  return out;
}

export interface GrokSessionSummary {
  sessionId: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  hasConversation?: boolean;
  firstPrompt?: string;
  summaryTitle?: string;
}

export interface GrokHistoryMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  blocks?: Array<
    | { type: 'text'; text: string }
    | { type: 'thinking'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  >;
  timestamp?: string;
  model?: string;
}

export type GrokAdapterEvent =
  | { type: 'init'; sessionId: string; cwd: string; tools: string[] }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'synthetic_text'; text: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | {
      type: 'permission_denied';
      denials: Array<{ tool_name: string; tool_use_id: string; tool_input: unknown }>;
    }
  | {
      type: 'done';
      sessionId: string;
      result: string;
      isError: boolean;
      subtype: string;
      stopReason: string | null;
      usage?: Record<string, unknown>;
      durationMs?: number;
    }
  | { type: 'interrupted'; sessionId: string }
  | { type: 'error'; message: string };

export interface GrokStartTurnOptions {
  sessionId: string;
  prompt: string;
  cwd?: string;
  isNew?: boolean;
  model?: string;
  effort?: string;
  permissionMode?: string;
  contentBlocks?: Array<Record<string, unknown>>;
  onEvent: (event: GrokAdapterEvent) => void;
}

export interface GrokAdapterOptions {
  grokBin?: string;
  env?: Record<string, string>;
  sessionsDir?: string;
}

export interface GrokProviderAdapterOptions extends GrokAdapterOptions {
  settingsPath?: string;
  recycleGraceMs?: number;
}

export type { GrokNativeCommandInput };

export class GrokAdapter {
  private readonly grokBin: string;
  private readonly env: Record<string, string>;
  private readonly sessionsDir: string;
  private readonly running = new Map<string, ChildProcess>();
  private readonly ephemeralChildren = new Set<ChildProcess>();
  private closed = false;
  private readonly interruptRequested = new Set<string>();
  private readonly exitWaiters = new Map<string, Array<() => void>>();
  private readonly sessionCwd = new Map<string, string>();
  private static readonly MODELS_TTL_MS = 5 * 60_000;
  private modelsCache: { ts: number; value: { defaultModel?: string; models: string[] } } | null = null;
  private modelsInflight: Promise<{ defaultModel?: string; models: string[] }> | null = null;

  constructor(options: GrokAdapterOptions = {}) {
    this.grokBin = resolveGrokBin(options.grokBin);
    this.env = { ...(options.env ?? {}) };
    const grokHome = process.env.GROK_HOME ?? path.join(os.homedir(), '.grok');
    this.sessionsDir = options.sessionsDir ?? path.join(grokHome, 'sessions');
  }

  readonly provider = 'grok' as const;

  readonly capabilities = {
    streamingText: true,
    thinking: true,
    toolEvents: true,
    interrupt: true,
    resume: true,
    fork: true,
    approvals: true,
    questions: true,
  };

  get binPath(): string {
    return this.grokBin;
  }

  async list(): Promise<GrokSessionSummary[]> {
    const out: GrokSessionSummary[] = [];
    let cwdDirs: fs.Dirent[];
    try {
      cwdDirs = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const cwdEnt of cwdDirs) {
      if (!cwdEnt.isDirectory()) continue;
      const cwdPath = path.join(this.sessionsDir, cwdEnt.name);
      let sessionDirs: fs.Dirent[];
      try {
        sessionDirs = fs.readdirSync(cwdPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sessEnt of sessionDirs) {
        if (!sessEnt.isDirectory() || !UUID_RE.test(sessEnt.name)) continue;
        const sessionDir = path.join(cwdPath, sessEnt.name);
        const summaryPath = path.join(sessionDir, 'summary.json');
        const raw = readJsonNoFollow(summaryPath);
        if (!raw) continue;
        const info = isRecord(raw.info) ? raw.info : {};
        const sessionId = typeof info.id === 'string' && UUID_RE.test(info.id) ? info.id : sessEnt.name;
        const cwd = typeof info.cwd === 'string'
          ? info.cwd
          : decodeUriComponentSafe(cwdEnt.name);
        const inspected = inspectGrokSessionFiles(sessionDir, raw);
        const title = inspected.summaryTitle || inspected.firstPrompt || `Grok ${sessionId.slice(0, 8)}`;
        const updatedAt = pickString(raw.updated_at, raw.last_active_at) || new Date().toISOString();
        const createdAt = pickString(raw.created_at) || updatedAt;
        const model = typeof raw.current_model_id === 'string' ? raw.current_model_id : undefined;
        if (cwd) this.sessionCwd.set(sessionId, cwd);
        out.push({
          sessionId,
          title: title.slice(0, 120),
          cwd,
          createdAt,
          updatedAt,
          ...(model ? { model } : {}),
          hasConversation: inspected.hasConversation,
          ...(inspected.firstPrompt ? { firstPrompt: inspected.firstPrompt } : {}),
          ...(inspected.summaryTitle ? { summaryTitle: inspected.summaryTitle } : {}),
        });
      }
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }

  async create(cwd?: string): Promise<{ sessionId: string }> {
    const sessionId = randomUUID();
    this.sessionCwd.set(sessionId, cwd ?? os.homedir());
    return { sessionId };
  }

  getCwd(sessionId: string): string | undefined {
    return this.sessionCwd.get(sessionId);
  }

  hasSessionFile(sessionId: string): boolean {
    return this.findSessionDir(sessionId) !== null;
  }

  isBusy(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  async getHistory(sessionId: string): Promise<GrokHistoryMessage[]> {
    const dir = this.findSessionDir(sessionId);
    if (!dir) throw new Error(`grok-adapter: session not found: ${sessionId}`);
    const chatPath = path.join(dir, 'chat_history.jsonl');
    const updatesPath = path.join(dir, 'updates.jsonl');
    const pointsPath = path.join(dir, 'rewind_points.jsonl');
    const chatText = readTailNoFollow(chatPath, MAX_SESSION_FILE_TAIL_BYTES);
    const updates = parseJsonl(readTailNoFollow(updatesPath, MAX_SESSION_FILE_TAIL_BYTES));
    const points = parseJsonl(readTailNoFollow(pointsPath, MAX_SMALL_FILE_BYTES));
    if (chatText === null && updates.length === 0) {
      throw new Error(`grok-adapter: session not found: ${sessionId}`);
    }
    const rewind = effectiveRewind(updates, points);

    const messages: GrokHistoryMessage[] = [];
    for (const entry of parseJsonl(chatText)) {
      const mapped = mapHistoryEntry(entry);
      if (!mapped) continue;
      const timestamp = pickString(entry.timestamp);
      if (timestamp) mapped.timestamp = timestamp;
      messages.push(mapped);
    }
    applyRewind(messages, rewind);

    if (messages.length === 0 && updates.length > 0) {
      messages.push(...historyFromUpdates(updates, rewind));
    }

    const { createdAt, updatedAt } = readSessionTimes(dir);
    const missing = messages.filter((m) => !m.timestamp);
    for (let i = 0; i < missing.length; i++) {
      missing[i].timestamp = interpolateIso(createdAt, updatedAt, i, missing.length);
    }
    return messages;
  }

  async listModels(): Promise<{ defaultModel?: string; models: string[] }> {
    if (this.modelsCache && Date.now() - this.modelsCache.ts < GrokAdapter.MODELS_TTL_MS) {
      return this.modelsCache.value;
    }
    if (this.modelsInflight) return this.modelsInflight;
    const pending = this.spawnText(['models']).then((stdout) => {
      const parsed = parseGrokModels(stdout);
      if (parsed.models.length === 0) {
        throw new Error('grok-adapter: `grok models` returned no models');
      }
      this.modelsCache = { ts: Date.now(), value: parsed };
      return parsed;
    }).finally(() => {
      this.modelsInflight = null;
    });
    this.modelsInflight = pending;
    return pending;
  }

  async startTurn(opts: GrokStartTurnOptions): Promise<void> {
    const { sessionId, prompt, onEvent } = opts;
    if (this.running.has(sessionId)) {
      await this.waitForExit(sessionId, 8_000);
      if (this.running.has(sessionId)) {
        throw new Error(`grok-adapter: a turn is already running for session ${sessionId}`);
      }
    }
    const cwd = opts.cwd ?? this.sessionCwd.get(sessionId) ?? os.homedir();
    this.sessionCwd.set(sessionId, cwd);

    // Large prompts/images must not land in argv: Linux rejects them with E2BIG.
    const promptFile = materializePromptFile(prompt, opts.contentBlocks);
    const args: string[] = [];
    if (promptFile) {
      args.push('--prompt-file', promptFile.path);
    } else if (opts.contentBlocks && opts.contentBlocks.length > 0) {
      args.push('--prompt-json', JSON.stringify(opts.contentBlocks));
    } else {
      args.push('-p', prompt);
    }
    args.push('--output-format', 'streaming-messages-json', '--include-partial-messages');
    if (opts.isNew) {
      args.push('--session-id', sessionId);
    } else {
      args.push('--resume', sessionId);
    }
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);

    const child = spawn(this.grokBin, args, {
      cwd,
      env: this.childEnv(),
      // Grok does not read the prompt from stdin; leave it unused.
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    this.running.set(sessionId, child);
    const cleanupPromptFile = (): void => promptFile?.cleanup();

    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    });

    const done = new Promise<void>((resolve, reject) => {
      let sawResult = false;
      const rl = readline.createInterface({ input: child.stdout! });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        for (const mapped of mapStreamEvent(ev)) {
          if (mapped.type === 'done') sawResult = true;
          onEvent(mapped);
        }
      });

      child.on('error', (err) => {
        cleanupPromptFile();
        this.running.delete(sessionId);
        this.resolveExitWaiters(sessionId);
        onEvent({ type: 'error', message: `spawn failed: ${err.message}` });
        reject(err);
      });

      child.on('close', (code, signal) => {
        cleanupPromptFile();
        this.running.delete(sessionId);
        this.resolveExitWaiters(sessionId);
        const wasInterrupted =
          this.interruptRequested.delete(sessionId) ||
          signal === 'SIGINT' ||
          signal === 'SIGTERM';
        if (sawResult) {
          resolve();
        } else if (wasInterrupted) {
          onEvent({ type: 'interrupted', sessionId });
          resolve();
        } else {
          const message =
            `grok exited without a result event (code=${code}, signal=${signal}). ` +
            (stderrTail ? `stderr tail: ${stderrTail.trim()}` : '');
          onEvent({ type: 'error', message });
          reject(new Error(message));
        }
      });
    });

    return done;
  }

  interrupt(sessionId: string): boolean {
    const child = this.running.get(sessionId);
    if (!child) return false;
    this.interruptRequested.add(sessionId);
    // detached spawn 的组 id = 主 pid;只 kill 主进程时孙进程(模型请求)可能留下。
    this.killGroup(child, 'SIGINT');
    const ref = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) this.killGroup(child, 'SIGKILL');
    }, 5000);
    ref.unref?.();
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [sessionId, child] of this.running) {
      this.killGroup(child, 'SIGTERM');
      this.running.delete(sessionId);
      this.resolveExitWaiters(sessionId);
    }
    for (const child of this.ephemeralChildren) {
      this.killGroup(child, 'SIGTERM');
      this.ephemeralChildren.delete(child);
    }
    this.sessionCwd.clear();
    this.interruptRequested.clear();
    this.exitWaiters.clear();
  }

  private spawnText(args: string[]): Promise<string> {
    if (this.closed) return Promise.reject(new Error('grok adapter closed'));
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.grokBin, args, {
          cwd: os.homedir(),
          env: this.childEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(err);
        return;
      }
      this.ephemeralChildren.add(child);
      let stdout = '';
      let stderr = '';
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ephemeralChildren.delete(child);
        fn();
      };
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', (err) => done(() => reject(err)));
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        done(() => reject(new Error(`grok ${args.join(' ')} timed out`)));
      }, 20_000);
      timer.unref();
      child.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) {
          done(() => reject(new Error(`grok ${args.join(' ')} failed (code=${code}): ${stderr.trim()}`)));
          return;
        }
        done(() => resolve(stdout));
      });
    });
  }

  /** CLI 子进程继承用户环境(含代理),去掉 GATEWAY_* 并补 loopback NO_PROXY。 */
  private childEnv(): NodeJS.ProcessEnv {
    return grokChildEnv(this.env);
  }

  /**
   * Fork via the CLI (`grok --resume <id> --fork-session --session-id <new>`);
   * when the binary is missing (unit fixtures) clone the session directory.
   */
  async forkSession(sessionId: string, cwd: string): Promise<{ sessionId: string }> {
    const sourceDir = this.findSessionDir(sessionId);
    const newId = randomUUID();
    const forked = await this.forkViaCli(sessionId, newId, cwd);
    if (forked) {
      this.sessionCwd.set(newId, cwd);
      return { sessionId: newId };
    }
    if (!sourceDir) throw new Error(`grok-adapter: session not found: ${sessionId}`);
    const targetDir = path.join(this.sessionsDir, encodeURIComponent(cwd), newId);
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of ['chat_history.jsonl', 'updates.jsonl', 'rewind_points.jsonl', 'usage.json']) {
      const src = path.join(sourceDir, name);
      try {
        if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(targetDir, name));
      } catch {
        // optional file
      }
    }
    const goalSrc = path.join(sourceDir, 'goal', 'state.json');
    try {
      if (fs.statSync(goalSrc).isFile()) {
        fs.mkdirSync(path.join(targetDir, 'goal'), { recursive: true });
        fs.copyFileSync(goalSrc, path.join(targetDir, 'goal', 'state.json'));
      }
    } catch {
      // no goal state
    }
    const now = new Date().toISOString();
    const sourceSummary = readJsonNoFollow(path.join(sourceDir, 'summary.json')) ?? {};
    const sourceInfo = isRecord(sourceSummary.info) ? sourceSummary.info : {};
    fs.writeFileSync(path.join(targetDir, 'summary.json'), JSON.stringify({
      ...sourceSummary,
      info: { ...sourceInfo, id: newId, cwd },
      parent_session_id: sessionId,
      forked_at: now,
      created_at: now,
      updated_at: now,
    }));
    this.sessionCwd.set(newId, cwd);
    return { sessionId: newId };
  }

  private forkViaCli(sessionId: string, newId: string, cwd: string): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.grokBin, [
          '--resume', sessionId,
          '--fork-session',
          '--session-id', newId,
          '-p', '/session-info',
          '--output-format', 'streaming-messages-json',
        ], {
          cwd,
          env: this.childEnv(),
          stdio: ['ignore', 'pipe', 'ignore'],
          detached: true,
        });
      } catch {
        resolve(false);
        return;
      }
      this.ephemeralChildren.add(child);
      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(-16_000); });
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ephemeralChildren.delete(child);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        this.killGroup(child, 'SIGKILL');
        finish(false);
      }, FORK_TIMEOUT_MS);
      timer.unref();
      child.on('error', () => finish(false));
      child.on('close', () => {
        const created = this.findSessionDir(newId) !== null;
        const announced = stdout.includes(newId);
        finish(created || announced);
      });
    });
  }

  /**
   * Rewind by appending the CLI's own `rewind_marker` (target prompt index) and
   * truncating rewind_points.jsonl to the surviving prefix.
   */
  rollbackSession(sessionId: string, numTurns: number): void {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new ProviderError('invalid_request', 'grok-adapter: numTurns must be a positive integer', 400);
    }
    const dir = this.findSessionDir(sessionId);
    if (!dir) throw new ProviderError('not_found', `grok-adapter: session not found: ${sessionId}`, 404);
    const updatesPath = path.join(dir, 'updates.jsonl');
    const pointsPath = path.join(dir, 'rewind_points.jsonl');
    const chatPath = path.join(dir, 'chat_history.jsonl');
    const updates = parseJsonl(readTailNoFollow(updatesPath, MAX_SESSION_FILE_TAIL_BYTES));
    const points = parseJsonl(readTailNoFollow(pointsPath, MAX_SMALL_FILE_BYTES));
    const chatEntries = parseJsonl(readTailNoFollow(chatPath, MAX_SESSION_FILE_TAIL_BYTES));
    const userTurns = chatEntries.filter((entry) => entry.type === 'user' && mapHistoryEntry(entry) !== null).length;
    const promptIndexes = updates
      .map((entry) => updateOf(entry))
      .filter((update) => String(update.sessionUpdate ?? update.type ?? '') === 'user_message_chunk')
      .map((update) => promptIndexOf(update))
      .filter((index): index is number => index !== undefined);
    const totalPrompts = Math.max(userTurns, promptIndexes.length, points.length);
    if (totalPrompts === 0) {
      throw new ProviderError('invalid_request', 'grok-adapter: session has no turns to roll back', 400);
    }
    const previous = effectiveRewind(updates, points);
    const base = previous ?? totalPrompts;
    const target = Math.max(0, base - numTurns);

    const marker = {
      timestamp: Math.floor(Date.now() / 1000),
      method: '_x.ai/session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'rewind_marker', target_prompt_index: target },
      },
    };
    const isSafeRegularOrMissing = (file: string): boolean => {
      try {
        const st = fs.lstatSync(file);
        return st.isFile() && !st.isSymbolicLink();
      } catch (err) {
        return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
      }
    };
    if (!isSafeRegularOrMissing(updatesPath) || !isSafeRegularOrMissing(pointsPath)) {
      throw new ProviderError('invalid_request', 'grok-adapter: refusing to mutate non-regular session file', 400);
    }
    fs.appendFileSync(updatesPath, JSON.stringify(marker) + '\n');
    const kept = points.filter((point) => {
      const index = point.prompt_index ?? point.promptIndex;
      return typeof index === 'number' && index < target;
    });
    fs.writeFileSync(pointsPath, kept.map((point) => JSON.stringify(point)).join('\n') + (kept.length > 0 ? '\n' : ''));
    if (chatEntries.length > 0 && isSafeRegularOrMissing(chatPath)) {
      let seenUserTurns = 0;
      let cutIdx = chatEntries.length;
      for (let i = 0; i < chatEntries.length; i += 1) {
        if (chatEntries[i].type === 'user' && mapHistoryEntry(chatEntries[i]) !== null) {
          if (seenUserTurns >= target) {
            cutIdx = i;
            break;
          }
          seenUserTurns += 1;
        }
      }
      const surviving = chatEntries.slice(0, cutIdx);
      fs.writeFileSync(chatPath, surviving.map((entry) => JSON.stringify(entry)).join('\n') + (surviving.length > 0 ? '\n' : ''));
    }
  }

  /** usage.json written by the CLI (costUsdTicks is USD * 1e10). */
  readUsage(sessionId: string): SessionUsage | null {
    const dir = this.findSessionDir(sessionId);
    if (!dir) return null;
    const raw = readJsonNoFollow(path.join(dir, 'usage.json'));
    return raw ? usageFromFile(raw) : null;
  }

  /** goal/state.json written by the CLI's /goal tracker. */
  readGoal(sessionId: string): Record<string, unknown> | null {
    const dir = this.findSessionDir(sessionId);
    if (!dir) return null;
    const raw = readJsonNoFollow(path.join(dir, 'goal', 'state.json'));
    return raw ? normalizeGoal(raw, sessionId) : null;
  }

  private findSessionDir(sessionId: string): string | null {
    if (!UUID_RE.test(sessionId)) return null;
    let cwdDirs: fs.Dirent[];
    try {
      cwdDirs = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const cwdEnt of cwdDirs) {
      if (!cwdEnt.isDirectory()) continue;
      const candidate = path.join(this.sessionsDir, cwdEnt.name, sessionId);
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  deleteSession(sessionId: string): void {
    this.sessionCwd.delete(sessionId);
    const dir = this.findSessionDir(sessionId);
    if (!dir) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // missing / already gone
    }
  }

  private waitForExit(sessionId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.exitWaiters.get(sessionId);
        if (waiters) {
          const index = waiters.indexOf(done);
          if (index >= 0) waiters.splice(index, 1);
          if (waiters.length === 0) this.exitWaiters.delete(sessionId);
        }
        resolve();
      }, timeoutMs);
      timer.unref();
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const waiters = this.exitWaiters.get(sessionId) ?? [];
      waiters.push(done);
      this.exitWaiters.set(sessionId, waiters);
    });
  }

  private resolveExitWaiters(sessionId: string): void {
    const waiters = this.exitWaiters.get(sessionId);
    if (!waiters) return;
    this.exitWaiters.delete(sessionId);
    for (const done of waiters) done();
  }

  private killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
  }
}

export class GrokProviderAdapter implements ProviderAdapter {
  readonly name = 'grok' as ProviderName;
  private readonly inner: GrokAdapter;
  private readonly grokBin: string;
  private readonly grokEnv: Record<string, string>;
  private readonly sessionCwd = new Map<string, string>();
  private readonly settings: SettingsStore;
  private readonly renames = new Map<string, string>();
  private readonly sessionUsage = new Map<string, SessionUsage>();
  private readonly acpTurns = new Map<string, EventStream<GatewayEvent>>();
  /** Gateway session id → ACP session id. Grok 1.0.77 may assign its own id. */
  private readonly acpSessionIds = new Map<string, string>();
  /** Reverse map: ACP session id → Gateway session id. */
  private readonly gatewaySessionIds = new Map<string, string>();
  private readonly acpClients = new Map<boolean, GrokAcpClient>();
  private readonly acpConnecting = new Map<boolean, Promise<GrokAcpClient | null>>();
  private readonly sessionClient = new Map<string, GrokAcpClient>();
  private readonly sessionGoals = new Map<string, Record<string, unknown>>();
  private readonly skillCache = new Map<string, { ts: number; skills: SkillCommandInput[] }>();
  private defaultModel: string | undefined;
  private disposed = false;
  private static readonly SKILL_CACHE_TTL_MS = 30_000;
  private static readonly COMMANDS_TTL_MS = 5 * 60_000;
  private static readonly MAX_CACHE_ENTRIES = 64;
  private readonly recycleGraceMs: number;
  private recycleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly commandsCache = new Map<string, { ts: number; commands: GrokNativeCommandInput[] }>();

  constructor(options?: GrokProviderAdapterOptions) {
    const { settingsPath, recycleGraceMs, ...innerOptions } = options ?? {};
    this.inner = new GrokAdapter(innerOptions);
    this.settings = new SettingsStore(settingsPath);
    this.grokBin = this.inner.binPath;
    this.grokEnv = innerOptions.env ?? {};
    this.recycleGraceMs = typeof recycleGraceMs === 'number' && recycleGraceMs > 0 ? recycleGraceMs : 0;
    this.restoreAcpSessionIds();
  }

  get client(): GrokAcpClient | null {
    return this.acpClients.get(false) ?? null;
  }

  get alwaysApproveClient(): GrokAcpClient | null {
    return this.acpClients.get(true) ?? null;
  }

  clearCommandsCache(): void {
    this.commandsCache.clear();
  }

  private setSkillCache(key: string, skills: SkillCommandInput[]): void {
    const now = Date.now();
    for (const [k, v] of this.skillCache) {
      if (now - v.ts >= GrokProviderAdapter.SKILL_CACHE_TTL_MS) {
        this.skillCache.delete(k);
      }
    }
    if (this.skillCache.has(key)) {
      this.skillCache.delete(key);
    } else {
      while (this.skillCache.size >= GrokProviderAdapter.MAX_CACHE_ENTRIES) {
        const oldest = this.skillCache.keys().next().value;
        if (oldest === undefined) break;
        this.skillCache.delete(oldest);
      }
    }
    this.skillCache.set(key, { ts: now, skills });
  }

  private setCommandsCache(key: string, commands: GrokNativeCommandInput[]): void {
    const now = Date.now();
    for (const [k, v] of this.commandsCache) {
      if (now - v.ts >= GrokProviderAdapter.COMMANDS_TTL_MS) {
        this.commandsCache.delete(k);
      }
    }
    if (this.commandsCache.has(key)) {
      this.commandsCache.delete(key);
    } else {
      while (this.commandsCache.size >= GrokProviderAdapter.MAX_CACHE_ENTRIES) {
        const oldest = this.commandsCache.keys().next().value;
        if (oldest === undefined) break;
        this.commandsCache.delete(oldest);
      }
    }
    this.commandsCache.set(key, { ts: now, commands });
  }

  private scheduleRecycleWhenIdle(): void {
    if (this.recycleGraceMs <= 0 || this.disposed) return;
    if (this.recycleTimer) clearTimeout(this.recycleTimer);
    this.recycleTimer = setTimeout(() => {
      this.recycleTimer = null;
      void this.recycleIfIdle();
    }, this.recycleGraceMs);
    this.recycleTimer.unref?.();
  }

  private isAcpBusy(): boolean {
    if (this.acpTurns.size > 0 || this.acpConnecting.size > 0) return true;
    for (const client of this.acpClients.values()) {
      if (!client.ready) continue;
      const c = client as unknown as {
        pending?: Map<unknown, unknown>;
        permissions?: Map<unknown, unknown>;
        questions?: Map<unknown, unknown>;
      };
      if ((c.pending?.size ?? 0) > 0) return true;
      if ((c.permissions?.size ?? 0) > 0) return true;
      if ((c.questions?.size ?? 0) > 0) return true;
    }
    return false;
  }

  async recycleIfIdle(): Promise<void> {
    if (this.disposed) return;
    if (this.isAcpBusy()) {
      if (this.recycleGraceMs > 0) {
        this.scheduleRecycleWhenIdle();
      }
      return;
    }
    await this.recycleAcpClients();
  }

  private async recycleAcpClients(): Promise<void> {
    const connecting = [...this.acpConnecting.values()];
    this.acpConnecting.clear();
    const clients = [...this.acpClients.values()];
    this.acpClients.clear();
    this.sessionClient.clear();
    const resolvedConnecting = await Promise.allSettled(connecting);
    for (const r of resolvedConnecting) {
      if (r.status === 'fulfilled' && r.value && !clients.includes(r.value)) {
        clients.push(r.value);
      }
    }
    await Promise.allSettled(clients.map((c) => c.close().catch(() => undefined)));
  }

  private restoreAcpSessionIds(): void {
    for (const [gatewayId, acpId] of Object.entries(this.settings.listStrings('acpId'))) {
      if (!gatewayId || !acpId || gatewayId === acpId) continue;
      this.acpSessionIds.set(gatewayId, acpId);
      this.gatewaySessionIds.set(acpId, gatewayId);
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
      attachments: true,
      compact: true,
      fork: true,
      rollback: true,
      rename: true,
      archive: true,
      delete: true,
      planMode: true,
      permissionModes: ['default', 'auto', 'bypassPermissions', 'plan'],
      manualApproval: true,
      goals: true,
      models: true,
      thinkingLevels: true,
      commands: true,
      skills: true,
      usage: true,
    };
  }

  private isBusy(sessionId: string): boolean {
    const storageId = this.storageSessionId(sessionId);
    return this.inner.isBusy(sessionId)
      || this.inner.isBusy(storageId)
      || this.acpTurns.has(sessionId)
      || this.acpTurns.has(storageId);
  }

  async list(query: ListSessionsQuery = {}): Promise<SessionPage> {
    const sessions = (await this.inner.list()).filter((session) => {
      if (query.cwd && session.cwd !== query.cwd) return false;
      const effectiveId = this.gatewaySessionIds.get(session.sessionId) ?? session.sessionId;
      const isLive = this.isBusy(session.sessionId) || this.isBusy(effectiveId);
      if (session.hasConversation === false && !isLive) return false;
      const isArchived = this.settings.getBoolean('archived', effectiveId) === true
        || this.settings.getBoolean('archived', session.sessionId) === true;
      return query.archived === true ? isArchived : !isArchived;
    });
    const start = query.cursor
      ? sessions.findIndex((session) => (this.gatewaySessionIds.get(session.sessionId) ?? session.sessionId) === query.cursor || session.sessionId === query.cursor) + 1
      : 0;
    if (query.cursor && start === 0) return { items: [] };
    const limit = query.limit ?? 50;
    const page = sessions.slice(start, start + limit);
    const items = page.map((session) => this.toSession(session));
    return {
      items,
      ...(start + limit < sessions.length && page.length > 0
        ? { next_cursor: items[items.length - 1]!.id }
        : {}),
    };
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const cwd = input.cwd ?? (input.metadata?.cwd as string | undefined) ?? process.cwd();
    const { sessionId } = await this.inner.create(cwd);
    this.sessionCwd.set(sessionId, cwd);
    return {
      id: sessionId,
      workspace_id: workspaceIdFromCwd(cwd, 'grok'),
      title: input.title ?? `Grok ${sessionId.slice(0, 8)}`,
      created_at: nowIso(),
      updated_at: nowIso(),
      busy: false,
      metadata: { cwd },
      provider: this.name,
    };
  }

  async getHistory(sessionId: string, _query: HistoryQuery = {}): Promise<Message[]> {
    const storageId = this.storageSessionId(sessionId);
    const history = await this.inner.getHistory(storageId);
    return history.map((m, index) => {
      const content: Message['content'] = m.blocks && m.blocks.length > 0
        ? m.blocks.map((b) => {
            if (b.type === 'thinking') return { type: 'thinking' as const, thinking: b.text };
            if (b.type === 'tool_use') {
              return { type: 'tool_use' as const, tool_call_id: b.id, tool_name: b.name, input: b.input };
            }
            if (b.type === 'tool_result') {
              return {
                type: 'tool_result' as const,
                tool_call_id: b.tool_use_id,
                output: b.content,
                is_error: b.is_error === true,
              };
            }
            return { type: 'text' as const, text: b.text };
          })
        : [{ type: 'text' as const, text: m.text }];
      return {
        id: `msg_${createHash('sha256')
          .update(JSON.stringify([sessionId, index, m.role, m.timestamp ?? '', m.text]))
          .digest('hex')
          .slice(0, 24)}`,
        session_id: sessionId,
        role: content.length > 0 && content.every((part) => part.type === 'tool_result') ? 'tool' : m.role,
        content: content as MessageContentPart[],
        created_at: m.timestamp ?? '',
        ...(m.model ? { metadata: { model: m.model } } : {}),
      };
    });
  }

  async startTurn(input: StartTurnInput): Promise<TurnHandle> {
    const sessionId = input.sessionId;
    let prompt = textOfInput(input.input);
    const skills = await this.discoverSkills(this.getCwd(sessionId));
    const expandable = skills.filter((skill): skill is SkillCommandInput & { path: string } => typeof skill.path === 'string');
    const expanded = expandGrokSkill(prompt, expandable);
    if (expanded !== null) prompt = expanded;
    const blocks: Array<Record<string, unknown>> = [];
    const notes: string[] = [];
    for (const a of input.attachments ?? []) {
      if (a.kind === 'localImage' && a.path) {
        const data = await fs.promises.readFile(a.path).catch(() => null);
        if (data) blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType ?? 'image/png', data: data.toString('base64') } });
        else notes.push(fileAttachText(a));
      } else if (a.kind === 'imageDataUrl' && a.dataUrl) {
        const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(a.dataUrl);
        if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
        else notes.push(fileAttachText(a));
      } else if (a.path) {
        notes.push(fileAttachText(a));
      }
    }
    if (notes.length > 0) prompt = [...notes, prompt].filter((s) => s.trim()).join('\n');
    const storageId = this.storageSessionId(sessionId);
    const isNew = !this.inner.hasSessionFile(storageId);
    const cwd = this.getCwd(sessionId);
    const model = this.settings.getString('model', sessionId);
    const thinking = this.getThinking(sessionId);
    const effort = grokEffort(thinking);
    const perm = this.getPermission(sessionId);
    const permissionMode = this.settings.getBoolean('plan', sessionId)
      ? 'plan'
      : grokPermissionMode(perm);
    const turnId = randomUUID();
    const stream = new EventStream<GatewayEvent>();

    const emit = (ev: GrokAdapterEvent): void => {
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
              output: '工具需要权限,Grok 非交互模式自动拒绝(网关未开启写权限)',
              is_error: true,
            },
          });
          break;
        case 'done':
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

    const contentBlocks =
      blocks.length > 0 ? [...blocks, ...(prompt.trim() ? [{ type: 'text', text: prompt }] : [])] : undefined;

    const yolo = permissionMode === 'bypassPermissions';
    const autoMode = perm === 'auto';
    void this.startTurnPreferAcp({
      sessionId,
      prompt,
      cwd,
      isNew,
      model,
      effort,
      permissionMode,
      contentBlocks,
      yolo,
      autoMode,
      plan: this.settings.getBoolean('plan', sessionId) === true,
      emit,
      stream,
      turnId,
    });

    return { turnId, events: stream };
  }

  private async startTurnPreferAcp(opts: {
    sessionId: string;
    prompt: string;
    cwd?: string;
    isNew: boolean;
    model?: string;
    effort?: string;
    permissionMode?: string;
    contentBlocks?: Array<Record<string, unknown>>;
    yolo: boolean;
    autoMode?: boolean;
    plan: boolean;
    emit: (ev: GrokAdapterEvent) => void;
    stream: EventStream<GatewayEvent>;
    turnId: string;
  }): Promise<void> {
    const acp = await this.ensureAcp(opts.yolo);
    if (acp) {
      try {
        await this.runAcpTurn(acp, opts);
        return;
      } catch (err) {
        this.acpTurns.delete(opts.sessionId);
        if (!opts.stream) return;
        opts.emit({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }
    void this.inner
      .startTurn({
        sessionId: opts.sessionId,
        prompt: opts.prompt,
        cwd: opts.cwd,
        isNew: opts.isNew,
        model: opts.model,
        effort: opts.effort,
        permissionMode: opts.permissionMode,
        contentBlocks: opts.contentBlocks,
        onEvent: opts.emit,
      })
      .catch((err: unknown) => {
        opts.stream.push({
          kind: 'turn',
          status: 'failed',
          sessionId: opts.sessionId,
          turnId: opts.turnId,
          timestamp: Date.now(),
          payload: { reason: 'failed', error: err instanceof Error ? err.message : String(err) },
        });
        opts.stream.end();
      });
  }

  private async ensureAcp(alwaysApprove: boolean): Promise<GrokAcpClient | null> {
    if (this.disposed) return null;
    if (this.recycleTimer) {
      clearTimeout(this.recycleTimer);
      this.recycleTimer = null;
    }
    const existing = this.acpClients.get(alwaysApprove);
    if (existing?.ready) return existing;
    const inflight = this.acpConnecting.get(alwaysApprove);
    if (inflight) return inflight;

    const pending = (async (): Promise<GrokAcpClient | null> => {
      if (this.disposed) return null;
      if (existing) {
        this.acpClients.delete(alwaysApprove);
        await existing.close().catch(() => undefined);
      }
      const client = new GrokAcpClient({
        grokBin: this.grokBin,
        env: this.grokEnv,
        alwaysApprove,
        requestTimeoutMs: 20_000,
        // Turns can legitimately run for minutes; the old 20s cap killed live turns.
        promptTimeoutMs: 0,
      });
      try {
        await client.connect();
        if (this.disposed) {
          await client.close().catch(() => undefined);
          return null;
        }
        this.acpClients.set(alwaysApprove, client);
        client.onEvent((ev) => this.onAcpProcessEvent(client, alwaysApprove, ev));
        if (this.recycleGraceMs > 0) {
          this.scheduleRecycleWhenIdle();
        }
        return client;
      } catch {
        await client.close().catch(() => undefined);
        return null;
      }
    })().finally(() => {
      if (this.acpConnecting.get(alwaysApprove) === pending) {
        this.acpConnecting.delete(alwaysApprove);
      }
    });
    this.acpConnecting.set(alwaysApprove, pending);
    return pending;
  }

  private clientForSession(sessionId: string): GrokAcpClient | null {
    const bound = this.sessionClient.get(sessionId);
    if (bound?.ready) return bound;
    for (const client of this.acpClients.values()) {
      if (client.ready) return client;
    }
    return null;
  }

  private matchesSessionId(evSessionId: string | undefined, gatewaySessionId: string): boolean {
    if (!evSessionId) return false;
    return evSessionId === gatewaySessionId || evSessionId === this.acpId(gatewaySessionId);
  }

  private storageSessionId(sessionId: string): string {
    if (this.inner.hasSessionFile(sessionId)) return sessionId;
    const mapped = this.acpSessionIds.get(sessionId) ?? this.settings.getString('acpId', sessionId);
    if (mapped && this.inner.hasSessionFile(mapped)) return mapped;
    return mapped ?? sessionId;
  }

  private async runAcpTurn(
    acp: GrokAcpClient,
    opts: {
      sessionId: string;
      prompt: string;
      cwd?: string;
      isNew: boolean;
      model?: string;
      effort?: string;
      contentBlocks?: Array<Record<string, unknown>>;
      plan: boolean;
      yolo: boolean;
      autoMode?: boolean;
      emit: (ev: GrokAdapterEvent) => void;
      stream: EventStream<GatewayEvent>;
      turnId: string;
    },
  ): Promise<void> {
    const cwd = opts.cwd ?? os.homedir();
    if (this.recycleTimer) {
      clearTimeout(this.recycleTimer);
      this.recycleTimer = null;
    }
    this.acpTurns.set(opts.sessionId, opts.stream);
    this.sessionClient.set(opts.sessionId, acp);
    const unsub = acp.onEvent((ev) => this.mapAcpEvent(opts.sessionId, opts.turnId, opts.stream, ev));
    try {
      let acpSessionId = this.acpId(opts.sessionId);
      if (opts.isNew) {
        const created = await acp.sessionNew({
          cwd,
          sessionId: opts.sessionId,
          yoloMode: opts.yolo,
          autoMode: opts.autoMode,
          planMode: opts.plan,
          model: opts.model,
          effort: opts.effort,
        });
        acpSessionId = created.sessionId || opts.sessionId;
        this.rememberAcpSession(opts.sessionId, acpSessionId, cwd);
      } else {
        try {
          await acp.sessionLoad({
            sessionId: acpSessionId,
            cwd,
            autoMode: opts.autoMode,
            yoloMode: opts.yolo,
          });
        } catch {
          const created = await acp.sessionNew({
            cwd,
            sessionId: opts.sessionId,
            yoloMode: opts.yolo,
            autoMode: opts.autoMode,
            planMode: opts.plan,
            model: opts.model,
            effort: opts.effort,
          });
          acpSessionId = created.sessionId || opts.sessionId;
          this.rememberAcpSession(opts.sessionId, acpSessionId, cwd);
        }
      }
      // session/new _meta hints are advisory on 1.0.77; the standard RPCs are authoritative.
      await this.applyLiveConfig(acp, acpSessionId, {
        model: opts.model,
        effort: opts.effort,
        plan: opts.plan,
      });
      const prompt = acpPrompt(opts.prompt, opts.contentBlocks);
      const { stopReason } = await acp.sessionPrompt({ sessionId: acpSessionId, prompt });
      const cancelled = stopReason === 'cancelled' || stopReason === 'max_tokens';
      opts.stream.push({
        kind: 'turn',
        status: cancelled ? 'cancelled' : 'completed',
        sessionId: opts.sessionId,
        turnId: opts.turnId,
        timestamp: Date.now(),
        payload: { reason: cancelled ? 'cancelled' : 'completed' },
      });
      opts.stream.end();
    } finally {
      unsub();
      this.acpTurns.delete(opts.sessionId);
      if (this.recycleGraceMs > 0) {
        this.scheduleRecycleWhenIdle();
      }
    }
  }

  private rememberAcpSession(gatewayId: string, acpId: string, cwd: string): void {
    this.acpSessionIds.set(gatewayId, acpId);
    this.sessionCwd.set(gatewayId, cwd);
    if (acpId && acpId !== gatewayId) {
      this.gatewaySessionIds.set(acpId, gatewayId);
      this.sessionCwd.set(acpId, cwd);
      this.settings.set('acpId', gatewayId, acpId);
    }
  }

  private mapAcpEvent(
    sessionId: string,
    turnId: string,
    stream: EventStream<GatewayEvent>,
    ev: GrokAcpEvent,
  ): void {
    const ts = Date.now();
    switch (ev.type) {
      case 'message_chunk':
        if (!this.matchesSessionId(ev.sessionId, sessionId)) return;
        stream.push({
          kind: 'message',
          status: 'delta',
          sessionId,
          turnId,
          timestamp: ts,
          payload: { delta: ev.text, message: emptyAssistantMessage(sessionId) },
        });
        break;
      case 'thought_chunk':
        if (!this.matchesSessionId(ev.sessionId, sessionId)) return;
        stream.push({
          kind: 'thinking',
          status: 'delta',
          sessionId,
          turnId,
          timestamp: ts,
          payload: { text: '', delta: ev.text },
        });
        break;
      case 'tool_call':
        if (!this.matchesSessionId(ev.sessionId, sessionId)) return;
        stream.push({
          kind: 'tool',
          status: 'started',
          sessionId,
          turnId,
          timestamp: ts,
          payload: { toolCallId: ev.toolCallId, name: ev.title, input: ev.rawInput },
        });
        break;
      case 'tool_call_update': {
        if (!this.matchesSessionId(ev.sessionId, sessionId)) return;
        const isFailed = ev.status === 'failed' || ev.status === 'error' || ev.status === 'cancelled';
        const isTerminal = isFailed || ev.status === 'completed';
        const status: EventStatus = isTerminal ? (isFailed ? 'failed' : 'completed') : 'delta';
        const hasRawOutput = ev.rawOutput !== undefined && ev.rawOutput !== null;
        const output = !hasRawOutput
          ? undefined
          : typeof ev.rawOutput === 'string'
            ? ev.rawOutput
            : JSON.stringify(ev.rawOutput);
        stream.push({
          kind: 'tool',
          status,
          sessionId,
          turnId,
          timestamp: ts,
          payload: {
            toolCallId: ev.toolCallId,
            name: ev.title ?? '',
            ...(output !== undefined ? { output } : {}),
            is_error: isFailed,
          },
        });
        break;
      }
      case 'question_request':
        if (ev.sessionId && !this.matchesSessionId(ev.sessionId, sessionId)) return;
        stream.push({
          kind: 'question',
          status: 'started',
          sessionId,
          turnId,
          timestamp: ts,
          payload: {
            questionId: ev.questionId,
            prompt: ev.prompt,
            options: ev.options,
            isBlocking: true,
            questions: ev.questions,
            rawQuestions: ev.rawQuestions,
            ...(ev.toolCallId ? { itemId: ev.toolCallId } : {}),
          },
        });
        break;
      case 'goal_update':
        if (ev.sessionId && !this.matchesSessionId(ev.sessionId, sessionId)) return;
        this.sessionGoals.set(sessionId, normalizeGoal(ev.goal, sessionId));
        break;
      case 'plan':
        if (ev.sessionId && !this.matchesSessionId(ev.sessionId, sessionId)) return;
        stream.push({
          kind: 'plan',
          status: 'updated',
          sessionId,
          turnId,
          timestamp: ts,
          payload: { raw: ev.plan },
        });
        break;
      case 'permission_request':
        if (!this.matchesSessionId(ev.sessionId, sessionId)) return;
        stream.push({
          kind: 'approval',
          status: 'started',
          sessionId,
          turnId,
          timestamp: ts,
          payload: {
            approvalId: String(ev.requestId),
            itemId: String((ev.toolCall as { toolCallId?: unknown; id?: unknown } | undefined)?.toolCallId
              ?? (ev.toolCall as { id?: unknown } | undefined)?.id
              ?? ''),
            tool: String((ev.toolCall as { title?: string } | undefined)?.title ?? 'tool'),
            input: ev.toolCall,
            options: ev.options.map((o) => o.optionId),
          },
        });
        break;
      case 'usage':
        if (!this.matchesSessionId(ev.sessionId, sessionId)) return;
        this.sessionUsage.set(sessionId, usageFromAcp(ev.usage, this.sessionUsage.get(sessionId)));
        break;
      default:
        break;
    }
  }

  private onAcpProcessEvent(client: GrokAcpClient, alwaysApprove: boolean, ev: GrokAcpEvent): void {
    if (ev.type === 'disconnected') {
      if (this.acpClients.get(alwaysApprove) === client) {
        this.acpClients.delete(alwaysApprove);
      }
      for (const [sid, bound] of this.sessionClient) {
        if (bound === client) this.sessionClient.delete(sid);
      }
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const client = this.clientForSession(sessionId);
    if (client?.ready) {
      await client.sessionCancel(this.acpId(sessionId)).catch(() => undefined);
    }
    this.inner.interrupt(sessionId);
  }

  async resolveApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const acpId = this.acpId(sessionId);
    const candidates = [this.clientForSession(sessionId), ...this.acpClients.values()]
      .filter((c, i, arr): c is GrokAcpClient => Boolean(c) && arr.indexOf(c) === i);
    for (const client of candidates) {
      const pending = client.getPendingPermission(approvalId);
      if (!pending) continue;
      if (pending.sessionId && pending.sessionId !== sessionId && pending.sessionId !== acpId) continue;
      if (decision === 'reject') {
        client.cancelPermission(pending.id);
        if (this.recycleGraceMs > 0) this.scheduleRecycleWhenIdle();
        return;
      }
      const optionId = pickPermissionOption(pending.options, decision);
      if (!optionId) {
        client.cancelPermission(pending.id);
        if (this.recycleGraceMs > 0) this.scheduleRecycleWhenIdle();
        throw new ProviderError('invalid_request', 'grok-adapter: no matching permission option', 400);
      }
      client.resolvePermission(pending.id, optionId);
      if (this.recycleGraceMs > 0) this.scheduleRecycleWhenIdle();
      return;
    }
    throw new ProviderError('not_found', `grok-adapter: no pending approval ${approvalId}`, 404);
  }

  async resolveQuestion(
    sessionId: string,
    questionId: string,
    answer: string | Record<string, string[]>,
  ): Promise<void> {
    const acpId = this.acpId(sessionId);
    const candidates = [this.clientForSession(sessionId), ...this.acpClients.values()]
      .filter((c, i, arr): c is GrokAcpClient => Boolean(c) && arr.indexOf(c) === i);
    for (const client of candidates) {
      const pending = client.getPendingQuestion(questionId);
      if (!pending) continue;
      if (pending.sessionId && pending.sessionId !== sessionId && pending.sessionId !== acpId) continue;
      const dismissed = isRecord(answer) && Object.keys(answer).length === 0;
      const ok = dismissed
        ? client.cancelQuestion(questionId)
        : client.resolveQuestion(questionId, answer);
      if (ok) {
        if (this.recycleGraceMs > 0) this.scheduleRecycleWhenIdle();
        return;
      }
    }
    throw new ProviderError('not_found', `grok-adapter: no pending question ${questionId}`, 404);
  }

  async setGoal(sessionId: string, objective: string): Promise<Record<string, unknown> | null> {
    const trimmed = objective.trim();
    if (!trimmed) {
      throw new ProviderError('invalid_request', 'Goal objective cannot be empty', 400);
    }
    const optimistic = normalizeGoal({ objective: trimmed, status: 'active' }, sessionId);
    this.sessionGoals.set(sessionId, optimistic);
    const observed = await this.runGoalCommand(sessionId, `/goal ${trimmed}`);
    const goal = observed ?? this.inner.readGoal(this.storageSessionId(sessionId)) ?? optimistic;
    this.sessionGoals.set(sessionId, goal);
    return goal;
  }

  async getGoal(sessionId: string): Promise<Record<string, unknown> | null> {
    const fromDisk = this.inner.readGoal(this.storageSessionId(sessionId));
    const cached = this.sessionGoals.get(sessionId) ?? null;
    const goal = fromDisk ? { ...cached, ...fromDisk } : cached;
    if (!goal) return null;
    const status = String(goal.status ?? '');
    if (status === 'cleared' || status === 'cancelled') return null;
    return goal;
  }

  async controlGoal(
    sessionId: string,
    control: 'pause' | 'resume' | 'cancel',
  ): Promise<Record<string, unknown> | null> {
    const subcmd = control === 'cancel' ? '/goal clear' : control === 'pause' ? '/goal pause' : '/goal resume';
    const observed = await this.runGoalCommand(sessionId, subcmd);
    if (control === 'cancel') {
      const cleared = observed ?? normalizeGoal({ status: 'cleared' }, sessionId);
      this.sessionGoals.set(sessionId, { ...cleared, status: 'cleared' });
      return null;
    }
    const status = control === 'pause' ? 'paused' : 'active';
    const base = observed ?? this.inner.readGoal(this.storageSessionId(sessionId)) ?? this.sessionGoals.get(sessionId) ?? {};
    const goal = normalizeGoal({ ...base, status }, sessionId);
    this.sessionGoals.set(sessionId, goal);
    return goal;
  }

  async steer(_sessionId: string, _turnId: string, _text: string): Promise<void> {
    throw new ProviderError('unsupported', 'Grok 无 stdin 通道,不支持插话', 400);
  }

  async close(sessionId: string): Promise<void> {
    const acpId = this.acpSessionIds.get(sessionId);
    this.renames.delete(sessionId);
    if (acpId) this.renames.delete(acpId);
    this.sessionCwd.delete(sessionId);
    if (acpId) this.sessionCwd.delete(acpId);
    this.sessionClient.delete(sessionId);
    this.acpSessionIds.delete(sessionId);
    if (acpId) this.gatewaySessionIds.delete(acpId);
    this.sessionUsage.delete(sessionId);
    if (acpId) this.sessionUsage.delete(acpId);
    this.sessionGoals.delete(sessionId);
    this.commandsCache.delete(sessionId);
    if (acpId) this.commandsCache.delete(acpId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.recycleTimer) {
      clearTimeout(this.recycleTimer);
      this.recycleTimer = null;
    }
    this.commandsCache.clear();
    this.skillCache.clear();
    this.sessionCwd.clear();
    this.sessionUsage.clear();
    this.renames.clear();
    this.sessionGoals.clear();
    const connecting = [...this.acpConnecting.values()];
    const clients = [...this.acpClients.values()];
    this.acpClients.clear();
    this.acpConnecting.clear();
    this.sessionClient.clear();
    this.acpSessionIds.clear();
    this.gatewaySessionIds.clear();
    this.settings.close();
    const resolvedConnecting = await Promise.allSettled(connecting);
    for (const r of resolvedConnecting) {
      if (r.status === 'fulfilled' && r.value && !clients.includes(r.value)) {
        clients.push(r.value);
      }
    }
    for (const leftover of this.acpClients.values()) {
      if (!clients.includes(leftover)) clients.push(leftover);
    }
    this.acpClients.clear();
    await Promise.allSettled(clients.map((client) => client.close()));
    await this.inner.close();
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    this.settings.set('model', sessionId, model);
    const client = this.clientForSession(sessionId);
    const acpId = this.acpSessionIds.get(sessionId);
    if (client?.ready && acpId) {
      await client.sessionSetModel(acpId, model).catch(async () => {
        await client.sessionSetConfigOption(acpId, 'model', model).catch(() => undefined);
      });
    }
  }

  getModel(sessionId: string): string | undefined {
    return this.settings.getString('model', sessionId)
      ?? this.settings.getString('model', '__default__')
      ?? this.defaultModel;
  }

  private defaultEffortForModel(client: GrokAcpClient, modelId?: string): string | undefined {
    const models = client.modelState?.availableModels ?? [];
    const targetId = modelId || client.modelState?.currentModelId;
    const info = models.find((m) => m.modelId === targetId);
    if (!info || info.supportsReasoningEffort === false) return undefined;
    const fromDefault = info.reasoningEffort ?? info.reasoningEfforts?.find((e) => e.default)?.value;
    if (fromDefault) return fromDefault;
    if (info.supportsReasoningEffort === true || (info.reasoningEfforts && info.reasoningEfforts.length > 0)) {
      return isKnownGrokReasoningModel(targetId) ? 'high' : info.reasoningEfforts?.[0]?.value;
    }
    return undefined;
  }

  async setThinking(sessionId: string, thinking: string): Promise<void> {
    const normalized = thinking === 'on' ? 'high' : thinking;
    if (normalized === 'auto' || !normalized) {
      this.settings.delete('thinking', sessionId);
      if (sessionId === '__default__') return;
      const client = this.clientForSession(sessionId);
      const acpId = this.acpSessionIds.get(sessionId);
      if (client?.ready && acpId) {
        const hasEffortOpt = client.getConfigOptions(acpId)?.some((o) => o.id === 'reasoning_effort');
        const fallbackEffort =
          grokEffort(this.getThinking('__default__'))
          ?? this.defaultEffortForModel(client, this.getModel(sessionId));
        if (fallbackEffort && (hasEffortOpt || client.modelState)) {
          await client.sessionSetConfigOption(acpId, 'reasoning_effort', fallbackEffort).catch(() => undefined);
        }
      }
      return;
    }
    this.settings.set('thinking', sessionId, normalized);
    if (sessionId === '__default__') return;
    const effort = grokEffort(normalized);
    const client = this.clientForSession(sessionId);
    const acpId = this.acpSessionIds.get(sessionId);
    if (effort && client?.ready && acpId) {
      await client.sessionSetConfigOption(acpId, 'reasoning_effort', effort).catch(() => undefined);
    }
  }

  getThinking(sessionId: string): string | undefined {
    return this.settings.getString('thinking', sessionId)
      ?? this.settings.getString('thinking', '__default__');
  }

  async setPermission(sessionId: string, mode: string): Promise<void> {
    const prev = this.getPermission(sessionId);
    this.settings.set('permission', sessionId, mode);
    if (sessionId === '__default__' || prev === mode) return;
    const bound = this.sessionClient.get(sessionId);
    if (!bound || this.acpTurns.has(sessionId)) return;
    const acpId = this.acpSessionIds.get(sessionId) ?? sessionId;
    const nextYolo = grokPermissionMode(mode) === 'bypassPermissions';
    const prevAuto = prev === 'auto';
    const nextAuto = mode === 'auto';
    if (bound.alwaysApproveEnabled !== nextYolo || prevAuto !== nextAuto) {
      this.sessionClient.delete(sessionId);
      if (bound.ready && acpId) {
        await bound.sessionClose(acpId).catch(() => undefined);
      }
    }
  }

  getPermission(sessionId: string): string | undefined {
    return this.settings.getString('permission', sessionId)
      ?? this.settings.getString('permission', '__default__');
  }

  async setPlanMode(sessionId: string, on: boolean): Promise<void> {
    if (on) this.settings.set('plan', sessionId, true);
    else this.settings.delete('plan', sessionId);
    const client = this.clientForSession(sessionId);
    const acpId = this.acpSessionIds.get(sessionId);
    if (client?.ready && acpId) {
      await client.sessionSetMode(acpId, on ? 'plan' : 'default').catch(() => undefined);
    }
  }

  getPlanMode(sessionId: string): boolean | undefined {
    return this.settings.getBoolean('plan', sessionId);
  }

  async rename(sessionId: string, title: string): Promise<void> {
    this.renames.set(sessionId, title);
    const client = this.clientForSession(sessionId);
    const acpId = this.acpId(sessionId);
    if (client?.ready) {
      await client.sessionRename(acpId, title).catch(() => undefined);
    }
  }

  async listModels(): Promise<NativeModel[]> {
    let liveState: GrokAcpModelState | undefined;
    for (const client of this.acpClients.values()) {
      if (client.ready && client.modelState && client.modelState.availableModels.length > 0) {
        liveState = client.modelState;
        break;
      }
    }
    const acpModelMap = new Map<string, GrokAcpModelInfo>();
    if (liveState) {
      for (const m of liveState.availableModels) {
        acpModelMap.set(m.modelId, m);
      }
    }

    const toAcpModel = (model: string, acpInfo: GrokAcpModelInfo, isDefault: boolean): NativeModel => {
      const isGrok = isKnownGrokReasoningModel(model);
      const supportsEffort = acpInfo.supportsReasoningEffort !== false && (
        acpInfo.supportsReasoningEffort === true ||
        Boolean(acpInfo.reasoningEfforts?.length) ||
        Boolean(acpInfo.reasoningEffort) ||
        isGrok
      );
      const supportEfforts = supportsEffort
        ? (acpInfo.reasoningEfforts?.length
            ? acpInfo.reasoningEfforts.map((e) => e.value)
            : (isGrok ? [...GROK_EFFORTS] : undefined))
        : undefined;
      const defaultEffort = supportsEffort
        ? (acpInfo.reasoningEffort
            ?? acpInfo.reasoningEfforts?.find((e) => e.default)?.value
            ?? (isGrok ? 'high' : undefined))
        : undefined;
      return {
        provider: 'grok',
        model,
        display_name: acpInfo.name ?? model,
        ...(acpInfo.description ? { description: acpInfo.description } : {}),
        max_context_size: acpInfo.totalContextTokens ?? grokContextWindow(model),
        capabilities: supportsEffort ? ['thinking'] : [],
        support_efforts: supportEfforts,
        default_effort: defaultEffort,
        isDefault,
        raw: acpInfo,
      };
    };

    try {
      const { defaultModel, models } = await this.inner.listModels();
      if (defaultModel) this.defaultModel = defaultModel;
      else if (liveState?.currentModelId) this.defaultModel = liveState.currentModelId;

      return models.map((model) => {
        const acpInfo = acpModelMap.get(model);
        if (acpInfo) {
          const isDefault = defaultModel ? defaultModel === model : (liveState?.currentModelId === model);
          return toAcpModel(model, acpInfo, isDefault);
        }

        const isGrok = isKnownGrokReasoningModel(model);
        return {
          provider: 'grok',
          model,
          display_name: model,
          max_context_size: grokContextWindow(model),
          capabilities: isGrok ? ['thinking'] : [],
          support_efforts: isGrok ? [...GROK_EFFORTS] : undefined,
          default_effort: isGrok ? 'high' : undefined,
          isDefault: defaultModel === model,
        };
      });
    } catch (err) {
      if (liveState && liveState.availableModels.length > 0) {
        if (liveState.currentModelId) this.defaultModel = liveState.currentModelId;
        return liveState.availableModels.map((m) =>
          toAcpModel(m.modelId, m, liveState!.currentModelId === m.modelId),
        );
      }
      throw err;
    }
  }

  async listCommands(sessionId?: string, cwdOverride?: string): Promise<NativeCommand[]> {
    const cwd = cwdOverride ?? (sessionId ? this.getCwd(sessionId) : undefined);
    const skills = await this.discoverSkills(cwd);
    const cacheKey = sessionId ? this.acpId(sessionId) : '__default__';
    let native: GrokNativeCommandInput[] = [];

    const liveClient = sessionId ? this.clientForSession(sessionId) : this.clientForSession('');
    if (liveClient?.ready) {
      native = liveClient.getAvailableCommands(sessionId ? this.acpId(sessionId) : undefined);
      if (native.length === 0) {
        for (const client of this.acpClients.values()) {
          native = client.getAvailableCommands(sessionId ? this.acpId(sessionId) : undefined);
          if (native.length > 0) break;
        }
      }
      if (native.length > 0) {
        this.setCommandsCache(cacheKey, native);
        if (!sessionId) {
          this.setCommandsCache('__default__', native);
        }
      }
    } else {
      const hit = this.commandsCache.get(cacheKey);
      if (hit && Date.now() - hit.ts < GrokProviderAdapter.COMMANDS_TTL_MS) {
        native = hit.commands;
      } else {
        if (hit) this.commandsCache.delete(cacheKey);
        const acp = await this.ensureAcp(false);
        if (acp?.ready) {
          native = acp.getAvailableCommands(sessionId ? this.acpId(sessionId) : undefined);
          if (native.length === 0) {
            for (const client of this.acpClients.values()) {
              native = client.getAvailableCommands(sessionId ? this.acpId(sessionId) : undefined);
              if (native.length > 0) break;
            }
          }
          if (native.length > 0) {
            this.setCommandsCache(cacheKey, native);
            if (!sessionId) {
              this.setCommandsCache('__default__', native);
            }
          }
        }
      }
    }
    if (this.recycleGraceMs > 0) {
      this.scheduleRecycleWhenIdle();
    }
    return listGrokCommands(skills, native);
  }

  async listSkills(
    sessionId?: string,
    cwdOverride?: string,
  ): Promise<Array<{ name: string; description: string; path?: string; scope?: string; enabled?: boolean }>> {
    const cwd = cwdOverride ?? (sessionId ? this.getCwd(sessionId) : undefined);
    return (await this.discoverSkills(cwd)).map((skill) => ({
      name: skill.name,
      description: skill.description,
      ...(skill.path ? { path: skill.path } : {}),
      ...(skill.scope ? { scope: skill.scope } : {}),
      enabled: true,
    }));
  }

  private acpId(sessionId: string): string {
    return this.acpSessionIds.get(sessionId) ?? this.settings.getString('acpId', sessionId) ?? sessionId;
  }

  /** Compact is a native slash command on 1.0.77 — there is no compact RPC. */
  async compact(sessionId: string): Promise<void> {
    await this.promptSlashCommand(sessionId, '/compact');
  }

  async fork(sessionId: string): Promise<Session> {
    const cwd = this.getCwd(sessionId) ?? process.cwd();
    const storageId = this.storageSessionId(sessionId);
    let newId: string | null = null;
    const client = this.clientForSession(sessionId);
    if (client?.ready && (this.acpSessionIds.has(sessionId) || this.inner.hasSessionFile(storageId))) {
      const acpFork = await client
        .sessionFork({ sourceSessionId: storageId, sourceCwd: cwd, newCwd: cwd })
        .catch(() => null);
      if (acpFork?.newSessionId) {
        newId = acpFork.newSessionId;
        this.rememberAcpSession(newId, newId, cwd);
      }
    }
    if (!newId) {
      const forked = await this.inner.forkSession(storageId, cwd);
      newId = forked.sessionId;
    }
    this.sessionCwd.set(newId, cwd);
    this.settings.copySession(sessionId, newId);
    const goal = this.sessionGoals.get(sessionId);
    if (goal) this.sessionGoals.set(newId, { ...goal, threadId: newId });
    return {
      id: newId,
      workspace_id: workspaceIdFromCwd(cwd, 'grok'),
      title: this.renames.get(sessionId) ?? `Grok ${newId.slice(0, 8)}`,
      created_at: nowIso(),
      updated_at: nowIso(),
      busy: false,
      metadata: { cwd },
      provider: this.name,
    };
  }

  /** Rewind via the CLI's append-only rewind_marker (no rewind RPC on 1.0.77). */
  async rollback(sessionId: string, numTurns: number): Promise<void> {
    this.inner.rollbackSession(this.storageSessionId(sessionId), numTurns);
  }

  async delete(sessionId: string): Promise<void> {
    const acpId = this.acpId(sessionId);
    const client = this.clientForSession(sessionId);
    if (client?.ready) {
      await client.sessionDelete(acpId).catch(() => undefined);
    }
    this.inner.interrupt(sessionId);
    this.renames.delete(sessionId);
    if (acpId !== sessionId) this.renames.delete(acpId);
    this.sessionCwd.delete(sessionId);
    this.sessionCwd.delete(acpId);
    this.sessionClient.delete(sessionId);
    this.acpSessionIds.delete(sessionId);
    this.gatewaySessionIds.delete(acpId);
    this.sessionUsage.delete(sessionId);
    if (acpId !== sessionId) this.sessionUsage.delete(acpId);
    this.sessionGoals.delete(sessionId);
    this.commandsCache.delete(sessionId);
    this.commandsCache.delete(acpId);
    this.settings.delete('acpId', sessionId);
    this.settings.delete('model', sessionId);
    this.settings.delete('thinking', sessionId);
    this.settings.delete('permission', sessionId);
    this.settings.delete('plan', sessionId);
    this.settings.delete('archived', sessionId);
    this.inner.deleteSession(sessionId);
    if (acpId !== sessionId) this.inner.deleteSession(acpId);
  }

  getUsage(sessionId: string): SessionUsage | undefined {
    const fromDisk = this.inner.readUsage(this.storageSessionId(sessionId));
    const cached = this.sessionUsage.get(sessionId);
    if (!fromDisk) return cached;
    if (!cached) return fromDisk;
    return {
      ...cached,
      ...fromDisk,
      input_tokens: Math.max(fromDisk.input_tokens, cached.input_tokens),
      output_tokens: Math.max(fromDisk.output_tokens, cached.output_tokens),
      cache_read_tokens: Math.max(fromDisk.cache_read_tokens, cached.cache_read_tokens),
      cache_creation_tokens: Math.max(fromDisk.cache_creation_tokens, cached.cache_creation_tokens),
      turn_count: Math.max(fromDisk.turn_count, cached.turn_count),
      reasoning_output_tokens: Math.max(
        fromDisk.reasoning_output_tokens ?? 0,
        cached.reasoning_output_tokens ?? 0,
      ) || undefined,
    };
  }

  private async discoverSkills(cwd?: string): Promise<SkillCommandInput[]> {
    const key = cwd ?? '';
    const cached = this.skillCache.get(key);
    if (cached) {
      if (Date.now() - cached.ts < GrokProviderAdapter.SKILL_CACHE_TTL_MS) {
        return cached.skills;
      }
      this.skillCache.delete(key);
    }
    const skills = await discoverGrokDiskSkills(cwd);
    this.setSkillCache(key, skills);
    return skills;
  }

  /** Best-effort live sync; a missing RPC must not fail the turn. */
  private async applyLiveConfig(
    acp: GrokAcpClient,
    acpSessionId: string,
    opts: { model?: string; effort?: string; plan: boolean },
  ): Promise<void> {
    if (opts.plan) await acp.sessionSetMode(acpSessionId, 'plan').catch(() => undefined);
    if (opts.model) {
      await acp.sessionSetModel(acpSessionId, opts.model).catch(async () => {
        await acp.sessionSetConfigOption(acpSessionId, 'model', opts.model as string).catch(() => undefined);
      });
    }
    if (opts.effort) {
      await acp.sessionSetConfigOption(acpSessionId, 'reasoning_effort', opts.effort).catch(() => undefined);
    } else {
      const effortOpt = acp.getConfigOptions(acpSessionId)?.find((o) => o.id === 'reasoning_effort');
      const defaultEffort = this.defaultEffortForModel(acp, opts.model);
      if (effortOpt && defaultEffort && effortOpt.currentValue !== defaultEffort) {
        await acp.sessionSetConfigOption(acpSessionId, 'reasoning_effort', defaultEffort).catch(() => undefined);
      }
    }
  }

  /**
   * Run a native slash command through ACP when the CLI speaks it, otherwise
   * through the headless fallback. Returns goal snapshots observed on the way.
   */
  private async promptSlashCommand(sessionId: string, command: string): Promise<Record<string, unknown> | null> {
    const cwd = this.getCwd(sessionId) ?? process.cwd();
    const acp = await this.ensureAcp(false);
    const storageId = this.storageSessionId(sessionId);
    if (!acp) {
      await this.inner.startTurn({ sessionId: storageId, prompt: command, cwd, isNew: !this.inner.hasSessionFile(storageId), onEvent: () => undefined });
      return this.inner.readGoal(storageId);
    }
    this.sessionClient.set(sessionId, acp);
    let acpSessionId = this.acpId(sessionId);
    const perm = this.getPermission(sessionId);
    const autoMode = perm === 'auto';
    const yoloMode = perm === 'bypassPermissions' || perm === 'yolo';
    if (!this.inner.hasSessionFile(storageId) && !this.acpSessionIds.has(sessionId)) {
      const created = await acp.sessionNew({ cwd, sessionId, autoMode, yoloMode });
      acpSessionId = created.sessionId || sessionId;
      this.rememberAcpSession(sessionId, acpSessionId, cwd);
    } else {
      await acp.sessionLoad({ sessionId: acpSessionId, cwd, autoMode, yoloMode }).catch(async () => {
        const created = await acp.sessionNew({ cwd, sessionId, autoMode, yoloMode });
        acpSessionId = created.sessionId || sessionId;
        this.rememberAcpSession(sessionId, acpSessionId, cwd);
      });
    }
    let observed: Record<string, unknown> | null = null;
    const unsub = acp.onEvent((ev) => {
      if (ev.type === 'goal_update' && (!ev.sessionId || this.matchesSessionId(ev.sessionId, sessionId))) {
        observed = normalizeGoal(ev.goal, sessionId);
      }
    });
    try {
      await acp.sessionPrompt({ sessionId: acpSessionId, prompt: [{ type: 'text', text: command }] });
    } finally {
      unsub();
      if (this.recycleGraceMs > 0) {
        this.scheduleRecycleWhenIdle();
      }
    }
    return observed;
  }

  private async runGoalCommand(sessionId: string, command: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.promptSlashCommand(sessionId, command);
    } catch {
      return this.inner.readGoal(this.storageSessionId(sessionId));
    }
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    if (archived) this.settings.set('archived', sessionId, true);
    else this.settings.delete('archived', sessionId);
  }

  getCwd(sessionId: string): string | undefined {
    const acpId = this.acpSessionIds.get(sessionId) ?? this.settings.getString('acpId', sessionId);
    return this.sessionCwd.get(sessionId)
      ?? (acpId ? this.sessionCwd.get(acpId) : undefined)
      ?? this.inner.getCwd(sessionId)
      ?? (acpId ? this.inner.getCwd(acpId) : undefined);
  }

  private toSession(s: GrokSessionSummary): Session {
    const id = this.gatewaySessionIds.get(s.sessionId) ?? s.sessionId;
    if (s.cwd) {
      this.sessionCwd.set(s.sessionId, s.cwd);
      this.sessionCwd.set(id, s.cwd);
    }
    const cleanSummary = s.summaryTitle && s.summaryTitle !== '(session)' ? s.summaryTitle : '';
    const cleanFallbackTitle = s.title && s.title !== '(session)' ? s.title : '';
    const title = this.renames.get(id) ?? this.renames.get(s.sessionId) ?? (cleanSummary || s.firstPrompt || cleanFallbackTitle || `Grok ${id.slice(0, 8)}`);
    const lastPrompt = this.renames.get(id)
      ?? this.renames.get(s.sessionId)
      ?? (s.firstPrompt || cleanSummary || (s.hasConversation !== false ? cleanFallbackTitle : '') || '');
    const archived = this.settings.getBoolean('archived', id) === true
      || this.settings.getBoolean('archived', s.sessionId) === true;
    return {
      id,
      workspace_id: workspaceIdFromCwd(s.cwd, 'grok'),
      title,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
      busy: false,
      archived,
      extras: { last_prompt: lastPrompt },
      metadata: { cwd: s.cwd },
      provider: this.name,
    };
  }
}

/** Official grok-4.6 / grok-4.5 context window is 500,000 tokens. Unknown aliases share the family. */
export function grokContextWindow(_model?: string): number {
  return 500_000;
}

export function grokPermissionMode(mode: string | undefined): string | undefined {
  switch (mode) {
    case 'manual': return 'default';
    case 'auto': return 'auto';
    case 'yolo': return 'bypassPermissions';
    default: return undefined;
  }
}

export const GROK_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export function isKnownGrokReasoningModel(modelId?: string): boolean {
  if (!modelId) return false;
  return /^grok(-|$)/i.test(modelId);
}

/** Map Kimi thinking chips onto grok --effort. UI 'on' is not a CLI value. */
export function grokEffort(thinking: string | undefined): string | undefined {
  if (!thinking) return undefined;
  if (thinking === 'off') return 'none';
  if (thinking === 'on') return 'high';
  if ((['none', ...GROK_EFFORTS] as readonly string[]).includes(thinking)) return thinking;
  return undefined;
}

export function acpPrompt(prompt: string, contentBlocks?: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (contentBlocks && contentBlocks.length > 0) {
    const blocks = contentBlocks.map((block) => {
      if (block.type === 'text') return { type: 'text', text: String(block.text ?? '') };
      if (block.type === 'image' && isRecord(block.source)) {
        return {
          type: 'image',
          data: String(block.source.data ?? ''),
          mimeType: String(block.source.media_type ?? 'image/png'),
        };
      }
      return block;
    });
    const hasContent = blocks.some((b) => {
      if (b.type === 'text') return String(b.text ?? '').trim().length > 0;
      if (b.type === 'image') return Boolean(b.data);
      return true;
    });
    if (hasContent) return blocks;
  }
  const trimmed = prompt.trim();
  if (trimmed) return [{ type: 'text', text: trimmed }];
  throw new ProviderError('invalid_request', 'empty prompt', 400);
}

function usageFromAcp(raw: Record<string, unknown>, prev?: SessionUsage): SessionUsage {
  const used = isRecord(raw.used) ? raw.used : isRecord(raw.session) ? raw.session : raw;
  const input = num(used.input_tokens ?? used.inputTokens ?? used.input);
  const output = num(used.output_tokens ?? used.outputTokens ?? used.output);
  const cacheRead = num(used.cachedReadTokens ?? used.cache_read_tokens ?? used.cached_read_tokens);
  const cacheCreate = num(used.cacheCreationTokens ?? used.cache_creation_tokens ?? used.cache_creation_input_tokens);
  const reasoning = num(used.reasoningTokens ?? used.reasoning_output_tokens ?? used.reasoning_tokens);
  const turnCount = num(used.turnCount ?? used.turn_count);
  const cost = num(used.total_cost_usd ?? used.costUsd ?? used.cost_usd)
    || num(used.costUsdTicks) / 1e10;
  return {
    input_tokens: (prev?.input_tokens ?? 0) + input,
    output_tokens: (prev?.output_tokens ?? 0) + output,
    cache_read_tokens: (prev?.cache_read_tokens ?? 0) + cacheRead,
    cache_creation_tokens: (prev?.cache_creation_tokens ?? 0) + cacheCreate,
    total_cost_usd: (prev?.total_cost_usd ?? 0) + cost,
    context_tokens: input + output,
    context_limit: grokContextWindow(),
    turn_count: turnCount > 0 ? turnCount : (prev?.turn_count ?? 0) + 1,
    ...(reasoning > 0 || prev?.reasoning_output_tokens
      ? { reasoning_output_tokens: (prev?.reasoning_output_tokens ?? 0) + reasoning }
      : {}),
  };
}

/** usage.json is cumulative, so its numbers replace (not add to) the cache. */
function usageFromFile(raw: Record<string, unknown>): SessionUsage | null {
  const session = isRecord(raw.session) ? raw.session : raw;
  if (!('inputTokens' in session) && !('input_tokens' in session) && !('totalTokens' in session)) return null;
  const input = num(session.inputTokens ?? session.input_tokens);
  const output = num(session.outputTokens ?? session.output_tokens);
  const reasoning = num(session.reasoningTokens ?? session.reasoning_output_tokens);
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: num(session.cachedReadTokens ?? session.cache_read_tokens),
    cache_creation_tokens: num(session.cacheCreationTokens ?? session.cache_creation_tokens),
    total_cost_usd: num(session.costUsd ?? session.total_cost_usd) || num(session.costUsdTicks) / 1e10,
    context_tokens: input + output,
    context_limit: grokContextWindow(),
    turn_count: num(session.turnCount ?? session.turn_count),
    ...(reasoning > 0 ? { reasoning_output_tokens: reasoning } : {}),
    authoritative: true,
  };
}

/**
 * Goal snapshot that satisfies both direct callers and gateway.ts
 * `codexGoalToWire` (which reads threadId / tokensUsed / timeUsedSeconds / tokenBudget).
 */
function normalizeGoal(raw: Record<string, unknown>, sessionId: string): Record<string, unknown> {
  const nested = isRecord(raw.goal) ? raw.goal : isRecord(raw.state) ? raw.state : raw;
  const goalId = pickString(nested.goal_id, nested.goalId, nested.id) || sessionId;
  const objective = pickString(nested.objective, nested.goal, nested.text);
  const status = pickString(nested.status) || 'active';
  const tokensUsed = num(nested.tokens_used ?? nested.tokensUsed);
  const tokenBudget = num(nested.token_budget ?? nested.tokenBudget);
  const elapsedMs = num(nested.elapsed_ms ?? nested.elapsedMs ?? nested.wall_clock_ms);
  return {
    ...nested,
    goal_id: goalId,
    goalId,
    threadId: goalId,
    objective,
    status,
    tokens_used: tokensUsed,
    tokensUsed,
    token_budget: tokenBudget || undefined,
    tokenBudget: tokenBudget || undefined,
    elapsed_ms: elapsedMs,
    timeUsedSeconds: elapsedMs / 1000,
    ...(typeof nested.phase === 'string' ? { phase: nested.phase } : {}),
  };
}

function updateOf(entry: Record<string, unknown>): Record<string, unknown> {
  const params = isRecord(entry.params) ? entry.params : entry;
  return isRecord(params.update) ? params.update : params;
}

function promptIndexOf(update: Record<string, unknown>): number | undefined {
  const meta = isRecord(update._meta) ? update._meta : {};
  const value = update.promptIndex ?? update.prompt_index ?? meta.promptIndex ?? meta.prompt_index;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Latest un-superseded rewind_marker wins; rewind_points.jsonl alone never truncates un-rewound history. */
function effectiveRewind(
  updates: Array<Record<string, unknown>>,
  _points: Array<Record<string, unknown>>,
): number | undefined {
  let target: number | undefined;
  for (const entry of updates) {
    const update = updateOf(entry);
    const kind = String(update.sessionUpdate ?? update.type ?? '');
    if (kind === 'rewind_marker' || kind === 'rewind') {
      const value = update.target_prompt_index ?? update.targetPromptIndex ?? update.prompt_index;
      if (typeof value === 'number' && Number.isFinite(value)) target = value;
      continue;
    }
    if (kind === 'user_message_chunk' && target !== undefined) {
      target = undefined;
    }
  }
  return target;
}

/**
 * Drop the rewound user turns and everything that belongs to them. User turns
 * are counted in file order (banner-only synthetic entries are not turns).
 */
function applyRewind(messages: GrokHistoryMessage[], target: number | undefined): void {
  if (target === undefined) return;
  let userTurns = 0;
  let cutAt = messages.length;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'user') continue;
    if (userTurns >= target) {
      cutAt = i;
      break;
    }
    userTurns += 1;
  }
  messages.splice(cutAt);
}

/** Reconstruct a transcript from ACP updates when chat_history.jsonl is absent. */
function historyFromUpdates(
  updates: Array<Record<string, unknown>>,
  _rewindTarget: number | undefined,
): GrokHistoryMessage[] {
  const messages: GrokHistoryMessage[] = [];
  let userTurns = 0;
  const flush = (role: GrokHistoryMessage['role'], text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const last = messages[messages.length - 1];
    if (role === 'assistant' && last && last.role === 'assistant') {
      last.text += trimmed;
      last.blocks = [...(last.blocks ?? []), { type: 'text', text: trimmed }];
      return;
    }
    messages.push({ role, text: trimmed, blocks: [{ type: 'text', text: trimmed }] });
  };
  let pending = '';
  let pendingRole: 'user' | 'assistant' | null = null;
  let pendingPromptIndex: number | undefined;
  const commit = (): void => {
    if (pendingRole) flush(pendingRole, pending);
    pending = '';
    pendingRole = null;
    pendingPromptIndex = undefined;
  };
  for (const entry of updates) {
    const update = updateOf(entry);
    const kind = String(update.sessionUpdate ?? update.type ?? '');
    if (kind === 'rewind_marker' || kind === 'rewind') {
      commit();
      const value = update.target_prompt_index ?? update.targetPromptIndex ?? update.prompt_index;
      if (typeof value === 'number' && Number.isFinite(value)) {
        const target = Math.max(0, Math.trunc(value));
        applyRewind(messages, target);
        userTurns = target;
      }
      continue;
    }
    if (kind === 'user_message_chunk') {
      const index = promptIndexOf(update);
      if (pendingRole && (pendingRole !== 'user' || index === undefined || index !== pendingPromptIndex)) {
        commit();
      }
      if (index === undefined) userTurns += 1;
      else if (index >= userTurns) userTurns = index + 1;
      pendingRole = 'user';
      pendingPromptIndex = index;
      pending += textOfContent(update.content);
      continue;
    }
    if (kind === 'agent_message_chunk') {
      if (pendingRole && pendingRole !== 'assistant') commit();
      pendingRole = 'assistant';
      pending += textOfContent(update.content);
      continue;
    }
    if (kind === 'agent_thought_chunk') {
      commit();
      const text = textOfContent(update.content).trim();
      if (text) messages.push({ role: 'assistant', text: '', blocks: [{ type: 'thinking', text }] });
      continue;
    }
    if (kind === 'tool_call') {
      commit();
      const id = String(update.toolCallId ?? update.id ?? '');
      const name = String(update.title ?? update.toolName ?? 'tool');
      messages.push({
        role: 'assistant',
        text: '',
        blocks: [{ type: 'tool_use', id, name, input: update.rawInput ?? update.input ?? {} }],
      });
    }
  }
  commit();
  return messages;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  if (Array.isArray(content)) return content.map((part) => textOfContent(part)).join('');
  return '';
}

interface PromptFile {
  path: string;
  cleanup: () => void;
}

function imageExtension(mediaType?: string): string {
  switch (mediaType?.toLowerCase()) {
    case 'image/png': return '.png';
    case 'image/jpeg':
    case 'image/jpg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'image/svg+xml': return '.svg';
    default: return '.png';
  }
}

/**
 * Payloads that would blow the argv limit (large text or base64 images) are
 * handed to the CLI as a 0600 temp file via --prompt-file.
 *
 * Grok CLI --prompt-file reads plain UTF-8 text, NOT JSON contentBlocks.
 * Base64 images are cleanly materialized into 0600 temporary files and referenced
 * by path in the plain text prompt, cleaned up after turn completion.
 */
export function materializePromptFile(
  prompt: string,
  contentBlocks?: Array<Record<string, unknown>>,
): PromptFile | null {
  const hasBlocks = contentBlocks && contentBlocks.length > 0;
  const json = hasBlocks ? JSON.stringify(contentBlocks) : '';
  const oversized = Buffer.byteLength(json || prompt, 'utf8') > MAX_INLINE_PROMPT_BYTES;
  if (!oversized) return null;

  const cleanupFiles: string[] = [];
  const textParts: string[] = [];
  const promptTrimmed = prompt.trim();
  if (promptTrimmed) {
    textParts.push(promptTrimmed);
  }

  if (hasBlocks) {
    for (const block of contentBlocks) {
      if (block.type === 'text') {
        const t = String(block.text ?? '').trim();
        if (t && !textParts.includes(t)) {
          textParts.push(t);
        }
      } else if (block.type === 'image') {
        let base64Data: string | undefined;
        let mediaType: string | undefined;
        if (isRecord(block.source) && block.source.type === 'base64') {
          base64Data = typeof block.source.data === 'string' ? block.source.data : undefined;
          mediaType = typeof block.source.media_type === 'string' ? block.source.media_type : undefined;
        } else if (typeof block.data === 'string') {
          base64Data = block.data;
          mediaType = typeof block.mimeType === 'string' ? block.mimeType : undefined;
        }

        if (base64Data) {
          const imgPath = path.join(os.tmpdir(), `grok-img-${randomUUID()}${imageExtension(mediaType)}`);
          try {
            fs.writeFileSync(imgPath, Buffer.from(base64Data, 'base64'), { mode: 0o600 });
            try {
              fs.chmodSync(imgPath, 0o600);
            } catch {
              // mode on writeFile is enough on POSIX
            }
            cleanupFiles.push(imgPath);
            textParts.push(`Attached image: ${imgPath}`);
          } catch {
            // failed to write temp image file
          }
        } else if (typeof block.path === 'string') {
          textParts.push(`Attached image: ${block.path}`);
        }
      }
    }
  }

  const fileText = textParts.filter(Boolean).join('\n\n') || prompt;
  const filePath = path.join(os.tmpdir(), `grok-prompt-${randomUUID()}.txt`);
  fs.writeFileSync(filePath, fileText, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // mode on writeFile is enough on POSIX
  }
  cleanupFiles.push(filePath);

  let cleaned = false;
  return {
    path: filePath,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      for (const file of cleanupFiles) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // already gone
        }
      }
    },
  };
}

/** Disk skills: Grok's own dirs plus the Claude/agents dirs it also loads. */
export async function discoverGrokDiskSkills(
  cwd?: string,
  options?: { maxEntries?: number; maxDepth?: number },
): Promise<SkillCommandInput[]> {
  const home = os.homedir();
  const maxEntries = Math.max(1, options?.maxEntries ?? 500);
  const maxDepth = Math.max(1, options?.maxDepth ?? 3);
  let totalEntriesScanned = 0;
  const claude = await discoverClaudeDiskCommands(cwd, path.join(home, '.claude'), { maxEntries }).catch(
    () => [] as ClaudeCatalogCommand[],
  );
  const grokDirs: Array<{ dir: string; scope: string }> = [
    ...(cwd ? [{ dir: path.join(cwd, '.grok', 'skills'), scope: 'project' }] : []),
    ...(cwd ? [{ dir: path.join(cwd, '.grok', 'commands'), scope: 'project' }] : []),
    { dir: path.join(home, '.grok', 'skills'), scope: 'user' },
    { dir: path.join(home, '.grok', 'commands'), scope: 'user' },
  ];
  const out: SkillCommandInput[] = claude
    .filter((entry) => entry.source === 'skill' || entry.source === 'command')
    .map((entry) => ({
      name: entry.name,
      description: entry.description,
      ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
      ...(entry.aliases ? { aliases: entry.aliases } : {}),
      ...(entry.path ? { path: entry.path } : {}),
      ...(entry.scope ? { scope: entry.scope } : {}),
    }));
  const seen = new Set(out.map((skill) => skill.name));
  for (const { dir, scope } of grokDirs) {
    if (seen.size >= maxEntries || totalEntriesScanned >= maxEntries) break;
    const queue: Array<{ currentDir: string; depth: number }> = [{ currentDir: dir, depth: 0 }];
    while (queue.length > 0) {
      if (seen.size >= maxEntries || totalEntriesScanned >= maxEntries) break;
      const { currentDir, depth } = queue.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        totalEntriesScanned++;
        if (totalEntriesScanned >= maxEntries || seen.size >= maxEntries) break;
        const full = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          const skillMd = path.join(full, 'SKILL.md');
          if (fs.existsSync(skillMd)) {
            const text = readTailNoFollow(skillMd, 64 * 1024);
            if (text !== null) {
              const name = entry.name;
              if (name && !seen.has(name)) {
                seen.add(name);
                const description = text.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('---')) ?? name;
                out.push({ name, description: description.replace(/^#+\s*/, '').slice(0, 200), path: skillMd, scope });
              }
            }
          } else if (depth < maxDepth) {
            queue.push({ currentDir: full, depth: depth + 1 });
          }
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          const text = readTailNoFollow(full, 64 * 1024);
          if (text !== null) {
            const name = entry.name.replace(/\.md$/i, '');
            if (name && !seen.has(name)) {
              seen.add(name);
              const description = text.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('---')) ?? name;
              out.push({ name, description: description.replace(/^#+\s*/, '').slice(0, 200), path: full, scope });
            }
          }
        }
      }
    }
  }
  return out;
}



function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseGrokModels(text: string): { defaultModel?: string; models: string[] } {
  let defaultModel: string | undefined;
  const models: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const def = /^Default model:\s+(\S+)/i.exec(line);
    if (def) {
      defaultModel = def[1];
      continue;
    }
    const avail = /^[*+-]\s+(\S+)/.exec(line);
    if (!avail) continue;
    const name = avail[1].replace(/\(default\)\s*$/i, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    models.push(name);
  }
  if (defaultModel) {
    const rest = models.filter((model) => model !== defaultModel);
    models.length = 0;
    models.push(defaultModel, ...rest);
    seen.add(defaultModel);
  }
  return { defaultModel, models };
}

function mapHistoryEntry(entry: any): GrokHistoryMessage | null {
  const type = entry?.type;
  if (type === 'system') return null;

  if (type === 'reasoning') {
    const text = extractReasoning(entry);
    if (!text) return null;
    return { role: 'assistant', text: '', blocks: [{ type: 'thinking', text }] };
  }

  if (type === 'tool_result') {
    const id = String(entry.tool_call_id ?? entry.tool_use_id ?? '');
    const content = toolResultText(entry.content);
    return {
      role: 'tool',
      text: '',
      blocks: [{
        type: 'tool_result',
        tool_use_id: id,
        content,
        ...(entry.is_error === true ? { is_error: true } : {}),
      }],
    };
  }

  if (type === 'user' || type === 'assistant') {
    const blocks: NonNullable<GrokHistoryMessage['blocks']> = [];
    const content = entry.content ?? entry.message?.content;
    if (type === 'user' && (entry.synthetic_reason || isGrokBannerText(extractText(content)))) {
      const query = unwrapUserQuery(extractText(content));
      if (!query) return null;
      return { role: 'user', text: query, blocks: [{ type: 'text', text: query }] };
    }
    if (typeof content === 'string' && content) {
      const text = type === 'user' ? normalizeGrokUserText(content) : content;
      if (text) blocks.push({ type: 'text', text });
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'thinking' && typeof (b.thinking ?? b.text) === 'string') {
          const t = String(b.thinking ?? b.text).trim();
          if (t) blocks.push({ type: 'thinking', text: t });
        } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        } else if (b.type === 'tool_result') {
          blocks.push({
            type: 'tool_result',
            tool_use_id: String(b.tool_use_id ?? b.tool_call_id ?? ''),
            content: toolResultText(b.content),
            ...(b.is_error === true ? { is_error: true } : {}),
          });
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text) {
          const text = type === 'user' ? normalizeGrokUserText(b.text) : b.text;
          if (text) {
            blocks.push({ type: 'text', text });
          }
        }
      }
    }
    if (Array.isArray(entry.tool_calls)) {
      for (const call of entry.tool_calls) {
        if (!call || typeof call !== 'object') continue;
        const id = String(call.id ?? '');
        const name = String(call.name ?? '');
        if (!id && !name) continue;
        blocks.push({ type: 'tool_use', id, name, input: parseToolArguments(call.arguments ?? call.input) });
      }
    }
    const rawText = extractText(content);
    const blockText = blocks
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const text = blockText.trim() || (type === 'user' ? normalizeGrokUserText(rawText) : rawText);
    if (!text && blocks.length === 0) return null;
    const role: GrokHistoryMessage['role'] =
      blocks.length > 0 && blocks.every((b) => b.type === 'tool_result') ? 'tool' : type;
    return {
      role,
      text,
      ...(blocks.length > 0 ? { blocks } : {}),
      model: type === 'assistant' ? (entry.model_id ?? entry.model ?? entry.message?.model) : undefined,
    };
  }

  return null;
}

function mapStreamEvent(ev: any): GrokAdapterEvent[] {
  const out: GrokAdapterEvent[] = [];
  switch (ev?.type) {
    case 'system':
      if (ev.subtype === 'init') {
        out.push({
          type: 'init',
          sessionId: ev.session_id,
          cwd: ev.cwd,
          tools: Array.isArray(ev.tools) ? ev.tools : [],
        });
      }
      break;

    case 'stream_event': {
      const e = ev.event;
      if (e?.type === 'content_block_delta') {
        const d = e.delta;
        if (d?.type === 'text_delta' && typeof d.text === 'string') {
          out.push({ type: 'text_delta', text: d.text });
        } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
          out.push({ type: 'thinking_delta', text: d.thinking });
        }
      }
      break;
    }

    case 'assistant': {
      const content = ev.message?.content ?? ev.content;
      if (Array.isArray(content)) {
        if (ev.message?.model === '<synthetic>') {
          const text = extractText(content);
          if (text) out.push({ type: 'synthetic_text', text });
        }
        for (const block of content) {
          if (block?.type === 'tool_use') {
            out.push({
              type: 'tool_use',
              toolUseId: String(block.id ?? ''),
              name: String(block.name ?? ''),
              input: block.input,
            });
          }
        }
      }
      if (Array.isArray(ev.tool_calls) || Array.isArray(ev.message?.tool_calls)) {
        for (const call of ev.tool_calls ?? ev.message.tool_calls) {
          out.push({
            type: 'tool_use',
            toolUseId: String(call?.id ?? ''),
            name: String(call?.name ?? ''),
            input: parseToolArguments(call?.arguments ?? call?.input),
          });
        }
      }
      break;
    }

    case 'user': {
      const content = ev.message?.content ?? ev.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result') {
            out.push({
              type: 'tool_result',
              toolUseId: String(block.tool_use_id ?? block.tool_call_id ?? ''),
              content:
                typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content ?? ''),
              isError: block.is_error === true,
            });
          }
        }
      }
      break;
    }

    case 'result': {
      const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
      if (denials.length > 0) {
        out.push({
          type: 'permission_denied',
          denials: denials.map((d: any) => ({
            tool_name: String(d.tool_name ?? ''),
            tool_use_id: String(d.tool_use_id ?? ''),
            tool_input: d.tool_input,
          })),
        });
      }
      out.push({
        type: 'done',
        sessionId: String(ev.session_id ?? ''),
        result: typeof ev.result === 'string' ? ev.result : '',
        isError: ev.is_error === true,
        subtype: String(ev.subtype ?? ''),
        stopReason: ev.stop_reason ?? null,
        usage: ev.usage,
        durationMs: ev.duration_ms,
      });
      break;
    }

    default:
      break;
  }
  return out;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string') {
      parts.push((block as any).text);
    }
  }
  return parts.join('').trim();
}

function extractReasoning(entry: any): string {
  if (typeof entry?.text === 'string' && entry.text.trim()) return entry.text.trim();
  if (typeof entry?.thinking === 'string' && entry.thinking.trim()) return entry.thinking.trim();
  if (Array.isArray(entry?.summary)) {
    return entry.summary
      .map((s: any) => (typeof s === 'string' ? s : s?.text ?? ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function toolResultText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return (raw as Array<Record<string, unknown>>).map((x) => (x.text as string) ?? '').join('');
  }
  if (raw == null) return '';
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value ?? {};
}

function isGrokBannerText(text: string): boolean {
  const t = text.trim();
  return t.startsWith('<user_info>')
    || t.startsWith('<system-reminder>')
    || t.startsWith('<rules>')
    || t.includes('<always_applied_workspace_rules')
    || t.includes('MCP servers connected:');
}

function unwrapUserQuery(text: string): string | null {
  const match = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
  const query = match?.[1]?.trim();
  return query || null;
}

function normalizeGrokUserText(raw: string): string {
  if (/<user_query>[\s\S]*?<\/user_query>/.test(raw)) {
    return unwrapUserQuery(raw) ?? '';
  }
  return isGrokBannerText(raw) ? '' : raw;
}

function inspectGrokSessionFiles(
  dir: string,
  raw: Record<string, unknown>,
): { hasConversation: boolean; firstPrompt?: string; summaryTitle?: string } {
  const rawSummary = pickString(raw.session_summary, raw.generated_title);
  const summaryTitle = rawSummary && rawSummary !== '(session)' ? rawSummary : '';
  const numMessages = typeof raw.num_messages === 'number' && Number.isFinite(raw.num_messages)
    ? raw.num_messages
    : undefined;

  if (numMessages !== undefined && numMessages > 0 && summaryTitle) {
    return { hasConversation: true, summaryTitle };
  }

  let hasMappedMsg = false;
  let firstPrompt = '';
  const chatHead = readHeadNoFollow(path.join(dir, 'chat_history.jsonl'), 256 * 1024);
  for (const entry of parseJsonl(chatHead)) {
    const mapped = mapHistoryEntry(entry);
    if (!mapped) continue;
    hasMappedMsg = true;
    if (!firstPrompt && mapped.role === 'user' && mapped.text.trim()) {
      firstPrompt = mapped.text.replace(/\s+/g, ' ').trim().slice(0, 120);
    }
    if (firstPrompt && (numMessages === undefined || numMessages > 0)) break;
  }

  if (!hasMappedMsg) {
    const updatesHead = readHeadNoFollow(path.join(dir, 'updates.jsonl'), 64 * 1024);
    const updates = parseJsonl(updatesHead);
    if (updates.length > 0) {
      const reconstructed = historyFromUpdates(updates, undefined);
      if (reconstructed.length > 0) {
        hasMappedMsg = true;
        const firstUser = reconstructed.find((m) => m.role === 'user' && m.text.trim());
        if (firstUser) {
          firstPrompt = firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 120);
        }
      }
    }
  }

  const hasConversation = hasMappedMsg
    || (numMessages !== undefined ? numMessages > 0 : Boolean(summaryTitle));

  return {
    hasConversation,
    ...(firstPrompt ? { firstPrompt } : {}),
    ...(summaryTitle ? { summaryTitle } : {}),
  };
}

function readSessionTimes(dir: string): { createdAt: string; updatedAt: string } {
  const raw = readJsonNoFollow(path.join(dir, 'summary.json'));
  if (!raw) return { createdAt: '', updatedAt: '' };
  const updatedAt = pickString(raw.updated_at, raw.last_active_at);
  const createdAt = pickString(raw.created_at) || updatedAt;
  return { createdAt, updatedAt };
}

function interpolateIso(createdAt: string, updatedAt: string, index: number, count: number): string {
  if (count <= 1 || index <= 0) return createdAt || updatedAt;
  if (index >= count - 1) return updatedAt || createdAt;
  const start = Date.parse(createdAt);
  const end = Date.parse(updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return createdAt || updatedAt;
  return new Date(start + ((end - start) * index) / (count - 1)).toISOString();
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function decodeUriComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function workspaceIdFromCwd(cwd: string, provider: string): string {
  const normalized = path.resolve(cwd).replace(/[\\/]+$/, '') || '/';
  const slug = normalized.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root';
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  const prefix = `wd_${provider}_`;
  const maxSlug = Math.max(1, 60 - prefix.length - 1 - hash.length);
  return `${prefix}${slug.slice(0, maxSlug)}_${hash}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function textOfInput(input: StartTurnInput['input']): string {
  if (typeof input === 'string') return input;
  return input
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function fileAttachText(a: TurnAttachment): string {
  const mime = a.mediaType ?? 'application/octet-stream';
  const size = a.size ?? 0;
  const name = a.name ?? a.path?.split('/').pop() ?? 'file';
  return `Attached file "${name}" (${mime}, ${size} bytes): ${a.path} — open it with the Read tool`;
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
