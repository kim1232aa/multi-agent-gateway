import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClaudeAdapter } from './claude-adapter.js';

test('rejects traversal session ids before reading transcript paths', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-adapter-'));
  const projectsDir = join(base, 'projects');
  try {
    await mkdir(join(projectsDir, 'project'), { recursive: true });
    await writeFile(
      join(base, 'escape.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'outside transcript' } }) + '\n',
    );

    const adapter = new ClaudeAdapter({ projectsDir });
    await assert.rejects(adapter.getHistory('../../escape'), /session not found/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
