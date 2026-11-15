import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import test from 'node:test';
import { isKimiV25Version, v25TurnToV262 } from './kimi-v25-bridge.js';
import { startGateway } from './gateway.js';
import { WsFrameParser, wsAccept, wsSendText } from './ws-framing.js';
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

test('isKimiV25Version identifies 2.5.x vs 2.6.x accurately', () => {
  assert.equal(isKimiV25Version('2.5.3'), true);
  assert.equal(isKimiV25Version('2.4.0'), true);
  assert.equal(isKimiV25Version('2.6.0'), false);
  assert.equal(isKimiV25Version('2.6.2'), false);
  assert.equal(isKimiV25Version(undefined), false);
});

test('v25TurnToV262 converts 2.5.3 TranscriptTurn frames into 2.6.2 Turn items', () => {
  const converted = v25TurnToV262({
    turnId: 't1',
    triggerPromptId: 'p1',
    ordinal: 1,
    state: 'completed',
    origin: { kind: 'user' },
    prompt: 'hello world',
    startedAt: '2026-11-15T00:00:00.000Z',
    endedAt: '2026-11-15T00:00:05.000Z',
    durationMs: 5000,
    steps: [
      {
        kind: 'step',
        stepId: 't1.1',
        ordinal: 1,
        state: 'completed',
        startedAt: '2026-11-15T00:00:01.000Z',
        endedAt: '2026-11-15T00:00:05.000Z',
        frames: [
          { kind: 'thinking', frameId: 'f1', text: 'pondering' },
          { kind: 'tool', frameId: 'f2', toolCallId: 'call-1', name: 'Shell', state: 'done', input: { command: 'ls' }, output: 'ok' },
          { kind: 'text', frameId: 'f3', text: 'done!' },
        ],
      },
    ],
  });
  assert.equal(converted.turn_id, 't1');
  assert.equal(converted.ordinal, 1);
  assert.equal(converted.status, 'ended');
  assert.equal(converted.outcome, 'completed');
  const items = converted.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 4);
  assert.equal(items[0]?.type, 'user_message');
  assert.equal(items[0]?.text, 'hello world');
  assert.equal(items[1]?.type, 'reasoning');
  assert.equal(items[1]?.text, 'pondering');
  assert.equal(items[2]?.type, 'tool_call');
  assert.equal(items[2]?.outcome, 'completed');
  assert.equal(items[3]?.type, 'assistant_message');
  assert.equal(items[3]?.text, 'done!');
});

test('gateway bridges 2.6.2 WS subscribe and /agents/:id/turns to an upstream 2.5.3 Kimi server', async () => {
  const upstreamWsSeen: any[] = [];
  const upstreamSockets = new Set<Duplex>();
  const upstreamServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/v1/meta') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, msg: 'success', data: { server_version: '2.5.3', backend: 'v2' } }));
      return;
    }
    if (url.pathname === '/api/v1/sessions/sess-1/transcript') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        code: 0,
        msg: 'success',
        data: {
          agent_id: 'main',
          has_more: false,
          items: [
            {
              kind: 'turn',
              turnId: 't0',
              triggerPromptId: 'p0',
              ordinal: 0,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'hi kimi',
              startedAt: '2026-11-15T00:00:00.000Z',
              endedAt: '2026-11-15T00:00:01.000Z',
              steps: [{ kind: 'step', stepId: 't0.1', ordinal: 1, state: 'completed', frames: [{ kind: 'text', frameId: 'f0', text: 'hello from 2.5.3' }] }],
            },
          ],
        },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  upstreamServer.on('upgrade', (req, socket, head) => {
    upstreamSockets.add(socket);
    const key = req.headers['sec-websocket-key'] as string;
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${wsAccept(key)}`,
      '',
      '',
    ].join('\r\n'));
    wsSendText(socket, JSON.stringify({ type: 'server_hello', payload: { protocol_version: 2 } }));
    const parser = new WsFrameParser();
    const consume = (buf: Buffer) => {
      for (const f of parser.push(buf)) {
        if (f.opcode !== 0x1) continue;
        const msg = JSON.parse(f.payload.toString('utf8'));
        upstreamWsSeen.push(msg);
        if (msg.type === 'client_hello') {
          wsSendText(socket, JSON.stringify({ type: 'ack', id: msg.id, code: 0, msg: 'success', payload: {} }));
        } else if (msg.type === 'subscribe_v2') {
          wsSendText(socket, JSON.stringify({
            type: 'transcript.reset',
            session_id: msg.payload.session_id,
            payload: { type: 'transcript.reset', agent_id: 'main', snapshot: { items: [] }, has_more_older: true, seq: 1 },
          }));
          wsSendText(socket, JSON.stringify({
            type: 'ack',
            id: msg.id,
            code: 0,
            msg: 'success',
            payload: { accepted: [msg.payload.session_id], not_found: [] },
          }));
        }
      }
    };
    if (head.length > 0) consume(head);
    socket.on('data', consume);
    socket.on('close', () => upstreamSockets.delete(socket));
  });

  await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
  const uPort = (upstreamServer.address() as any).port;

  const gw = await startGateway({
    port: 0,
    token: 'gw-secret',
    kimi: { upstream: `http://127.0.0.1:${uPort}`, token: 'kimi-secret' },
    claude: stubAdapter('claude') as any,
    codex: stubAdapter('codex') as any,
    grok: stubAdapter('grok') as any,
    pi: stubAdapter('pi'),
  });

  try {
    // 1) REST /agents/main/turns bridged cleanly from 2.5.3 /transcript
    const turnsRes = await fetch(`${gw.url}/api/v1/sessions/sess-1/agents/main/turns?page_size=20`, {
      headers: { authorization: 'Bearer gw-secret' },
    });
    assert.equal(turnsRes.status, 200);
    const turnsJson = (await turnsRes.json()) as any;
    assert.equal(turnsJson.data.turns.length, 1);
    assert.equal(turnsJson.data.turns[0].items[1].text, 'hello from 2.5.3');

    // 2) WS 2.6.2 subscribe -> bridged to client_hello + subscribe_v2 -> returns response + turns
    const wsUrl = gw.url.replace('http://', 'ws://') + '/api/v1/ws?provider=kimi';
    const ws = new WebSocket(wsUrl, ['kimi-code.bearer.gw-secret']);
    const received: any[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS timeout')), 5000);
      ws.addEventListener('message', (evt) => {
        const msg = JSON.parse(String(evt.data));
        received.push(msg);
        if (msg.type === 'server_hello') {
          ws.send(JSON.stringify({ type: 'subscribe', request_id: 'sub-1', session_id: 'sess-1', agent_ids: ['main'] }));
        } else if (msg.type === 'turns') {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.addEventListener('error', reject);
    });
    ws.close();

    assert.ok(received.some((m) => m.type === 'response' && m.request_id === 'sub-1' && m.code === 0));
    const turnsMsg = received.find((m) => m.type === 'turns' && m.session_id === 'sess-1');
    assert.ok(turnsMsg);
    assert.equal(turnsMsg.turns.length, 1);
    assert.equal(turnsMsg.turns[0].items[1].text, 'hello from 2.5.3');
    assert.equal(upstreamWsSeen.some((m) => m.type === 'client_hello'), true);
    assert.equal(upstreamWsSeen.some((m) => m.type === 'subscribe_v2'), true);
  } finally {
    await gw.close();
    for (const s of upstreamSockets) s.destroy();
    await new Promise<void>((r) => upstreamServer.close(() => r()));
  }
});
