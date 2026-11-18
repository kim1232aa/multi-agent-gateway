/**
 * 入口:启动 multi-agent-gateway。
 *
 * 环境变量:
 * - GATEWAY_PORT  监听端口(默认 58629)
 * - GATEWAY_HOST  监听地址(默认 127.0.0.1;Vite 会代理)
 * - GATEWAY_TOKEN 访问 token(未设时生成随机 token 写入 0600 gateway.token,不再使用固定默认口令)
 * - GATEWAY_KIMI  设为 off 时不提供 Kimi 路径(仅 Claude/Codex/Grok/Pi)
 * - STATIC_DIR    kimi-web 构建产物目录(默认仓库 web-dist)
 * - CLAUDE_BIN / GROK_BIN / CODEX_PATH / PI_BIN 各 CLI 二进制覆盖路径
 * - Claude 路径需要 ANTHROPIC_* 环境变量(由调用方注入,网关不内置密钥)。
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGateway } from './gateway.js';
import { KimiProviderSource } from './provider-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.basename(here) === 'dist' ? path.dirname(here) : here;
const repoRoot = path.resolve(serverRoot, '..');
const defaultStaticDir = path.resolve(repoRoot, 'web-dist');

function readManifestVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(path.join(repoRoot, 'web-origin-manifest.json'), 'utf8')) as { version?: unknown };
    if (typeof raw.version === 'string' && raw.version.trim()) return raw.version.trim();
  } catch {
    // fallback below
  }
  return '2.6.2';
}

const port = Number(process.env.GATEWAY_PORT ?? 58629);
const host = process.env.GATEWAY_HOST ?? '127.0.0.1';
const envToken = process.env.GATEWAY_TOKEN?.trim();
const ephemeralToken = envToken ? undefined : randomBytes(24).toString('base64url');
const token = envToken ?? ephemeralToken!;
const staticDir = process.env.STATIC_DIR ?? defaultStaticDir;
const kimi = process.env.GATEWAY_KIMI === 'off' ? 'off' as const : undefined;
const settingsDir = process.env.GATEWAY_SETTINGS_DIR ?? path.join(os.homedir(), '.config', 'multi-agent-gateway');
// 复用 Kimi Code 已配置的供应商(只读);GATEWAY_KIMI_PROVIDERS=off 关闭。
const kimiProviders = (process.env.GATEWAY_KIMI_PROVIDERS ?? 'on').toLowerCase() === 'off' ? null : new KimiProviderSource();

const { url, close, web } = await startGateway({
  port,
  host,
  token,
  staticDir,
  settingsDir,
  kimiProviders,
  ...(kimi ? { kimi } : {}),
});

let tokenFile: string | undefined;
if (ephemeralToken) {
  tokenFile = path.join(settingsDir, 'gateway.token');
  await fsp.mkdir(settingsDir, { recursive: true, mode: 0o700 });
  await fsp.writeFile(tokenFile, `${ephemeralToken}\n`, { mode: 0o600 });
  await fsp.chmod(tokenFile, 0o600).catch(() => undefined);
}

console.log(`multi-agent-gateway listening at ${url}`);
if (envToken) {
  console.log('token: (configured via GATEWAY_TOKEN env)');
  console.log(`前端入口: ${url}/#token=<GATEWAY_TOKEN>`);
} else if (process.stdout.isTTY) {
  console.log(`token: ${token}`);
  console.log(`前端入口: ${url}/#token=${token}`);
} else {
  console.log(`token written to ${tokenFile} (mode 0600)`);
  console.log(`前端入口: ${url} (append #token= from ${tokenFile})`);
}
if (web) {
  const baseline = readManifestVersion();
  console.log(`Kimi Web baseline: ${baseline}, injection=${web.injectionEnabled ? 'enabled' : `disabled (${web.reason})`}`);
}

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
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
