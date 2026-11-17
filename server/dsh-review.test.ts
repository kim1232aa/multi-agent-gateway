import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DshAdapter } from './dsh-adapter.js';

/** 真实会话足够大时,zstd 会分成多个块,截断尾部仍能解出前面完整块。 */
function buildSession(id: string, userText: string, fillerLines: number): string {
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id, createdAt: 1700000000000, cwd: '/work' }),
    JSON.stringify({ type: 'user/message', data: { message: { content: [{ type: 'text', text: userText }] } } }),
  ];
  for (let i = 0; i < fillerLines; i += 1) {
    lines.push(JSON.stringify({ type: 'assistant/message', seq: i, data: { message: { content: [{ type: 'text', text: `chunk ${i} `.repeat(40) }] } } }));
  }
  return lines.join('\n');
}

test('DSH review: a session file mid-append still lists instead of 404', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-partial-'));
  try {
    const sessionDir = join(tempDir, '--work--', 'partial-sess');
    await mkdir(sessionDir, { recursive: true });
    const full = zlib.zstdCompressSync(Buffer.from(buildSession('partial-sess', '你好', 300), 'utf8'));
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), full.subarray(0, full.length - 40));

    const adapter = new DshAdapter({ sessionsDir: tempDir });
    const sessions = adapter.listSessionsFromDisk();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, 'partial-sess');
    assert.equal(sessions[0]?.title, '你好');
    assert.ok(adapter.getHistoryMessages('partial-sess').length > 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('DSH review: a half-written trailing line is skipped, not fatal', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-partial-line-'));
  try {
    const sessionDir = join(tempDir, '--work--', 'cut-line');
    await mkdir(sessionDir, { recursive: true });
    const body = buildSession('cut-line', 'hello', 300) + '\n{"type":"assistant/message","data":{"message":{"content":[{"type":"text","te';
    const compressed = zlib.zstdCompressSync(Buffer.from(body, 'utf8'));
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), compressed.subarray(0, compressed.length - 40));

    const adapter = new DshAdapter({ sessionsDir: tempDir });
    const [session] = adapter.listSessionsFromDisk();
    assert.equal(session?.id, 'cut-line');
    assert.ok(adapter.getHistoryMessages('cut-line').length >= 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
