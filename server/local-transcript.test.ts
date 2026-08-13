import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalTranscriptHub } from './local-transcript.js';
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
  const { buildLocalTranscriptPage } = await import('./local-transcript.js');
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
