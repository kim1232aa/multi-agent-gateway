import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalTranscriptHub, buildLocalTranscriptPage, contentFrames } from './local-transcript.js';
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

test('keeps Claude user-role tool_result on the current turn instead of starting an empty turn', () => {
  const messages: Message[] = [
    {
      id: 'u1', session_id: 's1', role: 'user',
      content: [{ type: 'text', text: 'run tool' }],
      created_at: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'a1', session_id: 's1', role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'consider the command' } as any,
        { type: 'tool_use', tool_call_id: 'tool-1', tool_name: 'Bash', input: { command: 'pwd' } } as any,
      ],
      created_at: '2026-01-01T00:00:01.000Z',
    },
    {
      id: 'u2', session_id: 's1', role: 'user',
      content: [{ type: 'tool_result', tool_call_id: 'tool-1', output: '/tmp', is_error: false } as any],
      created_at: '2026-01-01T00:00:02.000Z',
    },
  ];
  const page = buildLocalTranscriptPage(messages, { agentId: 'main' }, 'idle', 0);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.prompt, 'run tool');
  const frames = page.items[0]?.steps.flatMap((step) => step.frames) ?? [];
  assert.deepEqual(frames.map((frame) => frame.kind), ['thinking', 'tool', 'tool']);
  assert.equal(frames[2]?.output, '/tmp');
  assert.equal(frames[2]?.state, 'done');
});

test('projects thinking and tool history blocks from both internal and Kimi wire shapes', () => {
  const internal: Message[] = [{
    id: 'a-internal', session_id: 's1', role: 'assistant',
    content: [
      { type: 'thinking', text: 'consider the command' },
      { type: 'tool_call', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', tool_call_id: 'tool-1', content: '/tmp', is_error: true },
    ],
    created_at: '2026-01-01T00:00:01.000Z',
  }];
  const wire: Message[] = [{
    id: 'a-wire', session_id: 's1', role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'consider the command' } as any,
      { type: 'tool_use', tool_call_id: 'tool-1', tool_name: 'Bash', input: { command: 'pwd' } } as any,
      { type: 'tool_result', tool_call_id: 'tool-1', output: '/tmp', is_error: true } as any,
    ],
    created_at: '2026-01-01T00:00:01.000Z',
  }];

  for (const messages of [internal, wire]) {
    const page = buildLocalTranscriptPage(messages, { agentId: 'main' }, 'idle', 0);
    const frames = page.items[0]?.steps[0]?.frames ?? [];
    assert.deepEqual(frames.map((frame) => frame.kind), ['thinking', 'tool', 'tool']);
    assert.equal(frames[0]?.text, 'consider the command');
    assert.equal(frames[1]?.toolCallId, 'tool-1');
    assert.equal(frames[1]?.name, 'Bash');
    assert.equal(frames[2]?.output, '/tmp');
    assert.equal(frames[2]?.state, 'error');
  }
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

test('projects image parts safely in contentFrames and page attachments without embedding raw base64', () => {
  const hugeBase64 = 'A'.repeat(2048);
  const messages: Message[] = [
    {
      id: 'u-img', session_id: 's1', role: 'user',
      content: [
        { type: 'image', mime_type: 'image/png', data: hugeBase64, name: 'inline.png' },
        { type: 'image', mime_type: 'image/jpeg', url: '/api/v1/sessions/s1/images/ref-1', name: 'snap.jpg' },
      ],
      created_at: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'a-img', session_id: 's1', role: 'assistant',
      content: [
        { type: 'image', mimeType: 'image/webp', url: 'data:image/webp;base64,' + hugeBase64, ref: 'media-9' },
      ],
      created_at: '2026-01-01T00:00:01.000Z',
    },
  ];

  const userFrames = contentFrames(messages[0]!);
  assert.equal(userFrames.length, 2);
  assert.equal(userFrames[0]?.kind, 'text');
  assert.equal(userFrames[0]?.text, '[image: inline.png]');
  assert.equal(userFrames[0]?.inlineOmitted, true);
  assert.equal(userFrames[1]?.text, '[image: snap.jpg]');
  assert.deepEqual(userFrames[1]?.attachmentIds, ['u-img.att.1']);

  const assistantFrames = contentFrames(messages[1]!);
  assert.equal(assistantFrames.length, 1);
  assert.equal(assistantFrames[0]?.kind, 'text');
  assert.equal(assistantFrames[0]?.inlineOmitted, true);
  assert.equal(assistantFrames[0]?.url, undefined);
  assert.equal(assistantFrames[0]?.ref, 'media-9');
  assert.deepEqual(assistantFrames[0]?.attachmentIds, ['a-img.att.0']);

  const page = buildLocalTranscriptPage(messages, { agentId: 'main' }, 'idle', 0);
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0]?.attachmentIds, ['u-img.att.1']);
  assert.equal(page.attachments.length, 2);
  assert.equal(JSON.stringify(page).includes(hugeBase64), false);
});

test('rejects obfuscated media URL schemes containing control characters or unsafe protocols', () => {
  const unsafeUrls = [
    'java\nscript:alert(1)',
    '\tjavascript:alert(1)',
    'java\rscript:alert(1)',
    'javascript\x00:alert(1)',
    '  JaVaScRiPt:alert(1)',
    'data:image/png;base64,AAAA',
    'vbscript:msgbox(1)',
    '//evil.example/x.png',
    '/\\evil.example/x.png',
    'blob:javascript:alert(1)',
  ];
  const messages: Message[] = [
    {
      id: 'u-bad-urls', session_id: 's1', role: 'user',
      content: [
        ...unsafeUrls.map((url) => ({ type: 'image' as const, mime_type: 'image/png', url })),
        { type: 'image', mime_type: 'image/png', url: 'https://cdn.example.com/ok.png', name: 'ok.png' },
        { type: 'image', mime_type: 'image/png', url: 'blob:https://localhost:58629/123', name: 'blob.png' },
      ],
      created_at: '2026-01-01T00:00:00.000Z',
    },
  ];
  const frames = contentFrames(messages[0]!);
  for (let i = 0; i < unsafeUrls.length; i += 1) {
    assert.equal(frames[i]?.url, undefined, `unsafe url should be stripped: ${JSON.stringify(unsafeUrls[i])}`);
    assert.equal(frames[i]?.attachmentIds, undefined);
    assert.equal(frames[i]?.inlineOmitted, true);
  }
  assert.equal(frames[unsafeUrls.length]?.url, 'https://cdn.example.com/ok.png');
  assert.equal(frames[unsafeUrls.length + 1]?.url, 'blob:https://localhost:58629/123');

  const page = buildLocalTranscriptPage(messages, { agentId: 'main' }, 'idle', 0);
  assert.equal(page.attachments.length, 2);
  assert.deepEqual(page.items[0]?.attachmentIds, [
    `u-bad-urls.att.${unsafeUrls.length}`,
    `u-bad-urls.att.${unsafeUrls.length + 1}`,
  ]);
});

test('preserves accumulated stream text and avoids duplicate frame IDs across rebaseUnbasedTurns', () => {
  const hub = new LocalTranscriptHub();
  const unseededEmissions: any[] = [];
  const turn = hub.beginTurn('s1', 'live');
  turn.append('assistant', 'abc');

  // Unseeded subscriber observes between pre-rebase append and history observation.
  const sub = hub.subscribe('s1', (emission) => unseededEmissions.push(emission));

  hub.observeHistory('s1', history);
  turn.append('assistant', 'def');

  const active = hub.activeItems('s1');
  assert.equal(active.length, 1);
  assert.equal(active[0]?.turnId, 't2');
  const textFrames = active[0]?.steps[0]?.frames.filter((f) => f.kind === 'text') ?? [];
  assert.equal(textFrames.length, 1);
  assert.equal(textFrames[0]?.frameId, 't2.1.assistant');
  assert.equal(textFrames[0]?.text, 'abcdef');

  const journalOps = hub.getOpsSince('s1', 0).batches.flatMap((b) => b.ops);
  const appendOps = journalOps.filter((op) => op.op === 'append') as Array<Record<string, any>>;
  assert.equal(appendOps.length, 2);
  assert.equal(appendOps[0]?.target?.frameId, 't2.1.assistant');
  assert.equal(appendOps[0]?.offset, 0);
  assert.equal(appendOps[1]?.target?.frameId, 't2.1.assistant');
  assert.equal(appendOps[1]?.offset, 3);
  assert.equal(appendOps[1]?.text, 'def');

  // Seed after rebase: reset baseline + pending ops have no stale t1 IDs.
  sub.seed(history, 'turn');
  const rawSub = JSON.stringify(unseededEmissions);
  assert.equal(rawSub.includes('"t1"'), false);
  assert.equal(rawSub.includes('"t1.1'), false);
  const reset = unseededEmissions.find((e) => e.type === 'transcript.reset');
  assert.equal(reset.payload.snapshot.items[0]?.turnId, 't2');
  assert.equal(reset.payload.snapshot.items[0]?.steps[0]?.frames[0]?.text, 'abc');
});

test('preserves non-string and structured tool_result outputs without empty-string masking', () => {
  const messages: Message[] = [
    {
      id: 'a1', session_id: 's1', role: 'assistant',
      content: [
        { type: 'tool_result', tool_call_id: 'c1', output: '', content: 'from-content' },
        { type: 'tool_result', tool_call_id: 'c2', output: '', structuredOutput: { files: ['a.ts'], count: 1 } },
        { type: 'tool_result', tool_call_id: 'c3', content: [{ type: 'text', text: 'chunked failure' }], is_error: true },
        { type: 'tool_result', tool_call_id: 'c4', output: 0, is_error: false },
      ],
      created_at: '2026-01-01T00:00:01.000Z',
    },
  ];
  const frames = contentFrames(messages[0]!);
  assert.equal(frames[0]?.output, 'from-content');
  assert.deepEqual(frames[1]?.output, { files: ['a.ts'], count: 1 });
  assert.deepEqual(frames[2]?.output, [{ type: 'text', text: 'chunked failure' }]);
  assert.equal(frames[2]?.state, 'error');
  assert.equal(typeof frames[2]?.error, 'string');
  assert.equal(frames[2]?.error, 'chunked failure');
  assert.equal(frames[3]?.output, 0);

  const hub = new LocalTranscriptHub();
  const turn = hub.beginTurn('s1', 'structured tool');
  turn.toolStarted('c5', 'mcp_lookup', { q: 'x' }, { phase: 'commentary', agentId: 'sub-1' });
  turn.toolResult('c5', '', true, { structuredOutput: { message: 'upstream denied' }, agentId: 'sub-1' });
  turn.end('failed');
  const active = hub.activeItems('s1');
  const toolFrame = active[0]?.steps[0]?.frames[0];
  assert.deepEqual(toolFrame?.output, { message: 'upstream denied' });
  assert.equal(toolFrame?.error, 'upstream denied');
  assert.deepEqual(toolFrame?.agentRefs, [{ agentId: 'sub-1', role: 'child' }]);
});

test('supports subagent, plan, notice, and phase metadata cleanly', () => {
  const hub = new LocalTranscriptHub();
  const turn = hub.beginTurn('s1', 'plan and run');
  turn.setPhase('commentary');
  turn.append('assistant', 'thinking aloud', { phase: 'commentary' });
  turn.append('assistant', 'final answer', { phase: 'final_answer' });
  turn.notice('Context compacted', { level: 'warning', source: 'compact', detail: { before: 100 } });
  turn.toolStarted('sub-call', 'Agent', { task: 'audit' }, { parentToolUseId: 'root-tu', agentId: 'worker-2' });
  turn.end('completed');
  hub.upsertTask('s1', {
    taskId: 'task-sub-1',
    kind: 'subagent',
    state: 'completed',
    detached: true,
    agentId: 'worker-2',
    outputTail: 'done',
  });
  hub.setPlans('s1', [{ step: 'Inspect contracts', status: 'completed' }], { version: 1 });

  const liveTurn = hub.activeItems('s1')[0]!;
  const frames = liveTurn.steps[0]?.frames ?? [];
  assert.equal(frames.filter((f) => f.kind === 'text').length, 2);
  assert.equal(frames[0]?.phase, 'commentary');
  assert.equal(frames[1]?.phase, 'final_answer');
  assert.equal(frames[2]?.kind, 'notice');
  assert.equal(frames[2]?.level, 'warning');
  assert.equal(frames[3]?.parentToolUseId, 'root-tu');
  assert.deepEqual(frames[3]?.agentRefs, [{ agentId: 'worker-2', role: 'child' }]);

  const historyWithMeta: Message[] = [
    {
      id: 'sys-1', session_id: 's1', role: 'system',
      content: [{ type: 'text', text: 'Plan updated' }],
      created_at: '2026-01-01T00:00:00.000Z',
      metadata: {
        notice_level: 'info',
        notice_source: 'plan',
        phase: 'commentary',
        agent_id: 'worker-1',
        parent_tool_use_id: 'tu-parent',
        plan: { explanation: 'step 1', steps: [{ step: 'Read', status: 'completed' }] },
      },
    },
  ];
  const page = buildLocalTranscriptPage(
    historyWithMeta,
    { agentId: 'main' },
    'idle',
    hub.currentSeq('s1'),
    hub.activeItems('s1'),
    [],
    [],
    { tasks: hub.currentTasks('s1'), meta: hub.currentMeta('s1'), plans: hub.currentPlans('s1') },
  );
  assert.equal(page.tasks.length, 1);
  assert.equal(page.plans?.length, 2);
  assert.deepEqual(page.meta.modes, { plan: { version: 1 } });
  assert.ok(page.agents.some((a) => a.agentId === 'main' && a.type === 'main'));
  assert.ok(page.agents.some((a) => a.agentId === 'worker-1' && a.type === 'subagent'));
  assert.ok(page.agents.some((a) => a.agentId === 'worker-2' && a.type === 'subagent'));
});

test('coordinates transcript.reset notifications and monotonic seq across invalidateHistory', () => {
  const hub = new LocalTranscriptHub();
  const seededEmissions: any[] = [];
  const unseededEmissions: any[] = [];

  const sub1 = hub.subscribe('s1', (emission) => seededEmissions.push(emission));
  sub1.seed(history, 'idle');

  const t1 = hub.beginTurn('s1', 'will be rolled back');
  t1.append('assistant', 'stale');
  t1.end('completed');
  const seqBefore = hub.currentSeq('s1');
  assert.ok(seqBefore > 0);

  // Unseeded subscriber joins before invalidation and buffers live ops.
  const sub2 = hub.subscribe('s1', (emission) => unseededEmissions.push(emission));
  const t2 = hub.beginTurn('s1', 'buffered stale');
  t2.append('assistant', 'drop me');
  t2.end('completed');
  const seqBeforeReset = hub.currentSeq('s1');

  const genBefore = hub.currentGeneration('s1');
  hub.invalidateHistory('s1', { messages: [], reason: 'undo', activity: 'idle' });
  assert.equal(hub.currentGeneration('s1'), genBefore + 1);
  assert.equal(hub.currentSeq('s1'), seqBeforeReset + 1);
  assert.equal(hub.hasObservedHistory('s1'), true);

  const resets = seededEmissions.filter((e) => e.type === 'transcript.reset');
  assert.equal(resets.length, 2);
  assert.equal(resets[1]?.payload.seq, seqBeforeReset + 1);
  assert.equal(resets[1]?.payload.has_more_older, false);
  assert.equal(resets[1]?.payload.reason, 'undo');

  // Unseeded subscriber seeded after invalidation does not replay pre-undo buffered ops.
  sub2.seed([], 'idle');
  assert.equal(unseededEmissions.length, 1);
  assert.equal(unseededEmissions[0]?.type, 'transcript.reset');
  assert.equal(unseededEmissions[0]?.payload.seq, seqBeforeReset + 1);

  // Subsequent ops advance monotonically from reset seq.
  hub.publish('s1', [{ op: 'meta.merge', meta: { activity: 'idle' } }]);
  const postResetOps = seededEmissions.filter(
    (e) => e.type === 'transcript.ops' && e.payload.seq === seqBeforeReset + 2,
  );
  assert.ok(postResetOps.length >= 1);
});

test('rebuilds active turns in reset snapshot when invalidateHistory runs mid-turn', () => {
  const hub = new LocalTranscriptHub();
  const seededEmissions: any[] = [];
  const unseededEmissions: any[] = [];

  const sub1 = hub.subscribe('s1', (emission) => seededEmissions.push(emission));
  sub1.seed([], 'idle');

  const turn = hub.beginTurn('s1', 'active prompt');
  turn.append('assistant', 'first');

  const sub2 = hub.subscribe('s1', (emission) => unseededEmissions.push(emission));
  hub.invalidateHistory('s1', { messages: history, reason: 'compact' });

  // Active turn should survive reset in snapshot (rebased to t2) and continue accepting appends.
  turn.append('assistant', 'second');

  const resets1 = seededEmissions.filter((e) => e.type === 'transcript.reset');
  assert.equal(resets1.length, 2);
  const midReset = resets1[1]!;
  assert.equal(midReset.payload.has_more_older, true);
  assert.equal(midReset.payload.snapshot.items.length, 1);
  assert.equal(midReset.payload.snapshot.items[0]?.turnId, 't2');
  assert.equal(midReset.payload.snapshot.items[0]?.steps[0]?.frames[0]?.text, 'first');

  const postResetOps1 = seededEmissions.slice(seededEmissions.indexOf(midReset) + 1);
  assert.equal(postResetOps1.length, 1);
  assert.equal(postResetOps1[0]?.payload.ops[0]?.op, 'append');
  assert.equal(postResetOps1[0]?.payload.ops[0]?.target.frameId, 't2.1.assistant');
  assert.equal(postResetOps1[0]?.payload.ops[0]?.offset, 5);
  assert.equal(postResetOps1[0]?.payload.ops[0]?.text, 'second');

  // Unseeded subscriber seeded after mid-turn invalidation + second append gets rebuilt reset + delta.
  sub2.seed(history, 'turn');
  assert.equal(unseededEmissions[0]?.type, 'transcript.reset');
  assert.equal(unseededEmissions[0]?.payload.snapshot.items[0]?.turnId, 't2');
  assert.equal(unseededEmissions[0]?.payload.snapshot.items[0]?.steps[0]?.frames[0]?.text, 'first');
  assert.equal(unseededEmissions[1]?.type, 'transcript.ops');
  assert.equal(unseededEmissions[1]?.payload.ops[0]?.target.frameId, 't2.1.assistant');
  assert.equal(unseededEmissions[1]?.payload.ops[0]?.offset, 5);
  assert.equal(unseededEmissions[1]?.payload.ops[0]?.text, 'second');
});

test('rejects pre-invalidation cursors as incomplete across disconnect, pre-seed, and getOpsSince', () => {
  const hub = new LocalTranscriptHub();
  hub.publish('s1', [{ op: 'meta.merge', meta: { v: 1 } }]);
  const oldSeq = hub.currentSeq('s1');
  assert.equal(oldSeq, 1);

  // Pre-seed subscriber created before invalidation holding old cursor.
  const preSeedEmissions: any[] = [];
  const preSeedSub = hub.subscribe('s1', (emission) => preSeedEmissions.push(emission));

  hub.invalidateHistory('s1');
  assert.equal(hub.getOpsSince('s1', oldSeq).complete, false);

  hub.publish('s1', [{ op: 'meta.merge', meta: { v: 2 } }]);
  assert.equal(hub.getOpsSince('s1', oldSeq).complete, false);

  // Pre-seed subscriber must get a reset, not skip with complete catch-up.
  preSeedSub.seed(history, 'idle', oldSeq);
  assert.equal(preSeedEmissions[0]?.type, 'transcript.reset');
  const resetSeq = preSeedEmissions[0]?.payload.seq;
  assert.ok(resetSeq > oldSeq);

  // Disconnected subscriber reconnecting with old cursor must also get a reset.
  const reconnectOldEmissions: any[] = [];
  hub.subscribe('s1', (emission) => reconnectOldEmissions.push(emission)).seed(history, 'idle', oldSeq);
  assert.equal(reconnectOldEmissions[0]?.type, 'transcript.reset');

  // Client reconnecting with post-reset cursor catches up incrementally without reset.
  const reconnectFreshEmissions: any[] = [];
  hub.subscribe('s1', (emission) => reconnectFreshEmissions.push(emission)).seed(history, 'idle', resetSeq);
  assert.equal(reconnectFreshEmissions.some((e) => e.type === 'transcript.reset'), false);
  assert.equal(reconnectFreshEmissions.length, 1);
  assert.equal(reconnectFreshEmissions[0]?.type, 'transcript.ops');
});
