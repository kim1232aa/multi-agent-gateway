import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexProviderAdapter } from './facade.js';

const parent = 'review-codex-parent';

function reviewAdapter(): { adapter: CodexProviderAdapter; inner: Record<string, unknown> } {
  const adapter = new CodexProviderAdapter();
  const inner = adapter['inner' as keyof CodexProviderAdapter] as unknown as Record<string, unknown>;
  return { adapter, inner };
}

async function feedItems(adapter: CodexProviderAdapter, ...items: Array<Record<string, unknown>>): Promise<void> {
  const source = (async function* () {
    for (const item of items) yield { type: 'item-completed', item };
  })();
  for await (const _ of (adapter as unknown as { mapCodexEvents: (s: string, t: string, i: AsyncIterable<unknown>) => AsyncIterable<unknown> })
    .mapCodexEvents(parent, 'review-turn', source)) { /* drain */ }
}

test('grok review: a lost subagent_finished no longer pins the ACP process after the running TTL', async (t) => {
  const { GrokProviderAdapter } = await import('./grok-adapter.js');
  const { GrokAcpClient } = await import('./grok-acp.js');
  const parent = '66666666-6666-4666-8666-666666666666';
  const child = '77777777-7777-4777-8777-777777777777';
  const gateway = '88888888-8888-4888-8888-888888888888';
  const adapter = new GrokProviderAdapter({ grokBin: '/missing-grok' });
  t.after(() => adapter.dispose());
  const client = new GrokAcpClient({ grokBin: '/missing-grok' });
  const emit = (status: string) =>
    (adapter as any).onAcpProcessEvent(client, false, { type: 'subagent', sessionId: parent, agentId: child, status, raw: {} });
  (adapter as any).rememberAcpSession(gateway, parent, '/work');
  emit('running');
  assert.equal((adapter as any).clientBusy(client), true);
  const TTL = (GrokProviderAdapter as any).SUBAGENT_RUNNING_TTL_MS as number;
  (adapter as any).subagentLive.get(gateway).get(child).updatedAt = Date.now() - TTL - 1000;
  assert.equal((adapter as any).clientBusy(client), false);
  assert.equal((await adapter.listSubagents(gateway)).find((c) => c.agentId === child)?.status, 'unknown');
});

test('codex review: ordinary command output with agent_id text is not subagent evidence', async (t) => {
  const { adapter } = reviewAdapter();
  t.after(() => adapter.dispose());
  (adapter as any).resolveCodexRolloutPath = async () => null;
  (adapter as any).inner.listSubagentThreadStates = async () => [];

  await feedItems(adapter, {
    type: 'commandExecution',
    id: 'cmd-read-log',
    command: 'cat unrelated.log',
    aggregatedOutput: 'agent_id: unrelated-thread-id',
    exitCode: 0,
    status: 'completed',
  });

  const children = await adapter.listSubagents(parent);
  assert.equal(children.some((c) => c.agentId === 'unrelated-thread-id'), false);
  let opened = '';
  (adapter as any).getHistory = async (id: string) => { opened = id; return []; };
  await adapter.getSubagentMessages(parent, 'unrelated-thread-id');
  assert.equal(opened, '');
});

test('codex review: spawn-family tool with receiverThreadIds still records the child', async (t) => {
  const { adapter } = reviewAdapter();
  t.after(() => adapter.dispose());
  (adapter as any).resolveCodexRolloutPath = async () => null;
  (adapter as any).inner.listSubagentThreadStates = async () => [];

  await feedItems(adapter, {
    type: 'collabAgentToolCall',
    id: 'call-spawn-ok',
    tool: 'spawnAgent',
    receiverThreadIds: ['real-child'],
    status: 'completed',
  });

  const children = await adapter.listSubagents(parent);
  assert.equal(children.some((c) => c.agentId === 'real-child'), true);
});

test('codex review: interacted keeps the child running and interrupted maps to cancelled', async (t) => {
  const { adapter } = reviewAdapter();
  t.after(() => adapter.dispose());
  (adapter as any).resolveCodexRolloutPath = async () => null;
  (adapter as any).inner.listSubagentThreadStates = async () => [];

  await feedItems(adapter, { type: 'subAgentActivity', agentId: 'real-child', kind: 'started' });
  await feedItems(adapter, { type: 'subAgentActivity', agentId: 'real-child', kind: 'interacted' });
  assert.equal((await adapter.listSubagents(parent)).find((c) => c.agentId === 'real-child')?.status, 'running');

  await feedItems(adapter, { type: 'subAgentActivity', agentId: 'real-child', kind: 'interrupted' });
  assert.equal((await adapter.listSubagents(parent)).find((c) => c.agentId === 'real-child')?.status, 'cancelled');
});

test('codex review: native child systemError wins over stale live running', async (t) => {
  const { adapter } = reviewAdapter();
  t.after(() => adapter.dispose());
  (adapter as any).resolveCodexRolloutPath = async () => null;
  (adapter as any).inner.listSubagentThreadStates = async () => [];

  await feedItems(adapter, { type: 'subAgentActivity', agentId: 'real-child', kind: 'started' });
  (adapter as any).inner.listSubagentThreadStates = async () => [{ threadId: 'real-child', status: 'failed' }];
  assert.equal((await adapter.listSubagents(parent)).find((c) => c.agentId === 'real-child')?.status, 'failed');
});

test('claude review: explicit running status on a sync result stays running, absent status stays completed', async () => {
  const sessionId = '55555555-5555-4555-8555-555555555555';
  const T1 = '2026-11-18T01:00:00.000Z';
  const T2 = '2026-11-18T01:05:00.000Z';
  const base = await mkdtemp(join(tmpdir(), 'claude-sync-status-'));
  const projectsDir = join(base, 'projects');
  const projDir = join(projectsDir, 'proj');
  const subDir = join(projDir, sessionId, 'subagents');
  try {
    await mkdir(subDir, { recursive: true });
    const parentLines = [
      { type: 'assistant', timestamp: T1, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: {} }] } },
      { type: 'assistant', timestamp: T1, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b', name: 'Agent', input: {} }] } },
      { type: 'user', timestamp: T2, toolUseResult: { status: 'running', agentId: 'childA' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'in progress' }] } },
      { type: 'user', timestamp: T2, toolUseResult: { status: 'completed', agentId: 'childB' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'done' }] } },
    ];
    await writeFile(join(projDir, `${sessionId}.jsonl`), parentLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const { ClaudeAdapter } = await import('./claude-adapter.js');
    const adapter = new ClaudeAdapter({ projectsDir, claudeBin: '/missing-cli' });
    await writeFile(join(subDir, 'agent-childA.meta.json'), JSON.stringify({ toolUseId: 'toolu_a' }));
    await writeFile(join(subDir, 'agent-childB.meta.json'), JSON.stringify({ toolUseId: 'toolu_b' }));
    const byId = new Map((await adapter.listSubagentDetails(sessionId)).map((e) => [e.agentId, e]));
    assert.equal(byId.get('childA')?.status, 'running');
    assert.equal(byId.get('childA')?.endedAt, undefined);
    assert.equal(byId.get('childB')?.status, 'completed');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
