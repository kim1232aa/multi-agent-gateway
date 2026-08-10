/**
 * kimi-child:网关自管的 kap-server 子进程。
 *
 * 为什么不代理用户已在跑的 58627:那个实例的 token 网关拿不到,
 * 代理过去必然 401。网关改为自己 spawn 一个 `kimi web --no-open`
 * (loopback),从它 stdout 的 `Kimi server: ...#token=<tok>` 行解析出
 * token,之后 HTTP 转发时重写 Authorization、WS  relay 时用它建上游连接。
 * 会话存储在 ~/.kimi-code 下,与用户既有实例共享同一份数据。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';

export interface KimiChild {
  /** 例如 http://127.0.0.1:58731 */
  url: string;
  port: number;
  token: string;
  process: ChildProcess;
  close: () => Promise<void>;
}

export interface SpawnKimiOptions {
  /** kimi 二进制路径,默认 ~/.kimi-code/bin/kimi,可用 KIMI_BIN 覆盖。 */
  bin?: string;
  /** 起始端口,默认 58731;被占用时往后试,最多 10 个。 */
  port?: number;
  /** 额外环境变量(合入子进程 env)。 */
  env?: Record<string, string>;
}

const TOKEN_LINE = /#token=([A-Za-z0-9_\-]+)/;

export async function spawnKimiServer(options: SpawnKimiOptions = {}): Promise<KimiChild> {
  const bin = options.bin ?? process.env.KIMI_BIN ?? `${homedir()}/.kimi-code/bin/kimi`;
  const basePort = options.port ?? Number(process.env.KIMI_PORT ?? 58731);

  let lastError: unknown = null;
  for (let port = basePort; port < basePort + 10; port++) {
    try {
      return await trySpawn(bin, port, options.env);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`spawn kimi kap-server failed after 10 ports from ${basePort}: ${String(lastError)}`);
}

function trySpawn(bin: string, port: number, extraEnv?: Record<string, string>): Promise<KimiChild> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['web', '--port', String(port), '--no-open'], {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let token = '';
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`kimi kap-server on port ${port}: timed out waiting for token line`));
      }
    }, 15_000);

    const onData = (chunk: Buffer): void => {
      const match = TOKEN_LINE.exec(chunk.toString('utf8'));
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        token = match[1];
        resolve({
          url: `http://127.0.0.1:${port}`,
          port,
          token,
          process: child,
          close: () =>
            new Promise((done) => {
              child.once('exit', () => done());
              child.kill('SIGTERM');
              // 兜底:3 秒不退就 SIGKILL。
              setTimeout(() => {
                if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
                done();
              }, 3_000).unref();
            }),
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`kimi kap-server exited early (code ${code}) on port ${port}`));
      }
    });
  });
}
