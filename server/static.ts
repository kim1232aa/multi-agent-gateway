/**
 * static:托管 kimi-web 的构建产物(SPA)。
 *
 * - 只服务 GET/HEAD;API 路径(/api/v1/*)不进入这里。
 * - /assets/* 带内容哈希,长缓存;index.html 不缓存。
 * - 非文件路径(前端路由)回退到 index.html。
 */

import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebShell } from './web-assets.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.riv': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const STATIC_EXTENSIONS = new Set(Object.keys(MIME).filter((ext) => ext !== '.html'));
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

export function createStaticServer(root: string, shell?: WebShell): (req: IncomingMessage, res: ServerResponse) => boolean {
  const indexHtml = join(root, 'index.html');
  const rootNorm = normalize(root);
  const rootReal = realpathSync(rootNorm);
  const isInsideRoot = (candidate: string): boolean => {
    let candidateReal: string;
    try {
      candidateReal = realpathSync(candidate);
    } catch {
      return false;
    }
    const rel = relative(rootReal, candidateReal);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  };
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, SECURITY_HEADERS).end();
      return true;
    }

    const extension = shell?.extensionAsset(pathname);
    if (extension) {
      const headers = { ...SECURITY_HEADERS, 'content-type': extension.contentType, 'cache-control': 'no-cache' };
      if (req.method === 'HEAD') {
        res.writeHead(200, { ...headers, 'content-length': String(extension.body.byteLength) }).end();
      } else {
        res.writeHead(200, headers).end(extension.body);
      }
      return true;
    }

    if (pathname === '/') pathname = '/index.html';

    // 防目录穿越:规范化后必须仍落在 root 内。注意 startsWith 要带路径分隔
    // 符边界,否则 /srv/dist-private 会通过 /srv/dist 的前缀检查(实测可读出
    // root 外的兄弟目录)。realpath 额外拦住 web-dist 内指向外部的符号链接。
    const filePath = normalize(join(rootNorm, pathname));
    if (filePath !== rootNorm && !filePath.startsWith(rootNorm + sep)) {
      res.writeHead(403, SECURITY_HEADERS).end();
      return true;
    }
    const fileExists = existsSync(filePath);
    if (fileExists && !isInsideRoot(filePath)) {
      res.writeHead(403, SECURITY_HEADERS).end();
      return true;
    }

    const isFile = fileExists && statSync(filePath).isFile();
    const requestedExt = extname(pathname).toLowerCase();
    if (!isFile && (pathname.startsWith('/assets/') || STATIC_EXTENSIONS.has(requestedExt))) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return true;
    }
    const target = isFile ? filePath : indexHtml; // SPA fallback
    if (!existsSync(target)) return false;

    const ext = extname(target).toLowerCase();
    const body = target === indexHtml && shell ? shell.indexHtml : null;
    const size = body?.byteLength ?? statSync(target).size;
    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
      'content-type': MIME[ext] ?? 'application/octet-stream',
      // 哈希资产长缓存;index.html 与未命中路径不缓存。
      'cache-control': target.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'content-length': String(size) }).end();
      return true;
    }
    if (body) {
      res.writeHead(200, headers).end(body);
    } else {
      res.writeHead(200, headers);
      const stream = createReadStream(target);
      // 读取中途出错(权限/IO)不能挂着响应:毁掉连接,让客户端如实失败。
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }
    return true;
  };
}

/** 预读 index.html 用不到,但保留一个存在性检查给启动日志。 */
export async function staticRootReady(root: string): Promise<boolean> {
  try {
    await readFile(join(root, 'index.html'));
    return true;
  } catch {
    return false;
  }
}
