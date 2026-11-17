/**
 * gateway:对外讲 Kimi kap-server 协议的 HTTP + WebSocket 服务。
 *
 * 路由规则:
 * - provider 通过 URL query `?provider=kimi|claude|codex|grok|pi` 显式指定,或由会话 id 前缀推断。
 * - Kimi 会话(id 无前缀)→ 由 kimi-proxy 无损转发到 kap-server。
 * - Codex / Claude / Grok / Pi 会话 → facade 适配层,把各家协议翻译成 Kimi wire 格式。
 *
 * 只实现"能用 Kimi / Claude / Codex / Grok / Pi 会话"的最小 API 面:
 *   meta / auth / healthz / workspaces / sessions(CRUD+snapshot)/ prompts(提交/中止)
 *   / approvals / questions,加 /api/v1/ws 事件推送。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { randomUUID, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import * as fsp from 'node:fs/promises';
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadWebShell, type WebShell } from './web-assets.js';
import { createKimiHttpProxy, createKimiWsUpgrader, isKimiApiPath } from './kimi-proxy.js';
import { bridgeKimiV25Ws, fetchKimiV25Turns, isKimiV25Version } from './kimi-v25-bridge.js';
import { WS_MAX_MESSAGE_BYTES, WsFrameParser, wsAccept, wsSendFrame, wsSendText, type ParsedWsFrame } from './ws-framing.js';
import { followKimiServer, spawnKimiServer, type KimiChild } from './kimi-child.js';
import { createStaticServer } from './static.js';
import { CodexProviderAdapter, ClaudeProviderAdapter, claudeContextWindow } from './facade.js';
import { GrokProviderAdapter } from './grok-adapter.js';
import { PiProviderAdapter } from './pi-adapter.js';
import { DshProviderAdapter } from './dsh-adapter.js';
import { SettingsStore } from './settings-store.js';
import {
  claudeGatewayCommandNames,
  claudeUnsupportedTuiCommandNames,
  codexGatewayCommandNames,
  dshGatewayCommandNames,
  expandDshSkill,
  grokGatewayCommandNames,
  grokUnsupportedTuiCommandNames,
  piGatewayCommandNames,
  piUnsupportedTuiCommandNames,
} from './native-commands.js';
import { fsDiff, fsGitStatus, fsGrep, fsList, fsRead, fsRepoDiff, fsSearch } from './fs-local.js';
import {
  buildLocalTranscriptPage,
  extractSubagentIdFromOutput,
  LocalTranscriptHub,
  normalizeKimiWebTool,
  type LocalTranscriptTurn,
  type TranscriptEmission,
  type TranscriptTask,
} from './local-transcript.js';
import {
  demoEnabled,
  demoStartTurn,
  getDemoHistory,
  getDemoModel,
  getDemoSession,
  isDemoSession,
  listDemoSessions,
} from './demo-sessions.js';
import {
  ProviderError,
  isProviderName,
  type GatewayEvent,
  type GranularApprovalDetails,
  type Message,
  type NativeCommand,
  type NativeModel,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderName,
  type Session,
  type SessionPage,
  type SessionUsage,
  type TurnAttachment,
  type TurnHandle,
} from './types.js';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

type LocalProviderName = Exclude<ProviderName, 'kimi'>;
const LOCAL_PROVIDERS: readonly LocalProviderName[] = ['codex', 'claude', 'grok', 'pi', 'dsh'];

export interface GatewayOptions {
  port?: number;
  host?: string;
  /** 网关自身的访问 token(前端 #token= 或 Bearer)。 */
  token?: string;
  codex?: CodexProviderAdapter;
  claude?: ClaudeProviderAdapter;
  grok?: ProviderAdapter;
  pi?: ProviderAdapter;
  dsh?: ProviderAdapter;
  /**
   * Kimi 路径的上游来源:
   * - 'spawn'(默认):网关自起 `kimi web` 子进程并解析它的 token;
   * - { upstream, token }:用外部 kap-server(需调用方提供 token);
   * - 'off':不提供 Kimi 路径(仅剩 Codex/Claude/Grok/Pi)。
   */
  kimi?: 'spawn' | 'off' | { upstream: string; token?: string };
  /** kimi-web 构建产物目录(SPA 静态托管);默认仓库 web-dist。 */
  staticDir?: string;
  /** 注入层目录;默认仓库 web-extension。 */
  extensionDir?: string;
  /** 官方资产 manifest;默认仓库 web-origin-manifest.json。 */
  manifestPath?: string;
  /**
   * 会话级设置(model/thinking/permission/plan)的持久化目录;
   * 默认 $GATEWAY_SETTINGS_DIR 或 ~/.config/multi-agent-gateway。
   */
  settingsDir?: string;
  /**
   * 对外展示的可用 provider(默认按本机二进制探测:claude/codex/grok/pi 没装就不出现
   * 在选择器里,避免用户点了才发现不存在)。测试可显式覆盖。
   */
  availableProviders?: ProviderName[];
}

/** 探测本机实际安装的 provider:只做一次 fs 检查,不起进程(开销)。 */
export function detectAvailableProviders(env: NodeJS.ProcessEnv = process.env): ProviderName[] {
  const providers: ProviderName[] = ['kimi'];
  const claudeBin = env.CLAUDE_BIN ?? path.join(os.homedir(), '.local', 'bin', 'claude');
  if (existsSync(claudeBin) || onPath('claude', env.PATH)) providers.push('claude');
  const grokBin = env.GROK_BIN ?? path.join(os.homedir(), '.local', 'bin', 'grok');
  if (existsSync(grokBin) || onPath('grok', env.PATH)) providers.push('grok');
  const codexPath = env.CODEX_PATH;
  if (codexPath ? existsSync(codexPath) : onPath('codex', env.PATH)) providers.push('codex');
  const piBin = env.PI_BIN ?? path.join(os.homedir(), '.local', 'bin', 'pi');
  if (existsSync(piBin) || onPath('pi', env.PATH)) providers.push('pi');
  const dshBin = env.DSH_BIN ?? path.join(os.homedir(), '.local', 'bin', 'dsh');
  if (existsSync(dshBin) || onPath('dsh', env.PATH)) providers.push('dsh');
  return providers;
}

function onPath(bin: string, pathEnv: string | undefined): boolean {
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      accessSync(path.join(dir, bin), fsConstants.X_OK);
      return true;
    } catch {
      // 不在该目录,继续。
    }
  }
  return false;
}

/** 已解析的 Kimi 上游;token 必存在(spawn 模式一定能解析到)。 */
interface KimiUpstream {
  url: string;
  token: string;
  child?: KimiChild;
}

const API = '/api/v1';

// ---------------------------------------------------------------------------
// provider 路由:id 前缀 ↔ provider
// ---------------------------------------------------------------------------

const ID_PREFIX: Record<LocalProviderName, string> = {
  codex: 'codex_',
  claude: 'claude_',
  grok: 'grok_',
  pi: 'pi_',
  dsh: 'dsh_',
};

/** Preview transcripts. Bound per startGateway() instance — never module-global. */

function mergeDemoSessions(provider: ProviderName, items: Session[], demoActive: boolean): Session[] {
  if (!demoActive) return items;
  const seen = new Set(items.map((session) => session.id));
  const extra = listDemoSessions(provider).filter((session) => !seen.has(session.id));
  if (extra.length === 0) return items;
  return [...items, ...extra].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function tryHistoryWithDemo(
  adapter: ProviderAdapter | null,
  provider: ProviderName,
  nativeId: string,
  demoActive: boolean,
): Promise<Message[] | null> {
  if (demoActive) {
    const demo = getDemoHistory(provider, nativeId);
    if (demo) return Promise.resolve(demo);
  }
  if (!adapter) return Promise.resolve([]);
  return adapter.getHistory(nativeId).catch(() => null);
}

function historyWithDemo(
  adapter: ProviderAdapter | null,
  provider: ProviderName,
  nativeId: string,
  demoActive: boolean,
): Promise<Message[]> {
  return tryHistoryWithDemo(adapter, provider, nativeId, demoActive).then((h) => h ?? []);
}

function kimiDemoAdapter(): ProviderAdapter {
  return {
    name: 'kimi',
    capabilities: () => ({
      streaming: true,
      thinking: true,
      tools: true,
      approvals: false,
      questions: false,
      interrupt: false,
      history: true,
    }),
    async list() {
      return { items: listDemoSessions('kimi') };
    },
    async create() {
      throw new ProviderError('unsupported', 'preview demo cannot create Kimi sessions', 400);
    },
    async getHistory(sessionId) {
      const history = getDemoHistory('kimi', sessionId);
      if (!history) throw new ProviderError('not_found', `kimi session not found: ${sessionId}`, 404);
      return history;
    },
    async startTurn(input) {
      const text = typeof input.input === 'string'
        ? input.input
        : input.input.map((part) => (part.type === 'text' ? part.text : '')).join('');
      return demoStartTurn('kimi', input.sessionId, text);
    },
    async interrupt() { /* demo turns are instant */ },
    async resolveApproval() {
      throw new ProviderError('unsupported', 'demo session has no approvals', 400);
    },
    async resolveQuestion() {
      throw new ProviderError('unsupported', 'demo session has no questions', 400);
    },
    async close() { /* no-op */ },
    getCwd: (sessionId) => getDemoSession('kimi', sessionId)?.metadata.cwd,
    getModel: (sessionId) => getDemoModel('kimi', sessionId),
  };
}

function isLocalProvider(value: string | null | undefined): value is LocalProviderName {
  return value === 'claude' || value === 'codex' || value === 'grok' || value === 'pi' || value === 'dsh';
}

/** Official grok-4.6 / grok-4.5 window (https://docs.x.ai/developers/models/grok-4.6). */
function grokStatusContextFallback(): number {
  return 500_000;
}

/** Official DeepSeek V3 / R1 context window (128K). */
function dshStatusContextFallback(): number {
  return 131_072;
}

function prefixedId(provider: ProviderName, nativeId: string): string {
  return !isLocalProvider(provider) ? nativeId : `${ID_PREFIX[provider]}${nativeId}`;
}

function firstUserText(messages: Message[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const part of message.content) {
      if (part.type === 'text' && part.text.trim()) {
        return part.text.trim().replace(/\s+/g, ' ').slice(0, 80);
      }
    }
  }
  return '';
}

async function generateLocalSessionTitle(adapter: ProviderAdapter, nativeId: string): Promise<string> {
  const history = adapter.getHistory ? await adapter.getHistory(nativeId, { limit: 20 }).catch(() => []) : [];
  const fromHistory = firstUserText(history);
  if (fromHistory) return fromHistory;
  const listed = adapter.list ? await adapter.list({ limit: 50 }).catch(() => ({ items: [] as Session[] })) : { items: [] };
  const existing = listed.items.find((session) => session.id === nativeId)?.title?.trim();
  return existing || 'New session';
}

function providerFromSessionId(id: string): { provider: ProviderName; nativeId: string } {
  for (const [provider, prefix] of Object.entries(ID_PREFIX) as [LocalProviderName, string][]) {
    if (id.startsWith(prefix)) {
      return { provider, nativeId: id.slice(prefix.length) };
    }
  }
  return { provider: 'kimi', nativeId: id };
}

/** archive/restore/delete 后清掉该会话当过页尾时留下的翻页游标,避免 Open/Done 串页。 */
const MAX_SESSION_PAGE_CURSORS = 500;

function clearSessionPageCursors(pageCursors: Map<string, string>, sessionId: string): void {
  for (const key of pageCursors.keys()) {
    if (key.endsWith(`\u0000${sessionId}`)) pageCursors.delete(key);
  }
}

function setSessionPageCursor(pageCursors: Map<string, string>, key: string, cursor: string): void {
  if (pageCursors.has(key)) {
    pageCursors.delete(key);
  } else if (pageCursors.size >= MAX_SESSION_PAGE_CURSORS) {
    const oldest = pageCursors.keys().next().value;
    if (oldest !== undefined) pageCursors.delete(oldest);
  }
  pageCursors.set(key, cursor);
}

function getSessionPageCursor(pageCursors: Map<string, string>, key: string): string | undefined {
  const cursor = pageCursors.get(key);
  if (cursor !== undefined) {
    pageCursors.delete(key);
    pageCursors.set(key, cursor);
  }
  return cursor;
}

// ---------------------------------------------------------------------------
// envelope
// ---------------------------------------------------------------------------

function ok(res: ServerResponse, data: unknown, requestId: string): void {
  sendJson(res, 200, { code: 0, msg: 'success', data, request_id: requestId });
}

function fail(res: ServerResponse, httpStatus: number, code: number, msg: string, requestId: string): void {
  sendJson(res, httpStatus, { code, msg, data: null, request_id: requestId });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,x-request-id',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).byteLength;
    // 无上限累积会把网关内存打爆;正常 body(会话/设置)远小于此。
    if (size > 10 * 1024 * 1024) {
      throw new ProviderError('invalid_request', 'request body too large', 400);
    }
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ProviderError('invalid_request', 'invalid JSON body', 400);
  }
}

// ---------------------------------------------------------------------------
// 会话忙闲与事件中心(WS 广播)
// ---------------------------------------------------------------------------

interface ActiveTurn {
  sessionId: string;
  turnId: string;
  promptId: string;
  /** abort 在 acquire 窗口(turnId 还没拿到)到达时置位,acquire 成功后立即 interrupt。 */
  cancelled: boolean;
  assistantText: string;
  thinkingText: string;
  runningTools: Map<string, { name: string; args?: unknown }>;
  pendingApprovals: Map<string, { tool: string; input?: unknown; itemId?: string }>;
  pendingQuestions: Map<string, { prompt: string; rawQuestions?: unknown[] }>;
  localQuestionResolvers?: Map<string, (payload: string | Record<string, string[]> | null) => void>;
  transcript?: LocalTranscriptTurn;
  v262TurnId: string;
  v262Ordinal: number;
  v262StartedAt: string;
  v262StepIndex: number;
  v262AssistantItemId?: string;
  v262ThinkingItemId?: string;
  v262ThinkingStartedAt?: number;
  v262Items: Array<Record<string, unknown>>;
  v262ItemMap: Map<string, Record<string, unknown>>;
}

/** 排队中的 prompt(busy 时提交;对齐 kap-server 的 queued 语义)。 */
interface QueuedPrompt {
  promptId: string;
  text: string;
  /** 随 prompt 的附件(网关解析后的形态;接力时一并交给 adapter)。 */
  attachments?: TurnAttachment[];
  createdAt: string;
}

export class SessionHub {
  readonly busy = new Map<string, ActiveTurn>();
  readonly queued = new Map<string, QueuedPrompt[]>();
  readonly transcript = new LocalTranscriptHub();
  private readonly listeners = new Map<string, Set<(ev: Record<string, unknown>) => void>>();
  private readonly v262Listeners = new Map<string, Set<(ev: Record<string, unknown>) => void>>();
  private readonly globalListeners = new Set<(ev: Record<string, unknown>) => void>();
  /**
   * 每会话的非 volatile 帧环形缓冲(WS 断线重连后按 cursor 重放)。
   * volatile 帧(assistant/thinking delta)是瞬态拼字,重放会重复文本,
   * 一律不缓冲(对齐 kap-server 语义:cursor 恢复走 snapshot+非瞬态帧)。
   */
  private readonly replay = new Map<string, { seq: number; frame: Record<string, unknown> }[]>();
  /** 每会话最近被挤出的帧 seq:客户端 cursor 比它还旧 = 有缺口,要 resync。 */
  private readonly evictedSeq = new Map<string, number>();
  private static readonly REPLAY_CAP = 200;
  private seq = 0;
  readonly epoch = randomBytes(8).toString('base64url');

  nextSeq(): number {
    return ++this.seq;
  }

  currentSeq(): number {
    return this.seq;
  }

  listenerCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0;
  }

  hasListeners(sessionId: string): boolean {
    return this.listeners.has(sessionId);
  }

  hasV262Listeners(sessionId: string): boolean {
    return this.v262Listeners.has(sessionId);
  }

  subscribe(sessionId: string, fn: (ev: Record<string, unknown>) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) {
        this.listeners.delete(sessionId);
      }
    };
  }

  subscribeV262(sessionId: string, fn: (ev: Record<string, unknown>) => void): () => void {
    let set = this.v262Listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.v262Listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) {
        this.v262Listeners.delete(sessionId);
      }
    };
  }

  broadcastV262(sessionId: string, payload: Record<string, unknown>): void {
    const targets = this.v262Listeners.get(sessionId);
    if (!targets || targets.size === 0) return;
    for (const fn of targets) fn(payload);
  }

  subscribeGlobal(fn: (ev: Record<string, unknown>) => void): () => void {
    this.globalListeners.add(fn);
    return () => this.globalListeners.delete(fn);
  }

  broadcast(sessionId: string, frame: Record<string, unknown>): void {
    if (frame.volatile !== true && typeof frame.seq === 'number') {
      const buf = this.replay.get(sessionId) ?? [];
      buf.push({ seq: frame.seq, frame });
      if (buf.length > SessionHub.REPLAY_CAP) {
        const dropped = buf.splice(0, buf.length - SessionHub.REPLAY_CAP);
        this.evictedSeq.set(sessionId, dropped[dropped.length - 1].seq);
      }
      this.replay.set(sessionId, buf);
    }
    const type = typeof frame.type === 'string' ? frame.type : '';
    const targets = new Set(this.listeners.get(sessionId) ?? []);
    if (type === 'session.meta.updated' || type.startsWith('event.session.') || type.startsWith('event.workspace.') || type.startsWith('event.config.')) {
      for (const fn of this.globalListeners) targets.add(fn);
    }
    for (const fn of targets) fn(frame);
  }

  /**
   * 重放 cursor 之后的帧。cursor 比已挤出序列还旧 → 缓冲有缺口,
   * 返回 resync:true(客户端应重新拉 snapshot)。
   */
  replaySince(sessionId: string, cursor: number): { frames: Record<string, unknown>[]; resync: boolean } {
    if ((this.evictedSeq.get(sessionId) ?? -1) > cursor) return { frames: [], resync: true };
    const buf = this.replay.get(sessionId) ?? [];
    return { frames: buf.filter((f) => f.seq > cursor).map((f) => f.frame), resync: false };
  }

  /** 删除/归档会话后清残留态:队列、回放缓冲、缺口水位(不动进行中的 turn)。 */
  drop(sessionId: string): void {
    this.queued.delete(sessionId);
    this.replay.delete(sessionId);
    this.evictedSeq.delete(sessionId);
    this.listeners.delete(sessionId);
    this.v262Listeners.delete(sessionId);
    this.transcript.drop(sessionId);
  }
}

// ---------------------------------------------------------------------------
// 主服务
// ---------------------------------------------------------------------------

export async function startGateway(options: GatewayOptions = {}): Promise<{
  url: string;
  close: () => Promise<void>;
  web: { injectionEnabled: boolean; reason: string } | null;
}> {
  const port = options.port ?? 58629;
  const host = options.host ?? '127.0.0.1';
  const token = (options.token?.trim()) || randomBytes(24).toString('base64url');
  const settingsDir = options.settingsDir
    ?? process.env.GATEWAY_SETTINGS_DIR
    ?? path.join(os.homedir(), '.config', 'multi-agent-gateway');
  const uploadStore = createUploadStore(settingsDir);
  const workspaceStore = new SettingsStore(
    options.settingsDir || process.env.GATEWAY_SETTINGS_DIR
      ? path.join(settingsDir, 'workspaces.json')
      : undefined,
  );
  const grokRecycleGraceMs = process.env.GATEWAY_GROK_IDLE_TIMEOUT_MS !== undefined
    ? Number(process.env.GATEWAY_GROK_IDLE_TIMEOUT_MS)
    : 3 * 60_000;
  const codexRecycleGraceMs = process.env.GATEWAY_CODEX_IDLE_TIMEOUT_MS !== undefined
    ? Number(process.env.GATEWAY_CODEX_IDLE_TIMEOUT_MS)
    : undefined;
  const dshRecycleGraceMs = process.env.GATEWAY_DSH_IDLE_TIMEOUT_MS !== undefined
    ? Number(process.env.GATEWAY_DSH_IDLE_TIMEOUT_MS)
    : undefined;
  const adapters: Record<LocalProviderName, ProviderAdapter> = {
    codex: options.codex ?? new CodexProviderAdapter({
      settingsPath: path.join(settingsDir, 'session-settings.codex.json'),
      ...(codexRecycleGraceMs !== undefined && Number.isFinite(codexRecycleGraceMs) ? { recycleGraceMs: codexRecycleGraceMs } : {}),
    }),
    claude: options.claude ?? new ClaudeProviderAdapter({
      settingsPath: path.join(settingsDir, 'session-settings.claude.json'),
      claudeBin: process.env.CLAUDE_BIN,
    }),
    grok: options.grok ?? new GrokProviderAdapter({
      settingsPath: path.join(settingsDir, 'session-settings.grok.json'),
      grokBin: process.env.GROK_BIN,
      ...(Number.isFinite(grokRecycleGraceMs) ? { recycleGraceMs: grokRecycleGraceMs } : {}),
    }),
    pi: options.pi ?? (() => {
      const piRecycleGraceMs = process.env.GATEWAY_PI_IDLE_TIMEOUT_MS !== undefined
        ? Number(process.env.GATEWAY_PI_IDLE_TIMEOUT_MS)
        : undefined;
      const piMaxLiveProcesses = process.env.GATEWAY_PI_MAX_PROCESSES !== undefined
        ? Number(process.env.GATEWAY_PI_MAX_PROCESSES)
        : undefined;
      const piMaxSessionFileBytes = process.env.GATEWAY_PI_MAX_SESSION_BYTES !== undefined
        ? Number(process.env.GATEWAY_PI_MAX_SESSION_BYTES)
        : undefined;
      const piExtraArgs = process.env.GATEWAY_PI_EXTRA_ARGS
        ? process.env.GATEWAY_PI_EXTRA_ARGS.trim().split(/\s+/).filter(Boolean)
        : undefined;
      return new PiProviderAdapter({
        settingsPath: path.join(settingsDir, 'session-settings.pi.json'),
        piBin: process.env.PI_BIN,
        ...(piRecycleGraceMs !== undefined && Number.isFinite(piRecycleGraceMs) ? { recycleGraceMs: piRecycleGraceMs } : {}),
        ...(piMaxLiveProcesses !== undefined && Number.isFinite(piMaxLiveProcesses) ? { maxLiveProcesses: piMaxLiveProcesses } : {}),
        ...(piMaxSessionFileBytes !== undefined && Number.isFinite(piMaxSessionFileBytes) ? { maxSessionFileBytes: piMaxSessionFileBytes } : {}),
        ...(piExtraArgs && piExtraArgs.length > 0 ? { extraArgs: piExtraArgs } : {}),
      });
    })(),
    dsh: options.dsh ?? new DshProviderAdapter({
      settingsPath: path.join(settingsDir, 'session-settings.dsh.json'),
      dshBin: process.env.DSH_BIN,
      ...(dshRecycleGraceMs !== undefined && Number.isFinite(dshRecycleGraceMs) ? { recycleGraceMs: dshRecycleGraceMs } : {}),
    }),
  };
  const availableProviders = options.availableProviders ?? detectAvailableProviders();
  const hub = new SessionHub();
  const sessionPageCursors = new Map<string, string>();
  const manifestPathForVersion = options.manifestPath
    ?? (options.staticDir ? path.join(path.resolve(options.staticDir, '..'), 'web-origin-manifest.json') : undefined);
  const kimiCompatVersion = readManifestCompatVersion(manifestPathForVersion);

  // 解析 Kimi 上游:没有官方 `/web` 实例时才自起 fallback Core。
  // owned fallback 始终作为 standby 保留；当前 shell 执行 `/web` 后改接该
  // 官方实例，实例退出后再自动回切，旧 WS 隧道由浏览器重连。
  let kimi: KimiUpstream | null = null;
  let kimiFallback: KimiChild | null = null;
  let kimiHttp: ReturnType<typeof createKimiHttpProxy> | null = null;
  let kimiWs: ReturnType<typeof createKimiWsUpgrader> | null = null;
  const kimiOpt = options.kimi ?? 'spawn';
  const demoActive = demoEnabled(kimiOpt === 'off');
  if (kimiOpt === 'spawn') {
    const child = await spawnKimiServer();
    if (child.owned) {
      kimiFallback = child;
    } else if (process.env.GATEWAY_KIMI_STANDBY === '1' && !process.env.KIMI_UPSTREAM_URL && !process.env.KIMI_UPSTREAM_PORT && !process.env.KIMI_PORT) {
      kimiFallback = await spawnKimiServer({ reuseRegistered: false });
    } else {
      kimiFallback = null;
    }
    kimi = { url: child.url, token: child.token, child };
  } else if (kimiOpt !== 'off') {
    if (!kimiOpt.token) throw new Error('external kimi upstream requires a token');
    kimi = { url: kimiOpt.upstream, token: kimiOpt.token };
  }
  const updateKimiProxy = (): void => {
    const proxyOptions = kimi
      ? { upstream: kimi.url, upstreamToken: kimi.token, stripQueryParams: ['provider', 'token'] }
      : null;
    kimiHttp = proxyOptions ? createKimiHttpProxy(proxyOptions) : null;
    kimiWs = proxyOptions ? createKimiWsUpgrader(proxyOptions) : null;
  };
  updateKimiProxy();
  const kimiVersionCache = new Map<string, string>();
  const isKimiV25Upstream = async (): Promise<boolean> => {
    if (!kimi) return false;
    const directVersion = kimi.child?.version;
    if (directVersion) return isKimiV25Version(directVersion);
    const cached = kimiVersionCache.get(kimi.url);
    if (cached !== undefined) return isKimiV25Version(cached);
    try {
      const res = await fetch(`${kimi.url}${API}/meta`, {
        headers: { authorization: `Bearer ${kimi.token}` },
        signal: AbortSignal.timeout(1_000),
      });
      if (!res.ok) return false;
      const parsed = (await res.json()) as { data?: { server_version?: unknown } };
      const ver = typeof parsed?.data?.server_version === 'string' ? parsed.data.server_version : '';
      if (ver) {
        kimiVersionCache.set(kimi.url, ver);
        return isKimiV25Version(ver);
      }
    } catch {
      // ignore probe failure; keep lossless passthrough
    }
    return false;
  };
  const kimiSockets = new Set<Duplex>();
  const kimiNeedsFollow = (): boolean => Boolean(kimiFallback || (kimi && !kimi.child?.owned));
  let refreshKimiInflight: Promise<void> | null = null;
  const refreshKimi = (): Promise<void> => {
    if (kimiOpt !== 'spawn') return Promise.resolve();
    refreshKimiInflight ??= (async () => {
      let next: KimiChild | null = null;
      if (kimiFallback) {
        if (kimi && !kimi.child?.owned && await kimiAlive(kimi)) {
          return;
        }
        next = await followKimiServer(kimiFallback);
        if (next === kimiFallback && !(await kimiAlive(next))) {
          // 官方候选经 connectExisting 探活过;只有"无候选→沿用 standby"这条
          // 没探。standby 崩溃/被杀时旧实现永远卡在死人身上(kimi WS 502、
          // /auth 掉线、前端弹 WebSocket error),探死就重走 spawn:注册表有
          // 活实例则复用;没有、或注册表卡住(多实例/残留误报)则强制新起。
          try {
            next = await spawnKimiServer();
          } catch {
            next = await spawnKimiServer({ reuseRegistered: false });
          }
          if (next.owned) kimiFallback = next;
        }
      } else if (kimi) {
        if (!(await kimiAlive(kimi))) {
          try {
            next = await spawnKimiServer();
          } catch {
            next = await spawnKimiServer({ reuseRegistered: false });
          }
          if (next.owned) kimiFallback = next;
        }
      }
      if (!next) return;
      if (kimi?.url === next.url && kimi.token === next.token) return;
      kimi = { url: next.url, token: next.token, child: next };
      updateKimiProxy();
      for (const socket of kimiSockets) socket.destroy();
      const label = next.owned ? 'owned fallback' : 'official /web server';
      console.error(`[gateway] Kimi upstream switched to ${label} at ${next.url}`);
    })().finally(() => {
      refreshKimiInflight = null;
    });
    return refreshKimiInflight;
  };
  const kimiFollowTimer = kimiOpt === 'spawn'
    ? setInterval(() => { if (kimiNeedsFollow()) void refreshKimi().catch(() => undefined); }, 1_000)
    : null;
  kimiFollowTimer?.unref();

  // SPA 静态托管:校验官方 web-dist 资产后只在 index 响应内存中注入扩展。
  const staticDir = options.staticDir;
  let webShell: WebShell | null = null;
  if (staticDir) {
    const repoRoot = path.resolve(staticDir, '..');
    webShell = await loadWebShell({
      root: staticDir,
      extensionDir: options.extensionDir ?? path.join(repoRoot, 'web-extension'),
      manifestPath: options.manifestPath ?? path.join(repoRoot, 'web-origin-manifest.json'),
    });
  }
  const serveStatic = staticDir ? createStaticServer(staticDir, webShell ?? undefined) : null;

  // 直接向上游发 REST(聚合列表 / 建 Kimi 会话时用)。
  const kimiFetch = async (path: string, init?: RequestInit): Promise<unknown> => {
    await refreshKimi();
    if (!kimi) throw new ProviderError('unsupported', 'kimi provider is off', 400);
    const res = await fetch(`${kimi.url}${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${kimi.token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = (await res.json()) as { code?: number; msg?: string; data?: unknown };
    if (!res.ok || body.code !== 0) {
      throw new ProviderError('upstream_error', `kimi upstream ${path}: ${body.msg ?? res.status}`, res.ok ? 500 : res.status);
    }
    return body.data;
  };

  const server = createServer((req, res) => {
    void (async () => {
      // 鉴权先于一切路由和代理(含 /api/v1, /api/v2, /v1/remote):无凭证请求
      // 绝不能绕过直接进 proxyKimiHttp 换票直达上游。healthz 免鉴权;OPTIONS 放行给 CORS。
      const preAuthUrl = new URL(req.url ?? '/', 'http://localhost');
      if (
        req.method !== 'OPTIONS'
        && (isKimiApiPath(req.url) || preAuthUrl.pathname === `${API}/ws`)
        && preAuthUrl.pathname !== `${API}/healthz`
        && !authed(req, token)
      ) {
        fail(res, 401, 40101, 'Unauthorized', ulid());
        return;
      }
      // Kimi 会话(id 无前缀)的 REST → 无损代理到原版 kap-server;2.5.x 上游补齐 2.6.2 翻页。
      if (shouldProxyToKimi(req, (id) => uploadStore.has(id))) {
        await refreshKimi();
        if (req.method === 'GET' && kimi) {
          const reqUrl = new URL(req.url ?? '/', 'http://localhost');
          const turnsMatch = /^\/api\/v1\/sessions\/([^/:]+)\/agents\/([^/:]+)\/turns$/.exec(reqUrl.pathname);
          if (turnsMatch && await isKimiV25Upstream()) {
            const sessionId = decodeURIComponent(turnsMatch[1]);
            const agentId = decodeURIComponent(turnsMatch[2]);
            const beforeRaw = reqUrl.searchParams.get('before_ordinal');
            const beforeOrdinal = beforeRaw !== null && beforeRaw !== '' ? Number(beforeRaw) : undefined;
            const pageSize = Number(reqUrl.searchParams.get('page_size') ?? 20) || 20;
            const page = await fetchKimiV25Turns(kimi, sessionId, agentId, {
              beforeOrdinal: Number.isFinite(beforeOrdinal) ? beforeOrdinal : undefined,
              pageSize,
            });
            ok(res, page, ulid());
            return;
          }
        }
        if (kimiHttp) {
          const handled = await kimiHttp(req, res);
          if (handled) return;
        }
      }
      await route(req, res);
    })().catch((err: unknown) => {
      const requestId = ulid();
      console.error(
        `[gateway] request failed ${requestId} ${req.method} ${req.url}:`,
        err instanceof Error ? err.stack ?? err.message : err,
      );
      if (res.headersSent) return;
      if (err instanceof ProviderError) {
        fail(res, err.httpStatus, codeNumber(err.code), err.message, requestId);
      } else {
        fail(res, 500, 50001, err instanceof Error ? err.message : String(err), requestId);
      }
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = ulid();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'OPTIONS') {
      sendJson(res, 200, {});
      return;
    }

    // 非 API 路径 → SPA 静态托管;没配静态目录则 404。
    if (
      !url.pathname.startsWith(API)
      && url.pathname !== '/api/v2/sessions'
      && url.pathname !== '/api/v2/sessions:archive'
      && url.pathname !== '/api/v2/sessions:restore'
    ) {
      if (serveStatic && serveStatic(req, res)) return;
      fail(res, 404, 40400, 'not an api route', requestId);
      return;
    }

    // 鉴权:Bearer 或 WS 子协议 token。healthz 免鉴权。
    if (url.pathname !== `${API}/healthz` && !authed(req, token)) {
      fail(res, 401, 40101, 'Unauthorized', requestId);
      return;
    }

    const sub = url.pathname.startsWith(API) ? url.pathname.slice(API.length) : url.pathname;
    const providerParam = url.searchParams.get('provider');
    const provider: ProviderName | undefined = providerParam && isProviderName(providerParam) ? providerParam : undefined;

    if (url.pathname === '/api/v2/sessions' && req.method === 'GET') {
      const archivedParam = url.searchParams.get('meta.archived');
      const archivedAll = archivedParam === 'all';
      const archivedOnly = archivedParam === 'true';
      const view = url.searchParams.get('view');
      const pageParam = url.searchParams.get('page');
      const page = pageParam ? Math.max(1, Number(pageParam) || 1) : undefined;
      const fieldsParam = (url.searchParams.get('fields') ?? '').trim();
      const maxPageSize = fieldsParam ? 10_000 : 100;
      const pageSize = Math.min(
        maxPageSize,
        Math.max(1, Number(url.searchParams.get('page_size') ?? (view === 'by_workspace' ? 500 : 50)) || 50),
      );
      const filterWsIds = new Set(url.searchParams.getAll('workspace.id').filter(Boolean));
      const updatedAfter = parseV2TimestampBound(url.searchParams.get('meta.updated_after'));
      const updatedBefore = parseV2TimestampBound(url.searchParams.get('meta.updated_before'));
      const activityStatuses = new Set(url.searchParams.getAll('activity.status').filter(Boolean));
      const sortParam = url.searchParams.get('sort') ?? '';
      const hasV2Filters =
        filterWsIds.size > 0 ||
        updatedAfter !== undefined ||
        updatedBefore !== undefined ||
        activityStatuses.size > 0 ||
        Boolean(fieldsParam) ||
        Boolean(sortParam && sortParam !== 'meta.updated_at_desc');
      const isPageMode = page !== undefined;
      const fetchAll = view === 'by_workspace' || isPageMode || archivedAll || hasV2Filters;
      const pageToken = url.searchParams.get('page_token');

      let rawItems: Record<string, unknown>[];
      let upstreamHasMore = false;
      if (archivedAll) {
        const v1Open = new URL(url.href);
        v1Open.searchParams.set('page_size', '500');
        v1Open.searchParams.delete('archived_only');
        v1Open.searchParams.delete('before_id');
        const v1Archived = new URL(url.href);
        v1Archived.searchParams.set('page_size', '500');
        v1Archived.searchParams.set('archived_only', 'true');
        v1Archived.searchParams.delete('before_id');
        const [openData, archivedData] = await Promise.all([
          listSessions(adapters, kimiFetch, v1Open, provider, (sid) => hub.busy.has(sid), sessionPageCursors, demoActive, true, workspaceStore),
          listSessions(adapters, kimiFetch, v1Archived, provider, (sid) => hub.busy.has(sid), sessionPageCursors, demoActive, true, workspaceStore),
        ]);
        const byId = new Map<string, Record<string, unknown>>();
        for (const item of [...((openData.items ?? []) as Record<string, unknown>[]), ...((archivedData.items ?? []) as Record<string, unknown>[])]) {
          const sid = String(item.id ?? '');
          if (sid && !byId.has(sid)) byId.set(sid, item);
        }
        rawItems = [...byId.values()];
      } else {
        const v1 = new URL(url.href);
        // 侧栏 load 走 view=by_workspace 或分页/过滤模式走全量抓取后内存切片
        v1.searchParams.set('page_size', fetchAll ? '500' : String(pageSize));
        if (archivedOnly) v1.searchParams.set('archived_only', 'true');
        if (pageToken && !fetchAll) v1.searchParams.set('before_id', pageToken);
        const data = await listSessions(
          adapters,
          kimiFetch,
          v1,
          provider,
          (sid) => hub.busy.has(sid),
          sessionPageCursors,
          demoActive,
          fetchAll,
          workspaceStore,
        );
        rawItems = (data.items ?? []) as Record<string, unknown>[];
        upstreamHasMore = Boolean(data.has_more);
      }

      let allItems = rawItems.map((item) => sessionV2Dto(item, Boolean(item.busy)));
      if (filterWsIds.size > 0) {
        allItems = allItems.filter((it) => filterWsIds.has(String((it.workspace as { id?: string } | undefined)?.id ?? '')));
      }
      if (archivedParam === 'false') {
        allItems = allItems.filter((it) => (it.meta as { archived?: boolean } | undefined)?.archived !== true);
      }
      if (updatedAfter !== undefined) {
        allItems = allItems.filter((it) => Number((it.meta as { updated_at?: number } | undefined)?.updated_at ?? 0) >= updatedAfter);
      }
      if (updatedBefore !== undefined) {
        allItems = allItems.filter((it) => Number((it.meta as { updated_at?: number } | undefined)?.updated_at ?? 0) <= updatedBefore);
      }
      if (activityStatuses.size > 0) {
        allItems = allItems.filter((it) => activityStatuses.has(String((it.activity as { status?: string } | undefined)?.status ?? '')));
      }
      if (fetchAll) {
        const field = sortParam.startsWith('meta.created_at') ? 'created_at' : 'updated_at';
        const asc = sortParam.endsWith('_asc');
        allItems.sort((a, b) => {
          const av = Number((a.meta as Record<string, unknown> | undefined)?.[field] ?? 0);
          const bv = Number((b.meta as Record<string, unknown> | undefined)?.[field] ?? 0);
          return asc ? av - bv : bv - av;
        });
      }

      if (view === 'by_workspace') {
        const wsData = (await listWorkspaces(adapters, kimiFetch, provider, demoActive, workspaceStore).catch(() => null)) as
          | { items?: Record<string, unknown>[] }
          | null;
        if (wsData) {
          const validIds = new Set<string>();
          const validRoots = new Map<string, string>();
          const primaryRoots = new Map<string, string>();
          for (const w of wsData.items ?? []) {
            const wid = String(w.id ?? '');
            const wroot = typeof w.root === 'string' ? w.root : '';
            if (wid) validIds.add(wid);
            if (wroot) {
              const normRoot = normalizeWorkspaceRoot(wroot) || wroot;
              validRoots.set(normRoot, wid);
              primaryRoots.set(wid, wroot);
            }
            if (Array.isArray(w.additional_dirs)) {
              for (const d of w.additional_dirs) {
                if (typeof d === 'string' && d.trim()) {
                  const normD = normalizeWorkspaceRoot(d) || d;
                  validRoots.set(normD, wid);
                }
              }
            }
          }
          return ok(res, sessionGroupsV2(allItems, url, validIds, validRoots, primaryRoots), requestId);
        }
        return ok(res, sessionGroupsV2(allItems, url), requestId);
      }

      const total = allItems.length;
      let pagedItems = allItems;
      let hasMore = upstreamHasMore;
      if (isPageMode) {
        const start = (page - 1) * pageSize;
        pagedItems = allItems.slice(start, start + pageSize);
        hasMore = start + pageSize < total;
      } else if (fetchAll) {
        let start = 0;
        if (pageToken) {
          const idx = allItems.findIndex((it) => String(it.id) === pageToken);
          start = idx === -1 ? total : idx + 1;
        }
        pagedItems = allItems.slice(start, start + pageSize);
        hasMore = start + pageSize < total;
      }

      const outItems = fieldsParam ? pagedItems.map((it) => projectV2Fields(it, fieldsParam)) : pagedItems;
      return ok(res, {
        items: outItems,
        total,
        has_more: hasMore,
        next_page_token: hasMore ? String(pagedItems[pagedItems.length - 1]?.id ?? '') : null,
      }, requestId);
    }

    // 会话管理页批量归档/恢复。claude/codex/grok/pi 走本地 adapter;kimi 走上游。
    if (
      (url.pathname === '/api/v2/sessions:archive' || url.pathname === '/api/v2/sessions:restore')
      && req.method === 'POST'
    ) {
      const archived = url.pathname.endsWith(':archive');
      const body = (await readBody(req).catch(() => ({}))) as { ids?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
      if (ids.length === 0) throw new ProviderError('invalid_request', 'ids required', 400);
      const planned: Array<{ id: string; provider: LocalProviderName; nativeId: string }> = [];
      for (const id of ids) {
        const { provider: sp, nativeId } = providerFromSessionId(id);
        if (sp === 'kimi') {
          throw new ProviderError('unsupported', 'kimi bulk archive must go through upstream kap-server', 400);
        }
        if (!adapters[sp].setArchived) throw new ProviderError('unsupported', `${sp} 不支持归档`, 400);
        planned.push({ id, provider: sp, nativeId });
      }
      const succeeded: string[] = [];
      const failed: Array<{ id: string; reason: string }> = [];
      for (const item of planned) {
        try {
          await adapters[item.provider].setArchived!(item.nativeId, archived);
          if (archived && !hub.busy.has(item.id)) hub.drop(item.id);
          clearSessionPageCursors(sessionPageCursors, item.id);
          hub.broadcast(item.id, frame(item.id, hub, archived ? 'event.session.archived' : 'event.session.restored', { sessionId: item.id }));
          succeeded.push(item.id);
        } catch (err) {
          failed.push({ id: item.id, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      return ok(res, {
        ok: failed.length === 0,
        archived,
        count: succeeded.length,
        succeeded,
        failed,
      }, requestId);
    }

    // --- 元信息 ---
    if (sub === '/healthz') return ok(res, { ok: true }, requestId);
    if (sub === '/meta') {
      const upstream = (await kimiFetch?.('/meta').catch(() => null)) as Record<string, unknown> | null;
      const localInAvailable = LOCAL_PROVIDERS.filter((p) => availableProviders.includes(p));
      const targetProviders = localInAvailable.length > 0 ? localInAvailable : LOCAL_PROVIDERS;
      const providerCapabilities: Record<string, ProviderCapabilities> = {};
      for (const p of targetProviders) {
        if (adapters[p]) {
          providerCapabilities[p] = adapters[p].capabilities();
        }
      }

      const localCaps = isLocalProvider(provider) ? adapters[provider]?.capabilities() : undefined;
      const experimentalFlags = localCaps
        ? {
            ...((upstream?.experimental_flags as Record<string, unknown> | undefined) ?? {}),
            tower: localCaps.tower === true,
            swarm: localCaps.swarm === true,
            subagent_fork: false,
            notify_user: false,
            wait_for: false,
            'tool-select': false,
            plan: localCaps.planMode === true,
            goal: localCaps.goals === true,
          }
        : (upstream?.experimental_flags as Record<string, unknown> | undefined);

      return ok(res, {
        server_version: `multi-agent-gateway/0.1 (Kimi ${kimiCompatVersion} compatible)`,
        capabilities: { websocket: true, file_upload: true, fs_query: true, mcp: false, tasks: true, terminal: true },
        server_id: 'multi-agent-gateway',
        started_at: new Date(0).toISOString(),
        open_in_apps: [],
        dangerous_bypass_auth: false,
        backend: 'v2',
        ...(upstream ?? {}),
        providers: availableProviders,
        provider_capabilities: providerCapabilities,
        ...(experimentalFlags !== undefined ? { experimental_flags: experimentalFlags } : {}),
      }, requestId);
    }
    if (sub === '/auth') {
      // kimi 上游关闭时不能 502:前端靠 /auth ready 才能进主页。
      // 给出本地-only 登录态,不假装有 Kimi 账号。
      if (!kimi) {
        return ok(res, {
          ready: true,
          providers_count: availableProviders.length,
          default_model: null,
          managed_provider: null,
          local_only: true,
        }, requestId);
      }
      // 登录态永远以 Kimi 上游为准,即使 URL 带了 provider=claude/codex:
      // 这两家是本地 CLI provider,不在网关伪造各自的 ready——否则模型目录
      // 为空时会被前端误显示成"未登录"(实测复现)。
      // 但 kimi 上游本身挂了时,不能再假 ready:true 掩盖故障。
      try {
        const data = await kimiFetch('/auth') as Record<string, unknown>;
        return ok(res, data, requestId);
      } catch (err) {
        if (provider && provider !== 'kimi') {
          // Claude/Codex 选择器仍要能进主页;登录徽章只反映 Kimi。
          return ok(res, {
            ready: false,
            providers_count: 0,
            default_model: null,
            managed_provider: null,
            upstream_error: err instanceof Error ? err.message : String(err),
          }, requestId);
        }
        throw err instanceof ProviderError
          ? err
          : new ProviderError('upstream_error', err instanceof Error ? err.message : String(err), 502);
      }
    }

    // 非 Kimi provider 复用官方配置 UI，但配置只投影到当前 provider，
    // 不把 Claude/Codex 模型写进 Kimi 的 config.toml。
    if (sub === '/oauth/region' && req.method === 'GET') {
      // kap-server 用这个区分大陆/海外登录;kimi=off 时仍要 200,否则前端控制台 404。
      const region = process.env.GATEWAY_REGION === 'mainland-cn' ? 'mainland-cn' : 'global';
      return ok(res, { region }, requestId);
    }
    if (sub === '/config' && (req.method === 'GET' || req.method === 'POST')) {
      if (isLocalProvider(provider)) {
        const patch = req.method === 'POST'
          ? ((await readBody(req)) as Record<string, unknown>)
          : {};
        return ok(res, await providerConfigView(provider, adapters[provider], kimiFetch, patch), requestId);
      }
      if (!kimi) {
        const patch = req.method === 'POST'
          ? ((await readBody(req)) as Record<string, unknown>)
          : {};
        return ok(res, {
          providers: {},
          default_provider: null,
          default_model: null,
          models: [],
          local_only: true,
          ...patch,
        }, requestId);
      }
    }
    if (isLocalProvider(provider) && sub === '/providers' && req.method === 'GET') {
      return ok(res, { items: [await providerDto(provider, adapters[provider])] }, requestId);
    }
    const singleProviderMatch = /^\/providers\/([^/:]+)$/.exec(sub);
    if (singleProviderMatch && req.method === 'GET') {
      const p = decodeURIComponent(singleProviderMatch[1]);
      if (isLocalProvider(p)) {
        return ok(res, await providerDto(p, adapters[p]), requestId);
      }
      if (p === 'kimi' && !kimi) {
        return fail(res, 404, 40401, 'provider not found', requestId);
      }
    }
    if (isLocalProvider(provider) && isProviderRefreshRoute(sub) && req.method === 'POST') {
      try {
        await adapters[provider].listModels?.();
        return ok(res, { changed: [], unchanged: [provider], failed: [] }, requestId);
      } catch (error) {
        return ok(res, {
          changed: [],
          unchanged: [],
          failed: [{ provider, reason: error instanceof Error ? error.message : String(error) }],
        }, requestId);
      }
    }
    if (sub === '/models' && req.method === 'GET') {
      // claude/codex/grok/pi → 各自 adapter 的原生目录。失败必须如实报错(500),
      // 不能吞成空列表或演示目录——那会把"没装好/握手失败"显示成"有模型"。
      if (isLocalProvider(provider)) {
        const adapter = adapters[provider];
        const rawItems = adapter.listModels ? await adapter.listModels() : [];
        const items = rawItems.map((model) => wireModelDto(model));
        return ok(res, { items }, requestId);
      }
      if (!kimi) {
        return ok(res, { items: [] }, requestId);
      }
      const data = kimiFetch ? ((await kimiFetch('/models').catch(() => null)) as Record<string, unknown> | null) : null;
      return ok(res, data ?? { items: [] }, requestId);
    }
    // 新建会话草稿(还没有 session id)时的原生命令目录,按 ?provider= 分流。
    if (sub === '/commands' && req.method === 'GET') {
      if (!isLocalProvider(provider)) return ok(res, { items: [] }, requestId);
      const adapter = adapters[provider];
      const items = adapter.listCommands ? await adapter.listCommands(undefined) : [];
      return ok(res, { items }, requestId);
    }

    // --- 文件上传(存网关本地;提交 prompt 时按 provider 翻译成各家输入) ---
    if (sub === '/files' && req.method === 'POST') {
      const part = await readMultipart(req);
      if (!part) throw new ProviderError('invalid_request', 'expected multipart/form-data with a file field', 400);
      return ok(res, await uploadStore.store(part.filename, part.contentType, part.data), requestId);
    }
    const fileMatch = /^\/files\/([^/:]+)$/.exec(sub);
    if (fileMatch && req.method === 'GET') {
      const f = await uploadStore.read(decodeURIComponent(fileMatch[1]));
      if (!f) return fail(res, 404, 40401, 'file not found', requestId);
      res.writeHead(200, {
        'content-type': f.media_type,
        'content-length': String(f.data.byteLength),
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(f.data);
      return;
    }
    const mediaMatch = /^\/media\/([^/:]+)$/.exec(sub);
    if (mediaMatch && req.method === 'GET') {
      const f = await uploadStore.read(decodeURIComponent(mediaMatch[1]));
      if (!f) return fail(res, 404, 40401, 'media not found', requestId);
      res.writeHead(200, {
        'content-type': f.media_type,
        'content-length': String(f.data.byteLength),
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(f.data);
      return;
    }

    // --- 目录浏览(前端"添加本地项目"选目录;PRESUMED 端点,本网关实现) ---
    if (sub === '/fs:browse' && req.method === 'GET') {
      const rawTarget = url.searchParams.get('path');
      const target = path.resolve(rawTarget || os.homedir());
      const dirents = await fsp.readdir(target, { withFileTypes: true }).catch((err: unknown) => {
        throw new ProviderError('invalid_request', `cannot list ${target}: ${err instanceof Error ? err.message : String(err)}`, 400);
      });
      const entries = dirents
        .map((d) => ({ name: d.name, path: path.join(target, d.name), is_dir: d.isDirectory() }))
        .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name));
      const parent = path.dirname(target);
      return ok(res, { path: target, parent: parent === target ? null : parent, entries }, requestId);
    }
    if (sub === '/fs:home' && req.method === 'GET') {
      return ok(res, { home: os.homedir(), recent_roots: [] }, requestId);
    }

    const workspaceSkills = /^\/workspaces\/([^/:]+)\/skills$/.exec(sub);
    if (workspaceSkills && isLocalProvider(provider) && req.method === 'GET') {
      const wid = decodeURIComponent(workspaceSkills[1]);
      const all = await listWorkspaces(adapters, kimiFetch, provider, demoActive, workspaceStore).catch(() => ({ items: [] }));
      const wsItems = (all as { items?: Array<Record<string, unknown>> }).items ?? [];
      const hit = wsItems.find((w) => w.id === wid);
      const cwd = typeof hit?.root === 'string' && hit.root ? hit.root : undefined;
      return ok(res, { skills: await adapterSkills(adapters[provider], undefined, cwd) }, requestId);
    }

    // --- workspaces ---
    if (sub === '/workspaces/project-config-dirs' && req.method === 'GET' && (!kimi || isLocalProvider(provider))) {
      return ok(res, { additional_dirs: [] }, requestId);
    }
    const workspaceTrustMatch = /^\/workspaces\/([^/:]+)\/trust$/.exec(sub);
    if (workspaceTrustMatch && (req.method === 'GET' || req.method === 'POST') && (!kimi || isLocalProvider(provider))) {
      return ok(res, { trusted: true }, requestId);
    }
    const workspacePrimaryMatch = /^\/workspaces\/([^/:]+)\/primary$/.exec(sub);
    if (workspacePrimaryMatch && req.method === 'POST' && (!kimi || isLocalProvider(provider))) {
      const wid = decodeURIComponent(workspacePrimaryMatch[1]);
      const body = (await readBody(req).catch(() => ({}))) as { path?: string };
      const all = await listWorkspaces(adapters, kimiFetch, provider, demoActive, workspaceStore);
      const wsItems = (all as { items?: Array<Record<string, unknown>> }).items ?? [];
      const hit = wsItems.find((w) => w.id === wid);
      const root = typeof body.path === 'string' && body.path.trim()
        ? body.path.trim()
        : (typeof hit?.root === 'string' ? hit.root : '');
      const previousRoot = typeof hit?.root === 'string' ? hit.root : '';
      const rootNorm = normalizeWorkspaceRoot(root) || root;
      const keptDirs = new Map<string, string>();
      for (const dir of [
        ...(Array.isArray(hit?.additional_dirs) ? hit.additional_dirs : []),
        ...(previousRoot ? [previousRoot] : []),
      ]) {
        if (typeof dir !== 'string' || !dir.trim()) continue;
        const norm = normalizeWorkspaceRoot(dir) || dir;
        if (norm === rootNorm || keptDirs.has(norm)) continue;
        keptDirs.set(norm, dir);
      }
      const existingDirs = [...keptDirs.values()];
      const nextName = typeof hit?.name === 'string' ? hit.name : undefined;
      const dto: Record<string, unknown> = hit
        ? {
            ...hit,
            id: wid,
            root,
            additional_dirs: existingDirs,
            last_opened_at: new Date().toISOString(),
          }
        : {
            ...workspaceDto(root || os.homedir(), nextName, { kind: 'managed', additionalDirs: existingDirs }),
            id: wid,
            root,
          };
      if (isLocalProvider(provider) && root) {
        upsertStoredWorkspace(workspaceStore, provider, {
          id: wid,
          root,
          name: typeof dto.name === 'string' ? dto.name : undefined,
          kind: 'managed',
          additional_dirs: existingDirs,
          created_at: typeof dto.created_at === 'string' ? dto.created_at : undefined,
          last_opened_at: String(dto.last_opened_at),
        });
      }
      return ok(res, dto, requestId);
    }
    if (sub === '/workspaces' && req.method === 'GET') {
      return ok(res, await listWorkspaces(adapters, kimiFetch, provider, demoActive, workspaceStore), requestId);
    }
    if (sub === '/workspaces' && req.method === 'POST') {
      const body = (await readBody(req)) as { root?: unknown; name?: unknown; additional_dirs?: unknown };
      const root = typeof body.root === 'string' ? body.root.trim() : '';
      if (!root) {
        throw new ProviderError('invalid_request', 'workspace root is required', 400);
      }
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
      const additionalDirs = Array.isArray(body.additional_dirs)
        ? body.additional_dirs.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
        : [];
      const baseDto = workspaceDto(root, name, { kind: 'managed', additionalDirs });
      if (isLocalProvider(provider)) {
        const all = await listWorkspaces(adapters, kimiFetch, provider, demoActive, workspaceStore).catch(() => ({ items: [] }));
        const existing = ((all as { items?: Array<Record<string, unknown>> }).items ?? []).find((w) => w.id === baseDto.id);
        const createdAt = typeof existing?.created_at === 'string' ? existing.created_at : String(baseDto.created_at);
        const sessionCount = typeof existing?.session_count === 'number' ? existing.session_count : 0;
        const dto: Record<string, unknown> = {
          ...baseDto,
          created_at: createdAt,
          session_count: sessionCount,
        };
        upsertStoredWorkspace(workspaceStore, provider, {
          id: String(dto.id),
          root,
          name: String(dto.name),
          kind: 'managed',
          additional_dirs: additionalDirs,
          created_at: createdAt,
          last_opened_at: String(dto.last_opened_at),
        });
        return ok(res, dto, requestId);
      }
      return ok(res, baseDto, requestId);
    }
    const workspaceIdMatch = /^\/workspaces\/([^/:]+)$/.exec(sub);
    if (workspaceIdMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const wid = decodeURIComponent(workspaceIdMatch[1]);
      // Local ids are `wd_${slug}_${hash}` (no provider infix). Prefix-gated
      // no-ops never matched Claude/Codex/Grok workspaces from workspaceDto.
      if (isLocalProvider(provider)) {
        if (req.method === 'DELETE') {
          workspaceStore.delete(provider, wid);
          return ok(res, { deleted: wid }, requestId);
        }
        const body = (await readBody(req).catch(() => ({}))) as { name?: unknown; additional_dirs?: unknown };
        const all = await listWorkspaces(adapters, kimiFetch, provider, demoActive, workspaceStore);
        const wsItems = (all as { items?: Array<Record<string, unknown>> }).items ?? [];
        const hit = wsItems.find((w) => w.id === wid);
        const nextName = typeof body.name === 'string'
          ? body.name
          : (typeof hit?.name === 'string' ? hit.name : '');
        const nextDirs = Array.isArray(body.additional_dirs)
          ? body.additional_dirs.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
          : (Array.isArray(hit?.additional_dirs)
              ? hit.additional_dirs.filter((d): d is string => typeof d === 'string')
              : []);
        const now = new Date().toISOString();
        const dto = hit
          ? {
              ...hit,
              id: wid,
              name: nextName,
              additional_dirs: nextDirs,
              last_opened_at: now,
            }
          : {
              ...workspaceDto('', nextName || wid, { kind: 'managed', additionalDirs: nextDirs }),
              id: wid,
              root: '',
              name: nextName,
              additional_dirs: nextDirs,
              last_opened_at: now,
            };
        if (typeof hit?.root === 'string' && hit.root) {
          upsertStoredWorkspace(workspaceStore, provider, {
            id: wid,
            root: hit.root,
            name: nextName || String(hit.name ?? ''),
            kind: 'managed',
            additional_dirs: nextDirs,
            created_at: typeof hit.created_at === 'string' ? hit.created_at : now,
            last_opened_at: now,
          });
        }
        return ok(res, dto, requestId);
      }
    }
    if (sub === '/workspace/fs:list' && req.method === 'POST' && provider && provider !== 'kimi') {
      const body = (await readBody(req).catch(() => ({}))) as { workspace?: string; path?: string; depth?: number; include_git_status?: boolean };
      const all = await listWorkspaces(adapters, kimiFetch, provider, demoActive, workspaceStore);
      const wsItems = (all as { items?: Array<Record<string, unknown>> }).items ?? [];
      const hit = wsItems.find((w) => w.id === body.workspace);
      if (!hit || typeof hit.root !== 'string' || !hit.root) {
        return ok(res, { items: [], truncated: false }, requestId);
      }
      return ok(res, await fsList(hit.root, body), requestId);
    }
    if ((sub === '/workspace/fs:search' || sub === '/workspace/fs:suggest') && req.method === 'POST' && provider && provider !== 'kimi') {
      const body = (await readBody(req)) as { workspace?: string; query?: string; limit?: number };
      const all = await listWorkspaces(adapters, kimiFetch, provider, demoActive, workspaceStore);
      const wsItems = (all as { items?: Array<Record<string, unknown>> }).items ?? [];
      const hit = wsItems.find((w) => w.id === body.workspace);
      if (!hit || typeof hit.root !== 'string' || !hit.root) {
        return ok(res, { items: [], truncated: false }, requestId);
      }
      return ok(res, await fsSearch(hit.root, { query: body.query ?? '', limit: body.limit }), requestId);
    }
    if (sub === '/fs:suggest' && req.method === 'POST' && provider && provider !== 'kimi') {
      const body = (await readBody(req).catch(() => ({}))) as { roots?: unknown[]; query?: string; limit?: number };
      const roots = Array.isArray(body.roots) ? body.roots.filter((r): r is string => typeof r === 'string' && r.length > 0) : [];
      const all = await listWorkspaces(adapters, kimiFetch, provider, demoActive, workspaceStore);
      const wsItems = (all as { items?: Array<Record<string, unknown>> }).items ?? [];
      const allowedRoot = roots.find((r) => wsItems.some((w) => w.root === r));
      if (!allowedRoot) {
        return ok(res, { items: [], truncated: false }, requestId);
      }
      return ok(res, await fsSearch(allowedRoot, { query: body.query ?? '', limit: body.limit }), requestId);
    }

    // --- sessions ---
    if (sub === '/sessions' && req.method === 'GET') {
      return ok(res, await listSessions(adapters, kimiFetch, url, provider, (sid) => hub.busy.has(sid), sessionPageCursors, demoActive, false, workspaceStore), requestId);
    }
    if (sub === '/sessions' && req.method === 'POST') {
      if (!provider || provider === 'kimi') {
        throw new ProviderError('upstream_error', 'Kimi session creation must be handled by the transparent proxy', 500);
      }
      if (!isLocalProvider(provider)) {
        throw new ProviderError('unsupported', `${provider} is not wired in gateway yet`, 400);
      }
      return ok(res, await createLocalSession(adapters, await readBody(req), provider, workspaceStore), requestId);
    }

    const sessMatch = /^\/sessions\/([^/:]+)(.*)$/.exec(sub);
    if (sessMatch) {
      const [, rawId, tail] = sessMatch;
      const { provider: sp, nativeId } = providerFromSessionId(decodeURIComponent(rawId));

      if (sp === 'kimi') {
        if (!demoActive || !isDemoSession('kimi', nativeId)) {
          return fail(res, 404, 40401, kimi ? 'kimi session handled by proxy' : 'kimi session not found', requestId);
        }
      }
      const adapter = sp === 'kimi' ? kimiDemoAdapter() : adapters[sp];
      const caps = adapter.capabilities();

      if (tail === '' && req.method === 'GET') {
        return ok(res, sessionDto(await getSession(adapter, sp, nativeId, demoActive), adapter.getModel?.(nativeId), adapter.getUsage?.(nativeId), hub.busy.has(prefixedId(sp, nativeId))), requestId);
      }
      if (tail === '' && req.method === 'PATCH') {
        const body = (await readBody(req)) as Record<string, unknown>;
        return ok(res, await applySessionProfilePatch(adapter, sp, nativeId, caps, body, hub, demoActive), requestId);
      }
      if ((tail === '' && req.method === 'DELETE') || (tail === ':delete' && req.method === 'POST')) {
        if (caps.delete === false || !adapter.delete) throw new ProviderError('unsupported', `${sp} 不支持删除会话`, 400);
        await adapter.delete(nativeId);
        // 清掉 hub 里的残留态(队列/回放缓冲),避免删后重建同 id 会话串味。
        const sid = prefixedId(sp, nativeId);
        hub.drop(sid);
        clearSessionPageCursors(sessionPageCursors, sid);
        hub.broadcast(sid, frame(sid, hub, 'event.session.deleted', { sessionId: sid }));
        return ok(res, { deleted: true }, requestId);
      }
      if (tail === ':archive' && req.method === 'POST') {
        if (caps.archive === false || !adapter.setArchived) throw new ProviderError('unsupported', `${sp} 不支持归档`, 400);
        await adapter.setArchived(nativeId, true);
        const sid = prefixedId(sp, nativeId);
        if (!hub.busy.has(sid)) hub.drop(sid);
        clearSessionPageCursors(sessionPageCursors, sid);
        hub.broadcast(sid, frame(sid, hub, 'event.session.archived', { sessionId: sid }));
        return ok(res, { archived: true }, requestId);
      }
      if (tail === ':restore' && req.method === 'POST') {
        if (caps.archive === false || !adapter.setArchived) throw new ProviderError('unsupported', `${sp} 不支持恢复归档`, 400);
        await adapter.setArchived(nativeId, false);
        const sid = prefixedId(sp, nativeId);
        clearSessionPageCursors(sessionPageCursors, sid);
        hub.broadcast(sid, frame(sid, hub, 'event.session.restored', { sessionId: sid }));
        return ok(res, sessionDto(await getSession(adapter, sp, nativeId, demoActive), adapter.getModel?.(nativeId), adapter.getUsage?.(nativeId), hub.busy.has(sid)), requestId);
      }
      if (tail === ':reload' && req.method === 'POST') {
        const sid = prefixedId(sp, nativeId);
        (adapter as { clearCommandsCache?: () => void }).clearCommandsCache?.();
        const session = await getSession(adapter, sp, nativeId, demoActive);
        clearSessionPageCursors(sessionPageCursors, sid);
        hub.transcript.invalidateHistory(sid);
        const history = await tryHistoryWithDemo(adapter, sp, nativeId, demoActive);
        if (history !== null) {
          const page = sliceV262Turns(turnsFromHistory(history, hub.busy.get(sid)), undefined, 20);
          hub.broadcastV262(sid, { type: 'turns', session_id: sid, agent_id: 'main', turns: page.turns, has_more: page.has_more });
        }
        return ok(res, sessionDto(session, adapter.getModel?.(nativeId), adapter.getUsage?.(nativeId), hub.busy.has(sid)), requestId);
      }
      if (tail === ':btw' && req.method === 'POST') {
        // 0.37 侧边对话是 Kimi 原生能力;本地 provider 暂无等价通道。
        // 明确 400,避免前端把裸 404 当成路由错误。
        throw new ProviderError('unsupported', `${sp} 不支持侧边对话(:btw)`, 400);
      }
      if (tail === ':swarm' && req.method === 'POST') {
        throw new ProviderError('unsupported', `${sp} 不支持 Swarm`, 400);
      }
      if (tail === ':tower' && req.method === 'POST') {
        throw new ProviderError('unsupported', `${sp} 不支持 tower 模式(:tower)`, 400);
      }
      if (tail === ':undo' && req.method === 'POST') {
        // 撤销最近 count 轮。codex:thread/rollback;claude:stream-json 下无 /rewind;pi:不支持 undo。
        if (caps.rollback === false || !adapter.rollback) throw new ProviderError('unsupported', `${sp} 不支持撤销`, 400);
        const body = (await readBody(req).catch(() => ({}))) as {
          count?: number;
          turn_id?: string;
          agent_id?: string;
        };
        if (body.agent_id !== undefined && body.agent_id !== 'main') {
          throw new ProviderError('unsupported', '仅支持撤销主会话轮次', 400);
        }
        const sid = prefixedId(sp, nativeId);
        const beforeHistory = await tryHistoryWithDemo(adapter, sp, nativeId, demoActive);
        const beforeTurns = beforeHistory ? turnsFromHistory(beforeHistory) : [];

        let count: number;
        if (typeof body.count === 'number' && Number.isFinite(body.count)) {
          count = Math.max(1, Math.min(50, Math.trunc(body.count)));
        } else if (typeof body.turn_id === 'string' && body.turn_id) {
          const targetTurnId = body.turn_id;
          const idx = beforeTurns.findIndex((t) => {
            const tid = String(t.turn_id ?? '');
            if (tid === targetTurnId) return true;
            if (tid === `hist_${targetTurnId}` || `hist_${tid}` === targetTurnId) return true;
            if (Array.isArray(t.items)) {
              for (const it of t.items as Array<Record<string, unknown>>) {
                if (it?.id === targetTurnId || it?.turn_id === targetTurnId) return true;
                if (Array.isArray(it?.prompt_ids)) {
                  for (const pid of it.prompt_ids) {
                    if (typeof pid === 'string' && (pid === targetTurnId || `turn_${pid}` === targetTurnId)) {
                      return true;
                    }
                  }
                }
              }
            }
            return false;
          });
          if (idx >= 0) {
            count = Math.max(1, Math.min(50, beforeTurns.length - idx));
          } else {
            count = 1;
          }
        } else {
          count = 1;
        }

        await adapter.rollback(nativeId, count);
        hub.transcript.invalidateHistory(sid);
        const removedTurnIds = beforeTurns.slice(-count).map((t) => String(t.turn_id));
        if (removedTurnIds.length > 0) {
          hub.broadcastV262(sid, {
            type: 'turns.removed',
            session_id: sid,
            agent_id: 'main',
            turn_ids: removedTurnIds,
          });
        }
        return ok(res, { undone: true, count, removed_turn_ids: removedTurnIds }, requestId);
      }
      if (tail === ':compact' && req.method === 'POST') {
        const body = (await readBody(req).catch(() => ({}))) as { instruction?: string };
        const sid = prefixedId(sp, nativeId);
        if (hub.busy.has(sid)) throw new ProviderError('busy', 'session busy: 当前 turn 结束后再压缩', 409);
        if (caps.compact === false || (!adapter.compact && sp !== 'claude')) {
          throw new ProviderError('unsupported', `${sp} 不支持压缩`, 400);
        }
        hub.broadcast(sid, frame(sid, hub, 'compaction.started', { trigger: 'manual', ...(body.instruction ? { instruction: body.instruction } : {}) }));
        emitV262AgentState(hub, adapter, sp, nativeId, sid, 'idle', true);
        if (adapter.compact) {
          try {
            await adapter.compact(nativeId, body.instruction);
          } finally {
            emitV262AgentState(hub, adapter, sp, nativeId, sid, 'idle', false);
          }
          hub.transcript.invalidateHistory(sid);
          hub.broadcast(sid, frame(sid, hub, 'compaction.completed', { result: {} }));
          const refreshed = await tryHistoryWithDemo(adapter, sp, nativeId, demoActive);
          if (refreshed !== null) {
            const page = sliceV262Turns(turnsFromHistory(refreshed, hub.busy.get(sid)), undefined, 20);
            hub.broadcastV262(sid, { type: 'turns', session_id: sid, agent_id: 'main', turns: page.turns, has_more: page.has_more });
          }
          return ok(res, { compacted: true }, requestId);
        }
        const text = `/compact${body.instruction ? ` ${body.instruction}` : ''}`;
        const result = await driveTurn(adapter, sp, nativeId, text, () => adapter.startTurn({ sessionId: nativeId, input: text }), hub, randomUUID(), (reason) => {
          emitV262AgentState(hub, adapter, sp, nativeId, sid, 'idle', false);
          hub.broadcast(sid, frame(sid, hub, 'compaction.completed', { result: { reason } }));
        }, demoActive, uploadStore);
        return ok(res, result, requestId);
      }
      if (tail === ':fork' && req.method === 'POST') {
        if (caps.fork === false || !adapter.fork) throw new ProviderError('unsupported', `${sp} 不支持分叉`, 400);
        const body = (await readBody(req).catch(() => ({}))) as { title?: string; turn_index?: number };
        const forked = await adapter.fork(nativeId);
        if (typeof body.title === 'string' && body.title.trim()) {
          const newTitle = body.title.trim();
          if (adapter.rename) {
            await adapter.rename(forked.id, newTitle).catch(() => {});
          }
          forked.title = newTitle;
        }
        const sid = prefixedId(sp, forked.id);
        hub.broadcast(sid, frame(sid, hub, 'event.session.created', { session: sessionDto(forked, adapter.getModel?.(forked.id), adapter.getUsage?.(forked.id)) }));
        return ok(res, sessionDto(forked, adapter.getModel?.(forked.id), adapter.getUsage?.(forked.id)), requestId);
      }
      if (tail === ':clone' && req.method === 'POST') {
        if (caps.clone === false || !adapter.clone) throw new ProviderError('unsupported', `${sp} 不支持克隆`, 400);
        const cloned = await adapter.clone(nativeId);
        const sid = prefixedId(sp, cloned.id);
        hub.broadcast(sid, frame(sid, hub, 'event.session.created', { session: sessionDto(cloned, adapter.getModel?.(cloned.id), adapter.getUsage?.(cloned.id)) }));
        return ok(res, sessionDto(cloned, adapter.getModel?.(cloned.id), adapter.getUsage?.(cloned.id)), requestId);
      }
      if (tail === '/warnings' && req.method === 'GET') {
        // 前端每次打开会话自动拉;本地 provider 无警告机制,回空。
        return ok(res, { warnings: [] }, requestId);
      }
      if (tail === ':takeover' && req.method === 'POST') {
        throw new ProviderError('unsupported', `${sp} 不支持 takeover`, 400);
      }
      if (tail === '/rating' && req.method === 'POST') {
        const body = (await readBody(req).catch(() => ({}))) as { op?: string };
        if (body.op === 'evaluate') {
          return ok(res, { appearance: null }, requestId);
        }
        throw new ProviderError('unsupported', `${sp} 不支持评价反馈`, 400);
      }
      if (tail === '/file-history/content' && req.method === 'GET') {
        throw new ProviderError('unsupported', `${sp} 不支持读取历史文件内容`, 400);
      }
      const sessionMediaMatch = /^\/media\/([^/:]+)$/.exec(tail);
      if (sessionMediaMatch && req.method === 'GET') {
        const f = await uploadStore.read(decodeURIComponent(sessionMediaMatch[1]));
        if (!f) return fail(res, 404, 40401, 'media not found', requestId);
        res.writeHead(200, {
          'content-type': f.media_type,
          'content-length': String(f.data.byteLength),
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        });
        res.end(f.data);
        return;
      }
      if (tail === '/file-history/changes' && req.method === 'GET') {
        return ok(res, { recorded: false, changes: [] }, requestId);
      }
      if (tail === '/children' && req.method === 'GET') {
        // 前端目前无调用(client 层未接线);如实回空页。
        return ok(res, { items: [], has_more: false }, requestId);
      }
      if (tail === '/children' && req.method === 'POST') {
        throw new ProviderError('unsupported', `${sp} 不支持子会话(codex 子线程只能 agent 内部 spawn)`, 400);
      }
      if (tail === '/skills' && req.method === 'GET') {
        if (sp === 'kimi') return ok(res, { skills: [] }, requestId);
        return ok(res, { skills: await adapterSkills(adapter, nativeId) }, requestId);
      }
      const skillActivate = /^\/skills\/(.+):activate$/.exec(tail);
      if (skillActivate && req.method === 'POST') {
        // 激活 = 把 "/skill名 参数" 作为 prompt 发出:claude/pi CLI 原生执行;
        // codex/grok 由 adapter 在 startTurn 里展开 SKILL.md 正文;同时透传附件。
        // Kimi 2.6.2 前端会带入 [name](kimi-code://skill/name) 芯片标记，先剥离避免误当参数。
        const body = (await readBody(req).catch(() => ({}))) as {
          args?: string;
          path?: string;
          prompt_id?: string;
          attachments?: Array<Record<string, unknown>>;
          metadata?: { display_text?: unknown };
        };
        const name = decodeURIComponent(skillActivate[1]);
        const bareSkillName = name.startsWith('skill:') ? name.slice(6) : name;
        const metadataText = typeof body.metadata?.display_text === 'string'
          ? sanitizePromptSkillChips(body.metadata.display_text)
          : '';
        const hasBodyArgs = typeof body.args === 'string' && body.args.trim().length > 0;
        const rawArgs = hasBodyArgs && body.args!.trim() !== `/${name}`
          ? body.args!
          : metadataText;
        let cleanArgs = sanitizeSkillActivateArgs(name, rawArgs)
          .replace(new RegExp(`^/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '')
          .trim();
        if (!hasBodyArgs && cleanArgs) {
          const nameEsc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const bareEsc = bareSkillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const chipPrefix = new RegExp(`^(?:${nameEsc}|${bareEsc})(?:\\s+([\\s\\S]*))?$`, 'i').exec(cleanArgs);
          if (chipPrefix) {
            cleanArgs = (chipPrefix[1] ?? '').trim();
          }
        }
        const effort = nativeEffortFromCommand(name, cleanArgs);
        if (effort && adapter.setThinking) await adapter.setThinking(nativeId, effort);

        let commandPrefix = `/${name}`;
        if (sp === 'pi') {
          const [skills, commands] = await Promise.all([
            adapter.listSkills ? adapter.listSkills(nativeId).catch(() => []) : Promise.resolve([]),
            adapter.listCommands ? adapter.listCommands(nativeId).catch(() => []) : Promise.resolve([]),
          ]);
          const matchingSkill = skills.find((s) => s && (s.name === name || s.name === `skill:${bareSkillName}`));
          const nonSkillCmd = commands.find(
            (c) => c && (c.name === name || c.name === bareSkillName) && c.source && c.source !== 'skill',
          );
          const requestedSkillByPath = typeof body.path === 'string' && body.path.length > 0 && matchingSkill?.path === body.path;
          if (matchingSkill && (requestedSkillByPath || !nonSkillCmd)) {
            commandPrefix = `/skill:${bareSkillName}`;
          }
        }

        let text = `${commandPrefix}${cleanArgs ? ` ${cleanArgs}` : ''}`;
        if (sp === 'dsh') {
          if (dshGatewayCommandNames().has(bareSkillName) || dshGatewayCommandNames().has(name)) {
            text = `/${bareSkillName}${cleanArgs ? ` ${cleanArgs}` : ''}`;
          } else {
            const skills = await adapterSkills(adapter, nativeId).catch(() => []);
            const matchingSkill = skills.find((s) => s && (s.name === name || s.name === bareSkillName || s.name === `skill:${bareSkillName}`));
            if (!matchingSkill || typeof matchingSkill.path !== 'string' || !matchingSkill.path) {
              throw new ProviderError('invalid_request', `dsh 技能 ${name} 不存在`, 400);
            }
            const promptToExpand = `/${bareSkillName}${cleanArgs ? ` ${cleanArgs}` : ''}`;
            const expanded = typeof expandDshSkill === 'function'
              ? expandDshSkill(promptToExpand, [{ name: bareSkillName, path: matchingSkill.path }])
              : null;
            if (!expanded) {
              throw new ProviderError('unsupported', `dsh 技能 ${name} 无法展开`, 400);
            }
            text = expanded;
          }
        }
        const content: Array<Record<string, unknown>> = [{ type: 'text', text }];
        if (Array.isArray(body.attachments)) {
          for (const att of body.attachments) {
            if (att && typeof att === 'object') content.push(att);
          }
        }
        await submitPrompt(adapter, sp, nativeId, { prompt_id: body.prompt_id, content }, hub, demoActive, uploadStore);
        return ok(res, { activated: true, skill_name: name }, requestId);
      }
      // --- fs:*(文件树/@提及/搜索/git 状态;网关本机实现,cwd 沙箱防穿越) ---
      if (tail.startsWith('/fs:') || /^\/fs\/.*:download$/.test(tail)) {
        const session = await getSession(adapter, sp, nativeId, demoActive);
        const cwd = session.metadata?.cwd;
        if (!cwd) throw new ProviderError('invalid_request', '会话没有工作目录', 400);
        if (tail === '/fs:list' && req.method === 'POST') {
          const body = (await readBody(req).catch(() => ({}))) as { path?: string; depth?: number; include_git_status?: boolean };
          return ok(res, await fsList(cwd, body), requestId);
        }
        if (tail === '/fs:read' && req.method === 'POST') {
          const body = (await readBody(req)) as { path: string; offset?: number; length?: number };
          return ok(res, await fsRead(cwd, body), requestId);
        }
        if (tail === '/fs:search' && req.method === 'POST') {
          const body = (await readBody(req)) as { query: string; limit?: number };
          return ok(res, await fsSearch(cwd, body), requestId);
        }
        if (tail === '/fs:grep' && req.method === 'POST') {
          const body = (await readBody(req)) as { pattern: string; regex?: boolean; case_sensitive?: boolean };
          return ok(res, await fsGrep(cwd, body), requestId);
        }
        if (tail === '/fs:git_status' && req.method === 'POST') {
          const body = (await readBody(req).catch(() => ({}))) as { paths?: string[] };
          return ok(res, await fsGitStatus(cwd, body.paths), requestId);
        }
        if (tail === '/fs:git_status:batch' && req.method === 'POST') {
          const body = (await readBody(req).catch(() => ({}))) as { roots?: unknown[] };
          const roots = Array.isArray(body.roots)
            ? body.roots.filter((r): r is string => typeof r === 'string' && r.length > 0)
            : [];
          const targets = roots.length > 0 ? roots : [cwd];
          const results: Record<string, unknown> = {};
          const errors: Record<string, { code: number; message: string }> = {};
          const realCwd = await fsp.realpath(cwd).catch(() => path.resolve(cwd));
          const realPrefix = realCwd === '/' ? '/' : `${realCwd}${path.sep}`;
          for (const rawRoot of targets) {
            const realRoot = await fsp.realpath(rawRoot).catch(() => null);
            if (!realRoot) {
              errors[rawRoot] = { code: 40401, message: 'directory not found' };
              continue;
            }
            if (realRoot !== realCwd && !realRoot.startsWith(realPrefix)) {
              errors[rawRoot] = { code: 40301, message: 'root outside session cwd' };
              continue;
            }
            const stat = await fsp.stat(realRoot).catch(() => null);
            if (!stat || !stat.isDirectory()) {
              errors[rawRoot] = { code: 40401, message: 'directory not found' };
              continue;
            }
            results[rawRoot] = await fsGitStatus(realRoot);
          }
          return ok(res, { results, errors }, requestId);
        }
        if (tail === '/fs:pull_request' && req.method === 'POST') {
          throw new ProviderError('unsupported', `${sp} 不支持 pull_request 查询`, 400);
        }
        if (tail === '/fs:pull_request:batch' && req.method === 'POST') {
          return ok(res, { results: {}, errors: {} }, requestId);
        }
        if (tail === '/fs:diff' && req.method === 'POST') {
          const body = (await readBody(req)) as { path: string };
          return ok(res, await fsDiff(cwd, body), requestId);
        }
        // fs:open/fs:reveal/fs:open-in/fs download 前端是死代码入口,如实 400。
        throw new ProviderError('unsupported', `${tail} 未实现(打开/下载在纯 web 端无意义)`, 400);
      }
      if (tail === '/goal' && req.method === 'GET') {
        if (caps.goals === false || !adapter.getGoal) throw new ProviderError('unsupported', `${sp} 不支持 goal`, 400);
        return ok(res, localGoalToWire(await adapter.getGoal(nativeId), nativeId), requestId);
      }
      if (tail === '/goal' && req.method === 'PATCH') {
        if (caps.goals === false || !adapter.setGoal) throw new ProviderError('unsupported', `${sp} 不支持 goal`, 400);
        const body = (await readBody(req).catch(() => ({}))) as { objective?: string };
        const objective = typeof body.objective === 'string' ? body.objective : '';
        const updated = await adapter.setGoal(nativeId, objective);
        return ok(res, localGoalToWire(updated, nativeId), requestId);
      }
      if (tail === '/export' && req.method === 'POST') {
        const session = await getSession(adapter, sp, nativeId, demoActive);
        const history = await historyWithDemo(adapter, sp, nativeId, demoActive);
        const zip = buildStoreZip([
          { name: 'transcript.md', data: Buffer.from(transcriptMarkdown(session, history, sp), 'utf8') },
        ]);
        const fileName = `${sp}-${session.title.replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || nativeId.slice(0, 8)}.zip`;
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': String(zip.byteLength),
          // 前端 client.ts 只解 RFC 5987 的 filename*;中文名必须走这个格式。
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'access-control-allow-origin': '*',
        });
        res.end(zip);
        return;
      }
      if (tail === '/profile' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>;
        return ok(res, await applySessionProfilePatch(adapter, sp, nativeId, caps, body, hub, demoActive), requestId);
      }
      if (tail === '/status' && req.method === 'GET') {
        const usage = adapter.getUsage?.(nativeId);
        let contextLimit = usage?.context_limit ?? 0;
        const model = adapter.getModel?.(nativeId) ?? getDemoModel(sp, nativeId) ?? '';
        if (contextLimit <= 0 && sp === 'claude') {
          if (model) contextLimit = claudeContextWindow(model);
        }
        if (contextLimit <= 0 && sp === 'grok') {
          contextLimit = grokStatusContextFallback();
        }
        if (contextLimit <= 0 && sp === 'dsh') {
          contextLimit = dshStatusContextFallback();
        }
        const contextUnavailable = usage?.context_unavailable === true;
        const extUi = (adapter as { getExtensionUiState?: (id: string) => unknown }).getExtensionUiState?.(nativeId);
        return ok(res, {
          model,
          thinking_level: adapter.getThinking?.(nativeId) ?? '',
          permission: adapter.getPermission?.(nativeId) ?? 'default',
          plan_mode: caps.planMode === false ? false : (adapter.getPlanMode?.(nativeId) ?? false),
          swarm_mode: false,
          tower_mode: false,
          context_tokens: contextUnavailable ? 0 : (usage?.context_tokens ?? 0),
          max_context_tokens: contextLimit,
          context_usage:
            !contextUnavailable && usage && contextLimit > 0
              ? Math.min(1, usage.context_tokens / contextLimit)
              : 0,
          ...(contextUnavailable ? { context_unavailable: true } : {}),
          ...(extUi ? { extension_ui: extUi } : {}),
        }, requestId);
      }
      if (tail === '/commands' && req.method === 'GET') {
        const items = adapter.listCommands ? await adapter.listCommands(nativeId) : [];
        return ok(res, { items }, requestId);
      }
      if (tail === '/messages' && req.method === 'GET') {
        return ok(res, await listAdapterMessages(adapter, sp, nativeId, url, demoActive), requestId);
      }
      const turnsMatch = /^\/agents\/([^/:]+)\/turns$/.exec(tail);
      if (turnsMatch && req.method === 'GET') {
        const agentId = decodeURIComponent(turnsMatch[1]);
        const sid = prefixedId(sp, nativeId);
        const beforeRaw = url.searchParams.get('before_ordinal');
        const beforeOrdinal = beforeRaw !== null && beforeRaw !== '' ? Number(beforeRaw) : undefined;
        const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size') ?? 20) || 20));
        if (agentId !== 'main') {
          const subHistory = adapter.getSubagentMessages
            ? await adapter.getSubagentMessages(nativeId, agentId).catch(() => [])
            : [];
          const subTurns = turnsFromHistory(subHistory);
          return ok(res, sliceV262Turns(subTurns, Number.isFinite(beforeOrdinal) ? beforeOrdinal : undefined, pageSize), requestId);
        }
        const history = await tryHistoryWithDemo(adapter, sp, nativeId, demoActive);
        const allTurns = turnsFromHistory(history ?? [], hub.busy.get(sid));
        return ok(res, sliceV262Turns(allTurns, Number.isFinite(beforeOrdinal) ? beforeOrdinal : undefined, pageSize), requestId);
      }
      if (tail === '/transcript' && req.method === 'GET') {
        const agentId = url.searchParams.get('agent_id');
        if (!agentId) throw new ProviderError('invalid_request', 'agent_id is required', 400);
        const pageSize = Number(url.searchParams.get('page_size') ?? 20);
        const sid = prefixedId(sp, nativeId);
        let history: Message[] | null = null;
        if (agentId === 'main') {
          history = await tryHistoryWithDemo(adapter, sp, nativeId, demoActive);
          // 失败时不观察(见 driveTurn 同理注释),页面用空历史+ live turn 降级呈现。
          if (history !== null && history.length > 0) {
            const active = hub.busy.get(sid);
            const historyPrior = active ? filterHistoryPriorToActive(history, active) : history;
            hub.transcript.observeHistory(sid, historyPrior);
          }
        } else if (adapter.getSubagentMessages) {
          history = await adapter.getSubagentMessages(nativeId, agentId).catch(() => []);
        } else {
          history = [];
        }
        const active = hub.busy.get(sid);
        const historyForPage = active && history ? filterHistoryPriorToActive(history, active) : (history ?? []);
        return ok(res, buildLocalTranscriptPage(historyForPage, {
          agentId,
          beforeTurn: url.searchParams.get('before_turn') ?? undefined,
          afterTurn: url.searchParams.get('after_turn') ?? undefined,
          pageSize,
        }, hub.busy.has(sid) ? 'turn' : 'idle', hub.transcript.currentSeq(sid), hub.transcript.activeItems(sid), hub.transcript.currentInteractions(sid), hub.transcript.currentPrompts(sid)), requestId);
      }
      if (tail === '/transcript/ops' && req.method === 'GET') {
        const agentId = url.searchParams.get('agent_id');
        const since = Number(url.searchParams.get('since_seq'));
        if (!agentId || !Number.isInteger(since) || since < 0) {
          throw new ProviderError('invalid_request', 'agent_id and non-negative since_seq are required', 400);
        }
        const catchup = hub.transcript.getOpsSince(prefixedId(sp, nativeId), since);
        return ok(res, {
          agent_id: agentId,
          batches: catchup.batches,
          latest_seq: catchup.latestSeq,
          complete: catchup.complete,
        }, requestId);
      }
      if (tail === '/transcript/plan' && req.method === 'GET') {
        return ok(res, {
          agent_id: url.searchParams.get('agent_id') ?? 'main',
          plans: [],
        }, requestId);
      }
      if (tail === '/snapshot' && req.method === 'GET') {
        return ok(res, await snapshot(adapter, sp, nativeId, hub, demoActive), requestId);
      }
      if (tail === '/prompts' && req.method === 'GET') {
        return ok(res, listPrompts(prefixedId(sp, nativeId), hub), requestId);
      }
      if ((tail === '/prompts' || tail === '/steer') && req.method === 'POST') {
        const body = (await readBody(req)) as {
          prompt_id?: string;
          content: { type: string; text?: string }[];
          model?: string; thinking?: string; permission_mode?: string; plan_mode?: boolean;
          swarm_mode?: boolean;
          tower_mode?: boolean;
          goal_objective?: string;
          goal_control?: 'pause' | 'resume' | 'cancel';
        };
        if (body.swarm_mode === true) {
          throw new ProviderError('unsupported', `${sp} 不支持 swarm_mode`, 400);
        }
        if (body.tower_mode === true) {
          throw new ProviderError('unsupported', `${sp} 不支持 tower_mode`, 400);
        }
        if (body.permission_mode === 'manual' && (caps.manualApproval === false || caps.approvals === false)) {
          throw new ProviderError('unsupported', `${sp} 不支持 manual 审批模式`, 400);
        }
        if (body.plan_mode === true && (caps.planMode === false || !adapter.setPlanMode)) {
          throw new ProviderError('unsupported', `${sp} 不支持 plan_mode`, 400);
        }
        if (typeof body.goal_objective === 'string') {
          if (caps.goals === false || !adapter.setGoal) throw new ProviderError('unsupported', `${sp} 不支持 goal`, 400);
          await adapter.setGoal(nativeId, body.goal_objective);
        }
        if (typeof body.goal_control === 'string') {
          if (caps.goals === false || !adapter.controlGoal) throw new ProviderError('unsupported', `${sp} 不支持 goal`, 400);
          await adapter.controlGoal(nativeId, body.goal_control);
        }
        if (body.model && adapter.setModel && adapter.getModel?.(nativeId) !== body.model) {
          await adapter.setModel(nativeId, body.model);
        }
        if (body.thinking && adapter.setThinking && adapter.getThinking?.(nativeId) !== body.thinking) {
          await adapter.setThinking(nativeId, body.thinking);
        }
        if (body.permission_mode && adapter.setPermission && adapter.getPermission?.(nativeId) !== body.permission_mode) {
          await adapter.setPermission(nativeId, body.permission_mode);
        }
        if (typeof body.plan_mode === 'boolean' && caps.planMode !== false && adapter.setPlanMode && adapter.getPlanMode?.(nativeId) !== body.plan_mode) {
          await adapter.setPlanMode(nativeId, body.plan_mode);
        }
        if (tail === '/steer' && hub.busy.has(prefixedId(sp, nativeId))) {
          return ok(res, await steerDirectPrompt(adapter, sp, nativeId, body, hub, uploadStore), requestId);
        }
        return ok(res, await submitPrompt(adapter, sp, nativeId, body, hub, demoActive, uploadStore), requestId);
      }
      if (tail === ':abort' && req.method === 'POST') {
        const aborted = await abortTurn(adapter, sp, nativeId, hub, demoActive, uploadStore);
        return ok(res, { aborted }, requestId);
      }
      const promptAbort = /^\/prompts\/([^/:]+):abort$/.exec(tail);
      if (promptAbort && req.method === 'POST') {
        const pid = decodeURIComponent(promptAbort[1]);
        const sid = prefixedId(sp, nativeId);
        const queue = hub.queued.get(sid);
        const qIdx = queue?.findIndex((q) => q.promptId === pid) ?? -1;
        if (queue && qIdx >= 0) {
          queue.splice(qIdx, 1);
          if (queue.length === 0) hub.queued.delete(sid);
          hub.transcript.finishPrompt(sid, pid, 'aborted');
          hub.broadcast(sid, frame(sid, hub, 'prompt.aborted', { promptId: pid, abortedAt: new Date().toISOString() }));
          return ok(res, { aborted: true }, requestId);
        }
        const active = hub.busy.get(sid);
        if (active && active.promptId !== pid) {
          return ok(res, { aborted: false }, requestId);
        }
        const aborted = await abortTurn(adapter, sp, nativeId, hub, demoActive, uploadStore);
        return ok(res, { aborted }, requestId);
      }
      const interactionResolve = /^\/interactions\/([^/:]+)$/.exec(tail);
      if (interactionResolve && req.method === 'POST') {
        const iid = decodeURIComponent(interactionResolve[1]);
        const sid = prefixedId(sp, nativeId);
        const active = hub.busy.get(sid);
        const body = (await readBody(req)) as Record<string, unknown> & {
          kind?: string;
          decision?: string;
          scope?: string;
          answers?: Record<string, unknown>;
          text?: string;
          dismissed?: boolean;
        };
        const isQuestion = body.kind === 'question' || (!body.kind && active?.pendingQuestions.has(iid));
        if (isQuestion) {
          if (caps.questions === false) {
            throw new ProviderError('unsupported', `${sp} 不支持交互提问`, 400);
          }
          if (body.dismissed === true) {
            await dismissQuestion(adapter, sp, nativeId, iid, hub);
            return ok(res, { outcome: 'dismissed', ended_at: new Date().toISOString() }, requestId);
          }
          await resolveQuestion(adapter, sp, nativeId, iid, body, hub);
          return ok(res, { outcome: 'answered', ended_at: new Date().toISOString() }, requestId);
        }
        if (caps.approvals === false) {
          throw new ProviderError('unsupported', `${sp} 不支持交互审批`, 400);
        }
        await resolveApproval(adapter, sp, nativeId, iid, body as { decision: string; scope?: string }, hub);
        return ok(res, { outcome: body.decision === 'approved' ? 'approved' : 'rejected', ended_at: new Date().toISOString() }, requestId);
      }
      if (tail === '/approvals' && req.method === 'GET') {
        return ok(res, { items: pendingApprovals(prefixedId(sp, nativeId), hub) }, requestId);
      }
      const approvalResolve = /^\/approvals\/([^/:]+)$/.exec(tail);
      if (approvalResolve && req.method === 'POST') {
        if (caps.approvals === false) {
          throw new ProviderError('unsupported', `${sp} 不支持交互审批`, 400);
        }
        const body = (await readBody(req)) as Record<string, unknown> & { decision: string; scope?: string };
        await resolveApproval(adapter, sp, nativeId, decodeURIComponent(approvalResolve[1]), body, hub);
        return ok(res, { resolved: true, resolved_at: new Date().toISOString() }, requestId);
      }
      if (tail === '/questions' && req.method === 'GET') {
        return ok(res, { items: pendingQuestions(prefixedId(sp, nativeId), hub) }, requestId);
      }
      const questionResolve = /^\/questions\/([^/:]+)$/.exec(tail);
      if (questionResolve && req.method === 'POST') {
        if (caps.questions === false) {
          throw new ProviderError('unsupported', `${sp} 不支持交互提问`, 400);
        }
        const body = (await readBody(req)) as { answers?: Record<string, unknown>; text?: string };
        await resolveQuestion(adapter, sp, nativeId, decodeURIComponent(questionResolve[1]), body, hub);
        return ok(res, { resolved: true, resolved_at: new Date().toISOString() }, requestId);
      }
      const questionDismiss = /^\/questions\/([^/:]+):dismiss$/.exec(tail);
      if (questionDismiss && req.method === 'POST') {
        if (caps.questions === false) {
          throw new ProviderError('unsupported', `${sp} 不支持交互提问`, 400);
        }
        await dismissQuestion(adapter, sp, nativeId, decodeURIComponent(questionDismiss[1]), hub);
        return ok(res, { dismissed: true, dismissed_at: new Date().toISOString() }, requestId);
      }
      if (tail === '/prompts:steer' && req.method === 'POST') {
        const body = (await readBody(req)) as { prompt_ids?: string[] };
        const ids = body.prompt_ids ?? [];
        const sid = prefixedId(sp, nativeId);
        const active = hub.busy.get(sid);
        if (!active || !active.turnId) {
          throw new ProviderError('not_found', 'PROMPT_NOT_FOUND: no active turn to steer into', 404);
        }
        if (caps.steer === false || !adapter.steer) {
          throw new ProviderError('unsupported', `${sp} 不支持 steer(排队消息将在本轮结束后自动发出)`, 400);
        }
        const queue = hub.queued.get(sid) ?? [];
        const steered: string[] = [];
        const steeredContent: Array<Record<string, unknown>> = [];
        for (const id of ids) {
          const idx = queue.findIndex((q) => q.promptId === id);
          if (idx === -1) continue;
          const q = queue[idx];
          const attachments = q.attachments ?? [];
          let steerText = q.text;
          if (attachments.length > 0 && caps.steerAttachments !== true) {
            const notes = attachments
              .map((a) => a.path
                ? `[attached ${a.kind === 'localImage' ? 'image' : 'file'}: ${a.path}]`
                : `[attached ${a.kind}]`)
              .join('\n');
            steerText = steerText ? `${steerText}\n${notes}` : notes;
          }
          if (caps.steerAttachments === true && attachments.length > 0) {
            await adapter.steer(nativeId, active.turnId, steerText, attachments);
          } else {
            await adapter.steer(nativeId, active.turnId, steerText);
          }
          queue.splice(idx, 1);
          steered.push(id);
          const msgContent = queuedContentBlocks(q.text, attachments);
          steeredContent.push(...msgContent);
          emitV262SteerUserItem(hub, sid, active, id, q.text, attachments);
          // 用户消息回显:前端靠 messageCreated(prompt_id 匹配)落乐观气泡。
          hub.broadcast(sid, frame(sid, hub, 'event.message.created', {
            message: {
              id: randomUUID(), session_id: sid, role: 'user', prompt_id: id,
              content: msgContent, created_at: new Date().toISOString(),
            },
          }));
        }
        if (steered.length > 0) hub.transcript.steerPrompts(sid, active.promptId, steered, steeredContent);
        if (queue.length === 0) hub.queued.delete(sid);
        return ok(res, { steered: steered.length > 0, prompt_ids: steered }, requestId);
      }
      if (tail === '/tasks' && req.method === 'GET') {
        const sid = prefixedId(sp, nativeId);
        return ok(res, { items: await collectSessionWireTasks(adapter, nativeId, sid, hub) }, requestId);
      }
      // 0.39 运行中卡片「移到后台」调 POST /tasks/:id:detach。Kimi 走上游代理;
      // 本地 provider 无对等物,明确 400,避免前端把裸 404 当成路由错误。
      const taskDetach = /^\/tasks\/([^/:]+):detach$/.exec(tail);
      if (taskDetach && req.method === 'POST') {
        throw new ProviderError('unsupported', `${sp} 不支持把任务移到后台(:detach)`, 400);
      }
      const taskCancel = /^\/tasks\/([^/:]+):cancel$/.exec(tail);
      if (taskCancel && req.method === 'POST') {
        throw new ProviderError('unsupported', `${sp} 不支持取消后台任务(:cancel)`, 400);
      }
      if (tail === '/title/generate' && req.method === 'POST') {
        const title = await generateLocalSessionTitle(adapter, nativeId);
        if (adapter.rename) await adapter.rename(nativeId, title);
        return ok(res, { title }, requestId);
      }
      if (tail === '/terminals' && req.method === 'GET') {
        // codex 后台终端(thread/backgroundTerminals/list);claude 无此机制回空。
        if (!adapter.listTerminals) return ok(res, { items: [] }, requestId);
        const sid = prefixedId(sp, nativeId);
        const items = (await adapter.listTerminals(nativeId).catch(() => [])).map((t) =>
          codexTerminalToWire(t, sid),
        );
        return ok(res, { items }, requestId);
      }
      if (tail === '/terminals' && req.method === 'POST') {
        throw new ProviderError('unsupported', `${sp} 不支持从 web 创建终端(只读列表)`, 400);
      }

      return fail(res, 404, 40401, `unsupported session route ${tail}`, requestId);
    }

    return fail(res, 404, 40400, `unknown route ${sub}`, requestId);
  }

  // Kimi 开着走官方 WebSocket 字节流;kimi=off 时启动屏走本地 server_hello。
  // Claude/Codex/Grok 始终是本地协议适配。
  const gatewaySockets = new Set<Duplex>();
  attachGatewayWebSocket(
    server,
    token,
    hub,
    adapters,
    async () => {
      await refreshKimi();
      return kimiWs;
    },
    gatewaySockets,
    kimiSockets,
    kimiOpt === 'off',
    demoActive,
    async (req, socket, head) => {
      await refreshKimi();
      if (kimi && await isKimiV25Upstream()) {
        bridgeKimiV25Ws(req, socket, head, kimi, gatewaySockets, kimiSockets);
        return true;
      }
      return false;
    },
  );

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => resolveListen());
  });

  await uploadStore.hydrate();
  // 预热只打本机已安装的 provider。没装的 CLI 会在 handshake 上空等 ~20s,
  // 抢首屏 /auth + WS,把官方「连接中」拖长。
  const warm: Array<Promise<unknown>> = [];
  const warmNames: string[] = [];
  const enqueueWarm = (name: string, task: Promise<unknown>): void => {
    warmNames.push(name);
    warm.push(task);
  };
  const fullWarmup = process.env.GATEWAY_WARMUP === 'full';
  for (const p of LOCAL_PROVIDERS) {
    if (!availableProviders.includes(p)) continue;
    enqueueWarm(`${p}.list`, adapters[p].list({ limit: 100 }));
    if (fullWarmup) {
      enqueueWarm(`${p}.models`, adapters[p].listModels?.() ?? Promise.resolve(null));
      enqueueWarm(`${p}.cmds`, adapters[p].listCommands?.() ?? Promise.resolve(null));
    }
  }
  if (warm.length > 0) {
    void Promise.allSettled(warm).then((rs) => {
      const parts = rs.map((r, i) => {
        if (r.status !== 'fulfilled') return `${warmNames[i]}=失败`;
        const value = r.value as { items?: unknown[] } | unknown[] | null;
        if (Array.isArray(value)) return `${warmNames[i]}=${value.length}`;
        if (value && Array.isArray(value.items)) return `${warmNames[i]}=${value.items.length}`;
        return `${warmNames[i]}=ok`;
      });
      console.error(`[gateway] 预热: ${parts.join(' ')}`);
    });
  }

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  // listen 回调早于内核 accept 队列就绪时,立刻 fetch 会 ECONNREFUSED(本机 Node 24 复现)。
  await waitUntilAccepting(host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host, actualPort);
  const url = `http://${host}:${actualPort}`;
  return {
    url,
    web: webShell
      ? { injectionEnabled: webShell.injectionEnabled, reason: webShell.reason }
      : null,
    close: () =>
      new Promise((resolveClose) => {
        if (kimiFollowTimer) clearInterval(kimiFollowTimer);
        uploadStore.close();
        workspaceStore.close();
        for (const socket of gatewaySockets) socket.destroy();
        server.close(() => {
          // 关停也要释放 provider 子进程;allSettled 保证一个挂了不拖住整体。
          const kimiChildren = new Set<KimiChild>();
          if (kimiFallback?.owned) kimiChildren.add(kimiFallback);
          if (kimi?.child?.owned) kimiChildren.add(kimi.child);
          void Promise.allSettled([
            ...Array.from(kimiChildren).map((c) => c.close()),
            adapters.claude.dispose?.() ?? Promise.resolve(),
            adapters.codex.dispose?.() ?? Promise.resolve(),
            adapters.grok.dispose?.() ?? Promise.resolve(),
            adapters.pi.dispose?.() ?? Promise.resolve(),
            adapters.dsh.dispose?.() ?? Promise.resolve(),
          ]).then(() => resolveClose());
        });
        // 流式/长连接会挡住 server.close 的回调,主动掐掉空闲 keep-alive。
        server.closeAllConnections?.();
      }),
  };
}

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function authed(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    if (safeEqual(header.slice(7).trim(), token)) return true;
  }
  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string') {
    const parts = proto.split(',').map((p) => p.trim());
    for (const part of parts) {
      if (part.startsWith('kimi-code.bearer.')) {
        if (safeEqual(part.slice('kimi-code.bearer.'.length), token)) return true;
      }
    }
  }
  // 开发期:允许 query token
  const url = new URL(req.url ?? '/', 'http://localhost');
  const qToken = url.searchParams.get('token');
  if (typeof qToken === 'string' && safeEqual(qToken, token)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Kimi 代理判定:无 provider 前缀的会话 id / Kimi 专属路由 → 转发 58627
// ---------------------------------------------------------------------------

function shouldProxyToKimi(req: IncomingMessage, hasUpload: (id: string) => boolean): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // 0.36+ /api/v2：Kimi 会话列表仍走 kap;claude/codex/grok/pi 必须留在本网关,
  // 否则平铺视图/搜索/已归档只看得到 Kimi。
  if (url.pathname === '/v1/remote' || url.pathname.startsWith('/v1/remote/')) return true;
  if (url.pathname.startsWith('/api/v2')) {
    const v2Provider = url.searchParams.get('provider');
    // 列表与批量归档/恢复:只有显式本地 provider 才留在本网关;其余透传 kap。
    // boot.js 会给这些路径补 ?provider=,所以本地 provider 侧边栏操作不会误进上游。
    if (isLocalProvider(v2Provider)) return false;
    return true;
  }
  if (!url.pathname.startsWith(API)) return false;
  if (url.pathname === `${API}/ws`) return false;
  // /meta 本地合并:官方字段照传,追加实际安装的 provider 列表(选择器过滤用)。
  if (url.pathname === `${API}/meta`) return false;

  const provider = url.searchParams.get('provider');
  if (provider === 'kimi') return true;
  if (isLocalProvider(provider)) return false;
  if (provider !== null) return false;

  const sessMatch = /^\/api\/v1\/sessions\/([^/:]+)/.exec(url.pathname);
  if (sessMatch) {
    const id = decodeURIComponent(sessMatch[1]);
    return providerFromSessionId(id).provider === 'kimi';
  }

  // Official file preview URLs do not carry provider. Keep only gateway-owned
  // upload ids local; every other file route belongs to Kimi.
  if (url.pathname.startsWith(`${API}/files/`)) {
    let id = '';
    try {
      id = decodeURIComponent(url.pathname.slice(`${API}/files/`.length));
    } catch {
      return true;
    }
    return !hasUpload(id);
  }

  // No provider is the unmodified official Kimi client. Keep only the gateway
  // liveness probe local and proxy every present or future Kimi API route.
  return url.pathname !== `${API}/healthz`;
}

// ---------------------------------------------------------------------------
// workspaces / sessions 数据组装
// ---------------------------------------------------------------------------

type KimiFetch = (path: string, init?: RequestInit) => Promise<unknown>;

function isProviderRefreshRoute(sub: string): boolean {
  return sub === '/providers:refresh' || sub === '/providers:refresh_oauth' || /^\/providers\/[^/:]+:refresh$/.test(sub);
}

async function providerDto(provider: LocalProviderName, adapter: ProviderAdapter): Promise<Record<string, unknown>> {
  // listModels 失败如实抛出(500),不伪装成空目录——与 /models 行为一致。
  const models = adapter.listModels ? await adapter.listModels() : [];
  return {
    id: provider,
    type: provider,
    default_model: models[0]?.model ?? '',
    has_api_key: true,
    status: 'connected',
    models: models.map((model) => model.model),
  };
}

const SKILL_CHIP_RE = /\[([^\]]+)\]\((?:kimi-code:\/\/skill\/|kimi-code-composer:\/\/skills\/)([^)\s?]+)(?:[?#][^)]*)?\)/g;

function sanitizeSkillActivateArgs(skillName: string, rawArgs: unknown): string {
  if (typeof rawArgs !== 'string' || !rawArgs) return '';
  const target = skillName.trim().toLowerCase();
  const cleaned = rawArgs.replace(SKILL_CHIP_RE, (_full, label: string, encodedSlug: string) => {
    let slug = encodedSlug;
    try { slug = decodeURIComponent(encodedSlug); } catch { /* keep raw */ }
    if (slug.toLowerCase() === target || label.trim().toLowerCase() === target) {
      return '';
    }
    return slug ? `/${slug}` : label;
  });
  return cleaned.replace(/\s+/g, ' ').trim();
}

function stripCommandSkillChips(text: string): string {
  return text.replace(
    /(^|\n)([ \t]*\/([^\s]+))(?:[ \t]+\[([^\]]+)\]\((?:kimi-code:\/\/skill\/|kimi-code-composer:\/\/skills\/)([^)\s?]+)(?:[?#][^)]*)?\))+/g,
    (full, lead: string, cmdPart: string, cmdName: string, label: string, encodedSlug: string) => {
      let slug = encodedSlug;
      try { slug = decodeURIComponent(encodedSlug); } catch { /* keep raw */ }
      if (slug.toLowerCase() === cmdName.toLowerCase() || label.trim().toLowerCase() === cmdName.toLowerCase()) {
        return `${lead}${cmdPart}`;
      }
      return full;
    },
  );
}

function sanitizePromptSkillChips(text: string): string {
  if (!text || (!text.includes('kimi-code://skill/') && !text.includes('kimi-code-composer://skills/'))) {
    return text;
  }
  let out = stripCommandSkillChips(text);
  out = out.replace(SKILL_CHIP_RE, (_full, label: string, encodedSlug: string) => {
    let slug = encodedSlug;
    try { slug = decodeURIComponent(encodedSlug); } catch { /* keep raw */ }
    return slug ? `/${slug}` : label;
  });
  return out.trim();
}

const NATIVE_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);

function nativeEffortFromCommand(name: string, args: string): string | undefined {
  if (!/^(effort|thinking)$/i.test(name)) return undefined;
  const token = args.trim().split(/\s+/)[0]?.toLowerCase();
  return token && NATIVE_EFFORTS.has(token) ? token : undefined;
}

export function parseWireThinkingPatch(
  raw: unknown,
  sp?: string,
  model?: NativeModel | null,
): string | undefined {
  let parsed: string | undefined;
  if (typeof raw === 'string' && raw.trim()) {
    parsed = raw.trim();
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const rec = raw as { enabled?: unknown; effort?: unknown };
    if (rec.enabled === false) return 'off';
    if (typeof rec.effort === 'string' && rec.effort.trim()) parsed = rec.effort.trim();
    else if (rec.enabled === true) parsed = 'on';
  }
  if (!parsed) return undefined;
  if (parsed === 'off') return 'off';

  // Check if model explicitly lacks thinking capability
  if (model) {
    const hasThinkingCap = model.capabilities ? model.capabilities.includes('thinking') : true;
    const hasEfforts = model.support_efforts ? model.support_efforts.length > 0 : true;
    if (!hasThinkingCap || !hasEfforts) {
      return undefined;
    }
  }

  const defaultEffort = model?.default_effort
    ?? (sp === 'grok' ? 'high' : 'medium');

  if (parsed === 'on') {
    return defaultEffort;
  }

  if (parsed === 'auto') {
    // Pi, Codex, Grok, and Dsh do not support 'auto'
    if (sp === 'pi' || sp === 'codex' || sp === 'grok' || sp === 'dsh') {
      return defaultEffort;
    }
    return 'auto';
  }

  return parsed;
}

function toWireThinkingConfig(thinking: string | undefined): Record<string, unknown> | undefined {
  if (!thinking) return undefined;
  if (thinking === 'off') return { enabled: false };
  if (thinking === 'on') return { enabled: true };
  return { enabled: true, effort: thinking };
}

function mergeAgentRefs(
  existing: unknown,
  ids: Array<string | undefined>,
): Array<{ agent_id: string; role: 'child' }> | undefined {
  const out: Array<{ agent_id: string; role: 'child' }> = [];
  const seen = new Set<string>();
  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as { agent_id?: unknown; agentId?: unknown };
      const id = typeof rec.agent_id === 'string' && rec.agent_id
        ? rec.agent_id
        : typeof rec.agentId === 'string' && rec.agentId
          ? rec.agentId
          : '';
      if (id && id !== 'main' && !seen.has(id)) {
        seen.add(id);
        out.push({ agent_id: id, role: 'child' });
      }
    }
  }
  for (const rawId of ids) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (id && id !== 'main' && !seen.has(id)) {
      seen.add(id);
      out.push({ agent_id: id, role: 'child' });
    }
  }
  return out.length > 0 ? out : undefined;
}

function toWireTask(t: TranscriptTask): Record<string, unknown> {
  const isRunning = t.state === 'running';
  const outcome = t.state === 'completed'
    ? 'completed'
    : t.state === 'failed' || t.state === 'timed_out'
      ? 'failed'
      : t.state === 'killed'
        ? 'cancelled'
        : isRunning
          ? undefined
          : 'lost';
  return {
    task_id: t.taskId,
    kind: t.kind,
    status: isRunning ? 'running' : 'ended',
    ...(outcome ? { outcome } : {}),
    detached: t.detached,
    ...(t.description ? { description: t.description } : {}),
    ...(t.agentId ? { child_agent_id: t.agentId } : {}),
    ...(t.parentToolUseId ? { parent_tool_call_id: t.parentToolUseId } : {}),
    ...(t.startedAt ? { started_at: t.startedAt } : {}),
    ...(t.endedAt ? { ended_at: t.endedAt } : {}),
    ...(t.resultSummary ? { result_summary: t.resultSummary } : {}),
    ...(t.error ? { state_reason: t.error } : {}),
  };
}

async function collectSessionWireTasks(
  adapter: ProviderAdapter | null | undefined,
  nativeId: string,
  sid: string,
  hub: SessionHub,
): Promise<Array<Record<string, unknown>>> {
  const items = hub.transcript.currentTasks(sid).map(toWireTask);
  const seenAgentIds = new Set<string>();
  const seenTaskIds = new Set<string>();
  for (const item of items) {
    if (typeof item.task_id === 'string') seenTaskIds.add(item.task_id);
    if (typeof item.child_agent_id === 'string') seenAgentIds.add(item.child_agent_id);
  }
  if (adapter?.listSubagents) {
    const subs = await adapter.listSubagents(nativeId).catch(() => []);
    for (const sub of subs) {
      if (!sub?.agentId || seenAgentIds.has(sub.agentId) || seenTaskIds.has(sub.agentId)) continue;
      seenAgentIds.add(sub.agentId);
      items.push({
        task_id: sub.agentId,
        kind: 'subagent',
        status: 'ended',
        outcome: 'completed',
        detached: false,
        ...(sub.description ? { description: sub.description } : {}),
        child_agent_id: sub.agentId,
        ...(sub.parentToolUseId ? { parent_tool_call_id: sub.parentToolUseId } : {}),
      });
    }
  }
  return items;
}

async function applySessionProfilePatch(
  adapter: ProviderAdapter,
  sp: ProviderName,
  nativeId: string,
  caps: ReturnType<ProviderAdapter['capabilities']>,
  body: Record<string, unknown>,
  hub: SessionHub,
  demoActive: boolean,
): Promise<Record<string, unknown>> {
  const title = typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : undefined;
  if (title) {
    if (caps.rename === false || !adapter.rename) {
      throw new ProviderError('unsupported', `${sp} 不支持重命名`, 400);
    }
    await adapter.rename(nativeId, title);
  }
  const nestedCfg = body?.agent_config && typeof body.agent_config === 'object' && !Array.isArray(body.agent_config)
    ? (body.agent_config as Record<string, unknown>)
    : {};
  const cfg = { ...body, ...nestedCfg };
  if (cfg.swarm_mode === true) {
    throw new ProviderError('unsupported', `${sp} 不支持 swarm_mode`, 400);
  }
  if (cfg.tower_mode === true) {
    throw new ProviderError('unsupported', `${sp} 不支持 tower_mode`, 400);
  }
  const selectedModelId = typeof cfg.model === 'string' && cfg.model ? cfg.model : adapter.getModel?.(nativeId);
  if (typeof cfg.model === 'string' && cfg.model && adapter.setModel) {
    await adapter.setModel(nativeId, cfg.model);
  }
  if (cfg.thinking !== undefined && adapter.setThinking) {
    const models = adapter.listModels ? await adapter.listModels().catch(() => []) : [];
    const selectedModel = (selectedModelId
      ? models.find((m) => m.model === selectedModelId)
      : models.find((m) => m.isDefault) ?? models[0]) ?? null;
    const parsedThinking = parseWireThinkingPatch(cfg.thinking, sp, selectedModel);
    if (parsedThinking !== undefined) {
      await adapter.setThinking(nativeId, parsedThinking);
    }
  }
  if (typeof cfg.permission_mode === 'string') {
    if (cfg.permission_mode === 'manual' && (caps.manualApproval === false || caps.approvals === false)) {
      throw new ProviderError('unsupported', `${sp} 不支持 manual 审批模式`, 400);
    }
    if (adapter.setPermission) await adapter.setPermission(nativeId, cfg.permission_mode);
  }
  if (typeof cfg.plan_mode === 'boolean') {
    if (cfg.plan_mode === true && (caps.planMode === false || !adapter.setPlanMode)) {
      throw new ProviderError('unsupported', `${sp} 不支持 plan_mode`, 400);
    }
    if (adapter.setPlanMode && caps.planMode !== false) {
      await adapter.setPlanMode(nativeId, cfg.plan_mode);
    }
  }
  if (typeof cfg.goal_objective === 'string') {
    if (caps.goals === false || !adapter.setGoal) throw new ProviderError('unsupported', `${sp} 不支持 goal`, 400);
    await adapter.setGoal(nativeId, cfg.goal_objective);
  }
  if (typeof cfg.goal_control === 'string') {
    if (caps.goals === false || !adapter.controlGoal) throw new ProviderError('unsupported', `${sp} 不支持 goal`, 400);
    await adapter.controlGoal(nativeId, cfg.goal_control as 'pause' | 'resume' | 'cancel');
  }
  const sid = prefixedId(sp, nativeId);
  emitV262AgentState(hub, adapter, sp, nativeId, sid, hub.busy.has(sid) ? 'running' : 'idle');
  return sessionDto(await getSession(adapter, sp, nativeId, demoActive), adapter.getModel?.(nativeId), adapter.getUsage?.(nativeId), hub.busy.has(sid));
}

async function providerConfigView(
  provider: LocalProviderName,
  adapter: ProviderAdapter,
  kimiFetch: KimiFetch,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const base = (await kimiFetch('/config').catch(() => ({ providers: {} }))) as Record<string, unknown>;
  const models = adapter.listModels ? await adapter.listModels().catch(() => []) : [];
  const requestedModel = typeof patch.default_model === 'string' ? patch.default_model : undefined;
  if (requestedModel && adapter.setModel) await adapter.setModel('__default__', requestedModel);
  const defaultModel = requestedModel ?? adapter.getModel?.('__default__') ?? models[0]?.model ?? '';
  const selectedModel = models.find((m) => m.model === defaultModel) ?? null;
  const requestedThinking = patch.thinking !== undefined ? parseWireThinkingPatch(patch.thinking, provider, selectedModel) : undefined;
  if (requestedThinking && adapter.setThinking) await adapter.setThinking('__default__', requestedThinking);
  const wireThinking = toWireThinkingConfig(adapter.getThinking?.('__default__'));
  const modelMap: Record<string, Record<string, unknown>> = {};
  for (const model of models) {
    const dto = wireModelDto(model);
    modelMap[model.model] = {
      provider,
      model: model.model,
      displayName: model.display_name ?? model.model,
      ...(typeof model.max_context_size === 'number' && model.max_context_size > 0
        ? { maxContextSize: model.max_context_size }
        : {}),
      ...(Array.isArray(dto.capabilities) ? { capabilities: dto.capabilities } : {}),
      ...(Array.isArray(dto.support_efforts) ? { supportEfforts: dto.support_efforts } : {}),
      ...(typeof dto.default_effort === 'string' ? { defaultEffort: dto.default_effort } : {}),
    };
  }
  const { thinking: _kimiThinking, ...restBase } = base;
  return {
    ...restBase,
    ...patch,
    ...(wireThinking ? { thinking: wireThinking } : {}),
    models: modelMap,
    providers: {
      [provider]: {
        type: provider,
        default_model: defaultModel,
        has_api_key: true,
      },
    },
    default_provider: provider,
    default_model: defaultModel,
  };
}

/**
 * 根据 provider capabilities 动态计算 Kimi Web 2.6.2 前端 `xM` Tier-1 命令集合。
 * Tier-1 命令由前端直接拦截/内置处理，需在 `/skills` 列表中过滤以避免重复渲染。
 */
export function activeKimiTier1Names(caps?: ProviderCapabilities): Set<string> {
  const names = new Set<string>(['new', 'clear', 'login', 'reload', 'export', 'status']);
  if (!caps) return names;
  if (caps.planMode !== false) names.add('plan');
  if (caps.goals !== false) names.add('goal');
  if (caps.swarm === true) names.add('swarm');
  if (caps.tower === true) names.add('tower');
  if (caps.btw === true) names.add('btw');
  if (caps.compact !== false) names.add('compact');
  if (caps.rollback !== false) names.add('undo');
  if (caps.fork !== false) names.add('fork');
  return names;
}

export function skillDto(command: NativeCommand, cwd?: string): Record<string, unknown> {
  const rawName = command.name;
  const bareName = rawName.startsWith('skill:') ? rawName.slice(6) : rawName;
  const isBuiltinLike = command.builtin === true || command.source === 'extension' || command.source === 'prompt';
  const isDiskEntry = Boolean(command.path) && !isBuiltinLike;
  const source = isBuiltinLike
    ? 'builtin'
    : isDiskEntry
      ? (command.scope === 'project' ? 'project' : 'user')
      : (command.scope === 'project' ? 'project' : 'builtin');
  const aliases = command.aliases
    ? command.aliases.map((a) => (a.startsWith('skill:') ? a.slice(6) : a))
    : undefined;
  return {
    name: bareName,
    description: command.description,
    path: command.path ?? '',
    source,
    ...(source === 'project' && cwd ? { workspace_dir: cwd } : {}),
    type: 'prompt',
    accepts_input: command.acceptsInput !== false,
    ...(command.argumentHint ? { argument_hint: command.argumentHint } : {}),
    ...(aliases && aliases.length > 0 ? { aliases } : {}),
    disable_model_invocation: false,
  };
}

export async function adapterSkills(
  adapter: ProviderAdapter,
  sessionId?: string,
  cwdOverride?: string,
): Promise<Record<string, unknown>[]> {
  const byName = new Map<string, Record<string, unknown>>();
  const cwd = cwdOverride ?? (sessionId ? adapter.getCwd?.(sessionId) : undefined);
  const caps = adapter.capabilities?.() ?? ({} as ProviderCapabilities);
  const tier1Names = activeKimiTier1Names(caps);

  if (adapter.listSkills) {
    const skills = await adapter.listSkills(sessionId, cwd).catch(() => []);
    for (const skill of skills) {
      if (
        !skill
        || typeof skill.name !== 'string'
        || skill.enabled === false
      ) {
        continue;
      }
      const rawName = skill.name;
      const bareName = rawName.startsWith('skill:') ? rawName.slice(6) : rawName;
      if (tier1Names.has(bareName) || tier1Names.has(rawName)) {
        continue;
      }
      const isBuiltinLike = (skill as any).builtin === true || (skill as any).source === 'extension' || (skill as any).source === 'prompt';
      const isDiskEntry = Boolean(skill.path) && !isBuiltinLike;
      const source = isBuiltinLike
        ? 'builtin'
        : isDiskEntry
          ? (skill.scope === 'project' ? 'project' : 'user')
          : (skill.scope === 'project' ? 'project' : 'user');
      const dedupeKey = `${source === 'builtin' ? 'cmd' : 'skill'}:${bareName}`;
      byName.set(dedupeKey, {
        name: bareName,
        description: skill.description ?? '',
        path: skill.path ?? '',
        source,
        ...(source === 'project' && cwd ? { workspace_dir: cwd } : {}),
        type: 'prompt',
        accepts_input: true,
        disable_model_invocation: false,
      });
    }
  }
  if (adapter.listCommands) {
    const commands = await adapter.listCommands(sessionId, cwd).catch(() => [] as NativeCommand[]);
    for (const command of commands) {
      if (
        command.kind !== 'prompt'
        || command.terminalOnly === true
      ) {
        continue;
      }
      const rawName = command.name;
      const bareName = rawName.startsWith('skill:') ? rawName.slice(6) : rawName;
      const dto = skillDto(command, cwd);
      const dedupeKey = `${dto.source === 'builtin' ? 'cmd' : 'skill'}:${bareName}`;
      if (
        tier1Names.has(bareName)
        || tier1Names.has(rawName)
        || byName.has(dedupeKey)
      ) {
        continue;
      }
      byName.set(dedupeKey, dto);
    }
  }
  return [...byName.values()];
}

function normalizeWorkspaceRoot(root: string): string {
  const trimmed = root.trim();
  if (!trimmed) return '';
  const resolved = path.resolve(trimmed);
  return (process.platform === 'win32' ? resolved.toLowerCase() : resolved).replace(/[\\/]+$/, '') || '/';
}

interface WorkspaceDtoOptions {
  kind?: 'implicit' | 'managed';
  additionalDirs?: string[];
  createdAt?: string;
  lastOpenedAt?: string;
  sessionCount?: number;
}

interface StoredLocalWorkspace {
  id: string;
  root: string;
  name?: string;
  kind?: 'implicit' | 'managed';
  additional_dirs?: string[];
  created_at?: string;
  last_opened_at?: string;
}

function readStoredWorkspaces(
  store: SettingsStore | undefined,
  provider: LocalProviderName,
): StoredLocalWorkspace[] {
  if (!store) return [];
  const entries = store.listStrings(provider);
  const out: StoredLocalWorkspace[] = [];
  for (const [id, raw] of Object.entries(entries)) {
    try {
      const parsed = JSON.parse(raw) as Partial<StoredLocalWorkspace>;
      if (parsed && typeof parsed.root === 'string' && parsed.root.trim()) {
        out.push({
          id: typeof parsed.id === 'string' && parsed.id ? parsed.id : id,
          root: parsed.root.trim(),
          name: typeof parsed.name === 'string' ? parsed.name : undefined,
          kind: parsed.kind === 'implicit' ? 'implicit' : 'managed',
          additional_dirs: Array.isArray(parsed.additional_dirs)
            ? parsed.additional_dirs.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
            : [],
          created_at: typeof parsed.created_at === 'string' ? parsed.created_at : undefined,
          last_opened_at: typeof parsed.last_opened_at === 'string' ? parsed.last_opened_at : undefined,
        });
      }
    } catch {
      // ignore corrupt persisted workspace entry
    }
  }
  return out;
}

function upsertStoredWorkspace(
  store: SettingsStore | undefined,
  provider: LocalProviderName,
  record: StoredLocalWorkspace,
): void {
  if (!store) return;
  store.set(provider, record.id, JSON.stringify(record));
}

function buildStoredWorkspaceIdMap(
  store: SettingsStore | undefined,
  provider?: ProviderName,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!store) return map;
  const targets: LocalProviderName[] = provider && isLocalProvider(provider)
    ? [provider]
    : [...LOCAL_PROVIDERS];
  for (const p of targets) {
    for (const stored of readStoredWorkspaces(store, p)) {
      const normRoot = normalizeWorkspaceRoot(stored.root) || stored.root;
      if (normRoot) map.set(normRoot, stored.id);
      for (const d of stored.additional_dirs ?? []) {
        const normD = normalizeWorkspaceRoot(d) || d;
        if (normD) map.set(normD, stored.id);
      }
    }
  }
  return map;
}

const DIR_PROBE_TTL_MS = 5_000;
const dirProbeCache = new Map<string, { exists: boolean; at: number }>();

function isExistingDir(dirPath: unknown): boolean {
  if (!dirPath || typeof dirPath !== 'string') return false;
  const now = Date.now();
  const hit = dirProbeCache.get(dirPath);
  if (hit && now - hit.at < DIR_PROBE_TTL_MS) return hit.exists;
  let exists = false;
  try {
    exists = statSync(dirPath).isDirectory();
  } catch {
    exists = false;
  }
  if (dirProbeCache.size >= 2048) {
    const oldest = dirProbeCache.keys().next().value;
    if (oldest !== undefined) dirProbeCache.delete(oldest);
  }
  dirProbeCache.set(dirPath, { exists, at: now });
  return exists;
}

function workspaceDto(root: string, name?: string, opts?: WorkspaceDtoOptions): Record<string, unknown> {
  const normalized = normalizeWorkspaceRoot(root) || root;
  const slug = normalized.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root';
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  const maxSlug = Math.max(1, 60 - 'wd_'.length - 1 - hash.length);
  const now = new Date().toISOString();
  const baseName = normalized ? path.posix.basename(normalized.replace(/\\/g, '/')) : '';
  const fallbackName = baseName || slug;
  return {
    id: `wd_${slug.slice(0, maxSlug)}_${hash}`,
    root,
    name: name && name.trim() ? name.trim() : fallbackName,
    kind: opts?.kind ?? 'implicit',
    additional_dirs: opts?.additionalDirs ?? [],
    created_at: opts?.createdAt ?? now,
    last_opened_at: opts?.lastOpenedAt ?? opts?.createdAt ?? now,
    session_count: opts?.sessionCount ?? 0,
  };
}

async function listAllSessions(
  adapter: ProviderAdapter,
  query: { cwd?: string; archived?: boolean } = {},
): Promise<Session[]> {
  const items: Session[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await adapter.list({ limit: 100, cursor, ...query });
    items.push(...page.items);
    if (!page.next_cursor || seen.has(page.next_cursor)) return items;
    seen.add(page.next_cursor);
    cursor = page.next_cursor;
  }
}

async function listWorkspaces(
  adapters: Record<LocalProviderName, ProviderAdapter>,
  kimiFetch: KimiFetch | null,
  provider: ProviderName | undefined,
  demoActive: boolean,
  workspaceStore?: SettingsStore,
): Promise<Record<string, unknown>> {
  const roots = new Map<string, Record<string, unknown>>();
  // Kimi 工作区:直接取上游视图(自带 session_count)。
  if (kimiFetch && (!provider || provider === 'kimi')) {
    const data = (await kimiFetch('/workspaces').catch(() => null)) as { items?: Record<string, unknown>[] } | null;
    for (const w of data?.items ?? []) {
      const root = String(w.root ?? w.id ?? '');
      const norm = normalizeWorkspaceRoot(root) || root;
      if (norm) roots.set(norm, w);
    }
  }
  if (demoActive && (!provider || provider === 'kimi')) {
    for (const session of listDemoSessions('kimi')) {
      const cwd = session.metadata.cwd;
      const norm = normalizeWorkspaceRoot(cwd) || cwd;
      if (!roots.has(norm)) roots.set(norm, workspaceDto(cwd));
      const workspace = roots.get(norm);
      if (workspace) {
        workspace.session_count = (typeof workspace.session_count === 'number' ? workspace.session_count : 0) + 1;
      }
    }
  }
  // Codex/Claude/Grok/Pi:沿各自原生 cursor 聚合全部主会话。固定上限会漏掉老项目,
  // 还会让前端的 session_count 与“加载更多”不一致。
  const targets: LocalProviderName[] = !provider
    ? [...LOCAL_PROVIDERS]
    : isLocalProvider(provider)
      ? [provider]
      : [];
  const dirToOwner = new Map<string, string>();
  for (const p of targets) {
    for (const stored of readStoredWorkspaces(workspaceStore, p)) {
      const norm = normalizeWorkspaceRoot(stored.root) || stored.root;
      if (!roots.has(norm)) {
        const dto = workspaceDto(stored.root, stored.name, {
          kind: stored.kind ?? 'managed',
          additionalDirs: stored.additional_dirs ?? [],
          createdAt: stored.created_at,
          lastOpenedAt: stored.last_opened_at,
          sessionCount: 0,
        });
        dto.id = stored.id;
        roots.set(norm, dto);
      }
      if (!dirToOwner.has(norm)) dirToOwner.set(norm, norm);
      for (const extra of stored.additional_dirs ?? []) {
        const extraNorm = normalizeWorkspaceRoot(extra) || extra;
        if (extraNorm && !dirToOwner.has(extraNorm)) dirToOwner.set(extraNorm, norm);
      }
    }
    const adapter = adapters[p];
    const sessions = mergeDemoSessions(
      p,
      await listAllSessions(adapter).catch((err) => {
        console.error(`[gateway] listWorkspaces: ${p}.list 失败:`, err instanceof Error ? err.message : err);
        return [] as Session[];
      }),
      demoActive,
    );
    const counts = new Map<string, number>();
    for (const session of sessions) {
      const cwd = session.metadata.cwd;
      const norm = normalizeWorkspaceRoot(cwd) || cwd;
      const ownerNorm = dirToOwner.get(norm) ?? norm;
      if (!roots.has(ownerNorm)) {
        if (isExistingDir(cwd)) {
          roots.set(ownerNorm, workspaceDto(cwd));
        }
      }
      if (roots.has(ownerNorm)) {
        counts.set(ownerNorm, (counts.get(ownerNorm) ?? 0) + 1);
      }
    }
    for (const [norm, count] of counts) {
      const workspace = roots.get(norm);
      if (workspace) {
        workspace.session_count = (typeof workspace.session_count === 'number' ? workspace.session_count : 0) + count;
      }
    }
  }
  return { items: [...roots.values()] };
}

function sessionDto(
  s: Session,
  model?: string,
  usage?: SessionUsage,
  busy?: boolean,
  storedWsIdMap?: Map<string, string>,
): Record<string, unknown> {
  // facade 的 Session.busy 是硬编码 false(适配器默认不跟踪网关 live turn 状态);
  // 真值只能从网关 hub(turn 登记处)拿,调用方有 hub 就传 busy 覆盖——否则
  // 进行中的会话刷新后月亮熄灭、前端误判 turn 结束(审查实测)。
  const isBusy = busy ?? s.busy;
  const cwd = s.metadata?.cwd ? String(s.metadata.cwd) : undefined;
  const normCwd = cwd ? (normalizeWorkspaceRoot(cwd) || cwd) : undefined;
  const storedId = normCwd && storedWsIdMap ? storedWsIdMap.get(normCwd) : undefined;
  const wsId = storedId ?? (cwd ? (workspaceDto(cwd).id as string) : s.workspace_id);
  return {
    id: prefixedId(s.provider, s.id),
    // workspace_id 优先按 normalized cwd 关联存储项目 ID(防换 primary 根后 ID 漂移导致分组被吞),
    // 隐式项目则按 workspaceDto 规则生成,确保与 listWorkspaces 一致。
    workspace_id: wsId,
    title: s.title,
    last_prompt: typeof s.extras?.last_prompt === 'string' ? s.extras.last_prompt : '',
    created_at: s.created_at,
    updated_at: s.updated_at,
    busy: isBusy,
    main_turn_active: isBusy,
    pending_interaction: 'none',
    archived: s.archived ?? false,
    metadata: { ...s.metadata, provider: s.provider },
    agent_config: { model: model ?? '' },
    usage: usage ?? {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
      total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 0,
    },
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}

function isEmptyPlaceholderSession(item: Record<string, unknown>, busy: boolean): boolean {
  if (busy) return false;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const lastPrompt = typeof item.last_prompt === 'string' ? item.last_prompt.trim() : '';
  const promptEmpty = lastPrompt.length === 0 || lastPrompt === '(session)';
  return promptEmpty && (title.length === 0 || title === '(session)');
}

/**
 * 0.38+ 侧栏 load 调 listSessionGroupsV2: GET /api/v2/sessions?view=by_workspace,
 * 解包 `groups` 再 `[...Ie.groups]`。Kimi 无 provider 仍走 shouldProxyToKimi,本函数服务本地 provider。
 */
function sessionGroupsV2(
  items: Record<string, unknown>[],
  url: URL,
  validWorkspaceIds?: Set<string>,
  validRoots?: Map<string, string>,
  primaryRoots?: Map<string, string>,
): Record<string, unknown> {
  const groupPageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('group.page_size') ?? 5) || 5));
  const hasPrompt = url.searchParams.get('meta.has_prompt') === 'true';
  const excludeEmpty = url.searchParams.get('exclude_empty') === 'true';
  const buckets = new Map<string, { workspace: { id: string; cwd: string }; sessions: Record<string, unknown>[] }>();
  for (const item of items) {
    const meta = item.meta && typeof item.meta === 'object' ? item.meta as Record<string, unknown> : {};
    const lastPrompt = typeof meta.last_prompt === 'string' ? meta.last_prompt.trim() : '';
    if (hasPrompt && (lastPrompt.length === 0 || lastPrompt === '(session)')) continue;
    const isBusy = Boolean((item.activity && typeof item.activity === 'object' && (item.activity as Record<string, unknown>).status === 'running') || item.busy);
    if (excludeEmpty && isEmptyPlaceholderSession({ title: meta.title, last_prompt: meta.last_prompt }, isBusy)) continue;
    const workspace = item.workspace && typeof item.workspace === 'object'
      ? item.workspace as Record<string, unknown>
      : {};
    let id = String(workspace.id ?? '');
    const cwd = typeof workspace.cwd === 'string' ? workspace.cwd : '';
    const normCwd = cwd ? (normalizeWorkspaceRoot(cwd) || cwd) : '';

    if (validRoots && normCwd && validRoots.has(normCwd)) {
      id = validRoots.get(normCwd)!;
      workspace.id = id;
    }

    if (validWorkspaceIds) {
      if (id && !validWorkspaceIds.has(id)) continue;
      if (!id && normCwd && validRoots && !validRoots.has(normCwd)) continue;
    } else if (cwd && !isExistingDir(cwd)) {
      continue;
    }
    const key = id || cwd;
    if (!key) continue;
    const bucket = buckets.get(key) ?? { workspace: { id, cwd: primaryRoots?.get(id) ?? cwd }, sessions: [] };
    bucket.sessions.push(item);
    buckets.set(key, bucket);
  }
  const groups = [...buckets.values()].map((bucket) => {
    const sessions = [...bucket.sessions].sort((a, b) => {
      const au = Number((a.meta as Record<string, unknown> | undefined)?.updated_at ?? 0);
      const bu = Number((b.meta as Record<string, unknown> | undefined)?.updated_at ?? 0);
      return bu - au;
    });
    return {
      workspace: bucket.workspace,
      sessions: sessions.slice(0, groupPageSize),
      total: sessions.length,
    };
  });
  groups.sort((a, b) => {
    const au = Number((a.sessions[0]?.meta as Record<string, unknown> | undefined)?.updated_at ?? 0);
    const bu = Number((b.sessions[0]?.meta as Record<string, unknown> | undefined)?.updated_at ?? 0);
    return bu - au;
  });
  return { groups, total: groups.length, has_more: false, next_page_token: null };
}

function parseV2TimestampBound(raw: string | null): number | undefined {
  if (!raw || !raw.trim()) return undefined;
  const num = Number(raw);
  if (Number.isFinite(num)) return num;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function projectV2Fields(item: Record<string, unknown>, fieldsCsv: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const meta = (item.meta && typeof item.meta === 'object') ? item.meta as Record<string, unknown> : {};
  for (const rawField of fieldsCsv.split(',')) {
    const f = rawField.trim();
    if (!f) continue;
    if (f === 'archived') out.archived = Boolean(meta.archived);
    else if (f in item) out[f] = item[f];
    else if (f in meta) out[f] = meta[f];
  }
  return out;
}

function sessionV2Dto(item: Record<string, unknown>, busy: boolean): Record<string, unknown> {
  const metadata = (item.metadata && typeof item.metadata === 'object')
    ? item.metadata as Record<string, unknown>
    : {};
  const agentConfig = (item.agent_config && typeof item.agent_config === 'object')
    ? item.agent_config as Record<string, unknown>
    : {};
  const model = typeof item.model === 'string' && item.model
    ? item.model
    : typeof agentConfig.model === 'string' && agentConfig.model
      ? agentConfig.model
      : undefined;
  const created = Date.parse(String(item.created_at ?? '')) || 0;
  const updated = Date.parse(String(item.updated_at ?? '')) || created;
  return {
    id: item.id,
    workspace: {
      id: item.workspace_id ?? '',
      cwd: typeof metadata.cwd === 'string' ? metadata.cwd : '',
    },
    meta: {
      title: item.title ?? '',
      last_prompt: typeof item.last_prompt === 'string' ? item.last_prompt : '',
      created_at: created,
      updated_at: updated,
      archived: Boolean(item.archived),
      archived_at: null,
    },
    activity: {
      status: busy ? 'running' : 'idle',
      ...(model ? { model } : {}),
    },
  };
}

async function listSessions(
  adapters: Record<LocalProviderName, ProviderAdapter>,
  kimiFetch: KimiFetch | null,
  url: URL,
  provider: ProviderName | undefined,
  busyOf: (sid: string) => boolean,
  pageCursors: Map<string, string>,
  demoActive: boolean,
  fetchAll = false,
  workspaceStore?: SettingsStore,
): Promise<Record<string, unknown>> {
  const limit = fetchAll ? Number.MAX_SAFE_INTEGER : Math.min(Number(url.searchParams.get('page_size') ?? 50) || 50, 100);
  const beforeId = url.searchParams.get('before_id') ?? undefined;
  const excludeEmpty = url.searchParams.get('exclude_empty') === 'true';
  const archivedOnly = url.searchParams.get('archived_only') === 'true';
  const workspaceId = url.searchParams.get('workspace_id') ?? undefined;
  const items: Record<string, unknown>[] = [];
  let workspaceRoot: string | undefined;
  if (workspaceId) {
    const all = (await listWorkspaces(adapters, kimiFetch, provider, demoActive, workspaceStore).catch(() => null)) as
      | { items?: Record<string, unknown>[] }
      | null;
    const hit = (all?.items ?? []).find((w) => w.id === workspaceId);
    workspaceRoot = typeof hit?.root === 'string' && hit.root ? hit.root : undefined;
  }
  const rootNorm = workspaceRoot ? normalizeWorkspaceRoot(workspaceRoot) : undefined;
  if (isLocalProvider(provider)) {
    const adapter = adapters[provider];
    if (fetchAll && !beforeId) {
      let allItems = await listAllSessions(adapter, { cwd: workspaceRoot, archived: archivedOnly || undefined }).catch((err) => {
        console.error(`[gateway] listSessions: ${provider}.list 失败:`, err instanceof Error ? err.message : err);
        return [] as Session[];
      });
      allItems = mergeDemoSessions(provider, allItems, demoActive);
      if (rootNorm) {
        allItems = allItems.filter((session) => normalizeWorkspaceRoot(String(session.metadata?.cwd ?? '')) === rootNorm);
      }
      allItems = archivedOnly
        ? allItems.filter((session) => session.archived === true)
        : allItems.filter((session) => session.archived !== true);
      const storedWsIdMap = buildStoredWorkspaceIdMap(workspaceStore, provider);
      const localItems = allItems
        .map((session) => sessionDto(
          session,
          adapter.getModel?.(session.id) ?? getDemoModel(provider, session.id),
          adapter.getUsage?.(session.id),
          busyOf(prefixedId(provider, session.id)),
          storedWsIdMap,
        ))
        .filter((dto) => !excludeEmpty || !isEmptyPlaceholderSession(dto, Boolean(dto.busy)));
      return { items: localItems, has_more: false };
    }
    // Open/Done 翻页游标必须带 archived 维度,否则两边页尾 id 相同时会串用。
    const archiveLane = archivedOnly ? 'ar' : 'op';
    const cursorKey = (id: string): string => `${provider}\u0000${workspaceId ?? ''}\u0000${archiveLane}\u0000${id}`;
    let cursor: string | undefined;
    if (beforeId) {
      cursor = getSessionPageCursor(pageCursors, cursorKey(beforeId));
      if (!cursor) {
        const prefix = ID_PREFIX[provider];
        if (prefix && beforeId.startsWith(prefix)) cursor = beforeId.slice(prefix.length);
      }
      if (!cursor) return { items: [], has_more: false };
    }
    let page: SessionPage = await adapter.list({ limit, cursor, cwd: workspaceRoot, archived: archivedOnly || undefined }).catch((err) => {
      console.error(`[gateway] listSessions: ${provider}.list 失败:`, err instanceof Error ? err.message : err);
      return { items: [] as Session[] };
    });
    // Codex 原始页可能只有子 agent;adapter 过滤后为空时沿原生 cursor 前进,
    // 避免 UI 因拿不到 before_id 而卡在空页。翻页必须继续带上 archived,
    // 否则 Done 页会混进进行中会话。
    for (let skipped = 0; page.items.length === 0 && page.next_cursor && skipped < 20; skipped += 1) {
      page = await adapter.list({
        limit,
        cursor: page.next_cursor,
        cwd: workspaceRoot,
        archived: archivedOnly || undefined,
      });
    }
    page = { ...page, items: mergeDemoSessions(provider, page.items, demoActive) };
    if (rootNorm) {
      page = {
        ...page,
        items: page.items.filter((session) => normalizeWorkspaceRoot(String(session.metadata?.cwd ?? '')) === rootNorm),
      };
    }
    if (archivedOnly) {
      page = { ...page, items: page.items.filter((session) => session.archived === true) };
    } else {
      page = { ...page, items: page.items.filter((session) => session.archived !== true) };
    }
    const storedWsIdMap = buildStoredWorkspaceIdMap(workspaceStore, provider);
    const localItems = page.items
      .map((session) => sessionDto(
        session,
        adapter.getModel?.(session.id) ?? getDemoModel(provider, session.id),
        adapter.getUsage?.(session.id),
        busyOf(prefixedId(provider, session.id)),
        storedWsIdMap,
      ))
      .filter((dto) => !excludeEmpty || !isEmptyPlaceholderSession(dto, Boolean(dto.busy)));
    if (page.next_cursor && page.items.length > 0) {
      setSessionPageCursor(pageCursors, cursorKey(prefixedId(provider, page.items[page.items.length - 1]!.id)), page.next_cursor);
    }
    return { items: localItems, has_more: Boolean(page.next_cursor) };
  }
  // Kimi 会话:上游原样条目(id 无前缀 = kimi);跟随上游分页拉全量。
  if (kimiFetch && (!provider || provider === 'kimi') && (!workspaceId || rootNorm)) {
    let upstreamBefore: string | undefined;
    for (let pageNo = 0; pageNo < 10; pageNo++) {
      const qs =
        (excludeEmpty ? '&exclude_empty=true' : '') +
        (upstreamBefore ? `&before_id=${encodeURIComponent(upstreamBefore)}` : '');
      const data = (await kimiFetch(`/sessions?page_size=100${qs}`).catch(() => null)) as
        | { items?: Record<string, unknown>[]; has_more?: boolean }
        | null;
      const pageItems = data?.items ?? [];
      for (const it of pageItems) {
        if (rootNorm) {
          const cwd = typeof (it.metadata as Record<string, unknown> | undefined)?.cwd === 'string'
            ? String((it.metadata as Record<string, unknown>).cwd)
            : '';
          if (normalizeWorkspaceRoot(cwd) !== rootNorm) continue;
        }
        items.push(it);
      }
      if (!data?.has_more || pageItems.length === 0) break;
      upstreamBefore = String(pageItems[pageItems.length - 1]?.id ?? '');
      if (!upstreamBefore) break;
    }
  }
  if (demoActive && (!provider || provider === 'kimi')) {
    for (const session of listDemoSessions('kimi')) {
      if (rootNorm && normalizeWorkspaceRoot(session.metadata.cwd) !== rootNorm) continue;
      const demoDto = sessionDto(session, getDemoModel('kimi', session.id));
      if (excludeEmpty && isEmptyPlaceholderSession(demoDto, Boolean(demoDto.busy))) continue;
      items.push(demoDto);
    }
  }
  if (provider === 'kimi') {
    items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    let start = 0;
    if (beforeId) {
      const idx = items.findIndex((it) => String(it.id) === beforeId);
      if (idx === -1) return { items: [], has_more: false };
      start = idx + 1;
    }
    return { items: items.slice(start, start + limit), has_more: start + limit < items.length };
  }
  for (const p of LOCAL_PROVIDERS) {
    const pageItems = await listAllSessions(adapters[p], { archived: archivedOnly || undefined }).catch((err) => {
      console.error(`[gateway] listSessions: ${p}.list 失败:`, err instanceof Error ? err.message : err);
      return [] as Session[];
    });
    const storedMap = buildStoredWorkspaceIdMap(workspaceStore, p);
    for (const s of mergeDemoSessions(p, pageItems, demoActive)) {
      if (archivedOnly ? s.archived !== true : s.archived === true) continue;
      if (workspaceId) {
        if (!rootNorm) continue;
        const cwd = typeof s.metadata?.cwd === 'string' ? String(s.metadata.cwd) : '';
        if (normalizeWorkspaceRoot(cwd) !== rootNorm) continue;
      }
      const dto = sessionDto(s, adapters[p].getModel?.(s.id) ?? getDemoModel(p, s.id), adapters[p].getUsage?.(s.id), busyOf(prefixedId(p, s.id)), storedMap);
      if (excludeEmpty && isEmptyPlaceholderSession(dto, Boolean(dto.busy))) continue;
      items.push(dto);
    }
  }
  items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  let start = 0;
  if (beforeId) {
    const idx = items.findIndex((it) => String(it.id) === beforeId);
    // before_id 已消失(会话被删/过滤):返回空页并终止翻页,避免重复回顶部。
    if (idx === -1) return { items: [], has_more: false };
    start = idx + 1;
  }
  return { items: items.slice(start, start + limit), has_more: start + limit < items.length };
}

async function createLocalSession(
  adapters: Record<LocalProviderName, ProviderAdapter>,
  body: unknown,
  provider: LocalProviderName,
  workspaceStore?: SettingsStore,
): Promise<Record<string, unknown>> {
  const b = body as { metadata?: { cwd?: string }; cwd?: string; workspace_id?: string; title?: string };
  let resolvedWorkspaceRoot: string | undefined;
  if (!b.metadata?.cwd && !b.cwd && typeof b.workspace_id === 'string' && b.workspace_id) {
    const storedHit = readStoredWorkspaces(workspaceStore, provider).find((w) => w.id === b.workspace_id);
    if (storedHit) {
      resolvedWorkspaceRoot = storedHit.root;
    } else {
      const all = await listWorkspaces(adapters, null, provider, false, workspaceStore).catch(() => ({ items: [] }));
      const hit = ((all as { items?: Array<Record<string, unknown>> }).items ?? []).find((w) => w.id === b.workspace_id);
      if (typeof hit?.root === 'string' && hit.root) {
        resolvedWorkspaceRoot = hit.root;
      } else {
        throw new ProviderError('not_found', `workspace not found: ${b.workspace_id}`, 404);
      }
    }
  }
  const rawCwd = b.metadata?.cwd ?? b.cwd ?? resolvedWorkspaceRoot ?? os.homedir();
  const cwd = path.resolve(rawCwd);
  const adapter = adapters[provider];
  const caps = adapter.capabilities();
  const createCfg = (b as {
    agent_config?: {
      model?: string;
      thinking?: string;
      permission_mode?: string;
      plan_mode?: boolean;
    };
  }).agent_config;
  if (createCfg?.permission_mode === 'manual' && (caps.manualApproval === false || caps.approvals === false)) {
    throw new ProviderError('unsupported', `${provider} 不支持 manual 审批模式`, 400);
  }
  if (createCfg?.plan_mode === true && (caps.planMode === false || !adapter.setPlanMode)) {
    throw new ProviderError('unsupported', `${provider} 不支持 plan_mode`, 400);
  }
  const session = await adapter.create({ provider, cwd, title: b.title, metadata: b.metadata });
  // 新建会话时前端已让用户选了模型/thinking(composer 的 pick 随 create 一起
  // 来);不应用的话首轮 turn 会跑在默认模型上,UI 却显示用户的选择(审查发现)。
  if (createCfg?.model && adapter.setModel) await adapter.setModel(session.id, createCfg.model);
  if (typeof createCfg?.thinking === 'string' && adapter.setThinking) {
    await adapter.setThinking(session.id, createCfg.thinking);
  }
  if (typeof createCfg?.permission_mode === 'string' && adapter.setPermission) {
    await adapter.setPermission(session.id, createCfg.permission_mode);
  }
  if (typeof createCfg?.plan_mode === 'boolean' && caps.planMode !== false && adapter.setPlanMode) {
    await adapter.setPlanMode(session.id, createCfg.plan_mode);
  }
  return sessionDto(session, adapter.getModel?.(session.id), adapter.getUsage?.(session.id));
}

async function getSession(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  demoActive: boolean,
): Promise<Session> {
  if (demoActive) {
    const demo = getDemoSession(provider, nativeId);
    if (demo) return demo;
  }
  // 沿 provider 原生 cursor 查找,不能只看第一页或用固定 500 截断,
  // 否则较老的真实会话会被伪造成新会话。
  let cursor: string | undefined;
  const seen = new Set<string>();
  try {
    for (;;) {
      const page = await adapter.list({ limit: 100, cursor });
      const found = page.items.find((session) => session.id === nativeId);
      if (found) return found;
      if (!page.next_cursor || seen.has(page.next_cursor)) break;
      seen.add(page.next_cursor);
      cursor = page.next_cursor;
    }
  } catch (err) {
    console.error(`[gateway] getSession: ${provider}.list 失败:`, err instanceof Error ? err.message : err);
  }
  // 新建但尚未落盘的会话只存在于 adapter 内存态；有真实 cwd 才能造
  // 最小 DTO。未知/已删除 id 必须 404，不能伪造成 HOME 下的空会话。
  const cwd = adapter.getCwd?.(nativeId);
  if (!cwd) throw new ProviderError('not_found', `${provider} session not found: ${nativeId}`, 404);
  return {
    id: nativeId,
    workspace_id: '',
    title: `${provider} ${nativeId.slice(0, 8)}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    busy: false,
    metadata: { cwd },
    provider,
  };
}

// ---------------------------------------------------------------------------
// snapshot / prompts
// ---------------------------------------------------------------------------

/** 快照只带最后一页消息(前端 load-older 页大小=50);更早的走 /messages?before_id 翻页。 */
const SNAPSHOT_MESSAGE_PAGE = 50;

function findActiveTurnHistoryStartIndex(history: readonly Message[], active: ActiveTurn): number {
  if (history.length === 0) return -1;

  const activePromptIds = new Set<string>();
  if (active.promptId) activePromptIds.add(active.promptId);
  for (const item of active.v262Items) {
    if (Array.isArray(item.prompt_ids)) {
      for (const pid of item.prompt_ids) if (typeof pid === 'string') activePromptIds.add(pid);
    }
    if (typeof item.prompt_id === 'string') activePromptIds.add(item.prompt_id);
  }

  const activeToolCallIds = new Set<string>();
  for (const item of active.v262Items) {
    if (item.type === 'tool_call' && typeof item.item_id === 'string') {
      activeToolCallIds.add(item.item_id);
    }
    if (typeof item.tool_call_id === 'string') {
      activeToolCallIds.add(item.tool_call_id);
    }
  }
  for (const tid of active.runningTools.keys()) {
    activeToolCallIds.add(tid);
  }
  for (const [aid, a] of active.pendingApprovals.entries()) {
    activeToolCallIds.add(aid);
    if (a.itemId) activeToolCallIds.add(a.itemId);
  }

  const activeOpener = active.v262Items.find((it) => it.type === 'user_message' && it.placement === 'opener')
    ?? active.v262Items.find((it) => it.type === 'user_message')
    ?? active.v262Items[0];
  const activeOpenerText = (typeof activeOpener?.text === 'string' ? activeOpener.text : '').trim();

  const activeStartedMs = Date.parse(active.v262StartedAt) || Date.now();

  const isOpenerMessage = (msg: Message): boolean => {
    if (msg.role !== 'user') return false;
    if (msg.metadata?.bash_card) return false;
    const text = msg.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    const hasAttachments = msg.content.some((p) => p.type === 'image' || p.type === 'file' || p.type === 'document');
    const isToolOnly = !text.trim() && !hasAttachments && msg.content.some((p) => p.type === 'tool_result' || p.type === 'tool_use' || p.type === 'tool_call');
    return !isToolOnly;
  };

  const openerIndices: number[] = [];
  for (let i = 0; i < history.length; i++) {
    if (isOpenerMessage(history[i])) openerIndices.push(i);
  }

  // Signal 1: Prompt ID or Tool Call ID match in history
  let earliestMatchIdx = -1;
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    let matched = false;
    if (activePromptIds.has(msg.id)) matched = true;
    if (typeof msg.metadata?.prompt_id === 'string' && activePromptIds.has(msg.metadata.prompt_id)) matched = true;
    if (Array.isArray(msg.metadata?.prompt_ids)) {
      for (const pid of msg.metadata.prompt_ids) {
        if (typeof pid === 'string' && activePromptIds.has(pid)) {
          matched = true;
          break;
        }
      }
    }
    if (!matched && activeToolCallIds.size > 0) {
      for (const part of msg.content) {
        if (part.type === 'tool_call' && activeToolCallIds.has(part.id)) { matched = true; break; }
        if (part.type === 'tool_use' && activeToolCallIds.has(part.tool_call_id)) { matched = true; break; }
        if (part.type === 'tool_result' && activeToolCallIds.has(part.tool_call_id)) { matched = true; break; }
      }
      if (!matched && msg.metadata?.bash_card) {
        const card = msg.metadata.bash_card as Record<string, unknown>;
        if (typeof card.tool_call_id === 'string' && activeToolCallIds.has(card.tool_call_id)) matched = true;
      }
    }
    if (matched) {
      earliestMatchIdx = i;
      break;
    }
  }

  if (earliestMatchIdx >= 0) {
    const matchingOpener = openerIndices.filter((idx) => idx <= earliestMatchIdx).pop();
    if (matchingOpener !== undefined) {
      if (activeOpenerText) {
        const candidateEarlier = openerIndices.find((idx) => {
          if (idx >= matchingOpener) return false;
          const msg = history[idx];
          const text = msg.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('\n').trim();
          const msgMs = Date.parse(msg.created_at) || 0;
          return text === activeOpenerText && msgMs >= activeStartedMs - 15_000;
        });
        if (candidateEarlier !== undefined) return candidateEarlier;
      }
      return matchingOpener;
    }
    return earliestMatchIdx;
  }

  // Signal 2: No tool calls / prompt IDs yet. Check opener text & timestamp
  if (activeOpenerText && openerIndices.length > 0) {
    for (let j = openerIndices.length - 1; j >= 0; j--) {
      const idx = openerIndices[j];
      const msg = history[idx];
      const text = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
        .trim();
      const msgMs = Date.parse(msg.created_at) || 0;
      if (text === activeOpenerText && msgMs >= activeStartedMs - 15_000) {
        const hasOlderCompletedAssistant = history.slice(idx + 1).some((m) => {
          if (m.role !== 'assistant') return false;
          const asstMs = Date.parse(m.created_at) || 0;
          return asstMs > 0 && asstMs < activeStartedMs - 1_000;
        });
        if (!hasOlderCompletedAssistant) {
          return idx;
        }
      }
    }
  }

  return -1;
}

function filterHistoryPriorToActive(history: Message[], active?: ActiveTurn): Message[] {
  if (!active || history.length === 0) return history;
  const startIdx = findActiveTurnHistoryStartIndex(history, active);
  if (startIdx < 0) return history;
  return history.slice(0, startIdx);
}

async function snapshot(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  hub: SessionHub,
  demoActive: boolean,
): Promise<Record<string, unknown>> {
  const sid = prefixedId(provider, nativeId);
  const [session, history, wireTasks] = await Promise.all([
    getSession(adapter, provider, nativeId, demoActive),
    historyWithDemo(adapter, provider, nativeId, demoActive),
    collectSessionWireTasks(adapter, nativeId, sid, hub),
  ]);
  const active = hub.busy.get(sid);
  const subagents = wireTasks
    .filter((t) => t.kind === 'subagent')
    .map((t) => ({
      agent_id: t.child_agent_id ?? t.task_id,
      ...(t.parent_tool_call_id ? { parent_tool_call_id: t.parent_tool_call_id } : {}),
      ...(t.description ? { description: t.description } : {}),
      status: t.status,
      ...(t.outcome ? { outcome: t.outcome } : {}),
    }));
  const visibleHistory = active ? filterHistoryPriorToActive(history, active) : history;
  return {
    as_of_seq: hub.nextSeq(),
    epoch: hub.epoch,
    session: sessionDto(session, adapter.getModel?.(nativeId) ?? getDemoModel(provider, nativeId), adapter.getUsage?.(nativeId), active !== undefined),
    // 对齐 kap-server:快照=最后一页 + has_more。全量塞进来会让大会话
    // (几千条)首屏传输/渲染爆炸,前端表现为"会话无响应"。
    messages: {
      items: visibleHistory.slice(-SNAPSHOT_MESSAGE_PAGE).map((m) => messageDto(m, sid)),
      has_more: visibleHistory.length > SNAPSHOT_MESSAGE_PAGE,
    },
    in_flight_turn: active
      ? {
          turn_id: active.turnId,
          assistant_text: active.assistantText,
          thinking_text: active.thinkingText,
          running_tools: [...active.runningTools.entries()].map(([id, t]) => ({
            tool_call_id: id, name: t.name, args: t.args ?? null, description: null, last_progress: null,
          })),
          current_prompt_id: active.promptId,
        }
      : null,
    subagents,
    pending_approvals: pendingApprovals(sid, hub),
    pending_questions: pendingQuestions(sid, hub),
  };
}

function messageDto(m: Message, sid: string): Record<string, unknown> {
  return {
    id: m.id,
    session_id: sid,
    role: m.role,
    content: m.content.map(toKimiMessageContent),
    created_at: m.created_at,
    ...(m.metadata ? { metadata: m.metadata } : {}),
  };
}

/** 历史 REST 必须发 Kimi Web wire 形状,内部 adapter 字段不能原样透传。 */
function toKimiMessageContent(part: Message['content'][number]): Record<string, unknown> {
  if (part.type === 'thinking') {
    return { type: 'thinking', thinking: part.thinking ?? part.text ?? '' };
  }
  if (part.type === 'tool_call') {
    return { type: 'tool_use', tool_call_id: part.id, tool_name: part.name, input: part.input };
  }
  if (part.type === 'tool_use') {
    return { type: 'tool_use', tool_call_id: part.tool_call_id, tool_name: part.tool_name, input: part.input };
  }
  if (part.type === 'tool_result') {
    return {
      type: 'tool_result',
      tool_call_id: part.tool_call_id,
      output: part.output ?? part.content ?? '',
      is_error: part.is_error === true,
    };
  }
  return part;
}

async function listAdapterMessages(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  url: URL,
  demoActive: boolean,
): Promise<Record<string, unknown>> {
  let messages = [...await historyWithDemo(adapter, provider, nativeId, demoActive)].reverse();
  const beforeId = url.searchParams.get('before_id');
  const afterId = url.searchParams.get('after_id');
  const cursor = beforeId ?? afterId;
  const cursorIndex = cursor ? messages.findIndex((message) => message.id === cursor) : -1;
  if (cursorIndex >= 0) {
    messages = beforeId ? messages.slice(cursorIndex + 1) : messages.slice(0, cursorIndex);
  }

  const requestedSize = Number(url.searchParams.get('page_size') ?? 50);
  const pageSize = Number.isFinite(requestedSize)
    ? Math.min(100, Math.max(1, Math.trunc(requestedSize)))
    : 50;
  const hasMore = messages.length > pageSize;
  let page = messages.slice(0, pageSize);
  const role = url.searchParams.get('role');
  if (role) page = page.filter((message) => message.role === role);

  const sid = prefixedId(provider, nativeId);
  return { items: page.map((message) => messageDto(message, sid)), has_more: hasMore };
}

function listPrompts(sid: string, hub: SessionHub): Record<string, unknown> {
  const prompts = hub.transcript.currentPrompts(sid);
  const toWire = (prompt: (typeof prompts)[number]) => ({
    prompt_id: prompt.promptId,
    user_message_id: prompt.userMessageId ?? prompt.promptId,
    origin: (prompt as { origin?: unknown }).origin ?? { kind: 'user' },
    status: prompt.status,
    content: prompt.content,
    created_at: prompt.createdAt,
  });
  const active = prompts.find((prompt) => prompt.status === 'running' || prompt.status === 'blocked');
  return {
    active: active ? toWire(active) : null,
    queued: prompts.filter((prompt) => prompt.status === 'queued').map(toWire),
  };
}

/**
 * 解析 prompt 提交体:text 部分拼接;image/video/file 附件翻译成
 * TurnAttachment(网关上传单 → 磁盘路径;base64 → data URL;http URL
 * 诚实降级为文字引用——codex turn/start 的 image 项只收 data URL)。
 * 上传单丢失(重启后内存元数据没了)时降级为文字说明,不让 prompt 整个失败。
 */
function extractAttachments(
  content: Array<Record<string, unknown>>,
  uploadStore: UploadStore,
): { text: string; attachments: TurnAttachment[] } {
  const texts: string[] = [];
  const attachments: TurnAttachment[] = [];
  for (const c of content ?? []) {
    const type = c.type as string | undefined;
    if (type === 'text') {
      const t = typeof c.text === 'string' ? c.text : '';
      if (t) texts.push(t);
      continue;
    }
    if (type === 'image' || type === 'video') {
      const src = c.source as Record<string, unknown> | undefined;
      const kind = src?.kind as string | undefined;
      if (kind === 'file' && typeof src?.file_id === 'string') {
        const meta = uploadStore.get(src.file_id);
        if (!meta) {
          texts.push(`[attached ${type} unavailable: upload expired]`);
          continue;
        }
        const p = uploadStore.filePath(meta.id);
        // codex 有 localImage 没有 video 输入项:图片给路径,视频物化成文本。
        attachments.push(
          type === 'image' && meta.media_type.startsWith('image/')
            ? { kind: 'localImage', path: p, name: meta.name, mediaType: meta.media_type, size: meta.size }
            : { kind: 'filePathText', path: p, name: meta.name, mediaType: meta.media_type, size: meta.size },
        );
        continue;
      }
      if (kind === 'base64' && typeof src?.data === 'string' && type === 'image') {
        const mime = typeof src.media_type === 'string' ? src.media_type : 'image/png';
        attachments.push({ kind: 'imageDataUrl', dataUrl: `data:${mime};base64,${src.data}`, mediaType: mime });
        continue;
      }
      if (kind === 'url' && typeof src?.url === 'string') {
        texts.push(`[attached ${type}: ${src.url}]`);
        continue;
      }
      continue;
    }
    if (type === 'file') {
      const fileId = c.file_id as string | undefined;
      const meta = fileId ? uploadStore.get(fileId) : undefined;
      if (meta) {
        attachments.push({ kind: 'filePathText', path: uploadStore.filePath(meta.id), name: meta.name, mediaType: meta.media_type, size: meta.size });
      } else {
        texts.push(`[attached file unavailable: ${String(c.name ?? 'unknown')}]`);
      }
    }
  }
  return { text: sanitizePromptSkillChips(texts.join('\n')), attachments };
}

function queuedContentBlocks(text: string, attachments: TurnAttachment[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ type: 'text', text }];
  for (const att of attachments) {
    out.push({
      type: att.kind === 'localImage' || att.kind === 'imageDataUrl' ? 'image' : 'file',
      ...(att.name ? { name: att.name } : {}),
      ...(att.path ? { path: att.path } : {}),
      ...(att.mediaType ? { media_type: att.mediaType } : {}),
      ...(att.size !== undefined ? { size: att.size } : {}),
    });
  }
  return out;
}

async function submitPrompt(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  body: { prompt_id?: string; content: Array<Record<string, unknown>> },
  hub: SessionHub,
  demoActive: boolean,
  uploadStore: UploadStore,
): Promise<Record<string, unknown>> {
  const sid = prefixedId(provider, nativeId);
  const { text, attachments } = extractAttachments(body.content ?? [], uploadStore);
  if (!text.trim() && attachments.length === 0) throw new ProviderError('invalid_request', 'empty prompt', 400);
  const requestedPromptId = typeof body.prompt_id === 'string' && body.prompt_id.trim()
    ? body.prompt_id.trim()
    : undefined;

  const cmd = isLocalProvider(provider)
    ? /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim())
    : null;
  if (cmd && provider === 'codex' && codexGatewayCommandNames().has(cmd[1])) {
    if (hub.busy.has(sid)) throw new ProviderError('busy', 'session busy: 当前 turn 结束后再执行命令', 409);
    const [, name, rawArgs] = cmd;
    const argsText = (rawArgs ?? '').trim();
    if (name === 'review') {
      if (!adapter.review) throw new ProviderError('unsupported', 'review 不可用', 400);
      const reviewOptions = parseCodexReviewOptions(argsText);
      const promptLabel = argsText ? `/review ${argsText}` : '/review';
      return driveTurn(
        adapter,
        provider,
        nativeId,
        promptLabel,
        () => adapter.review!(nativeId, reviewOptions),
        hub,
        requestedPromptId ?? randomUUID(),
        undefined,
        demoActive,
        uploadStore,
      );
    }
    return runLocalGatewayCommand(adapter, provider, nativeId, name, argsText, hub, requestedPromptId, demoActive, uploadStore);
  }
  if (
    cmd
    && provider === 'grok'
    && (grokGatewayCommandNames().has(cmd[1]) || grokUnsupportedTuiCommandNames().has(cmd[1]))
  ) {
    if (hub.busy.has(sid)) throw new ProviderError('busy', 'session busy: 当前 turn 结束后再执行命令', 409);
    const [, name, rawArgs] = cmd;
    return runLocalGatewayCommand(adapter, provider, nativeId, name, (rawArgs ?? '').trim(), hub, requestedPromptId, demoActive, uploadStore);
  }
  if (cmd && provider === 'pi') {
    if (cmd[1] === 'undo') {
      throw new ProviderError('unsupported', 'pi 不支持 /undo', 400);
    }
    if (cmd[1] === 'advisor') {
      if (hub.busy.has(sid)) throw new ProviderError('busy', 'session busy: 当前 turn 结束后再执行命令', 409);
      return runInteractivePiAdvisor(adapter, nativeId, (cmd[2] ?? '').trim(), hub, requestedPromptId, demoActive, uploadStore);
    }
    if (cmd[1] === 'plan' && !(cmd[2] ?? '').trim()) {
      const piCmds = adapter.listCommands ? await adapter.listCommands(nativeId).catch(() => [] as NativeCommand[]) : [];
      if (piCmds.some((c) => c.name === 'plan')) {
        if (hub.busy.has(sid)) throw new ProviderError('busy', 'session busy: 当前 turn 结束后再执行命令', 409);
        return runInteractivePiPlanMenu(adapter, nativeId, hub, requestedPromptId, demoActive, uploadStore);
      }
    }
    if (piGatewayCommandNames().has(cmd[1]) || piUnsupportedTuiCommandNames().has(cmd[1])) {
      if (hub.busy.has(sid)) throw new ProviderError('busy', 'session busy: 当前 turn 结束后再执行命令', 409);
      const [, name, rawArgs] = cmd;
      return runLocalGatewayCommand(adapter, provider, nativeId, name, (rawArgs ?? '').trim(), hub, requestedPromptId, demoActive, uploadStore);
    }
  }
  if (cmd && provider === 'claude') {
    if (cmd[1] === 'undo') {
      throw new ProviderError('unsupported', 'claude 不支持 /undo', 400);
    }
    if (claudeGatewayCommandNames().has(cmd[1]) || claudeUnsupportedTuiCommandNames().has(cmd[1])) {
      if (hub.busy.has(sid)) throw new ProviderError('busy', 'session busy: 当前 turn 结束后再执行命令', 409);
      const [, name, rawArgs] = cmd;
      return runLocalGatewayCommand(adapter, provider, nativeId, name, (rawArgs ?? '').trim(), hub, requestedPromptId, demoActive, uploadStore);
    }
  }
  if (cmd && provider === 'dsh') {
    if (cmd[1] === 'undo' || cmd[1] === 'fork' || cmd[1] === 'compact' || cmd[1] === 'goal' || cmd[1] === 'plan') {
      throw new ProviderError('unsupported', `dsh 不支持 /${cmd[1]}`, 400);
    }
    if (dshGatewayCommandNames().has(cmd[1])) {
      if (hub.busy.has(sid)) throw new ProviderError('busy', 'session busy: 当前 turn 结束后再执行命令', 409);
      const [, name, rawArgs] = cmd;
      return runLocalGatewayCommand(adapter, provider, nativeId, name, (rawArgs ?? '').trim(), hub, requestedPromptId, demoActive, uploadStore);
    }
  }

  // busy → 排队(对齐 kap-server:前端 steer 流依赖 status:'queued';队列里
  // 的 prompt 在当前 turn 结束后自动开自己的 turn,或被 prompts:steer 注入)。
  if (hub.busy.has(sid)) {
    const promptId = requestedPromptId ?? randomUUID();
    const createdAt = new Date().toISOString();
    const q = hub.queued.get(sid) ?? [];
    q.push({ promptId, text, attachments, createdAt });
    hub.queued.set(sid, q);
    const content = queuedContentBlocks(text, attachments);
    hub.transcript.submitPrompt(sid, promptId, 'queued', content, createdAt);
    return {
      prompt_id: promptId,
      user_message_id: promptId,
      origin: { kind: 'user' },
      status: 'queued',
      content,
      created_at: createdAt,
    };
  }

  return driveTurn(
    adapter,
    provider,
    nativeId,
    text,
    () => (demoActive && isDemoSession(provider, nativeId)
      ? Promise.resolve(demoStartTurn(provider, nativeId, text))
      : adapter.startTurn({ sessionId: nativeId, input: text, attachments })),
    hub,
    requestedPromptId ?? randomUUID(),
    undefined,
    demoActive,
    uploadStore,
  );
}

async function steerDirectPrompt(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  body: { prompt_id?: string; content: Array<Record<string, unknown>> },
  hub: SessionHub,
  uploadStore: UploadStore,
): Promise<Record<string, unknown>> {
  const sid = prefixedId(provider, nativeId);
  const active = hub.busy.get(sid);
  if (!active || !active.turnId) {
    throw new ProviderError('not_found', 'PROMPT_NOT_FOUND: no active turn to steer into', 404);
  }
  const caps = adapter.capabilities();
  if (caps.steer === false || !adapter.steer) {
    throw new ProviderError('unsupported', `${provider} 不支持 steer`, 400);
  }
  const { text, attachments } = extractAttachments(body.content ?? [], uploadStore);
  if (!text.trim() && attachments.length === 0) {
    throw new ProviderError('invalid_request', 'empty steer prompt', 400);
  }
  let steerText = text;
  if (attachments.length > 0 && caps.steerAttachments !== true) {
    const notes = attachments
      .map((a) => a.path
        ? `[attached ${a.kind === 'localImage' ? 'image' : 'file'}: ${a.path}]`
        : `[attached ${a.kind}]`)
      .join('\n');
    steerText = steerText ? `${steerText}\n${notes}` : notes;
  }
  if (caps.steerAttachments === true && attachments.length > 0) {
    await adapter.steer(nativeId, active.turnId, steerText, attachments);
  } else {
    await adapter.steer(nativeId, active.turnId, steerText);
  }
  const promptId = typeof body.prompt_id === 'string' && body.prompt_id.trim()
    ? body.prompt_id.trim()
    : randomUUID();
  const createdAt = new Date().toISOString();
  const msgContent = queuedContentBlocks(text, attachments);
  emitV262SteerUserItem(hub, sid, active, promptId, text, attachments);
  hub.broadcast(sid, frame(sid, hub, 'event.message.created', {
    message: {
      id: randomUUID(), session_id: sid, role: 'user', prompt_id: promptId,
      content: msgContent, created_at: createdAt,
    },
  }));
  hub.transcript.submitPrompt(sid, promptId, 'queued', msgContent, createdAt);
  hub.transcript.steerPrompts(sid, active.promptId, [promptId], msgContent);
  return {
    prompt_id: promptId,
    user_message_id: promptId,
    origin: { kind: 'user' },
    status: 'running',
    content: msgContent,
    created_at: createdAt,
  };
}

/**
 * 驱动一个 turn:忙态占位 → 起手帧 → 获取 TurnHandle(失败广播终态)→
 * 后台消费事件流 → 终态广播 → 排队中的下一个 prompt 接力。
 */
async function driveTurn(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  text: string,
  acquire: () => Promise<TurnHandle>,
  hub: SessionHub,
  promptId: string = randomUUID(),
  onSettled?: (reason: 'completed' | 'failed') => void,
  demoActive: boolean = false,
  uploadStore?: UploadStore,
): Promise<Record<string, unknown>> {
  const sid = prefixedId(provider, nativeId);
  const turn = newActiveTurn(nativeId, promptId);
  hub.busy.set(sid, turn);
  const startedAt = Date.now();
  const createdAt = new Date(startedAt).toISOString();
  turn.v262StartedAt = createdAt;
  hub.transcript.submitPrompt(sid, promptId, 'running', [{ type: 'text', text }], createdAt);
  // startTurn 与历史读取并行。用 settled 结果承接 rejection，避免历史较慢时
  // acquire 的拒绝先变成未处理 Promise。
  const acquired = acquire().then(
    (handle) => ({ ok: true as const, handle }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!hub.transcript.hasObservedHistory(sid)) {
    const history = await tryHistoryWithDemo(adapter, provider, nativeId, demoActive);
    if (history !== null && !hub.transcript.hasObservedHistory(sid) && history.length > 0) {
      const historyPrior = filterHistoryPriorToActive(history, turn);
      hub.transcript.observeHistory(sid, historyPrior);
    }
  }
  const emit = (type: string, payload: Record<string, unknown>, volatile = false, offset?: number): void =>
    hub.broadcast(sid, frame(sid, hub, type, payload, volatile, offset));

  // abort 可能在历史读取窗口先清掉 busy。此时不能再创建一个永远 running
  // 的 transcript turn，也不能重新广播 turn.started。
  if (!turn.cancelled && hub.busy.get(sid) === turn) {
    turn.transcript = hub.transcript.beginTurn(sid, text, createdAt);
    turn.v262Ordinal = Math.max(0, turn.transcript.ordinal - 1);
    emit('session.meta.updated', { patch: { lastPrompt: text } });
    emit('event.session.work_changed', { busy: true, main_turn_active: true, pending_interaction: 'none' });
    emit('turn.started', { turnId: 0, origin: { kind: 'user' }, prompt: text });

    const openerItem: Record<string, unknown> = {
      item_id: `${promptId}_user`,
      type: 'user_message',
      placement: 'opener',
      origin: { kind: 'user' },
      text,
      prompt_ids: [promptId],
      attachments: [],
      skills: [],
      created_at: createdAt,
    };
    turn.v262Items.push(openerItem);
    turn.v262ItemMap.set(String(openerItem.item_id), openerItem);
    hub.broadcastV262(sid, {
      type: 'turn.started',
      session_id: sid,
      agent_id: 'main',
      turn: {
        turn_id: turn.v262TurnId,
        ordinal: turn.v262Ordinal,
        turn_number: turn.v262Ordinal + 1,
        kind: 'agent',
        status: 'running',
        started_at: createdAt,
        steps: [{ index: 0 }],
        items: [],
      },
    });
    hub.broadcastV262(sid, {
      type: 'item.started',
      session_id: sid,
      agent_id: 'main',
      turn_id: turn.v262TurnId,
      item: openerItem,
    });
    hub.broadcastV262(sid, {
      type: 'item.ended',
      session_id: sid,
      agent_id: 'main',
      turn_id: turn.v262TurnId,
      item: openerItem,
    });
    emitV262AgentState(hub, adapter, provider, nativeId, sid, 'running');
  }

  const acquireResult = await acquired;
  if (!acquireResult.ok) {
    // abort/后继 turn 已经接管时不能用迟到的 startTurn 失败覆盖其状态。
    if (hub.busy.get(sid) === turn) {
      hub.busy.delete(sid);
      const durationMs = Date.now() - startedAt;
      const errMsg = acquireResult.error instanceof Error ? acquireResult.error.message : String(acquireResult.error);
      turn.transcript?.end('failed', durationMs);
      hub.transcript.finishPrompt(sid, promptId, 'failed');
      emit('turn.ended', { turnId: 0, reason: 'failed', durationMs });
      emit('prompt.completed', { promptId, reason: 'failed' });
      emit('event.session.work_changed', { busy: false, main_turn_active: false, pending_interaction: 'none', last_turn_reason: 'failed' });
      hub.broadcastV262(sid, {
        type: 'turn.ended',
        session_id: sid,
        agent_id: 'main',
        turn: {
          turn_id: turn.v262TurnId,
          ordinal: turn.v262Ordinal,
          turn_number: turn.v262Ordinal + 1,
          kind: 'agent',
          status: 'ended',
          outcome: 'failed',
          duration_ms: durationMs,
          started_at: createdAt,
          ended_at: new Date().toISOString(),
          error: { message: errMsg },
          steps: [{ index: 0 }],
          items: [],
        },
      });
      emitV262AgentState(hub, adapter, provider, nativeId, sid, 'idle');
      drainQueue(adapter, provider, nativeId, hub, demoActive, uploadStore);
    }
    throw acquireResult.error;
  }
  const handle = acquireResult.handle;
  turn.turnId = handle.turnId;

  // abort 在 acquire/历史窗口到达:abortTurn 已广播终态,这里用真实
  // turnId 补一刀 interrupt,然后直接返回,不消费事件流。
  if (turn.cancelled || hub.busy.get(sid) !== turn) {
    await adapter.interrupt(nativeId, handle.turnId).catch(() => undefined);
    return {
      prompt_id: promptId,
      user_message_id: promptId,
      origin: { kind: 'user' },
      status: 'aborted',
      content: [{ type: 'text', text }],
      created_at: new Date().toISOString(),
    };
  }

  // step 状态机:tool.result 结束一个 step;新一段文本/工具前懒开 step。
  let stepActive = false;
  let step = 0;
  const ensureStep = (): void => {
    if (!stepActive) {
      turn.assistantText = '';
      turn.thinkingText = '';
      emit('turn.step.started', { turnId: 0, step });
      stepActive = true;
      turn.v262StepIndex = step;
    }
  };
  const completeStep = (state: 'completed' | 'failed' = 'completed'): void => {
    if (stepActive) {
      closeV262Thinking(hub, sid, turn);
      closeV262Assistant(hub, sid, turn);
      turn.transcript?.completeStep(state);
      emit('turn.step.completed', { turnId: 0, step, usage: {} });
      stepActive = false;
      step += 1;
      turn.v262StepIndex = step;
    }
  };

  // 后台消费事件流:累积文本 + 广播 WS + 清理忙态。
  void (async () => {
    let reason: 'completed' | 'failed' = 'completed';
    let turnError: string | undefined;
    let turnTruncated = false;
    try {
      for await (const ev of handle.events) {
        if (hub.busy.get(sid) !== turn) break;
        if (ev.kind === 'turn') {
          if (ev.status === 'failed' || ev.status === 'cancelled') {
            reason = 'failed';
            const errText = (ev.payload as { error?: string } | undefined)?.error;
            if (typeof errText === 'string' && errText) turnError = errText;
          }
          if ((ev.payload as { truncated?: boolean } | undefined)?.truncated === true) {
            turnTruncated = true;
          }
        }
        consumeEvent(ev, turn, emit, ensureStep, completeStep, sid, hub, provider);
      }
    } catch (err) {
      reason = 'failed';
      turnError = err instanceof Error ? err.message : String(err);
    } finally {
      if (turnTruncated) {
        const truncMsg = '⚠ 模型输出达到 token 上限已截断。';
        emitAssistantDeltaText(turn.assistantText ? `\n\n${truncMsg}` : truncMsg, turn, emit, ensureStep, sid, hub);
      }
      completeStep(reason === 'failed' ? 'failed' : 'completed');
      closeV262Thinking(hub, sid, turn);
      closeV262Assistant(hub, sid, turn);
      // Never leave a completed slash-command turn (e.g. a Pi extension command that
      // produced no text/tool/notice items) as a silent blank user bubble.
      if (reason === 'completed' && step === 0 && turn.v262Items.length <= 1) {
        const trimmedCmd = text.trim();
        const fallbackMsg = trimmedCmd.startsWith('/')
          ? `ℹ 命令 \`${trimmedCmd.split(/\s+/)[0]}\` 已处理（无输出内容；若该命令在本地终端使用自定义 TUI 面板 \`ctx.ui.custom()\`，Web 协议模式下可能无界面输出，可尝试带子命令参数运行或输入 \`/help\` 查看网页可用命令）。`
          : '✓ 已完成（无额外文本输出）。';
        emitAssistantDeltaText(fallbackMsg, turn, emit, ensureStep, sid, hub);
        completeStep('completed');
      }
      if (hub.busy.get(sid) === turn) {
        hub.busy.delete(sid);
        const durationMs = Date.now() - startedAt;
        turn.transcript?.end(reason, durationMs);
        hub.transcript.finishPrompt(sid, promptId, reason);
        emit('turn.ended', { turnId: 0, reason, durationMs });
        emit('prompt.completed', { promptId, reason });
        const pending = turn.pendingApprovals.size > 0 ? 'approval' : turn.pendingQuestions.size > 0 ? 'question' : 'none';
        emit('event.session.work_changed', { busy: false, main_turn_active: false, pending_interaction: pending, last_turn_reason: reason });
        hub.broadcastV262(sid, {
          type: 'turn.ended',
          session_id: sid,
          agent_id: 'main',
          turn: {
            turn_id: turn.v262TurnId,
            ordinal: turn.v262Ordinal,
            turn_number: turn.v262Ordinal + 1,
            kind: 'agent',
            status: 'ended',
            outcome: reason === 'failed' ? 'failed' : 'completed',
            duration_ms: durationMs,
            started_at: createdAt,
            ended_at: new Date().toISOString(),
            ...(reason === 'failed' && turnError ? { error: { message: turnError } } : {}),
            steps: Array.from({ length: Math.max(1, step) }, (_, idx) => ({ index: idx })),
            items: [],
          },
        });
        emitV262AgentState(hub, adapter, provider, nativeId, sid, 'idle');
        emitV262Usage(hub, adapter, provider, nativeId, sid);
        drainQueue(adapter, provider, nativeId, hub, demoActive, uploadStore);
        onSettled?.(reason);
      }
    }
  })();

  return {
    prompt_id: promptId,
    user_message_id: promptId,
    origin: { kind: 'user' },
    status: 'running',
    content: [{ type: 'text', text }],
    created_at: createdAt,
  };
}

/**
 * 排空会话队列:busy 已清时取队首开新 turn;startTurn 失败继续取下一个,
 * 直到队列空或某个 turn 成功起跑(它的终态会再次调本函数接力)。
 */
function drainQueue(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  hub: SessionHub,
  demoActive: boolean = false,
  uploadStore?: UploadStore,
): void {
  const sid = prefixedId(provider, nativeId);
  if (hub.busy.has(sid)) return;
  const next = hub.queued.get(sid)?.shift();
  if (!next) return;
  if ((hub.queued.get(sid)?.length ?? 0) === 0) hub.queued.delete(sid);
  void driveTurn(
    adapter,
    provider,
    nativeId,
    next.text,
    () => adapter.startTurn({ sessionId: nativeId, input: next.text, attachments: next.attachments }),
    hub,
    next.promptId,
    undefined,
    demoActive,
    uploadStore,
  ).catch((err: unknown) => {
    console.error('[gateway] 队列 prompt 接力失败:', err instanceof Error ? err.message : err);
    drainQueue(adapter, provider, nativeId, hub, demoActive, uploadStore);
  });
}

/**
 * 网关代执行命令(codex / grok / pi 非 turn 类):执行 RPC 并把结果作为系统响应广播。
 */
async function runLocalGatewayCommand(
  adapter: ProviderAdapter,
  provider: LocalProviderName,
  nativeId: string,
  name: string,
  argsText: string,
  hub: SessionHub,
  requestedPromptId?: string,
  demoActive: boolean = false,
  uploadStore?: UploadStore,
): Promise<Record<string, unknown>> {
  const sid = prefixedId(provider, nativeId);
  const promptId = requestedPromptId ?? randomUUID();
  const promptText = `/${name}${argsText ? ` ${argsText}` : ''}`;
  const emit = (type: string, payload: Record<string, unknown>, volatile = false, offset?: number): void =>
    hub.broadcast(sid, frame(sid, hub, type, payload, volatile, offset));
  const turn = newActiveTurn(nativeId, promptId);
  hub.busy.set(sid, turn);
  const startedAt = Date.now();
  const createdAt = new Date(startedAt).toISOString();
  let lastReason: 'completed' | 'failed' = 'completed';
  try {
    const history = await tryHistoryWithDemo(adapter, provider, nativeId, demoActive);
    if (history !== null && !hub.transcript.hasObservedHistory(sid) && history.length > 0) {
      const historyPrior = filterHistoryPriorToActive(history, turn);
      hub.transcript.observeHistory(sid, historyPrior);
    }
    const ordinal = history ? turnsFromHistory(history).length : 0;
    const v262TurnId = `turn_${promptId}`;
    hub.transcript.submitPrompt(sid, promptId, 'running', [{ type: 'text', text: promptText }], createdAt);
    const transcript = hub.transcript.beginTurn(sid, promptText, createdAt);
    emit('event.session.work_changed', { busy: true, main_turn_active: true, pending_interaction: 'none' });
    emit('turn.started', { turnId: 0, origin: { kind: 'user' }, prompt: promptText });
    const openerItem: Record<string, unknown> = {
      item_id: `${promptId}_user`,
      type: 'user_message',
      placement: 'opener',
      origin: { kind: 'user' },
      text: promptText,
      prompt_ids: [promptId],
      attachments: [],
      skills: [],
      created_at: createdAt,
    };
    hub.broadcastV262(sid, {
      type: 'turn.started',
      session_id: sid,
      agent_id: 'main',
      turn: {
        turn_id: v262TurnId,
        ordinal,
        turn_number: ordinal + 1,
        kind: 'agent',
        status: 'running',
        started_at: createdAt,
        steps: [{ index: 0 }],
        items: [],
      },
    });
    hub.broadcastV262(sid, { type: 'item.started', session_id: sid, agent_id: 'main', turn_id: v262TurnId, item: openerItem });
    hub.broadcastV262(sid, { type: 'item.ended', session_id: sid, agent_id: 'main', turn_id: v262TurnId, item: openerItem });
    emitV262AgentState(hub, adapter, provider, nativeId, sid, 'running');

    let output: string;
    let reason: 'completed' | 'failed' = 'completed';
    try {
      output = await (
        provider === 'grok'
          ? executeGrokCommand(adapter, nativeId, name, argsText)
          : provider === 'pi'
            ? executePiCommand(adapter, nativeId, name, argsText)
            : provider === 'claude'
              ? executeClaudeCommand(adapter, nativeId, name, argsText)
              : provider === 'dsh'
                ? executeDshCommand(adapter, nativeId, name, argsText)
                : executeCodexCommand(adapter, nativeId, name, argsText)
      );
      if (name === 'compact' || name === 'undo') {
        hub.transcript.invalidateHistory(sid);
      }
    } catch (err) {
      reason = 'failed';
      output = `✗ ${promptText} 执行失败:${err instanceof Error ? err.message : String(err)}`;
    }
    lastReason = reason;
    emit('turn.step.started', { turnId: 0, step: 0 });
    transcript.append('assistant', output);
    emit('assistant.delta', { turnId: 0, delta: output }, true, 0);
    transcript.completeStep(reason === 'completed' ? 'completed' : 'failed');
    emit('turn.step.completed', { turnId: 0, step: 0, usage: {} });
    const durationMs = Date.now() - startedAt;
    transcript.end(reason, durationMs);
    hub.transcript.finishPrompt(sid, promptId, reason);
    emit('turn.ended', { turnId: 0, reason, durationMs });
    emit('prompt.completed', { promptId, reason });

    const replyItem: Record<string, unknown> = {
      item_id: `${promptId}_reply`,
      type: 'assistant_message',
      status: 'ended',
      text: output,
      created_at: new Date().toISOString(),
      step_index: 0,
    };
    hub.broadcastV262(sid, { type: 'item.started', session_id: sid, agent_id: 'main', turn_id: v262TurnId, item: { ...replyItem, status: 'running', text: '' } });
    hub.broadcastV262(sid, { type: 'item.delta', session_id: sid, agent_id: 'main', turn_id: v262TurnId, item_id: replyItem.item_id, field: 'text', delta: output });
    hub.broadcastV262(sid, { type: 'item.ended', session_id: sid, agent_id: 'main', turn_id: v262TurnId, item: replyItem });
    hub.broadcastV262(sid, {
      type: 'turn.ended',
      session_id: sid,
      agent_id: 'main',
      turn: {
        turn_id: v262TurnId,
        ordinal,
        turn_number: ordinal + 1,
        kind: 'agent',
        status: 'ended',
        outcome: reason === 'failed' ? 'failed' : 'completed',
        duration_ms: durationMs,
        started_at: createdAt,
        ended_at: new Date().toISOString(),
        steps: [{ index: 0 }],
        items: [],
      },
    });
    return {
      prompt_id: promptId,
      user_message_id: promptId,
      origin: { kind: 'user' },
      status: 'running',
      content: [{ type: 'text', text: promptText }],
      created_at: createdAt,
    };
  } finally {
    if (hub.busy.get(sid) === turn) {
      hub.busy.delete(sid);
      emit('event.session.work_changed', { busy: false, main_turn_active: false, pending_interaction: 'none', last_turn_reason: lastReason });
      emitV262AgentState(hub, adapter, provider, nativeId, sid, 'idle');
      drainQueue(adapter, provider, nativeId, hub, demoActive, uploadStore);
    }
  }
}

function resolveRpivAdvisorConfigPath(): { primary: string; legacy: string } {
  const home = os.homedir();
  const defaultDir = path.join(home, '.config');
  const rawXdg = process.env.XDG_CONFIG_HOME?.trim() ?? '';
  let configDir = defaultDir;
  if (rawXdg) {
    const expanded = rawXdg === '~' ? home : rawXdg.startsWith('~/') ? path.join(home, rawXdg.slice(2)) : rawXdg;
    if (path.isAbsolute(expanded)) configDir = expanded;
  }
  return {
    primary: path.join(configDir, 'rpiv-advisor', 'advisor.json'),
    legacy: path.join(defaultDir, 'rpiv-advisor', 'advisor.json'),
  };
}

async function readRpivAdvisorConfig(): Promise<{ path: string; data: Record<string, unknown> }> {
  const paths = resolveRpivAdvisorConfigPath();
  for (const candidate of [paths.primary, paths.legacy]) {
    try {
      const raw = await fsp.readFile(candidate, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { path: paths.primary, data: parsed as Record<string, unknown> };
      }
    } catch {
      // try next
    }
  }
  return { path: paths.primary, data: {} };
}

async function writeRpivAdvisorConfig(targetPath: string, data: Record<string, unknown>): Promise<void> {
  const dir = path.dirname(targetPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.advisor.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmpPath, targetPath);
}

function extractFirstQuestionAnswer(payload: string | Record<string, string[]> | null, qId: string): string | null {
  if (payload === null) return null;
  if (typeof payload === 'string') return payload.trim() || null;
  const direct = payload[qId];
  if (Array.isArray(direct) && direct.length > 0 && typeof direct[0] === 'string' && direct[0].trim()) {
    return direct[0].trim();
  }
  for (const vals of Object.values(payload)) {
    if (Array.isArray(vals) && vals.length > 0 && typeof vals[0] === 'string' && vals[0].trim()) {
      return vals[0].trim();
    }
  }
  return null;
}

async function askLocalTurnQuestion(
  hub: SessionHub,
  sid: string,
  turn: ActiveTurn,
  emit: Emit,
  promptText: string,
  rawQuestions: unknown[],
): Promise<string | Record<string, string[]> | null> {
  const questionId = `local_q_${randomUUID()}`;
  turn.pendingQuestions.set(questionId, { prompt: promptText, rawQuestions });
  if (!turn.localQuestionResolvers) turn.localQuestionResolvers = new Map();
  const wait = new Promise<string | Record<string, string[]> | null>((resolve) => {
    turn.localQuestionResolvers!.set(questionId, resolve);
  });
  const request = questionDto(sid, questionId, { prompt: promptText, rawQuestions });
  hub.transcript.requestInteraction(sid, {
    interactionId: questionId,
    interactionKind: 'question',
    state: 'pending',
    request,
  });
  emit('event.question.requested', request);
  emit('event.session.work_changed', { busy: true, main_turn_active: true, pending_interaction: 'question' });
  hub.broadcastV262(sid, v262PendingQuestionFrame(sid, questionId, undefined, { prompt: promptText, rawQuestions }));
  return wait;
}

async function beginLocalInteractiveTurn(
  adapter: ProviderAdapter,
  provider: LocalProviderName,
  nativeId: string,
  promptText: string,
  hub: SessionHub,
  requestedPromptId: string | undefined,
  demoActive: boolean,
): Promise<{
  sid: string;
  promptId: string;
  startedAt: number;
  createdAt: string;
  turn: ActiveTurn;
  emit: Emit;
  finishWithText: (output: string, reason?: 'completed' | 'failed') => void;
}> {
  const sid = prefixedId(provider, nativeId);
  const promptId = requestedPromptId ?? randomUUID();
  const emit: Emit = (type, payload, volatile = false, offset) =>
    hub.broadcast(sid, frame(sid, hub, type, payload, volatile, offset));
  const turn = newActiveTurn(nativeId, promptId);
  hub.busy.set(sid, turn);
  const startedAt = Date.now();
  const createdAt = new Date(startedAt).toISOString();
  turn.v262StartedAt = createdAt;
  const history = await tryHistoryWithDemo(adapter, provider, nativeId, demoActive);
  if (history !== null && !hub.transcript.hasObservedHistory(sid) && history.length > 0) {
    const historyPrior = filterHistoryPriorToActive(history, turn);
    hub.transcript.observeHistory(sid, historyPrior);
  }
  turn.transcript = hub.transcript.beginTurn(sid, promptText, createdAt);
  turn.v262Ordinal = Math.max(0, turn.transcript.ordinal - 1);
  hub.transcript.submitPrompt(sid, promptId, 'running', [{ type: 'text', text: promptText }], createdAt);
  emit('session.meta.updated', { patch: { lastPrompt: promptText } });
  emit('event.session.work_changed', { busy: true, main_turn_active: true, pending_interaction: 'none' });
  emit('turn.started', { turnId: 0, origin: { kind: 'user' }, prompt: promptText });
  const openerItem: Record<string, unknown> = {
    item_id: `${promptId}_user`,
    type: 'user_message',
    placement: 'opener',
    origin: { kind: 'user' },
    text: promptText,
    prompt_ids: [promptId],
    attachments: [],
    skills: [],
    created_at: createdAt,
  };
  turn.v262Items.push(openerItem);
  turn.v262ItemMap.set(String(openerItem.item_id), openerItem);
  hub.broadcastV262(sid, {
    type: 'turn.started',
    session_id: sid,
    agent_id: 'main',
    turn: {
      turn_id: turn.v262TurnId,
      ordinal: turn.v262Ordinal,
      turn_number: turn.v262Ordinal + 1,
      kind: 'agent',
      status: 'running',
      started_at: createdAt,
      steps: [{ index: 0 }],
      items: [],
    },
  });
  hub.broadcastV262(sid, { type: 'item.started', session_id: sid, agent_id: 'main', turn_id: turn.v262TurnId, item: openerItem });
  hub.broadcastV262(sid, { type: 'item.ended', session_id: sid, agent_id: 'main', turn_id: turn.v262TurnId, item: openerItem });
  emitV262AgentState(hub, adapter, provider, nativeId, sid, 'running');

  const finishWithText = (output: string, reason: 'completed' | 'failed' = 'completed'): void => {
    if (hub.busy.get(sid) !== turn) return;
    emit('turn.step.started', { turnId: 0, step: 0 });
    emitAssistantDeltaText(output, turn, emit, () => undefined, sid, hub);
    closeV262Thinking(hub, sid, turn);
    closeV262Assistant(hub, sid, turn);
    turn.transcript?.completeStep(reason === 'completed' ? 'completed' : 'failed');
    emit('turn.step.completed', { turnId: 0, step: 0, usage: {} });
    hub.busy.delete(sid);
    const durationMs = Date.now() - startedAt;
    turn.transcript?.end(reason, durationMs);
    hub.transcript.finishPrompt(sid, promptId, reason);
    emit('turn.ended', { turnId: 0, reason, durationMs });
    emit('prompt.completed', { promptId, reason });
    emit('event.session.work_changed', { busy: false, main_turn_active: false, pending_interaction: 'none', last_turn_reason: reason });
    hub.broadcastV262(sid, {
      type: 'turn.ended',
      session_id: sid,
      agent_id: 'main',
      turn: {
        turn_id: turn.v262TurnId,
        ordinal: turn.v262Ordinal,
        turn_number: turn.v262Ordinal + 1,
        kind: 'agent',
        status: 'ended',
        outcome: reason === 'failed' ? 'failed' : 'completed',
        duration_ms: durationMs,
        started_at: createdAt,
        ended_at: new Date().toISOString(),
        steps: [{ index: 0 }],
        items: [],
      },
    });
    emitV262AgentState(hub, adapter, provider, nativeId, sid, 'idle');
  };

  return { sid, promptId, startedAt, createdAt, turn, emit, finishWithText };
}

async function runInteractivePiAdvisor(
  adapter: ProviderAdapter,
  nativeId: string,
  argsText: string,
  hub: SessionHub,
  requestedPromptId: string | undefined,
  demoActive: boolean,
  uploadStore: UploadStore,
): Promise<Record<string, unknown>> {
  const promptText = argsText ? `/advisor ${argsText}` : '/advisor';
  const ctx = await beginLocalInteractiveTurn(adapter, 'pi', nativeId, promptText, hub, requestedPromptId, demoActive);
  const { sid, promptId, createdAt, turn, emit, finishWithText } = ctx;

  void (async () => {
    try {
      const sub = argsText.trim().toLowerCase();
      const { path: cfgPath, data: cfgData } = await readRpivAdvisorConfig();
      const curModel = typeof cfgData.modelKey === 'string' ? cfgData.modelKey : undefined;
      const curEffort = typeof cfgData.effort === 'string' ? cfgData.effort : undefined;

      if (sub === 'status') {
        const msg = curModel
          ? `当前 Pi Advisor 模型：\`${curModel}\`${curEffort ? ` (effort: \`${curEffort}\`)` : ''}\n配置文件：\`${cfgPath}\``
          : `当前未启用 Pi Advisor（可在 Web UI 直接发送 \`/advisor\` 弹窗选择）。`;
        finishWithText(msg, 'completed');
        return;
      }

      if (sub === 'off' || sub === 'disable' || sub === 'none') {
        const next = { ...cfgData };
        delete next.modelKey;
        delete next.effort;
        await writeRpivAdvisorConfig(cfgPath, next);
        await adapter.close(nativeId).catch(() => undefined);
        finishWithText(`✓ 已关闭 Pi Advisor（已更新 \`${cfgPath}\`）。`, 'completed');
        return;
      }

      const models = adapter.listModels ? await adapter.listModels().catch(() => [] as NativeModel[]) : [];
      if (models.length === 0) {
        finishWithText('⚠ 未获取到可用 Pi 模型列表，请检查 Pi 模型配置后再试。', 'failed');
        return;
      }

      const modelOptions = [
        ...models.map((m) => ({
          id: m.model,
          label: `${m.display_name || m.model}${m.model === curModel ? ' ✓' : ''}`,
          description: m.model,
        })),
        {
          id: '__disable__',
          label: `No advisor (关闭 Advisor)${!curModel ? ' ✓' : ''}`,
          description: '禁用 advisor 工具',
        },
      ];

      const modelAns = await askLocalTurnQuestion(hub, sid, turn, emit, '选择 Advisor 辅助模型', [
        {
          id: 'advisor_model',
          header: 'Advisor Tool',
          question: '选择 Advisor 辅助模型（当主模型卡住或面对复杂决策时升级求助）：',
          body: curModel
            ? `当前配置：\`${curModel}\`${curEffort ? ` · effort: \`${curEffort}\`` : ''}`
            : '当前未启用 Advisor',
          options: modelOptions,
        },
      ]);
      if (turn.cancelled || hub.busy.get(sid) !== turn) return;

      const pickedId = extractFirstQuestionAnswer(modelAns, 'advisor_model');
      if (!pickedId) {
        finishWithText('已取消 Advisor 配置（当前配置未修改）。', 'completed');
        return;
      }

      if (pickedId === '__disable__') {
        const next = { ...cfgData };
        delete next.modelKey;
        delete next.effort;
        await writeRpivAdvisorConfig(cfgPath, next);
        await adapter.close(nativeId).catch(() => undefined);
        finishWithText(`✓ 已关闭 Pi Advisor（已写入 \`${cfgPath}\`）。`, 'completed');
        return;
      }

      const pickedModel = models.find((m) => m.model === pickedId);
      if (!pickedModel) {
        finishWithText(`✗ 未找到所选模型 \`${pickedId}\`。`, 'failed');
        return;
      }

      let chosenEffort: string | undefined;
      const efforts = (pickedModel.support_efforts ?? ['minimal', 'low', 'medium', 'high', 'xhigh'])
        .filter((e) => e !== 'off' && e !== 'auto');
      if (pickedModel.capabilities?.includes('thinking') || efforts.length > 0) {
        const effortOptions = [
          { id: '__off__', label: 'off (no reasoning sent)', description: '不附加推理强度参数' },
          ...efforts.map((lvl) => ({
            id: lvl,
            label: lvl === 'medium' ? `${lvl} (Recommended)` : lvl,
            ...(lvl === curEffort ? { description: '当前已启用' } : {}),
          })),
        ];
        const effortAns = await askLocalTurnQuestion(hub, sid, turn, emit, '选择 Advisor 思考强度', [
          {
            id: 'advisor_effort',
            header: 'Reasoning Level',
            question: `为 ${pickedModel.display_name || pickedModel.model} 选择 Advisor 思考强度：`,
            options: effortOptions,
          },
        ]);
        if (turn.cancelled || hub.busy.get(sid) !== turn) return;
        const pickedEffort = extractFirstQuestionAnswer(effortAns, 'advisor_effort');
        if (pickedEffort && pickedEffort !== '__off__') {
          chosenEffort = pickedEffort;
        }
      }

      const next: Record<string, unknown> = { ...cfgData, modelKey: pickedModel.model };
      if (chosenEffort) next.effort = chosenEffort;
      else delete next.effort;
      await writeRpivAdvisorConfig(cfgPath, next);
      await adapter.close(nativeId).catch(() => undefined);
      finishWithText(
        `✓ 已启用 Pi Advisor：\`${pickedModel.model}\`${chosenEffort ? ` (effort: \`${chosenEffort}\`)` : ''}\n已保存至 \`${cfgPath}\`，下一轮对话自动生效。`,
        'completed',
      );
    } catch (err) {
      finishWithText(`✗ /advisor 配置失败：${err instanceof Error ? err.message : String(err)}`, 'failed');
    } finally {
      drainQueue(adapter, 'pi', nativeId, hub, demoActive, uploadStore);
    }
  })();

  return {
    prompt_id: promptId,
    user_message_id: promptId,
    origin: { kind: 'user' },
    status: 'running',
    content: [{ type: 'text', text: promptText }],
    created_at: createdAt,
  };
}

async function runInteractivePiPlanMenu(
  adapter: ProviderAdapter,
  nativeId: string,
  hub: SessionHub,
  requestedPromptId: string | undefined,
  demoActive: boolean,
  uploadStore: UploadStore,
): Promise<Record<string, unknown>> {
  const ctx = await beginLocalInteractiveTurn(adapter, 'pi', nativeId, '/plan', hub, requestedPromptId, demoActive);
  const { sid, promptId, startedAt, createdAt, turn, emit, finishWithText } = ctx;

  void (async () => {
    try {
      const planAns = await askLocalTurnQuestion(hub, sid, turn, emit, '选择 Plan Mode 操作', [
        {
          id: 'plan_action',
          header: 'Plan Mode',
          question: '选择 Plan Mode 操作，或在下方直接输入要规划的任务：',
          options: [
            { id: 'start', label: '开启 Plan Mode (/plan start)', description: '只读探索与规划，禁止修改文件' },
            { id: 'show', label: '查看当前计划 (/plan show)', description: '展示已生成或保存的计划内容' },
            { id: 'finalize', label: '生成最终计划 (/plan finalize)', description: '要求助手收敛并输出最终计划' },
            { id: 'implement', label: '开始实施计划 (/plan implement)', description: '退出只读规划并执行当前计划' },
            { id: 'save', label: '保存计划供稍后使用 (/plan save)', description: '将当前计划保存留待后续实施' },
            { id: 'exit', label: '退出 Plan Mode (/plan exit)', description: '关闭 Plan Mode 恢复正常对话' },
          ],
          isOther: true,
          otherLabel: '直接输入计划任务并开启',
          otherPlaceholder: '描述你想规划的任务…',
        },
      ]);
      if (turn.cancelled || hub.busy.get(sid) !== turn) return;

      const choice = extractFirstQuestionAnswer(planAns, 'plan_action');
      if (!choice) {
        finishWithText('已取消 Plan Mode 操作。', 'completed');
        return;
      }

      const nextCmd = `/plan ${choice}`;
      const handle = await adapter.startTurn({ sessionId: nativeId, input: nextCmd });
      turn.turnId = handle.turnId;
      let stepActive = false;
      let step = 0;
      const ensureStep = (): void => {
        if (!stepActive) {
          turn.assistantText = '';
          turn.thinkingText = '';
          emit('turn.step.started', { turnId: 0, step });
          stepActive = true;
          turn.v262StepIndex = step;
        }
      };
      const completeStep = (state: 'completed' | 'failed' = 'completed'): void => {
        if (stepActive) {
          closeV262Thinking(hub, sid, turn);
          closeV262Assistant(hub, sid, turn);
          turn.transcript?.completeStep(state);
          emit('turn.step.completed', { turnId: 0, step, usage: {} });
          stepActive = false;
          step += 1;
          turn.v262StepIndex = step;
        }
      };
      let reason: 'completed' | 'failed' = 'completed';
      let turnError: string | undefined;
      for await (const ev of handle.events) {
        if (hub.busy.get(sid) !== turn) break;
        if (ev.kind === 'turn' && (ev.status === 'failed' || ev.status === 'cancelled')) {
          reason = 'failed';
          const errText = (ev.payload as { error?: string } | undefined)?.error;
          if (typeof errText === 'string' && errText) turnError = errText;
        }
        consumeEvent(ev, turn, emit, ensureStep, completeStep, sid, hub, 'pi');
      }
      completeStep(reason === 'failed' ? 'failed' : 'completed');
      closeV262Thinking(hub, sid, turn);
      closeV262Assistant(hub, sid, turn);
      if (reason === 'completed' && step === 0 && turn.v262Items.length <= 1) {
        emitAssistantDeltaText(`✓ 已执行 \`${nextCmd}\`。`, turn, emit, ensureStep, sid, hub);
        completeStep('completed');
      }
      if (hub.busy.get(sid) === turn) {
        hub.busy.delete(sid);
        const durationMs = Date.now() - startedAt;
        turn.transcript?.end(reason, durationMs);
        hub.transcript.finishPrompt(sid, promptId, reason);
        emit('turn.ended', { turnId: 0, reason, durationMs });
        emit('prompt.completed', { promptId, reason });
        emit('event.session.work_changed', { busy: false, main_turn_active: false, pending_interaction: 'none', last_turn_reason: reason });
        hub.broadcastV262(sid, {
          type: 'turn.ended',
          session_id: sid,
          agent_id: 'main',
          turn: {
            turn_id: turn.v262TurnId,
            ordinal: turn.v262Ordinal,
            turn_number: turn.v262Ordinal + 1,
            kind: 'agent',
            status: 'ended',
            outcome: reason === 'failed' ? 'failed' : 'completed',
            duration_ms: durationMs,
            started_at: createdAt,
            ended_at: new Date().toISOString(),
            ...(reason === 'failed' && turnError ? { error: { message: turnError } } : {}),
            steps: Array.from({ length: Math.max(1, step) }, (_, idx) => ({ index: idx })),
            items: [],
          },
        });
        emitV262AgentState(hub, adapter, 'pi', nativeId, sid, 'idle');
      }
    } catch (err) {
      finishWithText(`✗ /plan 执行失败：${err instanceof Error ? err.message : String(err)}`, 'failed');
    } finally {
      drainQueue(adapter, 'pi', nativeId, hub, demoActive, uploadStore);
    }
  })();

  return {
    prompt_id: promptId,
    user_message_id: promptId,
    origin: { kind: 'user' },
    status: 'running',
    content: [{ type: 'text', text: '/plan' }],
    created_at: createdAt,
  };
}

function parseCodexReviewOptions(argsText: string): Parameters<NonNullable<ProviderAdapter['review']>>[1] {
  const trimmed = argsText.trim();
  if (!trimmed) return undefined;
  const baseMatch = /^--base(?:=|\s+)(\S+)$/.exec(trimmed);
  if (baseMatch) {
    return { target: { type: 'baseBranch', branch: baseMatch[1] } };
  }
  const commitMatch = /^--commit(?:=|\s+)(\S+)(?:\s+([\s\S]+))?$/.exec(trimmed);
  if (commitMatch) {
    return {
      target: {
        type: 'commit',
        sha: commitMatch[1],
        title: commitMatch[2]?.trim() || null,
      },
    };
  }
  return { instructions: trimmed };
}

/** codex 代执行命令 → RPC 映射,返回给用户的输出文本。 */
export async function executeCodexCommand(
  adapter: ProviderAdapter,
  nativeId: string,
  name: string,
  argsText: string,
): Promise<string> {
  switch (name) {
    case 'compact':
      if (!adapter.compact) throw new ProviderError('unsupported', 'codex compact 不可用', 400);
      await adapter.compact(nativeId);
      return '✓ 已发起上下文压缩(thread/compact/start)。';
    case 'undo':
      if (!adapter.rollback) throw new ProviderError('unsupported', 'codex undo 不可用', 400);
      await adapter.rollback(nativeId, 1);
      return '✓ 已回滚最近 1 个 turn(thread/revert)。';
    case 'fork': {
      if (!adapter.fork) throw new ProviderError('unsupported', 'codex fork 不可用', 400);
      const s = await adapter.fork(nativeId);
      return `⑂ 已分叉新会话:「${s.title}」\nID:${prefixedId('codex', s.id)}\n刷新会话列表后可见。`;
    }
    case 'goal': {
      const sub = argsText.trim();
      const lower = sub.toLowerCase();
      if (!sub || lower === 'status') {
        if (!adapter.getGoal) throw new ProviderError('unsupported', 'codex goal 不可用', 400);
        return renderGoalSummary(await adapter.getGoal(nativeId));
      }
      if (lower === 'pause' || lower === 'resume' || lower === 'cancel' || lower === 'clear') {
        if (!adapter.controlGoal) throw new ProviderError('unsupported', 'codex goal 不可用', 400);
        const ctrl = lower === 'clear' ? 'cancel' : (lower as 'pause' | 'resume' | 'cancel');
        const next = await adapter.controlGoal(nativeId, ctrl);
        return ctrl === 'cancel' ? '✓ 已清除会话目标。' : renderGoalSummary(next);
      }
      if (!adapter.setGoal) throw new ProviderError('unsupported', 'codex goal 不可用', 400);
      return renderGoalSummary(await adapter.setGoal(nativeId, sub));
    }
    case 'diff': {
      const remote = adapter.gitDiff ? await adapter.gitDiff(nativeId).catch(() => null) : null;
      if (remote && remote.diff.trim()) {
        const clipped = remote.diff.length > 48 * 1024 ? `${remote.diff.slice(0, 48 * 1024)}\n…(已截断)` : remote.diff;
        return `### Git Diff (相对远端 ${remote.sha || 'HEAD'})\n\`\`\`diff\n${clipped.trimEnd()}\n\`\`\``;
      }
      return renderRepoDiffCommand(adapter, nativeId);
    }
    case 'status':
      return renderCodexStatus(adapter, nativeId);
    case 'usage':
      return renderCodexUsage(adapter, nativeId);
    case 'mcp':
      return renderMcpServers(adapter.listMcpServers ? await adapter.listMcpServers(nativeId).catch(() => []) : []);
    case 'terminals': {
      const terms = adapter.listTerminals ? await adapter.listTerminals(nativeId).catch(() => []) : [];
      if (terms.length === 0) return '后台终端:无活动进程(0)。';
      return ['后台终端列表', ...terms.map((t) => `· ${String(t.id ?? '?')} — ${String(t.command ?? t.status ?? 'running')}`)].join('\n');
    }
    case 'terminals-clean': {
      if (!adapter.cleanTerminals) throw new ProviderError('unsupported', 'codex terminals-clean 不可用', 400);
      await adapter.cleanTerminals(nativeId);
      return '✓ 已清理本线程的后台终端。';
    }
    case 'skills':
      return renderProviderSkills(adapter, 'codex', nativeId);
    case 'help':
      return renderProviderHelp(adapter, 'codex', nativeId);
    default:
      throw new ProviderError('invalid_request', `unknown gateway command /${name}`, 400);
  }
}

async function executeGrokCommand(
  adapter: ProviderAdapter,
  nativeId: string,
  name: string,
  argsText: string,
): Promise<string> {
  switch (name) {
    case 'compact':
      if (!adapter.compact) throw new ProviderError('unsupported', 'grok compact 不可用', 400);
      await adapter.compact(nativeId);
      return '✓ 已压缩对话上下文(_x.ai/compact_conversation)。';
    case 'undo':
      if (!adapter.rollback) throw new ProviderError('unsupported', 'grok undo 不可用', 400);
      await adapter.rollback(nativeId, 1);
      return '✓ 已回滚最近 1 个 turn(_x.ai/rewind/execute)。';
    case 'fork': {
      if (!adapter.fork) throw new ProviderError('unsupported', 'grok fork 不可用', 400);
      const s = await adapter.fork(nativeId);
      return `⑂ 已分叉新会话:「${s.title}」\nID:${prefixedId('grok', s.id)}\n刷新会话列表后可见。`;
    }
    case 'status':
    case 'info':
    case 'session-info':
      return renderGrokStatus(adapter, nativeId);
    case 'thinking':
    case 'effort': {
      const level = argsText.trim().split(/\s+/)[0]?.toLowerCase();
      if (!level || !NATIVE_EFFORTS.has(level)) {
        return `用法: /${name} <off|minimal|low|medium|high|xhigh|max>`;
      }
      if (!adapter.setThinking) throw new ProviderError('unsupported', 'grok thinking 不可用', 400);
      await adapter.setThinking(nativeId, level);
      return `✓ 已设置思考档位: ${level}`;
    }
    case 'always-approve': {
      const arg = argsText.trim().toLowerCase();
      const current = adapter.getPermission?.(nativeId) ?? 'default';
      let nextMode: string;
      if (!arg) {
        nextMode = current === 'yolo' ? 'manual' : 'yolo';
      } else if (arg === 'on' || arg === 'true' || arg === '1') {
        nextMode = 'yolo';
      } else if (arg === 'off' || arg === 'false' || arg === '0') {
        nextMode = 'manual';
      } else {
        return `用法: /always-approve [on|off]（当前权限: ${current}）`;
      }
      if (!adapter.setPermission) throw new ProviderError('unsupported', 'grok 权限切换不可用', 400);
      await adapter.setPermission(nativeId, nextMode);
      return nextMode === 'yolo'
        ? '✓ 已开启 always-approve（当前会话权限: yolo）。'
        : '✓ 已关闭 always-approve（当前会话权限: manual）。';
    }
    case 'usage': {
      const usage = adapter.getUsage?.(nativeId);
      if (!usage) return '暂无用量数据。';
      return [
        'Grok 用量',
        `· input: ${usage.input_tokens}`,
        `· output: ${usage.output_tokens}`,
        `· context: ${usage.context_tokens}/${usage.context_limit || grokContextWindowSafe()}`,
      ].join('\n');
    }
    case 'diff':
      return renderRepoDiffCommand(adapter, nativeId);
    case 'skills':
      return renderProviderSkills(adapter, 'grok', nativeId);
    case 'help':
      return renderProviderHelp(adapter, 'grok', nativeId);
    case 'feedback':
    case 'loop':
      return `ℹ Grok /${name} 仅在原生终端模式提供，当前 Web 协议接口不支持。输入 /help 查看 Web UI 可用命令。`;
    default:
      throw new ProviderError('invalid_request', `unknown gateway command /${name}`, 400);
  }
}

async function executePiCommand(
  adapter: ProviderAdapter,
  nativeId: string,
  name: string,
  argsText: string,
): Promise<string> {
  switch (name) {
    case 'compact':
      if (!adapter.compact) throw new ProviderError('unsupported', 'pi compact 不可用', 400);
      await adapter.compact(nativeId, argsText || undefined);
      return '✓ 已压缩 Pi 会话上下文。';
    case 'auto-compact': {
      const arg = argsText.trim().toLowerCase();
      if (!adapter.setAutoCompaction) throw new ProviderError('unsupported', 'pi auto-compact 不可用', 400);
      let next: boolean;
      if (!arg) {
        const cur = adapter.getAutoCompaction ? await adapter.getAutoCompaction(nativeId) : undefined;
        next = cur === undefined ? true : !cur;
      } else if (arg === 'on' || arg === 'true' || arg === '1') {
        next = true;
      } else if (arg === 'off' || arg === 'false' || arg === '0') {
        next = false;
      } else {
        return '用法: /auto-compact [on|off]';
      }
      const effective = await adapter.setAutoCompaction(nativeId, next);
      return `✓ Pi 自动压缩已${effective ? '开启' : '关闭'}。`;
    }
    case 'clone': {
      if (!adapter.clone) throw new ProviderError('unsupported', 'pi clone 不可用', 400);
      const s = await adapter.clone(nativeId);
      return `⎘ 已克隆新会话:「${s.title}」\nID:${prefixedId('pi', s.id)}\n刷新会话列表后可见。`;
    }
    case 'fork': {
      if (!adapter.fork) throw new ProviderError('unsupported', 'pi fork 不可用', 400);
      const s = await adapter.fork(nativeId);
      return `⑂ 已分叉新会话:「${s.title}」\nID:${prefixedId('pi', s.id)}\n刷新会话列表后可见。`;
    }
    case 'name':
    case 'rename': {
      const title = argsText.trim();
      if (!title) return '用法: /name <新会话标题>';
      if (!adapter.rename) throw new ProviderError('unsupported', 'pi 重命名不可用', 400);
      await adapter.rename(nativeId, title);
      return `✓ 已更新会话标题为:「${title}」`;
    }
    case 'thinking': {
      const level = argsText.trim();
      if (!level) {
        const cur = adapter.getThinking?.(nativeId) ?? '(默认)';
        return `当前思考档位: ${cur}\n用法: /thinking <off|minimal|low|medium|high|xhigh>`;
      }
      if (!adapter.setThinking) throw new ProviderError('unsupported', 'pi 思考档位切换不可用', 400);
      await adapter.setThinking(nativeId, level);
      return `✓ 已将 Pi 思考档位设为: ${adapter.getThinking?.(nativeId) ?? level}`;
    }
    case 'status':
      return renderPiStatus(adapter, nativeId);
    case 'session':
      return renderPiSessionStats(adapter, nativeId);
    case 'usage':
      return renderPiUsage(adapter, nativeId);
    case 'copy': {
      if (!adapter.getLastAssistantText) throw new ProviderError('unsupported', 'pi copy 不可用', 400);
      const last = await adapter.getLastAssistantText(nativeId);
      if (!last || !last.trim()) return '当前会话还没有可复制的助手回复。';
      return `### 最近一条助手回复\n\n${last}`;
    }
    case 'tree': {
      if (!adapter.getSessionTree) throw new ProviderError('unsupported', 'pi tree 不可用', 400);
      return renderPiTree(await adapter.getSessionTree(nativeId));
    }
    case 'diff':
      return renderRepoDiffCommand(adapter, nativeId);
    case 'skills':
      return renderProviderSkills(adapter, 'pi', nativeId);
    case 'help':
      return renderProviderHelp(adapter, 'pi', nativeId);
    case 'settings':
      return renderPiSettings(adapter, nativeId);
    case 'export':
      return 'ℹ 在 Web UI 中可直接使用 `/export` 快捷键或会话菜单「导出」下载完整会话 ZIP。';
    case 'reload':
      return 'ℹ 在 Web UI 中可直接使用 `/reload` 快捷键重新加载会话与命令目录。';
    case 'resume':
      return 'ℹ 请在左侧会话列表中直接点击切换要恢复的 Pi 会话。';
    default:
      if (piUnsupportedTuiCommandNames().has(name)) {
        return `ℹ Pi /${name} 属于本地终端交互命令，在 Web UI 中已为您拦截（输入 /help 查看所有可用的网页命令）。`;
      }
      throw new ProviderError('invalid_request', `unknown gateway command /${name}`, 400);
  }
}

async function executeDshCommand(
  adapter: ProviderAdapter,
  nativeId: string,
  name: string,
  argsText: string,
): Promise<string> {
  switch (name) {
    case 'undo':
    case 'fork':
    case 'compact':
    case 'goal':
    case 'plan':
      throw new ProviderError('unsupported', `dsh 不支持 /${name}`, 400);
    case 'status':
      return renderDshStatus(adapter, nativeId);
    case 'diff':
      return renderRepoDiffCommand(adapter, nativeId);
    case 'skills':
      return renderDshSkills(adapter, nativeId);
    case 'help':
      return renderDshHelp(adapter, nativeId);
    default:
      throw new ProviderError('invalid_request', `unknown gateway command /${name}`, 400);
  }
}

async function executeClaudeCommand(
  adapter: ProviderAdapter,
  nativeId: string,
  name: string,
  argsText: string,
): Promise<string> {
  switch (name) {
    case 'status':
      return renderClaudeStatus(adapter, nativeId);
    case 'fork': {
      if (!adapter.fork) throw new ProviderError('unsupported', 'claude fork 不可用', 400);
      const s = await adapter.fork(nativeId);
      return `⑂ 已分叉新会话:「${s.title}」\nID:${prefixedId('claude', s.id)}\n刷新会话列表后可见。`;
    }
    case 'diff':
      return renderRepoDiffCommand(adapter, nativeId);
    case 'skills':
      return renderProviderSkills(adapter, 'claude', nativeId);
    case 'permissions': {
      const arg = argsText.trim().toLowerCase();
      const cur = adapter.getPermission?.(nativeId) ?? 'default';
      if (!arg) {
        return `当前 Claude 权限模式: ${cur}\n用法: /permissions <manual|auto|yolo>`;
      }
      if (arg !== 'manual' && arg !== 'auto' && arg !== 'yolo') {
        return `不支持的权限模式: ${arg}\n可选值: manual | auto | yolo`;
      }
      if (!adapter.setPermission) throw new ProviderError('unsupported', 'claude 权限切换不可用', 400);
      await adapter.setPermission(nativeId, arg);
      return `✓ 已将 Claude 权限模式设为: ${arg}`;
    }
    case 'tasks':
      return '当前会话无挂起的后台任务；运行中的子代理与工具进度会直接显示在对话消息卡片中。';
    case 'help':
      return renderProviderHelp(adapter, 'claude', nativeId);
    case 'resume':
      return 'ℹ 请在左侧会话列表中直接点击历史会话进行恢复。';
    default:
      if (claudeUnsupportedTuiCommandNames().has(name)) {
        return `ℹ Claude /${name} 依赖本地终端交互界面，Web UI 中暂不支持（输入 /help 查看所有网页可用命令）。`;
      }
      throw new ProviderError('invalid_request', `unknown gateway command /${name}`, 400);
  }
}

function grokContextWindowSafe(): number {
  return 500_000;
}

async function renderCodexStatus(adapter: ProviderAdapter, nativeId: string): Promise<string> {
  const model = adapter.getModel?.(nativeId) ?? '(provider 默认)';
  const thinking = adapter.getThinking?.(nativeId);
  const permission = adapter.getPermission?.(nativeId) ?? 'default';
  const usage = adapter.getUsage?.(nativeId);
  const lines = [
    '⚙ Codex 会话状态',
    `· 模型:${model}${thinking && thinking !== 'off' ? `(effort: ${thinking})` : ''}`,
    `· 权限:${permission}`,
  ];
  if (usage && usage.context_limit > 0) {
    const pct = ((usage.context_tokens / usage.context_limit) * 100).toFixed(1);
    lines.push(`· 上下文:${usage.context_tokens.toLocaleString()} / ${usage.context_limit.toLocaleString()} tokens(${pct}%)`);
  }
  const limits = adapter.getRateLimits ? await adapter.getRateLimits().catch(() => null) : null;
  const limitSummary = formatCodexRateLimits(limits);
  if (limitSummary) lines.push(limitSummary);
  return lines.join('\n');
}

export async function renderCodexUsage(adapter: ProviderAdapter, nativeId: string): Promise<string> {
  const u = adapter.getUsage?.(nativeId);
  const limits = adapter.getRateLimits ? await adapter.getRateLimits().catch(() => null) : null;
  const limitSummary = formatCodexRateLimits(limits);
  const accountUsage = (adapter as { getAccountUsage?: (sid?: string) => Promise<Record<string, unknown> | null> }).getAccountUsage
    ? await (adapter as { getAccountUsage?: (sid?: string) => Promise<Record<string, unknown> | null> }).getAccountUsage!(nativeId).catch(() => null)
    : null;
  const accountSummary = formatCodexAccountUsage(accountUsage);
  if (!u || (u.input_tokens === 0 && u.output_tokens === 0)) {
    const extraParts = [accountSummary, limitSummary].filter(Boolean);
    return extraParts.length > 0 ? `∑ 暂无本会话累计用量。\n${extraParts.join('\n')}` : '∑ 暂无用量数据(完成一轮对话后可见)。';
  }
  const lines = [
    '∑ 用量统计(本会话累计)',
    `· 输入 tokens:${u.input_tokens.toLocaleString()}`,
    `· 输出 tokens:${u.output_tokens.toLocaleString()}`,
    `· 缓存读:${u.cache_read_tokens.toLocaleString()} · 缓存写:${u.cache_creation_tokens.toLocaleString()}`,
  ];
  if (accountSummary) lines.push(accountSummary);
  if (limitSummary) lines.push(limitSummary);
  return lines.join('\n');
}

export function formatCodexAccountUsage(raw: Record<string, unknown> | null): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = (raw.usage && typeof raw.usage === 'object') ? (raw.usage as Record<string, unknown>) : raw;
  const parts: string[] = [];
  const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const total = num(data.totalTokens ?? data.total_tokens ?? data.tokensUsed ?? data.tokens_used);
  const input = num(data.inputTokens ?? data.input_tokens);
  const output = num(data.outputTokens ?? data.output_tokens);
  if (total !== undefined) parts.push(`总 tokens:${total.toLocaleString()}`);
  if (input !== undefined) parts.push(`输入:${input.toLocaleString()}`);
  if (output !== undefined) parts.push(`输出:${output.toLocaleString()}`);
  if (parts.length > 0) return `· 账号用量:${parts.join(' · ')}`;
  const textEntries = Object.entries(data)
    .filter(([_, v]) => typeof v === 'number' || typeof v === 'string')
    .slice(0, 3)
    .map(([k, v]) => `${k}:${typeof v === 'number' ? v.toLocaleString() : v}`);
  return textEntries.length > 0 ? `· 账号用量:${textEntries.join(' · ')}` : null;
}

function formatCodexRateLimits(raw: Record<string, unknown> | null): string | null {
  if (!raw) return null;
  const snap = raw.rateLimits as Record<string, unknown> | undefined;
  if (!snap || typeof snap !== 'object') return null;
  const parts: string[] = [];
  for (const [label, bucket] of [['主窗口', snap.primary], ['周窗口', snap.secondary]] as const) {
    const b = bucket as Record<string, unknown> | undefined;
    if (b && typeof b.usedPercent === 'number') {
      parts.push(`${label}已用 ${Math.round(b.usedPercent)}%`);
    }
  }
  return parts.length > 0 ? `· 配额:${parts.join(' · ')}` : null;
}

function renderGoalSummary(goal: Record<string, unknown> | null): string {
  if (!goal) return '🎯 当前会话暂无活动目标。用法: /goal <目标描述>';
  const obj = String(goal.objective ?? '').trim() || '(无目标内容)';
  const status = String(goal.status ?? 'active');
  const tokens = typeof goal.tokensUsed === 'number' ? goal.tokensUsed : undefined;
  const lines = [`🎯 会话目标 [${status}]`, `· 内容: ${obj}`];
  if (tokens !== undefined) lines.push(`· 已用 tokens: ${tokens.toLocaleString()}`);
  return lines.join('\n');
}

function renderClaudeStatus(adapter: ProviderAdapter, nativeId: string): string {
  const model = adapter.getModel?.(nativeId) ?? '(default)';
  const thinking = adapter.getThinking?.(nativeId);
  const permission = adapter.getPermission?.(nativeId) ?? 'default';
  const plan = adapter.getPlanMode?.(nativeId) === true;
  const usage = adapter.getUsage?.(nativeId);
  const lines = [
    '⚙ Claude 会话状态',
    `· 模型: ${model}${thinking && thinking !== 'off' ? ` (effort: ${thinking})` : ''}`,
    `· 权限: ${permission}${plan ? ' · Plan 模式: 开启' : ''}`,
  ];
  if (usage && usage.context_limit > 0 && !usage.context_unavailable) {
    const pct = ((usage.context_tokens / usage.context_limit) * 100).toFixed(1);
    lines.push(`· 上下文: ${usage.context_tokens.toLocaleString()} / ${usage.context_limit.toLocaleString()} tokens (${pct}%)`);
  }
  if (usage && usage.total_cost_usd > 0) {
    lines.push(`· 累计费用: $${usage.total_cost_usd.toFixed(4)}`);
  }
  return lines.join('\n');
}

function renderGrokStatus(adapter: ProviderAdapter, nativeId: string): string {
  const model = adapter.getModel?.(nativeId) ?? '(provider 默认)';
  const thinking = adapter.getThinking?.(nativeId);
  const permission = adapter.getPermission?.(nativeId) ?? 'default';
  const plan = adapter.getPlanMode?.(nativeId) === true;
  const usage = adapter.getUsage?.(nativeId);
  const limit = usage?.context_limit && usage.context_limit > 0 ? usage.context_limit : grokContextWindowSafe();
  const lines = [
    '⚙ Grok 会话状态',
    `· 模型: ${model}${thinking && thinking !== 'off' ? ` (effort: ${thinking})` : ''}`,
    `· 权限: ${permission}${plan ? ' · Plan 模式: 开启' : ''}`,
  ];
  if (usage) {
    const pct = limit > 0 ? ((usage.context_tokens / limit) * 100).toFixed(1) : '0.0';
    lines.push(`· 上下文: ${usage.context_tokens.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct}%)`);
    lines.push(`· 累计用量: input ${usage.input_tokens.toLocaleString()} · output ${usage.output_tokens.toLocaleString()}`);
  }
  return lines.join('\n');
}

function renderPiStatus(adapter: ProviderAdapter, nativeId: string): string {
  const model = adapter.getModel?.(nativeId) ?? '(provider 默认)';
  const thinking = adapter.getThinking?.(nativeId);
  const usage = adapter.getUsage?.(nativeId);
  const lines = [
    '⚙ Pi 会话状态',
    `· 模型:${model}${thinking && thinking !== 'off' ? ` (thinking: ${thinking})` : ''}`,
  ];
  if (usage?.context_unavailable) {
    lines.push('· 上下文:已压缩,待下轮刷新');
  } else if (usage && usage.context_limit > 0) {
    const pct = ((usage.context_tokens / usage.context_limit) * 100).toFixed(1);
    lines.push(`· 上下文:${usage.context_tokens.toLocaleString()} / ${usage.context_limit.toLocaleString()} tokens(${pct}%)`);
  }
  return lines.join('\n');
}

export interface DshAcpProfileInfo {
  bundles: string[];
  dependencies: string[];
  patchPlugins: string[];
}

function stripYamlComment(rawLine: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < rawLine.length; i += 1) {
    const ch = rawLine[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i += 1; continue; }
      if (quote === "'" && ch === "'" && rawLine[i + 1] === "'") { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(rawLine[i - 1]!))) {
      return rawLine.slice(0, i);
    }
  }
  return rawLine;
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const q = trimmed[0];
    if ((q === '"' || q === "'") && trimmed[trimmed.length - 1] === q) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function readDshAcpProfile(dshHomeOverride?: string): DshAcpProfileInfo {
  const dshHome = dshHomeOverride || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const acpDir = path.join(dshHome, 'profiles', 'acp');
  const pkgPath = path.join(acpDir, 'package.json');
  const patchPath = path.join(acpDir, 'cordis.patch.yml');

  const bundles: string[] = [];
  const dependencies: string[] = [];
  const patchPlugins: string[] = [];

  try {
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (Array.isArray(pkg.dsh?.profile?.bundles)) {
        for (const b of pkg.dsh.profile.bundles) {
          if (typeof b === 'string' && b.trim()) bundles.push(b.trim());
        }
      }
      if (pkg.dependencies && typeof pkg.dependencies === 'object') {
        for (const dep of Object.keys(pkg.dependencies)) {
          if (dep.trim()) dependencies.push(dep.trim());
        }
      }
    }
  } catch {
    // 安静降级
  }

  try {
    if (existsSync(patchPath)) {
      const content = readFileSync(patchPath, 'utf8');
      const lines = content.split('\n');
      const pluginEnabled = new Map<string, boolean>();
      let currentId: string | null = null;
      let currentEnabled = true;
      let currentFieldIndent = -1;
      let waitingIdIndent = -1;
      let listIndent: number | undefined;

      const commit = (): void => {
        if (currentId) pluginEnabled.set(currentId, currentEnabled);
        currentId = null;
        currentEnabled = true;
        currentFieldIndent = -1;
      };

      for (const rawLine of lines) {
        const line = stripYamlComment(rawLine).replace(/\r$/, '');
        if (!line.trim()) continue;
        const listItem = line.match(/^(\s*)-(?:\s|$)/);
        if (listItem) {
          const indent = listItem[1]!.length;
          listIndent ??= indent;
          if (indent !== listIndent) continue;
        }

        const dashId = line.match(/^(\s*-\s+)id:\s*(.+)$/);
        if (dashId) {
          commit();
          waitingIdIndent = -1;
          const rawId = unquoteYamlScalar(dashId[2]!);
          const cleanId = rawId.replace(/^~/, '');
          if (cleanId) {
            currentId = cleanId;
            currentEnabled = !rawId.startsWith('~');
            currentFieldIndent = dashId[1]!.length;
          }
          continue;
        }

        const bareDash = line.match(/^(\s*)-\s*$/);
        if (bareDash) {
          commit();
          waitingIdIndent = bareDash[1]!.length;
          continue;
        }

        const otherTop = line.match(/^(\s*)-\s+/);
        if (otherTop) {
          commit();
          waitingIdIndent = -1;
          continue;
        }

        const indent = line.match(/^(\s*)/)![1]!.length;
        if (waitingIdIndent >= 0 && indent > waitingIdIndent) {
          const idLine = line.match(/^\s+id:\s*(.+)$/);
          if (idLine) {
            const rawId = unquoteYamlScalar(idLine[1]!);
            const cleanId = rawId.replace(/^~/, '');
            if (cleanId) {
              currentId = cleanId;
              currentEnabled = !rawId.startsWith('~');
              currentFieldIndent = indent;
            }
            waitingIdIndent = -1;
            continue;
          }
        }

        if (!currentId || indent !== currentFieldIndent) continue;
        const kv = line.match(/^\s+(disabled|enabled):\s*(.+)$/);
        if (!kv) continue;
        const key = kv[1]!;
        const val = unquoteYamlScalar(kv[2]!).toLowerCase();
        if (key === 'disabled') {
          if (val === 'true' || val === '1' || val === 'yes' || val.startsWith('!!js')) currentEnabled = false;
          else if (val === 'false' || val === '0' || val === 'no') currentEnabled = true;
        } else if (key === 'enabled') {
          if (val === 'false' || val === '0' || val === 'no') currentEnabled = false;
          else if (val === 'true' || val === '1' || val === 'yes') currentEnabled = true;
        }
      }
      commit();

      for (const [id, enabled] of pluginEnabled) {
        if (enabled) patchPlugins.push(id);
      }
    }
  } catch {
    // 安静降级
  }

  return { bundles, dependencies, patchPlugins };
}

function renderDshStatus(adapter: ProviderAdapter, nativeId: string): string {
  const model = adapter.getModel?.(nativeId) ?? '(provider 默认)';
  const permission = adapter.getPermission?.(nativeId) ?? 'default';
  const plan = adapter.getPlanMode?.(nativeId) === true;
  const usage = adapter.getUsage?.(nativeId);
  const limit = usage?.context_limit && usage.context_limit > 0 ? usage.context_limit : dshStatusContextFallback();
  const profileInfo = readDshAcpProfile();
  const lines = [
    '⚙ DSH 会话状态',
    '· 通道: ACP 通道 (dsh --profile acp)',
    `· 模型: ${model}`,
    `· 权限: ${permission}${plan ? ' · Plan 模式: 开启' : ''}`,
    '· 能力限制: 当前 DSH ACP 实现未暴露原生命令通道与模式切换（modes），/plan、/goal、/compact、/undo、/fork 等不可用',
  ];
  if (usage) {
    const pct = limit > 0 ? ((usage.context_tokens / limit) * 100).toFixed(1) : '0.0';
    lines.push(`· 上下文: ${usage.context_tokens.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct}%)`);
    lines.push(`· 累计用量: input ${usage.input_tokens.toLocaleString()} · output ${usage.output_tokens.toLocaleString()}`);
  }
  const allDeclared = [
    ...profileInfo.bundles,
    ...profileInfo.dependencies,
    ...profileInfo.patchPlugins,
  ];
  if (allDeclared.length > 0) {
    lines.push('· ACP Profile 配置项（配置声明，非运行时状态）:');
    if (profileInfo.bundles.length > 0) {
      lines.push(`  - Bundles (package.json): ${profileInfo.bundles.join(', ')}`);
    }
    if (profileInfo.dependencies.length > 0) {
      lines.push(`  - Dependencies (package.json): ${profileInfo.dependencies.join(', ')}`);
    }
    if (profileInfo.patchPlugins.length > 0) {
      lines.push(`  - 补丁声明 (cordis.patch.yml): ${profileInfo.patchPlugins.join(', ')}`);
    }
  } else {
    lines.push('· ACP Profile 配置项: 未检测到 profile 配置文件');
  }
  return lines.join('\n');
}

async function renderPiSettings(adapter: ProviderAdapter, nativeId: string): Promise<string> {
  const pa = adapter as ProviderAdapter & {
    getSessionState?: (id: string) => Promise<Record<string, unknown>>;
  };
  const state = pa.getSessionState ? await pa.getSessionState(nativeId).catch(() => null) : null;
  const model = adapter.getModel?.(nativeId) ?? '(provider 默认)';
  const thinking = String(state?.thinkingLevel ?? adapter.getThinking?.(nativeId) ?? 'default');
  const autoCompact = state?.autoCompactionEnabled === true ? '开启' : state?.autoCompactionEnabled === false ? '关闭' : '未知';
  const steeringMode = typeof state?.steeringMode === 'string' ? state.steeringMode : 'one-at-a-time';
  const followUpMode = typeof state?.followUpMode === 'string' ? state.followUpMode : 'one-at-a-time';
  return [
    '⚙ Pi 当前会话配置',
    `· 模型: ${model}`,
    `· 思考档位: ${thinking}（可用 /thinking <level> 切换）`,
    `· 自动压缩: ${autoCompact}（可用 /auto-compact on|off 切换）`,
    `· 插话队列模式: steering=${steeringMode} · followUp=${followUpMode}`,
  ].join('\n');
}

async function renderPiSessionStats(adapter: ProviderAdapter, nativeId: string): Promise<string> {
  const pa = adapter as ProviderAdapter & {
    getSessionStats?: (id: string) => Promise<Record<string, unknown>>;
  };
  const stats = pa.getSessionStats ? await pa.getSessionStats(nativeId).catch(() => null) : null;
  if (!stats) return renderPiUsage(adapter, nativeId);
  const tokens = (stats.tokens && typeof stats.tokens === 'object' ? stats.tokens : {}) as Record<string, unknown>;
  const ctx = (stats.contextUsage && typeof stats.contextUsage === 'object' ? stats.contextUsage : null) as
    | { tokens?: number | null; contextWindow?: number; percent?: number | null }
    | null;
  const lines = [
    '📊 Pi 会话统计',
    `· 消息数: 用户 ${Number(stats.userMessages ?? 0)} · 助手 ${Number(stats.assistantMessages ?? 0)} · 工具调用 ${Number(stats.toolCalls ?? 0)}`,
    `· Tokens: input ${Number(tokens.input ?? 0).toLocaleString()} · output ${Number(tokens.output ?? 0).toLocaleString()} · cacheRead ${Number(tokens.cacheRead ?? 0).toLocaleString()}`,
  ];
  if (ctx && typeof ctx.contextWindow === 'number' && ctx.contextWindow > 0) {
    const used = typeof ctx.tokens === 'number' ? ctx.tokens.toLocaleString() : '待刷新';
    const pct = typeof ctx.percent === 'number' ? ` (${ctx.percent.toFixed(1)}%)` : '';
    lines.push(`· 上下文窗口: ${used} / ${ctx.contextWindow.toLocaleString()}${pct}`);
  }
  if (typeof stats.cost === 'number' && stats.cost > 0) {
    lines.push(`· 累计费用: $${stats.cost.toFixed(4)}`);
  }
  return lines.join('\n');
}

function renderPiTree(raw: Record<string, unknown> | null): string {
  if (!raw || !Array.isArray(raw.tree) || raw.tree.length === 0) {
    return '当前会话树为空（发送消息后即可查看分支结构）。';
  }
  const leafId = typeof raw.leafId === 'string' ? raw.leafId : '';
  const lines: string[] = ['🌳 Pi 会话分支树'];
  const visit = (nodes: unknown[], depth: number): void => {
    for (const rawNode of nodes) {
      if (lines.length >= 45) break;
      if (!rawNode || typeof rawNode !== 'object') continue;
      const node = rawNode as {
        entry?: { id?: string; type?: string; role?: string; message?: { role?: string } };
        children?: unknown[];
      };
      const id = String(node.entry?.id ?? '').slice(0, 8);
      const kind = String(node.entry?.message?.role ?? node.entry?.type ?? 'node');
      const marker = leafId && node.entry?.id === leafId ? ' ← 当前叶节点' : '';
      lines.push(`${'  '.repeat(Math.min(depth, 6))}· [${id || '?'}] ${kind}${marker}`);
      if (Array.isArray(node.children) && node.children.length > 0) {
        visit(node.children, depth + 1);
      }
    }
  };
  visit(raw.tree, 0);
  if (lines.length >= 45) lines.push('…（已截断部分深层节点）');
  return lines.join('\n');
}

async function renderRepoDiffCommand(adapter: ProviderAdapter, nativeId: string): Promise<string> {
  const cwd = adapter.getCwd?.(nativeId);
  if (!cwd) return '当前会话没有关联工作目录，无法读取 git diff。';
  const res = await fsRepoDiff(cwd).catch(() => null);
  if (!res) return `读取工作目录 ${cwd} 的 git diff 失败。`;
  if (!res.isGitRepo) return `当前工作目录不是 Git 仓库（${cwd}），无法读取 diff。`;
  const changedFiles = Object.entries(res.entries);
  if (changedFiles.length === 0 && !res.diff.trim()) {
    return `工作区干净（分支: ${res.branch || 'HEAD'}，无未提交改动）。`;
  }
  const fileList = changedFiles.slice(0, 20).map(([p, st]) => `- \`${st}\` ${p}`).join('\n');
  const moreFiles = changedFiles.length > 20 ? `\n- …共 ${changedFiles.length} 个文件` : '';
  const parts = [`### Git 状态（分支: ${res.branch || 'HEAD'}）\n${fileList || '（仅已暂存/跟踪改动）'}${moreFiles}`];
  if (res.diff.trim()) {
    parts.push(`\`\`\`diff\n${res.diff.trimEnd()}\n\`\`\`${res.truncated ? '\n_（diff 超过 48KB 已截断）_' : ''}`);
  }
  return parts.join('\n\n');
}

async function renderProviderSkills(
  adapter: ProviderAdapter,
  provider: LocalProviderName,
  nativeId: string,
): Promise<string> {
  const skills = await adapterSkills(adapter, nativeId);
  if (skills.length === 0) return `当前 ${provider} 会话暂无可用斜杠命令或技能。`;
  const lines = [`### ${provider} 可用命令与技能（${skills.length}）`];
  for (const item of skills.slice(0, 60)) {
    const name = String(item.name ?? '');
    const hint = typeof item.argument_hint === 'string' && item.argument_hint ? ` ${item.argument_hint}` : '';
    const desc = String(item.description ?? '').replace(/\s+/g, ' ').slice(0, 100);
    lines.push(`- \`/${name}${hint}\`${desc ? ` — ${desc}` : ''}`);
  }
  if (skills.length > 60) lines.push(`- …共 ${skills.length} 项`);
  return lines.join('\n');
}

async function renderDshHelp(adapter: ProviderAdapter, nativeId: string): Promise<string> {
  const cmds = adapter.listCommands ? await adapter.listCommands(nativeId).catch(() => [] as NativeCommand[]) : [];
  const runnable = cmds.filter((c) => !c.terminalOnly);
  const lines = [
    '### dsh Web UI 可用命令',
    'ℹ 通道说明: DSH 当前走 ACP 通道 (dsh --profile acp)，而非完整原生 Web。',
    '当前 DSH ACP 实现未暴露原生命令通道，不支持模式切换 (modes)、上下文压缩 (/compact)、目标模式 (/goal)、计划模式 (/plan)、会话分叉 (/fork) 或撤销 (/undo)。',
    '',
    `当前支持网关代执行的基础辅助命令（共 ${runnable.length} 项）：`,
  ];
  for (const c of runnable.slice(0, 50)) {
    const hint = c.argumentHint ? ` ${c.argumentHint}` : '';
    const aliasText = c.aliases && c.aliases.length > 0 ? `（别名: ${c.aliases.map((a) => `/${a}`).join(', ')}）` : '';
    const desc = c.description.replace(/\s+/g, ' ').slice(0, 90);
    lines.push(`- \`/${c.name}${hint}\` ${aliasText}— ${desc}`);
  }
  return lines.join('\n');
}

async function renderDshSkills(adapter: ProviderAdapter, nativeId: string): Promise<string> {
  const skills = await adapterSkills(adapter, nativeId);
  const profileInfo = readDshAcpProfile();
  const lines = [`### dsh 可用命令与技能`];
  for (const item of skills.slice(0, 60)) {
    const name = String(item.name ?? '');
    const hint = typeof item.argument_hint === 'string' && item.argument_hint ? ` ${item.argument_hint}` : '';
    const desc = String(item.description ?? '').replace(/\s+/g, ' ').slice(0, 100);
    lines.push(`- \`/${name}${hint}\`${desc ? ` — ${desc}` : ''}`);
  }
  const allDeclared = [
    ...profileInfo.bundles,
    ...profileInfo.dependencies,
    ...profileInfo.patchPlugins,
  ];
  if (allDeclared.length > 0) {
    lines.push('· ACP Profile 配置项（配置声明，非运行时状态）:');
    if (profileInfo.bundles.length > 0) {
      lines.push(`  - Bundles (package.json): ${profileInfo.bundles.join(', ')}`);
    }
    if (profileInfo.dependencies.length > 0) {
      lines.push(`  - Dependencies (package.json): ${profileInfo.dependencies.join(', ')}`);
    }
    if (profileInfo.patchPlugins.length > 0) {
      lines.push(`  - 补丁声明 (cordis.patch.yml): ${profileInfo.patchPlugins.join(', ')}`);
    }
  } else {
    lines.push('· ACP Profile 配置项: 未检测到 profile 配置文件');
  }
  return lines.join('\n');
}

async function renderProviderHelp(
  adapter: ProviderAdapter,
  provider: LocalProviderName,
  nativeId: string,
): Promise<string> {
  const cmds = adapter.listCommands ? await adapter.listCommands(nativeId).catch(() => [] as NativeCommand[]) : [];
  const runnable = cmds.filter((c) => !c.terminalOnly);
  const lines = [`### ${provider} Web UI 可用命令（${runnable.length}）`];
  for (const c of runnable.slice(0, 50)) {
    const hint = c.argumentHint ? ` ${c.argumentHint}` : '';
    const aliasText = c.aliases && c.aliases.length > 0 ? `（别名: ${c.aliases.map((a) => `/${a}`).join(', ')}）` : '';
    const desc = c.description.replace(/\s+/g, ' ').slice(0, 90);
    lines.push(`- \`/${c.name}${hint}\` ${aliasText}— ${desc}`);
  }
  if (runnable.length > 50) lines.push(`- …输入 \`/\` 打开完整命令菜单（共 ${runnable.length} 项）`);
  return lines.join('\n');
}

function renderPiUsage(adapter: ProviderAdapter, nativeId: string): string {
  const u = adapter.getUsage?.(nativeId);
  if (!u || (u.input_tokens === 0 && u.output_tokens === 0)) return '∑ 暂无用量数据(完成一轮对话后可见)。';
  const lines = [
    '∑ Pi 用量统计(本会话累计)',
    `· 输入 tokens:${u.input_tokens.toLocaleString()}`,
    `· 输出 tokens:${u.output_tokens.toLocaleString()}`,
    `· 缓存读:${u.cache_read_tokens.toLocaleString()} · 缓存写:${u.cache_creation_tokens.toLocaleString()}`,
  ];
  if (u.total_cost_usd > 0) lines.push(`· 费用:$${u.total_cost_usd.toFixed(4)}`);
  return lines.join('\n');
}

function renderMcpServers(servers: Array<Record<string, unknown>>): string {
  if (servers.length === 0) return 'MCP 服务器:无(0)。';
  const lines = [`MCP 服务器(${servers.length})`];
  for (const s of servers) {
    const name = String(s.name ?? s.id ?? '?');
    const status = String(s.status ?? s.authStatus ?? 'unknown');
    lines.push(`· ${name} — ${status}`);
  }
  return lines.join('\n');
}

function newActiveTurn(sessionId: string, promptId: string): ActiveTurn {
  return {
    sessionId,
    turnId: '',
    promptId,
    cancelled: false,
    assistantText: '',
    thinkingText: '',
    runningTools: new Map(),
    pendingApprovals: new Map(),
    pendingQuestions: new Map(),
    v262TurnId: `turn_${promptId}`,
    v262Ordinal: 0,
    v262StartedAt: new Date().toISOString(),
    v262StepIndex: 0,
    v262Items: [],
    v262ItemMap: new Map(),
  };
}

function closeV262Thinking(hub: SessionHub, sid: string, turn: ActiveTurn): void {
  if (!turn.v262ThinkingItemId) return;
  const item = turn.v262ItemMap.get(turn.v262ThinkingItemId);
  turn.v262ThinkingItemId = undefined;
  if (!item) return;
  item.status = 'ended';
  if (turn.v262ThinkingStartedAt !== undefined) {
    item.duration_ms = Math.max(0, Date.now() - turn.v262ThinkingStartedAt);
  }
  hub.broadcastV262(sid, {
    type: 'item.ended',
    session_id: sid,
    agent_id: 'main',
    turn_id: turn.v262TurnId,
    item,
  });
}

function closeV262Assistant(hub: SessionHub, sid: string, turn: ActiveTurn): void {
  if (!turn.v262AssistantItemId) return;
  const item = turn.v262ItemMap.get(turn.v262AssistantItemId);
  turn.v262AssistantItemId = undefined;
  if (!item) return;
  item.status = 'ended';
  hub.broadcastV262(sid, {
    type: 'item.ended',
    session_id: sid,
    agent_id: 'main',
    turn_id: turn.v262TurnId,
    item,
  });
}

function emitV262SteerUserItem(
  hub: SessionHub,
  sid: string,
  turn: ActiveTurn,
  promptId: string,
  text: string,
  attachments: TurnAttachment[],
): void {
  const item: Record<string, unknown> = {
    item_id: `${promptId}_steer`,
    type: 'user_message',
    placement: 'steer',
    origin: { kind: 'user' },
    text,
    prompt_ids: [promptId],
    attachments: attachments.map((a) => ({
      kind: a.kind === 'localImage' || a.kind === 'imageDataUrl' ? 'image' : 'file',
      ...(a.name ? { name: a.name } : {}),
      ...(a.mediaType ? { media_type: a.mediaType } : {}),
      ...(a.size !== undefined ? { size: a.size } : {}),
    })),
    skills: [],
    created_at: new Date().toISOString(),
  };
  turn.v262Items.push(item);
  turn.v262ItemMap.set(String(item.item_id), item);
  hub.broadcastV262(sid, {
    type: 'item.started',
    session_id: sid,
    agent_id: 'main',
    turn_id: turn.v262TurnId,
    item,
  });
  hub.broadcastV262(sid, {
    type: 'item.ended',
    session_id: sid,
    agent_id: 'main',
    turn_id: turn.v262TurnId,
    item,
  });
}

function emitV262AgentState(
  hub: SessionHub,
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  sid: string,
  status: 'idle' | 'running',
  compacting = false,
): void {
  const caps = adapter.capabilities();
  const thinking = adapter.getThinking?.(nativeId);
  hub.broadcastV262(sid, {
    type: 'agent',
    session_id: sid,
    agent_id: 'main',
    status,
    compacting,
    model: adapter.getModel?.(nativeId) ?? '',
    ...(thinking ? { thinking } : {}),
    permission_mode: adapter.getPermission?.(nativeId) ?? 'default',
    plan_mode: caps.planMode === false ? false : (adapter.getPlanMode?.(nativeId) ?? false),
    swarm_mode: false,
    tower_mode: false,
  });
}

function emitV262Usage(
  hub: SessionHub,
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  sid: string,
): void {
  const usage = adapter.getUsage?.(nativeId);
  if (!usage) return;
  let contextLimit = usage.context_limit ?? 0;
  const model = adapter.getModel?.(nativeId) ?? '';
  if (contextLimit <= 0 && provider === 'claude' && model) contextLimit = claudeContextWindow(model);
  if (contextLimit <= 0 && provider === 'grok') contextLimit = grokStatusContextFallback();
  if (contextLimit <= 0 && provider === 'dsh') contextLimit = dshStatusContextFallback();
  hub.broadcastV262(sid, {
    type: 'usage',
    session_id: sid,
    agent_id: 'main',
    context_tokens: usage.context_unavailable ? 0 : (usage.context_tokens ?? 0),
    max_context_tokens: contextLimit,
  });
}

type Emit = (type: string, payload: Record<string, unknown>, volatile?: boolean, offset?: number) => void;

function emitAssistantDeltaText(
  delta: string,
  turn: ActiveTurn,
  emit: Emit,
  ensureStep: () => void,
  sid: string,
  hub: SessionHub,
): void {
  if (!delta) return;
  ensureStep();
  const offset = turn.assistantText.length;
  turn.assistantText += delta;
  turn.transcript?.append('assistant', delta);
  emit('assistant.delta', { turnId: 0, delta }, true, offset);

  closeV262Thinking(hub, sid, turn);
  if (!turn.v262AssistantItemId) {
    const itemId = `${turn.v262TurnId}_asst_${turn.v262Items.length}`;
    const item: Record<string, unknown> = {
      item_id: itemId,
      type: 'assistant_message',
      status: 'running',
      text: '',
      created_at: new Date().toISOString(),
      step_index: turn.v262StepIndex,
    };
    turn.v262AssistantItemId = itemId;
    turn.v262Items.push(item);
    turn.v262ItemMap.set(itemId, item);
    hub.broadcastV262(sid, {
      type: 'item.started',
      session_id: sid,
      agent_id: 'main',
      turn_id: turn.v262TurnId,
      item: { ...item },
    });
  }
  const asst = turn.v262ItemMap.get(turn.v262AssistantItemId)!;
  asst.text = `${String(asst.text ?? '')}${delta}`;
  hub.broadcastV262(sid, {
    type: 'item.delta',
    session_id: sid,
    agent_id: 'main',
    turn_id: turn.v262TurnId,
    item_id: turn.v262AssistantItemId,
    field: 'text',
    delta,
  });
}

function consumeEvent(
  ev: GatewayEvent,
  turn: ActiveTurn,
  emit: Emit,
  ensureStep: () => void,
  completeStep: () => void,
  sid: string,
  hub: SessionHub,
  provider: ProviderName = 'kimi',
): void {
  if (ev.kind === 'message' && ev.status === 'delta') {
    const delta = (ev.payload as { delta?: string }).delta ?? '';
    emitAssistantDeltaText(delta, turn, emit, ensureStep, sid, hub);
  } else if (ev.kind === 'thinking' && ev.status === 'delta') {
    const delta = (ev.payload as { delta?: string }).delta ?? '';
    if (!delta) return;
    ensureStep();
    const offset = turn.thinkingText.length;
    turn.thinkingText += delta;
    turn.transcript?.append('thinking', delta);
    emit('thinking.delta', { turnId: 0, delta }, true, offset);

    closeV262Assistant(hub, sid, turn);
    if (!turn.v262ThinkingItemId) {
      const itemId = `${turn.v262TurnId}_think_${turn.v262Items.length}`;
      const now = Date.now();
      const iso = new Date(now).toISOString();
      const item: Record<string, unknown> = {
        item_id: itemId,
        type: 'reasoning',
        status: 'running',
        text: '',
        started_at: iso,
        created_at: iso,
        step_index: turn.v262StepIndex,
      };
      turn.v262ThinkingItemId = itemId;
      turn.v262ThinkingStartedAt = now;
      turn.v262Items.push(item);
      turn.v262ItemMap.set(itemId, item);
      hub.broadcastV262(sid, {
        type: 'item.started',
        session_id: sid,
        agent_id: 'main',
        turn_id: turn.v262TurnId,
        item: { ...item },
      });
    }
    const think = turn.v262ItemMap.get(turn.v262ThinkingItemId)!;
    think.text = `${String(think.text ?? '')}${delta}`;
    hub.broadcastV262(sid, {
      type: 'item.delta',
      session_id: sid,
      agent_id: 'main',
      turn_id: turn.v262TurnId,
      item_id: turn.v262ThinkingItemId,
      field: 'text',
      delta,
    });
  } else if (ev.kind === 'tool') {
    const p = ev.payload as {
      toolCallId: string;
      name: string;
      input?: unknown;
      output?: string;
      structuredOutput?: unknown;
      isError?: boolean;
      is_error?: boolean;
      agentId?: string;
      agent_id?: string;
      receiverThreadIds?: string[];
    };
    const normalized = normalizeKimiWebTool(p.name || 'tool', p.input ?? {});
    const directAgentId = ev.agentId ?? p.agentId ?? p.agent_id ?? p.receiverThreadIds?.[0];
    if (ev.status === 'started') {
      ensureStep();
      closeV262Thinking(hub, sid, turn);
      closeV262Assistant(hub, sid, turn);
      turn.runningTools.set(p.toolCallId, { name: normalized.name, args: normalized.input });
      const inputSubagentId = normalized.name === 'Agent' ? extractSubagentIdFromOutput(normalized.input) : undefined;
      const linked = hub.transcript.getLinkedSubagents(sid, p.toolCallId);
      const agentRefs = mergeAgentRefs(undefined, [directAgentId, inputSubagentId, ...linked]);
      if (agentRefs && (normalized.name === 'Agent' || directAgentId)) {
        for (const ref of agentRefs) {
          hub.transcript.linkSubagentToToolCall(sid, p.toolCallId, ref.agent_id);
        }
      }
      turn.transcript?.toolStarted(p.toolCallId, p.name, p.input ?? {}, {
        ...(ev.phase ? { phase: ev.phase } : {}),
        ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
        ...(directAgentId ? { agentId: directAgentId } : {}),
        ...(agentRefs ? { agentRefs: agentRefs.map((r) => ({ agentId: r.agent_id, role: r.role })) } : {}),
      });
      emit('tool.call.started', { turnId: 0, toolCallId: p.toolCallId, name: normalized.name, args: normalized.input ?? {} });

      const toolItem: Record<string, unknown> = {
        item_id: p.toolCallId,
        type: 'tool_call',
        name: normalized.name,
        input: normalized.input ?? {},
        status: 'running',
        started_at: new Date().toISOString(),
        step_index: turn.v262StepIndex,
        ...(agentRefs ? { agent_refs: agentRefs } : {}),
      };
      turn.v262Items.push(toolItem);
      turn.v262ItemMap.set(p.toolCallId, toolItem);
      hub.broadcastV262(sid, {
        type: 'item.started',
        session_id: sid,
        agent_id: 'main',
        turn_id: turn.v262TurnId,
        item: toolItem,
      });
    } else if (ev.status === 'delta') {
      const delta = p.output ?? '';
      if (!delta) return;
      const mode = (p as { outputMode?: string; output_mode?: string }).outputMode
        ?? (p as { outputMode?: string; output_mode?: string }).output_mode
        ?? 'append';
      emit('tool.progress', { turnId: 0, toolCallId: p.toolCallId, output: delta, ...(mode !== 'append' ? { outputMode: mode } : {}) });
      const existingTool = turn.v262ItemMap.get(p.toolCallId);
      if (existingTool) {
        if (mode === 'replace') {
          existingTool.output = delta;
          hub.broadcastV262(sid, {
            type: 'item.updated',
            session_id: sid,
            agent_id: 'main',
            turn_id: turn.v262TurnId,
            item_id: p.toolCallId,
            set: { output: delta },
          });
        } else {
          existingTool.output = `${String(existingTool.output ?? '')}${delta}`;
          hub.broadcastV262(sid, {
            type: 'item.delta',
            session_id: sid,
            agent_id: 'main',
            turn_id: turn.v262TurnId,
            item_id: p.toolCallId,
            field: 'output',
            delta,
          });
        }
      }
    } else {
      turn.runningTools.delete(p.toolCallId);
      const isError = p.isError ?? p.is_error ?? (ev.status === 'failed');
      const existingTool = turn.v262ItemMap.get(p.toolCallId);
      const resolvedOut = (p.output === undefined || p.output === '') && p.structuredOutput !== undefined
        ? (typeof p.structuredOutput === 'string' ? p.structuredOutput : JSON.stringify(p.structuredOutput))
        : (p.output ?? (existingTool?.output as string | undefined) ?? '');
      const extractedOutId = extractSubagentIdFromOutput(resolvedOut) ?? extractSubagentIdFromOutput(p.structuredOutput);
      const linked = hub.transcript.getLinkedSubagents(sid, p.toolCallId);
      const agentRefs = mergeAgentRefs(existingTool?.agent_refs, [directAgentId, extractedOutId, ...linked]);
      if (agentRefs) {
        for (const ref of agentRefs) {
          hub.transcript.linkSubagentToToolCall(sid, p.toolCallId, ref.agent_id);
        }
      }
      turn.transcript?.toolResult(p.toolCallId, resolvedOut, isError, {
        ...(p.structuredOutput !== undefined ? { structuredOutput: p.structuredOutput } : {}),
        ...(ev.phase ? { phase: ev.phase } : {}),
        ...(ev.parentToolUseId ? { parentToolUseId: ev.parentToolUseId } : {}),
        ...(directAgentId ? { agentId: directAgentId } : {}),
        ...(agentRefs ? { agentRefs: agentRefs.map((r) => ({ agentId: r.agent_id, role: r.role })) } : {}),
      });
      emit('tool.result', { turnId: 0, toolCallId: p.toolCallId, output: resolvedOut, isError });

      const endedTool: Record<string, unknown> = existingTool ?? {
        item_id: p.toolCallId,
        type: 'tool_call',
        name: normalized.name,
        input: normalized.input ?? {},
        started_at: new Date().toISOString(),
        step_index: turn.v262StepIndex,
      };
      endedTool.status = 'ended';
      endedTool.outcome = isError ? 'failed' : 'completed';
      endedTool.output = resolvedOut;
      if (isError && resolvedOut) endedTool.error = resolvedOut;
      endedTool.ended_at = new Date().toISOString();
      if (agentRefs) endedTool.agent_refs = agentRefs;
      if (!existingTool) {
        turn.v262Items.push(endedTool);
        turn.v262ItemMap.set(p.toolCallId, endedTool);
      }
      hub.broadcastV262(sid, {
        type: 'item.ended',
        session_id: sid,
        agent_id: 'main',
        turn_id: turn.v262TurnId,
        item: endedTool,
      });
      completeStep();
    }
  } else if (ev.kind === 'subagent') {
    const p = (ev.payload ?? {}) as {
      agentId?: string;
      agent_id?: string;
      parentToolUseId?: string;
      parent_tool_use_id?: string;
      name?: string;
      status?: string;
      summary?: string;
    };
    const agentId = ev.agentId ?? p.agentId ?? p.agent_id;
    const parentToolUseId = ev.parentToolUseId ?? p.parentToolUseId ?? p.parent_tool_use_id;
    if (agentId) {
      if (parentToolUseId) {
        hub.transcript.linkSubagentToToolCall(sid, parentToolUseId, agentId);
        const parentItem = turn.v262ItemMap.get(parentToolUseId);
        if (parentItem) {
          const nextRefs = mergeAgentRefs(parentItem.agent_refs, [agentId]);
          if (nextRefs) {
            parentItem.agent_refs = nextRefs;
            hub.broadcastV262(sid, {
              type: 'item.updated',
              session_id: sid,
              agent_id: 'main',
              turn_id: turn.v262TurnId,
              item_id: parentToolUseId,
              set: { agent_refs: nextRefs },
            });
          }
        }
      }
      const existing = hub.transcript.currentTasks(sid).find((t) => t.taskId === agentId || t.agentId === agentId);
      const taskState: TranscriptTask['state'] = ev.status === 'failed'
        ? 'failed'
        : ev.status === 'cancelled'
          ? 'killed'
          : ev.status === 'completed'
            ? 'completed'
            : 'running';
      const nextTask: TranscriptTask = {
        taskId: existing?.taskId ?? agentId,
        kind: 'subagent',
        state: taskState,
        detached: existing?.detached ?? false,
        description: p.summary ?? existing?.description ?? p.name ?? `Subagent ${agentId.slice(0, 8)}`,
        agentId,
        ...(parentToolUseId ?? existing?.parentToolUseId ? { parentToolUseId: parentToolUseId ?? existing?.parentToolUseId } : {}),
        outputTail: p.summary ?? existing?.outputTail ?? '',
        startedAt: existing?.startedAt ?? new Date(ev.timestamp || Date.now()).toISOString(),
        ...(taskState !== 'running' ? { endedAt: new Date(ev.timestamp || Date.now()).toISOString() } : {}),
        ...(taskState === 'completed' && p.summary ? { resultSummary: p.summary } : existing?.resultSummary ? { resultSummary: existing.resultSummary } : {}),
        ...(taskState === 'failed' && p.summary ? { error: p.summary } : {}),
      };
      hub.transcript.upsertTask(sid, nextTask);
      hub.broadcastV262(sid, {
        type: 'task',
        session_id: sid,
        agent_id: 'main',
        ...toWireTask(nextTask),
      });
    }
  } else if (ev.kind === 'task') {
    const p = (ev.payload ?? {}) as {
      taskId?: string;
      task_id?: string;
      description?: string;
      toolUseId?: string;
      subagentType?: string;
      taskType?: string;
      isBackgrounded?: boolean;
      summary?: string;
      lastToolName?: string;
      patch?: Record<string, unknown>;
    };
    const taskId = p.taskId ?? p.task_id;
    if (taskId) {
      const existing = hub.transcript.currentTasks(sid).find((t) => t.taskId === taskId);
      const patchDesc = typeof p.patch?.description === 'string' ? p.patch.description : undefined;
      const isSubagent = Boolean(p.subagentType || p.taskType === 'subagent' || existing?.kind === 'subagent');
      const parentToolUseId = p.toolUseId ?? ev.parentToolUseId ?? existing?.parentToolUseId;
      const taskState: TranscriptTask['state'] = ev.status === 'failed'
        ? 'failed'
        : ev.status === 'cancelled'
          ? 'killed'
          : ev.status === 'completed'
            ? 'completed'
            : 'running';
      const nextTask: TranscriptTask = {
        taskId,
        kind: isSubagent ? 'subagent' : existing?.kind ?? 'tool',
        state: taskState,
        detached: p.isBackgrounded ?? existing?.detached ?? false,
        ...(p.description ?? patchDesc ?? existing?.description ? { description: p.description ?? patchDesc ?? existing?.description } : {}),
        ...(isSubagent ? { agentId: existing?.agentId ?? taskId } : existing?.agentId ? { agentId: existing.agentId } : {}),
        ...(parentToolUseId ? { parentToolUseId } : {}),
        outputTail: p.summary ?? p.lastToolName ?? existing?.outputTail ?? '',
        startedAt: existing?.startedAt ?? new Date(ev.timestamp || Date.now()).toISOString(),
        ...(taskState !== 'running' ? { endedAt: new Date(ev.timestamp || Date.now()).toISOString() } : {}),
        ...(taskState === 'completed' && p.summary ? { resultSummary: p.summary } : existing?.resultSummary ? { resultSummary: existing.resultSummary } : {}),
        ...(taskState === 'failed' && p.summary ? { error: p.summary } : {}),
      };
      hub.transcript.upsertTask(sid, nextTask);
      hub.broadcastV262(sid, {
        type: 'task',
        session_id: sid,
        agent_id: 'main',
        ...toWireTask(nextTask),
      });
    }
  } else if (ev.kind === 'approval') {
    const p = ev.payload as { approvalId: string; tool: string; input?: unknown; itemId?: string };
    turn.pendingApprovals.set(p.approvalId, { tool: p.tool, input: p.input, itemId: p.itemId });
    const dto = approvalDto(sid, p.approvalId, turn);
    hub.transcript.requestInteraction(sid, {
      interactionId: p.approvalId,
      interactionKind: 'approval',
      ...(p.itemId ? { toolCallId: p.itemId } : {}),
      state: 'pending',
      request: dto,
    });
    emit('event.approval.requested', dto);
    emit('event.session.work_changed', { busy: true, main_turn_active: true, pending_interaction: 'approval' });
    hub.broadcastV262(sid, v262PendingApprovalFrame(sid, p.approvalId, turn));
  } else if (ev.kind === 'question') {
    const p = ev.payload as { questionId: string; prompt: string; rawQuestions?: unknown[]; itemId?: string };
    turn.pendingQuestions.set(p.questionId, { prompt: p.prompt, rawQuestions: p.rawQuestions });
    const request = questionDto(sid, p.questionId, { prompt: p.prompt, rawQuestions: p.rawQuestions });
    hub.transcript.requestInteraction(sid, {
      interactionId: p.questionId,
      interactionKind: 'question',
      ...(p.itemId ? { toolCallId: p.itemId } : {}),
      state: 'pending',
      request,
    });
    emit('event.question.requested', request);
    emit('event.session.work_changed', { busy: true, main_turn_active: true, pending_interaction: 'question' });
    hub.broadcastV262(sid, v262PendingQuestionFrame(sid, p.questionId, p.itemId, { prompt: p.prompt, rawQuestions: p.rawQuestions }));
  } else if (ev.kind === 'notice') {
    const p = ev.payload as { level?: string; message?: string; title?: string } | undefined;
    const rawMsg = typeof p?.message === 'string' ? p.message.trim() : '';
    if (rawMsg) {
      const prefix = p?.level === 'error' ? '✗ ' : p?.level === 'warning' ? '⚠ ' : '';
      const title = typeof p?.title === 'string' && p.title.trim() ? `**${p.title.trim()}**\n` : '';
      const sep = turn.assistantText ? '\n\n' : '';
      emitAssistantDeltaText(`${sep}${prefix}${title}${rawMsg}`, turn, emit, ensureStep, sid, hub);
    }
  } else if (ev.kind === 'usage') {
    const u = ev.payload as Partial<SessionUsage> | undefined;
    if (u) {
      let limit = u.context_limit ?? 0;
      if (limit <= 0 && provider === 'grok') limit = grokStatusContextFallback();
      if (limit <= 0 && provider === 'dsh') limit = dshStatusContextFallback();
      hub.broadcastV262(sid, {
        type: 'usage',
        session_id: sid,
        agent_id: 'main',
        context_tokens: u.context_unavailable ? 0 : (u.context_tokens ?? 0),
        max_context_tokens: limit,
      });
    }
  } else if (ev.kind === 'passthrough') {
    const p = ev.payload as { method?: string; data?: unknown } | undefined;
    if (p?.method === 'extension_ui' && p.data && typeof p.data === 'object') {
      hub.broadcastV262(sid, {
        type: 'extension_ui',
        session_id: sid,
        agent_id: 'main',
        ...(p.data as Record<string, unknown>),
      });
    }
  } else if (ev.kind === 'diff') {
    // codex: turn 进行中的文件改动增量(patchUpdated)与终态 diff(diffUpdated)。
    // delta 只推轻量文件清单;updated 落最终 diff 文本。
    const p = ev.payload as { diff?: string; files?: string[] } | undefined;
    if (ev.status === 'delta' && Array.isArray(p?.files) && p.files.length > 0) {
      const sep = turn.assistantText ? '\n\n' : '';
      emitAssistantDeltaText(`${sep}⚙ 文件改动中: ${p.files.join(', ')}`, turn, emit, ensureStep, sid, hub);
    } else if (ev.status === 'updated' && typeof p?.diff === 'string' && p.diff.trim()) {
      const sep = turn.assistantText ? '\n\n' : '';
      const clipped = p.diff.length > 16 * 1024 ? `${p.diff.slice(0, 16 * 1024)}\n…(已截断)` : p.diff;
      emitAssistantDeltaText(`${sep}\`\`\`diff\n${clipped.trimEnd()}\n\`\`\``, turn, emit, ensureStep, sid, hub);
    }
  } else if (ev.kind === 'turn') {
    // 终态由 driveTurn 的 finally 统一广播。
  }
}

/**
 * 中止当前 turn。返回是否真的中止了一个活动 turn——无活动时调用方应如实
 * 回 aborted:false,而不是谎称成功。帧序:turn.ended → prompt.aborted →
 * work_changed(前端投影器按 promptId 清 in-flight 状态,顺序敏感)。
 */
async function abortTurn(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  hub: SessionHub,
  demoActive: boolean = false,
  uploadStore?: UploadStore,
): Promise<boolean> {
  const sid = prefixedId(provider, nativeId);
  const active = hub.busy.get(sid);
  if (!active) return false;
  active.cancelled = true;
  if (active.localQuestionResolvers && active.localQuestionResolvers.size > 0) {
    for (const [qid, resolver] of [...active.localQuestionResolvers.entries()]) {
      active.localQuestionResolvers.delete(qid);
      try { resolver(null); } catch { /* ignore */ }
    }
  }
  await adapter.interrupt(nativeId, active.turnId || undefined);
  hub.busy.delete(sid);
  closeV262Thinking(hub, sid, active);
  closeV262Assistant(hub, sid, active);
  active.transcript?.end('cancelled', 0);
  hub.transcript.finishPrompt(sid, active.promptId, 'aborted');
  hub.broadcast(sid, frame(sid, hub, 'turn.ended', { turnId: 0, reason: 'cancelled', durationMs: 0 }));
  hub.broadcast(sid, frame(sid, hub, 'prompt.aborted', { promptId: active.promptId, abortedAt: new Date().toISOString() }));
  hub.broadcast(sid, frame(sid, hub, 'event.session.work_changed', { busy: false, main_turn_active: false, pending_interaction: 'none', last_turn_reason: 'cancelled' }));
  hub.broadcastV262(sid, {
    type: 'turn.ended',
    session_id: sid,
    agent_id: 'main',
    turn: {
      turn_id: active.v262TurnId,
      ordinal: active.v262Ordinal,
      turn_number: active.v262Ordinal + 1,
      kind: 'agent',
      status: 'ended',
      outcome: 'interrupted',
      duration_ms: 0,
      started_at: active.v262StartedAt,
      ended_at: new Date().toISOString(),
      steps: [{ index: 0 }],
      items: [],
    },
  });
  emitV262AgentState(hub, adapter, provider, nativeId, sid, 'idle');
  drainQueue(adapter, provider, nativeId, hub, demoActive, uploadStore);
  return true;
}

// ---------------------------------------------------------------------------
// approvals / questions
// ---------------------------------------------------------------------------

function v262PendingApprovalFrame(sid: string, approvalId: string, turn: ActiveTurn): Record<string, unknown> {
  const a = turn.pendingApprovals.get(approvalId);
  return {
    type: 'interaction',
    session_id: sid,
    agent_id: 'main',
    interaction_id: approvalId,
    kind: 'approval',
    status: 'pending',
    tool_call_id: a?.itemId ?? approvalId,
    request: {
      tool_name: a?.tool ?? 'commandExecution',
      action: a?.tool ?? 'commandExecution',
      tool_input_display: a?.input ?? null,
    },
  };
}

function v262PendingQuestionFrame(
  sid: string,
  questionId: string,
  toolCallId: string | undefined,
  q: { prompt: string; rawQuestions?: unknown[] },
): Record<string, unknown> {
  return {
    type: 'interaction',
    session_id: sid,
    agent_id: 'main',
    interaction_id: questionId,
    kind: 'question',
    status: 'pending',
    ...(toolCallId ? { tool_call_id: toolCallId } : {}),
    request: {
      questions: structuredQuestionItems(q.rawQuestions) ?? [{ id: 'q_0', question: q.prompt, options: [] }],
    },
  };
}

function pendingApprovals(sid: string, hub: SessionHub): unknown[] {
  const active = hub.busy.get(sid);
  if (!active) return [];
  return [...active.pendingApprovals.keys()].map((id) => approvalDto(sid, id, active));
}

function approvalDto(sid: string, approvalId: string, turn: ActiveTurn): Record<string, unknown> {
  const a = turn.pendingApprovals.get(approvalId);
  return {
    approval_id: approvalId,
    session_id: sid,
    turn_id: 0,
    // codex 的审批挂在发起它的 item 上;没有 itemId 时退回 approvalId 占位。
    tool_call_id: a?.itemId ?? approvalId,
    tool_name: a?.tool ?? 'commandExecution',
    action: a?.tool ?? 'commandExecution',
    tool_input_display: a?.input ?? null,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
  };
}

function pendingQuestions(sid: string, hub: SessionHub): unknown[] {
  const active = hub.busy.get(sid);
  if (!active) return [];
  return [...active.pendingQuestions.entries()].map(([id, q]) => questionDto(sid, id, q));
}

function questionDto(sid: string, questionId: string, q: { prompt: string; rawQuestions?: unknown[] }): Record<string, unknown> {
  return {
    question_id: questionId,
    session_id: sid,
    // codex 结构化提问原样透出(id/header/options 全保留);没有原始结构时
    // 退回单条自由文本提问。
    questions: structuredQuestionItems(q.rawQuestions) ?? [{ id: 'q_0', question: q.prompt, options: [] }],
    created_at: new Date().toISOString(),
  };
}

/**
 * codex requestUserInput 的 questions[] → WireQuestionItem[]。
 * 字段名宽容读取(实测/schema 之间命名不完全稳定);缺 id 时按下标补 q_N。
 */
function structuredQuestionItems(raw: unknown[] | undefined): Array<Record<string, unknown>> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.map((item, i) => {
    const q = (item ?? {}) as Record<string, unknown>;
    const options = Array.isArray(q.options)
      ? (q.options as Record<string, unknown>[]).map((o, j) => ({
          id: String(o?.id ?? o?.label ?? `opt_${j}`),
          label: String(o?.label ?? o?.id ?? `选项 ${j + 1}`),
          ...(typeof o?.description === 'string' ? { description: o.description } : {}),
        }))
      : [];
    const otherLabel = typeof q.otherLabel === 'string' ? q.otherLabel : typeof q.other_label === 'string' ? q.other_label : undefined;
    const otherDesc = typeof q.otherDescription === 'string' ? q.otherDescription : typeof q.other_description === 'string' ? q.other_description : undefined;
    const otherPh = typeof q.otherPlaceholder === 'string' ? q.otherPlaceholder : typeof q.other_placeholder === 'string' ? q.other_placeholder : undefined;
    return {
      id: String(q.id ?? `q_${i}`),
      question: String(q.question ?? q.header ?? ''),
      ...(typeof q.header === 'string' ? { header: q.header } : {}),
      ...(typeof q.body === 'string' && q.body ? { body: q.body } : {}),
      options,
      ...(q.multiSelect === true || q.multi_select === true ? { multi_select: true } : {}),
      ...(q.isOther === true || q.allow_other === true ? { allow_other: true } : {}),
      ...(otherLabel ? { other_label: otherLabel } : {}),
      ...(otherDesc ? { other_description: otherDesc } : {}),
      ...(otherPh ? { other_placeholder: otherPh } : {}),
    };
  });
}

async function resolveApproval(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  approvalId: string,
  body: Record<string, unknown> & { decision: string; scope?: string },
  hub: SessionHub,
): Promise<void> {
  // 前端"允许本次会话"带 scope:'session',映射 approve_always → codex/claude 持久放行。
  const base = body.decision === 'approved' ? 'approve' : 'reject';
  const decision = base === 'approve' && (body.scope === 'session' || body.scope === 'always')
    ? 'approve_always'
    : base;
  const details: GranularApprovalDetails = {};
  let hasDetails = false;
  if (typeof body.scope === 'string') { details.scope = body.scope; hasDetails = true; }
  if (typeof body.feedback === 'string') { details.message = body.feedback; hasDetails = true; }
  if (typeof body.message === 'string') { details.message = body.message; hasDetails = true; }
  if (Array.isArray(body.updatedPermissions)) { details.updatedPermissions = body.updatedPermissions; hasDetails = true; }
  if (body.updatedInput !== undefined) { details.updatedInput = body.updatedInput; hasDetails = true; }
  if (Array.isArray(body.execpolicyAmendment)) { details.execpolicyAmendment = body.execpolicyAmendment as string[]; hasDetails = true; }
  if (body.networkPolicyAmendment && typeof body.networkPolicyAmendment === 'object') {
    details.networkPolicyAmendment = body.networkPolicyAmendment as GranularApprovalDetails['networkPolicyAmendment'];
    hasDetails = true;
  }
  if (body.permissions && typeof body.permissions === 'object') {
    details.permissions = body.permissions as Record<string, unknown>;
    hasDetails = true;
  }
  if (body.elicitation && typeof body.elicitation === 'object') {
    details.elicitation = body.elicitation as GranularApprovalDetails['elicitation'];
    hasDetails = true;
  }
  if (body.nativeDecision !== undefined) { details.nativeDecision = body.nativeDecision; hasDetails = true; }
  if (hasDetails) {
    await adapter.resolveApproval(nativeId, approvalId, decision, details);
  } else {
    await adapter.resolveApproval(nativeId, approvalId, decision);
  }
  const sid = prefixedId(provider, nativeId);
  const active = hub.busy.get(sid);
  active?.pendingApprovals.delete(approvalId);
  hub.transcript.resolveInteraction(
    sid,
    approvalId,
    body.decision === 'approved' ? 'approved' : 'rejected',
    { decision: body.decision, scope: body.scope },
  );
  hub.broadcast(sid, frame(sid, hub, 'event.approval.resolved', {
    approval_id: approvalId,
    decision: body.decision,
    resolved_by: 'user',
    resolved_at: new Date().toISOString(),
  }));
  hub.broadcastV262(sid, {
    type: 'interaction',
    session_id: sid,
    agent_id: 'main',
    interaction_id: approvalId,
    kind: 'approval',
    status: 'ended',
    outcome: body.decision === 'approved' ? 'approved' : 'rejected',
    response: {
      ...(typeof body.feedback === 'string' ? { feedback: body.feedback } : {}),
      ...(typeof body.selected_label === 'string' ? { selected_label: body.selected_label } : {}),
    },
  });
  const pending = (active?.pendingApprovals.size ?? 0) > 0 ? 'approval' : (active?.pendingQuestions.size ?? 0) > 0 ? 'question' : 'none';
  hub.broadcast(sid, frame(sid, hub, 'event.session.work_changed', { busy: active !== undefined, main_turn_active: active !== undefined, pending_interaction: pending }));
}

async function resolveQuestion(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  questionId: string,
  body: { answers?: Record<string, unknown>; text?: string },
  hub: SessionHub,
): Promise<void> {
  let payload: string | Record<string, string[]>;
  if (body.answers && Object.keys(body.answers).length > 0) {
    const out: Record<string, string[]> = {};
    for (const [qid, ans] of Object.entries(body.answers)) out[qid] = wireAnswerStrings(ans);
    payload = out;
  } else {
    payload = body.text ?? '';
  }
  const sid = prefixedId(provider, nativeId);
  const active = hub.busy.get(sid);
  const localResolver = active?.localQuestionResolvers?.get(questionId);
  if (localResolver) {
    active!.localQuestionResolvers!.delete(questionId);
    localResolver(payload);
  } else {
    await adapter.resolveQuestion(nativeId, questionId, payload);
  }
  active?.pendingQuestions.delete(questionId);
  hub.transcript.resolveInteraction(sid, questionId, 'answered', payload);
  hub.broadcast(sid, frame(sid, hub, 'event.question.answered', {
    question_id: questionId,
    answers: body.answers ?? {},
    resolved_by: 'user',
    resolved_at: new Date().toISOString(),
  }));
  hub.broadcastV262(sid, {
    type: 'interaction',
    session_id: sid,
    agent_id: 'main',
    interaction_id: questionId,
    kind: 'question',
    status: 'ended',
    outcome: 'answered',
  });
  const pending = (active?.pendingApprovals.size ?? 0) > 0 ? 'approval' : (active?.pendingQuestions.size ?? 0) > 0 ? 'question' : 'none';
  hub.broadcast(sid, frame(sid, hub, 'event.session.work_changed', { busy: active !== undefined, main_turn_active: active !== undefined, pending_interaction: pending }));
}

async function dismissQuestion(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  questionId: string,
  hub: SessionHub,
): Promise<void> {
  const sid = prefixedId(provider, nativeId);
  const active = hub.busy.get(sid);
  const localResolver = active?.localQuestionResolvers?.get(questionId);
  if (localResolver) {
    active!.localQuestionResolvers!.delete(questionId);
    localResolver(null);
  } else {
    await adapter.resolveQuestion(nativeId, questionId, {}).catch(() => undefined);
  }
  active?.pendingQuestions.delete(questionId);
  hub.transcript.resolveInteraction(sid, questionId, 'dismissed', null);
  hub.broadcast(sid, frame(sid, hub, 'event.question.dismissed', {
    question_id: questionId, dismissed_at: new Date().toISOString(),
  }));
  hub.broadcastV262(sid, {
    type: 'interaction',
    session_id: sid,
    agent_id: 'main',
    interaction_id: questionId,
    kind: 'question',
    status: 'ended',
    outcome: 'dismissed',
  });
  const activeAfterDismiss = hub.busy.get(sid);
  const pendingAfterDismiss = (activeAfterDismiss?.pendingApprovals.size ?? 0) > 0
    ? 'approval'
    : (activeAfterDismiss?.pendingQuestions.size ?? 0) > 0 ? 'question' : 'none';
  hub.broadcast(sid, frame(sid, hub, 'event.session.work_changed', {
    busy: activeAfterDismiss !== undefined,
    main_turn_active: activeAfterDismiss !== undefined,
    pending_interaction: pendingAfterDismiss,
  }));
}

/** WireQuestionAnswer → codex 答案字符串数组(option id / 自由文本)。 */
function wireAnswerStrings(ans: unknown): string[] {
  const a = (ans ?? {}) as Record<string, unknown>;
  switch (a.kind) {
    case 'single':
      return [String(a.option_id ?? '')];
    case 'multi':
      return Array.isArray(a.option_ids) ? (a.option_ids as unknown[]).map(String) : [];
    case 'other':
      return [String(a.text ?? '')];
    case 'multi_with_other': {
      const ids = Array.isArray(a.option_ids) ? (a.option_ids as unknown[]).map(String) : [];
      const other = typeof a.other_text === 'string' ? a.other_text : '';
      return other ? [...ids, other] : ids;
    }
    default: // skipped / 未知
      return [];
  }
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function frame(sessionId: string, hub: SessionHub, type: string, payload: unknown, volatile = false, offset?: number): Record<string, unknown> {
  return {
    type,
    seq: hub.nextSeq(),
    epoch: hub.epoch,
    volatile,
    ...(offset === undefined ? {} : { offset }),
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    payload: { ...(payload as Record<string, unknown>), sessionId, agentId: 'main' },
  };
}

const TRANSCRIPT_PROJECTED_EVENT_TYPES = new Set([
  'turn.started', 'turn.ended', 'turn.step.started', 'turn.step.completed',
  'turn.step.interrupted', 'assistant.delta', 'thinking.delta',
  'tool.call.started', 'tool.result', 'prompt.completed', 'prompt.aborted',
  'event.question.requested', 'event.question.dismissed', 'event.question.answered',
  'event.approval.requested', 'event.approval.resolved',
]);

type LocalTranscriptGrade = 'off' | 'turn' | 'block' | 'delta';

function transcriptGrade(spec: Record<string, unknown> | undefined): LocalTranscriptGrade {
  const value = spec?.main ?? spec?.['*'] ?? 'off';
  return value === 'turn' || value === 'block' || value === 'delta' ? value : 'off';
}

function validTranscriptSpec(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((grade) =>
    grade === 'off' || grade === 'turn' || grade === 'block' || grade === 'delta');
}

function globalSessionEvent(type: string): boolean {
  return type === 'session.meta.updated'
    || type.startsWith('event.session.')
    || type.startsWith('event.workspace.')
    || type.startsWith('event.config.');
}

function transcriptSuppressesLegacy(event: Record<string, unknown>, spec: Record<string, unknown> | undefined): boolean {
  const type = typeof event.type === 'string' ? event.type : '';
  if (globalSessionEvent(type) || transcriptGrade(spec) === 'off') return false;
  const payload = event.payload as { agentId?: unknown } | undefined;
  if (payload && payload.agentId !== undefined && payload.agentId !== 'main') return false;
  return TRANSCRIPT_PROJECTED_EVENT_TYPES.has(type);
}

function filterTranscriptEmission(
  emission: TranscriptEmission,
  grade: LocalTranscriptGrade,
): TranscriptEmission | null {
  if (grade === 'off') return null;
  if (emission.type === 'transcript.reset' || grade === 'delta') return emission;
  const ops = Array.isArray(emission.payload.ops)
    ? (emission.payload.ops as Array<Record<string, unknown>>).filter((op) => {
        if (grade === 'block') return op.op !== 'append';
        return op.op !== 'step.upsert' && op.op !== 'frame.upsert' && op.op !== 'append';
      })
    : [];
  if (ops.length === 0) return null;
  return { ...emission, payload: { ...emission.payload, ops } };
}

function transcriptEnvelope(
  sessionId: string,
  hub: SessionHub,
  emission: TranscriptEmission,
): Record<string, unknown> {
  return {
    type: emission.type,
    seq: hub.currentSeq(),
    epoch: hub.epoch,
    volatile: true,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    payload: emission.payload,
  };
}

function attachGatewayWebSocket(
  server: ReturnType<typeof createServer>,
  token: string,
  hub: SessionHub,
  adapters: Record<LocalProviderName, ProviderAdapter>,
  resolveKimiWs: () => Promise<ReturnType<typeof createKimiWsUpgrader> | null>,
  gatewaySockets: Set<Duplex>,
  kimiSockets: Set<Duplex>,
  /** kimi=off: 官方启动屏等 WS open。没有上游时走本地事件通道,不能 503。 */
  stubKimiEvents: boolean,
  demoActive: boolean = false,
  onKimiV25Upgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<boolean>,
): void {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== `${API}/ws`) {
      socket.destroy();
      return;
    }
    if (!authed(req, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const provider = url.searchParams.get('provider');
    if (!isLocalProvider(provider) && !stubKimiEvents) {
      socket.pause();
      void (async () => {
        if (onKimiV25Upgrade && await onKimiV25Upgrade(req, socket, head)) {
          return;
        }
        const kimiWs = await resolveKimiWs();
        if (socket.destroyed) return;
        if (!kimiWs) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
          socket.destroy();
          return;
        }
        gatewaySockets.add(socket);
        kimiSockets.add(socket);
        socket.once('close', () => {
          gatewaySockets.delete(socket);
          kimiSockets.delete(socket);
        });
        if (!kimiWs(req, socket, head)) socket.destroy();
        else socket.resume();
      })().catch(() => {
        if (!socket.destroyed) {
          socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          socket.destroy();
        }
      });
      return;
    }
    const socketProvider: ProviderName = isLocalProvider(provider) ? provider : 'kimi';
    // 本地 provider 握手:从客户端提议里选一个子协议回显(RFC 6455 要求恰好
    // 一个;原样回显整个逗号分隔列表是非法响应,浏览器会拒绝握手)。
    const protos = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const chosenProto = protos.find((p) => p.startsWith('kimi-code.'));
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const acceptKey = wsAccept(key);
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
    ];
    if (chosenProto) headers.push(`Sec-WebSocket-Protocol: ${chosenProto}`);
    socket.write(headers.concat('\r\n').join('\r\n'));
    gatewaySockets.add(socket);
    // TCP keepalive + WS ping + 2.6.2 JSON ping(每 10s,匹配前端 stale 25s 与 20s 心跳指示)。
    try { (socket as import('node:net').Socket).setKeepAlive?.(true, 30_000); } catch { /* ignore */ }
    let lastPongAt = Date.now();
    const sendObj = (obj: Record<string, unknown>): void => {
      if (socket.destroyed) return;
      wsSendText(socket, JSON.stringify(obj));
      // 背压熔断:慢客户端(手机/隧道)消费不过来时写缓冲会无界增长拖垮
      // 进程。超阈值直接断开,客户端重连后走 snapshot+resync 恢复。
      if (socket.writableLength > 8 * 1024 * 1024) socket.destroy();
    };
    const pingTimer = setInterval(() => {
      if (socket.destroyed) {
        clearInterval(pingTimer);
        return;
      }
      if (Date.now() - lastPongAt > 90_000) {
        socket.destroy();
        return;
      }
      try {
        wsSendFrame(socket, 0x9, Buffer.alloc(0));
        sendObj({ type: 'ping' });
      } catch {
        socket.destroy();
      }
    }, 10_000);
    pingTimer.unref?.();

    sendObj({
      type: 'server_hello',
      timestamp: new Date().toISOString(),
      payload: {
        server_id: 'multi-agent-gateway',
        max_event_buffer_size: 1000,
        capabilities: { event_batching: false, compression: false },
      },
    });

    const transcriptSpecs = new Map<string, Record<string, unknown>>();
    const transcriptOffs = new Map<string, () => void>();
    const v262Offs = new Map<string, () => void>();
    const sendFrame = (event: Record<string, unknown>): void => {
      const sid = typeof event.session_id === 'string' ? event.session_id : '';
      if (sid && providerFromSessionId(sid).provider !== socketProvider) return;
      const type = typeof event.type === 'string' ? event.type : '';
      if (v262Offs.has(sid) && !globalSessionEvent(type)) return;
      if (!transcriptSuppressesLegacy(event, transcriptSpecs.get(sid))) sendObj(event);
    };
    // kimi=off 启动屏只要通道 open + server_hello,不能把 Claude/Codex/Grok/Pi
    // 的 session.meta / work_changed 灌进去。
    const offGlobal = socketProvider === 'kimi'
      ? () => undefined
      : hub.subscribeGlobal(sendFrame);

    // ---- 客户端帧处理:2.6.2 turns/items、legacy 事件与 transcript v2 ----
    const localOffs = new Map<string, () => void>();
    const handleFrame = async (msg: {
      type?: string;
      id?: string;
      request_id?: string;
      session_id?: string;
      agent_ids?: string[];
      payload?: {
        client_id?: string;
        subscriptions?: string[];
        session_ids?: string[];
        session_id?: string;
        agent_ids?: string[];
        cursors?: Record<string, unknown>;
        transcript?: unknown;
        transcript_since?: Record<string, unknown>;
      };
    }): Promise<void> => {
      if (msg.type === 'pong') {
        lastPongAt = Date.now();
        return;
      }
      if (msg.type === 'ping') {
        lastPongAt = Date.now();
        sendObj({ type: 'pong' });
        return;
      }
      if (msg.type === 'subscribe' && typeof msg.session_id === 'string') {
        const sid = msg.session_id;
        const split = providerFromSessionId(sid);
        if (split.provider !== socketProvider) {
          sendObj({ type: 'response', request_id: msg.request_id, code: 40001, msg: 'provider mismatch' });
          return;
        }
        const adapter = isLocalProvider(socketProvider) ? adapters[socketProvider] : null;
        let history: Message[] | null = null;
        if (adapter) {
          try {
            history = await tryHistoryStrictWithDemo(adapter, socketProvider, split.nativeId, demoActive);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const isKnownDraft = Boolean(adapter.getCwd?.(split.nativeId)) && /not found/i.test(errMsg);
            if (isKnownDraft) {
              history = [];
            } else {
              sendObj({ type: 'response', request_id: msg.request_id, code: 40401, msg: errMsg || 'session not found' });
              sendObj({ type: 'turns.failed', session_id: sid, agent_id: 'main', code: 40401, msg: errMsg || 'session not found' });
              return;
            }
          }
        }
        v262Offs.get(sid)?.();
        v262Offs.set(sid, hub.subscribeV262(sid, sendObj));
        sendObj({ type: 'response', request_id: msg.request_id, code: 0, msg: 'success' });

        const active = hub.busy.get(sid);
        if (history && !hub.transcript.hasObservedHistory(sid)) {
          const historyPrior = active ? filterHistoryPriorToActive(history, active) : history;
          hub.transcript.observeHistory(sid, historyPrior);
        }
        const allTurns = turnsFromHistory(history ?? [], active);
        const page = sliceV262Turns(allTurns, undefined, 20);
        sendObj({
          type: 'turns',
          session_id: sid,
          agent_id: 'main',
          turns: page.turns,
          has_more: page.has_more,
        });
        if (adapter) {
          emitV262AgentState(hub, adapter, socketProvider, split.nativeId, sid, active ? 'running' : 'idle');
          emitV262Usage(hub, adapter, socketProvider, split.nativeId, sid);
          const extUi = (adapter as { getExtensionUiState?: (id: string) => Record<string, unknown> | undefined }).getExtensionUiState?.(split.nativeId);
          if (extUi) {
            sendObj({
              type: 'extension_ui',
              session_id: sid,
              agent_id: 'main',
              ...extUi,
            });
          }
          const wireTasks = await collectSessionWireTasks(adapter, split.nativeId, sid, hub);
          sendObj({
            type: 'task.list',
            session_id: sid,
            agent_id: 'main',
            tasks: wireTasks,
          });
          const caps = adapter.capabilities();
          if (caps.goals !== false && adapter.getGoal) {
            const goal = await adapter.getGoal(split.nativeId).catch(() => null);
            sendObj({
              type: 'goal',
              session_id: sid,
              agent_id: 'main',
              goal: localGoalToWire(goal, split.nativeId),
            });
          }
        }
        if (active) {
          for (const approvalId of active.pendingApprovals.keys()) {
            sendObj(v262PendingApprovalFrame(sid, approvalId, active));
          }
          for (const [questionId, q] of active.pendingQuestions.entries()) {
            sendObj(v262PendingQuestionFrame(sid, questionId, undefined, q));
          }
        }
        return;
      }
      if (msg.type === 'unsubscribe' && typeof msg.session_id === 'string') {
        const sid = msg.session_id;
        v262Offs.get(sid)?.();
        v262Offs.delete(sid);
        sendObj({ type: 'response', request_id: msg.request_id, code: 0, msg: 'success' });
        return;
      }
      if (msg.type === 'subscribe_v2') {
        const sid = msg.payload?.session_id;
        const split = sid ? providerFromSessionId(sid) : null;
        const spec = msg.payload?.transcript;
        const rawSince = msg.payload?.transcript_since?.main ?? msg.payload?.transcript_since?.['*'];
        if (
          !sid
          || !split
          || split.provider !== socketProvider
          || !validTranscriptSpec(spec)
          || (rawSince !== undefined && (!Number.isInteger(rawSince) || Number(rawSince) < 0))
        ) {
          sendObj({ type: 'ack', id: msg.id, code: 1, msg: 'invalid subscribe_v2 payload', payload: {} });
          return;
        }

        const prevOff = transcriptOffs.get(sid);
        const prevSpec = transcriptSpecs.get(sid);
        prevOff?.();
        transcriptSpecs.set(sid, spec);
        const grade = transcriptGrade(spec);
        const subscription = hub.transcript.subscribe(sid, (emission) => {
          const filtered = filterTranscriptEmission(emission, grade);
          if (filtered) sendObj(transcriptEnvelope(sid, hub, filtered));
        });
        transcriptOffs.set(sid, subscription.close);
        const adapter = isLocalProvider(socketProvider) ? adapters[socketProvider] : null;
        let history: Message[] | null = null;
        if (adapter) {
          try {
            history = await tryHistoryStrictWithDemo(adapter, socketProvider, split.nativeId, demoActive);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const isKnownDraft = Boolean(adapter.getCwd?.(split.nativeId)) && /not found/i.test(errMsg);
            if (isKnownDraft) {
              history = [];
            } else {
              subscription.close();
              transcriptOffs.delete(sid);
              if (prevSpec === undefined) transcriptSpecs.delete(sid);
              else transcriptSpecs.set(sid, prevSpec);
              sendObj({
                type: 'ack',
                id: msg.id,
                code: 1,
                msg: errMsg || 'failed to load transcript',
                payload: { accepted: [], not_found: [], resync_required: [sid], cursors: {} },
              });
              return;
            }
          }
        }
        const active = hub.busy.get(sid);
        if (history) {
          const historyForSeed = active ? filterHistoryPriorToActive(history, active) : history;
          subscription.seed(historyForSeed, active ? 'turn' : 'idle', rawSince === undefined ? undefined : Number(rawSince));
        }
        sendObj({
          type: 'ack', id: msg.id, code: 0, msg: 'success',
          payload: { accepted: [sid], not_found: [], resync_required: [], cursors: {} },
        });
        return;
      }
      if (msg.type === 'unsubscribe_v2') {
        const sid = msg.payload?.session_id;
        const agentIds = msg.payload?.agent_ids;
        if (!sid || (agentIds !== undefined && (!Array.isArray(agentIds) || agentIds.length === 0))) {
          sendObj({ type: 'ack', id: msg.id, code: 1, msg: 'invalid unsubscribe_v2 payload', payload: {} });
          return;
        }
        if (agentIds === undefined || agentIds.includes('main')) {
          transcriptOffs.get(sid)?.();
          transcriptOffs.delete(sid);
          if (agentIds === undefined) transcriptSpecs.delete(sid);
          else transcriptSpecs.set(sid, { ...(transcriptSpecs.get(sid) ?? {}), main: 'off' });
        }
        sendObj({
          type: 'ack', id: msg.id, code: 0, msg: 'success',
          payload: { accepted: [sid], not_found: [], resync_required: [] },
        });
        return;
      }
      if (msg.type === 'client_hello' || msg.type === 'subscribe') {
        const ids = msg.type === 'client_hello' ? msg.payload?.subscriptions ?? [] : msg.payload?.session_ids ?? [];
        const localIds = ids.filter((id) => providerFromSessionId(id).provider === socketProvider);
        const cursors = msg.payload?.cursors ?? {};
        const resyncRequired: { sid: string; reason: 'buffer_overflow' | 'epoch_changed' }[] = [];
        for (const sid of localIds) {
          if (!localOffs.has(sid)) localOffs.set(sid, hub.subscribe(sid, sendFrame));
          const raw = cursors[sid] as { seq?: unknown; epoch?: unknown } | number | undefined;
          const cursorSeq = typeof raw === 'number' ? raw : Number(raw?.seq);
          const cursorEpoch = typeof raw === 'object' && raw !== null && typeof raw.epoch === 'string' ? raw.epoch : undefined;
          if (cursorEpoch !== undefined && cursorEpoch !== hub.epoch) {
            resyncRequired.push({ sid, reason: 'epoch_changed' });
          } else if (Number.isFinite(cursorSeq) && cursorSeq > 0) {
            const replayed = hub.replaySince(sid, cursorSeq);
            if (replayed.resync) resyncRequired.push({ sid, reason: 'buffer_overflow' });
            else for (const replayedFrame of replayed.frames) sendFrame(replayedFrame);
          }
        }
        for (const { sid, reason } of resyncRequired) {
          sendObj({
            type: 'resync_required',
            timestamp: new Date().toISOString(),
            payload: { session_id: sid, reason, current_seq: hub.currentSeq(), epoch: hub.epoch },
          });
        }
        sendObj({
          type: 'ack', id: msg.id, code: 0, msg: 'success',
          payload: {
            accepted_subscriptions: localIds,
            resync_required: resyncRequired.map((entry) => entry.sid),
            cursors: {},
          },
        });
        return;
      }
      if (msg.type === 'unsubscribe') {
        const ids = msg.payload?.session_ids ?? [];
        for (const sid of ids) {
          localOffs.get(sid)?.();
          localOffs.delete(sid);
          v262Offs.get(sid)?.();
          v262Offs.delete(sid);
          transcriptOffs.get(sid)?.();
          transcriptOffs.delete(sid);
          transcriptSpecs.delete(sid);
        }
        sendObj({ type: 'ack', id: msg.id, code: 0, msg: 'success', payload: {} });
        return;
      }
      // abort(上游 WS abort 是死路,中止走 REST):忽略。
    };

    const parser = new WsFrameParser();
    let controlQueue = Promise.resolve();
    // 分片重组:首帧(opcode 0x1)fin=false 时缓存,续帧(opcode 0x0)追加到
    // fin=true 再整体 JSON.parse。此前直接丢弃非 fin 帧,CF 边缘或浏览器一旦
    // 分片,subscribe 等控制消息静默丢失。
    let fragments: Buffer[] | null = null;
    let fragmentBytes = 0;
    const handleText = (payload: Buffer): void => {
      try {
        const message = JSON.parse(payload.toString('utf8')) as Parameters<typeof handleFrame>[0];
        controlQueue = controlQueue.then(() => handleFrame(message)).catch(() => undefined);
      } catch { /* 忽略坏帧 */ }
    };
    socket.on('data', (chunk: Buffer) => {
      let frames: ParsedWsFrame[];
      try {
        frames = parser.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const wsFrame of frames) {
        if (wsFrame.opcode === 0x8) {
          wsSendFrame(socket, 0x8, wsFrame.payload);
          socket.end();
          return;
        }
        if (wsFrame.opcode === 0x9) {
          wsSendFrame(socket, 0xa, wsFrame.payload);
          continue;
        }
        if (wsFrame.opcode === 0xa) {
          lastPongAt = Date.now();
          continue;
        }
        if (wsFrame.opcode === 0x1) {
          fragments = [wsFrame.payload]; // 新消息首帧(上一段未完则丢弃)
          fragmentBytes = wsFrame.payload.byteLength;
        } else if (wsFrame.opcode === 0x0 && fragments) {
          fragmentBytes += wsFrame.payload.byteLength;
          if (fragmentBytes > WS_MAX_MESSAGE_BYTES) {
            socket.destroy();
            return;
          }
          fragments.push(wsFrame.payload);
        } else {
          continue; // pong/binary/无首帧的续帧:忽略
        }
        if (wsFrame.fin) {
          handleText(Buffer.concat(fragments));
          fragments = null;
          fragmentBytes = 0;
        }
      }
    });
    const cleanup = (): void => {
      clearInterval(pingTimer);
      gatewaySockets.delete(socket);
      offGlobal();
      for (const off of localOffs.values()) off();
      localOffs.clear();
      for (const off of v262Offs.values()) off();
      v262Offs.clear();
      for (const off of transcriptOffs.values()) off();
      transcriptOffs.clear();
      transcriptSpecs.clear();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}

// ---------------------------------------------------------------------------
// 错误码 / 工具
// ---------------------------------------------------------------------------

async function waitUntilAccepting(host: string, port: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = createConnection({ host, port }, () => {
          sock.end();
          resolve();
        });
        sock.once('error', reject);
      });
      return;
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw last instanceof Error ? last : new Error(`gateway not accepting on ${host}:${port}`);
}

function codeNumber(code: string): number {
  const map: Record<string, number> = {
    not_found: 40401, invalid_request: 40001, unauthorized: 40101,
    busy: 40901, unsupported: 40001, upstream_error: 50001,
  };
  return map[code] ?? 50001;
}

/** 探活 kap-server:/meta 返回 200 即活;1s 超时,断连立即判死。 */
async function kimiAlive(candidate: { url: string; token: string }): Promise<boolean> {
  try {
    const res = await fetch(`${candidate.url}${API}/meta`, {
      headers: { authorization: `Bearer ${candidate.token}` },
      signal: AbortSignal.timeout(1_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function ulid(): string {
  // 简化版 ULID(时间戳 + 随机,base32)。kap-server 只要求 ULID 格式。
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const time = Date.now().toString(36).toUpperCase().padStart(10, '0').slice(-10);
  let rand = '';
  const bytes = randomBytes(16);
  for (let i = 0; i < 16; i++) rand += alphabet[bytes[i] % 32];
  return time + rand;
}

// ---------------------------------------------------------------------------
// goal / terminal / 2.6.2 turns / model → kimi wire 映射
// ---------------------------------------------------------------------------

function localGoalToWire(goal: Record<string, unknown> | null, fallbackId = 'goal'): Record<string, unknown> | null {
  if (!goal) return null;
  const status = String(goal.status ?? 'active');
  const mapped = status === 'usageLimited' || status === 'budgetLimited' ? 'blocked' : status;
  const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const tokensUsed = numOrNull(goal.tokensUsed ?? goal.tokens_used) ?? 0;
  const tokenBudget = numOrNull(goal.tokenBudget ?? goal.token_budget);
  const wallClockMs = typeof goal.elapsed_ms === 'number' && Number.isFinite(goal.elapsed_ms)
    ? goal.elapsed_ms
    : (numOrNull(goal.timeUsedSeconds) ?? 0) * 1000;
  return {
    goalId: String(goal.goalId ?? goal.goal_id ?? goal.threadId ?? fallbackId),
    objective: String(goal.objective ?? ''),
    ...(typeof goal.completionCriterion === 'string'
      ? { completionCriterion: goal.completionCriterion }
      : typeof goal.completion_criterion === 'string'
        ? { completionCriterion: goal.completion_criterion }
        : {}),
    status: mapped,
    turnsUsed: numOrNull(goal.turnsUsed ?? goal.turns_used) ?? 0,
    tokensUsed,
    wallClockMs,
    budget: {
      tokenBudget,
      turnBudget: numOrNull(goal.turnBudget ?? goal.turn_budget),
      wallClockBudgetMs: numOrNull(goal.wallClockBudgetMs ?? goal.wall_clock_budget_ms),
      remainingTokens: tokenBudget !== null ? Math.max(0, tokenBudget - tokensUsed) : null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: status === 'budgetLimited',
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: status === 'budgetLimited' || status === 'usageLimited',
    },
  };
}

function wireModelDto(m: NativeModel): Record<string, unknown> {
  const raw = m as NativeModel & Record<string, unknown>;
  const rawCaps = Array.isArray(m.capabilities) ? [...m.capabilities] : [];
  const rawEfforts = Array.isArray(m.support_efforts) ? m.support_efforts : undefined;
  const filteredEfforts = rawEfforts
    ? rawEfforts.filter((effort, idx, arr) => effort !== 'off' && arr.indexOf(effort) === idx)
    : undefined;
  if (
    m.supportsThinkingOff === false
    && rawCaps.includes('thinking')
    && !rawCaps.includes('always_thinking')
  ) {
    rawCaps.push('always_thinking');
  }
  const out: Record<string, unknown> = {
    ...raw,
    ...(rawCaps.length > 0 || m.capabilities !== undefined ? { capabilities: rawCaps } : {}),
    ...(m.max_output_tokens !== undefined && raw.max_output_size === undefined
      ? { max_output_size: m.max_output_tokens }
      : {}),
    ...(m.supportsAdaptiveThinking !== undefined && raw.adaptive_thinking === undefined
      ? { adaptive_thinking: m.supportsAdaptiveThinking }
      : {}),
  };
  if (filteredEfforts !== undefined) {
    if (filteredEfforts.length > 0) out.support_efforts = filteredEfforts;
    else delete out.support_efforts;
  }
  return out;
}

function tryHistoryStrictWithDemo(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  demoActive: boolean,
): Promise<Message[]> {
  if (demoActive) {
    const demo = getDemoHistory(provider, nativeId);
    if (demo) return Promise.resolve(demo);
  }
  return adapter.getHistory(nativeId);
}

function buildTurnsFromHistoryMessages(history: Message[]): Array<Record<string, unknown>> {
  const turns: Array<Record<string, unknown>> = [];
  let current: {
    turn_id: string;
    ordinal: number;
    turn_number: number;
    kind: 'agent';
    status: 'ended' | 'running';
    outcome?: string;
    started_at?: string;
    ended_at?: string;
    steps: Array<{ index: number }>;
    items: Array<Record<string, unknown>>;
  } | null = null;
  const toolMap = new Map<string, Record<string, unknown>>();
  const ensureTurn = (seedId: string, createdAt: string) => {
    if (!current) {
      const ordinal = turns.length;
      current = {
        turn_id: `hist_${seedId}`,
        ordinal,
        turn_number: ordinal + 1,
        kind: 'agent',
        status: 'ended',
        outcome: 'completed',
        started_at: createdAt,
        ended_at: createdAt,
        steps: [{ index: 0 }],
        items: [],
      };
      turns.push(current);
    }
    return current;
  };

  for (const msg of history) {
    const msgAgentId = typeof msg.metadata?.agent_id === 'string'
      ? msg.metadata.agent_id
      : typeof msg.metadata?.agentId === 'string'
        ? msg.metadata.agentId
        : undefined;
    const msgReceiverId = Array.isArray(msg.metadata?.receiverThreadIds) && typeof msg.metadata.receiverThreadIds[0] === 'string'
      ? msg.metadata.receiverThreadIds[0]
      : undefined;
    const isBashCard = Boolean(msg.metadata?.bash_card);

    if (msg.role === 'user' && !isBashCard) {
      const text = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      const attachments = msg.content
        .filter((p): p is Extract<Message['content'][number], { type: 'image' | 'file' | 'document' }> =>
          p.type === 'image' || p.type === 'file' || p.type === 'document')
        .map((p) => ({
          kind: p.type === 'image' ? 'image' : 'file',
          ...(p.name ? { name: p.name } : {}),
          ...((p.mimeType ?? p.mime_type) ? { media_type: p.mimeType ?? p.mime_type } : {}),
          ...(p.url ? { url: p.url } : {}),
        }));
      const isToolOnlyUser = !text.trim()
        && attachments.length === 0
        && msg.content.some((p) => p.type === 'tool_result' || p.type === 'tool_use' || p.type === 'tool_call');
      if (!isToolOnlyUser) {
        const ordinal = turns.length;
        const promptIds = Array.isArray(msg.metadata?.prompt_ids)
          ? msg.metadata.prompt_ids.filter((x): x is string => typeof x === 'string')
          : typeof msg.metadata?.prompt_id === 'string'
            ? [msg.metadata.prompt_id]
            : [msg.id];
        current = {
          turn_id: `hist_${msg.id}`,
          ordinal,
          turn_number: ordinal + 1,
          kind: 'agent',
          status: 'ended',
          outcome: 'completed',
          started_at: msg.created_at,
          ended_at: msg.created_at,
          steps: [{ index: 0 }],
          items: [{
            item_id: `${msg.id}_opener`,
            type: 'user_message',
            placement: 'opener',
            origin: { kind: 'user' },
            text,
            prompt_ids: promptIds,
            attachments,
            skills: [],
            created_at: msg.created_at,
          }],
        };
        turns.push(current);
        continue;
      }
    }

    if (msg.role === 'system' && msg.metadata?.notice_source === 'compact') {
      const summary = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      const target = ensureTurn(msg.id, msg.created_at);
      target.items.push({
        item_id: msg.id,
        type: 'system',
        kind: 'compaction',
        summary,
        trigger: 'manual',
        created_at: msg.created_at,
      });
      target.ended_at = msg.created_at;
      continue;
    }

    const target = ensureTurn(msg.id, msg.created_at);
    target.ended_at = msg.created_at;

    if (isBashCard) {
      const card = (typeof msg.metadata?.bash_card === 'object' && msg.metadata.bash_card !== null
        ? msg.metadata.bash_card
        : {}) as Record<string, unknown>;
      const command = typeof card.command === 'string'
        ? card.command
        : typeof card.cmd === 'string'
          ? card.cmd
          : '';
      const output = typeof card.output === 'string'
        ? card.output
        : typeof card.stdout === 'string'
          ? card.stdout
          : '';
      const isError = card.is_error === true || card.isError === true || msg.metadata?.is_error === true;
      const callId = (typeof card.tool_call_id === 'string' && card.tool_call_id) || `${msg.id}_bash`;
      const norm = normalizeKimiWebTool('Bash', {
        command,
        ...(card.cwd ? { cwd: card.cwd } : {}),
        ...(card.workdir ? { workdir: card.workdir } : {}),
      });
      target.items.push({
        item_id: callId,
        type: 'tool_call',
        name: norm.name,
        input: norm.input,
        status: 'ended',
        outcome: isError ? 'failed' : 'completed',
        output,
        ...(isError && output ? { error: output } : {}),
        started_at: msg.created_at,
        ended_at: msg.created_at,
        step_index: 0,
      });
      continue;
    }

    let idx = 0;
    for (const part of msg.content) {
      if (part.type === 'thinking') {
        const text = part.thinking ?? part.text ?? '';
        if (!text) continue;
        target.items.push({
          item_id: `${msg.id}_think_${idx++}`,
          type: 'reasoning',
          status: 'ended',
          text,
          started_at: msg.created_at,
          created_at: msg.created_at,
          step_index: 0,
        });
      } else if (part.type === 'text') {
        if (!part.text) continue;
        target.items.push({
          item_id: `${msg.id}_text_${idx++}`,
          type: 'assistant_message',
          status: 'ended',
          text: part.text,
          created_at: msg.created_at,
          step_index: 0,
        });
      } else if (part.type === 'tool_call' || part.type === 'tool_use') {
        const callId = part.type === 'tool_call' ? part.id : part.tool_call_id;
        const rawName = part.type === 'tool_call' ? part.name : part.tool_name;
        const normalized = normalizeKimiWebTool(rawName || 'tool', part.input ?? {});
        const inputSubagentId = normalized.name === 'Agent' ? extractSubagentIdFromOutput(normalized.input) : undefined;
        const agentRefs = mergeAgentRefs(
          msg.metadata?.agent_refs ?? msg.metadata?.agentRefs,
          [msgAgentId, msgReceiverId, inputSubagentId],
        );
        const item: Record<string, unknown> = {
          item_id: callId,
          type: 'tool_call',
          name: normalized.name,
          input: normalized.input ?? {},
          status: 'ended',
          outcome: 'completed',
          started_at: msg.created_at,
          ended_at: msg.created_at,
          step_index: 0,
          ...(agentRefs ? { agent_refs: agentRefs } : {}),
        };
        toolMap.set(callId, item);
        target.items.push(item);
      } else if (part.type === 'tool_result') {
        const existing = toolMap.get(part.tool_call_id);
        const structured = part.structured_output ?? part.structuredOutput;
        const rawOut = part.output ?? part.content ?? '';
        const output = (rawOut === '' || rawOut === undefined) && structured !== undefined
          ? (typeof structured === 'string' ? structured : JSON.stringify(structured))
          : rawOut;
        const isError = part.is_error === true;
        const outSubagentId = extractSubagentIdFromOutput(output) ?? extractSubagentIdFromOutput(structured);
        if (existing) {
          existing.status = 'ended';
          existing.outcome = isError ? 'failed' : 'completed';
          existing.output = output;
          if (isError && typeof output === 'string') existing.error = output;
          existing.ended_at = msg.created_at;
          const mergedRefs = mergeAgentRefs(existing.agent_refs, [msgAgentId, msgReceiverId, outSubagentId]);
          if (mergedRefs) existing.agent_refs = mergedRefs;
        } else {
          const agentRefs = mergeAgentRefs(
            msg.metadata?.agent_refs ?? msg.metadata?.agentRefs,
            [msgAgentId, msgReceiverId, outSubagentId],
          );
          target.items.push({
            item_id: `${part.tool_call_id}_result_${idx++}`,
            type: 'tool_call',
            name: 'tool',
            input: {},
            status: 'ended',
            outcome: isError ? 'failed' : 'completed',
            output,
            started_at: msg.created_at,
            ended_at: msg.created_at,
            step_index: 0,
            ...(agentRefs ? { agent_refs: agentRefs } : {}),
          });
        }
      }
    }
  }

  return turns;
}

function mergeActiveTurnItems(
  historyActive: Message[],
  active: ActiveTurn,
): Array<Record<string, unknown>> {
  const diskTurnItems: Array<Record<string, unknown>> = [];
  const diskToolMap = new Map<string, Record<string, unknown>>();
  let openerSeen = false;
  let idx = 0;

  for (const msg of historyActive) {
    const msgAgentId = typeof msg.metadata?.agent_id === 'string'
      ? msg.metadata.agent_id
      : typeof msg.metadata?.agentId === 'string'
        ? msg.metadata.agentId
        : undefined;
    const msgReceiverId = Array.isArray(msg.metadata?.receiverThreadIds) && typeof msg.metadata.receiverThreadIds[0] === 'string'
      ? msg.metadata.receiverThreadIds[0]
      : undefined;
    const isBashCard = Boolean(msg.metadata?.bash_card);

    if (msg.role === 'user' && !isBashCard) {
      const text = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      const attachments = msg.content
        .filter((p): p is Extract<Message['content'][number], { type: 'image' | 'file' | 'document' }> =>
          p.type === 'image' || p.type === 'file' || p.type === 'document')
        .map((p) => ({
          kind: p.type === 'image' ? 'image' : 'file',
          ...(p.name ? { name: p.name } : {}),
          ...((p.mimeType ?? p.mime_type) ? { media_type: p.mimeType ?? p.mime_type } : {}),
          ...(p.url ? { url: p.url } : {}),
        }));
      const isToolOnlyUser = !text.trim()
        && attachments.length === 0
        && msg.content.some((p) => p.type === 'tool_result' || p.type === 'tool_use' || p.type === 'tool_call');
      if (!isToolOnlyUser) {
        if (!openerSeen) {
          openerSeen = true;
          diskTurnItems.push({
            item_id: `${msg.id}_opener`,
            type: 'user_message',
            placement: 'opener',
            origin: { kind: 'user' },
            text,
            prompt_ids: [active.promptId],
            attachments,
            skills: [],
            created_at: msg.created_at,
          });
        } else {
          diskTurnItems.push({
            item_id: `${msg.id}_steer`,
            type: 'user_message',
            placement: 'steer',
            origin: { kind: 'user' },
            text,
            prompt_ids: typeof msg.metadata?.prompt_id === 'string' ? [msg.metadata.prompt_id] : [msg.id],
            attachments,
            skills: [],
            created_at: msg.created_at,
          });
        }
        continue;
      }
    }

    if (isBashCard) {
      const card = (typeof msg.metadata?.bash_card === 'object' && msg.metadata.bash_card !== null
        ? msg.metadata.bash_card
        : {}) as Record<string, unknown>;
      const command = typeof card.command === 'string' ? card.command : typeof card.cmd === 'string' ? card.cmd : '';
      const output = typeof card.output === 'string' ? card.output : typeof card.stdout === 'string' ? card.stdout : '';
      const isError = card.is_error === true || card.isError === true || msg.metadata?.is_error === true;
      const callId = (typeof card.tool_call_id === 'string' && card.tool_call_id) || `${msg.id}_bash`;
      const norm = normalizeKimiWebTool('Bash', { command, ...(card.cwd ? { cwd: card.cwd } : {}), ...(card.workdir ? { workdir: card.workdir } : {}) });
      const item: Record<string, unknown> = {
        item_id: callId,
        type: 'tool_call',
        name: norm.name,
        input: norm.input,
        status: 'ended',
        outcome: isError ? 'failed' : 'completed',
        output,
        ...(isError && output ? { error: output } : {}),
        started_at: msg.created_at,
        ended_at: msg.created_at,
        step_index: 0,
      };
      diskToolMap.set(callId, item);
      diskTurnItems.push(item);
      continue;
    }

    for (const part of msg.content) {
      if (part.type === 'thinking') {
        const text = part.thinking ?? part.text ?? '';
        if (!text) continue;
        diskTurnItems.push({
          item_id: `${msg.id}_think_${idx++}`,
          type: 'reasoning',
          status: 'ended',
          text,
          started_at: msg.created_at,
          created_at: msg.created_at,
          step_index: 0,
        });
      } else if (part.type === 'text') {
        if (!part.text) continue;
        diskTurnItems.push({
          item_id: `${msg.id}_text_${idx++}`,
          type: 'assistant_message',
          status: 'ended',
          text: part.text,
          created_at: msg.created_at,
          step_index: 0,
        });
      } else if (part.type === 'tool_call' || part.type === 'tool_use') {
        const callId = part.type === 'tool_call' ? part.id : part.tool_call_id;
        const rawName = part.type === 'tool_call' ? part.name : part.tool_name;
        const normalized = normalizeKimiWebTool(rawName || 'tool', part.input ?? {});
        const inputSubagentId = normalized.name === 'Agent' ? extractSubagentIdFromOutput(normalized.input) : undefined;
        const agentRefs = mergeAgentRefs(
          msg.metadata?.agent_refs ?? msg.metadata?.agentRefs,
          [msgAgentId, msgReceiverId, inputSubagentId],
        );
        const item: Record<string, unknown> = {
          item_id: callId,
          type: 'tool_call',
          name: normalized.name,
          input: normalized.input ?? {},
          status: 'ended',
          outcome: 'completed',
          started_at: msg.created_at,
          ended_at: msg.created_at,
          step_index: 0,
          ...(agentRefs ? { agent_refs: agentRefs } : {}),
        };
        diskToolMap.set(callId, item);
        diskTurnItems.push(item);
      } else if (part.type === 'tool_result') {
        const existing = diskToolMap.get(part.tool_call_id);
        const structured = part.structured_output ?? part.structuredOutput;
        const rawOut = part.output ?? part.content ?? '';
        const output = (rawOut === '' || rawOut === undefined) && structured !== undefined
          ? (typeof structured === 'string' ? structured : JSON.stringify(structured))
          : rawOut;
        const isError = part.is_error === true;
        const outSubagentId = extractSubagentIdFromOutput(output) ?? extractSubagentIdFromOutput(structured);
        if (existing) {
          existing.status = 'ended';
          existing.outcome = isError ? 'failed' : 'completed';
          existing.output = output;
          if (isError && typeof output === 'string') existing.error = output;
          existing.ended_at = msg.created_at;
          const mergedRefs = mergeAgentRefs(existing.agent_refs, [msgAgentId, msgReceiverId, outSubagentId]);
          if (mergedRefs) existing.agent_refs = mergedRefs;
        } else {
          const agentRefs = mergeAgentRefs(
            msg.metadata?.agent_refs ?? msg.metadata?.agentRefs,
            [msgAgentId, msgReceiverId, outSubagentId],
          );
          const item: Record<string, unknown> = {
            item_id: `${part.tool_call_id}_result_${idx++}`,
            type: 'tool_call',
            name: 'tool',
            input: {},
            status: 'ended',
            outcome: isError ? 'failed' : 'completed',
            output,
            started_at: msg.created_at,
            ended_at: msg.created_at,
            step_index: 0,
            ...(agentRefs ? { agent_refs: agentRefs } : {}),
          };
          diskToolMap.set(part.tool_call_id, item);
          diskTurnItems.push(item);
        }
      }
    }
  }

  const activeOpener = active.v262Items.find((it) => it.type === 'user_message' && it.placement === 'opener')
    ?? active.v262Items.find((it) => it.type === 'user_message')
    ?? active.v262Items[0];
  const activeSteers = active.v262Items.filter((it) => it.type === 'user_message' && it.placement === 'steer');
  const activeTools = new Map<string, Record<string, unknown>>();
  for (const it of active.v262Items) {
    if (it.type === 'tool_call' && typeof it.item_id === 'string') {
      activeTools.set(it.item_id, it);
    }
  }
  const activeReasoning = active.v262Items.find((it) => it.type === 'reasoning');
  const activeAssistant = active.v262Items.find((it) => it.type === 'assistant_message');

  const mergedItems: Array<Record<string, unknown>> = [];
  const placedActiveItemIds = new Set<string>();
  let placedReasoning = false;
  let placedAssistant = false;
  let placedOpener = false;

  for (const diskItem of diskTurnItems) {
    if (diskItem.type === 'user_message') {
      if (!placedOpener) {
        placedOpener = true;
        if (activeOpener) {
          placedActiveItemIds.add(String(activeOpener.item_id));
          mergedItems.push({
            ...activeOpener,
            ...(Array.isArray(diskItem.attachments) && diskItem.attachments.length > 0 && (!Array.isArray(activeOpener.attachments) || activeOpener.attachments.length === 0)
              ? { attachments: diskItem.attachments }
              : {}),
          });
        } else {
          mergedItems.push(diskItem);
        }
      } else {
        const diskText = typeof diskItem.text === 'string' ? diskItem.text.trim() : '';
        const matchedSteer = activeSteers.find(
          (s) => !placedActiveItemIds.has(String(s.item_id)) && (typeof s.text === 'string' && s.text.trim() === diskText)
        );
        if (matchedSteer) {
          placedActiveItemIds.add(String(matchedSteer.item_id));
          mergedItems.push({
            ...matchedSteer,
            ...(Array.isArray(diskItem.attachments) && diskItem.attachments.length > 0 && (!Array.isArray(matchedSteer.attachments) || matchedSteer.attachments.length === 0)
              ? { attachments: diskItem.attachments }
              : {}),
          });
        } else {
          mergedItems.push(diskItem);
        }
      }
      continue;
    }

    if (diskItem.type === 'tool_call') {
      const toolId = String(diskItem.item_id);
      const activeTool = activeTools.get(toolId);
      if (activeTool) {
        placedActiveItemIds.add(toolId);
        const isDiskEnded = diskItem.status === 'ended';
        const isActiveEnded = activeTool.status === 'ended';
        mergedItems.push({
          ...activeTool,
          ...diskItem,
          status: isDiskEnded || isActiveEnded ? 'ended' : 'running',
          outcome: diskItem.outcome ?? activeTool.outcome ?? (isDiskEnded || isActiveEnded ? 'completed' : undefined),
          output: diskItem.output !== undefined && diskItem.output !== '' ? diskItem.output : (activeTool.output ?? ''),
          ...(diskItem.error || activeTool.error ? { error: diskItem.error ?? activeTool.error } : {}),
          ...(activeTool.agent_refs || diskItem.agent_refs ? { agent_refs: activeTool.agent_refs ?? diskItem.agent_refs } : {}),
        });
      } else {
        mergedItems.push({ ...diskItem });
      }
      continue;
    }

    if (diskItem.type === 'reasoning') {
      if (activeReasoning && !placedReasoning) {
        placedReasoning = true;
        placedActiveItemIds.add(String(activeReasoning.item_id));
        const activeText = typeof activeReasoning.text === 'string' ? activeReasoning.text : '';
        const diskText = typeof diskItem.text === 'string' ? diskItem.text : '';
        const text = activeText.length >= diskText.length ? activeText : diskText;
        mergedItems.push({
          ...activeReasoning,
          text,
          status: activeReasoning.status ?? diskItem.status ?? 'running',
        });
      } else {
        mergedItems.push({ ...diskItem });
      }
      continue;
    }

    if (diskItem.type === 'assistant_message') {
      if (activeAssistant && !placedAssistant) {
        placedAssistant = true;
        placedActiveItemIds.add(String(activeAssistant.item_id));
        const activeText = typeof activeAssistant.text === 'string' ? activeAssistant.text : '';
        const diskText = typeof diskItem.text === 'string' ? diskItem.text : '';
        const text = activeText.length >= diskText.length ? activeText : diskText;
        mergedItems.push({
          ...activeAssistant,
          text,
          status: active.assistantText ? 'running' : (activeAssistant.status ?? diskItem.status ?? 'ended'),
        });
      } else {
        mergedItems.push({ ...diskItem });
      }
      continue;
    }

    mergedItems.push({ ...diskItem });
  }

  if (!placedOpener && activeOpener) {
    mergedItems.unshift({ ...activeOpener });
    placedActiveItemIds.add(String(activeOpener.item_id));
  }

  for (const it of active.v262Items) {
    const id = String(it.item_id);
    if (placedActiveItemIds.has(id)) continue;
    if (it.type === 'reasoning' && placedReasoning) continue;
    if (it.type === 'assistant_message' && placedAssistant) continue;
    mergedItems.push({ ...it });
  }

  return mergedItems;
}

function turnsFromHistory(history: Message[], active?: ActiveTurn): Array<Record<string, unknown>> {
  if (!active) {
    return buildTurnsFromHistoryMessages(history);
  }
  const activeStartIdx = findActiveTurnHistoryStartIndex(history, active);
  if (activeStartIdx < 0) {
    const turns = buildTurnsFromHistoryMessages(history);
    turns.push({
      turn_id: active.v262TurnId,
      ordinal: turns.length,
      turn_number: turns.length + 1,
      kind: 'agent',
      status: 'running',
      started_at: active.v262StartedAt,
      steps: Array.from({ length: Math.max(1, active.v262StepIndex + 1) }, (_, idx) => ({ index: idx })),
      items: active.v262Items.map((item) => ({ ...item })),
    });
    return turns;
  }

  const historyPrior = history.slice(0, activeStartIdx);
  const historyActive = history.slice(activeStartIdx);
  const turns = buildTurnsFromHistoryMessages(historyPrior);
  const mergedItems = mergeActiveTurnItems(historyActive, active);
  turns.push({
    turn_id: active.v262TurnId,
    ordinal: turns.length,
    turn_number: turns.length + 1,
    kind: 'agent',
    status: 'running',
    started_at: active.v262StartedAt,
    steps: Array.from({ length: Math.max(1, active.v262StepIndex + 1) }, (_, idx) => ({ index: idx })),
    items: mergedItems,
  });
  return turns;
}

function sliceV262Turns(
  allTurns: Array<Record<string, unknown>>,
  beforeOrdinal: number | undefined,
  pageSize: number,
): { turns: Array<Record<string, unknown>>; has_more: boolean } {
  const filtered = beforeOrdinal === undefined
    ? allTurns
    : allTurns.filter((t) => Number(t.ordinal) < beforeOrdinal);
  const start = Math.max(0, filtered.length - pageSize);
  return {
    turns: filtered.slice(start),
    has_more: start > 0,
  };
}

/**
 * codex ThreadBackgroundTerminal(schema:command/cwd/itemId/processId/osPid)
 * → WireTerminal。codex 不给尺寸/退出态,按运行中 + 默认 80x24 展示。
 */
function codexTerminalToWire(t: Record<string, unknown>, sid: string): Record<string, unknown> {
  return {
    id: String(t.processId ?? t.itemId ?? randomUUID()),
    session_id: sid,
    cwd: String(t.cwd ?? ''),
    shell: String(t.command ?? ''),
    cols: 80,
    rows: 24,
    status: 'running',
    created_at: new Date().toISOString(),
  };
}

function readManifestCompatVersion(explicitPath?: string): string {
  const candidates: string[] = [];
  if (explicitPath) candidates.push(explicitPath);
  const here = path.dirname(new URL(import.meta.url).pathname);
  candidates.push(path.resolve(here, '..', 'web-origin-manifest.json'));
  candidates.push(path.resolve(here, '..', '..', 'web-origin-manifest.json'));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim()) return parsed.version.trim();
    } catch {
      // try next candidate
    }
  }
  return '2.6.2';
}

// ---------------------------------------------------------------------------
// 会话导出(store-only zip,内含 transcript.md)
// ---------------------------------------------------------------------------

function transcriptMarkdown(session: Session, messages: Message[], provider: ProviderName): string {
  const lines = [
    `# ${session.title}`,
    '',
    `- Session: ${prefixedId(provider, session.id)}`,
    `- Provider: ${provider}`,
    `- Exported: ${new Date().toISOString()}`,
    '',
    '---',
    '',
  ];
  for (const m of messages) {
    lines.push(m.role === 'user' ? '## 👤 User' : '## 🤖 Assistant', '');
    for (const part of m.content) {
      if (part.type === 'text' && part.text) lines.push(part.text, '');
    }
  }
  return lines.join('\n');
}

/** CRC32(导出 zip 用,查表法)。 */
function crc32(buf: Buffer): number {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = (table[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}
crc32.table = null as Uint32Array | null;

/** 手搓 store-only(不压缩)zip:local headers + central directory + EOCD。 */
function buildStoreZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.byteLength, 18);
    local.writeUInt32LE(f.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, f.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(f.data.byteLength, 20);
    cd.writeUInt32LE(f.data.byteLength, 24);
    cd.writeUInt16LE(name.byteLength, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.byteLength + f.data.byteLength;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.byteLength, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ---------------------------------------------------------------------------
// 文件上传(multipart 解析 + 每实例 UploadStore)
// ---------------------------------------------------------------------------

const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const SAFE_RASTER_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const ACTIVE_WEB_MIMES = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
]);

interface UploadMeta {
  id: string;
  name: string;
  media_type: string;
  size: number;
  created_at: string;
}

interface UploadStore {
  has: (id: string) => boolean;
  get: (id: string) => UploadMeta | undefined;
  filePath: (id: string) => string;
  hydrate: () => Promise<void>;
  store: (name: string, mediaType: string, data: Buffer) => Promise<UploadMeta>;
  read: (id: string) => Promise<{ data: Buffer; media_type: string } | null>;
  close: () => void;
}

function sniffRasterImageMime(data: Buffer): string | null {
  if (data.byteLength >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return 'image/png';
  }
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.byteLength >= 6) {
    const hdr = data.subarray(0, 6).toString('ascii');
    if (hdr === 'GIF87a' || hdr === 'GIF89a') return 'image/gif';
  }
  if (data.byteLength >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function sanitizeUploadMediaType(rawMime: string, data: Buffer): string {
  const base = rawMime.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
  const normalized = base === 'image/jpg' ? 'image/jpeg' : base;
  if (ACTIVE_WEB_MIMES.has(normalized)) return 'application/octet-stream';
  if (normalized.startsWith('image/')) {
    return sniffRasterImageMime(data) ?? 'application/octet-stream';
  }
  return normalized;
}

function safeServedMediaType(mediaType: string): string {
  const base = mediaType.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
  if (ACTIVE_WEB_MIMES.has(base)) return 'application/octet-stream';
  if (base.startsWith('image/') && !SAFE_RASTER_IMAGE_MIMES.has(base)) return 'application/octet-stream';
  return base;
}

function createUploadStore(settingsDir: string): UploadStore {
  const uploadDir = path.join(settingsDir, 'uploads');
  const uploads = new Map<string, UploadMeta>();

  const ensureDir = async (): Promise<void> => {
    await fsp.mkdir(uploadDir, { recursive: true, mode: 0o700 });
  };

  const forget = (id: string): void => {
    uploads.delete(id);
    if (!/^[\w-]+$/.test(id)) return;
    void fsp.unlink(path.join(uploadDir, id)).catch(() => undefined);
    void fsp.unlink(path.join(uploadDir, `${id}.meta.json`)).catch(() => undefined);
  };

  const ttlTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, meta] of uploads) {
      const created = Date.parse(meta.created_at);
      if (!Number.isFinite(created) || now - created > UPLOAD_TTL_MS) forget(id);
    }
  }, 15 * 60 * 1000);
  ttlTimer.unref?.();

  return {
    has: (id) => uploads.has(id),
    get: (id) => uploads.get(id),
    filePath: (id) => path.join(uploadDir, id),
    async hydrate(): Promise<void> {
      try {
        await ensureDir();
        const names = await fsp.readdir(uploadDir);
        const now = Date.now();
        const dataFiles = new Set<string>();
        for (const name of names) {
          if (!/^[\w-]+$/.test(name)) continue;
          const full = path.join(uploadDir, name);
          const lst = await fsp.lstat(full).catch(() => null);
          if (!lst || lst.isSymbolicLink() || !lst.isFile()) continue;
          if (now - lst.mtimeMs > UPLOAD_TTL_MS) {
            await fsp.unlink(full).catch(() => undefined);
            await fsp.unlink(path.join(uploadDir, `${name}.meta.json`)).catch(() => undefined);
            continue;
          }
          dataFiles.add(name);
          if (uploads.has(name)) continue;
          let meta: UploadMeta | null = null;
          const metaPath = path.join(uploadDir, `${name}.meta.json`);
          const metaLst = await fsp.lstat(metaPath).catch(() => null);
          if (metaLst && !metaLst.isSymbolicLink() && metaLst.isFile()) {
            try {
              const raw = JSON.parse(await fsp.readFile(metaPath, 'utf8')) as Partial<UploadMeta>;
              if (typeof raw.name === 'string' && typeof raw.media_type === 'string' && typeof raw.created_at === 'string') {
                meta = {
                  id: name,
                  name: raw.name,
                  media_type: safeServedMediaType(raw.media_type),
                  size: typeof raw.size === 'number' && Number.isFinite(raw.size) ? raw.size : lst.size,
                  created_at: raw.created_at,
                };
              }
            } catch {
              // ignore corrupt sidecar
            }
          }
          uploads.set(name, meta ?? {
            id: name,
            name,
            media_type: 'application/octet-stream',
            size: lst.size,
            created_at: new Date(lst.mtimeMs).toISOString(),
          });
        }
        for (const name of names) {
          if (!name.endsWith('.meta.json')) continue;
          const id = name.slice(0, -'.meta.json'.length);
          if (!dataFiles.has(id)) {
            await fsp.unlink(path.join(uploadDir, name)).catch(() => undefined);
          }
        }
      } catch {
        // 上传目录不可用时不阻塞启动。
      }
    },
    async store(name: string, mediaType: string, data: Buffer): Promise<UploadMeta> {
      const id = randomUUID();
      await ensureDir();
      const safeName = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '') || 'upload';
      const safeMime = sanitizeUploadMediaType(mediaType, data);
      const meta: UploadMeta = {
        id,
        name: safeName,
        media_type: safeMime,
        size: data.byteLength,
        created_at: new Date().toISOString(),
      };
      await fsp.writeFile(path.join(uploadDir, id), data, { mode: 0o600 });
      await fsp.writeFile(path.join(uploadDir, `${id}.meta.json`), JSON.stringify(meta), { mode: 0o600 });
      uploads.set(id, meta);
      return meta;
    },
    async read(id: string): Promise<{ data: Buffer; media_type: string } | null> {
      const meta = uploads.get(id);
      if (!meta || !/^[\w-]+$/.test(id)) return null;
      const full = path.join(uploadDir, id);
      try {
        const lst = await fsp.lstat(full);
        if (lst.isSymbolicLink() || !lst.isFile()) return null;
        return { data: await fsp.readFile(full), media_type: safeServedMediaType(meta.media_type) };
      } catch {
        return null;
      }
    },
    close(): void {
      clearInterval(ttlTimer);
    },
  };
}

/** 极简 multipart/form-data 解析:只取第一个带 filename 的段(前端 postForm 单文件)。 */
async function readMultipart(req: IncomingMessage): Promise<{ filename: string; contentType: string; data: Buffer } | null> {
  const ct = String(req.headers['content-type'] ?? '');
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
  if (!m) return null;
  const boundary = (m[1] ?? m[2]).trim();
  // 先查 content-length 再读 body—— oversized 直接拒,不把几百 MB 读进内存。
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > 25 * 1024 * 1024) {
    throw new ProviderError('invalid_request', 'file too large (25MB max)', 400);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).byteLength;
    if (size > 25 * 1024 * 1024) {
      throw new ProviderError('invalid_request', 'file too large (25MB max)', 400);
    }
    chunks.push(c as Buffer);
  }
  const body = Buffer.concat(chunks);
  const delim = Buffer.from(`--${boundary}`);
  const start = body.indexOf(delim);
  if (start === -1) return null;
  const headerEnd = body.indexOf('\r\n\r\n', start);
  if (headerEnd === -1) return null;
  const header = body.subarray(start, headerEnd).toString('utf8');
  const filename = /filename="([^"]*)"/.exec(header)?.[1] ?? 'upload';
  const contentType = /content-type:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim() ?? 'application/octet-stream';
  let end = body.indexOf(delim, headerEnd + 4);
  if (end === -1) end = body.byteLength;
  let data = body.subarray(headerEnd + 4, end);
  // 段尾分隔符前的 \r\n 属于分隔符,不属于文件内容。
  if (data.byteLength >= 2 && data[data.byteLength - 2] === 13 && data[data.byteLength - 1] === 10) {
    data = data.subarray(0, data.byteLength - 2);
  }
  return { filename, contentType, data };
}
