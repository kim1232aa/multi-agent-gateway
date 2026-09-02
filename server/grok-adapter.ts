/**
 * GrokAdapter — wraps the Grok CLI (tested with 1.0.5; ACP rechecked on 1.0.13) as a ProviderAdapter.
 *
 * Main path: ACP (`grok agent stdio`, see grok-acp.ts). One long-lived JSON-RPC
 * process, multiple sessions. Headless `-p` is the fallback when ACP spawn or
 * initialize fails.
 *
 * Headless turn:
 *   grok -p PROMPT --output-format streaming-messages-json --include-partial-messages
 *        [--session-id UUID | --resume UUID] [--model] [--effort] [--permission-mode]
 *
 * The prompt is an argv flag (`-p` / `--prompt-json` / `--prompt-file`). Grok does
 * NOT read a piped stdin user-JSON line as the prompt (unlike Claude stream-json),
 * so stdin is unused (stdio ignore) / never written.
 *
 * Session files live under ~/.grok/sessions/<urlencoded-cwd>/<session-id>/
 * (summary.json + chat_history.jsonl, plus ACP updates.jsonl).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { listGrokCommands } from './native-commands.js';
import { GrokAcpClient, pickPermissionOption, type GrokAcpEvent } from './grok-acp.js';
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

export interface GrokSessionSummary {
  sessionId: string;
  title: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
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

export class GrokAdapter {
  private readonly grokBin: string;
  private readonly env: Record<string, string>;
  private readonly sessionsDir: string;
  private readonly running = new Map<string, ChildProcess>();
  private readonly interruptRequested = new Set<string>();
  private readonly exitWaiters = new Map<string, Array<() => void>>();
  private readonly sessionCwd = new Map<string, string>();
  private static readonly MODELS_TTL_MS = 5 * 60_000;
  private modelsCache: { ts: number; value: { defaultModel?: string; models: string[] } } | null = null;
  private modelsInflight: Promise<{ defaultModel?: string; models: string[] }> | null = null;

  constructor(options: GrokAdapterOptions = {}) {
    this.grokBin = options.grokBin ?? process.env.GROK_BIN ?? DEFAULT_GROK_BIN;
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
    fork: false,
    approvals: false,
    questions: false,
  };

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
        const summaryPath = path.join(cwdPath, sessEnt.name, 'summary.json');
        try {
          const raw = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as Record<string, unknown>;
          const info = (raw.info ?? {}) as Record<string, unknown>;
          const sessionId = typeof info.id === 'string' && UUID_RE.test(info.id) ? info.id : sessEnt.name;
          const cwd = typeof info.cwd === 'string'
            ? info.cwd
            : decodeUriComponentSafe(cwdEnt.name);
          const title = pickString(raw.session_summary, raw.generated_title) || '(session)';
          const updatedAt = pickString(raw.updated_at, raw.last_active_at) || new Date().toISOString();
          const createdAt = pickString(raw.created_at) || updatedAt;
          const model = typeof raw.current_model_id === 'string' ? raw.current_model_id : undefined;
          if (cwd) this.sessionCwd.set(sessionId, cwd);
          out.push({ sessionId, title: title.slice(0, 120), cwd, createdAt, updatedAt, ...(model ? { model } : {}) });
        } catch {
          // unreadable / malformed summary — skip
        }
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

  async getHistory(sessionId: string): Promise<GrokHistoryMessage[]> {
    const dir = this.findSessionDir(sessionId);
    if (!dir) throw new Error(`grok-adapter: session not found: ${sessionId}`);
    const filePath = path.join(dir, 'chat_history.jsonl');
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      throw new Error(`grok-adapter: session not found: ${sessionId}`);
    }
    const messages: GrokHistoryMessage[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const mapped = mapHistoryEntry(entry);
      if (!mapped) continue;
      const timestamp = pickString(entry.timestamp);
      if (timestamp) mapped.timestamp = timestamp;
      messages.push(mapped);
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

    const args: string[] = [];
    if (opts.contentBlocks && opts.contentBlocks.length > 0) {
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
        this.running.delete(sessionId);
        this.resolveExitWaiters(sessionId);
        onEvent({ type: 'error', message: `spawn failed: ${err.message}` });
        reject(err);
      });

      child.on('close', (code, signal) => {
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
    for (const [sessionId, child] of this.running) {
      this.killGroup(child, 'SIGTERM');
      this.running.delete(sessionId);
      this.resolveExitWaiters(sessionId);
    }
  }

  private spawnText(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.grokBin, args, {
        cwd: os.homedir(),
        env: this.childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', reject);
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`grok ${args.join(' ')} timed out`));
      }, 20_000);
      timer.unref();
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout.trim()) {
          reject(new Error(`grok ${args.join(' ')} failed (code=${code}): ${stderr.trim()}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  /**
   * CLI 子进程继承当前环境(含用户自己的代理),不在项目里写死代理地址。
   * 只把 loopback 补进 NO_PROXY,避免 grok 把 127.0.0.1 也送进代理。
   */
  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.env };
    const extra = ['127.0.0.1', 'localhost', '::1'];
    const current = String(env.NO_PROXY ?? env.no_proxy ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const merged = [...new Set([...current, ...extra])].join(',');
    env.NO_PROXY = merged;
    env.no_proxy = merged;
    return env;
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
  /** Gateway session id → ACP session id. Grok 1.0.13 ignores session/new.sessionId. */
  private readonly acpSessionIds = new Map<string, string>();
  private defaultModel: string | undefined;
  private acp: GrokAcpClient | null = null;

  constructor(options?: GrokAdapterOptions & { settingsPath?: string }) {
    const { settingsPath, ...innerOptions } = options ?? {};
    this.inner = new GrokAdapter(innerOptions);
    this.settings = new SettingsStore(settingsPath);
    this.grokBin = innerOptions.grokBin ?? process.env.GROK_BIN ?? DEFAULT_GROK_BIN;
    this.grokEnv = innerOptions.env ?? {};
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      thinking: true,
      tools: true,
      approvals: true,
      questions: false,
      interrupt: true,
      history: true,
    };
  }

  async list(query: ListSessionsQuery = {}): Promise<SessionPage> {
    const sessions = (await this.inner.list()).filter((session) => {
      if (query.cwd && session.cwd !== query.cwd) return false;
      const isArchived = this.settings.getBoolean('archived', session.sessionId) === true;
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
    const history = await this.inner.getHistory(sessionId);
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
    const isNew = !this.inner.hasSessionFile(sessionId);
    const cwd = this.sessionCwd.get(sessionId) ?? this.inner.getCwd(sessionId);
    const model = this.settings.getString('model', sessionId);
    const thinking = this.settings.getString('thinking', sessionId);
    const effort = grokEffort(thinking);
    const permissionMode = this.settings.getBoolean('plan', sessionId)
      ? 'plan'
      : grokPermissionMode(this.settings.getString('permission', sessionId));
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
    if (this.acp?.ready && this.acp.alwaysApproveEnabled === alwaysApprove) return this.acp;
    if (this.acp) {
      await this.acp.close().catch(() => undefined);
      this.acp = null;
    }
    const client = new GrokAcpClient({
      grokBin: this.grokBin,
      env: this.grokEnv,
      alwaysApprove,
      requestTimeoutMs: 6_000,
      promptTimeoutMs: 20_000,
    });
    try {
      await client.connect();
      this.acp = client;
      client.onEvent((ev) => this.onAcpProcessEvent(ev));
      return client;
    } catch {
      await client.close().catch(() => undefined);
      return null;
    }
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
      emit: (ev: GrokAdapterEvent) => void;
      stream: EventStream<GatewayEvent>;
      turnId: string;
    },
  ): Promise<void> {
    const cwd = opts.cwd ?? os.homedir();
    this.acpTurns.set(opts.sessionId, opts.stream);
    const unsub = acp.onEvent((ev) => this.mapAcpEvent(opts.sessionId, opts.turnId, opts.stream, ev));
    try {
      let acpSessionId = this.acpSessionIds.get(opts.sessionId) ?? opts.sessionId;
      if (opts.isNew) {
        const created = await acp.sessionNew({
          cwd,
          sessionId: opts.sessionId,
          yoloMode: opts.yolo,
          planMode: opts.plan,
          model: opts.model,
          effort: opts.effort,
        });
        acpSessionId = created.sessionId || opts.sessionId;
        this.rememberAcpSession(opts.sessionId, acpSessionId, cwd);
      } else {
        try {
          await acp.sessionLoad({ sessionId: acpSessionId, cwd });
        } catch {
          const created = await acp.sessionNew({ cwd, sessionId: opts.sessionId, yoloMode: opts.yolo, planMode: opts.plan, model: opts.model, effort: opts.effort });
          acpSessionId = created.sessionId || opts.sessionId;
          this.rememberAcpSession(opts.sessionId, acpSessionId, cwd);
        }
      }
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
    }
  }

  private rememberAcpSession(gatewayId: string, acpId: string, cwd: string): void {
    this.acpSessionIds.set(gatewayId, acpId);
    this.sessionCwd.set(gatewayId, cwd);
    if (acpId !== gatewayId) this.sessionCwd.set(acpId, cwd);
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
        if (ev.sessionId !== sessionId) return;
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
        if (ev.sessionId !== sessionId) return;
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
        if (ev.sessionId !== sessionId) return;
        stream.push({
          kind: 'tool',
          status: 'started',
          sessionId,
          turnId,
          timestamp: ts,
          payload: { toolCallId: ev.toolCallId, name: ev.title, input: ev.rawInput },
        });
        break;
      case 'tool_call_update':
        if (ev.sessionId !== sessionId) return;
        stream.push({
          kind: 'tool',
          status: ev.status === 'failed' ? 'failed' : 'completed',
          sessionId,
          turnId,
          timestamp: ts,
          payload: {
            toolCallId: ev.toolCallId,
            name: ev.title ?? '',
            output: typeof ev.rawOutput === 'string' ? ev.rawOutput : JSON.stringify(ev.rawOutput ?? ''),
            is_error: ev.status === 'failed',
          },
        });
        break;
      case 'permission_request':
        if (ev.sessionId !== sessionId) return;
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
        if (ev.sessionId !== sessionId) return;
        this.sessionUsage.set(sessionId, usageFromAcp(ev.usage, this.sessionUsage.get(sessionId)));
        break;
      default:
        break;
    }
  }

  private onAcpProcessEvent(ev: GrokAcpEvent): void {
    if (ev.type === 'disconnected') {
      this.acp = null;
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    if (this.acp?.ready) {
      await this.acp.sessionCancel(sessionId).catch(() => undefined);
    }
    this.inner.interrupt(sessionId);
  }

  async resolveApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.acp?.getPendingPermission(approvalId);
    if (!this.acp || !pending || pending.sessionId !== sessionId) {
      throw new ProviderError('not_found', `grok-adapter: no pending approval ${approvalId}`, 404);
    }
    if (decision === 'reject') {
      this.acp.cancelPermission(pending.id);
      return;
    }
    const optionId = pickPermissionOption(pending.options, decision);
    if (!optionId) {
      this.acp.cancelPermission(pending.id);
      throw new ProviderError('invalid_request', 'grok-adapter: no matching permission option', 400);
    }
    this.acp.resolvePermission(pending.id, optionId);
  }

  async resolveQuestion(): Promise<void> {
    throw new ProviderError('unsupported', 'Grok 非交互模式不支持代答提问', 400);
  }

  async setGoal(_sessionId: string, _objective: string): Promise<Record<string, unknown> | null> {
    throw new ProviderError('unsupported', 'Grok 不支持 goal 能力', 400);
  }

  async getGoal(_sessionId: string): Promise<Record<string, unknown> | null> {
    throw new ProviderError('unsupported', 'Grok 不支持 goal 能力', 400);
  }

  async controlGoal(_sessionId: string, _control: 'pause' | 'resume' | 'cancel'): Promise<Record<string, unknown> | null> {
    throw new ProviderError('unsupported', 'Grok 不支持 goal 能力', 400);
  }

  async steer(_sessionId: string, _turnId: string, _text: string): Promise<void> {
    throw new ProviderError('unsupported', 'Grok 无 stdin 通道,不支持插话', 400);
  }

  async close(_sessionId: string): Promise<void> {
    // ACP 进程常驻;会话级 close 为空操作。
  }

  async dispose(): Promise<void> {
    await this.acp?.close().catch(() => undefined);
    this.acp = null;
    this.acpSessionIds.clear();
    await this.inner.close();
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    this.settings.set('model', sessionId, model);
  }

  getModel(sessionId: string): string | undefined {
    return this.settings.getString('model', sessionId)
      ?? this.settings.getString('model', '__default__')
      ?? this.defaultModel;
  }

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

  async rename(sessionId: string, title: string): Promise<void> {
    this.renames.set(sessionId, title);
  }

  async listModels(): Promise<NativeModel[]> {
    const { defaultModel, models } = await this.inner.listModels();
    if (defaultModel) this.defaultModel = defaultModel;
    return models.map((model) => ({
      provider: 'grok',
      model,
      display_name: model,
      max_context_size: grokContextWindow(model),
      capabilities: ['thinking'],
      support_efforts: [...GROK_EFFORTS],
      default_effort: 'high',
    }));
  }

  async listCommands(_sessionId?: string): Promise<NativeCommand[]> {
    return listGrokCommands();
  }

  private acpId(sessionId: string): string {
    return this.acpSessionIds.get(sessionId) ?? sessionId;
  }

  async compact(sessionId: string): Promise<void> {
    const acp = await this.ensureAcp(false);
    if (!acp) throw new ProviderError('unsupported', 'Grok ACP compact 不可用(CLI 未提供 grok agent stdio)', 400);
    await acp.compact(this.acpId(sessionId));
  }

  async fork(sessionId: string): Promise<Session> {
    const acp = await this.ensureAcp(false);
    if (!acp) throw new ProviderError('unsupported', 'Grok ACP fork 不可用(CLI 未提供 grok agent stdio)', 400);
    const { sessionId: newId } = await acp.fork(this.acpId(sessionId));
    const cwd = this.sessionCwd.get(sessionId) ?? this.inner.getCwd(sessionId) ?? process.cwd();
    this.sessionCwd.set(newId, cwd);
    this.settings.copySession(sessionId, newId);
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

  async rollback(sessionId: string, numTurns: number): Promise<void> {
    const acp = await this.ensureAcp(false);
    if (!acp) throw new ProviderError('unsupported', 'Grok ACP rewind 不可用(CLI 未提供 grok agent stdio)', 400);
    await acp.rewind(this.acpId(sessionId), numTurns);
  }

  async delete(sessionId: string): Promise<void> {
    this.inner.interrupt(sessionId);
    this.renames.delete(sessionId);
    this.sessionCwd.delete(sessionId);
    this.acpSessionIds.delete(sessionId);
    this.sessionUsage.delete(sessionId);
    this.settings.delete('model', sessionId);
    this.settings.delete('thinking', sessionId);
    this.settings.delete('permission', sessionId);
    this.settings.delete('plan', sessionId);
    this.settings.delete('archived', sessionId);
    this.inner.deleteSession(sessionId);
  }

  getUsage(sessionId: string): SessionUsage | undefined {
    return this.sessionUsage.get(sessionId);
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    if (archived) this.settings.set('archived', sessionId, true);
    else this.settings.delete('archived', sessionId);
  }

  getCwd(sessionId: string): string | undefined {
    return this.sessionCwd.get(sessionId) ?? this.inner.getCwd(sessionId);
  }

  private toSession(s: GrokSessionSummary): Session {
    if (s.cwd) this.sessionCwd.set(s.sessionId, s.cwd);
    const title = this.renames.get(s.sessionId) ?? (s.title || `Grok ${s.sessionId.slice(0, 8)}`);
    const archived = this.settings.getBoolean('archived', s.sessionId) === true;
    return {
      id: s.sessionId,
      workspace_id: workspaceIdFromCwd(s.cwd, 'grok'),
      title,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
      busy: false,
      archived,
      extras: { last_prompt: title },
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

const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Map Kimi thinking chips onto grok --effort. UI 'on' is not a CLI value. */
export function grokEffort(thinking: string | undefined): string | undefined {
  if (!thinking || thinking === 'off') return undefined;
  if ((GROK_EFFORTS as readonly string[]).includes(thinking)) return thinking;
  if (thinking === 'on') return 'high';
  return undefined;
}

function acpPrompt(prompt: string, contentBlocks?: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (contentBlocks && contentBlocks.length > 0) {
    return contentBlocks.map((block) => {
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
  }
  return prompt.trim() ? [{ type: 'text', text: prompt }] : [];
}

function usageFromAcp(raw: Record<string, unknown>, prev?: SessionUsage): SessionUsage {
  const used = isRecord(raw.used) ? raw.used : raw;
  const input = num(used.input_tokens ?? used.inputTokens ?? used.input);
  const output = num(used.output_tokens ?? used.outputTokens ?? used.output);
  return {
    input_tokens: (prev?.input_tokens ?? 0) + input,
    output_tokens: (prev?.output_tokens ?? 0) + output,
    cache_read_tokens: prev?.cache_read_tokens ?? 0,
    cache_creation_tokens: prev?.cache_creation_tokens ?? 0,
    total_cost_usd: prev?.total_cost_usd ?? 0,
    context_tokens: input + output,
    context_limit: grokContextWindow(),
    turn_count: (prev?.turn_count ?? 0) + 1,
  };
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
      const text = type === 'user' ? (unwrapUserQuery(content) ?? content) : content;
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
          const text = type === 'user' ? (unwrapUserQuery(b.text) ?? b.text) : b.text;
          if (text && !(type === 'user' && isGrokBannerText(text) && !unwrapUserQuery(b.text))) {
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
    const text = extractText(content);
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

function readSessionTimes(dir: string): { createdAt: string; updatedAt: string } {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')) as Record<string, unknown>;
    const updatedAt = pickString(raw.updated_at, raw.last_active_at);
    const createdAt = pickString(raw.created_at) || updatedAt;
    return { createdAt, updatedAt };
  } catch {
    return { createdAt: '', updatedAt: '' };
  }
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
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root';
  return `wd_${provider}_${slug}`.slice(0, 60);
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
