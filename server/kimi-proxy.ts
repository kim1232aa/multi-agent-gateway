/**
 * Kimi 路径的无损代理:把进站的 `/api/v1/*` 与 `/api/v2/*` 请求原样转发到本机原版
 * kap-server(默认 http://127.0.0.1:58627)。
 *
 * 设计要点:
 * - 零依赖,只用 Node 内置模块 + 全局 fetch,方便挂进任意 HTTP 框架。
 *   Fastify 下用 `req.raw` / `reply.raw` 调用 `createKimiHttpProxy()`,
 *   WS 用 `fastify.server.on('upgrade', ...)` 挂 `createKimiWsUpgrader()`;
 *   原生 http.createServer 同理。
 * - HTTP 代理保留 method / 查询串 / 请求头 / 请求体,响应原样回写
 *   (仅剥离逐跳头并把 Host 改写为上游地址,token 走 Authorization 头透传)。
 * - WebSocket `/api/v1/ws` 用 TCP 层隧道转发:把客户端的 Upgrade 请求
 *   (含 `Sec-WebSocket-Protocol: kimi-code.bearer.<token>` 子协议头与
 *   `client_id` 查询串)逐字节重放到上游,之后的帧双向透传,
 *   token 随子协议头自动透传,代理解不出也无需解出任何帧内容。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import type { Duplex } from 'node:stream';

export const DEFAULT_KIMI_UPSTREAM = 'http://127.0.0.1:58627';

export interface KimiProxyOptions {
  /** 上游 kap-server 地址,默认 http://127.0.0.1:58627。 */
  upstream?: string;
  /**
   * 上游 kap-server 的 bearer token。设置后 HTTP 转发会用它重写
   * Authorization 头 —— 网关自己的 token 与上游 token 不同,必须换票。
   */
  upstreamToken?: string;
  /** 网关内部的 provider 分流参数不上游 kap-server。 */
  stripQueryParams?: string[];
}

/** RFC 9110 逐跳头 + 代理由 fetch 自行管理的头,转发时剥离。 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function resolveUpstream(options?: KimiProxyOptions): URL {
  const raw = options?.upstream ?? process.env.KIMI_UPSTREAM_URL ?? DEFAULT_KIMI_UPSTREAM;
  return new URL(raw);
}

/** 请求路径是否属于 kap-server 的 REST 面(`/api/v1` 与 0.36+ `/api/v2`,不含 /ws)。 */
export function isKimiApiPath(url: string | undefined): boolean {
  if (url === undefined) return false;
  const path = url.split('?', 1)[0];
  if (path === '/api/v2' || path.startsWith('/api/v2/')) return true;
  return path === '/api/v1' || (path.startsWith('/api/v1/') && !isKimiWsPath(url));
}

/** 请求路径是否是 kap-server 的 WS 端点。 */
export function isKimiWsPath(url: string | undefined): boolean {
  if (url === undefined) return false;
  const path = url.split('?', 1)[0];
  return path === '/api/v1/ws';
}

// ---------------------------------------------------------------------------
// HTTP 代理
// ---------------------------------------------------------------------------

/**
 * 返回一个 `(req, res) => Promise<boolean>` 处理器:
 * 路径命中 `/api/v1/*` 或 `/api/v2/*` 时转发并返回 true;不命中时不碰响应、返回 false,
 * 让 facade 继续走自己的路由。
 */
export function createKimiHttpProxy(options?: KimiProxyOptions) {
  const upstream = resolveUpstream(options);
  const upstreamAuthority = upstream.host;
  const upstreamToken = options?.upstreamToken;

  return async function proxyKimiHttp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if (!isKimiApiPath(req.url)) return false;

    const target = new URL(req.url ?? '/', upstream);
    for (const name of options?.stripQueryParams ?? []) target.searchParams.delete(name);

    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const value = req.rawHeaders[i + 1];
      const lower = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower)) continue;
      if (lower === 'host' || lower === 'content-length') continue;
      // Host 被改写为上游地址,客户端的 Origin(隧道域名)对上游不再成立;
      // kap-server 会做 Origin 校验,原样透传会被 403 —— 直接剥离,
      // 让上游按非浏览器客户端处理。
      if (lower === 'origin') continue;
      headers.append(name, value);
    }
    headers.set('host', upstreamAuthority);
    // 换票:客户端带的是网关 token,上游只认它自己的 token。
    if (upstreamToken) headers.set('authorization', `Bearer ${upstreamToken}`);
    // 不让上游压缩,避免 fetch 解压后与 content-encoding 头不一致。
    headers.set('accept-encoding', 'identity');

    const method = req.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD';

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(target, {
        method,
        headers,
        body: hasBody ? (req as unknown as RequestInit['body']) : undefined,
        // Node/undici 要求流式请求体声明 half-duplex。
        duplex: hasBody ? 'half' : undefined,
        redirect: 'manual',
      } as RequestInit);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      res.end(
        JSON.stringify({
          code: 50200,
          msg: `kimi upstream unreachable: ${error instanceof Error ? error.message : String(error)}`,
          data: null,
        }),
      );
      return true;
    }

    const responseHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower)) return;
      // body 经 fetch 流式回写,长度/编码头不再可信。
      if (lower === 'content-length' || lower === 'content-encoding') return;
      responseHeaders[name] = value;
    });
    res.writeHead(upstreamRes.status, responseHeaders);

    if (upstreamRes.body === null || method === 'HEAD') {
      res.end();
      return true;
    }
    const bodyStream = Readable.fromWeb(
      upstreamRes.body as import('node:stream/web').ReadableStream,
    );
    bodyStream.on('error', () => res.destroy());
    bodyStream.pipe(res);
    return true;
  };
}

// ---------------------------------------------------------------------------
// WebSocket 代理(TCP 隧道)
// ---------------------------------------------------------------------------

/**
 * 返回一个 Node `http.Server` 的 'upgrade' 事件处理器
 * `(req, socket, head) => boolean`:
 *
 * 命中 `/api/v1/ws` 时,与上游 58627 建立 TCP 连接,把客户端的 Upgrade
 * 请求(请求行 + 原始头 + 已预读的 head 字节)逐字节重放给上游,
 * 随后两个 socket 双向 pipe —— WS 握手响应(101 + 上游选定的
 * `kimi-code.bearer.*` 子协议)和之后所有帧都对客户端无损透传,
 * token 随 `Sec-WebSocket-Protocol` 头自动透传。
 *
 * 不命中时不碰 socket、返回 false,交给 facade 自己的 WS 路由。
 */
export function createKimiWsUpgrader(options?: KimiProxyOptions) {
  const upstream = resolveUpstream(options);
  const upstreamHost = upstream.hostname;
  const upstreamPort = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80));
  const upstreamAuthority = upstream.host;
  const upstreamToken = options?.upstreamToken;

  return function proxyKimiWsUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean {
    if (!isKimiWsPath(req.url)) return false;

    const upstreamSocket = net.connect(upstreamPort, upstreamHost);
    let established = false;

    upstreamSocket.on('connect', () => {
      established = true;
      const target = new URL(req.url ?? '/api/v1/ws', upstream);
      for (const name of options?.stripQueryParams ?? []) target.searchParams.delete(name);
      const lines = [`${req.method ?? 'GET'} ${target.pathname}${target.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const lower = name.toLowerCase();
        // 同 HTTP 路径:剥离 Origin,避免 kap-server 因 Origin/Host 不一致 403。
        if (lower === 'origin') continue;
        if (lower === 'host') {
          lines.push(`${name}: ${upstreamAuthority}`);
        } else if (lower !== 'authorization' || !upstreamToken) {
          lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
        }
      }
      if (upstreamToken) lines.push(`Authorization: Bearer ${upstreamToken}`);
      upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });

    upstreamSocket.on('error', (error) => {
      if (!established) {
        // 上游不可达:按 HTTP 语义回 502 再关闭。
        socket.write(
          'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n' +
            `kimi upstream unreachable: ${error.message}`,
        );
      }
      socket.destroy();
    });
    socket.on('error', () => upstreamSocket.destroy());
    socket.on('close', () => upstreamSocket.destroy());

    return true;
  };
}

/**
 * 便捷封装:把 HTTP 代理与 WS 升级代理一起挂到一个原生 http.Server
 * (或 Fastify 的 `app.server`)上。`fallback` 处理非 `/api/v1` 请求。
 */
export function attachKimiProxy(
  server: import('node:http').Server,
  options?: KimiProxyOptions,
): void {
  const httpProxy = createKimiHttpProxy(options);
  const wsUpgrader = createKimiWsUpgrader(options);

  server.on('request', (req, res) => {
    void httpProxy(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  server.on('upgrade', (req, socket, head) => {
    if (!wsUpgrader(req, socket, head)) {
      socket.destroy();
    }
  });
}
