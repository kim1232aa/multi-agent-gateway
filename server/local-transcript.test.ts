import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalTranscriptHub, buildLocalTranscriptPage } from './local-transcript.js';
import type { Message } from './types.js';

const history: Message[] = [
  {
    id: 'u1', session_id: 's1', role: 'user',
    content: [{ type: 'text', text: 'hello' }],
    created_at: '2026-01-01T00:00:00.000Z',
  },
];

test('seeds late subscribers with global state and no turn bodies', () => {
  const hub = new LocalTranscriptHub();
  const turn = hub.beginTurn('s1', 'live');
  turn.append('assistant', 'secret');
  turn.end('completed');
  hub.submitPrompt('s1', 'p1', 'running', [{ type: 'text', text: 'live' }]);
  hub.finishPrompt('s1', 'p1', 'completed');

  const emissions: any[] = [];
  hub.subscribe('s1', (emission) => emissions.push(emission)).seed(history, 'idle');

  const reset = emissions.find((emission) => emission.type === 'transcript.reset');
  assert.deepEqual(reset.payload.snapshot.items, []);
  assert.equal(reset.payload.has_more_older, true);
  assert.equal(JSON.stringify(reset.payload.snapshot).includes('secret'), false);
  assert.ok(reset.payload.snapshot.prompts.some((prompt: any) =>
    prompt.promptId === 'p1' && prompt.status === 'completed'));
});

test('reports complete catch-up only while the requested cursor is journaled', () => {
  const hub = new LocalTranscriptHub();
  for (let index = 0; index < 205; index += 1) {
    hub.publish('s1', [{ op: 'meta.merge', meta: { index } }]);
  }

  const covered = hub.getOpsSince('s1', 200);
  assert.equal(covered.complete, true);
  assert.deepEqual(covered.batches.map((batch) => batch.seq), [201, 202, 203, 204, 205]);

  const current = hub.getOpsSince('s1', 205);
  assert.equal(current.complete, true);
  assert.deepEqual(current.batches, []);

  assert.equal(hub.getOpsSince('s1', 1).complete, false);
  assert.equal(hub.getOpsSince('s1', 999).complete, false);
});

test('replays provider error messages as failed turns', async () => {
  const messages: Message[] = [
    {
      id: 'u1', session_id: 's1', role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      created_at: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'a1', session_id: 's1', role: 'assistant',
      content: [{ type: 'text', text: 'API Error' }],
      created_at: '2026-01-01T00:00:01.000Z',
      metadata: { is_error: true },
    },
  ];

  const page = buildLocalTranscriptPage(messages, { agentId: 'main' }, 'idle', 0);

  assert.equal(page.items[0]?.state, 'failed');
  assert.equal(page.items[0]?.steps[0]?.state, 'failed');
});

const persistedHistory: Message[] = [
  { id: 'u1', session_id: 's1', role: 'user', content: [{ type: 'text', text: 'old one' }], created_at: '2026-01-01T00:00:00.000Z' },
  { id: 'a1', session_id: 's1', role: 'assistant', content: [{ type: 'text', text: 'old reply' }], created_at: '2026-01-01T00:00:01.000Z' },
  { id: 'u2', session_id: 's1', role: 'user', content: [{ type: 'text', text: 'old two' }], created_at: '2026-01-01T00:00:02.000Z' },
];

test('rebases a running turn allocated before first history observation instead of dropping it', () => {
  const hub = new LocalTranscriptHub();
  // 历史拉取失败窗口:turn 在未观察历史的情况下开始,拿到 ordinal 1(与持久化 t1 撞号)。
  const turn = hub.beginTurn('s1', 'live prompt');
  turn.append('assistant', 'partial');
  // 历史随后成功回灌(两个持久化 turn)。
  hub.observeHistory('s1', persistedHistory);

  const active = hub.activeItems('s1');
  assert.equal(active.length, 1);
  assert.equal(active[0].turnId, 't3');
  assert.equal(active[0].state, 'running');
  assert.equal(active[0].steps[0]?.stepId, 't3.1');

  // REST 页:持久化 t1/t2 + live t3,运行中 turn 不再被同号持久化 turn 顶替。
  const page = buildLocalTranscriptPage(persistedHistory, { agentId: 'main' }, 'turn', hub.currentSeq('s1'), active);
  assert.deepEqual(
    page.items.map((item) => [item.turnId, item.state]),
    [['t1', 'completed'], ['t2', 'completed'], ['t3', 'running']],
  );

  // journal 已重写:重放不出现旧号幽灵(旧 t1 的 turn.upsert/append 都改到 t3)。
  const raw = JSON.stringify(hub.getOpsSince('s1', 0).batches);
  assert.equal(raw.includes('"turnId":"t1"'), false);
  assert.equal(raw.includes('"turnId":"t3"'), true);
  assert.equal(raw.includes('"stepId":"t1.1"'), false);
  assert.equal(raw.includes('"stepId":"t3.1"'), true);
});

test('unbased completed turns survive first observation via rebase, not eviction', () => {
  const hub = new LocalTranscriptHub();
  const turn = hub.beginTurn('s1', 'done prompt');
  turn.append('assistant', 'answer');
  turn.end('completed');
  hub.observeHistory('s1', persistedHistory);

  // 未基准的已完成 turn 重编号到 t3,而不是按撞号被持久化历史驱逐。
  const items = hub.activeItems('s1');
  assert.equal(items.length, 1);
  assert.equal(items[0].turnId, 't3');
  assert.equal(items[0].state, 'completed');
  assert.equal(items[0].prompt, 'done prompt');
});
