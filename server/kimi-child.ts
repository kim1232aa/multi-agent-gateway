/**
 * kimi-child:复用唯一的官方 kap-server,没有可确认实例时才自起子进程。
 *
 * Kimi 会把活动 server 登记在 `<KIMI_CODE_HOME>/server/instances/*.json`,
 * 并复用 `<KIMI_CODE_HOME>/server.token`。复用同一个 `/web` 实例才能收到
 * 该 shell 当前 turn 的实时 transcript;多实例时不猜,要求显式选择端口。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface KimiChild {
  /** 例如 http://127.0.0.1:58731 */
  url: string;
  port: number;
  token: string;
  version?: string;
  owned: boolean;
  process?: ChildProcess;
  close: () => Promise<void>;
}

export interface SpawnKimiOptions {
  /** kimi 路径:优先于 KIMI_BIN,默认先找 ~/.kimi-code/bin/kimi,不存在时查 PATH。 */
  bin?: string;
  /** 显式端口只复用同端口实例;否则作为新进程起始端口。 */
  port?: number;
  /** false 时跳过 registry 复用,专门启动网关 standby Core。 */
  reuseRegistered?: boolean;
  /** 额外环境变量;继承环境中的 GATEWAY_* 会先被移除。 */
  env?: Record<string, string>;
}

interface KimiInstance {
  pid: number;
  host: string;
  port: number;
  host_version?: string;
}

const TOKEN_LINE = /#token=([A-Za-z0-9_\-]+)/;

export async function spawnKimiServer(options: SpawnKimiOptions = {}): Promise<KimiChild> {
  const setting = (name: string): string | undefined => options.env?.[name] ?? process.env[name];
  const home = setting('KIMI_CODE_HOME') ?? `${homedir()}/.kimi-code`;
  const explicitUrl = setting('KIMI_UPSTREAM_URL');
  if (explicitUrl) {
    const token = setting('KIMI_UPSTREAM_TOKEN')
      ?? (await readFile(join(home, 'server.token'), 'utf8').catch(() => '')).trim();
    if (!token) throw new Error('KIMI_UPSTREAM_URL requires KIMI_UPSTREAM_TOKEN or a non-empty server.token');
    return connectExisting(explicitUrl, token, 'configured Kimi upstream');
  }

  const requestedPort = options.port ?? numberEnv(setting('KIMI_UPSTREAM_PORT') ?? setting('KIMI_PORT'));
  if (options.reuseRegistered !== false) {
    const reusable = await findReusableServer(home, requestedPort);
    if (reusable) return reusable;
  }

  const defaultBin = join(homedir(), '.kimi-code', 'bin', 'kimi');
  const bin = options.bin ?? setting('KIMI_BIN') ?? (existsSync(defaultBin) ? defaultBin : 'kimi');
  const basePort = requestedPort ?? 58731;
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

/** Prefer a later official `/web` handoff over this gateway's owned fallback. */
export async function followKimiServer(
  current: KimiChild,
  options: SpawnKimiOptions = {},
): Promise<KimiChild> {
  if (!current.owned) return current;
  const setting = (name: string): string | undefined => options.env?.[name] ?? process.env[name];
  if (setting('KIMI_UPSTREAM_URL') || setting('KIMI_UPSTREAM_PORT') || setting('KIMI_PORT')) return current;
  const home = setting('KIMI_CODE_HOME') ?? `${homedir()}/.kimi-code`;
  const ownPid = current.process?.pid;
  return (await findReusableServer(home, undefined, ownPid === undefined ? undefined : new Set([ownPid]))) ?? current;
}

async function findReusableServer(
  home: string,
  requestedPort?: number,
  excludedPids: ReadonlySet<number> = new Set(),
): Promise<KimiChild | null> {
  const dir = join(home, 'server', 'instances');
  const names = await readdir(dir).catch(() => [] as string[]);
  const instances: KimiInstance[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const value = JSON.parse(await readFile(join(dir, name), 'utf8')) as Partial<KimiInstance>;
      if (
        typeof value.pid === 'number' && !excludedPids.has(value.pid) && pidAlive(value.pid) &&
        typeof value.host === 'string' && isLoopback(value.host) &&
        typeof value.port === 'number' && value.port > 0 && value.port <= 65535 &&
        (requestedPort === undefined || value.port === requestedPort)
      ) {
        instances.push(value as KimiInstance);
      }
    } catch {
      // Registry files are atomically replaced; ignore a transient/incomplete read.
    }
  }
  if (instances.length === 0) return null;
  if (instances.length > 1) {
    const ports = instances.map((instance) => instance.port).sort((a, b) => a - b).join(', ');
    throw new Error(`multiple live Kimi servers found on ports ${ports}; set KIMI_PORT to select one`);
  }

  const token = (await readFile(join(home, 'server.token'), 'utf8').catch(() => '')).trim();
  if (!token) throw new Error(`registered Kimi server found but ${join(home, 'server.token')} is missing or empty`);
  const instance = instances[0];
  const host = instance.host.includes(':') ? `[${instance.host}]` : instance.host;
  return connectExisting(
    `http://${host}:${instance.port}`,
    token,
    'registered Kimi server',
    instance.host_version,
  );
}

async function connectExisting(
  rawUrl: string,
  token: string,
  label: string,
  versionHint?: string,
): Promise<KimiChild> {
  const upstream = new URL(rawUrl);
  if (upstream.protocol !== 'http:' || !isLoopback(upstream.hostname)) {
    throw new Error(`${label} must use an http loopback URL`);
  }
  if (upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error(`${label} URL must contain only scheme, loopback host, and port`);
  }
  const url = upstream.origin;
  let version = versionHint;
  try {
    // NODE_USE_ENV_PROXY + HTTP_PROXY 会把 127.0.0.1 打到代理(no_proxy 对 Node fetch
    // 经常无效)。loopback 探测必须走独立 Agent,否则复用本机 kimi web 会误报 unreachable。
    const { status, body } = await loopbackGet(`${url}/api/v1/meta`, {
      authorization: `Bearer ${token}`,
    }, 1_000);
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    const parsed = JSON.parse(body) as { code?: number; data?: { server_version?: unknown } };
    if (parsed.code !== undefined && parsed.code !== 0) throw new Error(`response code ${parsed.code}`);
    if (typeof parsed.data?.server_version === 'string') version = parsed.data.server_version;
  } catch (error) {
    throw new Error(`${label} at ${url} is unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    url,
    port: Number(upstream.port || 80),
    token,
    version,
    owned: false,
    close: async () => {},
  };
}

function loopbackGet(url: string, headers: http.OutgoingHttpHeaders, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.get({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: timeoutMs,
      agent: new http.Agent({ keepAlive: false }),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk as Buffer));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function numberEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function trySpawn(bin: string, port: number, extraEnv?: Record<string, string>): Promise<KimiChild> {
  return new Promise((resolve, reject) => {
    const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GATEWAY_/i.test(key)));
    const child = spawn(bin, ['web', '--port', String(port), '--no-open'], {
      env: { ...inheritedEnv, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`kimi kap-server on port ${port}: timed out waiting for token line`));
      }
    }, 15_000);

    const finish = (token: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        token,
        owned: true,
        process: child,
        close: () =>
          new Promise((done) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              done();
              return;
            }
            child.once('exit', () => done());
            child.kill('SIGTERM');
            setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
              done();
            }, 3_000).unref();
          }),
      });
    };
    const buffers = { stdout: '', stderr: '' };
    const onData = (source: keyof typeof buffers, chunk: Buffer): void => {
      const lines = `${buffers[source]}${chunk.toString('utf8')}`.split(/\r?\n/);
      buffers[source] = lines.pop() ?? '';
      for (const line of lines) {
        const match = TOKEN_LINE.exec(line);
        if (match) finish(match[1]);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => onData('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => onData('stderr', chunk));

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
