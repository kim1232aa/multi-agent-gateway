import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type { ProviderAdapter, ProviderCapabilities, NativeModel, NativeCommand, Session, SessionPage, Message, StartTurnInput, TurnHandle, ApprovalDecision, HistoryQuery, ListSessionsQuery, CreateSessionInput } from './types.js';
import { activeKimiTier1Names, detectAvailableProviders, executeCodexCommand, formatCodexAccountUsage, parseWireThinkingPatch, renderCodexUsage, SessionHub, skillDto, startGateway } from './gateway.js';

const capabilities: ProviderCapabilities = { streaming: true, thinking: true, tools: true, approvals: false, questions: false, interrupt: true, history: true };

function fakeAdapter(name: 'claude' | 'codex' | 'grok' | 'pi' | 'dsh'): ProviderAdapter {
  const session: Session = {
    id: `${name}-native`, workspace_id: '', title: `${name} test`, created_at: new Date(0).toISOString(), updated_at: new Date().toISOString(), busy: false, metadata: { cwd: '/tmp' }, provider: name,
  };
  const models: NativeModel[] = [{ provider: name, model: `${name}-model`, display_name: `${name} model`, max_context_size: 200000, capabilities: ['thinking'], support_efforts: ['low', 'high'] }];
  const commands: NativeCommand[] = [{ name: 'help', description: 'Help', kind: 'prompt', acceptsInput: false }];
  const sessionModels = new Map<string, string>();
  const sessionThinking = new Map<string, string>();
  const sessionPermission = new Map<string, string>();
  const sessionPlan = new Map<string, boolean>();
  const adapterCaps: ProviderCapabilities = name === 'pi'
    ? {
        ...capabilities,
        approvals: true,
        manualApproval: true,
        questions: true,
        compact: true,
        fork: true,
        clone: true,
        rollback: false,
        planMode: false,
        goals: false,
      }
    : name === 'claude' || name === 'codex'
      ? {
          ...capabilities,
          approvals: true,
          manualApproval: true,
          planMode: true,
          questions: true,
        }
      : capabilities;
  return {
    name, capabilities: () => adapterCaps,
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
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    availableProviders: ['kimi', 'claude', 'codex'],
    pi: fakeAdapter('pi') as any,
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

    // 0.39 POST /sessions/:id/tasks/:taskId:detach — Kimi 会话必须透传到 kap-server。
    const detachKimi = await get('/sessions/plain-kimi-id/tasks/task-1:detach', { method: 'POST', body: '{}' });
    assert.equal(detachKimi.status, 200);
    assert.equal((await detachKimi.json() as any).data.upstream, true);
    assert.ok(seen.some((x) => x.path === '/api/v1/sessions/plain-kimi-id/tasks/task-1:detach'));

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
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
      host_version: '0.37.2',
    }));
  };

  try {
    gateway = await startGateway({
      port: 0,
      token: 'gateway-token',
      codex: fakeAdapter('codex') as any,
      claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
      pi: fakeAdapter('pi') as any,
      availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
      claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
      pi: fakeAdapter('pi') as any,
      availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
      claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
      pi: fakeAdapter('pi') as any,
      availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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

test('maps local history blocks to the Kimi Web message wire', async () => {
  const history = (provider: 'claude' | 'codex'): Message[] => [{
    id: `${provider}-blocks`,
    session_id: `${provider}-native`,
    role: 'assistant',
    content: [
      { type: 'thinking', text: 'consider the command' },
      { type: 'tool_call', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', tool_call_id: 'tool-1', content: '/tmp', is_error: true },
    ],
    created_at: '2026-01-01T00:00:04.000Z',
  }];
  const claude = fakeAdapter('claude');
  const codex = fakeAdapter('codex');
  claude.getHistory = async () => history('claude');
  codex.getHistory = async () => history('codex');
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: codex as any,
    claude: claude as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  try {
    for (const provider of ['claude', 'codex'] as const) {
      const response = await fetch(`${gateway.url}/api/v1/sessions/${provider}_${provider}-native/messages`, {
        headers: { authorization: 'Bearer gateway-token' },
      });
      assert.equal(response.status, 200);
      const item = ((await response.json() as any).data.items as any[])[0];
      const wireContent = [
        { type: 'thinking', thinking: 'consider the command' },
        { type: 'tool_use', tool_call_id: 'tool-1', tool_name: 'Bash', input: { command: 'pwd' } },
        { type: 'tool_result', tool_call_id: 'tool-1', output: '/tmp', is_error: true },
      ];
      assert.deepEqual(item.content, wireContent);

      const snapshot = await fetch(`${gateway.url}/api/v1/sessions/${provider}_${provider}-native/snapshot`, {
        headers: { authorization: 'Bearer gateway-token' },
      });
      assert.equal(snapshot.status, 200);
      const snapshotItem = ((await snapshot.json() as any).data.messages.items as any[])[0];
      assert.deepEqual(snapshotItem.content, wireContent);

      const transcript = await fetch(`${gateway.url}/api/v1/sessions/${provider}_${provider}-native/transcript?agent_id=main`, {
        headers: { authorization: 'Bearer gateway-token' },
      });
      assert.equal(transcript.status, 200);
      const frames = ((await transcript.json() as any).data.items as any[])[0]?.steps?.[0]?.frames ?? [];
      assert.deepEqual(frames.map((frame: any) => frame.kind), ['thinking', 'tool', 'tool']);
      assert.equal(frames[0].text, 'consider the command');
      assert.equal(frames[1].toolCallId, 'tool-1');
      assert.equal(frames[1].name, 'Bash');
      assert.equal(frames[2].output, '/tmp');
      assert.equal(frames[2].state, 'error');
    }
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
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    codex: codex as any, claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
      yield { ...base, kind: 'tool', status: 'delta', payload: { toolCallId: 'tool-1', name: 'Bash', output: 'partial' } } as any;
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
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    const toolProgress = frames.filter((frame) => frame.type === 'tool.progress');
    assert.equal(toolProgress.length, 1);
    assert.equal(toolProgress[0]?.payload.toolCallId, 'tool-1');
    assert.equal(toolProgress[0]?.payload.output, 'partial');
    assert.equal(frames.some((frame) => frame.type === 'tool.call.progress'), false);
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
    codex: codex as any, claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  const frames: Array<Record<string, any>> = [];
  let ws: WebSocket | undefined;
    let resolveReset!: () => void;
    let resolveCompleted!: () => void;
    let sawTurnCompleted = false;
    let sawPromptCompleted = false;
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
        if (frame.type === 'transcript.ops') {
          const ops = frame.payload.ops as Array<Record<string, any>>;
          if (ops.some((op) => op.op === 'turn.upsert' && op.turn?.state === 'completed')) sawTurnCompleted = true;
          if (ops.some((op) => op.op === 'prompt.upsert' && op.prompt?.status === 'completed')) sawPromptCompleted = true;
          if (sawTurnCompleted && sawPromptCompleted) resolveCompleted();
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
    codex: codex as any, claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    codex: codex as any, claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    codex: fakeAdapter('codex') as any, claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    codex: codex as any, claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    codex: codex as any, claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    codex: codex as any, claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    codex: codex as any, claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    codex: codex as any, claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    codex: codex as any, claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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

test('opens a local events socket when kimi is off so the official splash can finish', async () => {
  const gateway = await startGateway({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  const frames: Record<string, unknown>[] = [];
  const ws = new WebSocket(
    `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?client_id=browser&provider=kimi`,
    ['kimi-code.bearer.test-token'],
  );
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('kimi=off WebSocket failed to open locally'));
        ws.onmessage = (event) => {
          frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
        };
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('kimi=off WebSocket open timed out')), 1_000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(frames[0]?.type, 'server_hello');
    assert.equal(
      (frames[0]?.payload as { server_id?: string } | undefined)?.server_id,
      'multi-agent-gateway',
    );
  } finally {
    ws.close();
    await gateway.close();
  }
});

test('does not fan other-provider session events onto the kimi=off splash socket', async () => {
  const codex = fakeAdapter('codex');
  let resolveIdle!: () => void;
  const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
  codex.startTurn = async (): Promise<TurnHandle> => ({
    turnId: 'splash-isolation',
    events: (async function* () {
      const base = { sessionId: 'codex-native', turnId: 'splash-isolation', timestamp: Date.now() };
      yield { ...base, kind: 'message', status: 'delta', payload: { delta: 'hi' } } as any;
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
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  const splashFrames: Record<string, unknown>[] = [];
  const splash = new WebSocket(
    `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?client_id=browser&provider=kimi`,
    ['kimi-code.bearer.test-token'],
  );
  const observer = new WebSocket(
    `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`,
    ['kimi-code.bearer.test-token'],
  );
  observer.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (frame.type === 'event.session.work_changed' && (frame.payload as { busy?: boolean } | undefined)?.busy === false) {
      resolveIdle();
    }
  };
  splash.onmessage = (event) => {
    splashFrames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  };
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        let opened = 0;
        const mark = (): void => { opened += 1; if (opened === 2) resolve(); };
        splash.onopen = mark;
        observer.onopen = mark;
        splash.onerror = () => reject(new Error('splash WebSocket failed'));
        observer.onerror = () => reject(new Error('codex observer WebSocket failed'));
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('WebSocket open timed out')), 1_000)),
    ]);
    const response = await fetch(`${gateway.url}/api/v1/sessions/codex_codex-native/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'isolate' }] }),
    });
    assert.equal(response.status, 200);
    await Promise.race([
      idle,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('codex turn did not finish')), 1_000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(splashFrames.every((frame) => frame.type === 'server_hello'), true);
    assert.equal(splashFrames.some((frame) => frame.type === 'event.session.work_changed'), false);
  } finally {
    splash.close();
    observer.close();
    await gateway.close();
  }
});

test('returns 502 when kimi is on and the upstream WebSocket is unreachable', async () => {
  const gateway = await startGateway({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    kimi: { upstream: 'http://127.0.0.1:1', token: 'upstream-token' },
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  const gatewayUrl = new URL(gateway.url);
  try {
    const statusLine = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(Number(gatewayUrl.port), '127.0.0.1', () => {
        socket.write([
          'GET /api/v1/ws?client_id=browser&provider=kimi HTTP/1.1',
          `Host: ${gatewayUrl.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Protocol: kimi-code.bearer.test-token',
          '',
          '',
        ].join('\r\n'));
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('kimi=on unreachable upstream handshake timed out'));
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
    assert.match(statusLine, /^HTTP\/1\.1 502 /);
  } finally {
    await gateway.close();
  }
});

test('does not preheat list/models/commands for providers that are not installed', async () => {
  const claude = fakeAdapter('claude');
  const grok = fakeAdapter('grok');
  const codex = fakeAdapter('codex');
  const pi = fakeAdapter('pi');
  const calls: string[] = [];
  claude.list = async () => { calls.push('claude.list'); return { items: [] }; };
  claude.listModels = async () => { calls.push('claude.models'); return []; };
  claude.listCommands = async () => { calls.push('claude.cmds'); return []; };
  grok.list = async () => { calls.push('grok.list'); return { items: [] }; };
  grok.listModels = async () => { calls.push('grok.models'); return []; };
  grok.listCommands = async () => { calls.push('grok.cmds'); return []; };
  pi.list = async () => { calls.push('pi.list'); return { items: [] }; };
  pi.listModels = async () => { calls.push('pi.models'); return []; };
  pi.listCommands = async () => { calls.push('pi.cmds'); return []; };
  let resolveCodex!: () => void;
  const codexWarmed = new Promise<void>((resolve) => { resolveCodex = resolve; });
  const originalList = codex.list.bind(codex);
  codex.list = async (query) => {
    const page = await originalList(query);
    calls.push('codex.list');
    resolveCodex();
    return page;
  };
  const gateway = await startGateway({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    kimi: 'off',
    availableProviders: ['kimi', 'codex'],
    codex: codex as any,
    claude: claude as any,
    grok: grok as any,
    pi: pi as any,
  });
  try {
    await Promise.race([
      codexWarmed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('codex preheat did not run')), 1_000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls.includes('codex.list'), true);
    assert.equal(calls.some((name) => name.startsWith('claude.') || name.startsWith('grok.') || name.startsWith('pi.')), false);
  } finally {
    await gateway.close();
  }
});

test('keeps grok WebSocket local instead of tunneling to Kimi', async () => {
  let tunneled = false;
  const upstreamServer = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  upstreamServer.on('upgrade', (_req, socket) => {
    tunneled = true;
    socket.write('HTTP/1.1 500 Tunneled\r\n\r\n');
    socket.destroy();
  });
  const upstream = await listen(upstreamServer);
  const gateway = await startGateway({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    kimi: { upstream: upstream.url, token: 'upstream-token' },
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  const ws = new WebSocket(
    `${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=grok`,
    ['kimi-code.bearer.test-token'],
  );
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('grok WebSocket failed to open locally'));
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('grok WebSocket open timed out')), 1_000)),
    ]);
    assert.equal(tunneled, false);
  } finally {
    ws.close();
    await gateway.close();
    await upstream.close();
  }
});

test('acknowledges a local provider WebSocket close frame', async () => {
  const gateway = await startGateway({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    claude: claude as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    availableProviders: ['kimi', 'codex'],
    pi: fakeAdapter('pi') as any,
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

test('detectAvailableProviders honors CLAUDE_BIN, GROK_BIN, CODEX_PATH and PI_BIN presence', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-avail-'));
  try {
    const claudeBin = join(base, 'claude');
    await writeFile(claudeBin, '#!/bin/sh\n');

    const grokBin = join(base, 'grok');
    await writeFile(grokBin, '#!/bin/sh\n');

    const piBin = join(base, 'pi');
    await writeFile(piBin, '#!/bin/sh\n');

    const dshBin = join(base, 'dsh');
    await writeFile(dshBin, '#!/bin/sh\n');

    const present = detectAvailableProviders({
      CLAUDE_BIN: claudeBin,
      GROK_BIN: grokBin,
      CODEX_PATH: '/bin/true',
      PI_BIN: piBin,
      DSH_BIN: dshBin,
      PATH: '',
    });
    assert.deepEqual(present, ['kimi', 'claude', 'grok', 'codex', 'pi', 'dsh']);

    const missing = detectAvailableProviders({
      CLAUDE_BIN: join(base, 'missing-claude'),
      GROK_BIN: join(base, 'missing-grok'),
      CODEX_PATH: join(base, 'missing-codex'),
      PI_BIN: join(base, 'missing-pi'),
      DSH_BIN: join(base, 'missing-dsh'),
      PATH: '',
    });
    assert.deepEqual(missing, ['kimi']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('detectAvailableProviders includes claude when a fake claude is on PATH', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-path-'));
  try {
    const claudeBin = join(base, 'claude');
    await writeFile(claudeBin, '#!/bin/sh\n');
    await chmod(claudeBin, 0o755);
    // CLAUDE_BIN 指向不存在的路径,迫使探测走 PATH,而不是 ~/.local/bin/claude。
    const found = detectAvailableProviders({
      CLAUDE_BIN: join(base, 'missing-claude'),
      GROK_BIN: join(base, 'missing-grok'),
      PI_BIN: join(base, 'missing-pi'),
      PATH: base,
    });
    assert.equal(found.includes('claude'), true);

    const missing = detectAvailableProviders({
      CLAUDE_BIN: join(base, 'missing-claude'),
      GROK_BIN: join(base, 'missing-grok'),
      PI_BIN: join(base, 'missing-pi'),
      PATH: '',
    });
    assert.equal(missing.includes('claude'), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('startGateway({kimi:off}) GET /api/v1/auth is 200 ready true without kimi child', async () => {
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    availableProviders: ['claude', 'codex', 'grok'],
    pi: fakeAdapter('pi') as any,
  });
  const get = (path: string) => fetch(`${gateway.url}/api/v1${path}`, {
    headers: { authorization: 'Bearer gateway-token' },
  });
  try {
    const auth = await get('/auth');
    assert.equal(auth.status, 200);
    const authData = (await auth.json() as any).data;
    assert.equal(authData.ready, true);
    assert.equal(authData.providers_count, 3);
    assert.equal(authData.default_model, null);
    assert.equal(authData.managed_provider, null);
    assert.equal(authData.local_only, true);
    assert.equal(authData.upstream_error, undefined);

    const meta = await get('/meta');
    assert.equal(meta.status, 200);
    const metaData = (await meta.json() as any).data;
    assert.deepEqual(metaData.providers, ['claude', 'codex', 'grok']);
    assert.match(String(metaData.server_version), /Kimi 2\.6\.2 compatible/);

    const models = await get('/models');
    assert.equal(models.status, 200);
    const modelsData = (await models.json() as any).data;
    assert.deepEqual(modelsData.items, []);
    assert.equal(modelsData.upstream_error, undefined);
  } finally {
    await gateway.close();
  }
});

test('rejects grok swarm and goal the same way as Claude', async () => {
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  const post = (path: string, body: unknown) => fetch(`${gateway.url}/api/v1${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    const swarm = await post('/sessions/grok_grok-native:swarm', {});
    assert.equal(swarm.status, 400);
    const goal = await post('/sessions/grok_grok-native/profile', { agent_config: { goal_objective: 'x' } });
    assert.equal(goal.status, 400);
    const btw = await post('/sessions/grok_grok-native:btw', {});
    assert.equal(btw.status, 400);
    const detach = await post('/sessions/grok_grok-native/tasks/task-1:detach', {});
    assert.equal(detach.status, 400);
    assert.match(((await detach.json()) as { msg?: string }).msg ?? '', /不支持.*:detach/);
    const compact = await post('/sessions/grok_grok-native:compact', {});
    assert.equal(compact.status, 400);
    assert.match(((await compact.json()) as { msg?: string }).msg ?? '', /不支持压缩/);
    const undo = await post('/sessions/grok_grok-native:undo', {});
    assert.equal(undo.status, 400);
    const undoMsg = ((await undo.json()) as { msg?: string }).msg ?? '';
    assert.match(undoMsg, /不支持撤销/);
    assert.doesNotMatch(undoMsg, /claude stream-json/);
  } finally {
    await gateway.close();
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
    claude: claude as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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

test('GATEWAY_DEMO does not replace a failed Claude model catalog', async () => {
  const saved = process.env.GATEWAY_DEMO;
  process.env.GATEWAY_DEMO = 'on';
  const claude = fakeAdapter('claude');
  claude.listModels = async () => { throw new Error('handshake failed'); };
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: claude as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/models?provider=claude`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.notEqual(response.status, 200);
    const body = (await response.json()) as { code?: number; msg?: string };
    assert.match(body.msg ?? '', /handshake failed/);
  } finally {
    await gateway.close();
    if (saved === undefined) delete process.env.GATEWAY_DEMO;
    else process.env.GATEWAY_DEMO = saved;
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
    claude: claude as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    claude: claude as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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

test('rejects unsupported Claude goal routes and profile controls', async () => {
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  const get = (path: string, init: RequestInit = {}) => fetch(`${gateway.url}/api/v1${path}`, {
    ...init,
    headers: { authorization: 'Bearer gateway-token', ...(init.headers ?? {}) },
  });
  try {
    const goal = await get('/sessions/claude_claude-native/goal');
    assert.equal(goal.status, 400);
    const goalBody = (await goal.json()) as { code?: number; msg?: string };
    assert.notEqual(goalBody.code, 0);
    assert.match(goalBody.msg ?? '', /不支持.*goal/);

    const objective = await get('/sessions/claude_claude-native/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_config: { goal_objective: 'ship it' } }),
    });
    assert.equal(objective.status, 400);
    const objectiveBody = (await objective.json()) as { code?: number; msg?: string };
    assert.notEqual(objectiveBody.code, 0);
    assert.match(objectiveBody.msg ?? '', /不支持.*goal/);

    const control = await get('/sessions/claude_claude-native/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_config: { goal_control: 'pause' } }),
    });
    assert.equal(control.status, 400);
    const controlBody = (await control.json()) as { code?: number; msg?: string };
    assert.notEqual(controlBody.code, 0);
    assert.match(controlBody.msg ?? '', /不支持.*goal/);
  } finally {
    await gateway.close();
  }
});

test('rejects swarm mode requests for local Claude and Codex providers', async () => {
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  try {
    for (const provider of ['claude', 'codex'] as const) {
      const response = await fetch(`${gateway.url}/api/v1/sessions/${provider}_${provider}-native/profile`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer gateway-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ agent_config: { swarm_mode: true } }),
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { code?: number; msg?: string };
      assert.notEqual(body.code, 0);
      assert.match(body.msg ?? '', /不支持.*swarm_mode/);

      const swarmRoute = await fetch(`${gateway.url}/api/v1/sessions/${provider}_${provider}-native:swarm`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer gateway-token',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(swarmRoute.status, 400);
      const swarmBody = (await swarmRoute.json()) as { code?: number; msg?: string };
      assert.notEqual(swarmBody.code, 0);
      assert.match(swarmBody.msg ?? '', /不支持.*[Ss]warm/);
    }
  } finally {
    await gateway.close();
  }
});

test('rejects Kimi swarm/goal fields on local prompt submit', async () => {
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  const post = (path: string, body: Record<string, unknown>) => fetch(`${gateway.url}/api/v1${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    const swarm = await post('/sessions/claude_claude-native/prompts', {
      content: [{ type: 'text', text: 'hi' }],
      swarm_mode: true,
    });
    assert.equal(swarm.status, 400);
    assert.match(((await swarm.json()) as { msg?: string }).msg ?? '', /不支持.*swarm_mode/);

    const goal = await post('/sessions/claude_claude-native/prompts', {
      content: [{ type: 'text', text: 'hi' }],
      goal_objective: 'ship it',
    });
    assert.equal(goal.status, 400);
    assert.match(((await goal.json()) as { msg?: string }).msg ?? '', /不支持.*goal/);

    const okPrompt = await post('/sessions/claude_claude-native/prompts', {
      content: [{ type: 'text', text: 'hi' }],
      swarm_mode: false,
    });
    assert.equal(okPrompt.status, 200);
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
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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
    claude: fakeAdapter('claude') as any, grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
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

test('disposes provider adapters on gateway close', async () => {
  const disposed: string[] = [];
  const claude = fakeAdapter('claude');
  const codex = fakeAdapter('codex');
  const grok = fakeAdapter('grok');
  claude.dispose = async () => { disposed.push('claude'); };
  codex.dispose = async () => { disposed.push('codex'); };
  grok.dispose = async () => { disposed.push('grok'); };
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: codex as any,
    claude: claude as any,
    grok: grok as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  await gateway.close();
  assert.deepEqual(disposed.sort(), ['claude', 'codex', 'grok']);
});

test('GET /models?provider=grok returns adapter items', async () => {
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/models?provider=grok`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).data.items[0].model, 'grok-model');
  } finally {
    await gateway.close();
  }
});

test('session id grok_<id> is not proxied to kimi', async () => {
  const seen: string[] = [];
  const upstream = await listen(createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://upstream');
    seen.push(`${url.pathname}${url.search}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(envelope({ upstream: true, path: url.pathname }));
  }));
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: { upstream: upstream.url, token: 'upstream-token' },
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/sessions/grok_grok-native`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.equal(response.status, 200);
    const data = (await response.json() as any).data;
    assert.equal(data.id, 'grok_grok-native');
    assert.equal(data.upstream, undefined);
    assert.equal(seen.some((path) => path.includes('grok_')), false);

    const v2 = await fetch(`${gateway.url}/api/v2/sessions?provider=grok`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.equal(v2.status, 200);
    const v2Data = (await v2.json() as any).data;
    assert.equal(v2Data.items[0].id, 'grok_grok-native');
    assert.equal(seen.some((path) => path.startsWith('/api/v2')), false);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('meta providers includes grok when availableProviders includes it', async () => {
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok'],
    pi: fakeAdapter('pi') as any,
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/meta`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.deepEqual((await response.json() as any).data.providers, ['kimi', 'claude', 'codex', 'grok']);
  } finally {
    await gateway.close();
  }
});

test('PATCH and DELETE local workspaces without wd_codex_/wd_claude_ prefixes stay local', async () => {
  const seen: string[] = [];
  const upstream = await listen(createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://upstream');
    seen.push(`${req.method} ${url.pathname}${url.search}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(envelope({ upstream: true, path: url.pathname }));
  }));
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: { upstream: upstream.url, token: 'upstream-token' },
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  const auth = { authorization: 'Bearer gateway-token', 'content-type': 'application/json' };
  try {
    const grokId = 'wd_tmp_anything';
    const grokPatch = await fetch(`${gateway.url}/api/v1/workspaces/${grokId}?provider=grok`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ name: 'tmp-grok' }),
    });
    assert.equal(grokPatch.status, 200);
    const grokPatchData = (await grokPatch.json() as any).data;
    assert.equal(grokPatchData.id, grokId);
    assert.equal(grokPatchData.upstream, undefined);
    assert.equal(grokPatchData.name, 'tmp-grok');

    const grokDelete = await fetch(`${gateway.url}/api/v1/workspaces/${grokId}?provider=grok`, {
      method: 'DELETE',
      headers: auth,
    });
    assert.equal(grokDelete.status, 200);
    assert.equal((await grokDelete.json() as any).data.deleted, grokId);

    const claudeId = 'wd_home-ubuntu_deadbeef';
    const claudePatch = await fetch(`${gateway.url}/api/v1/workspaces/${claudeId}?provider=claude`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ name: 'home' }),
    });
    assert.equal(claudePatch.status, 200);
    const claudePatchData = (await claudePatch.json() as any).data;
    assert.equal(claudePatchData.id, claudeId);
    assert.equal(claudePatchData.upstream, undefined);
    assert.equal(claudePatchData.name, 'home');

    const claudeDelete = await fetch(`${gateway.url}/api/v1/workspaces/${claudeId}?provider=claude`, {
      method: 'DELETE',
      headers: auth,
    });
    assert.equal(claudeDelete.status, 200);
    assert.equal((await claudeDelete.json() as any).data.deleted, claudeId);

    assert.equal(seen.some((path) => path.includes('/workspaces/')), false);

    const kimiPatch = await fetch(`${gateway.url}/api/v1/workspaces/wd_kimi_noprovider`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ name: 'kimi-ws' }),
    });
    assert.equal(kimiPatch.status, 200);
    assert.equal((await kimiPatch.json() as any).data.upstream, true);
    assert.equal(seen.some((path) => path.includes('/api/v1/workspaces/wd_kimi_noprovider')), true);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('GET grok session status fills max_context_tokens from grok window when usage is 0', async () => {
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  try {
    const response = await fetch(`${gateway.url}/api/v1/sessions/grok_grok-native/status`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).data.max_context_tokens, 500000);
  } finally {
    await gateway.close();
  }
});

test('GET /api/v2/sessions?view=by_workspace returns groups for local providers', async () => {
  const grok = fakeAdapter('grok');
  grok.list = async () => ({
    items: [
      {
        id: 'g-new',
        workspace_id: '',
        title: 'new in a',
        created_at: '2026-08-24T01:00:00.000Z',
        updated_at: '2026-08-24T03:00:00.000Z',
        busy: false,
        metadata: { cwd: '/tmp/a' },
        extras: { last_prompt: 'new in a' },
        provider: 'grok',
      },
      {
        id: 'g-old',
        workspace_id: '',
        title: 'old in a',
        created_at: '2026-08-23T01:00:00.000Z',
        updated_at: '2026-08-23T03:00:00.000Z',
        busy: false,
        metadata: { cwd: '/tmp/a' },
        extras: { last_prompt: 'old in a' },
        provider: 'grok',
      },
      {
        id: 'g-b',
        workspace_id: '',
        title: 'in b',
        created_at: '2026-08-24T02:00:00.000Z',
        updated_at: '2026-08-24T02:00:00.000Z',
        busy: false,
        metadata: { cwd: '/tmp/b' },
        extras: { last_prompt: 'in b' },
        provider: 'grok',
      },
      {
        id: 'g-empty',
        workspace_id: '',
        title: 'empty prompt',
        created_at: '2026-08-24T04:00:00.000Z',
        updated_at: '2026-08-24T04:00:00.000Z',
        busy: false,
        metadata: { cwd: '/tmp/c' },
        provider: 'grok',
      },
    ],
  });
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: grok as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  try {
    const grouped = await fetch(
      `${gateway.url}/api/v2/sessions?provider=grok&view=by_workspace&group.page_size=1&meta.has_prompt=true`,
      { headers: { authorization: 'Bearer gateway-token' } },
    );
    assert.equal(grouped.status, 200);
    const data = (await grouped.json() as any).data;
    assert.ok(Array.isArray(data.groups), `expected groups array, got ${JSON.stringify(data)}`);
    assert.equal(data.items, undefined);
    assert.equal(data.groups.length, 2);
    assert.equal(data.total, 2);
    assert.equal(data.has_more, false);
    assert.equal(data.groups[0].workspace.cwd, '/tmp/a');
    assert.equal(data.groups[0].sessions.length, 1);
    assert.equal(data.groups[0].sessions[0].id, 'grok_g-new');
    assert.equal(data.groups[0].total, 2);
    assert.equal(data.groups[1].workspace.cwd, '/tmp/b');
    assert.equal(data.groups[1].sessions[0].id, 'grok_g-b');

    const empty = fakeAdapter('codex');
    empty.list = async () => ({ items: [] });
    const gateway2 = await startGateway({
      port: 0,
      token: 'gateway-token',
      kimi: 'off',
      codex: empty as any,
      claude: fakeAdapter('claude') as any,
      grok: fakeAdapter('grok') as any,
      pi: fakeAdapter('pi') as any,
      availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
    });
    try {
      const response = await fetch(
        `${gateway2.url}/api/v2/sessions?provider=codex&view=by_workspace`,
        { headers: { authorization: 'Bearer gateway-token' } },
      );
      assert.equal(response.status, 200);
      const emptyData = (await response.json() as any).data;
      assert.deepEqual(emptyData.groups, []);
    } finally {
      await gateway2.close();
    }

    const flat = await fetch(`${gateway.url}/api/v2/sessions?provider=grok`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.equal(flat.status, 200);
    const flatData = (await flat.json() as any).data;
    assert.ok(Array.isArray(flatData.items));
    assert.equal(flatData.groups, undefined);
  } finally {
    await gateway.close();
  }
});

test('0.39 remote control, local title/generate and :cancel stay on the right side', async () => {
  const seen: string[] = [];
  const renamed: string[] = [];
  const upstream = await listen(createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://upstream');
    seen.push(`${req.method} ${url.pathname}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(envelope({ upstream: true, path: url.pathname }));
  }));
  const claude = fakeAdapter('claude');
  claude.rename = async (sessionId, title) => {
    renamed.push(`${sessionId}:${title}`);
  };
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: { upstream: upstream.url, token: 'upstream-token' },
    codex: fakeAdapter('codex') as any,
    claude: claude as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  const auth = { authorization: 'Bearer gateway-token', 'content-type': 'application/json' };
  try {
    const remote = await fetch(`${gateway.url}/v1/remote/devices`, { headers: auth });
    assert.equal(remote.status, 200);
    assert.match(remote.headers.get('content-type') ?? '', /application\/json/);
    assert.equal((await remote.json() as any).data.path, '/v1/remote/devices');
    assert.equal(seen.includes('GET /v1/remote/devices'), true);

    const title = await fetch(`${gateway.url}/api/v1/sessions/claude_claude-native/title/generate`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    });
    assert.equal(title.status, 200);
    assert.equal((await title.json() as any).data.title, 'one');
    assert.deepEqual(renamed, ['claude-native:one']);
    assert.equal(seen.some((line) => line.includes('title/generate')), false);

    const kimiCancel = await fetch(`${gateway.url}/api/v1/sessions/kimi-session/tasks/bg-1:cancel`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    });
    assert.equal(kimiCancel.status, 200);
    assert.equal((await kimiCancel.json() as any).data.upstream, true);
    assert.equal(seen.includes('POST /api/v1/sessions/kimi-session/tasks/bg-1:cancel'), true);

    for (const provider of ['claude', 'codex', 'grok'] as const) {
      const response = await fetch(`${gateway.url}/api/v1/sessions/${provider}_${provider}-native/tasks/bg-1:cancel`, {
        method: 'POST',
        headers: auth,
        body: '{}',
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { code?: number; msg?: string };
      assert.notEqual(body.code, 0);
      assert.match(body.msg ?? '', /不支持.*:cancel/);
    }
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('0.39 task detach is proxied for Kimi and 400 for local providers', async () => {
  const seen: string[] = [];
  const upstream = await listen(createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://upstream');
    seen.push(`${req.method} ${url.pathname}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(envelope({ upstream: true, path: url.pathname }));
  }));
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: { upstream: upstream.url, token: 'upstream-token' },
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  const post = (path: string) => fetch(`${gateway.url}/api/v1${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' },
    body: '{}',
  });
  try {
    const kimi = await post('/sessions/kimi-session/tasks/bg-1:detach');
    assert.equal(kimi.status, 200);
    assert.equal((await kimi.json() as any).data.upstream, true);
    assert.equal(seen.includes('POST /api/v1/sessions/kimi-session/tasks/bg-1:detach'), true);

    for (const provider of ['claude', 'codex', 'grok'] as const) {
      const response = await post(`/sessions/${provider}_${provider}-native/tasks/bg-1:detach`);
      assert.equal(response.status, 400);
      const body = (await response.json()) as { code?: number; msg?: string };
      assert.notEqual(body.code, 0);
      assert.match(body.msg ?? '', /不支持.*:detach/);
    }
    assert.equal(seen.some((line) => line.includes('claude_') || line.includes('codex_') || line.includes('grok_')), false);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});


test('Pi routing, wireModelDto, capability gating, and Pi slash commands work end-to-end', async () => {
  const calls: string[] = [];
  const pi = fakeAdapter('pi');
  pi.listModels = async () => [{
    provider: 'pi',
    model: 'anthropic/claude-sonnet-4',
    display_name: 'Claude Sonnet 4',
    max_context_size: 200_000,
    max_output_tokens: 16_384,
    capabilities: ['thinking', 'vision'],
    support_efforts: ['low', 'medium', 'high'],
    supportsAdaptiveThinking: true,
  }];
  pi.clone = async (id: string) => ({
    id: `${id}-clone`,
    workspace_id: '',
    title: 'Pi Clone',
    created_at: new Date(0).toISOString(),
    updated_at: new Date().toISOString(),
    busy: false,
    metadata: { cwd: '/tmp' },
    provider: 'pi',
  });
  pi.fork = async (id: string) => ({
    id: `${id}-fork`,
    workspace_id: '',
    title: 'Pi Fork',
    created_at: new Date(0).toISOString(),
    updated_at: new Date().toISOString(),
    busy: false,
    metadata: { cwd: '/tmp' },
    provider: 'pi',
  });
  pi.compact = async (_id: string, instr?: string) => { calls.push(`compact:${instr ?? ''}`); };
  pi.delete = async (id: string) => { calls.push(`delete:${id}`); };
  pi.resolveQuestion = async (_id: string, qid: string) => { calls.push(`question:${qid}`); };

  let upstreamHits = 0;
  const upstream = await listen(createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(envelope({ upstream: true }));
  }));
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: { upstream: upstream.url, token: 'upstream-token' },
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: pi as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  const reqJson = (path: string, method = 'GET', body?: unknown) => fetch(`${gateway.url}/api/v1${path}`, {
    method,
    headers: {
      authorization: 'Bearer gateway-token',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const modelsRes = await reqJson('/models?provider=pi');
    assert.equal(modelsRes.status, 200);
    const modelDto = (await modelsRes.json() as any).data.items[0];
    assert.equal(modelDto.max_output_size, 16_384);
    assert.equal(modelDto.adaptive_thinking, true);

    assert.equal((await reqJson('/sessions/pi_pi-native:clone', 'POST', {})).status, 200);
    assert.equal((await reqJson('/sessions/pi_pi-native:fork', 'POST', {})).status, 200);
    assert.equal((await reqJson('/sessions/pi_pi-native:compact', 'POST', { instruction: 'trim' })).status, 200);

    assert.equal((await reqJson('/sessions/pi_pi-native:undo', 'POST', {})).status, 400);
    assert.equal((await reqJson('/sessions?provider=pi', 'POST', { cwd: '/tmp', agent_config: { permission_mode: 'manual' } })).status, 200);
    assert.equal((await reqJson('/sessions?provider=pi', 'POST', { cwd: '/tmp', agent_config: { plan_mode: true } })).status, 400);
    assert.equal((await reqJson('/sessions/pi_pi-native/prompts', 'POST', { content: [{ type: 'text', text: 'hi' }], permission_mode: 'manual' })).status, 200);
    assert.equal((await reqJson('/sessions/pi_pi-native/prompts', 'POST', { content: [{ type: 'text', text: 'hi' }], plan_mode: true })).status, 400);
    const approvalsRes = await reqJson('/sessions/pi_pi-native/approvals');
    assert.equal(approvalsRes.status, 200);
    assert.deepEqual((await approvalsRes.json() as any).data.items, []);
    assert.equal((await reqJson('/sessions/pi_pi-native/approvals/ap-1', 'POST', { decision: 'approved' })).status, 200);
    assert.equal((await reqJson('/sessions/pi_pi-native/interactions/ap-1', 'POST', { kind: 'approval', decision: 'approved' })).status, 200);

    const qRes = await reqJson('/sessions/pi_pi-native/interactions/q-1', 'POST', {
      kind: 'question',
      answers: { pick: { kind: 'single', option_id: 'yes' } },
    });
    assert.equal(qRes.status, 200);
    assert.equal((await qRes.json() as any).data.outcome, 'answered');

    for (const cmd of ['/status', '/usage', '/clone', '/fork', '/compact keep']) {
      const res = await reqJson('/sessions/pi_pi-native/prompts', 'POST', { content: [{ type: 'text', text: cmd }] });
      assert.equal(res.status, 200, `${cmd} should return 200`);
    }
    assert.equal((await reqJson('/sessions/pi_pi-native/prompts', 'POST', { content: [{ type: 'text', text: '/undo' }] })).status, 400);
    assert.equal((await reqJson('/sessions/pi_pi-native:delete', 'POST', {})).status, 200);
    assert.equal(upstreamHits, 0);
    assert.ok(calls.includes('compact:trim'));
    assert.ok(calls.includes('compact:keep'));
    assert.ok(calls.includes('delete:pi-native'));
    assert.ok(calls.includes('question:q-1'));
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('rejects tower mode for all local providers and allows Grok compact/goal when advertised', async () => {
  const grok = fakeAdapter('grok');
  let savedGoal: Record<string, unknown> | null = null;
  (grok as any).capabilities = () => ({
    streaming: true, thinking: true, tools: true, approvals: true, questions: true, interrupt: true, history: true,
    compact: true, rollback: true, goals: true,
  });
  grok.compact = async () => {};
  grok.setGoal = async (_id: string, objective: string) => {
    savedGoal = { goalId: 'g1', objective, status: 'active', tokensUsed: 12, tokenBudget: 100 };
    return savedGoal;
  };
  grok.getGoal = async () => savedGoal;

  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: grok as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  const reqJson = (path: string, method = 'POST', body?: unknown) => fetch(`${gateway.url}/api/v1${path}`, {
    method,
    headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  try {
    for (const p of ['claude', 'codex', 'grok', 'pi'] as const) {
      const sid = `${p}_${p}-native`;
      assert.equal((await reqJson(`/sessions/${sid}:tower`, 'POST', {})).status, 400);
      assert.equal((await reqJson(`/sessions/${sid}/profile`, 'POST', { agent_config: { tower_mode: true } })).status, 400);
      assert.equal((await reqJson(`/sessions/${sid}/prompts`, 'POST', { content: [{ type: 'text', text: 'hi' }], tower_mode: true })).status, 400);
    }

    assert.equal((await reqJson('/sessions/grok_grok-native:compact', 'POST', {})).status, 200);
    assert.equal((await reqJson('/sessions/grok_grok-native/profile', 'POST', { agent_config: { goal_objective: 'ship m15' } })).status, 200);
    const goalGet = await reqJson('/sessions/grok_grok-native/goal', 'GET');
    assert.equal(goalGet.status, 200);
    const goalData = (await goalGet.json() as any).data;
    assert.equal(goalData.objective, 'ship m15');
    assert.equal(goalData.budget.remainingTokens, 88);
  } finally {
    await gateway.close();
  }
});

test('by_workspace fetches all pages beyond 100 sessions and prompts:steer retains attachments', async () => {
  const codex = fakeAdapter('codex');
  const allItems: Session[] = Array.from({ length: 115 }, (_, idx) => ({
    id: `c-${idx}`,
    workspace_id: '',
    title: `Session ${idx}`,
    created_at: new Date(idx * 1000).toISOString(),
    updated_at: new Date(1_700_000_000_000 + idx * 1000).toISOString(),
    busy: false,
    metadata: { cwd: idx % 2 === 0 ? '/tmp/ws-a' : '/tmp/ws-b' },
    provider: 'codex',
  }));
  codex.list = async (query: ListSessionsQuery = {}): Promise<SessionPage> => {
    const start = query.cursor ? Number(query.cursor) : 0;
    const limit = query.limit ?? 100;
    const slice = allItems.slice(start, start + limit);
    return {
      items: slice,
      ...(start + slice.length < allItems.length ? { next_cursor: String(start + slice.length) } : {}),
    };
  };

  let releaseTurn!: () => void;
  const turnReleased = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const steers: Array<{ text: string; attachments?: unknown[] }> = [];
  (codex as any).capabilities = () => ({ ...capabilities, steer: true, steerAttachments: false });
  codex.startTurn = async (): Promise<TurnHandle> => ({
    turnId: 'live-turn',
    events: (async function* () {
      await turnReleased;
      yield { sessionId: 'c-0', turnId: 'live-turn', kind: 'turn', status: 'completed', timestamp: Date.now(), payload: { reason: 'completed' } } as any;
    })(),
  });
  codex.steer = async (_sid: string, _tid: string, text: string, attachments?: unknown[]) => {
    steers.push({ text, attachments });
  };

  const settingsDir = await mkdtemp(join(tmpdir(), 'multi-agent-m15-steer-'));
  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    settingsDir,
    codex: codex as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  try {
    const groupsRes = await fetch(`${gateway.url}/api/v2/sessions?provider=codex&view=by_workspace&group.page_size=100`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.equal(groupsRes.status, 200);
    const groups = (await groupsRes.json() as any).data.groups as Array<{ sessions: unknown[]; total: number }>;
    assert.equal(groups.reduce((acc, g) => acc + g.total, 0), 115);
    assert.equal(groups.reduce((acc, g) => acc + g.sessions.length, 0), 115);

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const form = new FormData();
    form.append('file', new Blob([pngBytes], { type: 'image/png' }), 'pic.png');
    const upRes = await fetch(`${gateway.url}/api/v1/files`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token' },
      body: form,
    });
    assert.equal(upRes.status, 200);
    const fileId = (await upRes.json() as any).data.id as string;

    await fetch(`${gateway.url}/api/v1/sessions/codex_c-0/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'first' }] }),
    });
    const queuedRes = await fetch(`${gateway.url}/api/v1/sessions/codex_c-0/prompts`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        content: [
          { type: 'text', text: 'follow up' },
          { type: 'image', source: { kind: 'file', file_id: fileId } },
        ],
      }),
    });
    const queuedPromptId = (await queuedRes.json() as any).data.prompt_id as string;
    const steerRes = await fetch(`${gateway.url}/api/v1/sessions/codex_c-0/prompts:steer`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt_ids: [queuedPromptId] }),
    });
    assert.equal(steerRes.status, 200);
    assert.equal(steers.length, 1);
    assert.match(steers[0].text, /follow up/);
    assert.match(steers[0].text, /\[attached image:/);
  } finally {
    releaseTurn();
    await gateway.close();
    await rm(settingsDir, { recursive: true, force: true });
  }
});

test('uploadStore persists metadata sidecars across restarts, sniffs PNG magic bytes, and neuters active web MIMEs', async () => {
  const settingsDir = await mkdtemp(join(tmpdir(), 'multi-agent-m15-upload-'));
  let gateway1 = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    settingsDir,
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  let pngId = '';
  let spoofId = '';
  let svgId = '';
  try {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const form1 = new FormData();
    form1.append('file', new Blob([pngBytes], { type: 'image/jpeg' }), 'snap.png');
    const r1 = await fetch(`${gateway1.url}/api/v1/files`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token' },
      body: form1,
    });
    assert.equal(r1.status, 200);
    const meta1 = (await r1.json() as any).data;
    assert.equal(meta1.media_type, 'image/png');
    pngId = meta1.id;

    const formSpoof = new FormData();
    formSpoof.append('file', new Blob(['<html><script>alert(1)</script></html>'], { type: 'image/png' }), 'fake.png');
    const rSpoof = await fetch(`${gateway1.url}/api/v1/files`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token' },
      body: formSpoof,
    });
    assert.equal(rSpoof.status, 200);
    const metaSpoof = (await rSpoof.json() as any).data;
    assert.equal(metaSpoof.media_type, 'application/octet-stream');
    spoofId = metaSpoof.id;

    const form2 = new FormData();
    form2.append('file', new Blob(['<svg onload="alert(1)"/>'], { type: 'image/svg+xml' }), 'xss.svg');
    const r2 = await fetch(`${gateway1.url}/api/v1/files`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token' },
      body: form2,
    });
    assert.equal(r2.status, 200);
    const meta2 = (await r2.json() as any).data;
    assert.equal(meta2.media_type, 'application/octet-stream');
    svgId = meta2.id;
  } finally {
    await gateway1.close();
  }

  const gateway2 = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    settingsDir,
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  try {
    const getPng = await fetch(`${gateway2.url}/api/v1/files/${pngId}`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.equal(getPng.status, 200);
    assert.equal(getPng.headers.get('content-type'), 'image/png');
    assert.equal(getPng.headers.get('x-content-type-options'), 'nosniff');

    const getSpoof = await fetch(`${gateway2.url}/api/v1/files/${spoofId}`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.equal(getSpoof.status, 200);
    assert.equal(getSpoof.headers.get('content-type'), 'application/octet-stream');
    assert.equal(getSpoof.headers.get('x-content-type-options'), 'nosniff');

    const getSvg = await fetch(`${gateway2.url}/api/v1/files/${svgId}`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.equal(getSvg.status, 200);
    assert.equal(getSvg.headers.get('content-type'), 'application/octet-stream');
    assert.equal(getSvg.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await gateway2.close();
    await rm(settingsDir, { recursive: true, force: true });
  }
});

test('subscribe_v2 rolls back on history error and 2.6.2 WS + secondary fallbacks work cleanly', async () => {
  const wsDir = await mkdtemp(join(tmpdir(), 'multi-agent-m15-262-'));
  const subDir = join(wsDir, 'sub');
  const outsideDir = await mkdtemp(join(tmpdir(), 'multi-agent-m15-out-'));
  await mkdir(subDir, { recursive: true });

  const codex = fakeAdapter('codex');
  let failHistory = true;
  (codex as any).capabilities = () => ({ ...capabilities, rollback: true, compact: true, steer: true });
  codex.getUsage = () => ({
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    context_tokens: 15,
    context_limit: 200_000,
    total_cost_usd: 0,
    turn_count: 1,
  });
  codex.getHistory = async () => {
    if (failHistory) throw new Error('boom history');
    return [
      { id: 'u1', session_id: 'codex-native', role: 'user', content: [{ type: 'text', text: 'turn one' }], created_at: '2026-01-01T00:00:01.000Z' },
      { id: 'a1', session_id: 'codex-native', role: 'assistant', content: [{ type: 'text', text: 'answer one' }], created_at: '2026-01-01T00:00:02.000Z' },
    ];
  };
  codex.list = async (): Promise<SessionPage> => ({
    items: [{
      id: 'codex-native', workspace_id: '', title: 'codex 262', created_at: new Date(0).toISOString(), updated_at: new Date().toISOString(), busy: false, metadata: { cwd: wsDir }, provider: 'codex',
    }],
  });
  codex.rollback = async () => {};
  codex.compact = async () => {};
  codex.startTurn = async (): Promise<TurnHandle> => ({
    turnId: 'v262-turn',
    events: (async function* () {
      yield { sessionId: 'codex-native', turnId: 'v262-turn', kind: 'message', status: 'delta', timestamp: Date.now(), payload: { delta: 'hi 262' } } as any;
      yield { sessionId: 'codex-native', turnId: 'v262-turn', kind: 'turn', status: 'completed', timestamp: Date.now(), payload: { reason: 'completed' } } as any;
    })(),
  });

  const gateway = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: codex as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });

  const reqJson = (path: string, method = 'GET', body?: unknown) => fetch(`${gateway.url}/api/v1${path}`, {
    method,
    headers: {
      authorization: 'Bearer gateway-token',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  let wsV2: WebSocket | undefined;
  let ws262: WebSocket | undefined;
  try {
    // 1. subscribe_v2 failure rollback
    wsV2 = new WebSocket(`${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`, ['kimi-code.bearer.gateway-token']);
    const ackErr = await new Promise<Record<string, any>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ack timeout')), 2_000);
      wsV2!.onopen = () => wsV2!.send(JSON.stringify({
        type: 'subscribe_v2',
        id: 'sub-fail',
        payload: { session_id: 'codex_codex-native', transcript: { main: 'delta' } },
      }));
      wsV2!.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as Record<string, any>;
        if (msg.type === 'ack' && msg.id === 'sub-fail') {
          clearTimeout(t);
          resolve(msg);
        }
      };
    });
    assert.equal(ackErr.code, 1);
    assert.deepEqual(ackErr.payload.resync_required, ['codex_codex-native']);

    // 2. Enable history & verify 2.6.2 turns + WS subscribe + :undo/:reload/batch fallbacks
    failHistory = false;
    const turnsRes = await reqJson('/sessions/codex_codex-native/agents/main/turns');
    assert.equal(turnsRes.status, 200);
    assert.equal((await turnsRes.json() as any).data.turns.length, 1);

    const v262Frames: Array<Record<string, any>> = [];
    let resolveSub!: () => void;
    let resolveTurnEnd!: () => void;
    let resolveRemoved!: () => void;
    const subDone = new Promise<void>((r) => { resolveSub = r; });
    const turnDone = new Promise<void>((r) => { resolveTurnEnd = r; });
    const removedDone = new Promise<void>((r) => { resolveRemoved = r; });

    ws262 = new WebSocket(`${gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`, ['kimi-code.bearer.gateway-token']);
    ws262.onopen = () => ws262!.send(JSON.stringify({
      type: 'subscribe',
      request_id: 'req-262',
      session_id: 'codex_codex-native',
    }));
    ws262.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Record<string, any>;
      v262Frames.push(m);
      if (
        v262Frames.some((f) => f.type === 'turns' && f.session_id === 'codex_codex-native')
        && v262Frames.some((f) => f.type === 'agent' && f.session_id === 'codex_codex-native')
        && v262Frames.some((f) => f.type === 'usage' && f.session_id === 'codex_codex-native')
      ) {
        resolveSub();
      }
      if (m.type === 'turn.ended') resolveTurnEnd();
      if (m.type === 'turns.removed') resolveRemoved();
    };
    await subDone;
    assert.ok(v262Frames.some((m) => m.type === 'response' && m.request_id === 'req-262' && m.code === 0));
    assert.ok(v262Frames.some((m) => m.type === 'agent'));
    assert.ok(v262Frames.some((m) => m.type === 'usage'));

    assert.equal((await reqJson('/sessions/codex_codex-native/prompts', 'POST', { content: [{ type: 'text', text: 'stream 262' }] })).status, 200);
    await turnDone;
    assert.ok(v262Frames.some((m) => m.type === 'turn.started'));
    assert.ok(v262Frames.some((m) => m.type === 'item.delta' && m.delta === 'hi 262'));

    const undoRes = await reqJson('/sessions/codex_codex-native:undo', 'POST', { count: 1 });
    assert.equal(undoRes.status, 200);
    assert.equal((await undoRes.json() as any).data.removed_turn_ids.length, 1);
    await removedDone;

    // 3. 2.6.2 secondary endpoints
    assert.equal((await reqJson('/sessions/codex_codex-native:reload', 'POST', {})).status, 200);
    assert.deepEqual((await (await reqJson('/sessions/codex_codex-native/file-history/changes')).json() as any).data, { recorded: false, changes: [] });
    assert.deepEqual((await (await reqJson('/sessions/codex_codex-native/fs:pull_request:batch', 'POST', { roots: [wsDir] })).json() as any).data, { results: {}, errors: {} });

    const gitBatchRes = await reqJson('/sessions/codex_codex-native/fs:git_status:batch', 'POST', { roots: [subDir, outsideDir] });
    assert.equal(gitBatchRes.status, 200);
    const gitBatch = (await gitBatchRes.json() as any).data;
    assert.ok(gitBatch.results[subDir]);
    assert.equal(gitBatch.errors[outsideDir]?.code, 40301);

    assert.deepEqual((await (await reqJson('/workspaces/project-config-dirs')).json() as any).data, { additional_dirs: [] });
    assert.deepEqual((await (await reqJson('/workspaces/wd_test/trust')).json() as any).data, { trusted: true });
    assert.deepEqual((await (await reqJson('/workspaces/wd_test/trust', 'POST', {})).json() as any).data, { trusted: true });
    assert.equal((await reqJson('/workspaces/wd_test/primary', 'POST', { path: wsDir })).status, 200);
  } finally {
    wsV2?.close();
    ws262?.close();
    await gateway.close();
    await rm(wsDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('adapts Web UI slash menus, colon/attachment skill activation, extension notices, and per-provider commands', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'gw-web-cmds-'));
  const calls: string[] = [];
  let reviewCalls: any[] = [];
  const codex = fakeAdapter('codex');
  codex.getCwd = () => cwd;
  codex.listSkills = async () => [
    { name: 'proj-skill', description: 'Project skill', path: join(cwd, 'SKILL.md'), scope: 'project', enabled: true },
    { name: 'status', description: 'Duplicate xM status', path: join(cwd, 'DUP.md'), scope: 'user', enabled: true },
  ];
  codex.listCommands = async () => [
    { name: 'new', description: 'New', kind: 'client' },
    { name: 'compact', description: 'Compact', kind: 'prompt', acceptsInput: false },
    { name: 'review', description: 'Review code', kind: 'prompt', acceptsInput: true, argumentHint: '[instructions]' },
    { name: 'goal', description: 'Goal', kind: 'prompt', acceptsInput: true, argumentHint: '<objective> | status' },
    { name: 'diff', description: 'Git diff', kind: 'prompt', acceptsInput: false },
    { name: 'help', description: 'Help', kind: 'prompt', acceptsInput: false },
  ];
  codex.review = async (_id: string, opts?: any) => {
    reviewCalls.push(opts);
    return {
      turnId: 'rev-turn',
      events: (async function* () {
        yield { sessionId: 'codex-native', turnId: 'rev-turn', kind: 'message', status: 'delta', timestamp: Date.now(), payload: { delta: 'review-ok' } } as any;
        yield { sessionId: 'codex-native', turnId: 'rev-turn', kind: 'turn', status: 'completed', timestamp: Date.now(), payload: { reason: 'completed' } } as any;
      })(),
    };
  };
  let savedGoal: Record<string, unknown> | null = null;
  codex.setGoal = async (_id, obj) => { savedGoal = { goalId: 'g1', objective: obj, status: 'active' }; return savedGoal; };
  codex.getGoal = async () => savedGoal;
  codex.controlGoal = async (_id, ctrl) => { savedGoal = ctrl === 'cancel' ? null : { ...savedGoal, status: ctrl === 'pause' ? 'paused' : 'active' }; return savedGoal; };
  codex.cleanTerminals = async () => { calls.push('codex.cleanTerminals'); };
  codex.gitDiff = async () => ({ sha: 'abc123', diff: 'diff --git a/a.ts b/a.ts\n+hi\n' });

  const claude = fakeAdapter('claude');
  claude.getCwd = () => cwd;
  claude.listCommands = async () => [
    { name: 'compact', description: 'Compact', kind: 'prompt', builtin: true },
    { name: 'color', description: 'Terminal color', kind: 'prompt', builtin: true, terminalOnly: true },
    { name: 'sub:deploy', description: 'Sub command', kind: 'prompt', path: '/tmp/sub/deploy.md', scope: 'user' },
    { name: 'status', description: 'Status', kind: 'prompt', builtin: true },
    { name: 'help', description: 'Help', kind: 'prompt', builtin: true },
  ];
  const claudeStarted: StartTurnInput[] = [];
  claude.startTurn = async (input: StartTurnInput) => {
    claudeStarted.push(input);
    return {
      turnId: 'cl-turn',
      events: (async function* () {
        yield { sessionId: 'claude-native', turnId: 'cl-turn', kind: 'message', status: 'delta', timestamp: Date.now(), payload: { delta: 'claude-ok' } } as any;
        yield { sessionId: 'claude-native', turnId: 'cl-turn', kind: 'turn', status: 'completed', timestamp: Date.now(), payload: { reason: 'completed' } } as any;
      })(),
    };
  };

  const grok = fakeAdapter('grok');
  grok.getCwd = () => cwd;
  (grok as any).capabilities = () => ({ ...capabilities, compact: true, rollback: true, fork: true, goals: true });
  const grokStarted: string[] = [];
  grok.startTurn = async (input: StartTurnInput) => {
    grokStarted.push(String(input.input));
    return {
      turnId: 'gr-turn',
      events: (async function* () {
        yield { sessionId: 'grok-native', turnId: 'gr-turn', kind: 'turn', status: 'completed', timestamp: Date.now(), payload: { reason: 'completed' } } as any;
      })(),
    };
  };

  const pi = fakeAdapter('pi') as any;
  pi.getCwd = () => cwd;
  pi.setAutoCompaction = async (_id: string, enabled: boolean) => { calls.push(`pi.auto:${enabled}`); return enabled; };
  pi.getAutoCompaction = async () => false;
  pi.getLastAssistantText = async () => 'Last Pi reply body';
  pi.getSessionTree = async () => ({ leafId: 'n2', tree: [{ entry: { id: 'n1', type: 'message', message: { role: 'user' } }, children: [{ entry: { id: 'n2', type: 'message', message: { role: 'assistant' } }, children: [] }] }] });
  pi.getSessionStats = async () => ({ userMessages: 2, assistantMessages: 2, toolCalls: 1, tokens: { input: 100, output: 50, cacheRead: 20 }, cost: 0.01, contextUsage: { tokens: 150, contextWindow: 1000, percent: 15 } });
  pi.rename = async (_id: string, title: string) => { calls.push(`pi.rename:${title}`); };
  pi.startTurn = async (input: StartTurnInput) => {
    calls.push(`pi.turn:${String(input.input)}`);
    return {
      turnId: 'pi-mcp-turn',
      events: (async function* () {
        yield { sessionId: 'pi-native', turnId: 'pi-mcp-turn', kind: 'notice', status: 'completed', timestamp: Date.now(), payload: { level: 'info', message: 'MCP server ready' } } as any;
        yield { sessionId: 'pi-native', turnId: 'pi-mcp-turn', kind: 'turn', status: 'completed', timestamp: Date.now(), payload: { reason: 'completed' } } as any;
      })(),
    };
  };

  const gateway = await startGateway({
    port: 0, token: 'gw-tok', kimi: 'off',
    codex: codex as any, claude: claude as any, grok: grok as any, pi,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });
  const reqJson = (p: string, method = 'GET', body?: unknown) => fetch(`${gateway.url}/api/v1${p}`, {
    method,
    headers: { authorization: 'Bearer gw-tok', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  try {
    // 1. /skills strips Kimi xM duplicates, hides terminalOnly, avoids /skill: prefix for built-ins, sets workspace_dir for project skills
    const codexSkills = (await (await reqJson('/sessions/codex_codex-native/skills')).json() as any).data.skills;
    assert.equal(codexSkills.some((s: any) => s.name === 'compact' || s.name === 'goal' || s.name === 'status'), false);
    const reviewSkill = codexSkills.find((s: any) => s.name === 'review');
    assert.equal(reviewSkill?.source, 'builtin');
    assert.equal(reviewSkill?.argument_hint, '[instructions]');
    const projSkill = codexSkills.find((s: any) => s.name === 'proj-skill');
    assert.equal(projSkill?.source, 'project');
    assert.equal(projSkill?.workspace_dir, cwd);

    const claudeSkills = (await (await reqJson('/sessions/claude_claude-native/skills')).json() as any).data.skills;
    assert.equal(claudeSkills.some((s: any) => s.name === 'color'), false);
    assert.equal(claudeSkills.find((s: any) => s.name === 'sub:deploy')?.source, 'user');

    // 2. Colon command :activate + attachment forwarding
    const actRes = await reqJson('/sessions/claude_claude-native/skills/sub%3Adeploy:activate', 'POST', {
      args: 'prod',
      attachments: [{ type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'AA==' } }],
    });
    assert.equal(actRes.status, 200);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(claudeStarted[0]?.input, '/sub:deploy prod');
    assert.equal(claudeStarted[0]?.attachments?.[0]?.kind, 'imageDataUrl');

    // 3. Codex /review args + /goal + /diff + /terminals-clean + /help
    await reqJson('/sessions/codex_codex-native/skills/review:activate', 'POST', { args: 'check auth' });
    await reqJson('/sessions/codex_codex-native/skills/review:activate', 'POST', { args: '--base main' });
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(reviewCalls, [{ instructions: 'check auth' }, { target: { type: 'baseBranch', branch: 'main' } }]);
    for (const txt of ['/goal ship web ui', '/goal status', '/goal pause', '/diff', '/terminals-clean', '/help']) {
      assert.equal((await reqJson('/sessions/codex_codex-native/prompts', 'POST', { content: [{ type: 'text', text: txt }] })).status, 200);
    }
    assert.ok(calls.includes('codex.cleanTerminals'));
    const codexTr = (await (await reqJson('/sessions/codex_codex-native/transcript?agent_id=main&page_size=20')).json() as any).data.items;
    assert.ok(codexTr.some((t: any) => t.prompt === '/diff' && t.steps[0]?.frames[0]?.text.includes('diff --git a/a.ts')));

    // 4. Grok /status, /always-approve on, /feedback graceful interception (no LLM turn spawned!)
    for (const txt of ['/status', '/info', '/always-approve on', '/feedback hello', '/help']) {
      assert.equal((await reqJson('/sessions/grok_grok-native/prompts', 'POST', { content: [{ type: 'text', text: txt }] })).status, 200);
    }
    assert.equal(grokStarted.length, 0);
    assert.equal(grok.getPermission?.('grok-native'), 'yolo');

    // 5. Pi notice rendering (/mcp) + Pi RPC gateway commands (/auto-compact, /name, /thinking, /session, /copy, /tree, /settings)
    assert.equal((await reqJson('/sessions/pi_pi-native/prompts', 'POST', { content: [{ type: 'text', text: '/mcp' }] })).status, 200);
    await new Promise((r) => setTimeout(r, 40));
    for (const txt of ['/auto-compact on', '/name WebTitle', '/thinking high', '/session', '/copy', '/tree', '/settings', '/help']) {
      assert.equal((await reqJson('/sessions/pi_pi-native/prompts', 'POST', { content: [{ type: 'text', text: txt }] })).status, 200);
    }
    assert.ok(calls.includes('pi.auto:true'));
    assert.ok(calls.includes('pi.rename:WebTitle'));
    const piTr = (await (await reqJson('/sessions/pi_pi-native/transcript?agent_id=main&page_size=20')).json() as any).data.items;
    assert.ok(piTr.some((t: any) => t.prompt === '/mcp' && t.steps[0]?.frames[0]?.text.includes('MCP server ready')));
    assert.ok(piTr.some((t: any) => t.prompt === '/copy' && t.steps[0]?.frames[0]?.text.includes('Last Pi reply body')));
    assert.ok(piTr.some((t: any) => t.prompt === '/tree' && t.steps[0]?.frames[0]?.text.includes('当前叶节点')));

    // 6. Claude gateway-adapted commands + terminal-only fallback + /undo 400
    for (const txt of ['/status', '/diff', '/skills', '/permissions auto', '/tasks', '/help', '/theme']) {
      assert.equal((await reqJson('/sessions/claude_claude-native/prompts', 'POST', { content: [{ type: 'text', text: txt }] })).status, 200);
    }
    assert.equal(claude.getPermission?.('claude-native'), 'auto');
    assert.equal((await reqJson('/sessions/claude_claude-native/prompts', 'POST', { content: [{ type: 'text', text: '/undo' }] })).status, 400);

    // 7. runLocalGatewayCommand holds hub.busy so concurrent prompt queues and drains sequentially
    let releaseTree!: () => void;
    let treeEntered!: () => void;
    const treeWait = new Promise<void>((r) => { treeEntered = r; });
    pi.getSessionTree = async () => {
      treeEntered();
      await new Promise<void>((r) => { releaseTree = r; });
      return { leafId: 'n2', tree: [] };
    };
    const treeReq = reqJson('/sessions/pi_pi-native/prompts', 'POST', { content: [{ type: 'text', text: '/tree' }] });
    await treeWait;
    const queuedRes = await reqJson('/sessions/pi_pi-native/prompts', 'POST', { content: [{ type: 'text', text: 'follow up while busy' }] });
    assert.equal(queuedRes.status, 200);
    assert.equal(((await queuedRes.json()) as any).data.status, 'queued');
    releaseTree();
    assert.equal((await treeReq).status, 200);
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(calls.includes('pi.turn:follow up while busy'));

    // 8. /workspaces/:wid/skills passes workspace cwd so project skills include workspace_dir
    const wsList = (await (await reqJson('/workspaces?provider=codex')).json() as any).data.items as Array<{ id: string; root: string }>;
    assert.ok(wsList.length > 0);
    const targetWs = wsList[0]!;
    let capturedSkillCwd: string | undefined;
    codex.listSkills = async (_sid?: string, cwdArg?: string) => {
      capturedSkillCwd = cwdArg;
      return [{ name: 'ws-only', description: 'Workspace skill', path: join(targetWs.root, 'SKILL.md'), scope: 'project', enabled: true }];
    };
    const wsSkills = (await (await reqJson(`/workspaces/${encodeURIComponent(targetWs.id)}/skills?provider=codex`)).json() as any).data.skills;
    assert.equal(capturedSkillCwd, targetWs.root);
    assert.equal(wsSkills.find((s: any) => s.name === 'ws-only')?.workspace_dir, targetWs.root);

    // 9. /workspace/fs:list, /workspace/fs:suggest, and /fs:suggest work for local providers
    await writeFile(join(targetWs.root, 'alpha.ts'), 'export const alpha = 1;\n');
    const wsListFiles = await reqJson('/workspace/fs:list?provider=codex', 'POST', { workspace: targetWs.id, path: '.' });
    assert.equal(wsListFiles.status, 200);
    assert.ok(((await wsListFiles.json()) as any).data.items.some((e: any) => e.name === 'alpha.ts'));
    const wsSuggest = await reqJson('/workspace/fs:suggest?provider=codex', 'POST', { workspace: targetWs.id, query: 'alpha' });
    assert.equal(wsSuggest.status, 200);
    assert.ok(((await wsSuggest.json()) as any).data.items.some((e: any) => e.name === 'alpha.ts'));
    const rootSuggest = await reqJson('/fs:suggest?provider=codex', 'POST', { roots: [targetWs.root], query: 'alpha' });
    assert.equal(rootSuggest.status, 200);
    assert.ok(((await rootSuggest.json()) as any).data.items.some((e: any) => e.name === 'alpha.ts'));
  } finally {
    await gateway.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('local workspace creation returns full DTO, persists across restart, resolves workspace_id sessions, and config returns model map', async () => {
  const settingsDir = await mkdtemp(join(tmpdir(), 'multi-agent-ws-persist-'));
  const projDir = await mkdtemp(join(tmpdir(), 'multi-agent-ws-proj-'));
  const extraDir = await mkdtemp(join(tmpdir(), 'multi-agent-ws-extra-'));
  const auth = { authorization: 'Bearer gateway-token', 'content-type': 'application/json' };
  let capturedCreateCwd: string | undefined;
  const makeGateway = () => {
    const codex = fakeAdapter('codex');
    const origCreate = codex.create.bind(codex);
    codex.create = async (input) => {
      capturedCreateCwd = input.cwd;
      const s = await origCreate(input);
      return { ...s, metadata: { ...s.metadata, cwd: input.cwd ?? s.metadata.cwd } };
    };
    return startGateway({
      port: 0,
      token: 'gateway-token',
      kimi: 'off',
      settingsDir,
      codex: codex as any,
      claude: fakeAdapter('claude') as any,
      grok: fakeAdapter('grok') as any,
      pi: fakeAdapter('pi') as any,
      availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
    });
  };
  let gw = await makeGateway();
  try {
    // 1. POST /workspaces returns Kimi 2.6.2 fields (including additional_dirs array and managed kind)
    const createRes = await fetch(`${gw.url}/api/v1/workspaces?provider=codex`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ root: projDir, name: 'GitHub', additional_dirs: [extraDir] }),
    });
    assert.equal(createRes.status, 200);
    const created = ((await createRes.json()) as any).data;
    assert.ok(created.id.startsWith('wd_'));
    assert.equal(created.root, projDir);
    assert.equal(created.name, 'GitHub');
    assert.equal(created.kind, 'managed');
    assert.deepEqual(created.additional_dirs, [extraDir]);
    assert.equal(created.session_count, 0);
    assert.equal(typeof created.last_opened_at, 'string');

    // Empty root rejected with 400
    const badCreate = await fetch(`${gw.url}/api/v1/workspaces?provider=codex`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ root: '   ' }),
    });
    assert.equal(badCreate.status, 400);

    // 2. PATCH updates name and additional_dirs
    const patchRes = await fetch(`${gw.url}/api/v1/workspaces/${encodeURIComponent(created.id)}?provider=codex`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ name: 'GitHubRenamed', additional_dirs: [] }),
    });
    assert.equal(patchRes.status, 200);
    const patched = ((await patchRes.json()) as any).data;
    assert.equal(patched.name, 'GitHubRenamed');
    assert.deepEqual(patched.additional_dirs, []);

    // 3. /api/v1/config returns models as a keyed dictionary (matching Kimi schema)
    const cfgRes = await fetch(`${gw.url}/api/v1/config?provider=codex`, { headers: auth });
    assert.equal(cfgRes.status, 200);
    const cfg = ((await cfgRes.json()) as any).data;
    assert.equal(Array.isArray(cfg.models), false);
    assert.equal(typeof cfg.models, 'object');

    // 4. Restart gateway and verify managed workspace persists and resolves workspace_id -> cwd on session create
    await gw.close();
    gw = await makeGateway();
    const listRes = await fetch(`${gw.url}/api/v1/workspaces?provider=codex`, { headers: auth });
    assert.equal(listRes.status, 200);
    const items = ((await listRes.json()) as any).data.items as Array<Record<string, unknown>>;
    const persisted = items.find((w) => w.id === created.id);
    assert.ok(persisted);
    assert.equal(persisted.name, 'GitHubRenamed');
    assert.equal(persisted.kind, 'managed');
    assert.deepEqual(persisted.additional_dirs, []);

    const sessRes = await fetch(`${gw.url}/api/v1/sessions?provider=codex`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ workspace_id: created.id }),
    });
    assert.equal(sessRes.status, 200);
    const sess = ((await sessRes.json()) as any).data;
    assert.equal(sess.metadata?.cwd, projDir);

    // 5. DELETE removes persisted workspace
    const delRes = await fetch(`${gw.url}/api/v1/workspaces/${encodeURIComponent(created.id)}?provider=codex`, {
      method: 'DELETE',
      headers: auth,
    });
    assert.equal(delRes.status, 200);
    const afterDel = ((await (await fetch(`${gw.url}/api/v1/workspaces?provider=codex`, { headers: auth })).json()) as any).data.items;
    assert.equal(afterDel.some((w: any) => w.id === created.id), false);
  } finally {
    await gw.close();
    await rm(settingsDir, { recursive: true, force: true });
    await rm(projDir, { recursive: true, force: true });
    await rm(extraDir, { recursive: true, force: true });
  }
});

test('2.6.2 skill chip stripping, thinking config/PATCH, wireModelDto off dedup, subagent drawer turns, and normalized Bash/Agent cards', async () => {
  const startedInputs: Array<{ provider: string; input: string }> = [];
  const defaultThinking = new Map<string, string>();
  const makeTestAdapter = (name: 'codex' | 'claude' | 'grok' | 'pi') => {
    const base = fakeAdapter(name);
    const origSetThinking = base.setThinking!.bind(base);
    const origGetThinking = base.getThinking!.bind(base);
    base.setThinking = async (sid, level) => {
      if (sid === '__default__') { defaultThinking.set(name, level); return; }
      await origSetThinking(sid, level);
    };
    base.getThinking = (sid) => origGetThinking(sid) ?? defaultThinking.get(name);
    const origStart = base.startTurn.bind(base);
    base.startTurn = async (inp) => {
      startedInputs.push({ provider: name, input: typeof inp.input === 'string' ? inp.input : '' });
      return origStart(inp);
    };
    return base;
  };

  const codex = makeTestAdapter('codex');
  const claude = makeTestAdapter('claude');
  const grok = makeTestAdapter('grok');
  const pi = makeTestAdapter('pi');

  pi.listModels = async () => [
    {
      provider: 'pi',
      model: 'ccwu/gemini-3.8-flash',
      display_name: 'Gemini 3.8 Flash',
      max_context_size: 1_000_000,
      capabilities: ['vision', 'thinking'],
      support_efforts: ['off', 'minimal', 'low', 'medium', 'high'],
      supportsThinkingOff: true,
    },
    {
      provider: 'pi',
      model: 'kimi-coding/k3',
      display_name: 'Kimi K3',
      max_context_size: 1_000_000,
      capabilities: ['vision', 'thinking'],
      support_efforts: ['low', 'high', 'max'],
      supportsThinkingOff: false,
    },
  ];

  codex.getHistory = async () => [
    {
      id: 'm1',
      session_id: 'codex-native',
      role: 'user',
      content: [{ type: 'text', text: 'inspect repo' }],
      created_at: '2026-11-15T08:00:00.000Z',
    },
    {
      id: 'm2',
      session_id: 'codex-native',
      role: 'assistant',
      content: [
        { type: 'tool_use', tool_call_id: 'call_bash_1', tool_name: 'commandExecution', input: { command: 'ls -la', cwd: '/tmp' } },
        { type: 'tool_result', tool_call_id: 'call_bash_1', output: 'README.md', is_error: false },
        { type: 'tool_use', tool_call_id: 'call_sub_1', tool_name: 'spawn_agent', input: { message: 'Analyze ovis', agent_type: 'explore' } },
        { type: 'tool_result', tool_call_id: 'call_sub_1', output: 'agent_id: sub-thread-1\nDone', is_error: false },
      ],
      created_at: '2026-11-15T08:00:02.000Z',
    },
  ];
  codex.listSubagents = async () => [{ agentId: 'sub-thread-1', parentToolUseId: 'call_sub_1', description: 'Analyze ovis', subagentType: 'explore' }];
  codex.getSubagentMessages = async (_sid, agentId) => agentId === 'sub-thread-1'
    ? [
        {
          id: 'sm1',
          session_id: 'sub-thread-1',
          role: 'user',
          content: [{ type: 'text', text: 'Analyze ovis' }],
          created_at: '2026-11-15T08:00:01.000Z',
        },
        {
          id: 'sm2',
          session_id: 'sub-thread-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Found HerdrSocket ping probe.' }],
          created_at: '2026-11-15T08:00:02.000Z',
        },
      ]
    : [];

  let emitLiveEvents = false;
  const origCodexStart = codex.startTurn.bind(codex);
  codex.startTurn = async (inp) => {
    if (!emitLiveEvents) return origCodexStart(inp);
    return {
      turnId: 'live-turn-1',
      events: (async function* () {
        yield {
          kind: 'tool',
          status: 'started',
          sessionId: inp.sessionId,
          turnId: 'live-turn-1',
          timestamp: Date.now(),
          payload: { toolCallId: 'live_bash_1', name: 'exec_command', input: { cmd: 'pwd' } },
        };
        yield {
          kind: 'tool',
          status: 'completed',
          sessionId: inp.sessionId,
          turnId: 'live-turn-1',
          timestamp: Date.now(),
          payload: { toolCallId: 'live_bash_1', name: 'exec_command', output: '/tmp', is_error: false },
        };
        yield {
          kind: 'tool',
          status: 'started',
          sessionId: inp.sessionId,
          turnId: 'live-turn-1',
          timestamp: Date.now(),
          payload: { toolCallId: 'live_sub_call', name: 'spawn_agent', input: { prompt: 'Check pi-web' } },
        };
        yield {
          kind: 'subagent',
          status: 'started',
          sessionId: inp.sessionId,
          turnId: 'live-turn-1',
          timestamp: Date.now(),
          agentId: 'sub-live-99',
          parentToolUseId: 'live_sub_call',
          payload: { agentId: 'sub-live-99', parentToolUseId: 'live_sub_call', summary: 'Check pi-web' },
        };
        yield {
          kind: 'tool',
          status: 'completed',
          sessionId: inp.sessionId,
          turnId: 'live-turn-1',
          timestamp: Date.now(),
          payload: { toolCallId: 'live_sub_call', name: 'spawn_agent', output: 'done', is_error: false },
        };
        yield { kind: 'turn', status: 'completed', sessionId: inp.sessionId, turnId: 'live-turn-1', timestamp: Date.now(), payload: { reason: 'completed' } };
      })(),
    };
  };

  const upstream = await listen(createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url?.includes('/config')) {
      return res.end(JSON.stringify({ thinking: { enabled: true, effort: 'xhigh' }, providers: {} }));
    }
    res.end(JSON.stringify({}));
  }));

  const gw = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: { upstream: upstream.url, token: 'upstream-token' },
    codex: codex as any,
    claude: claude as any,
    grok: grok as any,
    pi: pi as any,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });

  const reqJson = (path: string, method = 'GET', body?: unknown) => fetch(`${gw.url}/api/v1${path}`, {
    method,
    headers: {
      authorization: 'Bearer gateway-token',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  let ws: WebSocket | undefined;
  try {
    // 1. Skill mention chips stripped cleanly on :activate and /prompts
    assert.equal((await reqJson('/sessions/grok_grok-native/skills/workflow:activate', 'POST', {
      args: '[workflow](kimi-code://skill/workflow)',
    })).status, 200);
    assert.equal((await reqJson('/sessions/pi_pi-native/skills/thinking:activate', 'POST', {
      args: '[thinking](kimi-code://skill/thinking?path=%2Ftmp) high',
    })).status, 200);
    assert.equal((await reqJson('/sessions/claude_claude-native/prompts', 'POST', {
      content: [{ type: 'text', text: '/effort [effort](kimi-code://skill/effort) high' }],
    })).status, 200);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(startedInputs.find((x) => x.provider === 'grok')?.input, '/workflow');
    assert.equal(pi.getThinking?.('pi-native'), 'high');
    assert.equal(startedInputs.find((x) => x.provider === 'claude')?.input, '/effort high');
    assert.equal((await reqJson('/sessions/claude_claude-native/prompts', 'POST', {
      content: [{ type: 'text', text: '先执行\n/effort [effort](kimi-code://skill/effort)' }],
    })).status, 200);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(
      startedInputs.filter((x) => x.provider === 'claude').at(-1)?.input,
      '先执行\n/effort',
    );

    // 2. PATCH /sessions/:id + /config thinking object handling (never leaks Kimi's xhigh)
    const cfgBefore = ((await (await reqJson('/config?provider=codex')).json()) as any).data;
    assert.equal(cfgBefore.thinking, undefined);
    const cfgSet = await reqJson('/config?provider=codex', 'POST', { thinking: { enabled: true, effort: 'low' } });
    assert.equal(cfgSet.status, 200);
    assert.deepEqual(((await cfgSet.json()) as any).data.thinking, { enabled: true, effort: 'low' });
    assert.equal(codex.getThinking?.('codex-native'), 'low');

    const patchSess = await reqJson('/sessions/codex_codex-native', 'PATCH', { thinking: 'high' });
    assert.equal(patchSess.status, 200);
    assert.equal(codex.getThinking?.('codex-native'), 'high');

    // 3. Pi wireModelDto strips duplicate 'off' from support_efforts and adds always_thinking when supportsThinkingOff=false
    const piModels = ((await (await reqJson('/models?provider=pi')).json()) as any).data.items as Array<Record<string, any>>;
    const flash = piModels.find((m) => m.model === 'ccwu/gemini-3.8-flash');
    const k3 = piModels.find((m) => m.model === 'kimi-coding/k3');
    assert.deepEqual(flash?.support_efforts, ['minimal', 'low', 'medium', 'high']);
    assert.equal(flash?.capabilities.includes('always_thinking'), false);
    assert.equal(k3?.capabilities.includes('always_thinking'), true);

    // 4. Normalized Bash/Agent items + subagent drawer /agents/:id/turns + /tasks + snapshot.subagents
    const mainTurns = ((await (await reqJson('/sessions/codex_codex-native/agents/main/turns')).json()) as any).data.turns;
    const tools = mainTurns[0].items.filter((it: any) => it.type === 'tool_call');
    assert.equal(tools[0].name, 'Bash');
    assert.equal(tools[0].input.command, 'ls -la');
    assert.equal(tools[1].name, 'Agent');
    assert.deepEqual(tools[1].agent_refs, [{ agent_id: 'sub-thread-1', role: 'child' }]);

    const subTurnsRes = await reqJson('/sessions/codex_codex-native/agents/sub-thread-1/turns');
    assert.equal(subTurnsRes.status, 200);
    const subTurns = ((await subTurnsRes.json()) as any).data.turns;
    assert.equal(subTurns.length, 1);
    assert.equal(subTurns[0].items[0].text, 'Analyze ovis');
    assert.equal(subTurns[0].items[1].text, 'Found HerdrSocket ping probe.');

    const tasksList = ((await (await reqJson('/sessions/codex_codex-native/tasks')).json()) as any).data.items;
    assert.equal(tasksList.length, 1);
    assert.equal(tasksList[0].child_agent_id, 'sub-thread-1');

    const snap = ((await (await reqJson('/sessions/codex_codex-native/snapshot')).json()) as any).data;
    assert.equal(snap.subagents.length, 1);
    assert.equal(snap.subagents[0].agent_id, 'sub-thread-1');

    // 5. Gateway local command avoids duplicate t2 turn after history already observed
    assert.equal((await reqJson('/sessions/codex_codex-native/prompts', 'POST', { content: [{ type: 'text', text: '/status' }] })).status, 200);
    const trAfterCmd = ((await (await reqJson('/sessions/codex_codex-native/transcript?agent_id=main&page_size=20')).json()) as any).data;
    assert.deepEqual(trAfterCmd.items.map((t: any) => t.turnId), ['t1', 't2']);

    // 6. WS subscribe: agent omits unset thinking, sends task.list, handles ping->pong, and streams live Bash/Agent + item.updated(agent_refs)
    const frames: Array<Record<string, any>> = [];
    let gotSub!: () => void;
    let gotPong!: () => void;
    let gotTurnEnd!: () => void;
    const subReady = new Promise<void>((r) => { gotSub = r; });
    const pongReady = new Promise<void>((r) => { gotPong = r; });
    const liveDone = new Promise<void>((r) => { gotTurnEnd = r; });

    ws = new WebSocket(`${gw.url.replace(/^http/, 'ws')}/api/v1/ws?provider=claude`, ['kimi-code.bearer.gateway-token']);
    ws.onopen = () => ws!.send(JSON.stringify({ type: 'subscribe', request_id: 's1', session_id: 'claude_claude-native' }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      frames.push(m);
      if (m.type === 'task.list') gotSub();
      if (m.type === 'pong') gotPong();
    };
    await subReady;
    const claudeAgentFrame = frames.find((f) => f.type === 'agent');
    assert.equal(Object.prototype.hasOwnProperty.call(claudeAgentFrame, 'thinking'), false);

    ws.send(JSON.stringify({ type: 'ping' }));
    await pongReady;
    ws.close();

    emitLiveEvents = true;
    const codexFrames: Array<Record<string, any>> = [];
    let codexSub!: () => void;
    const codexSubReady = new Promise<void>((r) => { codexSub = r; });
    ws = new WebSocket(`${gw.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`, ['kimi-code.bearer.gateway-token']);
    ws.onopen = () => ws!.send(JSON.stringify({ type: 'subscribe', request_id: 's2', session_id: 'codex_codex-native' }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      codexFrames.push(m);
      if (m.type === 'task.list') codexSub();
      if (m.type === 'turn.ended') gotTurnEnd();
    };
    await codexSubReady;
    assert.equal((await reqJson('/sessions/codex_codex-native/prompts', 'POST', { content: [{ type: 'text', text: 'run live' }] })).status, 200);
    await liveDone;

    assert.ok(codexFrames.some((f) => f.type === 'item.started' && f.item?.name === 'Bash' && f.item?.input?.command === 'pwd'));
    assert.ok(codexFrames.some((f) => f.type === 'item.started' && f.item?.name === 'Agent' && f.item?.item_id === 'live_sub_call'));
    assert.ok(codexFrames.some((f) => f.type === 'item.updated' && f.item_id === 'live_sub_call' && f.set?.agent_refs?.[0]?.agent_id === 'sub-live-99'));
    assert.ok(codexFrames.some((f) => f.type === 'task' && f.child_agent_id === 'sub-live-99'));
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    await gw.close();
    await upstream.close();
  }
});

test('activeKimiTier1Names dynamically computes Tier-1 slash commands based on capabilities', () => {
  // Always present: new, clear, login, reload, export, status
  const base = activeKimiTier1Names();
  assert.deepEqual([...base].sort(), ['clear', 'export', 'login', 'new', 'reload', 'status']);

  // If caps.planMode === false (e.g. Pi) or caps.goals === false (e.g. Claude), plan/goal are not suppressed
  const piCaps: ProviderCapabilities = {
    ...capabilities,
    planMode: false,
    goals: false,
    tower: false,
    swarm: false,
    btw: false,
    compact: true,
    rollback: false,
    fork: true,
  };
  const piTier1 = activeKimiTier1Names(piCaps);
  assert.equal(piTier1.has('plan'), false);
  assert.equal(piTier1.has('goal'), false);
  assert.equal(piTier1.has('tower'), false);
  assert.equal(piTier1.has('swarm'), false);
  assert.equal(piTier1.has('btw'), false);
  assert.equal(piTier1.has('undo'), false);
  assert.equal(piTier1.has('compact'), true);
  assert.equal(piTier1.has('fork'), true);

  // If caps advertise full capabilities
  const fullCaps: ProviderCapabilities = {
    ...capabilities,
    planMode: true,
    goals: true,
    tower: true,
    swarm: true,
    btw: true,
    compact: true,
    rollback: true,
    fork: true,
  };
  const fullTier1 = activeKimiTier1Names(fullCaps);
  assert.equal(fullTier1.has('plan'), true);
  assert.equal(fullTier1.has('goal'), true);
  assert.equal(fullTier1.has('tower'), true);
  assert.equal(fullTier1.has('swarm'), true);
  assert.equal(fullTier1.has('btw'), true);
  assert.equal(fullTier1.has('compact'), true);
  assert.equal(fullTier1.has('undo'), true);
  assert.equal(fullTier1.has('fork'), true);
});

test('/meta always returns provider_capabilities and overrides experimental_flags per provider', async () => {
  const codex = fakeAdapter('codex');
  codex.capabilities = () => ({ ...capabilities, planMode: true, goals: true, tower: false, swarm: false });
  const claude = fakeAdapter('claude');
  const grok = fakeAdapter('grok');
  const pi = fakeAdapter('pi');

  // Upstream with experimental_flags (tower: true, swarm: true)
  const upstream = createServer((req, res) => {
    if (req.url === '/api/v1/meta') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        code: 0,
        data: {
          upstream: true,
          experimental_flags: { tower: true, swarm: true, custom_flag: 'keep-me' },
        },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = (upstream.address() as any).port;

  const gw = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: { upstream: `http://127.0.0.1:${upstreamPort}`, token: 'up-tok' },
    codex: codex as any,
    claude: claude as any,
    grok: grok as any,
    pi: pi as any,
    availableProviders: ['kimi', 'codex', 'claude', 'grok', 'pi'],
  });

  const getMeta = async (query = '') => {
    const res = await fetch(`${gw.url}/api/v1/meta${query}`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    return (await res.json() as any).data;
  };

  try {
    // 1. Base /meta includes provider_capabilities for all local providers
    const baseMeta = await getMeta();
    assert.ok(baseMeta.provider_capabilities);
    assert.deepEqual(baseMeta.provider_capabilities.codex, codex.capabilities());
    assert.deepEqual(baseMeta.provider_capabilities.claude, claude.capabilities());
    assert.deepEqual(baseMeta.provider_capabilities.grok, grok.capabilities());
    assert.deepEqual(baseMeta.provider_capabilities.pi, pi.capabilities());
    // Upstream flags untouched when no provider specified
    assert.equal(baseMeta.experimental_flags?.tower, true);

    // 2. ?provider=pi overrides experimental_flags based on Pi capabilities (tower: false, plan: false, goal: false)
    const piMeta = await getMeta('?provider=pi');
    assert.equal(piMeta.experimental_flags.tower, false);
    assert.equal(piMeta.experimental_flags.swarm, false);
    assert.equal(piMeta.experimental_flags.subagent_fork, false);
    assert.equal(piMeta.experimental_flags.notify_user, false);
    assert.equal(piMeta.experimental_flags.wait_for, false);
    assert.equal(piMeta.experimental_flags['tool-select'], false);
    assert.equal(piMeta.experimental_flags.plan, false);
    assert.equal(piMeta.experimental_flags.goal, false);
    assert.equal(piMeta.experimental_flags.custom_flag, 'keep-me');

    // 3. ?provider=codex sets plan: true, goal: true according to codex capabilities
    const codexMeta = await getMeta('?provider=codex');
    assert.equal(codexMeta.experimental_flags.plan, true);
    assert.equal(codexMeta.experimental_flags.goal, true);
    assert.equal(codexMeta.experimental_flags.tower, false);
    assert.equal(codexMeta.experimental_flags.swarm, false);
  } finally {
    await gw.close();
    await upstream.close();
  }
});

test('POST /sessions/:id:undo supports turn_id and rejects non-main agent_id', async () => {
  const codex = fakeAdapter('codex') as any;
  codex.capabilities = () => ({ ...capabilities, rollback: true });

  const rollbackCalls: number[] = [];
  codex.rollback = async (_id: string, count: number) => {
    rollbackCalls.push(count);
  };

  // Fake history with 3 user turns
  codex.getHistory = async () => [
    { id: 'msg-1', session_id: 'codex-native', role: 'user', content: [{ type: 'text', text: 'turn 1' }], created_at: new Date(1000).toISOString() },
    { id: 'msg-1-res', session_id: 'codex-native', role: 'assistant', content: [{ type: 'text', text: 'reply 1' }], created_at: new Date(2000).toISOString() },
    { id: 'msg-2', session_id: 'codex-native', role: 'user', content: [{ type: 'text', text: 'turn 2' }], created_at: new Date(3000).toISOString() },
    { id: 'msg-2-res', session_id: 'codex-native', role: 'assistant', content: [{ type: 'text', text: 'reply 2' }], created_at: new Date(4000).toISOString() },
    { id: 'msg-3', session_id: 'codex-native', role: 'user', content: [{ type: 'text', text: 'turn 3' }], created_at: new Date(5000).toISOString() },
    { id: 'msg-3-res', session_id: 'codex-native', role: 'assistant', content: [{ type: 'text', text: 'reply 3' }], created_at: new Date(6000).toISOString() },
  ];

  const gw = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: codex as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
  });

  const postUndo = async (body: Record<string, unknown>) => {
    const res = await fetch(`${gw.url}/api/v1/sessions/codex_codex-native:undo`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer gateway-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as any };
  };

  try {
    // 1. Non-main agent_id must throw 400 with '仅支持撤销主会话轮次'
    const nonMain = await postUndo({ agent_id: 'subagent-1', turn_id: 'hist_msg-2' });
    assert.equal(nonMain.status, 400);
    assert.match(nonMain.json.msg ?? '', /仅支持撤销主会话轮次/);

    // 2. Matching turn_id = 'hist_msg-2' (turn 2 of 3) rolls back 2 turns
    const undo2 = await postUndo({ agent_id: 'main', turn_id: 'hist_msg-2' });
    assert.equal(undo2.status, 200);
    assert.equal(undo2.json.data.undone, true);
    assert.equal(undo2.json.data.count, 2);
    assert.deepEqual(undo2.json.data.removed_turn_ids, ['hist_msg-2', 'hist_msg-3']);
    assert.deepEqual(rollbackCalls, [2]);

    // 3. Fallback to count 1 when turn_id is unknown
    const undoUnknown = await postUndo({ turn_id: 'non-existent' });
    assert.equal(undoUnknown.status, 200);
    assert.equal(undoUnknown.json.data.count, 1);
    assert.deepEqual(undoUnknown.json.data.removed_turn_ids, ['hist_msg-3']);
    assert.deepEqual(rollbackCalls, [2, 1]);

    // 4. Numeric count is preserved
    const undoCount = await postUndo({ count: 3 });
    assert.equal(undoCount.status, 200);
    assert.equal(undoCount.json.data.count, 3);
    assert.deepEqual(rollbackCalls, [2, 1, 3]);
  } finally {
    await gw.close();
  }
});

test('Pi skills strip skill: prefix in /skills and format /skill: in :activate, while extension commands stay /name', async () => {
  const pi = fakeAdapter('pi') as any;
  const startedTurns: StartTurnInput[] = [];

  pi.startTurn = async (input: StartTurnInput) => {
    startedTurns.push(input);
    return {
      turnId: 'pi-turn-1',
      events: (async function* () {
        yield { sessionId: 'pi-native', turnId: 'pi-turn-1', kind: 'turn', status: 'completed', timestamp: Date.now(), payload: { reason: 'completed' } } as any;
      })(),
    };
  };

  pi.listSkills = async () => [
    { name: 'skill:commit', description: 'Commit git changes', path: '/home/pi/.pi/skills/commit/SKILL.md', scope: 'user' },
    { name: 'push', description: 'Push to remote', path: '/home/pi/.pi/skills/push/SKILL.md', scope: 'project' },
  ];

  pi.listCommands = async () => [
    { name: 'skill:commit', description: 'Commit git changes', kind: 'prompt', source: 'skill' },
    { name: 'my-ext', description: 'My extension command', kind: 'prompt', source: 'extension' },
    { name: 'prompt-cmd', description: 'Prompt template', kind: 'prompt', source: 'prompt' },
    { name: 'builtin-cmd', description: 'Builtin command', kind: 'prompt', builtin: true },
  ];

  const gw = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: pi as any,
  });

  const req = async (path: string, method = 'GET', body?: Record<string, unknown>) => {
    const res = await fetch(`${gw.url}/api/v1${path}`, {
      method,
      headers: {
        authorization: 'Bearer gateway-token',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json() as any };
  };

  try {
    // 1. GET /sessions/pi_pi-native/skills:
    // - 'skill:commit' has 'skill:' stripped -> name is 'commit', source is 'user'
    // - extension, prompt, and builtin commands have source: 'builtin'
    const skillsRes = await req('/sessions/pi_pi-native/skills');
    assert.equal(skillsRes.status, 200);
    const skills = skillsRes.json.data.skills as any[];

    const commitSkill = skills.find((s) => s.name === 'commit');
    assert.ok(commitSkill, 'skill:commit should have leading skill: stripped to commit');
    assert.equal(commitSkill.source, 'user');

    const pushSkill = skills.find((s) => s.name === 'push');
    assert.ok(pushSkill);
    assert.equal(pushSkill.source, 'project');

    const extCmd = skills.find((s) => s.name === 'my-ext');
    assert.ok(extCmd);
    assert.equal(extCmd.source, 'builtin', 'extension commands must emit source: builtin');

    const promptCmd = skills.find((s) => s.name === 'prompt-cmd');
    assert.ok(promptCmd);
    assert.equal(promptCmd.source, 'builtin', 'prompt commands must emit source: builtin');

    const builtinCmd = skills.find((s) => s.name === 'builtin-cmd');
    assert.ok(builtinCmd);
    assert.equal(builtinCmd.source, 'builtin', 'builtin commands must emit source: builtin');

    // 2. POST /sessions/pi_pi-native/skills/commit:activate synthesizes /skill:commit
    const actCommit = await req('/sessions/pi_pi-native/skills/commit:activate', 'POST', { args: '-m "feat: login"' });
    assert.equal(actCommit.status, 200);
    assert.equal(actCommit.json.data.activated, true);
    assert.equal(startedTurns[0]?.input, '/skill:commit -m "feat: login"');

    // 3. POST /sessions/pi_pi-native/skills/skill%3Acommit:activate also formats /skill:commit (single prefix)
    const actPrefixed = await req('/sessions/pi_pi-native/skills/skill%3Acommit:activate', 'POST');
    assert.equal(actPrefixed.status, 200);
    assert.equal(startedTurns[1]?.input, '/skill:commit');

    // 4. POST /sessions/pi_pi-native/skills/my-ext:activate stays /my-ext (NOT /skill:my-ext)
    const actExt = await req('/sessions/pi_pi-native/skills/my-ext:activate', 'POST', { args: 'arg1' });
    assert.equal(actExt.status, 200);
    assert.equal(startedTurns[2]?.input, '/my-ext arg1');
  } finally {
    await gw.close();
  }
});

test('POST /sessions/:id:undo matches live turn_<promptId> via opener prompt_ids, and Pi collided skill vs extension coexist', async () => {
  const codex = fakeAdapter('codex') as any;
  codex.capabilities = () => ({ ...capabilities, rollback: true });
  const rollbackCalls: number[] = [];
  codex.rollback = async (_id: string, count: number) => {
    rollbackCalls.push(count);
  };
  codex.getHistory = async () => [
    { id: 'm1', session_id: 'codex-native', role: 'user', content: [{ type: 'text', text: 'first' }], metadata: { prompt_id: 'p-live-1' }, created_at: new Date(1000).toISOString() },
    { id: 'm2', session_id: 'codex-native', role: 'assistant', content: [{ type: 'text', text: 'r1' }], created_at: new Date(2000).toISOString() },
    { id: 'm3', session_id: 'codex-native', role: 'user', content: [{ type: 'text', text: 'second' }], metadata: { prompt_id: 'p-live-2' }, created_at: new Date(3000).toISOString() },
    { id: 'm4', session_id: 'codex-native', role: 'assistant', content: [{ type: 'text', text: 'r2' }], created_at: new Date(4000).toISOString() },
  ];

  const pi = fakeAdapter('pi') as any;
  const piStarted: StartTurnInput[] = [];
  pi.startTurn = async (input: StartTurnInput) => {
    piStarted.push(input);
    return {
      turnId: 'pi-t1',
      events: (async function* () {
        yield { sessionId: 'pi-native', turnId: 'pi-t1', kind: 'turn', status: 'completed', timestamp: Date.now(), payload: { reason: 'completed' } } as any;
      })(),
    };
  };
  pi.listSkills = async () => [
    { name: 'skill:until-done', description: 'Skill doc', path: '/tmp/skills/until-done/SKILL.md', scope: 'user' },
  ];
  pi.listCommands = async () => [
    { name: 'until-done', description: 'Extension loop command', kind: 'prompt', source: 'extension' },
    { name: 'skill:until-done', description: 'Skill doc', kind: 'prompt', source: 'skill' },
  ];

  const gw = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: codex as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: pi as any,
  });

  try {
    const undoRes = await fetch(`${gw.url}/api/v1/sessions/codex_codex-native:undo`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'main', turn_id: 'turn_p-live-1' }),
    });
    assert.equal(undoRes.status, 200);
    const undoJson = (await undoRes.json()) as any;
    assert.equal(undoJson.data.count, 2);
    assert.deepEqual(rollbackCalls, [2]);

    const piSkillsRes = await fetch(`${gw.url}/api/v1/sessions/pi_pi-native/skills`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.equal(piSkillsRes.status, 200);
    const piSkills = ((await piSkillsRes.json()) as any).data.skills as any[];
    assert.ok(piSkills.some((s) => s.name === 'until-done' && s.source === 'builtin'));
    assert.ok(piSkills.some((s) => s.name === 'until-done' && s.source === 'user' && s.path === '/tmp/skills/until-done/SKILL.md'));

    await fetch(`${gw.url}/api/v1/sessions/pi_pi-native/skills/until-done:activate`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/skills/until-done/SKILL.md', args: 'ship it' }),
    });
    await fetch(`${gw.url}/api/v1/sessions/pi_pi-native/skills/until-done:activate`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' },
      body: JSON.stringify({ args: 'run' }),
    });
    assert.equal(piStarted[0]?.input, '/skill:until-done ship it');
    assert.equal(piStarted[1]?.input, '/until-done run');
  } finally {
    await gw.close();
  }
});

test('POST /sessions/:id:fork renames session if title is provided', async () => {
  const codex = fakeAdapter('codex') as any;
  codex.capabilities = () => ({ ...capabilities, fork: true });
  codex.fork = async () => ({
    id: 'forked-id',
    workspace_id: 'wd_1',
    title: 'Old Title',
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    busy: false,
    metadata: { cwd: '/tmp' },
    provider: 'codex',
  });
  const renameCalls: Array<{ id: string; title: string }> = [];
  codex.rename = async (id: string, title: string) => {
    renameCalls.push({ id, title });
  };

  const gw = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: codex as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
  });

  try {
    const res = await fetch(`${gw.url}/api/v1/sessions/codex_codex-native:fork`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer gateway-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'New Forked Session' }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json() as any).data;
    assert.equal(data.title, 'New Forked Session');
    assert.deepEqual(renameCalls, [{ id: 'forked-id', title: 'New Forked Session' }]);
  } finally {
    await gw.close();
  }
});

test('/transcript?agent_id=sub-1 returns empty when getSubagentMessages is absent', async () => {
  const pi = fakeAdapter('pi');
  delete (pi as any).getSubagentMessages;
  pi.getHistory = async () => [
    {
      id: 'm1',
      session_id: 'pi-native',
      role: 'user',
      content: [{ type: 'text', text: 'main parent prompt' }],
      created_at: new Date().toISOString(),
    },
  ];
  const gw = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    pi: pi as any,
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
  });

  try {
    // Child agent query
    const childRes = await fetch(`${gw.url}/api/v1/sessions/pi_pi-native/transcript?agent_id=sub-1`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.equal(childRes.status, 200);
    const childData = (await childRes.json() as any).data;
    assert.deepEqual(childData.items, []); // Empty, NOT main session history!

    // Main agent query gets main history
    const mainRes = await fetch(`${gw.url}/api/v1/sessions/pi_pi-native/transcript?agent_id=main`, {
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.equal(mainRes.status, 200);
    const mainData = (await mainRes.json() as any).data;
    assert.equal(mainData.items.length, 1);
    assert.equal(mainData.items[0].prompt, 'main parent prompt');
  } finally {
    await gw.close();
  }
});

test(':reload calls clearCommandsCache on Claude adapter', async () => {
  const claude = fakeAdapter('claude');
  let cacheCleared = false;
  (claude as any).clearCommandsCache = () => {
    cacheCleared = true;
  };
  const gw = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    claude: claude as any,
    codex: fakeAdapter('codex') as any,
    grok: fakeAdapter('grok') as any,
    pi: fakeAdapter('pi') as any,
  });

  try {
    const res = await fetch(`${gw.url}/api/v1/sessions/claude_claude-native:reload`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token' },
    });
    assert.equal(res.status, 200);
    assert.equal(cacheCleared, true);
  } finally {
    await gw.close();
  }
});

test('/profile normalizes thinking enabled: true and auto without passing raw on or auto to Pi and Codex', async () => {
  const pi = fakeAdapter('pi');
  let piReceivedThinking: string | undefined;
  pi.setThinking = async (_sid, thinking) => {
    piReceivedThinking = thinking;
  };
  pi.listModels = async () => [
    { provider: 'pi', model: 'pi-model', display_name: 'Pi Model', max_context_size: 200000, capabilities: ['thinking'], default_effort: 'medium', support_efforts: ['low', 'medium', 'high'] },
  ];

  const codex = fakeAdapter('codex');
  let codexReceivedThinking: string | undefined;
  codex.setThinking = async (_sid, thinking) => {
    codexReceivedThinking = thinking;
  };
  codex.listModels = async () => [
    { provider: 'codex', model: 'codex-model', display_name: 'Codex Model', max_context_size: 200000, capabilities: ['thinking'], default_effort: 'low', support_efforts: ['low', 'medium', 'high'] },
  ];

  const gw = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    pi: pi as any,
    codex: codex as any,
    claude: fakeAdapter('claude') as any,
    grok: fakeAdapter('grok') as any,
  });

  try {
    // Test Pi with { thinking: { enabled: true } }
    const res1 = await fetch(`${gw.url}/api/v1/sessions/pi_pi-native/profile`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' },
      body: JSON.stringify({ thinking: { enabled: true } }),
    });
    assert.equal(res1.status, 200);
    assert.equal(piReceivedThinking, 'medium'); // Normalized, not raw 'on'!

    // Test Pi with { thinking: 'auto' }
    const res2 = await fetch(`${gw.url}/api/v1/sessions/pi_pi-native/profile`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' },
      body: JSON.stringify({ thinking: 'auto' }),
    });
    assert.equal(res2.status, 200);
    assert.equal(piReceivedThinking, 'medium'); // Normalized, not raw 'auto'!

    // Test Codex with { thinking: { enabled: true } }
    const res3 = await fetch(`${gw.url}/api/v1/sessions/codex_codex-native/profile`, {
      method: 'POST',
      headers: { authorization: 'Bearer gateway-token', 'content-type': 'application/json' },
      body: JSON.stringify({ thinking: { enabled: true } }),
    });
    assert.equal(res3.status, 200);
    assert.equal(codexReceivedThinking, 'low'); // Model default_effort, not raw 'on'!
  } finally {
    await gw.close();
  }
});

test('SessionHub deletes empty Set entries on unsubscribe and clears session on drop', () => {
  const hub = new SessionHub();
  assert.equal(hub.hasListeners('s1'), false);

  const unsub1 = hub.subscribe('s1', () => {});
  const unsub2 = hub.subscribe('s1', () => {});
  assert.equal(hub.hasListeners('s1'), true);
  assert.equal(hub.listenerCount('s1'), 2);

  unsub1();
  assert.equal(hub.hasListeners('s1'), true);
  assert.equal(hub.listenerCount('s1'), 1);

  unsub2();
  // Empty Set must be deleted from listeners map!
  assert.equal(hub.hasListeners('s1'), false);

  // subscribeV262
  const unsubV262 = hub.subscribeV262('s1', () => {});
  assert.equal(hub.hasV262Listeners('s1'), true);
  unsubV262();
  assert.equal(hub.hasV262Listeners('s1'), false);

  // drop clears listeners even if still subscribed
  hub.subscribe('s2', () => {});
  hub.subscribeV262('s2', () => {});
  assert.equal(hub.hasListeners('s2'), true);
  assert.equal(hub.hasV262Listeners('s2'), true);
  hub.drop('s2');
  assert.equal(hub.hasListeners('s2'), false);
  assert.equal(hub.hasV262Listeners('s2'), false);
});

test('Codex executeCodexCommand undo uses thread/revert and renderCodexUsage includes account usage', async () => {
  const codex = fakeAdapter('codex');
  let rollbackCalls = 0;
  codex.rollback = async () => { rollbackCalls++; };

  const undoMsg = await executeCodexCommand(codex, 'native-1', 'undo', '');
  assert.equal(rollbackCalls, 1);
  assert.ok(undoMsg.includes('thread/revert'));
  assert.equal(undoMsg.includes('thread/rollback'), false);

  (codex as any).getAccountUsage = async () => ({
    totalTokens: 150000,
    inputTokens: 100000,
    outputTokens: 50000,
  });
  const usageMsg = await renderCodexUsage(codex, 'native-1');
  assert.ok(usageMsg.includes('账号用量'));
  assert.ok(usageMsg.includes('150,000'));
});

test('gateway filters empty (session) placeholders, dedupes :activate skill chips, drives Pi /advisor and /plan interactive menus, and pushes extension_ui', async () => {
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const cfgRoot = await mkdtemp(join(tmpdir(), 'gw-pi-advisor-xdg-'));
  process.env.XDG_CONFIG_HOME = cfgRoot;

  const pi = fakeAdapter('pi') as any;
  const piPrompts: string[] = [];
  let piClosed = 0;
  pi.close = async () => { piClosed += 1; };
  pi.listModels = async () => [
    {
      provider: 'alibb9',
      model: 'alibb9/cx/gpt-6.1-sol',
      display_name: 'GPT 6.1 Sol',
      capabilities: ['thinking'],
      support_efforts: ['low', 'medium', 'high'],
    },
  ];
  pi.listCommands = async () => [
    { name: 'advisor', description: 'Configure advisor', kind: 'prompt', source: 'extension', acceptsInput: true },
    { name: 'plan', description: 'Plan mode menu', kind: 'prompt', source: 'extension', acceptsInput: true },
    { name: 'silent-tui', description: 'Silent TUI cmd', kind: 'prompt', source: 'extension', acceptsInput: false },
  ];
  pi.getExtensionUiState = () => ({
    statuses: { 'plan-mode': 'Plan active' },
    widgets: { plan: { lines: ['Step A'] } },
    title: 'Plan',
  });
  pi.startTurn = async (input: StartTurnInput) => {
    const promptStr = typeof input.input === 'string' ? input.input : '';
    piPrompts.push(promptStr);
    return {
      turnId: `t-${piPrompts.length}`,
      events: (async function* () {
        if (promptStr === '/plan show') {
          yield { kind: 'message', status: 'delta', sessionId: input.sessionId, turnId: 't', timestamp: Date.now(), payload: { delta: 'Current Plan: A' } };
        }
        yield { kind: 'turn', status: 'completed', sessionId: input.sessionId, turnId: 't', timestamp: Date.now(), payload: { reason: 'completed' } };
      })(),
    };
  };

  const grok = fakeAdapter('grok') as any;
  grok.list = async () => ({
    items: [
      {
        id: 'empty-1',
        workspace_id: 'wd_grok_empty',
        title: '(session)',
        created_at: '2026-11-15T00:00:00.000Z',
        updated_at: '2026-11-15T00:00:00.000Z',
        busy: false,
        extras: { last_prompt: '' },
        metadata: { cwd: '/tmp/empty' },
        provider: 'grok',
      },
      {
        id: 'real-1',
        workspace_id: 'wd_grok_real',
        title: 'Real Chat',
        created_at: '2026-11-15T00:01:00.000Z',
        updated_at: '2026-11-15T00:01:00.000Z',
        busy: false,
        extras: { last_prompt: 'Real Chat' },
        metadata: { cwd: '/tmp/real' },
        provider: 'grok',
      },
    ],
  });

  const gw = await startGateway({
    port: 0,
    token: 'gateway-token',
    kimi: 'off',
    codex: fakeAdapter('codex') as any,
    claude: fakeAdapter('claude') as any,
    grok,
    pi,
    availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi'],
  });

  const authHeaders = { authorization: 'Bearer gateway-token', 'content-type': 'application/json' };
  const wsFrames: Record<string, unknown>[] = [];
  const waitFrame = (pred: (f: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const existing = wsFrames.find(pred);
      if (existing) { resolve(existing); return; }
      const timer = setInterval(() => {
        const hit = wsFrames.find(pred);
        if (hit) {
          clearInterval(timer);
          clearTimeout(deadline);
          resolve(hit);
        }
      }, 15);
      const deadline = setTimeout(() => {
        clearInterval(timer);
        reject(new Error(`WS frame timeout; got: ${wsFrames.map((f) => `${String(f.type)}:${String(f.status ?? '')}`).join(',')}`));
      }, timeoutMs);
    });

  let ws: WebSocket | undefined;
  try {
    // 1. Grok empty (session) placeholder filtered out from /sessions?exclude_empty=true and /api/v2/sessions
    const v1List = (await (await fetch(`${gw.url}/api/v1/sessions?provider=grok&exclude_empty=true`, { headers: authHeaders })).json()) as any;
    assert.deepEqual(v1List.data.items.map((s: any) => s.id), ['grok_real-1']);
    const v2Groups = (await (await fetch(`${gw.url}/api/v2/sessions?provider=grok&view=by_workspace&meta.has_prompt=true`, { headers: authHeaders })).json()) as any;
    assert.equal(v2Groups.data.groups.length, 1);
    assert.equal(v2Groups.data.groups[0].sessions[0].id, 'grok_real-1');

    // 2. GET /sessions/:id/status includes Pi extension_ui state
    const statusBody = (await (await fetch(`${gw.url}/api/v1/sessions/pi_pi-native/status?provider=pi`, { headers: authHeaders })).json()) as any;
    assert.deepEqual(statusBody.data.extension_ui, {
      statuses: { 'plan-mode': 'Plan active' },
      widgets: { plan: { lines: ['Step A'] } },
      title: 'Plan',
    });

    // 3. Connect WS and subscribe to pi_pi-native -> receives initial extension_ui frame
    ws = new WebSocket(`${gw.url.replace(/^http/, 'ws')}/api/v1/ws?provider=pi`, ['kimi-code.bearer.gateway-token']);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS open timeout')), 2000);
      ws!.onopen = () => { clearTimeout(timer); resolve(); };
      ws!.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
      ws!.onmessage = (ev) => {
        try {
          wsFrames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
        } catch { /* ignore */ }
      };
    });

    ws.send(JSON.stringify({ type: 'subscribe', request_id: 'sub-pi', session_id: 'pi_pi-native', agent_ids: ['main'] }));
    const initialExtUi = await waitFrame((f) => f.type === 'extension_ui' && f.session_id === 'pi_pi-native');
    assert.deepEqual((initialExtUi as any).statuses, { 'plan-mode': 'Plan active' });

    // 4. POST /skills/advisor:activate with empty args and chip metadata.display_text: "advisor"
    // must NOT forward "/advisor advisor" — instead triggers two-step QuestionCard and writes advisor.json!
    const actRes = await fetch(`${gw.url}/api/v1/sessions/pi_pi-native/skills/advisor:activate?provider=pi`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ args: '', metadata: { display_text: 'advisor' } }),
    });
    assert.equal(actRes.status, 200);
    assert.equal(piPrompts.length, 0);

    const qModel = await waitFrame((f) => f.type === 'interaction' && f.kind === 'question' && f.status === 'pending' && (f.request as any)?.questions?.[0]?.id === 'advisor_model');
    const qModelId = String(qModel.interaction_id);
    await fetch(`${gw.url}/api/v1/sessions/pi_pi-native/interactions/${encodeURIComponent(qModelId)}?provider=pi`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ answers: { advisor_model: { kind: 'single', option_id: 'alibb9/cx/gpt-6.1-sol' } }, method: 'click' }),
    });

    const qEffort = await waitFrame((f) => f.type === 'interaction' && f.kind === 'question' && f.status === 'pending' && (f.request as any)?.questions?.[0]?.id === 'advisor_effort');
    const qEffortId = String(qEffort.interaction_id);
    await fetch(`${gw.url}/api/v1/sessions/pi_pi-native/interactions/${encodeURIComponent(qEffortId)}?provider=pi`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ answers: { advisor_effort: { kind: 'single', option_id: 'high' } }, method: 'click' }),
    });

    await waitFrame((f) => f.type === 'turn.ended' && f.session_id === 'pi_pi-native');
    const { readFile } = await import('node:fs/promises');
    const advisorCfg = JSON.parse(await readFile(join(cfgRoot, 'rpiv-advisor', 'advisor.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(advisorCfg.modelKey, 'alibb9/cx/gpt-6.1-sol');
    assert.equal(advisorCfg.effort, 'high');
    assert.ok(piClosed >= 1);

    // 5. Bare /plan triggers QuestionCard menu and translates selected choice to `/plan show`
    wsFrames.length = 0;
    const planRes = await fetch(`${gw.url}/api/v1/sessions/pi_pi-native/prompts?provider=pi`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ content: [{ type: 'text', text: '/plan' }] }),
    });
    assert.equal(planRes.status, 200);
    const qPlan = await waitFrame((f) => f.type === 'interaction' && f.kind === 'question' && f.status === 'pending' && (f.request as any)?.questions?.[0]?.id === 'plan_action');
    await fetch(`${gw.url}/api/v1/sessions/pi_pi-native/interactions/${encodeURIComponent(String(qPlan.interaction_id))}?provider=pi`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ answers: { plan_action: { kind: 'single', option_id: 'show' } }, method: 'click' }),
    });
    await waitFrame((f) => f.type === 'turn.ended' && f.session_id === 'pi_pi-native');
    assert.ok(piPrompts.includes('/plan show'));

    // 6. Zero-output slash command turn emits helpful fallback message instead of silent blank turn
    wsFrames.length = 0;
    await fetch(`${gw.url}/api/v1/sessions/pi_pi-native/prompts?provider=pi`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ content: [{ type: 'text', text: '/silent-tui' }] }),
    });
    const silentDelta = await waitFrame((f) => f.type === 'item.delta' && typeof (f as any).delta === 'string' && String((f as any).delta).includes('/silent-tui'));
    assert.ok(silentDelta);
    await waitFrame((f) => f.type === 'turn.ended' && f.session_id === 'pi_pi-native');
  } finally {
    ws?.close();
    await gw.close();
    await rm(cfgRoot, { recursive: true, force: true });
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});


async function reviewRegressionFixture(options: {
  kimi?: 'off' | { upstream: string; token: string };
  adapters?: Partial<Record<'claude' | 'codex' | 'grok' | 'pi' | 'dsh', ProviderAdapter>>;
} = {}) {
  const settingsDir = await mkdtemp(join(tmpdir(), 'gw-review-regression-'));
  const adapters = {
    claude: fakeAdapter('claude'),
    codex: fakeAdapter('codex'),
    grok: fakeAdapter('grok'),
    pi: fakeAdapter('pi'),
    dsh: fakeAdapter('dsh'),
    ...options.adapters,
  };
  try {
    const gateway = await startGateway({
      port: 0,
      token: 'review-token',
      kimi: options.kimi ?? 'off',
      settingsDir,
      codex: adapters.codex as any,
      claude: adapters.claude as any,
      grok: adapters.grok as any,
      pi: adapters.pi as any,
      dsh: adapters.dsh as any,
      availableProviders: ['kimi', 'claude', 'codex', 'grok', 'pi', 'dsh'],
    });
    const request = (path: string, method = 'GET', body?: unknown) => fetch(`${gateway.url}/api/v1${path}`, {
      method,
      headers: { authorization: 'Bearer review-token', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      gateway, adapters, request, settingsDir,
      close: async () => {
        try { await gateway.close(); } finally { await rm(settingsDir, { recursive: true, force: true }); }
      },
    };
  } catch (err) {
    await rm(settingsDir, { recursive: true, force: true });
    throw err;
  }
}

for (const name of ['status', 'help', 'diff', 'skills']) {
  test(`review regression: DSH builtin /${name} activation executes without skill expansion`, async () => {
    const dsh = fakeAdapter('dsh');
    dsh.getHistory = async () => [];
    dsh.getCwd = () => undefined;
    dsh.listCommands = async () => ['status', 'help', 'diff', 'skills'].map((command) => ({ name: command, description: `${command} command`, kind: 'prompt', builtin: true }));
    let providerPrompts = 0;
    dsh.startTurn = async () => { providerPrompts++; throw new Error('builtin sent to provider'); };
    const fixture = await reviewRegressionFixture({ adapters: { dsh } });
    try {
      const response = await fixture.request(`/sessions/dsh_dsh-native/skills/${name}:activate`, 'POST', {});
      assert.equal(response.status, 200);
      assert.equal((await response.json() as any).data.activated, true);
      const transcript = await fixture.request('/sessions/dsh_dsh-native/transcript?agent_id=main&page_size=20');
      const turns = ((await transcript.json()) as any).data.items;
      const turn = turns.find((item: any) => item.prompt === `/${name}`);
      assert.ok(turn, `/${name} must produce a gateway command turn`);
      const text = String(turn.steps?.[0]?.frames?.[0]?.text ?? '');
      const expected: Record<string, RegExp> = {
        status: /DSH 会话状态/,
        help: /dsh Web UI 可用命令/,
        diff: /工作目录/,
        skills: /dsh 可用命令与技能/,
      };
      assert.match(text, expected[name]);
      assert.equal(providerPrompts, 0);
    } finally {
      await fixture.close();
    }
  });
}

test('review regression: DSH rejects a client supplied arbitrary skill path before file IO or prompt', async () => {
  const dsh = fakeAdapter('dsh');
  dsh.listCommands = async () => [];
  dsh.listSkills = async () => [];
  let providerPrompts = 0;
  dsh.startTurn = async () => { providerPrompts++; throw new Error('unexpected provider prompt'); };
  const fixture = await reviewRegressionFixture({ adapters: { dsh } });
  const arbitraryPath = join(fixture.settingsDir, 'unregistered-skill.md');
  let attemptedRead = false;
  const originalReadFileSync = fs.readFileSync;
  try {
    fs.readFileSync = ((path: unknown, ...args: unknown[]) => {
      if (String(path) === arbitraryPath) {
        attemptedRead = true;
        throw new Error('arbitrary skill path must not be read');
      }
      return (originalReadFileSync as any)(path, ...args);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    const response = await fixture.request('/sessions/dsh_dsh-native/skills/unregistered:activate', 'POST', { path: arbitraryPath });
    assert.equal(response.status, 400);
    assert.equal(attemptedRead, false);
    assert.equal(providerPrompts, 0);
  } finally {
    fs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
    await fixture.close();
  }
});

test('review regression: Kimi wd_ trust is forwarded and local provider trust stays local', async () => {
  const seen: Array<{ method: string; url: string; body: string }> = [];
  const upstream = await listen(createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(envelope({ trusted: false, upstream: true }));
    });
  }));
  let fixture: Awaited<ReturnType<typeof reviewRegressionFixture>> | undefined;
  try {
    fixture = await reviewRegressionFixture({ kimi: { upstream: upstream.url, token: 'upstream-token' } });
    for (const query of ['', '?provider=kimi']) {
      for (const method of ['GET', 'POST']) {
        const body = method === 'POST' ? { marker: 'forward-unchanged' } : undefined;
        const response = await fixture.request(`/workspaces/wd_kimi_123/trust${query}`, method, body);
        assert.deepEqual((await response.json() as any).data, { trusted: false, upstream: true });
        assert.ok(seen.some((entry) => entry.method === method && entry.url === '/api/v1/workspaces/wd_kimi_123/trust' && entry.body === (body ? JSON.stringify(body) : '')));
      }
    }
    const upstreamCount = seen.filter((entry) => entry.url.includes('/trust')).length;
    for (const method of ['GET', 'POST']) {
      const response = await fixture.request('/workspaces/wd_local_123/trust?provider=claude', method, method === 'POST' ? {} : undefined);
      assert.equal(response.status, 200);
      assert.equal((await response.json() as any).data.trusted, true);
    }
    assert.equal(seen.filter((entry) => entry.url.includes('/trust')).length, upstreamCount);
  } finally {
    try { await fixture?.close(); } finally { await upstream.close(); }
  }
});

test('review regression: authenticated external directory browse does not enumerate provider sessions', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gw-review-external-'));
  let fixture: Awaited<ReturnType<typeof reviewRegressionFixture>> | undefined;
  try {
    await mkdir(join(external, 'child'));
    fixture = await reviewRegressionFixture();
    let listCalls = 0;
    for (const adapter of Object.values(fixture.adapters)) {
      adapter.list = async () => { listCalls++; throw new Error('directory browse must not list sessions'); };
    }
    const unauthenticated = await fetch(`${fixture.gateway.url}/api/v1/fs:browse?provider=claude&path=${encodeURIComponent(external)}`);
    assert.equal(unauthenticated.status, 401);
    for (const target of [external, join(external, 'child')]) {
      const response = await fixture.request(`/fs:browse?provider=claude&path=${encodeURIComponent(target)}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json() as any).data.path, target);
    }
    assert.equal(listCalls, 0);
  } finally {
    try { await fixture?.close(); } finally { await rm(external, { recursive: true, force: true }); }
  }
});

for (const [operation, path, method, body] of [
  ['takeover', '/sessions/claude_claude-native:takeover', 'POST', {}],
  ['rating response', '/sessions/claude_claude-native/rating', 'POST', { op: 'respond', appearance_id: 'survey-1', response: { score: 1 } }],
  ['file history content', '/sessions/claude_claude-native/file-history/content?turn_number=1&path=file.txt&phase=before', 'GET', undefined],
  ['pull request', '/sessions/claude_claude-native/fs:pull_request', 'POST', {}],
] as const) {
  test(`review regression: unsupported ${operation} does not report success`, async () => {
    const fixture = await reviewRegressionFixture();
    try {
      const response = await fixture.request(path, method, body);
      const result = await response.json() as any;
      assert.equal(response.status, 400);
      assert.notEqual(result.code, 0);
      assert.match(String(result.msg), /unsupported|不支持|不可用/i);
    } finally {
      await fixture.close();
    }
  });
}

test('review regression: rating evaluation can report not applicable', async () => {
  const fixture = await reviewRegressionFixture();
  try {
    const response = await fixture.request('/sessions/claude_claude-native/rating', 'POST', { op: 'evaluate', turn_id: 'turn-1' });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as any).data, { appearance: null });
  } finally {
    await fixture.close();
  }
});

test('review regression: explicit root cwd reaches the local provider unchanged', async () => {
  const claude = fakeAdapter('claude');
  let createdCwd: string | undefined;
  const create = claude.create.bind(claude);
  claude.create = async (input) => { createdCwd = input.cwd; return create(input); };
  const fixture = await reviewRegressionFixture({ adapters: { claude } });
  try {
    const response = await fixture.request('/sessions?provider=claude', 'POST', { cwd: '/' });
    assert.equal(response.status, 200);
    assert.equal(createdCwd, '/');
  } finally {
    await fixture.close();
  }
});

test('review regression: Grok truncated turn is visible as failure or warning', async () => {
  const grok = fakeAdapter('grok');
  grok.getHistory = async () => [];
  grok.startTurn = async () => ({
    turnId: 'grok-limit-turn',
    events: (async function* () {
      yield { sessionId: 'grok-native', turnId: 'grok-limit-turn', kind: 'message', status: 'delta', timestamp: Date.now(), payload: { delta: 'partial answer' } } as any;
      yield { sessionId: 'grok-native', turnId: 'grok-limit-turn', kind: 'turn', status: 'completed', timestamp: Date.now(), payload: { reason: 'completed', truncated: true } } as any;
    })(),
  });
  const fixture = await reviewRegressionFixture({ adapters: { grok } });
  let ws: WebSocket | undefined;
  try {
    const frames: any[] = [];
    ws = new WebSocket(`${fixture.gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=grok`, ['kimi-code.bearer.review-token']);
    let resolveTurn!: () => void;
    const ended = new Promise<void>((resolve) => { resolveTurn = resolve; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 2000);
      ws!.onopen = () => { clearTimeout(timer); resolve(); };
      ws!.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket open failed')); };
      ws!.onmessage = (event) => {
        const frame = JSON.parse(String(event.data));
        frames.push(frame);
        if (frame.type === 'turn.ended') resolveTurn();
      };
    });
    ws.send(JSON.stringify({ type: 'subscribe', request_id: 'review-grok', session_id: 'grok_grok-native', agent_ids: ['main'] }));
    const subscribed = new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (frames.some((frame) => frame.type === 'response' && frame.request_id === 'review-grok')) {
          clearInterval(timer); clearTimeout(deadline); resolve();
        }
      }, 10);
      const deadline = setTimeout(() => { clearInterval(timer); reject(new Error('WebSocket subscribe timeout')); }, 2000);
    });
    await subscribed;
    const response = await fixture.request('/sessions/grok_grok-native/prompts', 'POST', { content: [{ type: 'text', text: 'test truncation' }] });
    assert.equal(response.status, 200);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ended, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('turn timeout')), 2000); })]);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
    const turnEnd = frames.find((frame) => frame.type === 'turn.ended');
    const visibleWarning = frames.some((frame) => {
      const text = frame.type === 'item.delta' ? frame.delta : frame.type === 'item.ended' ? frame.item?.text : frame.type === 'notice' ? frame.message : undefined;
      return typeof text === 'string' && /truncat|max.tokens|截断|令牌上限/i.test(text);
    });
    assert.ok(turnEnd?.turn?.outcome === 'failed' || turnEnd?.reason === 'failed' || visibleWarning, 'truncated output must not appear as an unqualified success');
  } finally {
    ws?.close();
    await fixture.close();
  }
});

test('review regression: tool delta with outputMode replace updates existingTool.output and emits item.updated', async () => {
  const codex = fakeAdapter('codex');
  codex.startTurn = async (): Promise<TurnHandle> => ({
    turnId: 'replace-turn',
    events: (async function* () {
      const base = { sessionId: 'codex-native', turnId: 'replace-turn', timestamp: Date.now() };
      yield { ...base, kind: 'tool', status: 'started', payload: { toolCallId: 'call-repl', name: 'Bash', input: {} } } as any;
      yield { ...base, kind: 'tool', status: 'delta', payload: { toolCallId: 'call-repl', name: 'Bash', output: 'step 1 snapshot' } } as any;
      yield { ...base, kind: 'tool', status: 'delta', payload: { toolCallId: 'call-repl', name: 'Bash', output: 'step 2 replacement', outputMode: 'replace' } } as any;
      yield { ...base, kind: 'tool', status: 'completed', payload: { toolCallId: 'call-repl', name: 'Bash' } } as any;
      yield { ...base, kind: 'turn', status: 'completed', payload: { reason: 'completed' } } as any;
    })(),
  });
  const fixture = await reviewRegressionFixture({ adapters: { codex } });
  let ws: WebSocket | undefined;
  try {
    const frames: any[] = [];
    ws = new WebSocket(`${fixture.gateway.url.replace(/^http/, 'ws')}/api/v1/ws?provider=codex`, ['kimi-code.bearer.review-token']);
    let resolveTurn!: () => void;
    const ended = new Promise<void>((resolve) => { resolveTurn = resolve; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 2000);
      ws!.onopen = () => { clearTimeout(timer); resolve(); };
      ws!.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket open failed')); };
      ws!.onmessage = (event) => {
        const frame = JSON.parse(String(event.data));
        frames.push(frame);
        if (frame.type === 'turn.ended') resolveTurn();
      };
    });
    ws.send(JSON.stringify({ type: 'subscribe', request_id: 'sub-replace', session_id: 'codex_codex-native', agent_ids: ['main'] }));
    const subscribed = new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (frames.some((frame) => frame.type === 'response' && frame.request_id === 'sub-replace')) {
          clearInterval(timer); clearTimeout(deadline); resolve();
        }
      }, 10);
      const deadline = setTimeout(() => { clearInterval(timer); reject(new Error('WebSocket subscribe timeout')); }, 2000);
    });
    await subscribed;
    const response = await fixture.request('/sessions/codex_codex-native/prompts', 'POST', { content: [{ type: 'text', text: 'test replace' }] });
    assert.equal(response.status, 200);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ended, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('turn timeout')), 2000); })]);
    } finally {
      if (deadline) clearTimeout(deadline);
    }

    const updatedFrame = frames.find((frame) => frame.type === 'item.updated' && frame.item_id === 'call-repl');
    assert.ok(updatedFrame, 'must broadcast item.updated for outputMode=replace');
    assert.equal(updatedFrame.set?.output, 'step 2 replacement');

    const endedItem = frames.find((frame) => frame.type === 'item.ended' && frame.item?.item_id === 'call-repl');
    assert.equal(endedItem?.item?.output, 'step 2 replacement');
  } finally {
    ws?.close();
    await fixture.close();
  }
});
