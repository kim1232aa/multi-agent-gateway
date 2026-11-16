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

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { DshAcpClient, type DshAcpEvent } from './dsh-acp.js';
import { workspaceIdFromCwd } from './facade.js';
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

export class DshAdapter {
  private readonly dshBin: string;
  private readonly sessionsDir: string;
  private readonly projcacheDir: string;
  private readonly historyCacheDir: string;
  private acpClient: DshAcpClient | null = null;
  private activeTurns = new Set<string>();

  constructor(options: { dshBin?: string; sessionsDir?: string; projcacheDir?: string; historyCacheDir?: string } = {}) {
    this.dshBin = resolveDshBin(options.dshBin);
    this.sessionsDir = options.sessionsDir ?? resolveDshSessionsDir();
    const dshHome = path.dirname(this.sessionsDir);
    this.projcacheDir = options.projcacheDir ?? path.join(dshHome, 'storages', 'session_projcache', 'sessions');
    this.historyCacheDir = options.historyCacheDir ?? path.join(dshHome, 'gateway_history');
    try {
      if (!fs.existsSync(this.historyCacheDir)) fs.mkdirSync(this.historyCacheDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  get binPath(): string {
    return this.dshBin;
  }

  isBusy(): boolean {
    return this.activeTurns.size > 0 || (this.acpClient?.isBusy() ?? false);
  }

  getAcpClient(alwaysApprove = false): DshAcpClient {
    if (!this.acpClient || !this.acpClient.isConnected()) {
      this.acpClient = new DshAcpClient({
        dshBin: this.dshBin,
        alwaysApprove,
        recycleGraceMs: 60_000,
        env: {
          // dsh profile patches route llm through the ccwu relay; it needs this key.
          ...(process.env.CCWU_API_KEY ? { CCWU_API_KEY: process.env.CCWU_API_KEY } : {}),
        },
      });
    }
    return this.acpClient;
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
          const buf = fs.readFileSync(sessionFile);
          const raw = zlib.zstdDecompressSync(buf).toString('utf8');
          const lines = raw.trim().split('\n').filter(Boolean);
          if (lines.length === 0) continue;

          let header: any = null;
          let firstUserPrompt = '';
          let explicitTitle = '';
          let userMsgCount = 0;

          for (const line of lines) {
            let ev: any;
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            if (ev.type === 'session' && !header) {
              header = ev;
            } else if (ev.type === 'session/title' && ev.data?.title) {
              explicitTitle = ev.data.title;
            } else if (ev.type === 'user/message') {
              userMsgCount++;
              if (!firstUserPrompt && Array.isArray(ev.data?.message?.content)) {
                for (const part of ev.data.message.content) {
                  if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
                    firstUserPrompt = part.text.trim().slice(0, 80);
                    break;
                  }
                }
              }
            }
          }

          if (!header) continue;

          // Live projection overlay (title/turn/busy from the projcache JSON).
          const proj = this.readProjcache(sessionId);
          const liveTitle = typeof proj?.title?.val === 'string' && proj.title.val.trim() ? proj.title.val.trim() : '';
          const turnCount = typeof proj?.turnBoundary?.val?.lastTurn === 'number' ? proj.turnBoundary.val.lastTurn : 0;
          const busy = proj?.turnBoundary?.val?.openTurnStartSeq != null;

          // Placeholder = no log events yet, no live title, zero turns. Skip those
          // to keep the sidebar clean; a session shows up right after its first turn.
          const isPlaceholder = userMsgCount === 0 && !explicitTitle && !liveTitle && turnCount === 0;
          if (isPlaceholder) continue;

          const title = explicitTitle || liveTitle || firstUserPrompt || '(session)';
          const createdAt = header.createdAt ? new Date(header.createdAt).toISOString() : stats.birthtime.toISOString();
          const updatedAt = stats.mtime.toISOString();

          results.push({
            id: sessionId,
            cwd: header.cwd || process.cwd(),
            title,
            createdAt,
            updatedAt,
            messageCount: userMsgCount,
            filePath: sessionFile,
            busy,
            turnCount,
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
    try {
      const file = path.join(this.projcacheDir, `${sessionId}.json`);
      if (!fs.existsSync(file)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { record?: { rows?: DshProjcacheRecord } };
      return parsed.record?.rows ?? undefined;
    } catch {
      return undefined;
    }
  }

  getHistoryMessages(sessionId: string): Message[] {
    const records = this.listSessionsFromDisk();
    const record = records.find((r) => r.id === sessionId);
    if (!record || !fs.existsSync(record.filePath)) return [];

    const messages: Message[] = [];
    try {
      const buf = fs.readFileSync(record.filePath);
      const raw = zlib.zstdDecompressSync(buf).toString('utf8');
      const lines = raw.trim().split('\n').filter(Boolean);

      let msgIndex = 0;
      for (const line of lines) {
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }

        if (ev.type === 'user/message') {
          let text = '';
          if (Array.isArray(ev.data?.message?.content)) {
            for (const part of ev.data.message.content) {
              if (part.type === 'text' && typeof part.text === 'string') {
                text += part.text;
              }
            }
          }
          messages.push({
            id: `msg_u_${msgIndex++}`,
            session_id: sessionId,
            role: 'user',
            content: [{ type: 'text', text }],
            created_at: new Date().toISOString(),
          });
        } else if (ev.type === 'assistant/message') {
          let text = '';
          let reasoning = '';
          const parts: MessageContentPart[] = [];

          if (Array.isArray(ev.data?.message?.content)) {
            for (const part of ev.data.message.content) {
              if (part.type === 'reasoning' && typeof part.text === 'string') {
                reasoning += part.text;
                parts.push({ type: 'thinking', thinking: part.text });
              } else if (part.type === 'text' && typeof part.text === 'string') {
                text += part.text;
                parts.push({ type: 'text', text: part.text });
              }
            }
          }

          messages.push({
            id: `msg_a_${msgIndex++}`,
            session_id: sessionId,
            role: 'assistant',
            content: parts.length > 0 ? parts : [{ type: 'text', text }],
            created_at: new Date().toISOString(),
          });
        }
      }
    } catch {
      // ignore
    }

    if (messages.length > 0) return messages;

    // Fallback: read from gateway_history cache file
    try {
      const cacheFile = path.join(this.historyCacheDir, `${sessionId}.json`);
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
    try {
      const cacheFile = path.join(this.historyCacheDir, `${sessionId}.json`);
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
}

export class DshProviderAdapter implements ProviderAdapter {
  readonly name = 'dsh';
  private readonly adapter: DshAdapter;
  private readonly settingsStore: SettingsStore;
  /** Gateway native id → cwd (recorded at create/resume time for later turns). */
  private readonly sessionCwds = new Map<string, string>();

  constructor(options: { dshBin?: string; sessionsDir?: string; settingsPath?: string; settingsStore?: SettingsStore } = {}) {
    this.adapter = new DshAdapter(options);
    this.settingsStore = options.settingsStore ?? new SettingsStore(options.settingsPath);
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
      planMode: true,
      permissionModes: ['default', 'auto', 'bypassPermissions', 'plan'],
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
    }));

    const limit = query.limit ?? 50;
    const page = sessions.slice(0, limit);
    return {
      items: page,
      ...(sessions.length > limit ? { next_cursor: page[page.length - 1]?.id } : {}),
    };
  }

  async get(id: string): Promise<Session> {
    const rawId = id.startsWith('dsh_') ? id.slice(4) : id;
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
    };
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const cwd = input.cwd || process.cwd();
    const client = this.adapter.getAcpClient();
    const res = await client.newSession(cwd);
    this.sessionCwds.set(res.sessionId, cwd);
    const now = new Date().toISOString();
    return {
      id: res.sessionId,
      workspace_id: workspaceIdFromCwd(cwd, 'dsh'),
      title: input.title || 'New Session',
      created_at: now,
      updated_at: now,
      busy: false,
      metadata: { cwd },
      provider: 'dsh',
    };
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    const rawId = sessionId.startsWith('dsh_') ? sessionId.slice(4) : sessionId;
    if (archived) this.settingsStore.set('archived', rawId, true);
    else this.settingsStore.delete('archived', rawId);
  }

  async delete(id: string): Promise<void> {
    const rawId = id.startsWith('dsh_') ? id.slice(4) : id;
    this.settingsStore.set('deleted', rawId, true);
    this.sessionCwds.delete(rawId);
    try {
      const cacheFile = path.join(this.adapter.historyDir, `${rawId}.json`);
      if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
    } catch {}
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const rawId = sessionId.startsWith('dsh_') ? sessionId.slice(4) : sessionId;
    this.settingsStore.set('title', rawId, title);
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const rawId = sessionId.startsWith('dsh_') ? sessionId.slice(4) : sessionId;
    this.settingsStore.set('model', rawId, model);
  }

  getModel(sessionId: string): string | undefined {
    const rawId = sessionId.startsWith('dsh_') ? sessionId.slice(4) : sessionId;
    return this.settingsStore.getString('model', rawId) ?? this.settingsStore.getString('model', '__default__');
  }

  async setPermission(sessionId: string, mode: string): Promise<void> {
    const rawId = sessionId.startsWith('dsh_') ? sessionId.slice(4) : sessionId;
    this.settingsStore.set('permission', rawId, mode);
  }

  getPermission(sessionId: string): string | undefined {
    const rawId = sessionId.startsWith('dsh_') ? sessionId.slice(4) : sessionId;
    return this.settingsStore.getString('permission', rawId) ?? this.settingsStore.getString('permission', '__default__');
  }

  async setPlanMode(sessionId: string, on: boolean): Promise<void> {
    const rawId = sessionId.startsWith('dsh_') ? sessionId.slice(4) : sessionId;
    if (on) this.settingsStore.set('plan', rawId, true);
    else this.settingsStore.delete('plan', rawId);
  }

  getPlanMode(sessionId: string): boolean | undefined {
    const rawId = sessionId.startsWith('dsh_') ? sessionId.slice(4) : sessionId;
    return this.settingsStore.getBoolean('plan', rawId);
  }

  getUsage(sessionId: string): SessionUsage | undefined {
    const rawId = sessionId.startsWith('dsh_') ? sessionId.slice(4) : sessionId;
    const proj = this.adapter.readProjcache(rawId);
    const totals = proj?.tokenUsage?.val?.totals;
    if (!totals) return undefined;
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
    const rawId = sessionId.startsWith('dsh_') ? sessionId.slice(4) : sessionId;
    return this.adapter.getHistoryMessages(rawId);
  }

  async models(sessionId?: string): Promise<NativeModel[]> {
    return [
      {
        provider: 'dsh',
        model: 'deepseek-v4-flash',
        display_name: 'DeepSeek V4 Flash',
        description: 'Fast, lightweight agent model for code execution',
        max_context_size: 131_072,
        isDefault: true,
      },
      {
        provider: 'dsh',
        model: 'deepseek-chat',
        display_name: 'DeepSeek Chat (V3)',
        description: 'DeepSeek general high-intelligence chat & code model',
        max_context_size: 131_072,
        isDefault: false,
      },
      {
        provider: 'dsh',
        model: 'deepseek-reasoner',
        display_name: 'DeepSeek Reasoner (R1)',
        description: 'DeepSeek full reasoning chain model with deep thought',
        max_context_size: 131_072,
        isDefault: false,
      },
    ];
  }

  async commands(sessionId?: string): Promise<NativeCommand[]> {
    return [
      {
        name: '/plan',
        description: 'Switch DSH to read-only plan mode',
        kind: 'client',
      },
      {
        name: '/compact',
        description: 'Trigger context compaction in DSH',
        kind: 'client',
      },
      {
        name: '/goal',
        description: 'Set an autonomous durable goal for DSH',
        kind: 'prompt',
      },
    ];
  }

  async startTurn(input: StartTurnInput): Promise<TurnHandle> {
    let rawId = input.sessionId;
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
    // The dsh ACP connection may have been recycled since this session was
    // created. Resume it; on "unknown session" (fresh process) re-create a
    // session on the same cwd and remap the id for this turn.
    try {
      await client.resumeSession(rawId, cwd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('unknown session')) {
        const remapped = await client.newSession(cwd);
        rawId = remapped.sessionId;
        this.sessionCwds.set(rawId, cwd);
        console.warn(`[dsh-adapter] recycled session ${input.sessionId} remapped to ${rawId} (cwd=${cwd})`);
      } else {
        console.warn(`[dsh-adapter] resumeSession(${rawId}) failed: ${message}`);
      }
    }

    const promptText = typeof input.input === 'string'
      ? input.input
      : input.input.map((p) => ('text' in p ? p.text : '')).join(' ');

    const events: GatewayEvent[] = [];
    let resolveTurn: (() => void) | undefined;
    let finished = false;
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
        events.push({
          kind: 'tool',
          status: 'completed',
          sessionId,
          turnId,
          timestamp: Date.now(),
          payload: {
            toolCallId: ev.toolCallId,
            name: ev.title || 'tool',
            output: typeof ev.rawOutput === 'string' ? ev.rawOutput : JSON.stringify(ev.rawOutput),
          },
        });
      } else if (ev.type === 'permission_request') {
        events.push({
          kind: 'approval',
          status: 'started',
          sessionId,
          turnId,
          timestamp: Date.now(),
          payload: {
            approvalId: String(ev.requestId),
            tool: String(ev.toolCall?.name || 'tool'),
            input: ev.toolCall?.arguments,
          },
        });
      }
    });

    client
      .prompt(rawId, promptText)
      .then(() => {
        this.adapter.appendHistoryCache(rawId, promptText, accumulatedAssistantText, accumulatedReasoningText);
        finished = true;
        events.push({
          kind: 'turn',
          status: 'completed',
          sessionId,
          turnId,
          timestamp: Date.now(),
          payload: { reason: 'completed' },
        });
        resolveTurn?.();
      })
      .catch((err) => {
        console.error(`[dsh-adapter] prompt(${rawId}) failed:`, err instanceof Error ? err.message : err);
        finished = true;
        events.push({
          kind: 'turn',
          status: 'failed',
          sessionId,
          turnId,
          timestamp: Date.now(),
          payload: { reason: 'failed', error: err.message },
        });
        resolveTurn?.();
      })
      .finally(() => {
        unsubscribe();
      });

    async function* eventStream(): AsyncIterable<GatewayEvent> {
      while (!finished || events.length > 0) {
        if (events.length > 0) {
          yield events.shift()!;
        } else {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
    }

    return {
      turnId,
      events: eventStream(),
    };
  }

  async resolveApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const rawId = sessionId;
    const client = this.adapter.getAcpClient();
    const approved = decision === 'approve' || decision === 'approve_always';
    client.resolvePermission(rawId, approved);
  }

  async resolveQuestion(sessionId: string, questionId: string, answer: string): Promise<void> {
    // DSH uses approval rather than questions currently
  }

  async interrupt(sessionId: string): Promise<void> {
    const rawId = sessionId;
    const client = this.adapter.getAcpClient();
    await client.cancel(rawId);
  }

  async close(): Promise<void> {
    const client = this.adapter.getAcpClient();
    client.close();
  }
}
