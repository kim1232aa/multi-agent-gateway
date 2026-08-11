import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import test from 'node:test';
import type { ProviderAdapter, ProviderCapabilities, NativeModel, NativeCommand, Session, SessionPage, Message, StartTurnInput, TurnHandle, ApprovalDecision, HistoryQuery, ListSessionsQuery, CreateSessionInput } from './types.js';
import { startGateway } from './gateway.js';

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

    for (const provider of ['claude', 'codex'] as const) {
      const auth = await get(`/auth?provider=${provider}`);
      const authData = (await auth.json() as any).data;
      assert.equal(authData.ready, true);
      assert.equal(authData.providers_count, 1);
      assert.equal(authData.default_model, `${provider}-model`);
      assert.equal(authData.managed_provider, null);
    }

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

    const plan = await get('/sessions/claude_claude-native/transcript/plan?agent_id=main');
    assert.equal(plan.status, 200);
    assert.deepEqual((await plan.json() as any).data, { agent_id: 'main', plans: [] });
  } finally {
    await gateway.close();
    await upstream.close();
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
          'GET /api/v1/ws HTTP/1.1',
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
