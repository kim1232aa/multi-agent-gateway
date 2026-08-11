/**
 * gateway:对外讲 Kimi kap-server 协议的 HTTP + WebSocket 服务。
 *
 * 路由规则:
 * - provider 通过 URL query `?provider=kimi|claude|codex` 显式指定,或由会话 id 前缀推断。
 * - Kimi 会话(id 无前缀)→ 由 kimi-proxy 无损转发到 58627。
 * - Codex / Claude 会话 → facade 适配层,把三家协议翻译成 Kimi wire 格式。
 *
 * 只实现"能用三家会话"的最小 API 面:
 *   meta / auth / healthz / workspaces / sessions(CRUD+snapshot)/ prompts(提交/中止)
 *   / approvals / questions,加 /api/v1/ws 事件推送。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadWebShell, type WebShell } from './web-assets.js';
import { createKimiHttpProxy } from './kimi-proxy.js';
import { spawnKimiServer, type KimiChild } from './kimi-child.js';
import { createStaticServer } from './static.js';
import { CodexProviderAdapter, ClaudeProviderAdapter } from './facade.js';
import { codexGatewayCommandNames } from './native-commands.js';
import { fsDiff, fsGitStatus, fsGrep, fsList, fsRead, fsSearch } from './fs-local.js';
import {
  ProviderError,
  isProviderName,
  type GatewayEvent,
  type Message,
  type NativeCommand,
  type ProviderAdapter,
  type ProviderName,
  type Session,
  type SessionUsage,
  type TurnAttachment,
  type TurnHandle,
} from './types.js';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface GatewayOptions {
  port?: number;
  host?: string;
  /** 网关自身的访问 token(前端 #token= 或 Bearer)。 */
  token?: string;
  codex?: CodexProviderAdapter;
  claude?: ClaudeProviderAdapter;
  /**
   * Kimi 路径的上游来源:
   * - 'spawn'(默认):网关自起 `kimi web` 子进程并解析它的 token;
   * - { upstream, token }:用外部 kap-server(需调用方提供 token);
   * - 'off':不提供 Kimi 路径(仅剩 Codex/Claude)。
   */
  kimi?: 'spawn' | 'off' | { upstream: string; token?: string };
  /** kimi-web 构建产物目录(SPA 静态托管);默认仓库 web-dist。 */
  staticDir?: string;
  /** 注入层目录;默认仓库 web-extension。 */
  extensionDir?: string;
  /** 官方资产 manifest;默认仓库 web-origin-manifest.json。 */
  manifestPath?: string;
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

const ID_PREFIX: Record<Exclude<ProviderName, 'kimi'>, string> = {
  codex: 'codex_',
  claude: 'claude_',
};

function prefixedId(provider: ProviderName, nativeId: string): string {
  return provider === 'kimi' ? nativeId : `${ID_PREFIX[provider]}${nativeId}`;
}

function providerFromSessionId(id: string): { provider: ProviderName; nativeId: string } {
  for (const [provider, prefix] of Object.entries(ID_PREFIX) as [Exclude<ProviderName, 'kimi'>, string][]) {
    if (id.startsWith(prefix)) {
      return { provider, nativeId: id.slice(prefix.length) };
    }
  }
  return { provider: 'kimi', nativeId: id };
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
  for await (const c of req) chunks.push(c as Buffer);
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
}

/** 排队中的 prompt(busy 时提交;对齐 kap-server 的 queued 语义)。 */
interface QueuedPrompt {
  promptId: string;
  text: string;
  /** 随 prompt 的附件(网关解析后的形态;接力时一并交给 adapter)。 */
  attachments?: TurnAttachment[];
  createdAt: string;
}

class SessionHub {
  readonly busy = new Map<string, ActiveTurn>();
  readonly queued = new Map<string, QueuedPrompt[]>();
  private readonly listeners = new Map<string, Set<(ev: Record<string, unknown>) => void>>();
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

  subscribe(sessionId: string, fn: (ev: Record<string, unknown>) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
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
    for (const fn of this.listeners.get(sessionId) ?? []) fn(frame);
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
  const token = options.token ?? randomBytes(24).toString('base64url');
  const adapters: Record<Exclude<ProviderName, 'kimi'>, ProviderAdapter> = {
    codex: options.codex ?? new CodexProviderAdapter(),
    claude: options.claude ?? new ClaudeProviderAdapter(),
  };
  const hub = new SessionHub();

  // 解析 Kimi 上游:默认自起 kap-server 子进程(token 从它 stdout 解析)。
  let kimi: KimiUpstream | null = null;
  const kimiOpt = options.kimi ?? 'spawn';
  if (kimiOpt === 'spawn') {
    const child = await spawnKimiServer();
    kimi = { url: child.url, token: child.token, child };
  } else if (kimiOpt !== 'off') {
    if (!kimiOpt.token) throw new Error('external kimi upstream requires a token');
    kimi = { url: kimiOpt.upstream, token: kimiOpt.token };
  }

  // Kimi 路径的 HTTP 代理:命中 Kimi 专属请求时换票转发到 kap-server。
  // provider 是网关内部的分流参数,上游不认识,转发前删除。
  const kimiHttp = kimi
    ? createKimiHttpProxy({ upstream: kimi.url, upstreamToken: kimi.token, stripQueryParams: ['provider', 'token'] })
    : null;

  // SPA 静态托管:校验官方 0.33 资产后只在 index 响应内存中注入扩展。
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
      // 鉴权先于一切路由和代理(审查发现:provider=kimi 透传曾在鉴权之前执行,
      // 无凭证请求被重写 Authorization 后直达上游 = 完整鉴权绕过)。healthz 免鉴权;
      // 与 route 内的检查并存(双保险),WS 握手走 upgrade 通道不受影响。
      const preAuthUrl = new URL(req.url ?? '/', 'http://localhost');
      if (preAuthUrl.pathname.startsWith(API) && preAuthUrl.pathname !== `${API}/healthz` && !authed(req, token)) {
        fail(res, 401, 40101, 'Unauthorized', ulid());
        return;
      }
      // Kimi 会话(id 无前缀)的 REST → 无损代理到原版 kap-server。
      if (kimiHttp && shouldProxyToKimi(req)) {
        const handled = await kimiHttp(req, res);
        if (handled) return;
      }
      await route(req, res);
    })().catch((err: unknown) => {
      const requestId = ulid();
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
    if (!url.pathname.startsWith(API)) {
      if (serveStatic && serveStatic(req, res)) return;
      fail(res, 404, 40400, 'not an api route', requestId);
      return;
    }

    // 鉴权:Bearer 或 WS 子协议 token。healthz 免鉴权。
    if (url.pathname !== `${API}/healthz` && !authed(req, token)) {
      fail(res, 401, 40101, 'Unauthorized', requestId);
      return;
    }

    const sub = url.pathname.slice(API.length);
    const providerParam = url.searchParams.get('provider');
    const provider: ProviderName | undefined = providerParam && isProviderName(providerParam) ? providerParam : undefined;

    // --- 元信息 ---
    if (sub === '/healthz') return ok(res, { ok: true }, requestId);
    if (sub === '/meta') {
      return ok(res, {
        server_version: 'multi-agent-gateway/0.1 (Kimi 0.33.0 compatible)',
        capabilities: { websocket: true, file_upload: true, fs_query: true, mcp: false, tasks: true, terminal: true },
        server_id: 'multi-agent-gateway',
        started_at: new Date(0).toISOString(),
        open_in_apps: [],
        dangerous_bypass_auth: false,
        backend: 'v2',
        providers: ['kimi', 'claude', 'codex'],
      }, requestId);
    }
    if (sub === '/auth') {
      if (provider && provider !== 'kimi') {
        const models = adapters[provider].listModels ? await adapters[provider].listModels().catch(() => []) : [];
        const defaultModel = models[0]?.model ?? null;
        return ok(res, {
          ready: defaultModel !== null,
          providers_count: 1,
          default_model: defaultModel,
          managed_provider: null,
        }, requestId);
      }
      return ok(res, { ready: true, providers_count: 1, default_model: null, managed_provider: null }, requestId);
    }

    // 非 Kimi provider 复用官方 0.33 配置 UI，但配置只投影到当前 provider，
    // 不把 Claude/Codex 模型写进 Kimi 的 config.toml。
    if (provider && provider !== 'kimi' && sub === '/config' && (req.method === 'GET' || req.method === 'POST')) {
      const patch = req.method === 'POST'
        ? ((await readBody(req)) as Record<string, unknown>)
        : {};
      return ok(res, await providerConfigView(provider, adapters[provider], kimiFetch, patch), requestId);
    }
    if (provider && provider !== 'kimi' && sub === '/providers' && req.method === 'GET') {
      return ok(res, { items: [await providerDto(provider, adapters[provider])] }, requestId);
    }
    if (provider && provider !== 'kimi' && isProviderRefreshRoute(sub) && req.method === 'POST') {
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
      // claude/codex → 各自 adapter 的原生目录;kimi(或未指定)→ 代理上游,
      // 失败给空列表。
      if (provider && provider !== 'kimi') {
        const adapter = adapters[provider];
        const items = adapter.listModels ? await adapter.listModels().catch(() => []) : [];
        return ok(res, { items }, requestId);
      }
      const data = kimiFetch ? ((await kimiFetch('/models').catch(() => null)) as Record<string, unknown> | null) : null;
      return ok(res, data ?? { items: [] }, requestId);
    }
    // 新建会话草稿(还没有 session id)时的原生命令目录,按 ?provider= 分流。
    if (sub === '/commands' && req.method === 'GET') {
      if (!provider || provider === 'kimi') return ok(res, { items: [] }, requestId);
      const adapter = adapters[provider];
      const items = adapter.listCommands ? await adapter.listCommands(undefined) : [];
      return ok(res, { items }, requestId);
    }

    // --- 文件上传(存网关本地;提交 prompt 时按 provider 翻译成各家输入) ---
    if (sub === '/files' && req.method === 'POST') {
      const part = await readMultipart(req);
      if (!part) throw new ProviderError('invalid_request', 'expected multipart/form-data with a file field', 400);
      return ok(res, await storeUpload(part.filename, part.contentType, part.data), requestId);
    }
    const fileMatch = /^\/files\/([^/:]+)$/.exec(sub);
    if (fileMatch && req.method === 'GET') {
      const f = await readUpload(decodeURIComponent(fileMatch[1]));
      if (!f) return fail(res, 404, 40401, 'file not found', requestId);
      res.writeHead(200, {
        'content-type': f.media_type,
        'content-length': String(f.data.byteLength),
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(f.data);
      return;
    }

    // --- 目录浏览(前端"添加本地项目"选目录;PRESUMED 端点,本网关实现) ---
    if (sub === '/fs:browse' && req.method === 'GET') {
      const target = url.searchParams.get('path') || os.homedir();
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
    if (workspaceSkills && provider && provider !== 'kimi' && req.method === 'GET') {
      return ok(res, { skills: await adapterSkills(adapters[provider], provider) }, requestId);
    }

    // --- workspaces ---
    if (sub === '/workspaces' && req.method === 'GET') {
      return ok(res, await listWorkspaces(adapters, kimiFetch, provider), requestId);
    }
    if (sub === '/workspaces' && req.method === 'POST') {
      const body = (await readBody(req)) as { root: string; name?: string };
      return ok(res, workspaceDto(body.root, body.name), requestId);
    }

    // --- sessions ---
    if (sub === '/sessions' && req.method === 'GET') {
      return ok(res, await listSessions(adapters, kimiFetch, url, provider, (sid) => hub.busy.has(sid)), requestId);
    }
    if (sub === '/sessions' && req.method === 'POST') {
      return ok(res, await createSession(adapters, kimiFetch, await readBody(req), provider), requestId);
    }

    const sessMatch = /^\/sessions\/([^/:]+)(.*)$/.exec(sub);
    if (sessMatch) {
      const [, rawId, tail] = sessMatch;
      const { provider: sp, nativeId } = providerFromSessionId(decodeURIComponent(rawId));

      if (sp === 'kimi') {
        // 交给 kimi-proxy(shouldProxyToKimi 已判)。理论到不了这里。
        return fail(res, 404, 40401, 'kimi session handled by proxy', requestId);
      }
      const adapter = adapters[sp];

      if (tail === '' && req.method === 'GET') {
        return ok(res, sessionDto(await getSession(adapter, sp, nativeId), adapter.getModel?.(nativeId), adapter.getUsage?.(nativeId), hub.busy.has(prefixedId(sp, nativeId))), requestId);
      }
      if (tail === '' && req.method === 'DELETE') {
        if (!adapter.delete) throw new ProviderError('unsupported', `${sp} 不支持删除会话`, 400);
        await adapter.delete(nativeId);
        // 清掉 hub 里的残留态(队列/回放缓冲),避免删后重建同 id 会话串味。
        hub.drop(prefixedId(sp, nativeId));
        return ok(res, { deleted: true }, requestId);
      }
      if (tail === ':archive' && req.method === 'POST') {
        if (!adapter.setArchived) throw new ProviderError('unsupported', `${sp} 不支持归档`, 400);
        await adapter.setArchived(nativeId, true);
        hub.drop(prefixedId(sp, nativeId));
        return ok(res, { archived: true }, requestId);
      }
      if (tail === ':restore' && req.method === 'POST') {
        if (!adapter.setArchived) throw new ProviderError('unsupported', `${sp} 不支持恢复归档`, 400);
        await adapter.setArchived(nativeId, false);
        return ok(res, sessionDto(await getSession(adapter, sp, nativeId), adapter.getModel?.(nativeId), adapter.getUsage?.(nativeId), hub.busy.has(prefixedId(sp, nativeId))), requestId);
      }
      if (tail === ':undo' && req.method === 'POST') {
        // 撤销最近 count 轮。codex:thread/rollback(0.147.0 实测历史真消失,
        // 但官方已标 DEPRECATED)。claude:stream-json 下 /rewind 是 TUI 专用
        // (二进制注册表 supportsNonInteractive:false),无可用机制,如实 400。
        if (!adapter.rollback) throw new ProviderError('unsupported', `${sp} 不支持撤销(claude stream-json 无 /rewind 机制)`, 400);
        const body = (await readBody(req).catch(() => ({}))) as { count?: number };
        const count = Math.max(1, Math.min(50, Number(body.count ?? 1) || 1));
        await adapter.rollback(nativeId, count);
        return ok(res, { undone: true, count }, requestId);
      }
      if (tail === ':compact' && req.method === 'POST') {
        const body = (await readBody(req).catch(() => ({}))) as { instruction?: string };
        const sid = prefixedId(sp, nativeId);
        // busy 时压缩会排队/互串,直接 409(与网关代执行命令同一 guard);
        // 否则会假 started(审查发现)。
        if (hub.busy.has(sid)) throw new ProviderError('busy', 'session busy: 当前 turn 结束后再压缩', 409);
        hub.broadcast(sid, frame(sid, hub, 'compaction.started', { trigger: 'manual', ...(body.instruction ? { instruction: body.instruction } : {}) }));
        if (adapter.compact) {
          // codex:adapter.compact 等到 contextCompaction item 完成才返回
          // (0.147.0 复核:item/completed + type==='contextCompaction' 是真完成
          // 信号),completed 广播在真实完成点(对齐 kap-server worker 尾部)。
          await adapter.compact(nativeId);
          hub.broadcast(sid, frame(sid, hub, 'compaction.completed', { result: {} }));
          return ok(res, { compacted: true }, requestId);
        }
        // claude:CLI 在 stream-json 下原生执行 /compact(2.1.226 实测),作为真
        // turn 发出;turn 终态 = 压缩完成,completed 由 onSettled 在终态广播后
        // 发出——不再是"还没跑就先报完成"(审查发现)。
        const text = `/compact${body.instruction ? ` ${body.instruction}` : ''}`;
        const result = await driveTurn(adapter, sp, nativeId, text, () => adapter.startTurn({ sessionId: nativeId, input: text }), hub, randomUUID(), (reason) => {
          hub.broadcast(sid, frame(sid, hub, 'compaction.completed', { result: { reason } }));
        });
        return ok(res, result, requestId);
      }
      if (tail === ':fork' && req.method === 'POST') {
        // codex:thread/fork(0.147.0 实测);claude 的 --fork-session 要新 spawn
        // 流程,未做,如实 400。
        if (!adapter.fork) throw new ProviderError('unsupported', `${sp} 不支持分叉`, 400);
        const forked = await adapter.fork(nativeId);
        // 前端拿到新会话后直接跳转;广播 session.created 让列表刷新。
        const sid = prefixedId(sp, forked.id);
        hub.broadcast(sid, frame(sid, hub, 'event.session.created', { session: sessionDto(forked, adapter.getModel?.(forked.id), adapter.getUsage?.(forked.id)) }));
        return ok(res, sessionDto(forked, adapter.getModel?.(forked.id), adapter.getUsage?.(forked.id)), requestId);
      }
      if (tail === '/warnings' && req.method === 'GET') {
        // 前端每次打开会话自动拉;本地 provider 无警告机制,回空。
        return ok(res, { warnings: [] }, requestId);
      }
      if (tail === '/children' && req.method === 'GET') {
        // 前端目前无调用(client 层未接线);如实回空页。
        return ok(res, { items: [], has_more: false }, requestId);
      }
      if (tail === '/children' && req.method === 'POST') {
        throw new ProviderError('unsupported', `${sp} 不支持子会话(codex 子线程只能 agent 内部 spawn)`, 400);
      }
      if (tail === '/skills' && req.method === 'GET') {
        return ok(res, { skills: await adapterSkills(adapter, sp, nativeId) }, requestId);
      }
      const skillActivate = /^\/skills\/([^/:]+):activate$/.exec(tail);
      if (skillActivate && req.method === 'POST') {
        // 激活 = 把 "/skill名 参数" 作为 prompt 发出:claude CLI 原生执行;
        // codex 由 facade 在 startTurn 里展开 SKILL.md 正文(实测可用路径)。
        const body = (await readBody(req).catch(() => ({}))) as { args?: string };
        const name = decodeURIComponent(skillActivate[1]);
        const text = `/${name}${body.args ? ` ${body.args}` : ''}`;
        await submitPrompt(adapter, sp, nativeId, { content: [{ type: 'text', text }] }, hub);
        return ok(res, { activated: true, skill_name: name }, requestId);
      }
      // --- fs:*(文件树/@提及/搜索/git 状态;网关本机实现,cwd 沙箱防穿越) ---
      if (tail.startsWith('/fs:') || /^\/fs\/.*:download$/.test(tail)) {
        const session = await getSession(adapter, sp, nativeId);
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
        if (tail === '/fs:diff' && req.method === 'POST') {
          const body = (await readBody(req)) as { path: string };
          return ok(res, await fsDiff(cwd, body), requestId);
        }
        // fs:open/fs:reveal/fs:open-in/fs download 前端是死代码入口,如实 400。
        throw new ProviderError('unsupported', `${tail} 未实现(打开/下载在纯 web 端无意义)`, 400);
      }
      if (tail === '/goal' && req.method === 'GET') {
        if (!adapter.getGoal) return ok(res, null, requestId);
        return ok(res, codexGoalToWire(await adapter.getGoal(nativeId)), requestId);
      }
      if (tail === '/export' && req.method === 'POST') {
        const session = await getSession(adapter, sp, nativeId);
        const history = await adapter.getHistory(nativeId).catch(() => [] as Message[]);
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
        // 本地 provider 可落地的字段:model / thinking / title / permission /
        // plan_mode / goal(goal_objective 设目标,goal_control 暂停/恢复/取消)。
        // swarm_mode 本地 provider 无机制,接受但忽略(前端对 codex/claude 不展示)。
        const body = (await readBody(req)) as {
          title?: string;
          agent_config?: {
            model?: string;
            thinking?: string;
            permission_mode?: string;
            plan_mode?: boolean;
            goal_objective?: string;
            goal_control?: 'pause' | 'resume' | 'cancel';
          };
        };
        if (typeof body?.title === 'string' && body.title.trim() && adapter.rename) {
          await adapter.rename(nativeId, body.title.trim());
        }
        const cfg = body?.agent_config ?? {};
        if (cfg.model && adapter.setModel) await adapter.setModel(nativeId, cfg.model);
        if (typeof cfg.thinking === 'string' && adapter.setThinking) {
          await adapter.setThinking(nativeId, cfg.thinking);
        }
        if (typeof cfg.permission_mode === 'string' && adapter.setPermission) {
          await adapter.setPermission(nativeId, cfg.permission_mode);
        }
        if (typeof cfg.plan_mode === 'boolean' && adapter.setPlanMode) {
          await adapter.setPlanMode(nativeId, cfg.plan_mode);
        }
        if (typeof cfg.goal_objective === 'string' && adapter.setGoal) {
          await adapter.setGoal(nativeId, cfg.goal_objective);
        }
        if (typeof cfg.goal_control === 'string' && adapter.controlGoal) {
          await adapter.controlGoal(nativeId, cfg.goal_control);
        }
        return ok(res, sessionDto(await getSession(adapter, sp, nativeId), adapter.getModel?.(nativeId), adapter.getUsage?.(nativeId), hub.busy.has(prefixedId(sp, nativeId))), requestId);
      }
      if (tail === '/status' && req.method === 'GET') {
        // 前端 refreshSessionStatus 的唯一回读通道:live model/thinking/permission/
        // plan/上下文占用。usage 来自 adapter 的会话级累计(codex tokenUsage
        // 通知 / claude result.usage)。
        const usage = adapter.getUsage?.(nativeId);
        // 上下文窗口回退(审查发现首轮前恒 0):claude 按模型名启发式(与 facade
        // 的 done 事件口径一致);codex 只信 tokenUsage 下发的 modelContextWindow,
        // 没有就诚实 0——不编造窗口值。
        let contextLimit = usage?.context_limit ?? 0;
        if (contextLimit <= 0 && sp === 'claude') {
          const m = adapter.getModel?.(nativeId) ?? '';
          if (m) contextLimit = m.includes('[1m]') ? 1_000_000 : 200_000;
        }
        return ok(res, {
          model: adapter.getModel?.(nativeId) ?? '',
          thinking_level: adapter.getThinking?.(nativeId) ?? '',
          permission: adapter.getPermission?.(nativeId) ?? 'default',
          plan_mode: adapter.getPlanMode?.(nativeId) ?? false,
          swarm_mode: false,
          context_tokens: usage?.context_tokens ?? 0,
          max_context_tokens: contextLimit,
          context_usage:
            usage && contextLimit > 0 ? Math.min(1, usage.context_tokens / contextLimit) : 0,
        }, requestId);
      }
      if (tail === '/commands' && req.method === 'GET') {
        const items = adapter.listCommands ? await adapter.listCommands(nativeId) : [];
        return ok(res, { items }, requestId);
      }
      if (tail === '/messages' && req.method === 'GET') {
        return ok(res, await listAdapterMessages(adapter, sp, nativeId, url), requestId);
      }
      if (tail === '/transcript/plan' && req.method === 'GET') {
        return ok(res, {
          agent_id: url.searchParams.get('agent_id') ?? 'main',
          plans: [],
        }, requestId);
      }
      if (tail === '/snapshot' && req.method === 'GET') {
        return ok(res, await snapshot(adapter, sp, nativeId, hub), requestId);
      }
      if (tail === '/prompts' && req.method === 'GET') {
        return ok(res, listPrompts(prefixedId(sp, nativeId), hub), requestId);
      }
      if (tail === '/prompts' && req.method === 'POST') {
        const body = (await readBody(req)) as {
          content: { type: string; text?: string }[];
          model?: string; thinking?: string; permission_mode?: string; plan_mode?: boolean;
        };
        // 前端每条 prompt 都带全套控制字段(mappers.toWirePromptSubmission),
        // 设计上以 prompt 为本 turn 权威——此前网关只读 content,草稿态开 Plan
        // 发首条消息实际不是 plan 跑的(审查发现)。apply-if-changed,避免每
        // 条 prompt 都白打一遍 RPC。
        if (body.model && adapter.setModel && adapter.getModel?.(nativeId) !== body.model) {
          await adapter.setModel(nativeId, body.model);
        }
        if (body.thinking && adapter.setThinking && adapter.getThinking?.(nativeId) !== body.thinking) {
          await adapter.setThinking(nativeId, body.thinking);
        }
        if (body.permission_mode && adapter.setPermission && adapter.getPermission?.(nativeId) !== body.permission_mode) {
          await adapter.setPermission(nativeId, body.permission_mode);
        }
        if (typeof body.plan_mode === 'boolean' && adapter.setPlanMode && adapter.getPlanMode?.(nativeId) !== body.plan_mode) {
          await adapter.setPlanMode(nativeId, body.plan_mode);
        }
        return ok(res, await submitPrompt(adapter, sp, nativeId, body, hub), requestId);
      }
      if (tail === ':abort' && req.method === 'POST') {
        const aborted = await abortTurn(adapter, sp, nativeId, hub);
        return ok(res, { aborted }, requestId);
      }
      const promptAbort = /^\/prompts\/([^/:]+):abort$/.exec(tail);
      if (promptAbort && req.method === 'POST') {
        const pid = decodeURIComponent(promptAbort[1]);
        // 命中排队中的 prompt → 出队即中止;命中活动 turn → interrupt;
        // 都不命中 → 该 prompt 已完结,如实回 aborted:false(前端按已完成处理)。
        const sid = prefixedId(sp, nativeId);
        const queue = hub.queued.get(sid);
        const qIdx = queue?.findIndex((q) => q.promptId === pid) ?? -1;
        if (queue && qIdx >= 0) {
          queue.splice(qIdx, 1);
          if (queue.length === 0) hub.queued.delete(sid);
          // 排队 prompt 从未开 turn:发 prompt.aborted(不是 prompt.completed),
          // 前端投影器靠它清 in-flight 状态。
          hub.broadcast(sid, frame(sid, hub, 'prompt.aborted', { promptId: pid, abortedAt: new Date().toISOString() }));
          return ok(res, { aborted: true }, requestId);
        }
        const active = hub.busy.get(sid);
        if (active && active.promptId !== pid) {
          return ok(res, { aborted: false }, requestId);
        }
        const aborted = await abortTurn(adapter, sp, nativeId, hub);
        return ok(res, { aborted }, requestId);
      }
      if (tail === '/approvals' && req.method === 'GET') {
        return ok(res, { items: pendingApprovals(prefixedId(sp, nativeId), hub) }, requestId);
      }
      const approvalResolve = /^\/approvals\/([^/:]+)$/.exec(tail);
      if (approvalResolve && req.method === 'POST') {
        const body = (await readBody(req)) as { decision: string };
        await resolveApproval(adapter, sp, nativeId, decodeURIComponent(approvalResolve[1]), body, hub);
        return ok(res, { resolved: true, resolved_at: new Date().toISOString() }, requestId);
      }
      if (tail === '/questions' && req.method === 'GET') {
        return ok(res, { items: pendingQuestions(prefixedId(sp, nativeId), hub) }, requestId);
      }
      const questionResolve = /^\/questions\/([^/:]+)$/.exec(tail);
      if (questionResolve && req.method === 'POST') {
        const body = (await readBody(req)) as { answers?: Record<string, unknown>; text?: string };
        await resolveQuestion(adapter, sp, nativeId, decodeURIComponent(questionResolve[1]), body, hub);
        return ok(res, { resolved: true, resolved_at: new Date().toISOString() }, requestId);
      }
      const questionDismiss = /^\/questions\/([^/:]+):dismiss$/.exec(tail);
      if (questionDismiss && req.method === 'POST') {
        const qid = decodeURIComponent(questionDismiss[1]);
        // 空答案 = 跳过(对齐 adapter autoApprove 的 {answers:{}} 形状)。
        await adapter.resolveQuestion(nativeId, qid, {}).catch(() => undefined);
        const sid = prefixedId(sp, nativeId);
        hub.busy.get(sid)?.pendingQuestions.delete(qid);
        hub.broadcast(sid, frame(sid, hub, 'event.question.dismissed', {
          question_id: qid, dismissed_at: new Date().toISOString(),
        }));
        const activeAfterDismiss = hub.busy.get(sid);
        const pendingAfterDismiss = (activeAfterDismiss?.pendingApprovals.size ?? 0) > 0
          ? 'approval'
          : (activeAfterDismiss?.pendingQuestions.size ?? 0) > 0 ? 'question' : 'none';
        hub.broadcast(sid, frame(sid, hub, 'event.session.work_changed', {
          busy: activeAfterDismiss !== undefined,
          main_turn_active: activeAfterDismiss !== undefined,
          pending_interaction: pendingAfterDismiss,
        }));
        return ok(res, { dismissed: true, dismissed_at: new Date().toISOString() }, requestId);
      }
      if (tail === '/prompts:steer' && req.method === 'POST') {
        // 把排队中的 prompt 注入进行中的 turn(codex turn/steer)。前端仅在
        // 拿到 status:'queued' 后调用;无活动 turn 时 404(前端静默忽略,
        // 排队 prompt 会在当前 turn 结束后自动开自己的 turn)。
        const body = (await readBody(req)) as { prompt_ids?: string[] };
        const ids = body.prompt_ids ?? [];
        const sid = prefixedId(sp, nativeId);
        const active = hub.busy.get(sid);
        if (!active || !active.turnId) {
          throw new ProviderError('not_found', 'PROMPT_NOT_FOUND: no active turn to steer into', 404);
        }
        if (!adapter.steer) {
          throw new ProviderError('unsupported', `${sp} 不支持 steer(排队消息将在本轮结束后自动发出)`, 400);
        }
        const queue = hub.queued.get(sid) ?? [];
        const steered: string[] = [];
        for (const id of ids) {
          const idx = queue.findIndex((q) => q.promptId === id);
          if (idx === -1) continue;
          // 先 steer 成功再出队——steer 失败时 prompt 留在队列里,
          // 当前 turn 结束后仍会作为自己的 turn 发出(审查发现丢消息)。
          await adapter.steer(nativeId, active.turnId, queue[idx].text);
          const [q] = queue.splice(idx, 1);
          steered.push(id);
          // 用户消息回显:前端靠 messageCreated(prompt_id 匹配)落乐观气泡。
          hub.broadcast(sid, frame(sid, hub, 'event.message.created', {
            message: {
              id: randomUUID(), session_id: sid, role: 'user', prompt_id: id,
              content: [{ type: 'text', text: q.text }], created_at: new Date().toISOString(),
            },
          }));
        }
        if (queue.length === 0) hub.queued.delete(sid);
        return ok(res, { steered: steered.length > 0, prompt_ids: steered }, requestId);
      }
      if (tail === '/tasks' && req.method === 'GET') {
        // codex 子 agent 线程不作为任务暴露(用户明确要求列表只显示主会话);
        // claude 无后台任务机制。如实回空。
        return ok(res, { items: [] }, requestId);
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

  // WebSocket:单连接,按订阅的会话 id 前缀分流(Kimi → relay 上游,Codex/Claude → 本地 hub)。
  const gatewaySockets = new Set<Duplex>();
  attachGatewayWebSocket(server, token, hub, kimi, gatewaySockets);

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => resolveListen());
  });

  // 预热列表缓存(codex thread/list 服务端全扫 ~4s),让首个页面请求落在暖缓存上。
  void Promise.allSettled([adapters.codex.list({ limit: 100 }), adapters.claude.list({ limit: 100 })]).then(
    (rs) => {
      const [c, k] = rs;
      console.error(
        `[gateway] 列表预热: codex=${c.status === 'fulfilled' ? c.value.items.length + '条' : '失败:' + c.reason} claude=${k.status === 'fulfilled' ? k.value.items.length + '条' : '失败:' + k.reason}`,
      );
    },
  );

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  return {
    url,
    web: webShell
      ? { injectionEnabled: webShell.injectionEnabled, reason: webShell.reason }
      : null,
    close: () =>
      new Promise((resolveClose) => {
        for (const socket of gatewaySockets) socket.destroy();
        server.close(() => {
          void (kimi?.child?.close() ?? Promise.resolve()).then(() => resolveClose());
        });
      }),
  };
}

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

function authed(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (header === `Bearer ${token}`) return true;
  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string' && proto.includes(`kimi-code.bearer.${token}`)) return true;
  // 开发期:允许 query token
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('token') === token;
}

// ---------------------------------------------------------------------------
// Kimi 代理判定:无 provider 前缀的会话 id / Kimi 专属路由 → 转发 58627
// ---------------------------------------------------------------------------

function shouldProxyToKimi(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith(API)) return false;
  if (url.pathname === `${API}/ws`) return false; // WS 一律由网关终止,按订阅分流
  const provider = url.searchParams.get('provider');
  // 显式 Kimi 视图全部透明代理。只有创建会话需要网关补 profile/model。
  if (provider === 'kimi') {
    return !(url.pathname === `${API}/sessions` && req.method === 'POST');
  }
  if (provider && provider !== 'kimi') return false;

  // 官方 Kimi 新建会话也经过网关，以便补齐 daemon 不会落地的模型配置；
  // GET /sessions 仍保持原版上游分页语义。
  if (!provider && url.pathname === `${API}/sessions` && req.method === 'POST') return false;

  const sessMatch = /^\/api\/v1\/sessions\/([^/:]+)/.exec(url.pathname);
  if (sessMatch) {
    const id = decodeURIComponent(sessMatch[1]);
    return !id.startsWith('codex_') && !id.startsWith('claude_');
  }

  // 官方客户端的文件预览 URL 不带 provider。扩展会给新请求补上 provider；
  // 对遗留的本地上传 id 仍留在网关，其余文件请求交给 Kimi 保持原生语义。
  if (url.pathname.startsWith(`${API}/files/`)) {
    let id = '';
    try {
      id = decodeURIComponent(url.pathname.slice(`${API}/files/`.length));
    } catch {
      return true;
    }
    return !uploads.has(id);
  }

  // 没有 provider 参数时就是纯官方 Kimi Web 语义。只保留网关自身必须终止
  // 的基础路由，其余原生/未来路由默认透明代理，避免升级后被 unknown route
  // 打断。扩展模式的列表/模型/config/files 请求都会显式附 provider。
  const gatewayOwned = new Set([
    `${API}/healthz`,
    `${API}/meta`,
    `${API}/fs:browse`,
    `${API}/fs:home`,
  ]);
  return !gatewayOwned.has(url.pathname);
}

// ---------------------------------------------------------------------------
// workspaces / sessions 数据组装
// ---------------------------------------------------------------------------

type KimiFetch = (path: string, init?: RequestInit) => Promise<unknown>;

function isProviderRefreshRoute(sub: string): boolean {
  return sub === '/providers:refresh' || sub === '/providers:refresh_oauth' || /^\/providers\/[^/:]+:refresh$/.test(sub);
}

async function providerDto(provider: Exclude<ProviderName, 'kimi'>, adapter: ProviderAdapter): Promise<Record<string, unknown>> {
  const models = adapter.listModels ? await adapter.listModels().catch(() => []) : [];
  return {
    id: provider,
    type: provider,
    default_model: models[0]?.model ?? '',
    has_api_key: true,
    status: 'connected',
    models: models.map((model) => model.model),
  };
}

async function providerConfigView(
  provider: Exclude<ProviderName, 'kimi'>,
  adapter: ProviderAdapter,
  kimiFetch: KimiFetch,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const base = (await kimiFetch('/config').catch(() => ({ providers: {} }))) as Record<string, unknown>;
  const models = adapter.listModels ? await adapter.listModels().catch(() => []) : [];
  const requestedModel = typeof patch.default_model === 'string' ? patch.default_model : undefined;
  const defaultModel = requestedModel ?? models[0]?.model ?? '';
  const baseProviders = base.providers && typeof base.providers === 'object'
    ? (base.providers as Record<string, unknown>)
    : {};
  return {
    ...base,
    ...patch,
    providers: {
      ...baseProviders,
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

function skillDto(command: NativeCommand, provider: Exclude<ProviderName, 'kimi'>): Record<string, unknown> {
  return {
    name: command.name,
    description: command.description,
    path: '',
    source: provider,
    type: 'prompt',
    disable_model_invocation: false,
  };
}

async function adapterSkills(
  adapter: ProviderAdapter,
  provider: Exclude<ProviderName, 'kimi'>,
  sessionId?: string,
): Promise<Record<string, unknown>[]> {
  const byName = new Map<string, Record<string, unknown>>();
  if (adapter.listSkills) {
    const skills = await adapter.listSkills(sessionId).catch(() => []);
    for (const skill of skills) {
      if (!skill || typeof skill.name !== 'string' || skill.enabled === false) continue;
      byName.set(skill.name, {
        name: skill.name,
        description: skill.description ?? '',
        path: skill.path ?? '',
        source: provider,
        type: 'prompt',
        disable_model_invocation: false,
      });
    }
  }
  if (adapter.listCommands) {
    const commands = await adapter.listCommands(sessionId).catch(() => [] as NativeCommand[]);
    for (const command of commands) {
      if (command.kind !== 'prompt' || byName.has(command.name)) continue;
      byName.set(command.name, skillDto(command, provider));
    }
  }
  return [...byName.values()];
}

function workspaceDto(root: string, name?: string): Record<string, unknown> {
  const slug = root.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root';
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 12);
  return {
    id: `wd_${slug}_${hash}`.slice(0, 60),
    root,
    name: name ?? slug,
    created_at: new Date().toISOString(),
  };
}

async function listWorkspaces(
  adapters: Record<Exclude<ProviderName, 'kimi'>, ProviderAdapter>,
  kimiFetch: KimiFetch | null,
  provider: ProviderName | undefined,
): Promise<Record<string, unknown>> {
  const roots = new Map<string, Record<string, unknown>>();
  // Kimi 工作区:直接取上游视图(自带 session_count)。
  if (kimiFetch && (!provider || provider === 'kimi')) {
    const data = (await kimiFetch('/workspaces').catch(() => null)) as { items?: Record<string, unknown>[] } | null;
    for (const w of data?.items ?? []) {
      const root = String(w.root ?? w.id ?? '');
      if (root) roots.set(root, w);
    }
  }
  // Codex/Claude:从会话的 cwd 聚合。工作区集合只取最近 50 条(老线程的临时
  // cwd 不造空工作区);session_count 用全量列表统计——前端"加载更多 N 个
  // 对话"按 session_count - 已加载数渲染,缺了会显示 NaN(实测)。
  const targets: ProviderName[] = provider && provider !== 'kimi' ? [provider] : ['codex', 'claude'];
  for (const p of targets) {
    const adapter = adapters[p as Exclude<ProviderName, 'kimi'>];
    const recent = await adapter.list({ limit: 50 }).catch((err) => {
      console.error(`[gateway] listWorkspaces: ${p}.list 失败:`, err instanceof Error ? err.message : err);
      return { items: [] as Session[] };
    });
    for (const s of recent.items) {
      const cwd = s.metadata.cwd;
      if (!roots.has(cwd)) roots.set(cwd, workspaceDto(cwd));
    }
    const all = await adapter.list({ limit: 500 }).catch(() => ({ items: [] as Session[] }));
    const counts = new Map<string, number>();
    for (const s of all.items) {
      counts.set(s.metadata.cwd, (counts.get(s.metadata.cwd) ?? 0) + 1);
    }
    for (const [cwd, n] of counts) {
      const w = roots.get(cwd);
      if (w) w.session_count = (typeof w.session_count === 'number' ? w.session_count : 0) + n;
    }
  }
  return { items: [...roots.values()] };
}

function sessionDto(s: Session, model?: string, usage?: SessionUsage, busy?: boolean): Record<string, unknown> {
  // facade 的 Session.busy 是硬编码 false(三家适配器都不跟踪 live 状态);
  // 真值只能从网关 hub(turn 登记处)拿,调用方有 hub 就传 busy 覆盖——否则
  // 进行中的会话刷新后月亮熄灭、前端误判 turn 结束(审查实测)。
  const isBusy = busy ?? s.busy;
  return {
    id: prefixedId(s.provider, s.id),
    // workspace_id 必须与 listWorkspaces 的 workspaceDto 同一规则生成,
    // 否则前端把会话挂不到聚合工作区树上(facade 内部另有一套 id 规则,在此覆盖)。
    workspace_id: s.metadata?.cwd ? (workspaceDto(String(s.metadata.cwd)).id as string) : s.workspace_id,
    title: s.title,
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

async function listSessions(
  adapters: Record<Exclude<ProviderName, 'kimi'>, ProviderAdapter>,
  kimiFetch: KimiFetch | null,
  url: URL,
  provider: ProviderName | undefined,
  busyOf: (sid: string) => boolean,
): Promise<Record<string, unknown>> {
  const limit = Math.min(Number(url.searchParams.get('page_size') ?? 50) || 50, 100);
  const beforeId = url.searchParams.get('before_id') ?? undefined;
  const excludeEmpty = url.searchParams.get('exclude_empty') === 'true';
  // 前端按工作区逐组拉首页(page_size 很小)并用 before_id 翻页:kimi 透传
  // workspace_id 给上游;codex/claude 由本网关按 cwd 派生的工作区 id 过滤。
  // 本地适配器有缓存,直接拉全量合并后在网关侧分页(before_id 语义对齐上游:
  // 返回比该 id 更旧的一页)。
  const FETCH_ALL = 500;
  const workspaceId = url.searchParams.get('workspace_id') ?? undefined;
  const items: Record<string, unknown>[] = [];
  // 前端按 cwd 把三家会话归到任一同 root 的工作区。先把 workspace_id 解析回
  // root,再按 root 过滤,而不是比 id——kimi 上游的工作区 id 规则(slug 取
  // basename,如 wd_ubuntu_*)与网关派生规则(全路径,如 wd_home-ubuntu_*)
  // 不同,直接透传会被上游 40410 拒掉(实测),所以 kimi 也在本地按 cwd 过滤。
  let workspaceRoot: string | undefined;
  if (workspaceId) {
    const all = (await listWorkspaces(adapters, kimiFetch, provider).catch(() => null)) as
      | { items?: Record<string, unknown>[] }
      | null;
    const hit = (all?.items ?? []).find((w) => w.id === workspaceId);
    workspaceRoot = typeof hit?.root === 'string' && hit.root ? hit.root : undefined;
  }
  const rootNorm = workspaceRoot?.replace(/\/+$/, '');
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
          if (cwd.replace(/\/+$/, '') !== rootNorm) continue;
        }
        items.push(it);
      }
      if (!data?.has_more || pageItems.length === 0) break;
      upstreamBefore = String(pageItems[pageItems.length - 1]?.id ?? '');
      if (!upstreamBefore) break;
    }
  }
  const targets: Exclude<ProviderName, 'kimi'>[] =
    provider && provider !== 'kimi' ? [provider] : ['codex', 'claude'];
  for (const p of targets) {
    const page = await adapters[p].list({ limit: FETCH_ALL }).catch((err) => {
      console.error(`[gateway] listSessions: ${p}.list 失败:`, err instanceof Error ? err.message : err);
      return { items: [] as Session[] };
    });
    for (const s of page.items) {
      if (workspaceId) {
        // 解析不到 root 的工作区 id(已被移除的派生工作区)= 没有会话。
        if (!rootNorm) continue;
        const cwd = typeof s.metadata?.cwd === 'string' ? String(s.metadata.cwd) : '';
        if (cwd.replace(/\/+$/, '') !== rootNorm) continue;
      }
      items.push(sessionDto(s, adapters[p].getModel?.(s.id), adapters[p].getUsage?.(s.id), busyOf(prefixedId(p, s.id))));
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

async function createSession(
  adapters: Record<Exclude<ProviderName, 'kimi'>, ProviderAdapter>,
  kimiFetch: KimiFetch | null,
  body: unknown,
  provider: ProviderName | undefined,
): Promise<Record<string, unknown>> {
  const b = body as { provider?: string; metadata?: { cwd?: string }; cwd?: string; title?: string };
  const target: ProviderName =
    (b.provider && isProviderName(b.provider) ? b.provider : provider) ?? 'kimi';
  if (target === 'kimi') {
    if (!kimiFetch) throw new ProviderError('unsupported', 'kimi provider is off', 400);
    // 原样转发给上游 kap-server,但剔除网关层的 provider 字段——它是本网关的
    // 分流概念,上游 kap-server 不认识(UI 审查:严格 schema 会 400)。
    const forward = { ...(b as Record<string, unknown>) };
    delete forward.provider;
    const created = (await kimiFetch('/sessions', { method: 'POST', body: JSON.stringify(forward) })) as Record<string, unknown>;
    // daemon 怪癖:create 不落地 agent_config.model,新会话 model 为空,
    // 直接发 prompt 会以 model.not_configured 失败。补一发 /profile 设模型
    // (请求体没指定就用上游 /auth 的 default_model)。实测验证过这条链。
    const id = typeof created.id === 'string' ? created.id : '';
    if (id) {
      const requested = (b as { agent_config?: { model?: string } }).agent_config?.model;
      const model =
        requested ??
        ((await kimiFetch('/auth').catch(() => null)) as { default_model?: string } | null)?.default_model;
      if (model) {
        await kimiFetch(`/sessions/${encodeURIComponent(id)}/profile`, {
          method: 'POST',
          // plan_mode:false 对齐官方 UI 空 composer 的默认;否则 API 建会话
          // daemon 默认 plan_mode:true,简单一句 PONG 也要先跑几十秒计划。
          body: JSON.stringify({ agent_config: { model, plan_mode: false } }),
        }).catch(() => null);
      }
    }
    return created;
  }
  const cwd = b.metadata?.cwd ?? b.cwd ?? process.env.HOME ?? '/home/ubuntu';
  const session = await adapters[target].create({ provider: target, cwd, title: b.title, metadata: b.metadata });
  // 新建会话时前端已让用户选了模型/thinking(composer 的 pick 随 create 一起
  // 来);不应用的话首轮 turn 会跑在默认模型上,UI 却显示用户的选择(审查发现)。
  const adapter = adapters[target];
  const createCfg = (b as {
    agent_config?: {
      model?: string;
      thinking?: string;
      permission_mode?: string;
      plan_mode?: boolean;
    };
  }).agent_config;
  if (createCfg?.model && adapter.setModel) await adapter.setModel(session.id, createCfg.model);
  if (typeof createCfg?.thinking === 'string' && adapter.setThinking) {
    await adapter.setThinking(session.id, createCfg.thinking);
  }
  if (typeof createCfg?.permission_mode === 'string' && adapter.setPermission) {
    await adapter.setPermission(session.id, createCfg.permission_mode);
  }
  if (typeof createCfg?.plan_mode === 'boolean' && adapter.setPlanMode) {
    await adapter.setPlanMode(session.id, createCfg.plan_mode);
  }
  return sessionDto(session, adapter.getModel?.(session.id), adapter.getUsage?.(session.id));
}

async function getSession(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
): Promise<Session> {
  // 全量查(本地适配器缓存服务大 limit):只查前 100 条会把较老的真实会话
  // 误判成"新建未落盘",伪造成 HOME 下的假会话(审查发现)。
  const page = await adapter.list({ limit: 500 });
  const found = page.items.find((s) => s.id === nativeId);
  if (found) return found;
  // Claude 新建但还没落盘的会话不在 list 里,造一个最小的;cwd 优先取
  // adapter 记录的(create 时写入),不伪造 HOME 假目录(审查发现)。
  return {
    id: nativeId,
    workspace_id: '',
    title: `${provider} ${nativeId.slice(0, 8)}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    busy: false,
    metadata: { cwd: adapter.getCwd?.(nativeId) ?? process.env.HOME ?? '/home/ubuntu' },
    provider,
  };
}

// ---------------------------------------------------------------------------
// snapshot / prompts
// ---------------------------------------------------------------------------

async function snapshot(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  hub: SessionHub,
): Promise<Record<string, unknown>> {
  const [session, history] = await Promise.all([
    getSession(adapter, provider, nativeId),
    adapter.getHistory(nativeId).catch(() => [] as Message[]),
  ]);
  const sid = prefixedId(provider, nativeId);
  const active = hub.busy.get(sid);
  return {
    as_of_seq: hub.nextSeq(),
    epoch: hub.epoch,
    session: sessionDto(session, adapter.getModel?.(nativeId), adapter.getUsage?.(nativeId), active !== undefined),
    messages: { items: history.map((m) => messageDto(m, sid)), has_more: false },
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
    subagents: [],
    pending_approvals: pendingApprovals(sid, hub),
    pending_questions: pendingQuestions(sid, hub),
  };
}

function messageDto(m: Message, sid: string): Record<string, unknown> {
  return {
    id: m.id,
    session_id: sid,
    role: m.role,
    content: m.content,
    created_at: m.created_at,
    ...(m.metadata ? { metadata: m.metadata } : {}),
  };
}

async function listAdapterMessages(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  url: URL,
): Promise<Record<string, unknown>> {
  let messages = [...await adapter.getHistory(nativeId).catch(() => [] as Message[])].reverse();
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
  const active = hub.busy.get(sid);
  return {
    active: active
      ? {
          prompt_id: active.promptId,
          user_message_id: active.promptId,
          status: 'running',
          content: [{ type: 'text', text: '' }],
          created_at: new Date().toISOString(),
        }
      : null,
    queued: (hub.queued.get(sid) ?? []).map((q) => ({
      prompt_id: q.promptId,
      user_message_id: q.promptId,
      status: 'queued',
      content: [{ type: 'text', text: q.text }],
      created_at: q.createdAt,
    })),
  };
}

/**
 * 解析 prompt 提交体:text 部分拼接;image/video/file 附件翻译成
 * TurnAttachment(网关上传单 → 磁盘路径;base64 → data URL;http URL
 * 诚实降级为文字引用——codex turn/start 的 image 项只收 data URL)。
 * 上传单丢失(重启后内存元数据没了)时降级为文字说明,不让 prompt 整个失败。
 */
function extractAttachments(content: Array<Record<string, unknown>>): { text: string; attachments: TurnAttachment[] } {
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
        const meta = uploads.get(src.file_id);
        if (!meta) {
          texts.push(`[attached ${type} unavailable: upload expired]`);
          continue;
        }
        const p = path.join(UPLOAD_DIR, meta.id);
        // codex 有 localImage 没有 video 输入项:图片给路径,视频物化成文本。
        attachments.push(
          type === 'image'
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
      const meta = fileId ? uploads.get(fileId) : undefined;
      if (meta) {
        attachments.push({ kind: 'filePathText', path: path.join(UPLOAD_DIR, meta.id), name: meta.name, mediaType: meta.media_type, size: meta.size });
      } else {
        texts.push(`[attached file unavailable: ${String(c.name ?? 'unknown')}]`);
      }
    }
  }
  return { text: texts.join('\n'), attachments };
}

async function submitPrompt(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  body: { content: Array<Record<string, unknown>> },
  hub: SessionHub,
): Promise<Record<string, unknown>> {
  // hub 键统一用带 provider 前缀的 wire id:codex/claude 的原生 id 都是 UUID,
  // 只用 nativeId 会让同名会话跨 provider 互串 busy/广播(审查发现)。
  const sid = prefixedId(provider, nativeId);
  const { text, attachments } = extractAttachments(body.content ?? []);
  if (!text.trim() && attachments.length === 0) throw new ProviderError('invalid_request', 'empty prompt', 400);

  // codex 网关代执行命令(/compact /fork /undo /status /usage /mcp /review):
  // app-server 没有 slash 概念,名字命中时映射到对应 RPC。/review 是真 turn,
  // 走 driveTurn;其余是即时代执行,输出以系统消息形式广播。claude 不拦截
  // —— CLI 在 stream-json 模式下自己执行斜杠命令(2.1.226 实测)。
  // 必须在 busy 排队之前拦截:代执行命令走 RPC 而非 turn/start,排进队列会被
  // drainQueue 当普通 prompt 发给模型。turn 进行中返回 409——既避免即时代执行
  // 帧与真 turn 帧在投影器里互串,也防止命令文本泄漏给模型(审查发现)。
  const cmd = provider === 'codex' ? /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim()) : null;
  if (cmd && codexGatewayCommandNames().has(cmd[1])) {
    if (hub.busy.has(sid)) throw new ProviderError('busy', 'session busy: 当前 turn 结束后再执行命令', 409);
    const [, name, argsText] = cmd;
    if (name === 'review') {
      if (!adapter.review) throw new ProviderError('unsupported', 'review 不可用', 400);
      return driveTurn(adapter, provider, nativeId, '/review', () => adapter.review!(nativeId), hub);
    }
    return runCodexLocalCommand(adapter, provider, nativeId, name, (argsText ?? '').trim(), hub);
  }

  // busy → 排队(对齐 kap-server:前端 steer 流依赖 status:'queued';队列里
  // 的 prompt 在当前 turn 结束后自动开自己的 turn,或被 prompts:steer 注入)。
  if (hub.busy.has(sid)) {
    const promptId = randomUUID();
    const q = hub.queued.get(sid) ?? [];
    q.push({ promptId, text, attachments, createdAt: new Date().toISOString() });
    hub.queued.set(sid, q);
    return {
      prompt_id: promptId,
      user_message_id: promptId,
      status: 'queued',
      content: [{ type: 'text', text }],
      created_at: new Date().toISOString(),
    };
  }

  return driveTurn(adapter, provider, nativeId, text, () => adapter.startTurn({ sessionId: nativeId, input: text, attachments }), hub);
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
): Promise<Record<string, unknown>> {
  const sid = prefixedId(provider, nativeId);
  const turn = newActiveTurn(nativeId, promptId);
  hub.busy.set(sid, turn);
  const startedAt = Date.now();
  const emit = (type: string, payload: Record<string, unknown>, volatile = false): void =>
    hub.broadcast(sid, frame(sid, hub, type, payload, volatile));

  // 事件序列对齐 kap-server:前端 agentEventProjector 只认这组帧。
  emit('session.meta.updated', { patch: { lastPrompt: text } });
  emit('event.session.work_changed', { busy: true, main_turn_active: true, pending_interaction: 'none' });
  emit('turn.started', { turnId: 0, origin: { kind: 'user' }, prompt: text });

  const handle = await acquire().catch((err) => {
    // startTurn 失败必须清 busy 并广播终态——否则会话永久 409(审查实测)。
    hub.busy.delete(sid);
    emit('turn.ended', { turnId: 0, reason: 'failed', durationMs: Date.now() - startedAt });
    emit('prompt.completed', { promptId, reason: 'failed' });
    emit('event.session.work_changed', { busy: false, main_turn_active: false, pending_interaction: 'none', last_turn_reason: 'failed' });
    // 队列里还有等着的 prompt:busy 已清,接力给下一个(审查实测会卡死)。
    drainQueue(adapter, provider, nativeId, hub);
    throw err;
  });
  turn.turnId = handle.turnId;

  // abort 在 acquire 窗口(turnId 还没拿到)到达:abortTurn 已广播终态,
  // 这里用真实 turnId 补一刀 interrupt,然后直接返回,不消费事件流。
  if (turn.cancelled) {
    await adapter.interrupt(nativeId, handle.turnId).catch(() => undefined);
    return {
      prompt_id: promptId,
      user_message_id: promptId,
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
      emit('turn.step.started', { turnId: 0, step });
      stepActive = true;
    }
  };
  const completeStep = (): void => {
    if (stepActive) {
      emit('turn.step.completed', { turnId: 0, step, usage: {} });
      stepActive = false;
      step += 1;
    }
  };

  // 后台消费事件流:累积文本 + 广播 WS + 清理忙态。
  void (async () => {
    let reason: 'completed' | 'failed' = 'completed';
    try {
      for await (const ev of handle.events) {
        // 已被 abort/被新 turn 取代:残余事件直接丢弃,不串扰新 turn 的 UI。
        if (hub.busy.get(sid) !== turn) break;
        // 适配器层的失败(如 CLI 无 result 退出)以 turn/failed 事件上来,
        // 必须传导到终态,否则 UI 显示假成功。
        if (ev.kind === 'turn' && ev.status === 'failed') reason = 'failed';
        consumeEvent(ev, turn, emit, ensureStep, completeStep, sid);
      }
    } catch {
      reason = 'failed';
    } finally {
      completeStep();
      // 只有自己仍是当前 turn 时才清理+广播终态。abort 路径由 abortTurn
      // 广播;若新 turn 已占位,旧流静默退出,避免误删新 turn 的 busy。
      if (hub.busy.get(sid) === turn) {
        hub.busy.delete(sid);
        const durationMs = Date.now() - startedAt;
        emit('turn.ended', { turnId: 0, reason, durationMs });
        emit('prompt.completed', { promptId, reason });
        const pending = turn.pendingApprovals.size > 0 ? 'approval' : turn.pendingQuestions.size > 0 ? 'question' : 'none';
        emit('event.session.work_changed', { busy: false, main_turn_active: false, pending_interaction: pending, last_turn_reason: reason });
        // 接力:队列里的下一个 prompt 作为自己的 turn 启动(kap-server 语义)。
        drainQueue(adapter, provider, nativeId, hub);
        // 终态广播后的收尾钩子(:compact 的 completed 帧在这发,时机对齐
        // kap-server 的 worker 尾部)。
        onSettled?.(reason);
      }
    }
  })();

  return {
    prompt_id: promptId,
    user_message_id: promptId,
    status: 'running',
    content: [{ type: 'text', text }],
    created_at: new Date().toISOString(),
  };
}

/**
 * 排空会话队列:busy 已清时取队首开新 turn;startTurn 失败继续取下一个,
 * 直到队列空或某个 turn 成功起跑(它的终态会再次调本函数接力)。
 * 审查实测:任何一个排队 prompt 启动失败都会让后续全部永久卡住。
 */
function drainQueue(adapter: ProviderAdapter, provider: ProviderName, nativeId: string, hub: SessionHub): void {
  const sid = prefixedId(provider, nativeId);
  if (hub.busy.has(sid)) return;
  const next = hub.queued.get(sid)?.shift();
  if (!next) return;
  if ((hub.queued.get(sid)?.length ?? 0) === 0) hub.queued.delete(sid);
  void driveTurn(adapter, provider, nativeId, next.text, () => adapter.startTurn({ sessionId: nativeId, input: next.text, attachments: next.attachments }), hub, next.promptId)
    .catch((err: unknown) => {
      console.error('[gateway] 队列 prompt 接力失败:', err instanceof Error ? err.message : err);
      drainQueue(adapter, provider, nativeId, hub);
    });
}

/**
 * codex 网关代执行命令(非 turn 类):执行 RPC,把结果以一轮"系统消息"
 * (起手帧 + assistant.delta + 终态帧)广播给订阅者。不与 busy 互斥——
 * 这些 RPC 与进行中的 turn 独立;turn 进行中投影器会把它显示在同一流里。
 */
async function runCodexLocalCommand(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  name: string,
  argsText: string,
  hub: SessionHub,
): Promise<Record<string, unknown>> {
  const sid = prefixedId(provider, nativeId);
  const promptId = randomUUID();
  const promptText = `/${name}${argsText ? ` ${argsText}` : ''}`;
  const emit = (type: string, payload: Record<string, unknown>, volatile = false): void =>
    hub.broadcast(sid, frame(sid, hub, type, payload, volatile));
  const startedAt = Date.now();
  emit('turn.started', { turnId: 0, origin: { kind: 'user' }, prompt: promptText });
  let output: string;
  let reason: 'completed' | 'failed' = 'completed';
  try {
    output = await executeCodexCommand(adapter, nativeId, name);
  } catch (err) {
    reason = 'failed';
    output = `✗ ${promptText} 执行失败:${err instanceof Error ? err.message : String(err)}`;
  }
  // 投影器的 assistant.delta 要求 currentAssistantMsgId 已存在,而它只由
  // turn.step.started 创建(审查实测:缺这一帧命令输出被静默丢弃,kap-server
  // 原版也是 step.started 先于该 step 全部 delta)。
  emit('turn.step.started', { turnId: 0, step: 0 });
  emit('assistant.delta', { turnId: 0, delta: output }, true);
  emit('turn.step.completed', { turnId: 0, step: 0, usage: {} });
  emit('turn.ended', { turnId: 0, reason, durationMs: Date.now() - startedAt });
  emit('prompt.completed', { promptId, reason });
  return {
    prompt_id: promptId,
    user_message_id: promptId,
    status: 'completed',
    content: [{ type: 'text', text: promptText }],
    created_at: new Date().toISOString(),
  };
}

/** codex 代执行命令 → RPC 映射,返回给用户的输出文本。 */
async function executeCodexCommand(adapter: ProviderAdapter, nativeId: string, name: string): Promise<string> {
  switch (name) {
    case 'compact':
      await adapter.compact!(nativeId);
      return '✓ 已发起上下文压缩(thread/compact/start)。';
    case 'undo':
      await adapter.rollback!(nativeId, 1);
      return '✓ 已回滚最近 1 个 turn(thread/rollback)。';
    case 'fork': {
      const s = await adapter.fork!(nativeId);
      return `⑂ 已分叉新会话:「${s.title}」\nID:${prefixedId('codex', s.id)}\n刷新会话列表后可见。`;
    }
    case 'status':
      return renderCodexStatus(adapter, nativeId);
    case 'usage':
      return renderCodexUsage(adapter, nativeId);
    case 'mcp':
      return renderMcpServers(await adapter.listMcpServers!(nativeId).catch(() => []));
    default:
      throw new ProviderError('invalid_request', `unknown gateway command /${name}`, 400);
  }
}

function renderCodexStatus(adapter: ProviderAdapter, nativeId: string): string {
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
  return lines.join('\n');
}

function renderCodexUsage(adapter: ProviderAdapter, nativeId: string): string {
  const u = adapter.getUsage?.(nativeId);
  if (!u || (u.input_tokens === 0 && u.output_tokens === 0)) return '∑ 暂无用量数据(完成一轮对话后可见)。';
  return [
    '∑ 用量统计(本会话累计)',
    `· 输入 tokens:${u.input_tokens.toLocaleString()}`,
    `· 输出 tokens:${u.output_tokens.toLocaleString()}`,
    `· 缓存读:${u.cache_read_tokens.toLocaleString()} · 缓存写:${u.cache_creation_tokens.toLocaleString()}`,
  ].join('\n');
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
  };
}

type Emit = (type: string, payload: Record<string, unknown>, volatile?: boolean) => void;

function consumeEvent(
  ev: GatewayEvent,
  turn: ActiveTurn,
  emit: Emit,
  ensureStep: () => void,
  completeStep: () => void,
  sid: string,
): void {
  if (ev.kind === 'message' && ev.status === 'delta') {
    const delta = (ev.payload as { delta?: string }).delta ?? '';
    if (!delta) return;
    ensureStep();
    turn.assistantText += delta;
    emit('assistant.delta', { turnId: 0, delta }, true);
  } else if (ev.kind === 'thinking' && ev.status === 'delta') {
    const delta = (ev.payload as { delta?: string }).delta ?? '';
    if (!delta) return;
    ensureStep();
    turn.thinkingText += delta;
    emit('thinking.delta', { turnId: 0, delta }, true);
  } else if (ev.kind === 'tool') {
    const p = ev.payload as { toolCallId: string; name: string; input?: unknown; output?: string; isError?: boolean; is_error?: boolean };
    if (ev.status === 'started') {
      ensureStep();
      turn.runningTools.set(p.toolCallId, { name: p.name, args: p.input });
      emit('tool.call.started', { turnId: 0, toolCallId: p.toolCallId, name: p.name, args: p.input ?? {} });
    } else {
      turn.runningTools.delete(p.toolCallId);
      // 适配器层统一用 snake_case(审查发现 camel 读取落空,失败被投影为成功)。
      emit('tool.result', { turnId: 0, toolCallId: p.toolCallId, output: p.output ?? '', isError: p.isError ?? p.is_error ?? false });
      // 前端在 tool.result 后重置 assistant 跟踪 —— 一个 step 到此为止。
      completeStep();
    }
  } else if (ev.kind === 'approval') {
    const p = ev.payload as { approvalId: string; tool: string; input?: unknown; itemId?: string };
    turn.pendingApprovals.set(p.approvalId, { tool: p.tool, input: p.input, itemId: p.itemId });
    emit('event.approval.requested', approvalDto(sid, p.approvalId, turn));
    emit('event.session.work_changed', { busy: true, main_turn_active: true, pending_interaction: 'approval' });
  } else if (ev.kind === 'question') {
    const p = ev.payload as { questionId: string; prompt: string; rawQuestions?: unknown[] };
    turn.pendingQuestions.set(p.questionId, { prompt: p.prompt, rawQuestions: p.rawQuestions });
    emit('event.question.requested', questionDto(sid, p.questionId, { prompt: p.prompt, rawQuestions: p.rawQuestions }));
    emit('event.session.work_changed', { busy: true, main_turn_active: true, pending_interaction: 'question' });
  } else if (ev.kind === 'turn') {
    // 终态由 submitPrompt 的 finally 统一广播。
  }
}

/**
 * 中止当前 turn。返回是否真的中止了一个活动 turn——无活动时调用方应如实
 * 回 aborted:false,而不是谎称成功。帧序:turn.ended → prompt.aborted →
 * work_changed(前端投影器按 promptId 清 in-flight 状态,顺序敏感)。
 */
async function abortTurn(adapter: ProviderAdapter, provider: ProviderName, nativeId: string, hub: SessionHub): Promise<boolean> {
  const sid = prefixedId(provider, nativeId);
  const active = hub.busy.get(sid);
  if (!active) return false;
  // 先置位:若 turnId 还没拿到(acquire 窗口),driveTurn 会补 interrupt。
  active.cancelled = true;
  await adapter.interrupt(nativeId, active.turnId || undefined);
  hub.busy.delete(sid);
  // 事件流循环发现占位消失后会静默退出(见 driveTurn 的 break),终态在
  // 此广播,前端才能从 busy 恢复。
  hub.broadcast(sid, frame(sid, hub, 'turn.ended', { turnId: 0, reason: 'cancelled', durationMs: 0 }));
  hub.broadcast(sid, frame(sid, hub, 'prompt.aborted', { promptId: active.promptId, abortedAt: new Date().toISOString() }));
  hub.broadcast(sid, frame(sid, hub, 'event.session.work_changed', { busy: false, main_turn_active: false, pending_interaction: 'none', last_turn_reason: 'cancelled' }));
  // 被取消 turn 后面可能还有排队 prompt,接力。
  drainQueue(adapter, provider, nativeId, hub);
  return true;
}

// ---------------------------------------------------------------------------
// approvals / questions
// ---------------------------------------------------------------------------

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
    return {
      id: String(q.id ?? `q_${i}`),
      question: String(q.question ?? q.header ?? ''),
      ...(typeof q.header === 'string' ? { header: q.header } : {}),
      options,
      ...(q.multiSelect === true || q.multi_select === true ? { multi_select: true } : {}),
      ...(q.isOther === true || q.allow_other === true ? { allow_other: true } : {}),
    };
  });
}

async function resolveApproval(
  adapter: ProviderAdapter,
  provider: ProviderName,
  nativeId: string,
  approvalId: string,
  body: { decision: string; scope?: string },
  hub: SessionHub,
): Promise<void> {
  // 前端"允许本次会话"带 scope:'session'(ApprovalCard.vue),映射 approve_always
  // → codex acceptForSession;此前网关只读 decision,该按钮实际只放行单次(审查发现)。
  const base = body.decision === 'approved' ? 'approve' : 'reject';
  const decision = base === 'approve' && body.scope === 'session' ? 'approve_always' : base;
  await adapter.resolveApproval(nativeId, approvalId, decision);
  const sid = prefixedId(provider, nativeId);
  const active = hub.busy.get(sid);
  active?.pendingApprovals.delete(approvalId);
  hub.broadcast(sid, frame(sid, hub, 'event.approval.resolved', {
    approval_id: approvalId,
    decision: body.decision,
    resolved_by: 'user',
    resolved_at: new Date().toISOString(),
  }));
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
  // 结构化答案(WireQuestionAnswer 按 question id 键控)→ codex 的
  // {questionId: string[]};纯文本退回字符串(adapter 包装成 q_0)。
  let payload: string | Record<string, string[]>;
  if (body.answers && Object.keys(body.answers).length > 0) {
    const out: Record<string, string[]> = {};
    for (const [qid, ans] of Object.entries(body.answers)) out[qid] = wireAnswerStrings(ans);
    payload = out;
  } else {
    payload = body.text ?? '';
  }
  await adapter.resolveQuestion(nativeId, questionId, payload);
  const sid = prefixedId(provider, nativeId);
  const active = hub.busy.get(sid);
  active?.pendingQuestions.delete(questionId);
  // 帧名对齐 kap-server:前端 projector 只认 event.question.answered/dismissed,
  // 发 resolved 会落进 "Unhandled event"(审查实测)。
  hub.broadcast(sid, frame(sid, hub, 'event.question.answered', {
    question_id: questionId,
    answers: body.answers ?? {},
    resolved_by: 'user',
    resolved_at: new Date().toISOString(),
  }));
  const pending = (active?.pendingApprovals.size ?? 0) > 0 ? 'approval' : (active?.pendingQuestions.size ?? 0) > 0 ? 'question' : 'none';
  hub.broadcast(sid, frame(sid, hub, 'event.session.work_changed', { busy: active !== undefined, main_turn_active: active !== undefined, pending_interaction: pending }));
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

function frame(sessionId: string, hub: SessionHub, type: string, payload: unknown, volatile = false): Record<string, unknown> {
  return {
    type,
    seq: hub.nextSeq(),
    epoch: hub.epoch,
    volatile,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    payload: { ...(payload as Record<string, unknown>), sessionId, agentId: 'main' },
  };
}

function attachGatewayWebSocket(
  server: ReturnType<typeof createServer>,
  token: string,
  hub: SessionHub,
  kimi: KimiUpstream | null,
  gatewaySockets: Set<Duplex>,
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
    // 握手:回显客户端提供的子协议(里面是网关 token,与上游 token 无关)。
    const proto = req.headers['sec-websocket-protocol'];
    const acceptKey = wsAccept(req.headers['sec-websocket-key'] as string);
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
    ];
    if (proto) headers.push(`Sec-WebSocket-Protocol: ${proto}`);
    socket.write(headers.concat('\r\n').join('\r\n'));
    gatewaySockets.add(socket);

    const sendObj = (obj: Record<string, unknown>): void => {
      if (!socket.destroyed) wsSendText(socket, JSON.stringify(obj));
    };
    const sendRaw = (text: string): void => {
      if (!socket.destroyed) wsSendText(socket, text);
    };
    sendObj({
      type: 'server_hello',
      timestamp: new Date().toISOString(),
      payload: {
        server_id: 'multi-agent-gateway',
        max_event_buffer_size: 1000,
        capabilities: { event_batching: false, compression: false },
      },
    });

    // ---- 上游(Kimi kap-server)WS relay:懒连接,按订阅转发 ----
    let upstream: WebSocket | null = null;
    let upstreamOpen = false;
    const upstreamQueue: string[] = [];
    const sendUpstream = (frame: Record<string, unknown>): void => {
      if (!kimi) return;
      const text = JSON.stringify(frame);
      if (upstream && upstreamOpen) {
        upstream.send(text);
        return;
      }
      upstreamQueue.push(text);
      if (upstream) return; // 正在连接
      const wsUrl = `${kimi.url.replace(/^http/, 'ws')}${API}/ws?client_id=gw_${randomUUID()}`;
      const up = new WebSocket(wsUrl, [`kimi-code.bearer.${kimi.token}`]);
      upstream = up;
      up.onopen = () => {
        upstreamOpen = true;
        for (const queued of upstreamQueue.splice(0)) up.send(queued);
      };
      up.onmessage = (ev: MessageEvent) => {
        const text = String(ev.data);
        try {
          const frame = JSON.parse(text) as { type?: string; payload?: { nonce?: string } };
          // 上游的控制帧(hello/ack)吞掉 —— 客户端只认网关的握手与 ack。
          if (frame.type === 'server_hello' || frame.type === 'ack') return;
          if (frame.type === 'ping') {
            up.send(JSON.stringify({ type: 'pong', payload: { nonce: frame.payload?.nonce ?? '' } }));
            return;
          }
        } catch { /* 非 JSON 也透传 */ }
        sendRaw(text);
      };
      up.onclose = () => {
        // 上游断了:断开客户端,SPA 的重连逻辑会重新订阅,届时再懒连上游。
        socket.destroy();
      };
      up.onerror = () => {
        socket.destroy();
      };
    };

    // ---- 客户端帧处理:按会话 id 前缀拆分订阅 ----
    const localOffs = new Map<string, () => void>();
    const handleFrame = (msg: {
      type?: string;
      id?: string;
      payload?: {
        client_id?: string;
        subscriptions?: string[];
        session_ids?: string[];
        cursors?: Record<string, unknown>;
      };
    }): void => {
      if (msg.type === 'client_hello' || msg.type === 'subscribe') {
        const ids = msg.type === 'client_hello' ? msg.payload?.subscriptions ?? [] : msg.payload?.session_ids ?? [];
        const kimiIds = ids.filter((id) => providerFromSessionId(id).provider === 'kimi');
        const localIds = ids.filter((id) => providerFromSessionId(id).provider !== 'kimi');
        const cursors = msg.payload?.cursors ?? {};
        const pickCursors = (keep: string[]): Record<string, unknown> =>
          Object.fromEntries(Object.entries(cursors).filter(([key]) => keep.includes(key)));
        if (kimiIds.length > 0) {
          sendUpstream(
            msg.type === 'client_hello'
              ? { type: 'client_hello', id: msg.id, payload: { client_id: msg.payload?.client_id ?? 'gateway', subscriptions: kimiIds, cursors: pickCursors(kimiIds) } }
              : { type: 'subscribe', id: msg.id, payload: { session_ids: kimiIds, cursors: pickCursors(kimiIds) } },
          );
        }
        const resyncRequired: { sid: string; reason: 'buffer_overflow' | 'epoch_changed' }[] = [];
        for (const sid of localIds) {
          if (!localOffs.has(sid)) {
            localOffs.set(sid, hub.subscribe(sid, (ev) => sendObj(ev)));
          }
          // 带 cursor 的重连:先订阅再重放缓冲里 cursor 之后的非瞬态帧
          // (先订阅防丢新帧;缓冲有缺口/epoch 不符时发顶层 resync_required
          // 帧——前端 ws.ts 只认这种帧,不认 ack.payload 里的列表)。
          // 前端 cursor 形状是 {seq, epoch}(wire.ts WireSessionCursor),兼容裸数字。
          const raw = cursors[sid] as { seq?: unknown; epoch?: unknown } | number | undefined;
          const cursorSeq = typeof raw === 'number' ? raw : Number(raw?.seq);
          const cursorEpoch = typeof raw === 'object' && raw !== null && typeof raw.epoch === 'string' ? raw.epoch : undefined;
          if (cursorEpoch !== undefined && cursorEpoch !== hub.epoch) {
            resyncRequired.push({ sid, reason: 'epoch_changed' });
          } else if (Number.isFinite(cursorSeq) && cursorSeq > 0) {
            const replayed = hub.replaySince(sid, cursorSeq);
            if (replayed.resync) {
              resyncRequired.push({ sid, reason: 'buffer_overflow' });
            } else {
              for (const f of replayed.frames) sendObj(f);
            }
          }
        }
        // 每个需要 resync 的会话发一条顶层控制帧(前端收到后重拉 snapshot)。
        for (const { sid, reason } of resyncRequired) {
          sendObj({
            type: 'resync_required',
            timestamp: new Date().toISOString(),
            payload: { session_id: sid, reason, current_seq: hub.nextSeq(), epoch: hub.epoch },
          });
        }
        sendObj({ type: 'ack', id: msg.id, code: 0, msg: 'success', payload: { accepted_subscriptions: ids, resync_required: resyncRequired.map((r) => r.sid), cursors: {} } });
        return;
      }
      if (msg.type === 'unsubscribe') {
        const ids = msg.payload?.session_ids ?? [];
        const kimiIds = ids.filter((id) => providerFromSessionId(id).provider === 'kimi');
        if (kimiIds.length > 0) sendUpstream({ type: 'unsubscribe', id: msg.id, payload: { session_ids: kimiIds } });
        for (const sid of ids) {
          localOffs.get(sid)?.();
          localOffs.delete(sid);
        }
        sendObj({ type: 'ack', id: msg.id, code: 0, msg: 'success', payload: {} });
        return;
      }
      // pong / abort(上游 WS abort 是死路,中止走 REST):忽略。
    };

    const parser = new WsFrameParser();
    socket.on('data', (chunk: Buffer) => {
      for (const text of parser.push(chunk)) {
        try {
          handleFrame(JSON.parse(text) as Parameters<typeof handleFrame>[0]);
        } catch { /* 忽略坏帧 */ }
      }
    });
    const cleanup = (): void => {
      gatewaySockets.delete(socket);
      for (const off of localOffs.values()) off();
      localOffs.clear();
      upstream?.close();
      upstream = null;
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}

function wsAccept(key: string): string {
  return createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

/** 发送一个 text WS 帧(服务端→客户端,不掩码)。 */
function wsSendText(socket: NodeJS.WritableStream, text: string): void {
  const payload = Buffer.from(text);
  const len = payload.byteLength;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

/** 带跨 chunk 缓冲的 WS 帧解析器:产出完整 text 帧的字符串。 */
class WsFrameParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: string[] = [];
    for (;;) {
      const frame = this.tryParse();
      if (!frame) break;
      if (frame.fin && frame.opcode === 0x1) out.push(frame.payload.toString('utf8'));
      // close/ping/pong 与分片帧:浏览器侧基本不发,v1 忽略(socket 层兜底)。
    }
    return out;
  }

  private tryParse(): { fin: boolean; opcode: number; payload: Buffer } | null {
    const b = this.buf;
    if (b.byteLength < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.byteLength < 4) return null;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.byteLength < 10) return null;
      len = Number(b.readBigUInt64BE(2));
      offset = 10;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (b.byteLength < offset + len) return null;
    let payload = b.subarray(offset, offset + len);
    if (masked) {
      const mask = b.subarray(maskOffset, maskOffset + 4);
      payload = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]));
    }
    this.buf = b.subarray(offset + len);
    return { fin, opcode, payload };
  }
}

// ---------------------------------------------------------------------------
// 错误码 / 工具
// ---------------------------------------------------------------------------

function codeNumber(code: string): number {
  const map: Record<string, number> = {
    not_found: 40401, invalid_request: 40001, unauthorized: 40101,
    busy: 40901, unsupported: 40001, upstream_error: 50001,
  };
  return map[code] ?? 50001;
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
// codex goal / terminal → kimi wire 映射
// ---------------------------------------------------------------------------

/**
 * codex ThreadGoal(schema 实测:createdAt/objective/status/timeUsedSeconds/
 * tokenBudget/tokensUsed/updatedAt)→ WireGoalSnapshot。codex 无 goalId /
 * turn 预算,goalId 用 threadId 占位,没有的字段回 null/false。
 */
function codexGoalToWire(goal: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!goal) return null;
  const status = String(goal.status ?? 'active');
  const mapped = status === 'usageLimited' || status === 'budgetLimited' ? 'blocked' : status;
  const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    goalId: String(goal.threadId ?? 'goal'),
    objective: String(goal.objective ?? ''),
    status: mapped,
    turnsUsed: 0,
    tokensUsed: numOrNull(goal.tokensUsed) ?? 0,
    wallClockMs: (numOrNull(goal.timeUsedSeconds) ?? 0) * 1000,
    budget: {
      tokenBudget: numOrNull(goal.tokenBudget),
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: status === 'budgetLimited',
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: status === 'budgetLimited' || status === 'usageLimited',
    },
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
// 文件上传(multipart 解析 + 本地存储)
// ---------------------------------------------------------------------------

const UPLOAD_DIR = path.join(process.env.HOME ?? os.homedir(), 'multi-agent-gateway', 'server', 'temp', 'uploads');

interface UploadMeta {
  id: string;
  name: string;
  media_type: string;
  size: number;
  created_at: string;
}

/** 上传元数据(内存态;文件本体在 UPLOAD_DIR,重启后元数据丢失、文件孤儿,可接受——temp 目录)。 */
const uploads = new Map<string, UploadMeta>();

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
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  if (body.byteLength > 25 * 1024 * 1024) {
    throw new ProviderError('invalid_request', 'file too large (25MB max)', 400);
  }
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

async function storeUpload(name: string, mediaType: string, data: Buffer): Promise<UploadMeta> {
  const id = randomUUID();
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.writeFile(path.join(UPLOAD_DIR, id), data);
  const meta: UploadMeta = { id, name, media_type: mediaType, size: data.byteLength, created_at: new Date().toISOString() };
  uploads.set(id, meta);
  return meta;
}

async function readUpload(id: string): Promise<{ data: Buffer; media_type: string } | null> {
  const meta = uploads.get(id);
  // id 只允许 UUID 字符,防目录穿越。
  if (!meta || !/^[\w-]+$/.test(id)) return null;
  try {
    return { data: await fsp.readFile(path.join(UPLOAD_DIR, id)), media_type: meta.media_type };
  } catch {
    return null;
  }
}
