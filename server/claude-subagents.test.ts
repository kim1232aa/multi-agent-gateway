import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClaudeAdapter } from './claude-adapter.js';

const sessionId = '44444444-4444-4444-8444-444444444444';
const T1 = '2026-11-18T01:00:00.000Z';
const T2 = '2026-11-18T01:05:00.000Z';
const T3 = '2026-11-18T02:00:00.000Z';

const launch = (id: string, ts: string) => ({
  type: 'assistant',
  timestamp: ts,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'd' } }] },
});
const asyncResult = (id: string, agentId: string, ts: string) => ({
  type: 'user',
  timestamp: ts,
  toolUseResult: { isAsync: true, status: 'async_launched', agentId },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Async agent launched successfully.\nagentId: ${agentId}` }] },
});
const syncResult = (id: string, ts: string, agentId?: string) => ({
  type: 'user',
  timestamp: ts,
  toolUseResult: agentId ? { status: 'completed', agentId } : { status: 'completed' },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
});
const errorResult = (id: string, ts: string) => ({
  type: 'user',
  timestamp: ts,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'boom' }] },
});
const notification = (toolUseId: string, status: string, ts: string) => ({
  type: 'user',
  timestamp: ts,
  message: {
    role: 'user',
    content: `<task-notification><task-id>agent-x</task-id><tool-use-id>${toolUseId}</tool-use-id><status>${status}</status><summary>summary text</summary></task-notification>`,
  },
});
const subJsonl = () => ({ type: 'user', isSidechain: true, message: { role: 'user', content: 'sub' } });

async function withProject(
  parentLines: unknown[],
  run: (ctx: { adapter: ClaudeAdapter; subDir: string; base: string }) => Promise<void>,
  parentExtra = '',
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'claude-subagents-'));
  const projectsDir = join(base, 'projects');
  const projDir = join(projectsDir, 'proj');
  const subDir = join(projDir, sessionId, 'subagents');
  try {
    await mkdir(subDir, { recursive: true });
    await writeFile(join(projDir, `${sessionId}.jsonl`), parentLines.map((l) => JSON.stringify(l)).join('\n') + '\n' + parentExtra);
    await run({ adapter: new ClaudeAdapter({ projectsDir }), subDir, base });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('sync Agent tool_result is terminal completed with start and end times', async () => {
  await withProject([launch('toolu_fg', T1), syncResult('toolu_fg', T2, 'fg1')], async ({ adapter, subDir }) => {
    await writeFile(join(subDir, 'agent-fg1.jsonl'), JSON.stringify(subJsonl()) + '\n');
    await writeFile(join(subDir, 'agent-fg1.meta.json'), JSON.stringify({ toolUseId: 'toolu_fg', agentType: 'Explore' }));
    const [entry] = await adapter.listSubagentDetails(sessionId);
    assert.equal(entry?.agentId, 'fg1');
    assert.equal(entry?.status, 'completed');
    assert.equal(entry?.startedAt, T1);
    assert.equal(entry?.endedAt, T2);
    assert.equal(entry?.parentToolUseId, 'toolu_fg');
    assert.equal(entry?.subagentType, 'Explore');
  });
});

test('async launch with agentId is running until task-notification arrives', async () => {
  await withProject([launch('toolu_bg', T1), asyncResult('toolu_bg', 'bg1', T2)], async ({ adapter, subDir }) => {
    await writeFile(join(subDir, 'agent-bg1.jsonl'), JSON.stringify(subJsonl()) + '\n');
    await writeFile(join(subDir, 'agent-bg1.meta.json'), JSON.stringify({ toolUseId: 'toolu_bg', finished: true }));
    const [entry] = await adapter.listSubagentDetails(sessionId);
    assert.equal(entry?.status, 'running');
    assert.equal(entry?.endedAt, undefined);
  });
});

test('task-notification maps completed, killed and failed to terminal statuses', async () => {
  const cases: Array<[string, string]> = [['completed', 'completed'], ['killed', 'cancelled'], ['failed', 'failed']];
  for (const [raw, expected] of cases) {
    await withProject(
      [launch('toolu_n', T1), asyncResult('toolu_n', 'n1', T2), notification('toolu_n', raw, T3)],
      async ({ adapter, subDir }) => {
        await writeFile(join(subDir, 'agent-n1.jsonl'), JSON.stringify(subJsonl()) + '\n');
        await writeFile(join(subDir, 'agent-n1.meta.json'), JSON.stringify({ toolUseId: 'toolu_n' }));
        const [entry] = await adapter.listSubagentDetails(sessionId);
        assert.equal(entry?.status, expected, raw);
        assert.equal(entry?.endedAt, T3);
        assert.equal(entry?.summary, 'summary text');
      },
    );
  }
});

test('failed spawn tool_result is failed', async () => {
  await withProject([launch('toolu_err', T1), errorResult('toolu_err', T2)], async ({ adapter, subDir }) => {
    await writeFile(join(subDir, 'agent-err1.jsonl'), JSON.stringify(subJsonl()) + '\n');
    await writeFile(join(subDir, 'agent-err1.meta.json'), JSON.stringify({ toolUseId: 'toolu_err' }));
    const [entry] = await adapter.listSubagentDetails(sessionId);
    assert.equal(entry?.status, 'failed');
  });
});

test('meta-only subagents use sidecar finished only as optional evidence', async () => {
  await withProject([], async ({ adapter, subDir }) => {
    await writeFile(join(subDir, 'agent-m1.meta.json'), JSON.stringify({ agentType: 'Plan', description: 'plan it' }));
    await writeFile(join(subDir, 'agent-m2.meta.json'), JSON.stringify({ finished: true }));
    await writeFile(join(subDir, 'agent-m3.meta.json'), JSON.stringify({ finished: false }));
    const byId = new Map((await adapter.listSubagentDetails(sessionId)).map((d) => [d.agentId, d]));
    assert.equal(byId.get('m1')?.status, 'unknown');
    assert.equal(byId.get('m1')?.subagentType, 'Plan');
    assert.equal(byId.get('m1')?.description, 'plan it');
    assert.equal(byId.get('m2')?.status, 'completed');
    assert.equal(byId.get('m3')?.status, 'unknown');
    assert.deepEqual(await adapter.listSubagents(sessionId), []);
  });
});

test('jsonl subagent without sidecar or parent evidence is unknown', async () => {
  await withProject([], async ({ adapter, subDir }) => {
    await writeFile(join(subDir, 'agent-lone.jsonl'), JSON.stringify(subJsonl()) + '\n');
    const details = await adapter.listSubagentDetails(sessionId);
    assert.deepEqual(details.map((d) => [d.agentId, d.status]), [['lone', 'unknown']]);
  });
});

test('resumed async launch newer than a stale finished sidecar stays running, not completed', async () => {
  await withProject(
    [
      launch('toolu_old', T1),
      asyncResult('toolu_old', 'r1', T1),
      notification('toolu_old', 'completed', T2),
      launch('toolu_new', T3),
      asyncResult('toolu_new', 'r1', T3),
    ],
    async ({ adapter, subDir }) => {
      await writeFile(join(subDir, 'agent-r1.jsonl'), JSON.stringify(subJsonl()) + '\n');
      await writeFile(join(subDir, 'agent-r1.meta.json'), JSON.stringify({ toolUseId: 'toolu_old', finished: true }));
      const [entry] = await adapter.listSubagentDetails(sessionId);
      assert.equal(entry?.status, 'running');
      assert.equal(entry?.parentToolUseId, 'toolu_new');
    },
  );
});

test('resumed launch without terminal evidence is unknown, never completed from stale finished', async () => {
  await withProject(
    [launch('toolu_old', T1), asyncResult('toolu_old', 'r1', T1), notification('toolu_old', 'completed', T2), launch('toolu_new', T3)],
    async ({ adapter, subDir }) => {
      await writeFile(join(subDir, 'agent-r1.jsonl'), JSON.stringify(subJsonl()) + '\n');
      await writeFile(join(subDir, 'agent-r1.meta.json'), JSON.stringify({ toolUseId: 'toolu_new', finished: true }));
      const [entry] = await adapter.listSubagentDetails(sessionId);
      assert.equal(entry?.status, 'unknown');
    },
  );
});

test('sidecar toolUseId contradicted by parent agentId is not trusted as parent evidence', async () => {
  await withProject([launch('toolu_x', T1), syncResult('toolu_x', T2, 'other')], async ({ adapter, subDir }) => {
    await writeFile(join(subDir, 'agent-mine.jsonl'), JSON.stringify(subJsonl()) + '\n');
    await writeFile(join(subDir, 'agent-mine.meta.json'), JSON.stringify({ toolUseId: 'toolu_x' }));
    const [entry] = await adapter.listSubagentDetails(sessionId);
    assert.equal(entry?.status, 'unknown');
    assert.equal(entry?.parentToolUseId, undefined);
  });
});

test('symlinked or oversized sidecars are ignored and cannot mark completion', async () => {
  await withProject([], async ({ adapter, subDir, base }) => {
    const outside = join(base, 'outside.meta.json');
    await writeFile(outside, JSON.stringify({ finished: true }));
    await symlink(outside, join(subDir, 'agent-sym.meta.json'));
    await writeFile(join(subDir, 'agent-big.meta.json'), JSON.stringify({ finished: true, pad: 'x'.repeat(70 * 1024) }));
    const byId = new Map((await adapter.listSubagentDetails(sessionId)).map((d) => [d.agentId, d]));
    assert.equal(byId.has('sym'), false);
    assert.equal(byId.get('big')?.status, 'unknown');
  });
});

test('parent transcript evidence beyond the 1 MiB tail window is not used', async () => {
  const pad = JSON.stringify({ type: 'system', padding: 'x'.repeat(1024 * 1024) });
  await withProject(
    [launch('toolu_far', T1), syncResult('toolu_far', T2, 'far1')],
    async ({ adapter, subDir }) => {
      await writeFile(join(subDir, 'agent-far1.jsonl'), JSON.stringify(subJsonl()) + '\n');
      await writeFile(join(subDir, 'agent-far1.meta.json'), JSON.stringify({ toolUseId: 'toolu_far' }));
      const [entry] = await adapter.listSubagentDetails(sessionId);
      assert.equal(entry?.status, 'unknown');
    },
    (pad + '\n').repeat(2),
  );
});

test('subagent listing is capped at 200 entries', async () => {
  await withProject([], async ({ adapter, subDir }) => {
    await Promise.all(
      Array.from({ length: 205 }, (_, i) => writeFile(join(subDir, `agent-c${String(i).padStart(3, '0')}.meta.json`), '{}')),
    );
    assert.equal((await adapter.listSubagentDetails(sessionId)).length, 200);
  });
});
