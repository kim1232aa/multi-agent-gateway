/**
 * 入口:启动 multi-agent-gateway。
 *
 * 环境变量:
 * - GATEWAY_PORT  监听端口(默认 58629)
 * - GATEWAY_TOKEN 访问 token(默认 admin123,前端用 #token= 携带)
 * - Claude 路径需要 ANTHROPIC_* 环境变量(由调用方注入,网关不内置密钥)。
 */
import { startGateway } from './gateway.js';

const port = Number(process.env.GATEWAY_PORT ?? 58629);
const token = process.env.GATEWAY_TOKEN ?? 'admin123';
const staticDir = process.env.STATIC_DIR; // kimi-web 构建产物目录

const { url, close, web } = await startGateway({ port, token, staticDir });

console.log(`multi-agent-gateway listening at ${url}`);
console.log(`token: ${token}`);
console.log(`前端入口: ${url}/#token=${token}`);
if (web) {
  console.log(`Kimi Web baseline: 0.33.0 (53c832d), injection=${web.injectionEnabled ? 'enabled' : `disabled (${web.reason})`}`);
}

const shutdown = (): void => {
  void close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
