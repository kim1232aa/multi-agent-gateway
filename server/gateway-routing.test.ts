import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type { ProviderAdapter, ProviderCapabilities, NativeModel, NativeCommand, Session, SessionPage, Message, StartTurnInput, TurnHandle, ApprovalDecision, HistoryQuery, ListSessionsQuery, CreateSessionInput } from './types.js';
import { detectAvailableProviders, startGateway } from './gateway.js';

const capabilities: ProviderCapabilities = { streaming: true, thinking: true, tools: true, approvals: false, questions: false, interrupt: true, history: true };

function fakeAdapter(name: 'claude' | 'codex'): ProviderAdapter {
  const session: Session = {
    id: `${name}-native`, workspace_id: '', title: `${name} test`, created_at: new Date(0).toISOString(), updated_at: new Date().toISOString(), busy: false, metadata: { cwd: '/tmp' }, provider: name,
  };
  const models: NativeModel[] = [{ provider: name, model: `${name}-model`, display_name: `${name} model`, max_context_size: 200000, capabilities: ['thinking'], support_efforts: ['low', 'high'] }];
  const commands: NativeCommand[] = [{ name: 'help', description: 'Help', kind: 'prompt', acceptsInput: false }];
  const sessionModels = new Map<string, string>();
  const sessionThinking = new Map<string, string>();
  const sessionPermission = new Map<string, string>();
  const sessionPlan = new Map<string, boolean>();
  return {
    name, capabilities: () => capabilities,
    list: async (): Promise<SessionPage> => ({ items: [session] }),
    create: async (_input: CreateSessionInput): Promise<Session> => ({ ...session, id: `${name}-created` }),
    getHistory: async (_id: string, _query?: HistoryQuery): Promise<Message[]> => [
      { id: `${name}-m1`, session_id: session.id, role: 'user', content: [{ type: 'text', text: 'one' }], created_at: '2026-01-01T00:00:01.000Z' },
      { id: `${name}-m2`, session_id: session.id, role: 'assistant', content: [{ type: 'text', text: 'two' }], created_at: '2026-01-01T00:00:02.000Z' },
      { id: `${name}-m3`, session_id: session.id, role: 'user', content: [{ type: 'text', text: 'three' }], created_at: '2026-01-01T00:00:03.000Z' },
    ],
    startTurn: async (_input: StartTurnInput): Promise<TurnHandle> => ({ turnId: 'turn', events: (async function* () {})() }),
    interrupt: async () => {},
    resolveApproval: async (_id: string, _approval: string, _decision: ApprovalDecision) => {},
    resolveQuestion: async () => {},
    close: async () => {},
    listModels: async () => models,
    listCommands: async () => commands,
    setModel: async (id: string, value: string) => { sessionModels.set(id, value); },
    getModel: (id: string) => sessionModels.get(id),
    setThinking: async (id: string, value: string) => { sessionThinking.set(id, value); },
    getThinking: (id: string) => sessionThinking.get(id),
    setPermission: async (id: string, value: string) => { sessionPermission.set(id, value); },
    getPermission: (id: string) => sessionPermission.get(id),
    setPlanMode: async (id: string, value: boolean) => { sessionPlan.set(id, value); },
    getPlanMode: (id: string) => sessionPlan.get(id),
    ...(name === 'codex' ? { listSkills: async () => [{ name: 'skill', description: 'Skill', path: '/tmp/SKILL.md', scope: 'user', enabled: true }] } : {}),
  } as ProviderAdapter;
}

async function listen(server: Server): Promise<{ url: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function envelope(data: unknown): string {
  return JSON.stringify({ code: 0, msg: 'success', data, request_id: 'upstream' });
}

function wsAccept(key: string): string {
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function wsTextFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

class ClientWsParser {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): Record<string, unknown>[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const values: Record<string, unknown>[] = [];
    for (;;) {
      if (this.buffer.length < 2) break;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) break;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) break;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) break;
      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.subarray(offset + length);
      values.push(JSON.parse(payload.toString('utf8')) as Record<string, unknown>);
    }
    return values;
  }
}

test('falls back to Kimi for native global routes and keeps non-Kimi config local', async () => {
  const seen: Array<{ method: string; path: string }> = [];
  let upstreamConfigPosts = 0;
  const upstream = await listen(createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://upstream');
    seen.push({ method: req.method ?? 'GET', path: url.pathname });
    if (url.pathname === '/api/v1/config') {
      if (req.method === 'POST') upstreamConfigPosts += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(envelope({ providers: { kimi: { type: 'kimi', has_api_key: true } }, default_provider: 'kimi', default_model: 'kimi-model' }));
      return;
    }
    if (url.pathname.endsWith('/skills')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(envelope({ skills: [{ name: 'kimi-skill', description: 'Kimi skill', path: '/kimi/SKILL.md', source: 'kimi' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(envelope({ upstream: true, path: url.pathname }));
  }));
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: { upstream: upstream.url, token: 'upstream-token' },
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    availableProviders: ['kimi', 'claude', 'codex'],
  });
  const get = (path: string, init: RequestInit = {}) => fetch(`${gateway.url}/api/v1${path}`, { ...init, headers: { authorization: 'Bearer gateway-token', ...(init.headers ?? {}) } });
  try {
    const nativeConfig = await get('/config');
    assert.equal(nativeConfig.status, 200);
    assert.equal((await nativeConfig.json() as any).data.upstream, undefined);
    assert.ok(seen.some((x) => x.path === '/api/v1/config'));

    const skills = await get('/workspaces/wd/skills');
    assert.equal(skills.status, 200);
    assert.equal((await skills.json() as any).data.skills[0].name, 'kimi-skill');

    const unknown = await get('/native-route');
    assert.equal((await unknown.json() as any).data.upstream, true);

    // /meta 不透传:本地合并官方字段 + 实际安装的 provider 列表(选择器靠它过滤)。
    const meta = await get('/meta');
    const metaData = (await meta.json() as any).data;
    assert.deepEqual(metaData.providers, ['kimi', 'claude', 'codex']);
    assert.equal(metaData.upstream, true);
    assert.ok(seen.some((x) => x.path === '/api/v1/meta'));

    const codexConfig = await get('/config?provider=codex');
    const codexData = (await codexConfig.json() as any).data;
    assert.equal(codexData.default_provider, 'codex');
    assert.equal(codexData.providers.codex.default_model, 'codex-model');

    const postConfig = await get('/config?provider=codex', { method: 'POST', body: JSON.stringify({ default_model: 'requested-model' }), headers: { 'content-type': 'application/json' } });
    const postData = (await postConfig.json() as any).data;
    assert.equal(postData.default_model, 'requested-model');
    assert.equal(upstreamConfigPosts, 0);

    const providerSkills = await get('/workspaces/wd/skills?provider=codex');
    const providerSkillData = (await providerSkills.json() as any).data.skills;
    assert.deepEqual(providerSkillData.map((x: any) => x.name).sort(), ['help', 'skill']);

    const sessionSkills = await get('/sessions/codex_codex-native/skills');
    const sessionSkillData = (await sessionSkills.json() as any).data.skills;
    assert.deepEqual(sessionSkillData.map((x: any) => x.name).sort(), ['help', 'skill']);

    const models = await get('/models?provider=claude');
    assert.equal((await models.json() as any).data.items[0].model, 'claude-model');

    // 登录态永远由 Kimi 上游回答:即使 URL 带了 provider=claude/codex,
    // /auth 也必须透传到 Kimi,不能在网关本地伪造各家的 ready 状态
    // (否则模型目录为空时会被前端误显示成"未登录")。
    for (const provider of ['claude', 'codex'] as const) {
      const auth = await get(`/auth?provider=${provider}`);
      assert.equal((await auth.json() as any).data.upstream, true);
    }
    assert.ok(seen.filter((x) => x.path === '/api/v1/auth').length >= 2);

    const created = await get('/sessions?provider=claude', {
      method: 'POST',
      body: JSON.stringify({
        cwd: '/tmp',
        agent_config: { model: 'claude-model', thinking: 'high', permission_mode: 'manual', plan_mode: true },
      }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal((await created.json() as any).data.id, 'claude_claude-created');
    const createdStatus = await get('/sessions/claude_claude-created/status');
    const statusData = (await createdStatus.json() as any).data;
    assert.equal(statusData.model, 'claude-model');
    assert.equal(statusData.thinking_level, 'high');
    assert.equal(statusData.permission, 'manual');
    assert.equal(statusData.plan_mode, true);

    const messages = await get('/sessions/claude_claude-native/messages?page_size=1');
    assert.equal(messages.status, 200);
    const messagePage = (await messages.json() as any).data;
    assert.deepEqual(messagePage.items.map((item: any) => item.id), ['claude-m3']);
    assert.equal(messagePage.has_more, true);

    const older = await get('/sessions/claude_claude-native/messages?before_id=claude-m3');
    assert.deepEqual((await older.json() as any).data.items.map((item: any) => item.id), ['claude-m2', 'claude-m1']);

    const transcript = await get('/sessions/claude_claude-native/transcript?agent_id=main&page_size=20');
    assert.equal(transcript.status, 200);
    const transcriptPage = (await transcript.json() as any).data;
    assert.equal(transcriptPage.agent_id, 'main');
    assert.equal(transcriptPage.has_more, false);
    assert.deepEqual(transcriptPage.items.map((item: any) => item.prompt), ['one', 'three']);
    assert.deepEqual(transcriptPage.items[0].steps[0].frames, [{
      kind: 'text',
      frameId: 'claude-m2.text.0',
      role: 'assistant',
      text: 'two',
    }]);
    assert.deepEqual(transcriptPage.meta, { activity: 'idle' });
    assert.deepEqual(transcriptPage.agents, [{ agentId: 'main', type: 'main' }]);

    const plan = await get('/sessions/claude_claude-native/transcript/plan?agent_id=main');
    assert.equal(plan.status, 200);
    assert.deepEqual((await plan.json() as any).data, { agent_id: 'main', plans: [] });
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('uses provider-native cursors for non-Kimi session pagination', async () => {
  const calls: ListSessionsQuery[] = [];
  const codex = fakeAdapter('codex');
  const makeSession = (id: string, updatedAt: string): Session => ({
    id,
    workspace_id: '',
    title: 'same title',
    created_at: updatedAt,
    updated_at: updatedAt,
    busy: false,
    metadata: { cwd: '/tmp' },
    provider: 'codex',
  });
  codex.list = async (query: ListSessionsQuery = {}): Promise<SessionPage> => {
    calls.push({ ...query });
    if (query.cursor === 'native-page-2') {
      return { items: [makeSession('third', '2026-01-01T00:00:01.000Z')] };
    }
    return {
      items: [
        makeSession('first', '2026-01-01T00:00:03.000Z'),
        makeSession('second', '2026-01-01T00:00:02.000Z'),
      ],
      next_cursor: 'native-page-2',
    };
  };
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: codex as any,
    claude: fakeAdapter('claude') as any,
  });
  const get = (path: string) => fetch(`${gateway.url}/api/v1${path}`, {
    headers: { authorization: 'Bearer gateway-token' },
  });
  try {
    const first = (await (await get('/sessions?provider=codex&page_size=2')).json() as any).data;
    assert.deepEqual(first.items.map((item: any) => item.id), ['codex_first', 'codex_second']);
    assert.equal(first.has_more, true);

    const second = (await (await get('/sessions?provider=codex&page_size=2&before_id=codex_second')).json() as any).data;
    assert.deepEqual(second.items.map((item: any) => item.id), ['codex_third']);
    assert.equal(second.has_more, false);
    assert.equal(calls.some((query) => query.cursor === 'native-page-2'), true);
    assert.equal(calls.some((query) => query.limit === 500), false);
  } finally {
    await gateway.close();
  }
});

test('builds local workspaces across all provider-native pages', async () => {
  const codex = fakeAdapter('codex');
  const calls: ListSessionsQuery[] = [];
  const makeSession = (id: string, cwd: string): Session => ({
    id,
    workspace_id: '',
    title: id,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    busy: false,
    metadata: { cwd },
    provider: 'codex',
  });
  codex.list = async (query: ListSessionsQuery = {}): Promise<SessionPage> => {
    calls.push({ ...query });
    return query.cursor === 'workspace-page-2'
      ? { items: [makeSession('older', '/tmp/older')] }
      : { items: [makeSession('newer', '/tmp/newer')], next_cursor: 'workspace-page-2' };
  };
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: codex as any,
    claude: fakeAdapter('claude') as any,
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/workspaces?provider=codex`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    const roots = (await response.json() as any).data.items.map((workspace: any) => workspace.root).sort();
    assert.deepEqual(roots, ['/tmp/newer', '/tmp/older']);
    assert.equal(calls.some((query) => query.cursor === 'workspace-page-2'), true);
    assert.equal(calls.some((query) => query.limit === 500), false);
  } finally {
    await gateway.close();
  }
});

test('finds an older local session through provider-native pages', async () => {
  const codex = fakeAdapter('codex');
  const calls: ListSessionsQuery[] = [];
  const makeSession = (id: string): Session => ({
    id,
    workspace_id: '',
    title: id,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    busy: false,
    metadata: { cwd: '/tmp' },
    provider: 'codex',
  });
  codex.list = async (query: ListSessionsQuery = {}): Promise<SessionPage> => {
    calls.push({ ...query });
    return query.cursor === 'older-page'
      ? { items: [makeSession('older')] }
      : { items: [makeSession('newer')], next_cursor: 'older-page' };
  };
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: codex as any,
    claude: fakeAdapter('claude') as any,
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/sessions/codex_older`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    const session = (await response.json() as any).data;
    assert.equal(session.id, 'codex_older');
    assert.equal(session.title, 'older');
    assert.equal(calls.some((query) => query.cursor === 'older-page'), true);
    assert.equal(calls.some((query) => query.limit === 500), false);
  } finally {
    await gateway.close();
  }
});

test('forwards explicit Kimi session creation without follow-up mutation', async () => {
  const seen: Array<{ method: string; path: string; search: string; body: unknown }> = [];
  const upstream = await listen(createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://upstream');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    seen.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      search: url.search,
      body: raw.length > 0 ? JSON.parse(raw) : null,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(envelope({ id: 'session_kimi' }));
  }));
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: { upstream: upstream.url, token: 'upstream-token' },
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/sessions?provider=kimi&token=internal`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer gateway-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        metadata: { cwd: '/tmp' },
        agent_config: { model: 'kimi-model', plan_mode: true },
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, [{
      method: 'POST',
      path: '/api/v1/sessions',
      search: '',
      body: {
        metadata: { cwd: '/tmp' },
        agent_config: { model: 'kimi-model', plan_mode: true },
      },
    }]);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('forwards provider-less native Kimi routes to the official upstream', async () => {
  const seen: string[] = [];
  const upstream = await listen(createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://upstream');
    seen.push(`${url.pathname}${url.search}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(envelope({ source: 'upstream', path: url.pathname }));
  }));
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: { upstream: upstream.url, token: 'upstream-token' },
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
  });
  const get = (path: string) => fetch(`${gateway.url}/api/v1${path}`, {
    headers: { authorization: 'Bearer gateway-token' },
  });
  try {
    for (const path of ['/meta', '/fs:home', '/fs:browse?path=%2Ftmp']) {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.equal((await response.json() as any).data.source, 'upstream');
    }
    assert.deepEqual(seen, [
      '/api/v1/meta',
      '/api/v1/fs:home',
      '/api/v1/fs:browse?path=%2Ftmp',
    ]);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('returns to the owned Kimi fallback after an official web server exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-agent-kimi-fallback-'));
  const fakeKimi = join(root, 'kimi');
  const instances = join(root, 'server', 'instances');
  const registry = join(instances, 'official.json');
  await mkdir(instances, { recursive: true });
  await writeFile(join(root, 'server.token'), 'shared-token\n', { mode: 0o600 });
  await writeFile(fakeKimi, `#!/usr/bin/env node
const http = require('node:http');
const index = process.argv.indexOf('--port');
const port = Number(process.argv[index + 1]);
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 0, msg: 'success', data: { source: 'fallback' } }));
});
server.listen(port, '127.0.0.1', () => console.log('Kimi server: http://127.0.0.1:' + port + '/#token=shared-token'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  await chmod(fakeKimi, 0o755);

  const previousHome = process.env.KIMI_CODE_HOME;
  const previousBin = process.env.KIMI_BIN;
  process.env.KIMI_CODE_HOME = root;
  process.env.KIMI_BIN = fakeKimi;
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  let official: Awaited<ReturnType<typeof listen>> | undefined;
  const source = async (): Promise<string | undefined> => {
    const response = await fetch(`${gateway?.url}/api/v1/meta`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    if (!response.ok) return undefined;
    return ((await response.json()) as { data?: { source?: string } }).data?.source;
  };
  const waitForSource = async (expected: string): Promise<void> => {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      if (await source().catch(() => undefined) === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(await source().catch(() => undefined), expected);
  };
  const startOfficial = async (): Promise<void> => {
    official = await listen(createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(envelope({ source: 'official' }));
    }));
    await writeFile(registry, JSON.stringify({
      pid: process.pid,
      host: '127.0.0.1',
      port: Number(new URL(official.url).port),
      host_version: '0.33.0',
    }));
  };

  try {
    gateway = await startGateway({
      port: 0,
      token: 'gateway-token',
      codex: fakeAdapter('codex') as any,
      claude: fakeAdapter('claude') as any,
    });
    await waitForSource('fallback');

    await startOfficial();
    await waitForSource('official');
    await rm(registry);
    await official?.close();
    official = undefined;
    await waitForSource('fallback');

    await startOfficial();
    await waitForSource('official');
    await gateway.close();
    gateway = undefined;
    gateway = await startGateway({
      port: 0,
      token: 'gateway-token',
      codex: fakeAdapter('codex') as any,
      claude: fakeAdapter('claude') as any,
    });
    await waitForSource('official');
    await rm(registry);
    const runningOfficial = official as Awaited<ReturnType<typeof listen>> | undefined;
    await runningOfficial?.close();
    official = undefined;
    await waitForSource('fallback');
  } finally {
    await official?.close();
    await gateway?.close();
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    if (previousBin === undefined) delete process.env.KIMI_BIN;
    else process.env.KIMI_BIN = previousBin;
    await rm(root, { recursive: true, force: true });
  }
});

test('respawns the owned Kimi fallback when the standby process is killed', async () => {
  // 回归:standby kap 崩溃/被杀时,旧实现的 1s follow 只会返回死人(注册表
  // 无候选 → ?? current),代理永远卡在尸体上——前端 kimi WS 502、/auth
  // 掉线弹 WebSocket error。现在 refreshKimi 探死就重走 spawn 自愈。
  const root = await mkdtemp(join(tmpdir(), 'multi-agent-kimi-respawn-'));
  const fakeKimi = join(root, 'kimi');
  await mkdir(join(root, 'server', 'instances'), { recursive: true });
  await writeFile(join(root, 'server.token'), 'shared-token\n', { mode: 0o600 });
  await writeFile(fakeKimi, `#!/usr/bin/env node
const http = require('node:http');
const index = process.argv.indexOf('--port');
const port = Number(process.argv[index + 1]);
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 0, msg: 'success', data: { source: 'fallback' } }));
});
server.listen(port, '127.0.0.1', () => console.log('Kimi server: http://127.0.0.1:' + port + '/#token=shared-token'));
`);
  await chmod(fakeKimi, 0o755);

  const previousHome = process.env.KIMI_CODE_HOME;
  const previousBin = process.env.KIMI_BIN;
  process.env.KIMI_CODE_HOME = root;
  process.env.KIMI_BIN = fakeKimi;
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  const source = async (): Promise<string | undefined> => {
    const response = await fetch(`${gateway?.url}/api/v1/meta`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    if (!response.ok) return undefined;
    return ((await response.json()) as { data?: { source?: string } }).data?.source;
  };
  const waitForSource = async (expected: string, ms = 10_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await source().catch(() => undefined) === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(await source().catch(() => undefined), expected);
  };

  try {
    gateway = await startGateway({
      port: 0,
      token: 'gateway-token',
      codex: fakeAdapter('codex') as any,
      claude: fakeAdapter('claude') as any,
    });
    await waitForSource('fallback');

    // SIGKILL 掉 standby(模拟 kap 崩溃):假二进制路径含唯一 tmp 目录,
    // pgrep -f 不会误匹配其它进程。
    const execFileP = promisify(execFile);
    const { stdout } = await execFileP('pgrep', ['-f', fakeKimi]);
    const pids = stdout.trim().split('\n').filter(Boolean).map(Number);
    assert.ok(pids.length > 0, 'expected a running standby kimi process');
    for (const pid of pids) process.kill(pid, 'SIGKILL');

    // 下一个 1s follow tick 探死 → 重新 spawn → 服务自愈(不允许永久 502)。
    await waitForSource('fallback');
  } finally {
    await gateway?.close();
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    if (previousBin === undefined) delete process.env.KIMI_BIN;
    else process.env.KIMI_BIN = previousBin;
    await rm(root, { recursive: true, force: true });
  }
});

test('snapshot returns only the latest message page and pages older via /messages', async () => {
  // 大会话全量快照=首屏传输/渲染爆炸(实测某 codex 会话 2238 条/1.1MB,
  // 前端像死机)。对齐 kap-server:快照只带最后一页(50)+has_more,
  // 更早的走 /messages?before_id 翻页。
  const codex = fakeAdapter('codex');
  const many: Message[] = Array.from({ length: 120 }, (_, i) => ({
    id: `m${String(i).padStart(3, '0')}`,
    session_id: 'codex-native',
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: `msg ${i}` }],
    created_at: new Date(1_700_000_000_000 + i * 1_000).toISOString(),
  }));
  codex.getHistory = async () => many;
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: codex as any,
    claude: fakeAdapter('claude') as any,
  });
  const get = (path: string) => fetch(`${gateway.url}/api/v1${path}`, {
    headers: { authorization: 'Bearer gateway-token' },
  });
  try {
    const snap = (await (await get('/sessions/codex_codex-native/snapshot')).json() as any).data;
    assert.equal(snap.messages.items.length, 50);
    assert.equal(snap.messages.has_more, true);
    // 快照=时间线最后一页,时间正序。
    assert.equal(snap.messages.items[0].id, 'm070');
    assert.equal(snap.messages.items[49].id, 'm119');

    // 向前翻页:before_id 之前的消息,新的在前。
    const older = (await (await get('/sessions/codex_codex-native/messages?before_id=m070&page_size=50')).json() as any).data;
    assert.equal(older.items.length, 50);
    assert.equal(older.items[0].id, 'm069');
    assert.equal(older.items[49].id, 'm020');
    assert.equal(older.has_more, true);
    const oldest = (await (await get('/sessions/codex_codex-native/messages?before_id=m020&page_size=50')).json() as any).data;
    assert.equal(oldest.items.length, 20);
    assert.equal(oldest.has_more, false);
  } finally {
    await gateway.close();
  }
});

test('tunnels Kimi WebSocket upgrade with upstream authorization and the browser protocol', async () => {
  let upgrade:
    | { path: string; authorization: string | undefined; protocol: string | undefined }
    | undefined;
  const upstreamServer = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  upstreamServer.on('upgrade', (req, socket) => {
    upgrade = {
      path: req.url ?? '',
      authorization: req.headers.authorization,
      protocol: req.headers['sec-websocket-protocol'],
    };
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const protocol = String(req.headers['sec-websocket-protocol'] ?? '');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${wsAccept(key)}`,
      `Sec-WebSocket-Protocol: ${protocol}`,
      '',
      '',
    ].join('\r\n'));
    setTimeout(() => {
      socket.write(wsTextFrame({
        type: 'server_hello',
        timestamp: new Date().toISOString(),
        payload: { server_id: 'official-upstream', protocol_version: 2 },
      }));
    }, 10);
    setTimeout(() => socket.destroy(), 50);
  });
  const upstream = await listen(upstreamServer);
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: { upstream: upstream.url, token: 'upstream-token' },
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
  });
  const frames: Record<string, unknown>[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?client_id=browser&provider=kimi&token=internal`,
        ['kimi-code.bearer.gateway-token'],
      );
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Kimi WebSocket tunnel timed out'));
      }, 1_000);
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'client_hello',
          id: 'hello-1',
          payload: { client_id: 'browser', subscriptions: ['session_kimi'] },
        }));
      };
      ws.onmessage = (event) => {
        frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    assert.deepEqual(upgrade, {
      path: '/api/v1/ws?client_id=browser',
      authorization: 'Bearer upstream-token',
      protocol: 'kimi-code.bearer.gateway-token',
    });
    assert.equal(
      (frames[0]?.payload as { server_id?: string } | undefined)?.server_id,
      'official-upstream',
    );
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('strips Origin on Kimi WebSocket tunnel so kap-server does not 403 the handshake', async () => {
  let upgrade: { origin: string | undefined; host: string | undefined } | undefined;
  const upstreamServer = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  upstreamServer.on('upgrade', (req, socket) => {
    upgrade = { origin: req.headers.origin, host: req.headers.host };
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const protocol = String(req.headers['sec-websocket-protocol'] ?? '');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${wsAccept(key)}`,
      `Sec-WebSocket-Protocol: ${protocol}`,
      '',
      '',
    ].join('\r\n'));
    setTimeout(() => socket.destroy(), 50);
  });
  const upstream = await listen(upstreamServer);
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: { upstream: upstream.url, token: 'upstream-token' },
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
  });
  try {
    const gatewayUrl = new URL(gateway.url);
    // 模拟过 cloudflare 隧道的浏览器握手:Origin 是隧道域名,与上游 Host 不一致。
    const statusLine = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(Number(gatewayUrl.port), '127.0.0.1', () => {
        socket.write([
          'GET /api/v1/ws?client_id=browser&provider=kimi HTTP/1.1',
          `Host: ${gatewayUrl.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Protocol: kimi-code.bearer.gateway-token',
          'Origin: https://kimi.example-tunnel.invalid',
          '',
          '',
        ].join('\r\n'));
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Kimi WebSocket origin-strip handshake timed out'));
      }, 2_000);
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx !== -1) {
          clearTimeout(timer);
          resolve(buf.subarray(0, idx).toString().split('\r\n')[0]);
          socket.destroy();
        }
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.equal(statusLine, 'HTTP/1.1 101 Switching Protocols');
    assert.equal(upgrade?.origin, undefined);
    assert.equal(upgrade?.host, new URL(upstream.url).host);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('unsubscribes transcript v2 and resumes legacy content for local providers', async () => {
  const codex = fakeAdapter('codex');
  codex.startTurn = async (): Promise<TurnHandle> => ({
    turnId: 'after-unsubscribe',
    events: (async function* () {
      const base = { sessionId: 'codex-native', turnId: 'after-unsubscribe', timestamp: Date.now() };
      yield { ...base, kind: 'message', status: 'delta', payload: { delta: 'legacy resumed' } } as any;
      yield { ...base, kind: 'turn', status: 'completed', payload: { reason: 'completed' } } as any;
    })(),
  });
  const gateway = await startGateway({
    host: '127.0.0.1', port: 0, token: 'test-token', kimi: 'off',
    codex: codex as any, claude: fakeAdapter('claude') as any,
  });
  const frames: Array<Record<string, any>> = [];
  let ws: WebSocket | undefined;
  let resolveUnsubscribed!: () => void;
  let resolveLegacy!: () => void;
  const unsubscribed = new Promise<void>((resolve) => { resolveUnsubscribed = resolve; });
  const legacySeen = new Promise<void>((resolve) => { resolveLegacy = resolve; });
  try {
    ws = new WebSocket(
      `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`,
      ['kimi-code.bearer.test-token'],
    );
    ws.onopen = () => {
      ws?.send(JSON.stringify({
        type: 'client_hello', id: 'legacy-subscribe',
        payload: { client_id: 'unsubscribe-test', subscriptions: ['codex_codex-native'] },
      }));
      ws?.send(JSON.stringify({
        type: 'subscribe_v2', id: 'subscribe-v2',
        payload: { session_id: 'codex_codex-native', transcript: { '*': 'delta' } },
      }));
      ws?.send(JSON.stringify({
        type: 'unsubscribe_v2', id: 'unsubscribe-v2',
        payload: { session_id: 'codex_codex-native' },
      }));
    };
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, any>;
      frames.push(frame);
      if (frame.type === 'ack' && frame.id === 'unsubscribe-v2') resolveUnsubscribed();
      if (frame.type === 'assistant.delta' && frame.payload.delta === 'legacy resumed') resolveLegacy();
    };
    await Promise.race([
      unsubscribed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('local unsubscribe_v2 timed out')), 1_000)),
    ]);
    const postUnsubscribeIndex = frames.length;
    const response = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'after unsubscribe' }] }),
    });
    assert.equal(response.status, 200);
    await Promise.race([
      legacySeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('legacy content did not resume')), 1_000)),
    ]);

    const subscribeAck = frames.find((frame) => frame.type === 'ack' && frame.id === 'subscribe-v2');
    const unsubscribeAck = frames.find((frame) => frame.type === 'ack' && frame.id === 'unsubscribe-v2');
    assert.deepEqual(subscribeAck?.payload, {
      accepted: ['codex_codex-native'], not_found: [], resync_required: [], cursors: {},
    });
    assert.deepEqual(unsubscribeAck?.payload, {
      accepted: ['codex_codex-native'], not_found: [], resync_required: [],
    });
    assert.equal(frames.slice(postUnsubscribeIndex).some((frame) => frame.type === 'transcript.ops'), false);
  } finally {
    ws?.close();
    await gateway.close();
  }
});

test('streams local assistant deltas with official offsets reset for each step', async () => {
  const codex = fakeAdapter('codex');
  codex.startTurn = async (): Promise<TurnHandle> => ({
    turnId: 'stream-turn',
    events: (async function* () {
      const base = { sessionId: 'codex-native', turnId: 'stream-turn', timestamp: Date.now() };
      yield { ...base, kind: 'thinking', status: 'delta', payload: { delta: 'abc' } } as any;
      yield { ...base, kind: 'message', status: 'delta', payload: { delta: 'Hello' } } as any;
      yield { ...base, kind: 'thinking', status: 'delta', payload: { delta: 'de' } } as any;
      yield { ...base, kind: 'message', status: 'delta', payload: { delta: ' world' } } as any;
      yield { ...base, kind: 'tool', status: 'started', payload: { toolCallId: 'tool-1', name: 'Bash', input: {} } } as any;
      yield { ...base, kind: 'tool', status: 'completed', payload: { toolCallId: 'tool-1', name: 'Bash', output: 'done' } } as any;
      yield { ...base, kind: 'message', status: 'delta', payload: { delta: 'next' } } as any;
      yield { ...base, kind: 'turn', status: 'completed', payload: { reason: 'completed' } } as any;
    })(),
  });
  const gateway = await startGateway({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    kimi: 'off',
    codex: codex as any,
    claude: fakeAdapter('claude') as any,
  });
  const frames: Array<Record<string, any>> = [];
  let ws: WebSocket | undefined;
  let resolveSubscribed!: () => void;
  let resolveEnded!: () => void;
  const subscribed = new Promise<void>((resolve) => { resolveSubscribed = resolve; });
  const ended = new Promise<void>((resolve) => { resolveEnded = resolve; });
  try {
    ws = new WebSocket(
      `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`,
      ['kimi-code.bearer.test-token'],
    );
    ws.onopen = () => {
      ws?.send(JSON.stringify({
        type: 'client_hello',
        id: 'stream-subscribe',
        payload: { client_id: 'legacy-test', subscriptions: ['codex_codex-native'] },
      }));
    };
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, any>;
      frames.push(frame);
      if (frame.type === 'ack' && frame.id === 'stream-subscribe') resolveSubscribed();
      if (frame.type === 'turn.ended') resolveEnded();
    };
    await Promise.race([
      subscribed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('local stream subscribe timed out')), 1_000)),
    ]);

    const response = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'stream it' }] }),
    });
    assert.equal(response.status, 200);
    await Promise.race([
      ended,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('local stream turn timed out')), 1_000)),
    ]);

    const deltas = frames.filter((frame) => frame.type === 'assistant.delta');
    assert.deepEqual(deltas.map((frame) => frame.offset), [0, 5, 0]);
    assert.deepEqual(deltas.map((frame) => frame.payload.delta), ['Hello', ' world', 'next']);
    const thinking = frames.filter((frame) => frame.type === 'thinking.delta');
    assert.deepEqual(thinking.map((frame) => frame.offset), [0, 3]);
    assert.deepEqual(thinking.map((frame) => frame.payload.delta), ['abc', 'de']);
  } finally {
    ws?.close();
    await gateway.close();
  }
});

test('streams local turns through transcript v2 without duplicate legacy content', async () => {
  const codex = fakeAdapter('codex');
  codex.startTurn = async (): Promise<TurnHandle> => ({
    turnId: 'transcript-turn',
    events: (async function* () {
      const base = { sessionId: 'codex-native', turnId: 'transcript-turn', timestamp: Date.now() };
      yield { ...base, kind: 'thinking', status: 'delta', payload: { delta: 'abc' } } as any;
      yield { ...base, kind: 'message', status: 'delta', payload: { delta: 'Hello' } } as any;
      yield { ...base, kind: 'message', status: 'delta', payload: { delta: ' world' } } as any;
      yield { ...base, kind: 'tool', status: 'started', payload: { toolCallId: 'tool-1', name: 'Bash', input: { command: 'pwd' } } } as any;
      yield { ...base, kind: 'approval', status: 'started', payload: { approvalId: 'approval-1', tool: 'Bash', input: { command: 'pwd' }, itemId: 'tool-1' } } as any;
      yield { ...base, kind: 'tool', status: 'completed', payload: { toolCallId: 'tool-1', name: 'Bash', output: '/tmp' } } as any;
      yield { ...base, kind: 'message', status: 'delta', payload: { delta: 'next' } } as any;
      yield { ...base, kind: 'turn', status: 'completed', payload: { reason: 'completed' } } as any;
    })(),
  });
  const gateway = await startGateway({
    host: '127.0.0.1', port: 0, token: 'test-token', kimi: 'off',
    codex: codex as any, claude: fakeAdapter('claude') as any,
  });
  const frames: Array<Record<string, any>> = [];
  let ws: WebSocket | undefined;
  let resolveReset!: () => void;
  let resolveCompleted!: () => void;
  const resetSeen = new Promise<void>((resolve) => { resolveReset = resolve; });
  const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
  try {
    ws = new WebSocket(
      `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`,
      ['kimi-code.bearer.test-token'],
    );
    ws.onopen = () => {
      ws?.send(JSON.stringify({
        type: 'client_hello', id: 'hello-v2',
        payload: { client_id: 'transcript-test', subscriptions: ['codex_codex-native'] },
      }));
      ws?.send(JSON.stringify({
        type: 'subscribe_v2', id: 'subscribe-v2-stream',
        payload: { session_id: 'codex_codex-native', transcript: { main: 'delta' } },
      }));
    };
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, any>;
      frames.push(frame);
      if (frame.type === 'transcript.reset') resolveReset();
      if (frame.type === 'transcript.ops' && frame.payload.ops.some((op: any) => op.op === 'turn.upsert' && op.turn.state === 'completed')) {
        resolveCompleted();
      }
    };
    await Promise.race([
      resetSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('transcript reset timed out')), 1_000)),
    ]);

    const response = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'stream v2' }] }),
    });
    assert.equal(response.status, 200);
    const submittedPrompt = (await response.json() as any).data;
    await Promise.race([
      completed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('transcript ops timed out')), 1_000)),
    ]);

    const reset = frames.find((frame) => frame.type === 'transcript.reset');
    assert.equal(reset?.payload.agent_id, 'main');
    assert.equal(reset?.payload.has_more_older, true);
    assert.deepEqual(reset?.payload.snapshot.items, []);
    assert.equal(typeof reset?.payload.seq, 'number');

    const batches = frames.filter((frame) => frame.type === 'transcript.ops');
    const ops = batches.flatMap((frame) => frame.payload.ops);
    assert.ok(ops.some((op: any) => op.op === 'turn.upsert' && op.turn.prompt === 'stream v2' && op.turn.state === 'running'));
    assert.ok(ops.some((op: any) => op.op === 'step.upsert' && op.step.state === 'running'));
    assert.ok(ops.some((op: any) => op.op === 'frame.upsert' && op.frame.kind === 'thinking'));
    assert.ok(ops.some((op: any) => op.op === 'frame.upsert' && op.frame.kind === 'text'));
    assert.ok(ops.some((op: any) => op.op === 'frame.upsert' && op.frame.kind === 'tool' && op.frame.state === 'done'));
    assert.ok(ops.some((op: any) => op.op === 'interaction.upsert'
      && op.interaction.interactionId === 'approval-1'
      && op.interaction.interactionKind === 'approval'
      && op.interaction.state === 'pending'
      && op.interaction.toolCallId === 'tool-1'));
    const appends = ops.filter((op: any) => op.op === 'append');
    assert.deepEqual(appends.filter((op: any) => op.target.frameId.endsWith('.assistant')).map((op: any) => op.offset), [0, 5, 0]);
    assert.deepEqual(appends.filter((op: any) => op.target.frameId.endsWith('.thinking')).map((op: any) => op.offset), [0]);
    assert.ok(ops.some((op: any) => op.op === 'turn.upsert' && op.turn.state === 'completed'));
    assert.ok(ops.some((op: any) => op.op === 'prompt.upsert'
      && op.prompt.promptId === submittedPrompt.prompt_id
      && op.prompt.status === 'running'
      && Array.isArray(op.prompt.content)
      && op.prompt.content[0]?.text === 'stream v2'));
    assert.ok(ops.some((op: any) => op.op === 'prompt.upsert'
      && op.prompt.promptId === submittedPrompt.prompt_id
      && op.prompt.status === 'completed'
      && typeof op.prompt.finishedAt === 'string'));
    assert.deepEqual(batches.map((frame) => frame.payload.seq), batches.map((_, index) => index + 1));
    assert.equal(frames.some((frame) => frame.type === 'turn.started' || frame.type === 'assistant.delta' || frame.type === 'thinking.delta'), false);

    const refreshed = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/transcript?agent_id=main&page_size=20`, {
      headers: { authorization: 'Bearer test-token' },
    });
    const refreshedData = (await refreshed.json() as any).data;
    const liveTurn = refreshedData.items.find((item: any) => item.prompt === 'stream v2');
    assert.equal(liveTurn?.state, 'completed');
    assert.deepEqual(liveTurn?.steps.flatMap((step: any) => step.frames)
      .filter((frame: any) => frame.kind === 'text')
      .map((frame: any) => frame.text), ['Hello world', 'next']);
    assert.equal(liveTurn?.steps.flatMap((step: any) => step.frames)
      .find((frame: any) => frame.toolCallId === 'tool-1')?.state, 'done');
    assert.ok(refreshedData.prompts.some((prompt: any) => prompt.promptId === submittedPrompt.prompt_id
      && prompt.status === 'completed'));
  } finally {
    ws?.close();
    await gateway.close();
  }
});

test('filters transcript v2 operations independently for turn, block, and delta grades', async () => {
  const codex = fakeAdapter('codex');
  codex.startTurn = async (): Promise<TurnHandle> => ({
    turnId: 'graded-turn',
    events: (async function* () {
      const base = { sessionId: 'codex-native', turnId: 'graded-turn', timestamp: Date.now() };
      yield { ...base, kind: 'message', status: 'delta', payload: { delta: 'graded text' } } as any;
      yield { ...base, kind: 'tool', status: 'started', payload: { toolCallId: 'graded-tool', name: 'Bash', input: {} } } as any;
      yield { ...base, kind: 'tool', status: 'completed', payload: { toolCallId: 'graded-tool', name: 'Bash', output: 'done' } } as any;
      yield { ...base, kind: 'turn', status: 'completed', payload: { reason: 'completed' } } as any;
    })(),
  });
  const gateway = await startGateway({
    host: '127.0.0.1', port: 0, token: 'test-token', kimi: 'off',
    codex: codex as any, claude: fakeAdapter('claude') as any,
  });
  const grades = ['turn', 'block', 'delta'] as const;
  const sockets: WebSocket[] = [];
  const frames = new Map<(typeof grades)[number], Array<Record<string, any>>>();
  try {
    const terminals = await Promise.all(grades.map(async (grade) => {
      const seen: Array<Record<string, any>> = [];
      frames.set(grade, seen);
      let resolveReset!: () => void;
      let resolveTerminal!: () => void;
      const reset = new Promise<void>((resolve) => { resolveReset = resolve; });
      const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve; });
      const ws = new WebSocket(
        `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`,
        ['kimi-code.bearer.test-token'],
      );
      sockets.push(ws);
      ws.onopen = () => ws.send(JSON.stringify({
        type: 'subscribe_v2', id: `graded-${grade}`,
        payload: { session_id: 'codex_codex-native', transcript: { main: grade } },
      }));
      ws.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as Record<string, any>;
        seen.push(frame);
        if (frame.type === 'transcript.reset') resolveReset();
        if (frame.type === 'transcript.ops' && frame.payload.ops.some((op: any) =>
          op.op === 'turn.upsert' && op.turn.state === 'completed')) resolveTerminal();
      };
      await Promise.race([
        reset,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${grade} transcript reset timed out`)), 1_000)),
      ]);
      return { terminal };
    }));

    const response = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'grade it' }] }),
    });
    assert.equal(response.status, 200);
    await Promise.race([
      Promise.all(terminals.map(({ terminal }) => terminal)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('graded transcript turn timed out')), 1_000)),
    ]);

    const opsFor = (grade: (typeof grades)[number]) => (frames.get(grade) ?? [])
      .filter((frame) => frame.type === 'transcript.ops')
      .flatMap((frame) => frame.payload.ops);
    const turnOps = opsFor('turn');
    assert.ok(turnOps.some((op: any) => op.op === 'turn.upsert'));
    assert.equal(turnOps.some((op: any) => op.op === 'step.upsert' || op.op === 'frame.upsert' || op.op === 'append'), false);
    const blockOps = opsFor('block');
    assert.ok(blockOps.some((op: any) => op.op === 'step.upsert'));
    assert.ok(blockOps.some((op: any) => op.op === 'frame.upsert'));
    assert.equal(blockOps.some((op: any) => op.op === 'append'), false);
    assert.ok(opsFor('delta').some((op: any) => op.op === 'append'));
  } finally {
    for (const ws of sockets) ws.close();
    await gateway.close();
  }
});

test('replays covered transcript cursors and resets incomplete cursors', async () => {
  const codex = fakeAdapter('codex');
  codex.startTurn = async (): Promise<TurnHandle> => ({
    turnId: 'cursor-turn',
    events: (async function* () {
      const base = { sessionId: 'codex-native', turnId: 'cursor-turn', timestamp: Date.now() };
      for (let index = 0; index < 205; index += 1) {
        yield { ...base, kind: 'message', status: 'delta', payload: { delta: 'x' } } as any;
      }
      yield { ...base, kind: 'turn', status: 'completed', payload: { reason: 'completed' } } as any;
    })(),
  });
  const gateway = await startGateway({
    host: '127.0.0.1', port: 0, token: 'test-token', kimi: 'off',
    codex: codex as any, claude: fakeAdapter('claude') as any,
  });
  const sockets: WebSocket[] = [];
  try {
    const initialFrames: Array<Record<string, any>> = [];
    let resolveReset!: () => void;
    let resolveCompleted!: () => void;
    const resetSeen = new Promise<void>((resolve) => { resolveReset = resolve; });
    const completedSeen = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    const initial = new WebSocket(
      `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`,
      ['kimi-code.bearer.test-token'],
    );
    sockets.push(initial);
    initial.onopen = () => initial.send(JSON.stringify({
      type: 'subscribe_v2', id: 'cursor-initial',
      payload: { session_id: 'codex_codex-native', transcript: { main: 'delta' } },
    }));
    initial.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, any>;
      initialFrames.push(frame);
      if (frame.type === 'transcript.reset') resolveReset();
      if (frame.type === 'transcript.ops' && frame.payload.ops.some((op: any) =>
        op.op === 'prompt.upsert' && op.prompt.status === 'completed')) resolveCompleted();
    };
    await Promise.race([
      resetSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cursor baseline reset timed out')), 1_000)),
    ]);

    const response = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'fill journal' }] }),
    });
    assert.equal(response.status, 200);
    await Promise.race([
      completedSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cursor journal fill timed out')), 1_000)),
    ]);

    const transcript = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/transcript?agent_id=main&page_size=20`, {
      headers: { authorization: 'Bearer test-token' },
    });
    const latest = Number((await transcript.json() as any).data.seq);
    assert.ok(latest > 200);

    const subscribeAt = async (id: string, since: number) => {
      const seen: Array<Record<string, any>> = [];
      const ws = new WebSocket(
        `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`,
        ['kimi-code.bearer.test-token'],
      );
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${id} ack timed out`)), 1_000);
        ws.onopen = () => ws.send(JSON.stringify({
          type: 'subscribe_v2', id,
          payload: {
            session_id: 'codex_codex-native', transcript: { main: 'delta' },
            transcript_since: { main: since },
          },
        }));
        ws.onmessage = (event) => {
          const frame = JSON.parse(String(event.data)) as Record<string, any>;
          seen.push(frame);
          if (frame.type === 'ack' && frame.id === id) {
            clearTimeout(timer);
            resolve();
          }
        };
      });
      return seen;
    };

    const covered = await subscribeAt('cursor-covered', latest - 2);
    assert.equal(covered.some((frame) => frame.type === 'transcript.reset'), false);
    assert.deepEqual(
      covered.filter((frame) => frame.type === 'transcript.ops').map((frame) => frame.payload.seq),
      [latest - 1, latest],
    );
    const current = await subscribeAt('cursor-current', latest);
    assert.equal(current.some((frame) => frame.type === 'transcript.reset' || frame.type === 'transcript.ops'), false);
    const future = await subscribeAt('cursor-future', latest + 1);
    assert.equal(future.some((frame) => frame.type === 'transcript.reset'), true);

    const coveredRest = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/transcript/ops?agent_id=main&since_seq=${latest - 2}`, {
      headers: { authorization: 'Bearer test-token' },
    });
    assert.deepEqual((await coveredRest.json() as any).data.batches.map((batch: any) => batch.seq), [latest - 1, latest]);
    const staleRest = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/transcript/ops?agent_id=main&since_seq=0`, {
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal((await staleRest.json() as any).data.complete, false);
  } finally {
    for (const ws of sockets) ws.close();
    await gateway.close();
  }
});

test('projects Codex local commands into transcript v2', async () => {
  const gateway = await startGateway({
    host: '127.0.0.1', port: 0, token: 'test-token', kimi: 'off',
    codex: fakeAdapter('codex') as any, claude: fakeAdapter('claude') as any,
  });
  const frames: Array<Record<string, any>> = [];
  let ws: WebSocket | undefined;
  let resolveReset!: () => void;
  let resolveCompleted!: () => void;
  const resetSeen = new Promise<void>((resolve) => { resolveReset = resolve; });
  const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
  try {
    ws = new WebSocket(
      `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`,
      ['kimi-code.bearer.test-token'],
    );
    ws.onopen = () => ws?.send(JSON.stringify({
      type: 'subscribe_v2', id: 'command-v2',
      payload: { session_id: 'codex_codex-native', transcript: { main: 'delta' } },
    }));
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, any>;
      frames.push(frame);
      if (frame.type === 'transcript.reset') resolveReset();
      if (frame.type === 'transcript.ops' && frame.payload.ops.some((op: any) =>
        op.op === 'turn.upsert' && op.turn.prompt === '/status' && op.turn.state === 'completed')) {
        resolveCompleted();
      }
    };
    await Promise.race([
      resetSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('command transcript reset timed out')), 1_000)),
    ]);

    const response = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: '/status' }] }),
    });
    assert.equal(response.status, 200);
    const submittedPrompt = (await response.json() as any).data;
    assert.equal(submittedPrompt.status, 'running');
    await Promise.race([
      completed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('command transcript ops timed out')), 1_000)),
    ]);

    const ops = frames.filter((frame) => frame.type === 'transcript.ops')
      .flatMap((frame) => frame.payload.ops);
    assert.ok(ops.some((op: any) => op.op === 'prompt.upsert'
      && op.prompt.promptId === submittedPrompt.prompt_id
      && op.prompt.status === 'completed'));
    assert.ok(ops.some((op: any) => op.op === 'frame.upsert'
      && op.frame.kind === 'text'
      && op.frame.text.includes('Codex 会话状态')));

    const refreshed = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/transcript?agent_id=main&page_size=20`, {
      headers: { authorization: 'Bearer test-token' },
    });
    const refreshedData = (await refreshed.json() as any).data;
    const commandTurn = refreshedData.items.find((item: any) => item.prompt === '/status');
    assert.equal(commandTurn?.state, 'completed');
    assert.ok(commandTurn?.steps.flatMap((step: any) => step.frames)
      .some((frame: any) => frame.kind === 'text' && frame.text.includes('Codex 会话状态')));
  } finally {
    ws?.close();
    await gateway.close();
  }
});

test('projects a queued prompt into transcript v2 while another turn is running', async () => {
  const codex = fakeAdapter('codex');
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let turnOrdinal = 0;
  codex.startTurn = async (input: StartTurnInput): Promise<TurnHandle> => ({
    turnId: `queued-turn-${++turnOrdinal}`,
    events: (async function* () {
      if (input.input === 'first') await firstReleased;
      yield {
        sessionId: 'codex-native', turnId: `queued-turn-${turnOrdinal}`,
        kind: 'turn', status: 'completed', timestamp: Date.now(), payload: { reason: 'completed' },
      } as any;
    })(),
  });
  const gateway = await startGateway({
    host: '127.0.0.1', port: 0, token: 'test-token', kimi: 'off',
    codex: codex as any, claude: fakeAdapter('claude') as any,
  });
  const frames: Array<Record<string, any>> = [];
  let ws: WebSocket | undefined;
  let resolveReset!: () => void;
  let resolveQueued!: () => void;
  let resolveAborted!: () => void;
  const resetSeen = new Promise<void>((resolve) => { resolveReset = resolve; });
  const queuedSeen = new Promise<void>((resolve) => { resolveQueued = resolve; });
  const abortedSeen = new Promise<void>((resolve) => { resolveAborted = resolve; });
  try {
    ws = new WebSocket(
      `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`,
      ['kimi-code.bearer.test-token'],
    );
    ws.onopen = () => ws?.send(JSON.stringify({
      type: 'subscribe_v2', id: 'queued-v2',
      payload: { session_id: 'codex_codex-native', transcript: { main: 'turn' } },
    }));
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, any>;
      frames.push(frame);
      if (frame.type === 'transcript.reset') resolveReset();
      if (frame.type === 'transcript.ops' && frame.payload.ops.some((op: any) =>
        op.op === 'prompt.upsert' && op.prompt.status === 'queued')) resolveQueued();
      if (frame.type === 'transcript.ops' && frame.payload.ops.some((op: any) =>
        op.op === 'prompt.upsert' && op.prompt.status === 'aborted')) resolveAborted();
    };
    await Promise.race([
      resetSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('queued transcript reset timed out')), 1_000)),
    ]);

    const postPrompt = (text: string) => fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text }] }),
    });
    const first = await postPrompt('first');
    const activePrompt = (await first.json() as any).data;
    assert.equal(activePrompt.status, 'running');
    const second = await postPrompt('second');
    const queuedPrompt = (await second.json() as any).data;
    assert.equal(queuedPrompt.status, 'queued');
    await Promise.race([
      queuedSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('queued prompt op timed out')), 1_000)),
    ]);

    const listedResponse = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts`, {
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(listedResponse.status, 200);
    assert.deepEqual((await listedResponse.json() as any).data, {
      active: activePrompt,
      queued: [queuedPrompt],
    });

    const queuedOp = frames.filter((frame) => frame.type === 'transcript.ops')
      .flatMap((frame) => frame.payload.ops)
      .find((op: any) => op.op === 'prompt.upsert' && op.prompt.promptId === queuedPrompt.prompt_id);
    assert.equal(queuedOp?.prompt.status, 'queued');
    assert.equal(queuedOp?.prompt.content[0]?.text, 'second');

    const aborted = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts/${queuedPrompt.prompt_id}:abort`, {
      method: 'POST', headers: { authorization: 'Bearer test-token' },
    });
    assert.equal((await aborted.json() as any).data.aborted, true);
    await Promise.race([
      abortedSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('queued abort op timed out')), 1_000)),
    ]);

    const refreshed = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/transcript?agent_id=main&page_size=20`, {
      headers: { authorization: 'Bearer test-token' },
    });
    const refreshedData = (await refreshed.json() as any).data;
    assert.ok(refreshedData.prompts.some((prompt: any) =>
      prompt.promptId === queuedPrompt.prompt_id && prompt.status === 'aborted'));
  } finally {
    releaseFirst();
    ws?.close();
    await gateway.close();
  }
});

test('settles steered queued prompts without ending the active prompt', async () => {
  const codex = fakeAdapter('codex');
  let releaseTurn!: () => void;
  const released = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const steeredTexts: string[] = [];
  codex.startTurn = async (): Promise<TurnHandle> => ({
    turnId: 'steer-turn',
    events: (async function* () {
      await released;
      yield {
        sessionId: 'codex-native', turnId: 'steer-turn', kind: 'turn',
        status: 'completed', timestamp: Date.now(), payload: { reason: 'completed' },
      } as any;
    })(),
  });
  codex.steer = async (_sessionId: string, _turnId: string, input: string) => { steeredTexts.push(input); };
  const gateway = await startGateway({
    host: '127.0.0.1', port: 0, token: 'test-token', kimi: 'off',
    codex: codex as any, claude: fakeAdapter('claude') as any,
  });
  const frames: Array<Record<string, any>> = [];
  let ws: WebSocket | undefined;
  let resolveReset!: () => void;
  let resolveSteered!: () => void;
  const resetSeen = new Promise<void>((resolve) => { resolveReset = resolve; });
  const steeredSeen = new Promise<void>((resolve) => { resolveSteered = resolve; });
  try {
    ws = new WebSocket(
      `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`,
      ['kimi-code.bearer.test-token'],
    );
    ws.onopen = () => ws?.send(JSON.stringify({
      type: 'subscribe_v2', id: 'steer-v2',
      payload: { session_id: 'codex_codex-native', transcript: { main: 'turn' } },
    }));
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, any>;
      frames.push(frame);
      if (frame.type === 'transcript.reset') resolveReset();
      if (frame.type === 'transcript.ops' && frame.payload.ops.some((op: any) =>
        op.op === 'prompt.upsert' && op.prompt.content?.[0]?.text === 'follow up'
          && op.prompt.status === 'completed' && typeof op.prompt.steeredAt === 'string')) resolveSteered();
    };
    await Promise.race([
      resetSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('steer transcript reset timed out')), 1_000)),
    ]);

    const postPrompt = (text: string) => fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text }] }),
    });
    const activePrompt = (await (await postPrompt('active')).json() as any).data;
    const queuedPrompt = (await (await postPrompt('follow up')).json() as any).data;
    const steer = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts:steer`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt_ids: [queuedPrompt.prompt_id] }),
    });
    assert.deepEqual((await steer.json() as any).data, { steered: true, prompt_ids: [queuedPrompt.prompt_id] });
    assert.deepEqual(steeredTexts, ['follow up']);
    await Promise.race([
      steeredSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('steered prompt op timed out')), 1_000)),
    ]);

    const refreshed = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/transcript?agent_id=main&page_size=20`, {
      headers: { authorization: 'Bearer test-token' },
    });
    const prompts = (await refreshed.json() as any).data.prompts;
    assert.ok(prompts.some((prompt: any) =>
      prompt.promptId === activePrompt.prompt_id && prompt.status === 'running'));
    assert.ok(prompts.some((prompt: any) =>
      prompt.promptId === queuedPrompt.prompt_id && prompt.status === 'completed'
        && typeof prompt.steeredAt === 'string'));
  } finally {
    releaseTurn();
    ws?.close();
    await gateway.close();
  }
});

test('marks the active transcript step failed when a local turn fails', async () => {
  const codex = fakeAdapter('codex');
  codex.startTurn = async (): Promise<TurnHandle> => ({
    turnId: 'failed-turn',
    events: (async function* () {
      const base = { sessionId: 'codex-native', turnId: 'failed-turn', timestamp: Date.now() };
      yield { ...base, kind: 'message', status: 'delta', payload: { delta: 'partial' } } as any;
      yield { ...base, kind: 'turn', status: 'failed', payload: { reason: 'failed' } } as any;
    })(),
  });
  const gateway = await startGateway({
    host: '127.0.0.1', port: 0, token: 'test-token', kimi: 'off',
    codex: codex as any, claude: fakeAdapter('claude') as any,
  });
  const frames: Array<Record<string, any>> = [];
  let ws: WebSocket | undefined;
  let resolveReset!: () => void;
  let resolveFailed!: () => void;
  const resetSeen = new Promise<void>((resolve) => { resolveReset = resolve; });
  const failedSeen = new Promise<void>((resolve) => { resolveFailed = resolve; });
  try {
    ws = new WebSocket(
      `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`,
      ['kimi-code.bearer.test-token'],
    );
    ws.onopen = () => ws?.send(JSON.stringify({
      type: 'subscribe_v2', id: 'failed-v2',
      payload: { session_id: 'codex_codex-native', transcript: { main: 'delta' } },
    }));
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, any>;
      frames.push(frame);
      if (frame.type === 'transcript.reset') resolveReset();
      if (frame.type === 'transcript.ops' && frame.payload.ops.some((op: any) =>
        op.op === 'turn.upsert' && op.turn.state === 'failed')) resolveFailed();
    };
    await Promise.race([
      resetSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('failed transcript reset timed out')), 1_000)),
    ]);

    const response = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'fail it' }] }),
    });
    assert.equal(response.status, 200);
    await Promise.race([
      failedSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('failed transcript turn timed out')), 1_000)),
    ]);

    const ops = frames.filter((frame) => frame.type === 'transcript.ops')
      .flatMap((frame) => frame.payload.ops);
    const stepStates = ops.filter((op: any) => op.op === 'step.upsert').map((op: any) => op.step.state);
    assert.equal(stepStates.at(-1), 'failed');
  } finally {
    ws?.close();
    await gateway.close();
  }
});

test('streams a local turn without reloading transcript history after subscribe_v2', async () => {
  const codex = fakeAdapter('codex');
  let historyCalls = 0;
  let releaseDuplicateHistory!: () => void;
  const duplicateHistoryReleased = new Promise<void>((resolve) => { releaseDuplicateHistory = resolve; });
  let releaseEvents!: () => void;
  const eventsReleased = new Promise<void>((resolve) => { releaseEvents = resolve; });
  codex.getHistory = async () => {
    historyCalls += 1;
    if (historyCalls === 1) return [];
    await duplicateHistoryReleased;
    return [];
  };
  codex.startTurn = async (): Promise<TurnHandle> => ({
    turnId: 'parallel-start-turn',
    events: (async function* () {
      yield {
        sessionId: 'codex-native', turnId: 'parallel-start-turn', kind: 'message',
        status: 'delta', timestamp: Date.now(), payload: { delta: 'first token' },
      } as any;
      await eventsReleased;
      yield {
        sessionId: 'codex-native', turnId: 'parallel-start-turn', kind: 'turn',
        status: 'completed', timestamp: Date.now(), payload: { reason: 'completed' },
      } as any;
    })(),
  });
  const gateway = await startGateway({
    host: '127.0.0.1', port: 0, token: 'test-token', kimi: 'off',
    codex: codex as any, claude: fakeAdapter('claude') as any,
  });
  const frames: Array<Record<string, any>> = [];
  let ws: WebSocket | undefined;
  let responsePromise: Promise<Response> | undefined;
  let resolveReset!: () => void;
  let resolveAppend!: () => void;
  const resetSeen = new Promise<void>((resolve) => { resolveReset = resolve; });
  const appendSeen = new Promise<void>((resolve) => { resolveAppend = resolve; });
  try {
    ws = new WebSocket(
      `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`,
      ['kimi-code.bearer.test-token'],
    );
    ws.onopen = () => ws?.send(JSON.stringify({
      type: 'subscribe_v2', id: 'parallel-v2',
      payload: { session_id: 'codex_codex-native', transcript: { main: 'delta' } },
    }));
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, any>;
      frames.push(frame);
      if (frame.type === 'transcript.reset') resolveReset();
      if (frame.type === 'transcript.ops' && frame.payload.ops.some((op: any) =>
        op.op === 'append' && op.text === 'first token')) resolveAppend();
    };
    await Promise.race([
      resetSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('parallel transcript reset timed out')), 1_000)),
    ]);

    responsePromise = fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'parallel start' }] }),
    });
    await Promise.race([
      appendSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('first transcript token waited for duplicate history')), 250)),
    ]);
    assert.equal(historyCalls, 1);
    const response = await responsePromise;
    assert.equal(response.status, 200);
  } finally {
    releaseDuplicateHistory();
    releaseEvents();
    await responsePromise?.catch(() => undefined);
    ws?.close();
    await gateway.close();
  }
});

test('settles an aborted active prompt in transcript v2', async () => {
  const codex = fakeAdapter('codex');
  let releaseTurn!: () => void;
  const released = new Promise<void>((resolve) => { releaseTurn = resolve; });
  let interrupted = false;
  codex.startTurn = async (): Promise<TurnHandle> => ({
    turnId: 'abort-turn',
    events: (async function* () {
      await released;
      yield {
        sessionId: 'codex-native', turnId: 'abort-turn', kind: 'turn',
        status: 'completed', timestamp: Date.now(), payload: { reason: 'completed' },
      } as any;
    })(),
  });
  codex.interrupt = async () => { interrupted = true; };
  const gateway = await startGateway({
    host: '127.0.0.1', port: 0, token: 'test-token', kimi: 'off',
    codex: codex as any, claude: fakeAdapter('claude') as any,
  });
  const frames: Array<Record<string, any>> = [];
  let ws: WebSocket | undefined;
  let resolveReset!: () => void;
  let resolveAborted!: () => void;
  const resetSeen = new Promise<void>((resolve) => { resolveReset = resolve; });
  const abortedSeen = new Promise<void>((resolve) => { resolveAborted = resolve; });
  try {
    ws = new WebSocket(
      `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`,
      ['kimi-code.bearer.test-token'],
    );
    ws.onopen = () => ws?.send(JSON.stringify({
      type: 'subscribe_v2', id: 'abort-v2',
      payload: { session_id: 'codex_codex-native', transcript: { main: 'turn' } },
    }));
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, any>;
      frames.push(frame);
      if (frame.type === 'transcript.reset') resolveReset();
      if (frame.type === 'transcript.ops' && frame.payload.ops.some((op: any) =>
        op.op === 'prompt.upsert' && op.prompt.status === 'aborted')) resolveAborted();
    };
    await Promise.race([
      resetSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('abort transcript reset timed out')), 1_000)),
    ]);

    const response = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'stop me' }] }),
    });
    const prompt = (await response.json() as any).data;
    const aborted = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts/${prompt.prompt_id}:abort`, {
      method: 'POST', headers: { authorization: 'Bearer test-token' },
    });
    assert.equal((await aborted.json() as any).data.aborted, true);
    assert.equal(interrupted, true);
    await Promise.race([
      abortedSeen,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('aborted prompt op timed out')), 1_000)),
    ]);

    const ops = frames.filter((frame) => frame.type === 'transcript.ops')
      .flatMap((frame) => frame.payload.ops);
    assert.ok(ops.some((op: any) => op.op === 'turn.upsert'
      && op.turn.prompt === 'stop me' && op.turn.state === 'cancelled'));
    assert.ok(ops.some((op: any) => op.op === 'prompt.upsert'
      && op.prompt.promptId === prompt.prompt_id && op.prompt.status === 'aborted'));

    const refreshed = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/transcript?agent_id=main&page_size=20`, {
      headers: { authorization: 'Bearer test-token' },
    });
    const refreshedData = (await refreshed.json() as any).data;
    assert.ok(refreshedData.prompts.some((item: any) =>
      item.promptId === prompt.prompt_id && item.status === 'aborted'));
  } finally {
    releaseTurn();
    ws?.close();
    await gateway.close();
  }
});

test('fans session global events to every local connection without leaking turn content', async () => {
  const codex = fakeAdapter('codex');
  codex.startTurn = async (): Promise<TurnHandle> => ({
    turnId: 'global-turn',
    events: (async function* () {
      const base = { sessionId: 'codex-native', turnId: 'global-turn', timestamp: Date.now() };
      yield { ...base, kind: 'message', status: 'delta', payload: { delta: 'visible only to subscriber' } } as any;
      yield { ...base, kind: 'turn', status: 'completed', payload: { reason: 'completed' } } as any;
    })(),
  });
  const gateway = await startGateway({
    host: '127.0.0.1', port: 0, token: 'test-token', kimi: 'off',
    codex: codex as any, claude: fakeAdapter('claude') as any,
  });
  const subscribedFrames: Array<Record<string, any>> = [];
  const observerFrames: Array<Record<string, any>> = [];
  let subscribedWs: WebSocket | undefined;
  let observerWs: WebSocket | undefined;
  let resolveReady!: () => void;
  let resolveEnded!: () => void;
  let resolveObserverIdle!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const ended = new Promise<void>((resolve) => { resolveEnded = resolve; });
  const observerIdle = new Promise<void>((resolve) => { resolveObserverIdle = resolve; });
  try {
    const wsUrl = `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`;
    observerWs = new WebSocket(wsUrl, ['kimi-code.bearer.test-token']);
    observerWs.onopen = () => resolveReady();
    observerWs.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, any>;
      observerFrames.push(frame);
      if (frame.type === 'event.session.work_changed' && frame.payload.busy === false) resolveObserverIdle();
    };
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('observer WebSocket timed out')), 1_000)),
    ]);

    let resolveSubscribed!: () => void;
    const subscribed = new Promise<void>((resolve) => { resolveSubscribed = resolve; });
    subscribedWs = new WebSocket(wsUrl, ['kimi-code.bearer.test-token']);
    subscribedWs.onopen = () => subscribedWs?.send(JSON.stringify({
      type: 'client_hello', id: 'global-subscribe',
      payload: { client_id: 'global-test', subscriptions: ['codex_codex-native'] },
    }));
    subscribedWs.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, any>;
      subscribedFrames.push(frame);
      if (frame.type === 'ack' && frame.id === 'global-subscribe') resolveSubscribed();
      if (frame.type === 'turn.ended') resolveEnded();
    };
    await Promise.race([
      subscribed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('subscriber WebSocket timed out')), 1_000)),
    ]);

    const response = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'fan out' }] }),
    });
    assert.equal(response.status, 200);
    await Promise.race([
      Promise.all([ended, observerIdle]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('global event fan-out timed out')), 1_000)),
    ]);

    assert.equal(observerFrames.filter((frame) => frame.type === 'event.session.work_changed').length, 2);
    assert.equal(observerFrames.some((frame) => frame.type === 'turn.started' || frame.type === 'assistant.delta'), false);
    assert.equal(subscribedFrames.filter((frame) => frame.type === 'event.session.work_changed').length, 2);
    assert.equal(subscribedFrames.filter((frame) => frame.type === 'assistant.delta').length, 1);
  } finally {
    subscribedWs?.close();
    observerWs?.close();
    await gateway.close();
  }
});

test('acknowledges a local provider WebSocket close frame', async () => {
  const gateway = await startGateway({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
  });
  const ws = new WebSocket(
    `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`,
    ['kimi-code.bearer.test-token'],
  );
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('local WebSocket failed to open'));
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('local WebSocket open timed out')), 1_000)),
    ]);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
    });
    ws.close(1000, 'client complete');
    assert.deepEqual(await Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('local WebSocket close timed out')), 1_000)),
    ]), { code: 1000, reason: 'client complete' });
  } finally {
    ws.close();
    await gateway.close();
  }
});

test('closes the gateway while a WebSocket connection is still open', async () => {
  const gateway = await startGateway({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
  });
  const port = Number(new URL(gateway.url).port);
  const socket = createConnection(port, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write([
          'GET /api/v1/ws?provider=codex HTTP/1.1',
          'Host: 127.0.0.1',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Protocol: kimi-code.bearer.test-token',
          '',
          '',
        ].join('\r\n'));
      });
      socket.once('data', (data) => {
        assert.match(data.toString(), /101 Switching Protocols/);
        resolve();
      });
    });
    await Promise.race([
      gateway.close(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('gateway close timed out')), 1_000)),
    ]);
  } finally {
    socket.destroy();
  }
});

test('returns 404 for a missing local session instead of fabricating one', async () => {
  const codex = fakeAdapter('codex');
  codex.list = async () => ({ items: [] });
  const gateway = await startGateway({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    kimi: 'off',
    codex: codex as any,
    claude: fakeAdapter('claude') as any,
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/sessions/codex_missing`, {
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json() as any).code, 40401);
  } finally {
    await gateway.close();
  }
});

test('returns an empty message page before a Claude transcript is materialized', async () => {
  const claude = fakeAdapter('claude');
  claude.getHistory = async () => {
    throw new Error('session not found');
  };
  const gateway = await startGateway({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: claude as any,
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/sessions/claude_new/messages`, {
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as any).data, { items: [], has_more: false });
  } finally {
    await gateway.close();
  }
});

test('reports only installed providers in /meta', async () => {
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    availableProviders: ['kimi', 'codex'],
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/meta`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.deepEqual((await response.json() as any).data.providers, ['kimi', 'codex']);
  } finally {
    await gateway.close();
  }
});

test('detectAvailableProviders honors CLAUDE_BIN and CODEX_PATH presence', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-avail-'));
  try {
    const claudeBin = join(base, 'claude');
    await writeFile(claudeBin, '#!/bin/sh\n');

    const present = detectAvailableProviders({ CLAUDE_BIN: claudeBin, CODEX_PATH: '/bin/true', PATH: '' });
    assert.deepEqual(present, ['kimi', 'claude', 'codex']);

    const missing = detectAvailableProviders({
      CLAUDE_BIN: join(base, 'missing-claude'),
      CODEX_PATH: join(base, 'missing-codex'),
      PATH: '',
    });
    assert.deepEqual(missing, ['kimi']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('surfaces provider model catalog errors instead of faking an empty list', async () => {
  const claude = fakeAdapter('claude');
  claude.listModels = async () => { throw new Error('handshake failed'); };
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: claude as any,
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/models?provider=claude`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.notEqual(response.status, 200);
    const body = (await response.json()) as { code?: number; msg?: string };
    assert.notEqual(body.code, 0);
    assert.match(body.msg ?? '', /handshake failed/);
  } finally {
    await gateway.close();
  }
});

test('keeps a running turn visible when the first history fetch fails but a later one succeeds', async () => {
  // 回归:首轮 getHistory 失败曾把 historyObserved 提前固化,之后历史成功
  // 回灌时运行中 turn 与同号持久化 turn 撞号,REST 页静默丢 live turn。
  const claude = fakeAdapter('claude');
  let historyCalls = 0;
  claude.getHistory = async (): Promise<Message[]> => {
    historyCalls += 1;
    if (historyCalls === 1) throw new Error('transient history failure');
    return [
      { id: 'u1', session_id: 'claude-native', role: 'user', content: [{ type: 'text', text: 'old one' }], created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'a1', session_id: 'claude-native', role: 'assistant', content: [{ type: 'text', text: 'old reply' }], created_at: '2026-01-01T00:00:01.000Z' },
      { id: 'u2', session_id: 'claude-native', role: 'user', content: [{ type: 'text', text: 'old two' }], created_at: '2026-01-01T00:00:02.000Z' },
    ];
  };
  claude.startTurn = async (): Promise<TurnHandle> => ({
    turnId: 'stuck-turn',
    // 永不结束的事件流:turn 一直保持 running。
    events: (async function* () { await new Promise<never>(() => {}); })() as AsyncGenerator<never>,
  });
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: claude as any,
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/sessions/claude_claude-native/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'live prompt' }] }),
    });
    assert.equal(response.status, 200);

    let page: any;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const res = await fetch(`${gateway.url}/api/v1/sessions/claude_claude-native/transcript?agent_id=main&page_size=20`, {
        headers: { authorization: 'Bearer gateway-token' },
      });
      page = (await res.json() as any).data;
      if (page.items.some((item: any) => item.state === 'running')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(
      page.items.map((item: any) => [item.turnId, item.state]),
      [['t1', 'completed'], ['t2', 'completed'], ['t3', 'running']],
    );
    assert.equal(page.items[2].prompt, 'live prompt');
  } finally {
    await gateway.close();
  }
});

test('surfaces provider DTO catalog errors instead of faking an empty list', async () => {
  const claude = fakeAdapter('claude');
  claude.listModels = async () => { throw new Error('handshake failed'); };
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: claude as any,
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/providers?provider=claude`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.notEqual(response.status, 200);
    const body = (await response.json()) as { code?: number; msg?: string };
    assert.notEqual(body.code, 0);
    assert.match(body.msg ?? '', /handshake failed/);
  } finally {
    await gateway.close();
  }
});

test('lets unauthenticated CORS preflight through to the OPTIONS handler', async () => {
  // preflight 浏览器不附带 Authorization;若在 pre-auth 被 401,跨域页面直接残废。
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/sessions?provider=claude`, { method: 'OPTIONS' });
    assert.equal(response.status, 200);
    // 非 OPTIONS 无凭据仍必须 401(鉴权绕过修复不回退)。
    const denied = await fetch(`${gateway.url}/api/v1/sessions?provider=claude`);
    assert.equal(denied.status, 401);
  } finally {
    await gateway.close();
  }
});

test('rejects oversized request bodies instead of buffering unbounded memory', async () => {
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/sessions?provider=claude`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' },
      body: 'x'.repeat(10 * 1024 * 1024 + 1),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { msg?: string };
    assert.match(body.msg ?? '', /too large/);
  } finally {
    await gateway.close();
  }
});

test('disposes both provider adapters on gateway close', async () => {
  const disposed: string[] = [];
  const claude = fakeAdapter('claude');
  const codex = fakeAdapter('codex');
  claude.dispose = async () => { disposed.push('claude'); };
  codex.dispose = async () => { disposed.push('codex'); };
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: codex as any,
    claude: claude as any,
  });
  await gateway.close();
  assert.deepEqual(disposed.sort(), ['claude', 'codex']);
});
