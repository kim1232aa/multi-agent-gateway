import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { followKimiServer, spawnKimiServer, type KimiChild } from './kimi-child.js';


test('an owned fallback yields to a later registered official Kimi server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-agent-kimi-follow-'));
  const instances = join(root, 'server', 'instances');
  const upstream = createServer((req, res) => {
    if (req.url === '/api/v1/meta' && req.headers.authorization === 'Bearer shared-token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { server_version: '0.34.0' } }));
      return;
    }
    res.writeHead(401).end();
  });
  try {
    await new Promise<void>((resolve) => upstream.listen(0, 'localhost', resolve));
    const address = upstream.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await mkdir(instances, { recursive: true });
    await writeFile(join(root, 'server.token'), 'shared-token\n', { mode: 0o600 });
    await writeFile(join(instances, 'official.json'), JSON.stringify({
      server_id: 'official',
      pid: process.pid,
      host: 'localhost',
      port,
      started_at: Date.now(),
      heartbeat_at: Date.now(),
      host_version: '0.34.0',
    }));
    const fallback = {
      url: 'http://127.0.0.1:59999',
      port: 59999,
      token: 'shared-token',
      owned: true,
      process: { pid: process.pid + 100_000 },
      close: async () => {},
    } as unknown as KimiChild;

    const selected = await followKimiServer(fallback, { env: { KIMI_CODE_HOME: root } });

    assert.equal(selected.url, `http://localhost:${port}`);
    assert.equal(selected.owned, false);
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('reuses the only live registered Kimi server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-agent-kimi-reuse-'));
  const instances = join(root, 'server', 'instances');
  const fakeKimi = join(root, 'kimi');
  const upstream = createServer((req, res) => {
    if (req.url === '/api/v1/meta' && req.headers.authorization === 'Bearer reused-token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, msg: 'success', data: { server_id: 'registered' } }));
      return;
    }
    res.writeHead(401).end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, 'localhost', resolve));
  const address = upstream.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await mkdir(instances, { recursive: true });
  await writeFile(join(root, 'server.token'), 'reused-token\n', { mode: 0o600 });
  await writeFile(join(instances, 'registered.json'), JSON.stringify({
    server_id: 'registered',
    pid: process.pid,
    host: 'localhost',
    port,
    started_at: Date.now(),
    heartbeat_at: Date.now(),
    host_version: '0.34.0',
  }));
  await writeFile(fakeKimi, '#!/bin/sh\nprintf "Kimi server: http://127.0.0.1/#token=spawned-token\\n"\nwhile :; do sleep 1; done\n');
  await chmod(fakeKimi, 0o755);

  const previousHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = root;
  let child: Awaited<ReturnType<typeof spawnKimiServer>> | undefined;
  try {
    child = await spawnKimiServer({ bin: fakeKimi });
    assert.equal(child.url, `http://localhost:${port}`);
    assert.equal(child.token, 'reused-token');
    assert.equal(child.owned, false);
    await child.close();
    const response = await fetch(`${child.url}/api/v1/meta`, {
      headers: { authorization: `Bearer ${child.token}` },
    });
    assert.equal(response.status, 200);
  } finally {
    await child?.close();
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('uses an explicit loopback Kimi URL and reports its version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-agent-kimi-url-'));
  const upstream = createServer((req, res) => {
    if (req.url === '/api/v1/meta' && req.headers.authorization === 'Bearer explicit-token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { server_version: '0.34.0' } }));
      return;
    }
    res.writeHead(401).end();
  });
  try {
    await new Promise<void>((resolve) => upstream.listen(0, 'localhost', resolve));
    const address = upstream.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const child = await spawnKimiServer({
      bin: join(root, 'must-not-spawn'),
      env: {
        KIMI_CODE_HOME: root,
        KIMI_UPSTREAM_URL: `http://localhost:${port}`,
        KIMI_UPSTREAM_TOKEN: 'explicit-token',
      },
    });

    assert.equal(child.url, `http://localhost:${port}`);
    assert.equal(child.token, 'explicit-token');
    assert.equal(child.version, '0.34.0');
    assert.equal(child.owned, false);
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an unreachable registered Kimi server instead of silently spawning another core', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-agent-kimi-unreachable-'));
  const instances = join(root, 'server', 'instances');
  const portHolder = createServer();
  try {
    await new Promise<void>((resolve) => portHolder.listen(0, 'localhost', resolve));
    const address = portHolder.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise<void>((resolve) => portHolder.close(() => resolve()));
    await mkdir(instances, { recursive: true });
    await writeFile(join(root, 'server.token'), 'registered-token\n', { mode: 0o600 });
    await writeFile(join(instances, 'unreachable.json'), JSON.stringify({
      pid: process.pid,
      host: 'localhost',
      port,
    }));

    await assert.rejects(
      spawnKimiServer({ bin: join(root, 'must-not-spawn'), env: { KIMI_CODE_HOME: root } }),
      /registered Kimi server.*unreachable/i,
    );
  } finally {
    if (portHolder.listening) await new Promise<void>((resolve) => portHolder.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to guess between multiple live registered Kimi servers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-agent-kimi-multiple-'));
  const instances = join(root, 'server', 'instances');
  const servers = [createServer(), createServer()];
  try {
    await mkdir(instances, { recursive: true });
    await writeFile(join(root, 'server.token'), 'shared-token\n', { mode: 0o600 });
    for (let index = 0; index < servers.length; index += 1) {
      const server = servers[index];
      server.on('request', (req, res) => {
        if (req.url === '/api/v1/meta' && req.headers.authorization === 'Bearer shared-token') {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        } else {
          res.writeHead(401).end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      await writeFile(join(instances, `${index}.json`), JSON.stringify({
        pid: process.pid,
        host: 'localhost',
        port,
      }));
    }

    await assert.rejects(
      spawnKimiServer({ env: { KIMI_CODE_HOME: root } }),
      /multiple live Kimi servers.*KIMI_PORT/i,
    );
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await rm(root, { recursive: true, force: true });
  }
});

test('selects the requested registered Kimi port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-agent-kimi-port-'));
  const instances = join(root, 'server', 'instances');
  const servers = [createServer(), createServer()];
  try {
    await mkdir(instances, { recursive: true });
    await writeFile(join(root, 'server.token'), 'shared-token\n', { mode: 0o600 });
    const ports: number[] = [];
    for (let index = 0; index < servers.length; index += 1) {
      const server = servers[index];
      server.on('request', (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
      await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      ports.push(port);
      await writeFile(join(instances, `${index}.json`), JSON.stringify({ pid: process.pid, host: 'localhost', port }));
    }

    const child = await spawnKimiServer({ env: { KIMI_CODE_HOME: root, KIMI_UPSTREAM_PORT: String(ports[1]) } });
    assert.equal(child.port, ports[1]);
    assert.equal(child.owned, false);
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await rm(root, { recursive: true, force: true });
  }
});

test('parses a token line split across child output chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-agent-kimi-token-'));
  const fakeKimi = join(root, 'kimi');
  await writeFile(
    fakeKimi,
    '#!/bin/sh\nprintf "Kimi server: http://127.0.0.1/#token=split"\nsleep 0.05\nprintf "%s\\n" "-token"\nwhile :; do sleep 1; done\n',
  );
  await chmod(fakeKimi, 0o755);
  const child = await spawnKimiServer({
    bin: fakeKimi,
    port: 59932,
    env: { KIMI_CODE_HOME: root },
  });
  try {
    assert.equal(child.token, 'split-token');
  } finally {
    await child.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('force-kills an owned Kimi child that ignores SIGTERM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-agent-kimi-child-'));
  const fakeKimi = join(root, 'kimi');
  await writeFile(fakeKimi, '#!/bin/sh\ntrap "" TERM\nprintf "Kimi server: http://127.0.0.1/#token=test-token\\n"\nwhile :; do sleep 1; done\n');
  await chmod(fakeKimi, 0o755);

  const previousHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = root;
  const child = await spawnKimiServer({ bin: fakeKimi, port: 59931 });
  try {
    assert.equal(child.owned, true);
    await child.close();
    for (let attempt = 0; attempt < 20 && child.process?.signalCode === null; attempt += 1) {
      await delay(25);
    }
    assert.equal(child.process?.signalCode, 'SIGKILL');
  } finally {
    if (child.process && child.process.exitCode === null && child.process.signalCode === null) {
      child.process.kill('SIGKILL');
    }
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
