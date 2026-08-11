import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClaudeProviderAdapter } from './facade.js';

test('keeps Claude history message ids stable across repeated reads', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-facade-'));
  const projectsDir = join(base, 'projects');
  const projectDir = join(projectsDir, 'project');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-11T10:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-11T10:00:01.000Z',
        message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'world' }] },
      }),
    ].join('\n') + '\n');

    const adapter = new ClaudeProviderAdapter({ projectsDir });
    const first = await adapter.getHistory(sessionId);
    const second = await adapter.getHistory(sessionId);

    assert.equal(first.length, 2);
    assert.equal(new Set(first.map((message) => message.id)).size, 2);
    assert.deepEqual(second.map((message) => message.id), first.map((message) => message.id));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
