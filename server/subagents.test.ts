import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GrokProviderAdapter } from './grok-adapter.js';
import { GrokAcpClient } from './grok-acp.js';

const parent = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';

test('Grok lists bounded disk child states without starting a CLI and rejects foreign/symlink children', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mag-subagents-'));
  const sessionsDir = join(root, 'sessions');
  const dir = join(sessionsDir, encodeURIComponent('/work'), parent, 'subagents');
  const adapter = new GrokProviderAdapter({ sessionsDir, grokBin: '/missing-grok' });
  try {
    await mkdir(join(dir, child), { recursive: true });
    const meta = { subagent_id: child, parent_session_id: parent, child_session_id: child, description: 'inspect', status: 'running' };
    await writeFile(join(dir, child, 'meta.json'), JSON.stringify(meta));
    const list = () => (adapter as any).listSubagents(parent);
    assert.equal((await list())[0].status, 'running');
    await writeFile(join(dir, child, 'meta.json'), JSON.stringify({ ...meta, status: 'completed', completed_at: '2026-11-17T12:00:00Z' }));
    assert.equal((await list())[0].status, 'completed');
    await writeFile(join(dir, child, 'meta.json'), JSON.stringify({ ...meta, parent_session_id: child }));
    assert.deepEqual(await list(), []);
    await rm(join(dir, child), { recursive: true });
    await mkdir(join(root, 'external'));
    await symlink(join(root, 'external'), join(dir, child));
    assert.deepEqual(await list(), []);
  } finally {
    await adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('Grok ACP child lifecycle distinguishes spawned from finished and keeps native child identity', () => {
  const client = new GrokAcpClient({ grokBin: '/missing-grok' });
  const events: any[] = [];
  client.onEvent((event) => events.push(event));
  for (const kind of ['subagent_spawned', 'subagent_finished']) {
    (client as any).handleNotification('_x.ai/session/update', {
      sessionId: parent,
      update: { sessionUpdate: kind, subagent_id: child, child_session_id: child, status: kind === 'subagent_finished' ? 'completed' : 'running', description: 'inspect', tokens_used: 42 },
    });
  }
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'subagent');
  assert.equal(events[0].agentId, child);
  assert.equal(events[0].status, 'running');
  assert.equal(events[1].status, 'completed');
  assert.equal(events[1].tokens, 42);
});


const gateway = '44444444-4444-4444-8444-444444444444';

async function writeChildMeta(dir: string, id: string, meta: Record<string, unknown>): Promise<void> {
  await mkdir(join(dir, id), { recursive: true });
  await writeFile(join(dir, id, 'meta.json'), JSON.stringify({ subagent_id: id, parent_session_id: parent, child_session_id: id, ...meta }));
}

test('Grok maps ACP subagent updates to kind subagent events under the gateway session id', () => {
  const adapter = new GrokProviderAdapter({ sessionsDir: join(tmpdir(), 'mag-subagents-none'), grokBin: '/missing-grok' });
  (adapter as any).rememberAcpSession(gateway, parent, '/work');
  const events: any[] = [];
  const stream = { push: (ev: any) => events.push(ev) };
  const map = (ev: Record<string, unknown>) => (adapter as any).mapAcpEvent(gateway, 'turn-1', stream, { type: 'subagent', raw: {}, ...ev });
  map({ sessionId: parent, agentId: child, status: 'running', description: 'inspect' });
  map({ sessionId: parent, agentId: child, status: 'completed' });
  map({ sessionId: parent, agentId: child, status: 'failed' });
  map({ sessionId: 'foreign-session', agentId: child, status: 'completed' });
  map({ sessionId: parent, agentId: child, status: 'weird' });
  assert.deepEqual(
    events.map((ev) => [ev.kind, ev.status, ev.sessionId, ev.agentId, ev.payload.status]),
    [
      ['subagent', 'started', gateway, child, 'running'],
      ['subagent', 'completed', gateway, child, 'completed'],
      ['subagent', 'failed', gateway, child, 'failed'],
      ['subagent', 'updated', gateway, child, 'unknown'],
    ],
  );
  assert.equal(events[0].payload.summary, 'inspect');
});

test('Grok live subagent state survives the parent turn and merges with disk by recency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mag-subagents-live-'));
  const sessionsDir = join(root, 'sessions');
  const dir = join(sessionsDir, encodeURIComponent('/work'), parent, 'subagents');
  const adapter = new GrokProviderAdapter({ sessionsDir, grokBin: '/missing-grok' });
  const client = new GrokAcpClient({ grokBin: '/missing-grok' });
  const emit = (ev: Record<string, unknown>) => (adapter as any).onAcpProcessEvent(client, false, { type: 'subagent', raw: {}, ...ev });
  const statuses = async () => Object.fromEntries((await adapter.listSubagents(gateway)).map((s) => [s.agentId, s.status]));
  try {
    (adapter as any).rememberAcpSession(gateway, parent, '/work');
    await writeChildMeta(dir, 'sub-disk-running', { status: 'running' });
    await writeChildMeta(dir, 'sub-disk-old', { status: 'completed', completed_at: '2000-01-01T00:00:00Z' });
    await writeChildMeta(dir, 'sub-disk-future', { status: 'completed', completed_at: '2099-01-01T00:00:00Z' });
    assert.deepEqual(await statuses(), {
      'sub-disk-running': 'running',
      'sub-disk-old': 'completed',
      'sub-disk-future': 'completed',
    });

    emit({ sessionId: parent, agentId: 'sub-disk-running', status: 'completed' });
    emit({ sessionId: parent, agentId: 'sub-disk-old', status: 'running', description: 'new spawn' });
    emit({ sessionId: parent, agentId: 'sub-disk-future', status: 'running' });
    emit({ sessionId: parent, agentId: 'sub-live-only', status: 'running', description: 'background' });
    assert.deepEqual(await statuses(), {
      'sub-disk-running': 'completed',
      'sub-disk-old': 'running',
      'sub-disk-future': 'completed',
      'sub-live-only': 'running',
    });
    assert.equal((adapter as any).isAcpBusy(), true);

    emit({ sessionId: parent, agentId: 'sub-disk-old', status: 'completed' });
    emit({ sessionId: parent, agentId: 'sub-live-only', status: 'cancelled' });
    emit({ sessionId: parent, agentId: 'sub-disk-future', status: 'completed' });
    assert.equal((await statuses())['sub-live-only'], 'cancelled');
    assert.equal((adapter as any).isAcpBusy(), false);
  } finally {
    await adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('Grok live subagent state goes unknown on disconnect and is cleared on close and dispose', async () => {
  const adapter = new GrokProviderAdapter({ sessionsDir: join(tmpdir(), 'mag-subagents-empty'), grokBin: '/missing-grok' });
  const client = new GrokAcpClient({ grokBin: '/missing-grok' });
  const emit = (ev: Record<string, unknown>) => (adapter as any).onAcpProcessEvent(client, false, { type: 'subagent', raw: {}, ...ev });
  const statuses = async () => Object.fromEntries((await adapter.listSubagents(gateway)).map((s) => [s.agentId, s.status]));
  (adapter as any).rememberAcpSession(gateway, parent, '/work');
  emit({ sessionId: parent, agentId: 'sub-a', status: 'running' });
  emit({ sessionId: parent, agentId: 'sub-b', status: 'running' });
  assert.equal((adapter as any).isAcpBusy(), true);
  (adapter as any).onAcpProcessEvent(client, false, { type: 'disconnected', code: null, signal: null });
  assert.deepEqual(await statuses(), { 'sub-a': 'unknown', 'sub-b': 'unknown' });
  assert.equal((adapter as any).isAcpBusy(), false);

  emit({ sessionId: parent, agentId: 'sub-c', status: 'running' });
  await adapter.close(gateway);
  assert.deepEqual(await statuses(), {});

  emit({ sessionId: parent, agentId: 'sub-d', status: 'running' });
  await adapter.dispose();
  assert.equal((adapter as any).subagentLive.size, 0);
});

test('Grok live subagent state is bounded per parent and in the number of parents', async () => {
  const adapter = new GrokProviderAdapter({ sessionsDir: join(tmpdir(), 'mag-subagents-bounded'), grokBin: '/missing-grok' });
  const client = new GrokAcpClient({ grokBin: '/missing-grok' });
  const emit = (sessionId: string, agentId: string, status: string) =>
    (adapter as any).onAcpProcessEvent(client, false, { type: 'subagent', sessionId, agentId, status, raw: {} });
  try {
    (adapter as any).rememberAcpSession(gateway, parent, '/work');
    for (let i = 0; i < 250; i += 1) emit(parent, `sub-${i}`, 'running');
    assert.equal((await adapter.listSubagents(gateway)).length, 200);
    for (let i = 0; i < 100; i += 1) emit(`parent-${i}`, 'sub-x', 'running');
    assert.ok((adapter as any).subagentLive.size <= 64);
  } finally {
    await adapter.dispose();
  }
});

test('Grok getSubagentMessages returns nothing for live-only or foreign children without throwing', async () => {
  const adapter = new GrokProviderAdapter({ sessionsDir: join(tmpdir(), 'mag-subagents-messages'), grokBin: '/missing-grok' });
  const client = new GrokAcpClient({ grokBin: '/missing-grok' });
  try {
    (adapter as any).rememberAcpSession(gateway, parent, '/work');
    (adapter as any).onAcpProcessEvent(client, false, { type: 'subagent', sessionId: parent, agentId: 'sub-live-only', status: 'running', raw: {} });
    assert.deepEqual(await adapter.getSubagentMessages(gateway, 'sub-live-only'), []);
    assert.deepEqual(await adapter.getSubagentMessages(gateway, child), []);
  } finally {
    await adapter.dispose();
  }
});

test('Grok advertises the subagents capability', () => {
  assert.equal(new GrokProviderAdapter().capabilities().subagents, true);
});

test('Grok background child completion notifies subscribers after the parent stream closes', async () => {
  const adapter = new GrokProviderAdapter({ grokBin: '/missing-grok' });
  const client = new GrokAcpClient({ grokBin: '/missing-grok' });
  (adapter as any).rememberAcpSession(gateway, parent, '/work');
  const received: string[] = [];
  const off = adapter.onSubagentUpdate((sid, info) => received.push(`${sid}:${info.agentId}:${info.status}`));
  try {
    for (const status of ['running', 'completed']) {
      (adapter as any).onAcpProcessEvent(client, false, { type: 'subagent', sessionId: parent, agentId: child, status, raw: {} });
    }
    assert.deepEqual(received, [`${gateway}:${child}:running`, `${gateway}:${child}:completed`]);
    off();
    (adapter as any).onAcpProcessEvent(client, false, { type: 'subagent', sessionId: parent, agentId: child, status: 'failed', raw: {} });
    assert.equal(received.length, 2);
  } finally { await adapter.dispose(); }
});
