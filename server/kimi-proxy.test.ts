import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { startGateway } from './gateway.js';
import { isKimiApiPath, isKimiWsPath } from './kimi-proxy.js';
import type { ProviderAdapter, ProviderCapabilities } from './types.js';

function stubAdapter(name: 'claude' | 'codex' | 'grok' | 'pi'): ProviderAdapter {
  const caps: ProviderCapabilities = {
    streaming: true,
    thinking: true,
    tools: true,
    approvals: false,
    questions: false,
    interrupt: true,
    history: true,
  };
  return {
    name,
    capabilities: () => caps,
    list: async () => ({ items: [] }),
    create: async () => { throw new Error('unused'); },
    getHistory: async () => [],
    startTurn: async () => { throw new Error('unused'); },
    interrupt: async () => {},
    resolveApproval: async () => {},
    resolveQuestion: async () => {},
    close: async () => {},
  };
}

test('treats /api/v1 and /api/v2 REST paths as Kimi API routes, but not the WS endpoint', () => {
  assert.equal(isKimiApiPath('/api/v1/sessions'), true);
  assert.equal(isKimiApiPath('/api/v2/sessions?limit=3'), true);
  assert.equal(isKimiApiPath('/api/v2'), true);
  assert.equal(isKimiApiPath('/api/v1/ws'), false);
  assert.equal(isKimiWsPath('/api/v1/ws'), true);
  assert.equal(isKimiApiPath('/assets/index.js'), false);
  assert.equal(isKimiApiPath('/v1/remote'), true);
  assert.equal(isKimiApiPath('/v1/remote/devices'), true);
  assert.equal(isKimiApiPath('/v1/remote/devices?limit=3'), true);
  assert.equal(isKimiApiPath('/v1/remotely'), false);
});

test('blocks unauthenticated requests to /v1/remote, /api/v2, and /api/v1 before upstream proxy', async () => {
  const upstreamSeen: string[] = [];
  const upstream = createServer((req, res) => {
    upstreamSeen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, msg: 'success', data: { leaked: true } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const addr = upstream.address();
  const upstreamUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const gateway = await startGateway({
    host: '127.0.0.1',
    port: 0,
    token: 'secret-token',
    kimi: { upstream: upstreamUrl, token: 'upstream-secret' },
    codex: stubAdapter('codex') as any,
    claude: stubAdapter('claude') as any,
    grok: stubAdapter('grok') as any,
    pi: stubAdapter('pi'),
  });
  try {
    for (const path of ['/v1/remote', '/v1/remote/devices', '/api/v2/sessions', '/api/v1/sessions']) {
      const res = await fetch(`${gateway.url}${path}`);
      assert.equal(res.status, 401, `expected 401 for unauthenticated ${path}`);
    }
    assert.deepEqual(upstreamSeen, []);

    const authed = await fetch(`${gateway.url}/v1/remote/devices`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    assert.equal(authed.status, 200);
    assert.deepEqual(upstreamSeen, ['GET /v1/remote/devices']);
  } finally {
    await gateway.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
