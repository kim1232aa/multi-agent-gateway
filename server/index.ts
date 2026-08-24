/**
 * 入口:启动 multi-agent-gateway。
 *
 * 环境变量:
 * - GATEWAY_PORT  监听端口(默认 58629)
 * - GATEWAY_HOST  监听地址(默认 127.0.0.1;Vite 会代理)
 * - GATEWAY_TOKEN 访问 token(默认 admin123,前端用 #token= 携带)
 * - GATEWAY_KIMI  设为 off 时不提供 Kimi 路径(仅 Claude/Codex/Grok)
 * - STATIC_DIR    kimi-web 构建产物目录(默认仓库 web-dist)
 * - Claude 路径需要 ANTHROPIC_* 环境变量(由调用方注入,网关不内置密钥)。
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGateway } from './gateway.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.basename(here) === 'dist' ? path.dirname(here) : here;
const defaultStaticDir = path.resolve(serverRoot, '..', 'web-dist');

const port = Number(process.env.GATEWAY_PORT ?? 58629);
const host = process.env.GATEWAY_HOST ?? '127.0.0.1';
const token = process.env.GATEWAY_TOKEN ?? 'admin123';
const staticDir = process.env.STATIC_DIR ?? defaultStaticDir;
const kimi = process.env.GATEWAY_KIMI === 'off' ? 'off' as const : undefined;

const { url, close, web } = await startGateway({
  port,
  host,
  token,
  staticDir,
  ...(kimi ? { kimi } : {}),
});

console.log(`multi-agent-gateway listening at ${url}`);
console.log(`token: ${token}`);
console.log(`前端入口: ${url}/#token=${token}`);
if (web) {
  console.log(`Kimi Web baseline: 0.38.0, injection=${web.injectionEnabled ? 'enabled' : `disabled (${web.reason})`}`);
}

const shutdown = (): void => {
  // 兜底:close 内部任何一步挂住都不能拖死进程,5s 后硬退。
  const hardExit = setTimeout(() => process.exit(0), 5_000);
  hardExit.unref?.();
  void close()
    .catch(() => undefined)
    .then(() => {
      clearTimeout(hardExit);
      process.exit(0);
    });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
