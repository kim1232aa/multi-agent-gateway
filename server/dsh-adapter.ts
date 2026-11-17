/**
 * DshAdapter & DshProviderAdapter — connects DeepSeek Harness (`dsh`) to multi-agent-gateway.
 *
 * Architecture:
 * - Read path: reads compressed ~/.dsh/sessions/ files directly using node:zlib
 *   (zstdDecompressSync), zero-spawn, sub-millisecond session listing and history reading.
 * - Write path: manages an interactive `dsh --profile acp` subprocess via DshAcpClient.
 * - Approvals: translates DSH `session/request_permission` into gateway `kind: 'approval'`.
 * - Process lifecycle: recycles idle dsh processes after 60s of inactivity.
 */

import * as childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { DshAcpClient, type DshAcpEvent } from './dsh-acp.js';
import { workspaceIdFromCwd } from './facade.js';
import { listDshCommands } from './native-commands.js';
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
  type TurnHandle,
} from './types.js';

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

export function validateSessionId(sessionId: string): string {
  const rawId = sessionId.startsWith('dsh_') ? sessionId.slice(4) : sessionId;
  if (!rawId || !SESSION_ID_RE.test(rawId)) {
    throw new ProviderError('invalid_request', `Invalid DSH session ID: ${sessionId}`, 400);
  }
  return rawId;
}

function parseConfigModels(configOptions: unknown): NativeModel[] | null {
  if (!Array.isArray(configOptions)) return null;
  const modelOpt = configOptions.find((opt: any) => opt && typeof opt === 'object' && opt.id === 'model') as any;
  if (!modelOpt || !Array.isArray(modelOpt.options) || modelOpt.options.length === 0) return null;

  const reasoningOpt = configOptions.find((opt: any) => opt && typeof opt === 'object' && opt.id === 'reasoning_effort') as any;
  let supportEfforts: string[] | undefined;
  let defaultEffort: string | undefined;
  let supportsThinkingOff: boolean | undefined;
  if (reasoningOpt && Array.isArray(reasoningOpt.options)) {
    supportEfforts = [];
    for (const item of reasoningOpt.options) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.value === 'string') {
        if (item.value) {
          supportEfforts.push(item.value);
        } else {
          supportsThinkingOff = true;
        }
      }
    }
    if (typeof reasoningOpt.currentValue === 'string') {
      defaultEffort = reasoningOpt.currentValue;
    }
  }

  const models: NativeModel[] = [];
  const currentModelVal = typeof modelOpt.currentValue === 'string' ? modelOpt.currentValue : undefined;

  for (const item of modelOpt.options) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.options)) {
      const groupProvider = typeof item.group === 'string' && item.group ? item.group : 'dsh';
      for (const opt of item.options) {
        if (!opt || typeof opt.value !== 'string') continue;
        models.push({
          provider: groupProvider,
          model: opt.value,
          display_name: opt.name || opt.value,
          ...(opt.description ? { description: opt.description } : {}),
          max_context_size: 131_072,
          isDefault: currentModelVal !== undefined ? opt.value === currentModelVal : models.length === 0,
          ...(supportEfforts && supportEfforts.length > 0 ? { support_efforts: supportEfforts } : {}),
          ...(defaultEffort !== undefined ? { default_effort: defaultEffort } : {}),
          ...(supportsThinkingOff ? { supportsThinkingOff: true } : {}),
        });
      }
    } else if (typeof item.value === 'string') {
      models.push({
        provider: 'dsh',
        model: item.value,
        display_name: item.name || item.value,
        ...(item.description ? { description: item.description } : {}),
        max_context_size: 131_072,
        isDefault: currentModelVal !== undefined ? item.value === currentModelVal : models.length === 0,
        ...(supportEfforts && supportEfforts.length > 0 ? { support_efforts: supportEfforts } : {}),
        ...(defaultEffort !== undefined ? { default_effort: defaultEffort } : {}),
        ...(supportsThinkingOff ? { supportsThinkingOff: true } : {}),
      });
    }
  }

  return models.length > 0 ? models : null;
}

export function parseCordisPatchModels(content: string): NativeModel[] {
  const models: NativeModel[] = [];
  const lines = content.split('\n');
  let inLlm = false;
  let currentProvider = '';
  let defaultProvider = '';
  let defaultModelId = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^- id:\s*acp\b/.test(line)) {
      for (let j = i + 1; j < lines.length && !/^- id:/.test(lines[j]); j++) {
        const pMatch = lines[j].match(/^\s+provider:\s*(\S+)/);
        if (pMatch) defaultProvider = pMatch[1];
        const mMatch = lines[j].match(/^\s+model:\s*(\S+)/);
        if (mMatch) defaultModelId = mMatch[1];
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^- id:\s*llm-pi-ai\b/.test(line)) inLlm = true;
    else if (/^- id:\s*/.test(line)) inLlm = false;

    if (inLlm) {
      const provMatch = line.match(/^\s{6}([a-zA-Z0-9_-]+):\s*$/);
      if (provMatch) {
        currentProvider = provMatch[1];
      }
      const modelIdMatch = line.match(/^\s+-\s*id:\s*([a-zA-Z0-9_.-]+)/);
      if (modelIdMatch && currentProvider) {
        const id = modelIdMatch[1];
        let displayName = id;
        if (i + 1 < lines.length) {
          const dnMatch = lines[i + 1].match(/^\s+displayName:\s*(.+)$/);
          if (dnMatch) displayName = dnMatch[1].trim();
        }
        const optValue = JSON.stringify([currentProvider, id]);
        const isDefault = currentProvider === defaultProvider && id === defaultModelId;
        models.push({
          provider: currentProvider,
          model: optValue,
          display_name: displayName,
          max_context_size: 131_072,
          isDefault,
        });
      }
    }
  }
  return models;
}

export function discoverStaticModels(sessionsDir: string, dshBin: string, extraArgs: string[] = []): NativeModel[] | null {
  const dshHome = path.dirname(sessionsDir);
  const patchFile = path.join(dshHome, 'profiles', 'acp', 'cordis.patch.yml');
  if (extraArgs.length === 0 && fs.existsSync(patchFile)) {
    try {
      const content = fs.readFileSync(patchFile, 'utf8');
      const models = parseCordisPatchModels(content);
      if (models.length > 0) return models;
    } catch {
      // ignore
    }
  }
  if (isExecutableFile(dshBin)) {
    try {
      const out = childProcess.execFileSync(dshBin, ['--profile', 'acp', ...extraArgs, '--dump-config'], {
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const models = parseCordisPatchModels(out);
      if (models.length > 0) return models;
    } catch {
      // ignore
    }
  }
  return null;
}

function formatToolOutput(rawOutput: unknown): string {
  if (typeof rawOutput === 'string') return rawOutput;
  if (rawOutput === null || rawOutput === undefined) return '';

  if (Array.isArray(rawOutput)) {
    const parts: string[] = [];
    for (const item of rawOutput) {
      if (!item || typeof item !== 'object') {
        parts.push(String(item));
        continue;
      }
      if (item.type === 'content' && item.content) {
        if (typeof item.content === 'string') {
          parts.push(item.content);
        } else if (item.content.type === 'text' && typeof item.content.text === 'string') {
          parts.push(item.content.text);
        } else if (typeof item.content.text === 'string') {
          parts.push(item.content.text);
        } else {
          parts.push(JSON.stringify(item.content));
        }
      } else if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      } else if (item.type === 'diff') {
        const filePath = item.path ? `--- ${item.path}\n+++ ${item.path}\n` : '';
        if (item.oldText != null) {
          parts.push(`${filePath}Original:\n${item.oldText}\nModified:\n${item.newText ?? ''}`);
        } else {
          parts.push(`${filePath}New file:\n${item.newText ?? ''}`);
        }
      } else if (item.type === 'terminal' && typeof item.text === 'string') {
        parts.push(item.text);
      } else if (typeof item.text === 'string') {
        parts.push(item.text);
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    return parts.join('\n');
  }

  if (typeof rawOutput === 'object') {
    const item = rawOutput as any;
    if (item.type === 'diff') {
      const filePath = item.path ? `--- ${item.path}\n+++ ${item.path}\n` : '';
      if (item.oldText != null) {
        return `${filePath}Original:\n${item.oldText}\nModified:\n${item.newText ?? ''}`;
      }
      return `${filePath}New file:\n${item.newText ?? ''}`;
    }
    if (item.type === 'text' && typeof item.text === 'string') return item.text;
    if (typeof item.text === 'string') return item.text;
    return JSON.stringify(rawOutput);
  }

  return String(rawOutput);
}

class AsyncEventQueue {
  private queue: GatewayEvent[] = [];
  private waiter: (() => void) | null = null;
  private finished = false;

  push(event: GatewayEvent): void {
    this.queue.push(event);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  finish(): void {
    this.finished = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<GatewayEvent> {
    while (!this.finished || this.queue.length > 0) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (!this.finished) {
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
      }
    }
  }
}

const DEFAULT_DSH_BIN = path.join(os.homedir(), '.local', 'bin', 'dsh');

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveDshBin(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnv = process.env.DSH_BIN?.trim();
  if (fromEnv) return fromEnv;
  if (isExecutableFile(DEFAULT_DSH_BIN)) return DEFAULT_DSH_BIN;
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'dsh');
    if (isExecutableFile(candidate)) return candidate;
  }
  return DEFAULT_DSH_BIN;
}

export function resolveDshSessionsDir(): string {
  const custom = process.env.DSH_HOME?.trim();
  if (custom) return path.join(custom, 'sessions');
  return path.join(os.homedir(), '.dsh', 'sessions');
}

export interface DshSessionRecord {
  id: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  filePath: string;
  busy: boolean;
  turnCount: number;
  lastPrompt?: string;
}

/** Live per-session state from dsh's projection cache (~/.dsh/storages/session_projcache). */
interface DshProjcacheRecord {
  title?: { val?: string };
  turnBoundary?: { val?: { lastTurn?: number; openTurnStartSeq?: number | null } };
  tokenUsage?: {
    val?: {
      totals?: { uncachedInputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    };
  };
}

interface CachedSessionFile {
  mtimeMs: number;
  size: number;
  header: any;
  explicitTitle: string;
  firstUserPrompt: string;
  userMsgCount: number;
  createdAt: string;
  messages: Message[];
}

export class DshAdapter {
  private readonly dshBin: string;
  private readonly sessionsDir: string;
  private readonly projcacheDir: string;
  private readonly historyCacheDir: string;
  private readonly recycleGraceMs: number;
  private readonly permissionModeForSession?: (sessionId: string) => string | undefined;
  private readonly injection?: () => { args: string[]; env: Record<string, string> };
  private acpClient: DshAcpClient | null = null;
  private activeTurns = new Set<string>();
  private readonly sessionFileCache = new Map<string, CachedSessionFile>();

  constructor(options: {
    dshBin?: string;
    sessionsDir?: string;
    projcacheDir?: string;
    historyCacheDir?: string;
    recycleGraceMs?: number;
    permissionModeForSession?: (sessionId: string) => string | undefined;
    injection?: () => { args: string[]; env: Record<string, string> };
  } = {}) {
    this.injection = options.injection;
    this.dshBin = resolveDshBin(options.dshBin);
    this.sessionsDir = options.sessionsDir ?? resolveDshSessionsDir();
    const dshHome = path.dirname(this.sessionsDir);
    this.projcacheDir = options.projcacheDir ?? path.join(dshHome, 'storages', 'session_projcache', 'sessions');
    this.historyCacheDir = options.historyCacheDir ?? path.join(dshHome, 'gateway_history');
    const envTimeout = process.env.GATEWAY_DSH_IDLE_TIMEOUT_MS ? Number(process.env.GATEWAY_DSH_IDLE_TIMEOUT_MS) : undefined;
    this.recycleGraceMs = options.recycleGraceMs ?? (Number.isFinite(envTimeout) && envTimeout! > 0 ? envTimeout! : 60_000);
    this.permissionModeForSession = options.permissionModeForSession;
  }

  get binPath(): string {
    return this.dshBin;
  }

  get sessionsDirectory(): string {
    return this.sessionsDir;
  }

  isBusy(): boolean {
    return this.activeTurns.size > 0 || (this.acpClient?.isBusy() ?? false);
  }

  getAcpClient(alwaysApprove = false): DshAcpClient {
    if (!this.acpClient || this.acpClient.isClosed()) {
      this.acpClient = new DshAcpClient({
        dshBin: this.dshBin,
        alwaysApprove,
        recycleGraceMs: this.recycleGraceMs,
        permissionModeForSession: this.permissionModeForSession,
        ...(this.injection ? { injection: this.injection } : {}),
        env: {
          // dsh profile patches route llm through the ccwu relay; it needs this key.
          ...(process.env.CCWU_API_KEY ? { CCWU_API_KEY: process.env.CCWU_API_KEY } : {}),
        },
      });
    }
    return this.acpClient;
  }

  private parseSessionFile(sessionFile: string, sessionId: string, stats: fs.Stats): CachedSessionFile {
    const buf = fs.readFileSync(sessionFile);
    // CLI 正在追加写入时尾部帧不完整;按 flush 语义解出已落盘部分,
    // 否则整条会话会在发送期间被判为不存在(侧栏 404)。
    const raw = zlib.zstdDecompressSync(buf, { finishFlush: zlib.constants.ZSTD_e_flush }).toString('utf8');
    const lines = raw.trim().split('\n').filter(Boolean);

    let header: any = null;
    let explicitTitle = '';
    let firstUserPrompt = '';
    let userMsgCount = 0;
    const messages: Message[] = [];
    let msgIndex = 0;

    for (const line of lines) {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }

      const createdAt = typeof ev.time === 'number' && Number.isFinite(ev.time)
        ? new Date(ev.time).toISOString()
        : (header?.createdAt ? new Date(header.createdAt).toISOString() : stats.birthtime.toISOString());

      if (ev.type === 'session' && !header) {
        header = ev;
      } else if (ev.type === 'session/title' && ev.data?.title) {
        explicitTitle = ev.data.title;
      } else if (ev.type === 'user/message') {
        const sourceKind = ev.data?.source?.kind;
        if (sourceKind && sourceKind !== 'user') {
          continue;
        }
        userMsgCount++;

        let text = '';
        const rawContent = ev.data?.content ?? ev.data?.message?.content;
        if (Array.isArray(rawContent)) {
          for (const part of rawContent) {
            if (part && part.type === 'text' && typeof part.text === 'string') {
              text += part.text;
            }
          }
        } else if (typeof rawContent === 'string') {
          text = rawContent;
        }

        if (!firstUserPrompt && text.trim()) {
          firstUserPrompt = text.trim().slice(0, 80);
        }

        const id = ev.data?.id ?? ev.id ?? (ev.seq != null ? `msg_u_${ev.seq}` : `msg_u_${msgIndex++}`);
        messages.push({
          id: String(id),
          session_id: sessionId,
          role: 'user',
          content: [{ type: 'text', text }],
          created_at: createdAt,
        });
      } else if (ev.type === 'assistant/message') {
        const parts: MessageContentPart[] = [];
        let text = '';
        const rawContent = ev.data?.message?.content ?? ev.data?.content;
        if (Array.isArray(rawContent)) {
          for (const part of rawContent) {
            if (!part || typeof part !== 'object') continue;
            if (part.type === 'reasoning' || part.type === 'thinking') {
              const thinkingText = typeof part.text === 'string' ? part.text : (typeof part.thinking === 'string' ? part.thinking : '');
              parts.push({ type: 'thinking', thinking: thinkingText });
            } else if (part.type === 'text' && typeof part.text === 'string') {
              text += part.text;
              parts.push({ type: 'text', text: part.text });
            } else if (part.type === 'tool-call' || part.type === 'tool_call') {
              let input: unknown = part.arguments ?? part.input ?? {};
              if (typeof input === 'string') {
                try {
                  input = JSON.parse(input);
                } catch {
                  // keep as string
                }
              }
              parts.push({
                type: 'tool_call',
                id: String(part.id ?? ''),
                name: String(part.name ?? 'tool'),
                input,
              });
            }
          }
        }
        const id = ev.data?.message?.id ?? ev.data?.id ?? ev.id ?? (ev.seq != null ? `msg_a_${ev.seq}` : `msg_a_${msgIndex++}`);
        messages.push({
          id: String(id),
          session_id: sessionId,
          role: 'assistant',
          content: parts.length > 0 ? parts : [{ type: 'text', text }],
          created_at: createdAt,
        });
      } else if (ev.type === 'tool/result') {
        const toolCallId = String(ev.data?.message?.toolCallId ?? ev.data?.toolCallId ?? '');
        let output = '';
        const rawContent = ev.data?.message?.content ?? ev.data?.content;
        if (Array.isArray(rawContent)) {
          for (const part of rawContent) {
            if (part && typeof part.text === 'string') {
              output += part.text;
            }
          }
        } else if (typeof rawContent === 'string') {
          output = rawContent;
        }
        const isError = Boolean(ev.data?.message?.isError ?? ev.data?.isError);
        const id = ev.data?.message?.id ?? ev.data?.id ?? ev.id ?? (ev.seq != null ? `msg_t_${ev.seq}` : `msg_t_${msgIndex++}`);
        messages.push({
          id: String(id),
          session_id: sessionId,
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              tool_call_id: toolCallId,
              output,
              content: output,
              is_error: isError,
            },
          ],
          created_at: createdAt,
        });
      }
    }

    const createdAt = header?.createdAt ? new Date(header.createdAt).toISOString() : stats.birthtime.toISOString();
    const cached: CachedSessionFile = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      header,
      explicitTitle,
      firstUserPrompt,
      userMsgCount,
      createdAt,
      messages,
    };
    this.sessionFileCache.set(sessionFile, cached);
    return cached;
  }

  /**
   * Fast, zero-process session discovery. Merges two on-disk sources:
   * - ~/.dsh/sessions/<cwd-slug>/<id>/session.v4.jsonl.zstd (durable log, may lag)
   * - ~/.dsh/storages/session_projcache/sessions/<id>.json (live projection:
   *   title/usage/turn state updated in near real time)
   */
  listSessionsFromDisk(): DshSessionRecord[] {
    const results: DshSessionRecord[] = [];
    if (!fs.existsSync(this.sessionsDir)) return results;

    let groupEntries: fs.Dirent[];
    try {
      groupEntries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const group of groupEntries) {
      if (!group.isDirectory()) continue;
      const groupPath = path.join(this.sessionsDir, group.name);
      let sessionDirs: fs.Dirent[];
      try {
        sessionDirs = fs.readdirSync(groupPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const sDir of sessionDirs) {
        if (!sDir.isDirectory()) continue;
        const sessionId = sDir.name;
        const sessionFile = path.join(groupPath, sessionId, 'session.v4.jsonl.zstd');
        if (!fs.existsSync(sessionFile)) continue;

        try {
          const stats = fs.statSync(sessionFile);
          let cached = this.sessionFileCache.get(sessionFile);
          if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) {
            cached = this.parseSessionFile(sessionFile, sessionId, stats);
          }
          if (!cached.header) continue;

          // Live projection overlay (title/turn/busy from the projcache JSON).
          const proj = this.readProjcache(sessionId);
          const liveTitle = typeof proj?.title?.val === 'string' && proj.title.val.trim() ? proj.title.val.trim() : '';
          const turnCount = typeof proj?.turnBoundary?.val?.lastTurn === 'number' ? proj.turnBoundary.val.lastTurn : 0;
          const busy = proj?.turnBoundary?.val?.openTurnStartSeq != null;

          // Placeholder = no log events yet, no live title, zero turns. Skip those
          // to keep the sidebar clean; a session shows up right after its first turn.
          const isPlaceholder = cached.userMsgCount === 0 && !cached.explicitTitle && !liveTitle && turnCount === 0;
          if (isPlaceholder) continue;

          const title = cached.explicitTitle || liveTitle || cached.firstUserPrompt || '';
          const createdAt = cached.createdAt;
          const updatedAt = stats.mtime.toISOString();

          results.push({
            id: sessionId,
            cwd: cached.header.cwd || process.cwd(),
            title,
            createdAt,
            updatedAt,
            messageCount: cached.userMsgCount,
            filePath: sessionFile,
            busy,
            turnCount,
            lastPrompt: cached.firstUserPrompt || '',
          });
        } catch {
          // ignore corrupted/partial writes
        }
      }
    }

    results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return results;
  }

  get historyDir(): string {
    return this.historyCacheDir;
  }

  /** Read the live projection JSON for one session id (returns undefined when absent). */
  readProjcache(sessionId: string): DshProjcacheRecord | undefined {
    const rawId = validateSessionId(sessionId);
    try {
      const file = path.join(this.projcacheDir, `${rawId}.json`);
      if (!fs.existsSync(file)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { record?: { rows?: DshProjcacheRecord } };
      return parsed.record?.rows ?? undefined;
    } catch {
      return undefined;
    }
  }

  getHistoryMessages(sessionId: string): Message[] {
    const rawId = validateSessionId(sessionId);
    const records = this.listSessionsFromDisk();
    const record = records.find((r) => r.id === rawId);
    if (!record || !fs.existsSync(record.filePath)) {
      // Fallback: read from gateway_history cache file
      try {
        const cacheFile = path.join(this.historyCacheDir, `${rawId}.json`);
        if (fs.existsSync(cacheFile)) {
          const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          if (Array.isArray(cached) && cached.length > 0) return cached;
        }
      } catch {
        // ignore
      }
      return [];
    }

    let messages: Message[] = [];
    try {
      const stats = fs.statSync(record.filePath);
      let cached = this.sessionFileCache.get(record.filePath);
      if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) {
        cached = this.parseSessionFile(record.filePath, rawId, stats);
      }
      messages = cached.messages;
    } catch {
      // ignore
    }

    if (messages.length > 0) return messages;

    // Fallback: read from gateway_history cache file
    try {
      const cacheFile = path.join(this.historyCacheDir, `${rawId}.json`);
      if (fs.existsSync(cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (Array.isArray(cached) && cached.length > 0) return cached;
      }
    } catch {
      // ignore
    }

    return messages;
  }

  appendHistoryCache(sessionId: string, userText: string, assistantText: string, reasoningText = ''): void {
    const rawId = validateSessionId(sessionId);
    try {
      if (!fs.existsSync(this.historyCacheDir)) {
        fs.mkdirSync(this.historyCacheDir, { recursive: true });
      }
      const cacheFile = path.join(this.historyCacheDir, `${rawId}.json`);
      let list: Message[] = [];
      if (fs.existsSync(cacheFile)) {
        try {
          list = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        } catch {
          list = [];
        }
      }

      const now = new Date().toISOString();
      const userIndex = list.length;
      list.push({
        id: `msg_u_${userIndex}`,
        session_id: sessionId,
        role: 'user',
        content: [{ type: 'text', text: userText }],
        created_at: now,
      });

      const assistantParts: MessageContentPart[] = [];
      if (reasoningText) {
        assistantParts.push({ type: 'thinking', thinking: reasoningText });
      }
      assistantParts.push({ type: 'text', text: assistantText });

      list.push({
        id: `msg_a_${userIndex + 1}`,
        session_id: sessionId,
        role: 'assistant',
        content: assistantParts,
        created_at: new Date().toISOString(),
      });

      fs.writeFileSync(cacheFile, JSON.stringify(list, null, 2), 'utf8');
    } catch {
      // ignore
    }
  }

  markTurnStart(turnId: string): void {
    this.activeTurns.add(turnId);
  }

  markTurnEnd(turnId: string): void {
    this.activeTurns.delete(turnId);
  }

  dispose(): void {
    this.acpClient?.close();
    this.acpClient = null;
  }

  recycleSoon(): void {
    this.acpClient?.recycleSoon();
  }

  injectedArgs(): string[] {
    return this.injection?.().args ?? [];
  }
}

export class DshProviderAdapter implements ProviderAdapter {
  readonly name = 'dsh';
  private readonly adapter: DshAdapter;
  private readonly settingsStore: SettingsStore;
  /** Gateway native id → cwd (recorded at create/resume time for later turns). */
  private readonly sessionCwds = new Map<string, string>();
  private cachedModels: NativeModel[] | null = null;

  constructor(options: {
    dshBin?: string;
    sessionsDir?: string;
    settingsPath?: string;
    settingsStore?: SettingsStore;
    recycleGraceMs?: number;
    injection?: () => { args: string[]; env: Record<string, string> };
  } = {}) {
    this.settingsStore = options.settingsStore ?? new SettingsStore(options.settingsPath);
    this.adapter = new DshAdapter({
      ...options,
      permissionModeForSession: (sessionId: string) => this.getPermission(sessionId),
    });
  }

  /** Gateway provider changed: forget the cached catalog and respawn the idle ACP process. */
  providerChanged(): void {
    this.cachedModels = null;
    this.adapter.recycleSoon();
  }

  private updateCachedConfigOptions(configOptions: unknown): void {
    const models = parseConfigModels(configOptions);
    if (models && models.length > 0) {
      this.cachedModels = models;
    }
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
      planMode: false,
      fork: false,
      rollback: false,
      goals: false,
      compact: false,
      permissionModes: ['default', 'auto'],
      manualApproval: true,
      commands: true,
      skills: true,
      models: true,
      usage: true,
      archive: true,
      delete: true,
      rename: true,
    };
  }

  isBusy(): boolean {
    return this.adapter.isBusy();
  }

  async list(query: ListSessionsQuery = {}): Promise<SessionPage> {
    const rawSessions = this.adapter.listSessionsFromDisk().filter((rec) => {
      if (this.settingsStore.getBoolean('deleted', rec.id) === true) return false;
      const isArchived = this.settingsStore.getBoolean('archived', rec.id) === true;
      return query.archived === true ? isArchived : !isArchived;
    });

    const sessions: Session[] = rawSessions.map((rec) => ({
      id: rec.id,
      workspace_id: workspaceIdFromCwd(rec.cwd, 'dsh'),
      title: this.settingsStore.getString('title', rec.id) ?? rec.title,
      created_at: rec.createdAt,
      updated_at: rec.updatedAt,
      busy: false,
      archived: this.settingsStore.getBoolean('archived', rec.id) === true,
      metadata: { cwd: rec.cwd },
      provider: 'dsh',
      extras: {
        last_prompt: rec.lastPrompt || (this.settingsStore.getString('title', rec.id) ?? rec.title ?? ''),
      },
    }));

    const limit = query.limit ?? 50;
    const page = sessions.slice(0, limit);
    return {
      items: page,
      ...(sessions.length > limit ? { next_cursor: page[page.length - 1]?.id } : {}),
    };
  }

  async get(id: string): Promise<Session> {
    const rawId = validateSessionId(id);
    if (this.settingsStore.getBoolean('deleted', rawId) === true) {
      throw new ProviderError('not_found', `DSH session deleted: ${id}`, 404);
    }
    const records = this.adapter.listSessionsFromDisk();
    const found = records.find((r) => r.id === rawId);
    if (!found) {
      throw new ProviderError('not_found', `DSH session not found: ${id}`, 404);
    }
    return {
      id: found.id,
      workspace_id: workspaceIdFromCwd(found.cwd, 'dsh'),
      title: this.settingsStore.getString('title', found.id) ?? found.title,
      created_at: found.createdAt,
      updated_at: found.updatedAt,
      busy: false,
      archived: this.settingsStore.getBoolean('archived', found.id) === true,
      metadata: { cwd: found.cwd },
      provider: 'dsh',
      extras: {
        last_prompt: found.lastPrompt ?? '',
      },
    };
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const cwd = input.cwd || process.cwd();
    const client = this.adapter.getAcpClient();
    const res = await client.newSession(cwd);
    if (res?.configOptions) {
      this.updateCachedConfigOptions(res.configOptions);
    }
    this.sessionCwds.set(res.sessionId, cwd);
    const now = new Date().toISOString();
    return {
      id: res.sessionId,
      workspace_id: workspaceIdFromCwd(cwd, 'dsh'),
      title: input.title || '',
      created_at: now,
      updated_at: now,
      busy: false,
      metadata: { cwd },
      provider: 'dsh',
      extras: {
        last_prompt: '',
      },
    };
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    const rawId = validateSessionId(sessionId);
    if (archived) this.settingsStore.set('archived', rawId, true);
    else this.settingsStore.delete('archived', rawId);
  }

  async delete(id: string): Promise<void> {
    const rawId = validateSessionId(id);
    this.settingsStore.set('deleted', rawId, true);
    this.sessionCwds.delete(rawId);
    try {
      const cacheFile = path.join(this.adapter.historyDir, `${rawId}.json`);
      if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
    } catch {}
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const rawId = validateSessionId(sessionId);
    this.settingsStore.set('title', rawId, title);
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const rawId = validateSessionId(sessionId);
    if (rawId === '__default__') {
      this.settingsStore.set('model', '__default__', model);
      return;
    }
    if (this.cachedModels && this.cachedModels.length > 0) {
      const exists = this.cachedModels.some((m) => m.model === model);
      if (!exists) {
        // Obsolete or invalid model (e.g. legacy deepseek-v4-flash) — ignore silently
        return;
      }
    }
    const client = this.adapter.getAcpClient();
    if (client.isConnected()) {
      try {
        const res = await client.setConfigOption(rawId, 'model', model);
        if (res?.configOptions) {
          this.updateCachedConfigOptions(res.configOptions);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/unknown model option/i.test(msg)) {
          // Do not surface obsolete/unknown model errors to the user
          return;
        }
        throw err;
      }
    }
    this.settingsStore.set('model', rawId, model);
  }

  getModel(sessionId: string): string | undefined {
    const rawId = validateSessionId(sessionId);
    return this.settingsStore.getString('model', rawId) ?? this.settingsStore.getString('model', '__default__');
  }

  async setThinking(sessionId: string, thinking: string): Promise<void> {
    const rawId = validateSessionId(sessionId);
    if (rawId === '__default__') {
      this.settingsStore.set('thinking', '__default__', thinking);
      return;
    }
    const client = this.adapter.getAcpClient();
    if (client.isConnected()) {
      const effort = thinking === 'off' ? '' : thinking;
      const res = await client.setConfigOption(rawId, 'reasoning_effort', effort);
      if (res?.configOptions) {
        this.updateCachedConfigOptions(res.configOptions);
      }
    }
    this.settingsStore.set('thinking', rawId, thinking);
  }

  getThinking(sessionId: string): string | undefined {
    const rawId = validateSessionId(sessionId);
    return this.settingsStore.getString('thinking', rawId) ?? this.settingsStore.getString('thinking', '__default__');
  }

  async setPermission(sessionId: string, mode: string): Promise<void> {
    const rawId = validateSessionId(sessionId);
    this.settingsStore.set('permission', rawId, mode);
  }

  getPermission(sessionId: string): string | undefined {
    const rawId = validateSessionId(sessionId);
    return this.settingsStore.getString('permission', rawId) ?? this.settingsStore.getString('permission', '__default__');
  }

  async setPlanMode(sessionId: string, on: boolean): Promise<void> {
    const rawId = validateSessionId(sessionId);
    if (on) this.settingsStore.set('plan', rawId, true);
    else this.settingsStore.delete('plan', rawId);
  }

  getPlanMode(sessionId: string): boolean | undefined {
    const rawId = validateSessionId(sessionId);
    return this.settingsStore.getBoolean('plan', rawId);
  }

  getUsage(sessionId: string): SessionUsage | undefined {
    const rawId = validateSessionId(sessionId);
    const proj = this.adapter.readProjcache(rawId);
    const totals = proj?.tokenUsage?.val?.totals;
    if (!totals) {
      return {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost_usd: 0,
        context_tokens: 0,
        context_limit: 131_072,
        turn_count: 0,
      };
    }
    const input = totals.uncachedInputTokens ?? 0;
    const output = totals.outputTokens ?? 0;
    const cacheRead = totals.cacheReadTokens ?? 0;
    const cacheWrite = totals.cacheWriteTokens ?? 0;
    const turns = proj?.turnBoundary?.val?.lastTurn ?? 0;
    return {
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheWrite,
      total_cost_usd: 0,
      context_tokens: input + cacheRead,
      context_limit: 131_072,
      turn_count: turns,
    };
  }

  async getHistory(sessionId: string, query?: HistoryQuery): Promise<Message[]> {
    const rawId = validateSessionId(sessionId);
    return this.adapter.getHistoryMessages(rawId);
  }

  async listModels(): Promise<NativeModel[]> {
    if (this.cachedModels && this.cachedModels.length > 0) {
      return this.cachedModels;
    }
    const staticModels = discoverStaticModels(this.adapter.sessionsDirectory, this.adapter.binPath, this.adapter.injectedArgs());
    if (staticModels && staticModels.length > 0) {
      this.cachedModels = staticModels;
      return staticModels;
    }
    return [];
  }

  async listCommands(_sessionId?: string, _cwd?: string): Promise<NativeCommand[]> {
    return listDshCommands();
  }

  async startTurn(input: StartTurnInput): Promise<TurnHandle> {
    let rawId = validateSessionId(input.sessionId);
    const client = this.adapter.getAcpClient();
    const sessionId = input.sessionId;
    const turnId = randomUUID();

    // Prefer the cwd recorded at create/list time; StartTurnInput carries no cwd.
    let cwd = this.sessionCwds.get(rawId);
    if (!cwd) {
      const rec = this.adapter.listSessionsFromDisk().find((r) => r.id === rawId);
      cwd = rec?.cwd;
    }
    if (!cwd) {
      const cwdMeta = input.metadata?.cwd;
      cwd = typeof cwdMeta === 'string' && cwdMeta ? cwdMeta : process.cwd();
    }
    const resumeRes = await client.resumeSession(rawId, cwd);
    if (resumeRes?.configOptions) {
      this.updateCachedConfigOptions(resumeRes.configOptions);
    }

    const promptText = typeof input.input === 'string'
      ? input.input
      : input.input.map((p) => ('text' in p ? p.text : '')).join(' ');

    this.adapter.markTurnStart(turnId);
    const events = new AsyncEventQueue();
    const toolCalls = new Map<string, { name: string; input: unknown }>();
    let accumulatedAssistantText = '';
    let accumulatedReasoningText = '';

    events.push({
      kind: 'turn',
      status: 'started',
      sessionId,
      turnId,
      timestamp: Date.now(),
      payload: {},
    });

    const unsubscribe = client.on((ev: DshAcpEvent) => {
      if ('sessionId' in ev && ev.sessionId !== rawId) return;

      if (ev.type === 'thought_chunk') {
        accumulatedReasoningText += ev.text;
        events.push({
          kind: 'thinking',
          status: 'delta',
          sessionId,
          turnId,
          timestamp: Date.now(),
          payload: { text: ev.text, delta: ev.text },
        });
      } else if (ev.type === 'message_chunk') {
        accumulatedAssistantText += ev.text;
        events.push({
          kind: 'message',
          status: 'delta',
          sessionId,
          turnId,
          timestamp: Date.now(),
          payload: {
            message: {
              id: ev.messageId || randomUUID(),
              session_id: sessionId,
              role: 'assistant',
              content: [{ type: 'text', text: ev.text }],
              created_at: new Date().toISOString(),
            },
            delta: ev.text,
          },
        });
      } else if (ev.type === 'tool_call') {
        toolCalls.set(ev.toolCallId, { name: ev.title, input: ev.rawInput });
        events.push({
          kind: 'tool',
          status: 'started',
          sessionId,
          turnId,
          timestamp: Date.now(),
          payload: {
            toolCallId: ev.toolCallId,
            name: ev.title,
            input: ev.rawInput,
          },
        });
      } else if (ev.type === 'tool_call_update') {
        const isFailed = ev.status === 'failed' || ev.status === 'error';
        events.push({
          kind: 'tool',
          status: isFailed ? 'failed' : 'completed',
          sessionId,
          turnId,
          timestamp: Date.now(),
          payload: {
            toolCallId: ev.toolCallId,
            name: ev.title || 'tool',
            output: formatToolOutput(ev.rawOutput),
            is_error: isFailed,
          },
        });
      } else if (ev.type === 'permission_request') {
        const callId = String(ev.toolCall?.toolCallId ?? ev.toolCall?.callId ?? '');
        const prevTool = callId ? toolCalls.get(callId) : undefined;
        events.push({
          kind: 'approval',
          status: 'started',
          sessionId,
          turnId,
          timestamp: Date.now(),
          payload: {
            approvalId: String(ev.requestId),
            tool: prevTool?.name || String(ev.toolCall?.name || 'tool'),
            input: prevTool?.input ?? ev.toolCall?.arguments ?? ev.toolCall?.input,
            itemId: callId || String(ev.requestId),
          },
        });
      }
    });

    client
      .prompt(rawId, promptText)
      .then((res) => {
        this.adapter.appendHistoryCache(rawId, promptText, accumulatedAssistantText, accumulatedReasoningText);
        const isCancelled = res?.stopReason === 'cancelled';
        events.push({
          kind: 'turn',
          status: isCancelled ? 'cancelled' : 'completed',
          sessionId,
          turnId,
          timestamp: Date.now(),
          payload: { reason: isCancelled ? 'cancelled' : 'completed' },
        });
      })
      .catch((err) => {
        console.error(`[dsh-adapter] prompt(${rawId}) failed:`, err instanceof Error ? err.message : err);
        events.push({
          kind: 'turn',
          status: 'failed',
          sessionId,
          turnId,
          timestamp: Date.now(),
          payload: { reason: 'failed', error: err instanceof Error ? err.message : String(err) },
        });
      })
      .finally(() => {
        this.adapter.markTurnEnd(turnId);
        events.finish();
        unsubscribe();
      });

    return {
      turnId,
      events,
    };
  }

  async resolveApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const rawId = validateSessionId(sessionId);
    const client = this.adapter.getAcpClient();
    const resolved = client.resolvePermission(approvalId, decision, rawId);
    if (!resolved) {
      throw new ProviderError('not_found', `Approval ${approvalId} not found for session ${sessionId}`, 404);
    }
  }

  async resolveQuestion(sessionId: string, questionId: string, answer: string): Promise<void> {
    // DSH uses approval rather than questions currently
  }

  async interrupt(sessionId: string): Promise<void> {
    const rawId = validateSessionId(sessionId);
    const client = this.adapter.getAcpClient();
    await client.cancel(rawId);
  }

  async close(sessionId: string): Promise<void> {
    const rawId = validateSessionId(sessionId);
    this.sessionCwds.delete(rawId);
    this.sessionCwds.delete(sessionId);
  }

  async dispose(): Promise<void> {
    this.adapter.dispose();
  }
}
