/**
 * static:托管 kimi-web 的构建产物(SPA)。
 *
 * - 只服务 GET/HEAD;API 路径(/api/v1/*)不进入这里。
 * - /assets/* 带内容哈希,长缓存;index.html 不缓存。
 * - 非文件路径(前端路由)回退到 index.html。
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

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
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function createStaticServer(root: string): (req: IncomingMessage, res: ServerResponse) => boolean {
  const indexHtml = join(root, 'index.html');
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    // 防目录穿越:规范化后必须仍落在 root 内。注意 startsWith 要带路径分隔
    // 符边界,否则 /srv/dist-private 会通过 /srv/dist 的前缀检查(实测可读出
    // root 外的兄弟目录)。
    const rootNorm = normalize(root);
    const filePath = normalize(join(root, pathname));
    if (filePath !== rootNorm && !filePath.startsWith(rootNorm + '/')) {
      res.writeHead(403).end();
      return true;
    }

    const isFile = existsSync(filePath) && statSync(filePath).isFile();
    const target = isFile ? filePath : indexHtml; // SPA fallback
    if (!existsSync(target)) return false;

    const ext = extname(target).toLowerCase();
    const headers: Record<string, string> = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      // 哈希资产长缓存;index.html 与未命中路径不缓存。
      'cache-control': target.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'content-length': String(statSync(target).size) }).end();
      return true;
    }
    res.writeHead(200, headers);
    createReadStream(target).pipe(res);
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
