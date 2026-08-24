import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('initialize handshake resolves fast when the CLI exits immediately', async () => {
  // 回归:此前只监听 spawn 的 error,CLI 启动即退不触发——每次握手卡满 20s。
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-fast-exit-'));
  try {
    const bin = join(base, 'claude-fast-exit');
    await writeFile(bin, '#!/bin/sh\nexit 1\n');
    await chmod(bin, 0o755);
    const adapter = new ClaudeAdapter({ claudeBin: bin });

    const modelsStart = Date.now();
    await assert.rejects(adapter.listBuiltinModels(), /no models/);
    assert.ok(Date.now() - modelsStart < 5_000, 'handshake must not wait for the 20s timeout');

    // 命令目录同一口径:失败如实抛错,不吞成空目录。
    const commandsStart = Date.now();
    await assert.rejects(adapter.listSlashCommands(), /no commands/);
    assert.ok(Date.now() - commandsStart < 5_000, 'commands handshake must not wait for the 20s timeout');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('lists only UUID-named transcripts, matching native claude resume', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-list-'));
  const projectsDir = join(base, 'projects');
  try {
    await mkdir(join(projectsDir, 'proj'), { recursive: true });
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      sessionId: uuid,
    });
    await writeFile(join(projectsDir, 'proj', `${uuid}.jsonl`), `${line}\n`);
    // 非 UUID 的 .jsonl 能进列表却打不开(findSessionFile 拒收)——不如不列。
    await writeFile(join(projectsDir, 'proj', 'notes.jsonl'), `${line}\n`);

    const adapter = new ClaudeAdapter({ projectsDir });
    const items = await adapter.list();
    assert.deepEqual(items.map((s: { sessionId: string }) => s.sessionId), [uuid]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('serializes a new turn behind the interrupted process instead of failing it', async () => {
  // 回归:abort 后立刻重提,旧进程还没退出(SIGINT→SIGKILL 最长 5s),
  // 新 turn 此前 100% 撞 running 拒绝。现在必须等旧进程退干净再起。
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-interrupt-'));
  try {
    const bin = join(base, 'claude-hang');
    // Hang independently of stdin EOF so a later steer can keep the pipe open.
    // exec sleep so SIGINT lands on the same pid the adapter spawned.
    await writeFile(bin, '#!/bin/sh\nexec sleep 60\n');
    await chmod(bin, 0o755);
    const adapter = new ClaudeAdapter({ claudeBin: bin });
    const sessionId = '123e4567-e89b-12d3-a456-426614174001';
    const events: string[] = [];

    const interruptWhenRunning = async (): Promise<void> => {
      for (let i = 0; i < 100; i += 1) {
        if (adapter.interrupt(sessionId)) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('turn process never started');
    };

    const first = adapter.startTurn({
      sessionId, prompt: 'one',
      onEvent: (ev) => { events.push(`first:${ev.type}`); },
    });
    await interruptWhenRunning();
    // 旧进程还在退出窗口内就开新 turn:必须等退出接力,不能抛 already running。
    const second = adapter.startTurn({
      sessionId, prompt: 'two',
      onEvent: (ev) => { events.push(`second:${ev.type}`); },
    });

    await first;
    await interruptWhenRunning();
    await second;

    assert.ok(events.includes('first:interrupted'), events.join(','));
    assert.ok(events.includes('second:interrupted'), events.join(','));
    await adapter.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

async function waitForLogLines(logPath: string, n: number): Promise<string[]> {
  for (let i = 0; i < 100; i += 1) {
    try {
      const text = await readFile(logPath, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      if (lines.length >= n) return lines;
    } catch {
      // log not created yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${n} stdin log line(s)`);
}

test('steers a second user line into an open stdin before interrupt', async () => {
  // Mid-turn 插话: keep stdin open after the first prompt so a later user
  // stream-json line reaches the SAME hanging CLI process. Do not fake this
  // by interrupt + a new turn (that would spawn a second process).
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-steer-'));
  try {
    const bin = join(base, 'claude-hang');
    const log = join(base, 'stdin.log');
    await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
fs.writeFileSync(log, JSON.stringify({ spawn: process.pid }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  fs.appendFileSync(log, line + '\\n');
});
setInterval(() => {}, 60_000);
`);
    await chmod(bin, 0o755);
    const adapter = new ClaudeAdapter({ claudeBin: bin });
    const sessionId = '123e4567-e89b-12d3-a456-426614174099';

    const turn = adapter.startTurn({
      sessionId,
      prompt: 'first prompt',
      onEvent: () => {},
    });

    const afterFirst = await waitForLogLines(log, 2);
    const spawnLine = JSON.parse(afterFirst[0]!);
    const first = JSON.parse(afterFirst[1]!);
    assert.equal(typeof spawnLine.spawn, 'number');
    assert.equal(first.type, 'user');
    assert.equal(first.message.role, 'user');
    assert.deepEqual(first.message.content, [{ type: 'text', text: 'first prompt' }]);

    await adapter.steer(sessionId, 'mid-turn injection');
    const afterSteer = await waitForLogLines(log, 3);
    const second = JSON.parse(afterSteer[2]!);
    assert.equal(second.type, 'user');
    assert.equal(second.message.role, 'user');
    assert.deepEqual(second.message.content, [{ type: 'text', text: 'mid-turn injection' }]);
    assert.equal(JSON.parse(afterSteer[0]!).spawn, spawnLine.spawn, 'steer must reuse the same CLI process');

    assert.ok(adapter.interrupt(sessionId));
    await turn;
    await assert.rejects(adapter.steer(sessionId, 'too late'), /no running/);
    await adapter.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('closes stdin after the result event so the CLI can exit', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-result-eof-'));
  try {
    const bin = join(base, 'claude-result');
    await writeFile(bin, `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let sent = false;
rl.on('line', () => {
  if (sent) return;
  sent = true;
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'ok',
    is_error: false,
    session_id: '123e4567-e89b-12d3-a456-426614174088',
  }) + '\\n');
});
rl.on('close', () => process.exit(0));
`);
    await chmod(bin, 0o755);
    const adapter = new ClaudeAdapter({ claudeBin: bin });
    const events: string[] = [];
    await adapter.startTurn({
      sessionId: '123e4567-e89b-12d3-a456-426614174088',
      prompt: 'go',
      onEvent: (ev) => { events.push(ev.type); },
    });
    assert.ok(events.includes('done'), events.join(','));
    await adapter.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
