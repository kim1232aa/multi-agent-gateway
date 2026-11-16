import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as zlib from 'node:zlib';
import { DshAdapter, DshProviderAdapter, resolveDshBin, resolveDshSessionsDir } from './dsh-adapter.js';
import { DshAcpClient } from './dsh-acp.js';

test('resolveDshBin falls back gracefully', () => {
  const custom = resolveDshBin('/usr/custom/bin/dsh');
  assert.equal(custom, '/usr/custom/bin/dsh');

  process.env.DSH_BIN = '/env/bin/dsh';
  assert.equal(resolveDshBin(), '/env/bin/dsh');
  delete process.env.DSH_BIN;
});

test('resolveDshSessionsDir respects DSH_HOME', () => {
  const orig = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '/custom/dsh';
    assert.equal(resolveDshSessionsDir(), '/custom/dsh/sessions');
  } finally {
    if (orig !== undefined) process.env.DSH_HOME = orig;
    else delete process.env.DSH_HOME;
  }
});

test('DshAdapter: listSessionsFromDisk and getHistoryMessages from zstd files', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-test-sessions-'));
  try {
    const groupDir = join(tempDir, '--tmp--');
    const sessionDir = join(groupDir, 'test-sess-123');
    await mkdir(sessionDir, { recursive: true });

    // Create session.v4.jsonl.zstd
    const lines = [
      JSON.stringify({ type: 'session', version: 4, id: 'test-sess-123', createdAt: 1700000000000, cwd: '/tmp' }),
      JSON.stringify({ type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Hello DeepSeek!' }] } } }),
      JSON.stringify({
        type: 'assistant/message',
        data: {
          message: {
            content: [
              { type: 'reasoning', text: 'Thinking step...' },
              { type: 'text', text: 'Hello! How can I help?' },
            ],
          },
        },
      }),
    ].join('\n');

    const compressed = zlib.zstdCompressSync(Buffer.from(lines, 'utf8'));
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), compressed);

    // Also create an empty session to test filtering
    const emptySessionDir = join(groupDir, 'empty-sess-456');
    await mkdir(emptySessionDir, { recursive: true });
    const emptyLines = JSON.stringify({ type: 'session', version: 4, id: 'empty-sess-456', createdAt: 1700000000000, cwd: '/tmp' });
    await writeFile(join(emptySessionDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(emptyLines, 'utf8')));

    const adapter = new DshAdapter({ sessionsDir: tempDir });
    const sessions = adapter.listSessionsFromDisk();

    // Empty session should be filtered out
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, 'test-sess-123');
    assert.equal(sessions[0]?.title, 'Hello DeepSeek!');
    assert.equal(sessions[0]?.messageCount, 1);

    // Test getHistoryMessages
    const history = adapter.getHistoryMessages('test-sess-123');
    assert.equal(history.length, 2);
    assert.equal(history[0]?.role, 'user');
    assert.equal(history[1]?.role, 'assistant');
    assert.equal(history[1]?.content.length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('DshProviderAdapter: contract methods', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-provider-test-'));
  try {
    const adapter = new DshProviderAdapter({ sessionsDir: tempDir });
    const caps = adapter.capabilities();
    assert.equal(caps.streaming, true);
    assert.equal(caps.approvals, true);
    assert.equal(caps.commands, true);

    const models = await adapter.models();
    assert.ok(models.length >= 3);
    assert.ok(models.some((m) => m.model === 'deepseek-v4-flash'));

    const cmds = await adapter.commands();
    assert.ok(cmds.some((c) => c.name === '/plan'));
    assert.ok(cmds.some((c) => c.name === '/compact'));

    const listRes = await adapter.list();
    assert.deepEqual(listRes.items, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('DshAcpClient: mock process interaction & approvals', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-acp-test-'));
  try {
    const fakeDsh = join(tempDir, 'fake-dsh.sh');
    const script = `#!/usr/bin/env node
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { protocolVersion: 1, agentInfo: { name: 'mock' } }
    }) + '\\n');
  } else if (req.method === 'session/new') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { sessionId: 'mock-session-1' }
    }) + '\\n');
  } else if (req.method === 'session/prompt') {
    // Send thought chunk
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: req.params.sessionId,
        update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'pondering...' } }
      }
    }) + '\\n');
    // Send message chunk
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: req.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { text: 'done' } }
      }
    }) + '\\n');
    // Finish prompt
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { stopReason: 'end' }
    }) + '\\n');
  }
});
`;
    await writeFile(fakeDsh, script, 'utf8');
    await chmod(fakeDsh, 0o755);

    const client = new DshAcpClient({ dshBin: fakeDsh });
    const events: any[] = [];
    client.on((ev) => events.push(ev));

    const newRes = await client.newSession('/tmp');
    assert.equal(newRes.sessionId, 'mock-session-1');

    const promptRes = await client.prompt('mock-session-1', 'hi');
    assert.equal(promptRes.stopReason, 'end');

    assert.ok(events.some((e) => e.type === 'thought_chunk' && e.text === 'pondering...'));
    assert.ok(events.some((e) => e.type === 'message_chunk' && e.text === 'done'));

    client.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
