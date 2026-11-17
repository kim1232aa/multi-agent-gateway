import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ClaudeAdapter,
  LruCache,
  encodeAskUserQuestionAnswers,
  followClaudeBranch,
  mapControlPermissionMode,
  resolveClaudeBin,
  type ClaudeAdapterEvent,
} from './claude-adapter.js';
import { ClaudeProviderAdapter } from './facade.js';

test('review regression: array history sanitizes tags and parses local commands', async () => {
  const base = await mkdtemp(join(tmpdir(), 'claude-review-regression-'));
  const projectsDir = join(base, 'projects');
  const projectDir = join(projectsDir, 'project');
  const sessionId = '11111111-1111-4111-8111-999999999999';
  const text = (value: string) => [{ type: 'text', text: value }];
  const entries = [
    { role: 'user', content: text('Check:\n<pasted_content id="1">\nconst a = 1;\n</pasted_content id="1">') },
    { role: 'user', content: text('<local-command-caveat>ignore this</local-command-caveat>') },
    { role: 'user', content: text('<command-name>/context</command-name><command-args>detail</command-args>') },
    { role: 'user', content: text('<local-command-stdout>Context output</local-command-stdout>') },
    { role: 'user', content: text('<bash-input>echo hi</bash-input>') },
    { role: 'user', content: text('<bash-stdout>hi</bash-stdout>') },
    { role: 'assistant', content: [
      { type: 'text', text: 'Before' },
      { type: 'thinking', thinking: 'reason' },
      { type: 'text', text: 'After' },
    ] },
  ];
  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${sessionId}.jsonl`), entries.map((entry, index) => JSON.stringify({
      type: entry.role,
      uuid: `entry-${index}`,
      parentUuid: index ? `entry-${index - 1}` : null,
      message: entry,
    })).join('\n') + '\n');

    const adapter = new ClaudeProviderAdapter({ projectsDir, settingsPath: join(base, 'settings.json') });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let history: Awaited<ReturnType<typeof adapter.getHistory>>;
    try {
      history = await Promise.race([
        adapter.getHistory(sessionId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('history timed out')), 1_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(history.length, 6);
    assert.deepEqual(history.slice(0, 3).map((message) => ({ role: message.role, content: message.content })), [
      { role: 'user', content: [{ type: 'text', text: 'Check:\nconst a = 1;' }] },
      { role: 'user', content: [{ type: 'text', text: '/context detail' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Context output' }] },
    ]);
    assert.equal(history[3]?.role, 'assistant');
    assert.equal(history[3]?.content[0]?.type, 'tool_use');
    assert.deepEqual((history[3]?.content[0] as any).input, { command: 'echo hi' });
    assert.equal(history[4]?.role, 'tool');
    assert.equal(history[4]?.content[0]?.type, 'tool_result');
    assert.equal((history[4]?.content[0] as any).output, 'hi');
    assert.deepEqual(history[5]?.content, [
      { type: 'text', text: 'Before' },
      { type: 'thinking', thinking: 'reason' },
      { type: 'text', text: 'After' },
    ]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: array history retains mixed assistant text and thinking in order', async () => {
  const base = await mkdtemp(join(tmpdir(), 'claude-review-mixed-'));
  const projectsDir = join(base, 'projects');
  const projectDir = join(projectsDir, 'project');
  const sessionId = '11111111-1111-4111-8111-999999999998';
  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${sessionId}.jsonl`), JSON.stringify({
      type: 'assistant', uuid: 'a1', parentUuid: null,
      message: { role: 'assistant', content: [
        { type: 'text', text: 'Before' },
        { type: 'thinking', thinking: 'reason' },
        { type: 'text', text: 'After' },
      ] },
    }) + '\n');
    const adapter = new ClaudeProviderAdapter({ projectsDir, settingsPath: join(base, 'settings.json') });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const history = await Promise.race([
        adapter.getHistory(sessionId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('history timed out')), 1_000);
        }),
      ]);
      assert.deepEqual(history[0]?.content, [
        { type: 'text', text: 'Before' },
        { type: 'thinking', thinking: 'reason' },
        { type: 'text', text: 'After' },
      ]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

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
    const adapter = new ClaudeAdapter({
      claudeBin: bin,
      configDir: join(base, 'config'),
      env: { HOME: base },
    });

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

test('delete unlinks the transcript jsonl and is idempotent', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-delete-'));
  const projectsDir = join(base, 'projects');
  try {
    await mkdir(join(projectsDir, 'proj'), { recursive: true });
    const uuid = '123e4567-e89b-12d3-a456-426614174010';
    const file = join(projectsDir, 'proj', `${uuid}.jsonl`);
    await writeFile(file, `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      timestamp: '2026-01-01T00:00:00.000Z',
    })}\n`);

    const adapter = new ClaudeAdapter({ projectsDir });
    assert.equal(adapter.hasSessionFile(uuid), true);
    await adapter.getHistory(uuid);
    await adapter.delete(uuid);
    assert.equal(adapter.hasSessionFile(uuid), false);
    await assert.rejects(adapter.getHistory(uuid), /session not found/);
    await adapter.delete(uuid);
    assert.deepEqual(await adapter.list(), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('forkSession captures a new session_id from --fork-session init', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-fork-'));
  try {
    const bin = join(base, 'claude-fork');
    const stdinLog = join(base, 'stdin.log');
    const oldId = '123e4567-e89b-12d3-a456-426614174020';
    const newId = '99999999-9999-4999-8999-999999999999';
    await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const stdinLog = ${JSON.stringify(stdinLog)};
fs.writeFileSync(stdinLog, '');
process.stdin.on('data', (chunk) => fs.appendFileSync(stdinLog, chunk));
const forked = process.argv.includes('--fork-session');
const resumeAt = process.argv.indexOf('--resume');
const resumeId = resumeAt >= 0 ? process.argv[resumeAt + 1] : '';
const sessionId = forked ? ${JSON.stringify(newId)} : resumeId;
process.stdout.write(JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  cwd: '/tmp',
  tools: [],
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: 'ok',
  is_error: false,
  session_id: sessionId,
}) + '\\n');
setTimeout(() => process.exit(0), 50);
`);
    await chmod(bin, 0o755);
    const adapter = new ClaudeAdapter({ claudeBin: bin });
    try {
      const forked = await adapter.forkSession(oldId, '/tmp');
      assert.equal(forked.sessionId, newId);
      const stdin = await readFile(stdinLog, 'utf8').catch(() => '');
      assert.equal(stdin.includes('Continue from this fork.'), false);
      assert.equal(stdin.trim(), '');
    } finally {
      await adapter.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('forkSession throws when the CLI reuses the original session id', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-fork-same-'));
  try {
    const bin = join(base, 'claude-fork-same');
    const oldId = '123e4567-e89b-12d3-a456-426614174021';
    await writeFile(bin, `#!/usr/bin/env node
const resumeAt = process.argv.indexOf('--resume');
const sessionId = resumeAt >= 0 ? process.argv[resumeAt + 1] : 'unknown';
process.stdout.write(JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  cwd: '/tmp',
  tools: [],
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: 'ok',
  is_error: false,
  session_id: sessionId,
}) + '\\n');
setTimeout(() => process.exit(0), 50);
`);
    await chmod(bin, 0o755);
    const adapter = new ClaudeAdapter({ claudeBin: bin });
    try {
      await assert.rejects(
        adapter.forkSession(oldId, '/tmp'),
        /did not yield a new session id/,
      );
    } finally {
      await adapter.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('control_request can_use_tool parks until resolveApproval allow, then result', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-approval-'));
  try {
    const bin = join(base, 'claude-approval');
    const log = join(base, 'stdin.log');
    const sessionId = '123e4567-e89b-12d3-a456-426614174077';
    await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
const sessionId = ${JSON.stringify(sessionId)};
const rl = readline.createInterface({ input: process.stdin });
let phase = 0;
rl.on('line', (line) => {
  fs.appendFileSync(log, line + '\\n');
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (phase === 0 && msg.type === 'user') {
    phase = 1;
    process.stdout.write(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      cwd: '/tmp',
      tools: ['Bash'],
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'control_request',
      request_id: 'req_tool_1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'pwd' },
        tool_use_id: 'toolu_1',
      },
    }) + '\\n');
    return;
  }
  if (phase === 1 && msg.type === 'control_response') {
    phase = 2;
    const behavior = msg.response && msg.response.response && msg.response.response.behavior;
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: behavior === 'allow' ? 'allowed' : 'denied',
      is_error: false,
      session_id: sessionId,
    }) + '\\n');
  }
});
rl.on('close', () => process.exit(0));
`);
    await chmod(bin, 0o755);
    const adapter = new ClaudeAdapter({ claudeBin: bin });
    try {
      const events: Array<{ type: string; approvalId?: string; tool?: string; input?: unknown; result?: string }> = [];
      const turn = adapter.startTurn({
        sessionId,
        prompt: 'run pwd',
        onEvent: (ev) => { events.push(ev as any); },
      });

      let approval: { approvalId: string; tool: string; input?: unknown } | undefined;
      for (let i = 0; i < 100; i += 1) {
        approval = events.find((ev) => ev.type === 'approval') as typeof approval;
        if (approval) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(approval, `never got approval event: ${events.map((e) => e.type).join(',')}`);
      assert.equal(approval!.approvalId, 'req_tool_1');
      assert.equal(approval!.tool, 'Bash');
      assert.deepEqual(approval!.input, { command: 'pwd' });

      await adapter.resolveApproval(sessionId, 'req_tool_1', 'allow');
      await turn;

      assert.ok(events.some((ev) => ev.type === 'done' && ev.result === 'allowed'), events.map((e) => e.type).join(','));
      const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
      const response = lines.map((line) => JSON.parse(line)).find((msg) => msg.type === 'control_response');
      assert.equal(response?.response?.subtype, 'success');
      assert.equal(response?.response?.request_id, 'req_tool_1');
      assert.equal(response?.response?.response?.behavior, 'allow');
      assert.deepEqual(response?.response?.response?.updatedInput, { command: 'pwd' });
    } finally {
      await adapter.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Executable resolution, env isolation (strip GATEWAY_*), CLAUDE_CONFIG_DIR
// ---------------------------------------------------------------------------

test('resolveClaudeBin honors claudeBin > CLAUDE_BIN > PATH > ~/.local/bin/claude', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-bin-res-'));
  const saved = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  };
  try {
    const fakeHome = join(base, 'home');
    const localBinDir = join(fakeHome, '.local', 'bin');
    const pathDir = join(base, 'path-bin');
    const nonExecDir = join(base, 'non-exec');
    await mkdir(localBinDir, { recursive: true });
    await mkdir(pathDir, { recursive: true });
    await mkdir(join(nonExecDir, 'claude'), { recursive: true }); // directory named 'claude' must be skipped

    const localBin = join(localBinDir, 'claude');
    const pathBin = join(pathDir, 'claude');
    const envBin = join(base, 'env-claude');
    const optBin = join(base, 'opt-claude');
    for (const p of [localBin, pathBin, envBin, optBin]) {
      await writeFile(p, '#!/bin/sh\nexit 0\n');
      await chmod(p, 0o755);
    }

    process.env.HOME = fakeHome;
    process.env.PATH = `${nonExecDir}:${pathDir}`;
    process.env.CLAUDE_BIN = envBin;

    assert.equal(resolveClaudeBin({ claudeBin: optBin }), optBin);
    assert.equal(resolveClaudeBin({}), envBin);
    assert.equal(resolveClaudeBin({ env: { CLAUDE_BIN: optBin } }), optBin);

    // Explicit empty CLAUDE_BIN in options.env falls through to PATH, skipping directory 'claude'
    assert.equal(resolveClaudeBin({ env: { CLAUDE_BIN: '' } }), pathBin);

    delete process.env.CLAUDE_BIN;
    assert.equal(resolveClaudeBin({}), pathBin);

    // Without PATH match, falls back to ~/.local/bin/claude
    assert.equal(resolveClaudeBin({ env: { PATH: nonExecDir, HOME: fakeHome } }), localBin);
  } finally {
    if (saved.CLAUDE_BIN === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = saved.CLAUDE_BIN;
    if (saved.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = saved.PATH;
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    await rm(base, { recursive: true, force: true });
  }
});

test('strips GATEWAY_* env from spawned claude child and honors custom CLAUDE_CONFIG_DIR', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-env-strip-'));
  const savedGatewayToken = process.env.GATEWAY_TOKEN;
  const savedGatewayPort = process.env.GATEWAY_PORT;
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.GATEWAY_TOKEN = 'secret-gateway-token';
    process.env.GATEWAY_PORT = '58629';
    const customConfig = join(base, 'custom-claude-config');
    const projDir = join(customConfig, 'projects', 'my-proj');
    await mkdir(projDir, { recursive: true });
    const sessionId = '11111111-2222-4333-8444-555555555555';
    await writeFile(
      join(projDir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        cwd: '/tmp/work',
        timestamp: '2026-05-01T00:00:00.000Z',
        message: { role: 'user', content: 'from custom config' },
      }) + '\n',
    );

    const envLog = join(base, 'child-env.json');
    const bin = join(base, 'claude');
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(envLog)}, JSON.stringify({
  gatewayToken: process.env.GATEWAY_TOKEN ?? null,
  gatewayPort: process.env.GATEWAY_PORT ?? null,
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  customKeep: process.env.CUSTOM_KEEP ?? null,
  noTraffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null,
}));
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: 'ok',
  is_error: false,
  session_id: ${JSON.stringify(sessionId)},
}) + '\\n');
`,
    );
    await chmod(bin, 0o755);

    process.env.CLAUDE_CONFIG_DIR = customConfig;
    const adapter = new ClaudeAdapter({ claudeBin: bin, env: { CUSTOM_KEEP: 'yes' } });
    const listed = await adapter.list();
    assert.deepEqual(listed.map((s) => s.sessionId), [sessionId]);
    assert.equal(listed[0]?.title, 'from custom config');
    assert.equal(adapter.hasSessionFile(sessionId), true);

    await adapter.startTurn({ sessionId, prompt: 'hi', onEvent: () => {} });
    const captured = JSON.parse(await readFile(envLog, 'utf8'));
    assert.equal(captured.gatewayToken, null);
    assert.equal(captured.gatewayPort, null);
    assert.equal(captured.configDir, customConfig);
    assert.equal(captured.customKeep, 'yes');
    assert.equal(captured.noTraffic, '1');
    await adapter.close();
  } finally {
    if (savedGatewayToken === undefined) delete process.env.GATEWAY_TOKEN;
    else process.env.GATEWAY_TOKEN = savedGatewayToken;
    if (savedGatewayPort === undefined) delete process.env.GATEWAY_PORT;
    else process.env.GATEWAY_PORT = savedGatewayPort;
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. AskUserQuestion encoding & can_use_tool metadata / responses
// ---------------------------------------------------------------------------

test('encodeAskUserQuestionAnswers maps q_N indices, comma-joins multiSelect, and validates bounds', () => {
  const questions = [
    { question: 'Pick a color?', header: 'Color', multiSelect: false },
    { question: 'Which DBs?', header: 'DB', multiSelect: true },
    { question: 'Special options?', header: 'Special', multiSelect: true },
  ];

  const mapped = encodeAskUserQuestionAnswers(questions, {
    q_0: ['Blue'],
    q_1: ['Postgres', 'Redis'],
    q_2: ['A, B', 'Normal'],
  });
  assert.deepEqual(mapped, {
    'Pick a color?': 'Blue',
    'Which DBs?': 'Postgres, Redis',
    'Special options?': '"A, B", Normal',
  });

  assert.deepEqual(encodeAskUserQuestionAnswers(questions, 'Green'), {
    'Pick a color?': 'Green',
  });

  assert.throws(() => encodeAskUserQuestionAnswers(questions, { q_3: ['x'] }), /out of bounds/);
  assert.throws(() => encodeAskUserQuestionAnswers(questions, { 'q_-1': ['x'] }), /out of bounds/);
  assert.throws(() => encodeAskUserQuestionAnswers(questions, { bogus: ['x'] }), /unknown question key/);
});

test('AskUserQuestion control_request preserves original input and translates q_N answers', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-ask-'));
  try {
    const bin = join(base, 'claude-ask');
    const log = join(base, 'stdin.log');
    const sessionId = '123e4567-e89b-12d3-a456-426614174050';
    const rawQuestions = [
      { question: 'Target runtime?', header: 'Runtime', multiSelect: false, options: [{ label: 'Node' }, { label: 'Bun' }] },
      { question: 'Features?', header: 'Features', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Cache' }] },
    ];
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
const sessionId = ${JSON.stringify(sessionId)};
const questions = ${JSON.stringify(rawQuestions)};
const rl = readline.createInterface({ input: process.stdin });
let sent = false;
rl.on('line', (line) => {
  fs.appendFileSync(log, line + '\\n');
  const msg = JSON.parse(line);
  if (!sent && msg.type === 'user') {
    sent = true;
    process.stdout.write(JSON.stringify({
      type: 'control_request',
      request_id: 'req_ask_1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'toolu_ask_1',
        input: { questions, metadata: { source: 'wizard' } },
      },
    }) + '\\n');
    return;
  }
  if (msg.type === 'control_response') {
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'done',
      is_error: false,
      session_id: sessionId,
    }) + '\\n');
  }
});
rl.on('close', () => process.exit(0));
`,
    );
    await chmod(bin, 0o755);

    const adapter = new ClaudeAdapter({ claudeBin: bin });
    try {
      const events: ClaudeAdapterEvent[] = [];
      const turn = adapter.startTurn({
        sessionId,
        prompt: 'ask me',
        onEvent: (ev) => events.push(ev),
      });

      let questionEv: Extract<ClaudeAdapterEvent, { type: 'question' }> | undefined;
      for (let i = 0; i < 100; i += 1) {
        questionEv = events.find((e) => e.type === 'question') as typeof questionEv;
        if (questionEv) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(questionEv);

      await assert.rejects(
        adapter.resolveQuestion(sessionId, 'req_ask_1', { q_5: ['invalid'] }),
        /out of bounds/,
      );
      await adapter.resolveQuestion(sessionId, 'req_ask_1', {
        q_0: ['Node'],
        q_1: ['Auth', 'Cache'],
      });
      await turn;

      const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const ctrlResp = lines.find((m) => m.type === 'control_response');
      assert.equal(ctrlResp?.response?.subtype, 'success');
      assert.equal(ctrlResp?.response?.response?.behavior, 'allow');
      assert.equal(ctrlResp?.response?.response?.toolUseID, 'toolu_ask_1');
      assert.deepEqual(ctrlResp?.response?.response?.updatedInput, {
        questions: rawQuestions,
        metadata: { source: 'wizard' },
        answers: {
          'Target runtime?': 'Node',
          'Features?': 'Auth, Cache',
        },
      });
    } finally {
      await adapter.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('can_use_tool preserves granular metadata, enforces suppressAlwaysAllow on approve_always, and sends required deny message', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-perms-'));
  try {
    const bin = join(base, 'claude-perms');
    const log = join(base, 'stdin.log');
    const sessionId = '123e4567-e89b-12d3-a456-426614174051';
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls *' }], behavior: 'allow', destination: 'session' }];

    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
const sessionId = ${JSON.stringify(sessionId)};
const suggestions = ${JSON.stringify(suggestions)};
const rl = readline.createInterface({ input: process.stdin });
let step = 0;
rl.on('line', (line) => {
  fs.appendFileSync(log, line + '\\n');
  const msg = JSON.parse(line);
  if (step === 0 && msg.type === 'user') {
    step = 1;
    process.stdout.write(JSON.stringify({
      type: 'control_request',
      request_id: 'req_p1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'toolu_p1',
        input: { command: 'ls' },
        permission_suggestions: suggestions,
        blocked_path: '/etc/shadow',
        decision_reason: 'Reads outside workspace',
        decision_reason_type: 'safetyCheck',
        suppress_always_allow_rule: false,
        default_to_no: true,
        requires_user_interaction: false,
      },
    }) + '\\n');
    return;
  }
  if (step === 1 && msg.type === 'control_response') {
    step = 2;
    process.stdout.write(JSON.stringify({
      type: 'control_request',
      request_id: 'req_p2',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'toolu_p2',
        input: { command: 'rm -rf /tmp/x' },
        permission_suggestions: suggestions,
        suppress_always_allow_rule: true,
        default_to_no: true,
        requires_user_interaction: true,
      },
    }) + '\\n');
    return;
  }
  if (step === 2 && msg.type === 'control_response') {
    step = 3;
    process.stdout.write(JSON.stringify({
      type: 'control_request',
      request_id: 'req_p3',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Write',
        tool_use_id: 'toolu_p3',
        input: { file_path: '/tmp/a.txt' },
      },
    }) + '\\n');
    return;
  }
  if (step === 3 && msg.type === 'control_response') {
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'done',
      is_error: false,
      session_id: sessionId,
    }) + '\\n');
  }
});
rl.on('close', () => process.exit(0));
`,
    );
    await chmod(bin, 0o755);

    const adapter = new ClaudeAdapter({ claudeBin: bin });
    try {
      const events: ClaudeAdapterEvent[] = [];
      const turn = adapter.startTurn({ sessionId, prompt: 'test', onEvent: (ev) => events.push(ev) });

      const waitForApproval = async (id: string) => {
        for (let i = 0; i < 100; i += 1) {
          const hit = events.find((e) => e.type === 'approval' && e.approvalId === id);
          if (hit && hit.type === 'approval') return hit;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error(`timeout waiting for approval ${id}`);
      };

      const a1 = await waitForApproval('req_p1');
      assert.deepEqual(a1.suggestions, suggestions);
      assert.equal(a1.blockedPath, '/etc/shadow');
      assert.equal(a1.decisionReason, 'Reads outside workspace');
      assert.equal(a1.decisionReasonType, 'safetyCheck');
      assert.equal(a1.suppressAlwaysAllow, false);
      assert.equal(a1.defaultToNo, true);
      assert.equal(a1.requiresUserInteraction, false);
      await adapter.resolveApproval(sessionId, 'req_p1', 'approve_always');

      const a2 = await waitForApproval('req_p2');
      assert.equal(a2.suppressAlwaysAllow, true);
      assert.equal(a2.requiresUserInteraction, true);
      // Even if approve_always is requested, suppress_always_allow_rule/requires_user_interaction forbids updatedPermissions
      await adapter.resolveApproval(sessionId, 'req_p2', 'approve_always');

      await waitForApproval('req_p3');
      await adapter.resolveApproval(sessionId, 'req_p3', 'deny');

      await turn;

      const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const r1 = lines.find((m) => m.response?.request_id === 'req_p1')?.response?.response;
      const r2 = lines.find((m) => m.response?.request_id === 'req_p2')?.response?.response;
      const r3 = lines.find((m) => m.response?.request_id === 'req_p3')?.response?.response;

      assert.equal(r1?.behavior, 'allow');
      assert.deepEqual(r1?.updatedPermissions, suggestions);
      assert.equal(r1?.decisionClassification, 'user_permanent');

      assert.equal(r2?.behavior, 'allow');
      assert.equal(r2?.updatedPermissions, undefined);
      assert.equal(r2?.decisionClassification, 'user_temporary');

      assert.equal(r3?.behavior, 'deny');
      assert.equal(typeof r3?.message, 'string');
      assert.ok(r3.message.length > 0);
      assert.equal(r3?.decisionClassification, 'user_reject');
    } finally {
      await adapter.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Bidirectional control transport, correlation, cancel, unknown subtype, 2.1.325 models/events
// ---------------------------------------------------------------------------

test('correlates out-of-order control_responses by request_id, handles cancel & rejects unknown inbound subtypes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-ctrl-'));
  try {
    const bin = join(base, 'claude-ctrl');
    const log = join(base, 'stdin.log');
    const sessionId = '123e4567-e89b-12d3-a456-426614174052';

    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
const sessionId = ${JSON.stringify(sessionId)};
const rl = readline.createInterface({ input: process.stdin });
const held = [];
rl.on('line', (line) => {
  fs.appendFileSync(log, line + '\\n');
  const msg = JSON.parse(line);
  if (msg.type === 'user') {
    // Emit unknown inbound control_request, plus an approval that gets cancelled
    process.stdout.write(JSON.stringify({
      type: 'control_request',
      request_id: 'req_unknown_1',
      request: { subtype: 'future_unknown_widget', foo: 1 },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'control_request',
      request_id: 'req_cancel_me',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu_c', input: { command: 'date' } },
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ type: 'control_cancel_request', request_id: 'req_cancel_me' }) + '\\n');
    }, 30);
    return;
  }
  if (msg.type === 'control_request') {
    const subtype = msg.request?.subtype;
    if (subtype === 'set_model' || subtype === 'mcp_status') {
      held.push(msg);
      if (held.length === 2) {
        // Reply OUT OF ORDER: second request first, first request second!
        const [first, second] = held;
        const replyFor = (req) =>
          req.request?.subtype === 'mcp_status'
            ? { mcpServers: [{ name: 'fs', status: 'connected' }] }
            : { model: 'claude-sonnet-5-5' };
        process.stdout.write(JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: second.request_id, response: replyFor(second) },
        }) + '\\n');
        process.stdout.write(JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: first.request_id, response: replyFor(first) },
        }) + '\\n');
      }
    } else if (subtype === 'interrupt') {
      process.stdout.write(JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } },
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'interrupted-ok',
        is_error: false,
        session_id: sessionId,
        total_cost_usd: 0.42,
        modelUsage: {
          'claude-sonnet-5-5': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 20, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.42, contextWindow: 200000, maxOutputTokens: 16384 },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: msg.request_id, response: {} },
      }) + '\\n');
    }
  }
});
rl.on('close', () => process.exit(0));
`,
    );
    await chmod(bin, 0o755);

    const adapter = new ClaudeAdapter({ claudeBin: bin });
    try {
      const events: ClaudeAdapterEvent[] = [];
      const turn = adapter.startTurn({ sessionId, prompt: 'go', onEvent: (ev) => events.push(ev) });

      // Wait for control_cancelled event
      for (let i = 0; i < 100; i += 1) {
        if (events.some((e) => e.type === 'control_cancelled' && e.requestId === 'req_cancel_me')) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(events.some((e) => e.type === 'control_cancelled' && e.requestId === 'req_cancel_me'));
      await assert.rejects(adapter.resolveApproval(sessionId, 'req_cancel_me', 'allow'), /no pending approval/);

      // Concurrent outbound requests answered out of order
      const [modelResp, mcpList] = await Promise.all([
        adapter.setModel(sessionId, 'sonnet'),
        adapter.mcpStatus(sessionId),
      ]);
      assert.equal(modelResp.model, 'claude-sonnet-5-5');
      assert.deepEqual(mcpList, [{ name: 'fs', status: 'connected' }]);

      await adapter.setPermissionMode(sessionId, 'manual');
      await adapter.setMaxThinkingTokens(sessionId, 8192, 'summarized');
      await adapter.setEffortLevel(sessionId, 'high');

      assert.equal(adapter.interrupt(sessionId), true);
      await turn;

      const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const unknownReply = lines.find((m) => m.type === 'control_response' && m.response?.request_id === 'req_unknown_1');
      assert.equal(unknownReply?.response?.subtype, 'error');
      assert.equal(unknownReply?.response?.error_code, 'unsupported_request');

      const permReq = lines.find((m) => m.type === 'control_request' && m.request?.subtype === 'set_permission_mode');
      assert.equal(permReq?.request?.mode, 'default'); // CLI-only 'manual' mapped to 'default'

      const flagReq = lines.find((m) => m.type === 'control_request' && m.request?.subtype === 'apply_flag_settings');
      assert.deepEqual(flagReq?.request?.settings, { effortLevel: 'high' });

      const doneEv = events.find((e) => e.type === 'done');
      assert.ok(doneEv && doneEv.type === 'done');
      assert.equal(doneEv.totalCostUsd, 0.42);
      assert.ok(doneEv.modelUsage && 'claude-sonnet-5-5' in doneEv.modelUsage);
    } finally {
      await adapter.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('mapControlPermissionMode explicitly maps 2.1.325 modes without sending CLI-only manual', () => {
  assert.equal(mapControlPermissionMode('default'), 'default');
  assert.equal(mapControlPermissionMode('manual'), 'default');
  assert.equal(mapControlPermissionMode('yolo'), 'bypassPermissions');
  assert.equal(mapControlPermissionMode('acceptEdits'), 'acceptEdits');
  assert.equal(mapControlPermissionMode('plan'), 'plan');
  assert.equal(mapControlPermissionMode('auto'), 'auto');
  assert.equal(mapControlPermissionMode('dontAsk'), 'dontAsk');
  assert.equal(mapControlPermissionMode('bypassPermissions'), 'bypassPermissions');
  assert.throws(() => mapControlPermissionMode('bogusMode'), /unsupported permission mode/);
});

test('preserves 2.1.325 model capability fields, full IDs, and parent_tool_use_id subagent/task events', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-21325-events-'));
  try {
    const bin = join(base, 'claude-21325');
    const sessionId = '123e4567-e89b-12d3-a456-426614174053';
    await writeFile(
      bin,
      `#!/usr/bin/env node
const readline = require('node:readline');
const sessionId = ${JSON.stringify(sessionId)};
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: { request_id: 'wrong_id', subtype: 'success', response: { models: [{ value: 'bad' }], commands: [] } },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: {
        request_id: msg.request_id,
        subtype: 'success',
        response: {
          fast_mode_state: 'off',
          fast_mode_disabled_reason: 'sdk_opt_in_required',
          commands: [{ name: 'compact', description: 'Compact', argumentHint: '', aliases: [] }],
          models: [
            {
              value: 'claude-opus-5-5',
              resolvedModel: 'claude-opus-5-5',
              displayName: 'Opus 5.5',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
              supportsAdaptiveThinking: true,
              supportsThinkingOff: false,
              supportsFastMode: true,
              supportsAutoMode: true,
            },
            {
              value: 'qwen3.6-flash[1m]',
              displayName: 'qwen3.6-flash[1m]',
            },
          ],
        },
      },
    }) + '\\n');
    return;
  }
  if (msg.type === 'user') {
    process.stdout.write(JSON.stringify({
      type: 'system', subtype: 'task_started', session_id: sessionId,
      task_id: 'task_1', tool_use_id: 'toolu_agent_1', description: 'Explore repo', subagent_type: 'Explore', uuid: 'u_ts',
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'system', subtype: 'task_progress', session_id: sessionId,
      task_id: 'task_1', tool_use_id: 'toolu_agent_1', description: 'Reading', last_tool_name: 'Read', summary: 'Scanning files', uuid: 'u_tp',
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent_1',
      agent_id: 'agent_1',
      subagent_type: 'Explore',
      uuid: 'u_sub_asst',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'checking files' },
          { type: 'text', text: 'Found match in foo.ts' },
          { type: 'tool_use', id: 'toolu_sub_read', name: 'Read', input: { file_path: 'foo.ts' } },
        ],
      },
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'tool_progress',
      tool_use_id: 'toolu_sub_read',
      tool_name: 'Read',
      parent_tool_use_id: 'toolu_agent_1',
      elapsed_time_seconds: 1.5,
      task_id: 'task_1',
      uuid: 'u_tprog',
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'system', subtype: 'task_notification', session_id: sessionId,
      task_id: 'task_1', tool_use_id: 'toolu_agent_1', status: 'completed', summary: 'Done exploring', uuid: 'u_tn',
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', result: 'ok', is_error: false, session_id: sessionId,
    }) + '\\n');
  }
});
rl.on('close', () => process.exit(0));
`,
    );
    await chmod(bin, 0o755);

    const adapter = new ClaudeAdapter({ claudeBin: bin });
    try {
      const models = await adapter.listBuiltinModels();
      assert.deepEqual(models.map((m) => m.value), ['claude-opus-5-5']);
      assert.equal(models[0]?.supportsAdaptiveThinking, true);
      assert.equal(models[0]?.supportsThinkingOff, false);
      assert.equal(models[0]?.fastMode, false);
      assert.equal(models[0]?.supportsAutoMode, true);
      assert.equal(models[0]?.fastModeState, 'off');
      assert.equal(models[0]?.fastModeDisabledReason, 'sdk_opt_in_required');

      const events: ClaudeAdapterEvent[] = [];
      await adapter.startTurn({ sessionId, prompt: 'go', onEvent: (ev) => events.push(ev) });

      const subThinking = events.find((e) => e.type === 'thinking_delta' && e.parentToolUseId === 'toolu_agent_1');
      const subText = events.find((e) => e.type === 'text_delta' && e.parentToolUseId === 'toolu_agent_1');
      const subTool = events.find((e) => e.type === 'tool_use' && e.parentToolUseId === 'toolu_agent_1');
      assert.ok(subThinking && subThinking.type === 'thinking_delta' && subThinking.text === 'checking files');
      assert.ok(subText && subText.type === 'text_delta' && subText.text === 'Found match in foo.ts');
      assert.equal(subText.uuid, 'u_sub_asst');
      assert.ok(subTool && subTool.type === 'tool_use' && subTool.agentId === 'agent_1');
      assert.ok(events.some((e) => e.type === 'task_started' && e.taskId === 'task_1'));
      assert.ok(events.some((e) => e.type === 'task_progress' && e.lastToolName === 'Read'));
      assert.ok(events.some((e) => e.type === 'tool_progress' && e.parentToolUseId === 'toolu_agent_1'));
      assert.ok(events.some((e) => e.type === 'task_notification' && e.status === 'completed'));
    } finally {
      await adapter.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Session & history upgrades (16 MiB tail, openBound, branch, continued-in,
//    custom-title, archive, safe delete, tags, subagents, disk command fallback)
// ---------------------------------------------------------------------------

test('followClaudeBranch prunes abandoned branches via parentUuid and logicalParentUuid', () => {
  const pruned = followClaudeBranch([
    { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'start' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'r1' }] } },
    { type: 'user', uuid: 'u_dead', parentUuid: 'a1', message: { role: 'user', content: 'abandoned' } },
    { type: 'assistant', uuid: 'a_dead', parentUuid: 'u_dead', message: { role: 'assistant', content: [{ type: 'text', text: 'dead' }] } },
    { type: 'system', subtype: 'compact_boundary', uuid: 'cb', parentUuid: null, logicalParentUuid: 'a1' },
    { type: 'user', uuid: 'cs', parentUuid: 'cb', isCompactSummary: true, message: { role: 'user', content: 'summary' } },
    { type: 'user', uuid: 'u2', parentUuid: 'cs', message: { role: 'user', content: 'after compact' } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'r2' }] } },
  ]);
  assert.deepEqual(
    pruned.map((e) => e.uuid),
    ['u1', 'a1', 'cb', 'cs', 'u2', 'a2'],
  );
});

test('getHistory enforces 16 MiB tail-window, handles <pasted_content>/<bash-input>/<bash-stdout>/isCompactSummary', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-16mib-'));
  const projectsDir = join(base, 'projects');
  const projDir = join(projectsDir, 'proj');
  const sessionId = '11111111-1111-4111-8111-222222222222';
  try {
    await mkdir(projDir, { recursive: true });
    const file = join(projDir, `${sessionId}.jsonl`);

    // Build > 16 MiB transcript: old padding entries + recent entries in tail 16 MiB
    const oldPadLine = JSON.stringify({
      type: 'user',
      uuid: 'old_0',
      parentUuid: null,
      message: { role: 'user', content: 'x'.repeat(32 * 1024) },
    }) + '\n';
    const chunks: string[] = [];
    let totalBytes = 0;
    while (totalBytes < 16 * 1024 * 1024 + 512 * 1024) {
      chunks.push(oldPadLine);
      totalBytes += Buffer.byteLength(oldPadLine);
    }

    chunks.push(
      JSON.stringify({
        type: 'user',
        uuid: 'cs_1',
        parentUuid: null,
        isCompactSummary: true,
        message: { role: 'user', content: 'Summary of earlier work' },
      }) + '\n',
      JSON.stringify({
        type: 'user',
        uuid: 'u_paste',
        parentUuid: 'cs_1',
        message: {
          role: 'user',
          content: 'Check:\n<pasted_content id="1a2b">\nconst a = 1;\n</pasted_content id="1a2b">',
        },
      }) + '\n',
      JSON.stringify({
        type: 'user',
        uuid: 'u_bash_in',
        parentUuid: 'u_paste',
        message: { role: 'user', content: '<bash-input>echo hi</bash-input>' },
      }) + '\n',
      JSON.stringify({
        type: 'user',
        uuid: 'u_bash_out',
        parentUuid: 'u_bash_in',
        message: { role: 'user', content: '<bash-stdout>hi\n</bash-stdout><bash-stderr></bash-stderr>' },
      }) + '\n',
      JSON.stringify({
        type: 'assistant',
        uuid: 'a_end',
        parentUuid: 'u_bash_out',
        message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done!' }] },
      }) + '\n',
    );
    await writeFile(file, chunks.join(''));

    const adapter = new ClaudeAdapter({ projectsDir });
    const history = await adapter.getHistory(sessionId);
    assert.deepEqual(
      history.map((m) => ({ role: m.role, text: m.text, isCompactSummary: m.isCompactSummary })),
      [
        { role: 'user', text: 'Summary of earlier work', isCompactSummary: true },
        { role: 'user', text: 'Check:\nconst a = 1;', isCompactSummary: undefined },
        { role: 'user', text: '! echo hi', isCompactSummary: undefined },
        { role: 'user', text: 'hi', isCompactSummary: undefined },
        { role: 'assistant', text: 'Done!', isCompactSummary: undefined },
      ],
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('openBound blocks symlinked transcript files and FIFOs', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-bound-'));
  const projectsDir = join(base, 'projects');
  const projDir = join(projectsDir, 'proj');
  const outside = join(base, 'outside.jsonl');
  const symId = '11111111-1111-4111-8111-333333333333';
  const fifoId = '11111111-1111-4111-8111-444444444444';
  try {
    await mkdir(projDir, { recursive: true });
    await writeFile(
      outside,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'secret' } }) + '\n',
    );
    await symlink(outside, join(projDir, `${symId}.jsonl`));
    try {
      execFileSync('mkfifo', [join(projDir, `${fifoId}.jsonl`)]);
    } catch {
      // mkfifo optional if missing on host
    }

    const adapter = new ClaudeAdapter({ projectsDir });
    const items = await adapter.list();
    assert.deepEqual(items, []);
    await assert.rejects(adapter.getHistory(symId), /session not found/);
    if (existsSync(join(projDir, `${fifoId}.jsonl`))) {
      await assert.rejects(adapter.getHistory(fifoId), /session not found/);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('supports continued-in chain, custom-title reading & rename persistence, and native archive sync', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-meta-'));
  const projectsDir = join(base, 'projects');
  const projDir = join(projectsDir, 'proj');
  const s1 = '11111111-1111-4111-8111-555555555551';
  const s2 = '11111111-1111-4111-8111-555555555552';
  const s3 = '11111111-1111-4111-8111-555555555553';
  try {
    await mkdir(projDir, { recursive: true });

    await writeFile(
      join(projDir, `${s1}.jsonl`),
      [
        JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, cwd: '/tmp/p', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'first' } }),
        JSON.stringify({ type: 'continued-in', sessionId: s1, continuedInSessionId: s2 }),
      ].join('\n') + '\n',
    );
    await writeFile(
      join(projDir, `${s2}.jsonl`),
      [
        JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, cwd: '/tmp/p', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'first' } }),
        JSON.stringify({ type: 'continued-in', sessionId: s2, continuedInSessionId: s3 }),
      ].join('\n') + '\n',
    );
    await writeFile(
      join(projDir, `${s3}.jsonl`),
      [
        JSON.stringify({ type: 'ai-title', aiTitle: 'AI auto title', cwd: '/tmp/p' }),
        JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, cwd: '/tmp/p', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'first' } }),
        JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'final' }] } }),
      ].join('\n') + '\n',
    );

    const adapter = new ClaudeAdapter({ projectsDir });
    assert.equal(await adapter.resolveContinuedSessionId(s1), s3);
    const followedHistory = await adapter.getHistory(s1, { followContinuedIn: true });
    assert.equal(followedHistory[1]?.text, 'final');

    let listed = await adapter.list();
    assert.deepEqual(listed.map((s) => s.sessionId), [s3]);
    assert.equal(listed[0]?.title, 'AI auto title');

    // Rename persists JSONL custom-title and survives a fresh adapter instance
    await adapter.rename(s3, 'My Custom Session Title');
    const adapter2 = new ClaudeAdapter({ projectsDir });
    listed = await adapter2.list();
    assert.equal(listed[0]?.title, 'My Custom Session Title');
    assert.equal(listed[0]?.customTitle, 'My Custom Session Title');

    // Native archive metadata sync + auto-unarchive on newer human prompt
    await adapter2.setArchived(s3, true);
    listed = await adapter2.list();
    assert.equal(listed[0]?.archived, true);

    await adapter2.setArchived(s3, false);
    listed = await adapter2.list();
    assert.equal(listed[0]?.archived, false);

    // Re-archive, then append a newer user message -> must automatically appear unarchived
    await adapter2.setArchived(s3, true);
    const futureTs = new Date(Date.now() + 60_000).toISOString();
    await writeFile(
      join(projDir, `${s3}.jsonl`),
      (await readFile(join(projDir, `${s3}.jsonl`), 'utf8')) +
        JSON.stringify({
          type: 'user',
          uuid: 'u2',
          parentUuid: 'a1',
          timestamp: futureTs,
          message: { role: 'user', content: 'resumed later' },
        }) + '\n',
    );
    await utimes(join(projDir, `${s3}.jsonl`), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    listed = await adapter2.list();
    assert.equal(listed[0]?.archived, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('reads subagents/agent-*.jsonl and safely deletes main jsonl + subagents dir within validated root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-subagents-'));
  const projectsDir = join(base, 'projects');
  const projDir = join(projectsDir, 'proj');
  const sessionId = '11111111-1111-4111-8111-666666666666';
  const symSessionId = '11111111-1111-4111-8111-777777777777';
  const victimDir = join(base, 'victim');
  try {
    await mkdir(join(projDir, sessionId, 'subagents'), { recursive: true });
    await mkdir(victimDir, { recursive: true });
    await writeFile(join(victimDir, 'keep.txt'), 'must not be deleted');

    await writeFile(
      join(projDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'main' } }) + '\n',
    );
    await writeFile(
      join(projDir, sessionId, 'subagents', 'agent-worker1.jsonl'),
      [
        JSON.stringify({ type: 'user', isSidechain: true, uuid: 'su1', parentUuid: null, message: { role: 'user', content: 'sub task' } }),
        JSON.stringify({ type: 'assistant', isSidechain: true, uuid: 'sa_dead', parentUuid: 'su1', message: { role: 'assistant', content: [{ type: 'text', text: 'dead branch' }] } }),
        JSON.stringify({ type: 'assistant', isSidechain: true, uuid: 'sa1', parentUuid: 'su1', message: { role: 'assistant', content: [{ type: 'text', text: 'sub answer' }] } }),
      ].join('\n') + '\n',
    );
    await writeFile(
      join(projDir, sessionId, 'subagents', 'agent-worker1.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_parent_1', agentType: 'Explore' }),
    );

    const adapter = new ClaudeAdapter({ projectsDir });
    assert.deepEqual(await adapter.listSubagents(sessionId), ['worker1']);
    const subMsgs = await adapter.getSubagentMessages(sessionId, 'worker1');
    assert.deepEqual(
      subMsgs.map((m) => ({ role: m.role, text: m.text, agentId: m.agentId, parentToolUseId: m.parentToolUseId })),
      [
        { role: 'user', text: 'sub task', agentId: 'worker1', parentToolUseId: 'toolu_parent_1' },
        { role: 'assistant', text: 'sub answer', agentId: 'worker1', parentToolUseId: 'toolu_parent_1' },
      ],
    );
    await assert.rejects(adapter.getSubagentMessages(sessionId, '../evil'), /invalid subagent id/);

    await adapter.setArchived(sessionId, true);
    await adapter.delete(sessionId);
    assert.equal(existsSync(join(projDir, `${sessionId}.jsonl`)), false);
    assert.equal(existsSync(join(projDir, sessionId, 'subagents')), false);
    assert.equal(existsSync(join(projDir, sessionId)), false);

    // Symlinked subagents dir escaping root must be refused without touching victimDir
    await mkdir(join(projDir, symSessionId), { recursive: true });
    await writeFile(
      join(projDir, `${symSessionId}.jsonl`),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 's' } }) + '\n',
    );
    await symlink(victimDir, join(projDir, symSessionId, 'subagents'));
    await assert.rejects(adapter.delete(symSessionId), /symlinked subagents/);
    assert.equal(await readFile(join(victimDir, 'keep.txt'), 'utf8'), 'must not be deleted');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('listSlashCommands falls back to zero-spawn discoverClaudeDiskCommands when CLI is unavailable', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-disk-cmds-'));
  try {
    const cwd = join(base, 'repo');
    const configDir = join(base, 'config');
    await mkdir(join(cwd, '.claude', 'commands', 'ops'), { recursive: true });
    await mkdir(join(cwd, '.claude', 'skills', 'deploy'), { recursive: true });
    await mkdir(join(configDir, 'commands'), { recursive: true });

    await writeFile(
      join(cwd, '.claude', 'commands', 'ops', 'check.md'),
      '---\ndescription: Run ops check\nargument-hint: "[env]"\naliases: [chk]\n---\nBody\n',
    );
    await writeFile(
      join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md'),
      '---\ndescription: Deploy service\n---\nInstructions\n',
    );
    await writeFile(
      join(configDir, 'commands', 'user-cmd.md'),
      '# User level command\n',
    );

    const adapter = new ClaudeAdapter({
      claudeBin: join(base, 'nonexistent-claude'),
      configDir,
      env: { HOME: base },
    });

    const cmds = await adapter.listSlashCommands(cwd);
    assert.deepEqual(
      cmds.map((c) => ({ name: c.name, description: c.description, source: c.source, scope: c.scope })),
      [
        { name: 'ops:check', description: 'Run ops check', source: 'command', scope: 'project' },
        { name: 'deploy', description: 'Deploy service', source: 'skill', scope: 'project' },
        { name: 'user-cmd', description: 'User level command', source: 'command', scope: 'user' },
      ],
    );
    assert.deepEqual(cmds[0]?.aliases, ['chk']);
    assert.equal(cmds[0]?.argumentHint, '[env]');

    // Explicit opt-out skips disk fallback and surfaces handshake failure
    await assert.rejects(adapter.listSlashCommands(cwd, { diskFallback: false }), /no commands/);
    const diskOnly = await adapter.listSlashCommands(cwd, { diskOnly: true });
    assert.deepEqual(diskOnly.map((c) => c.name), ['ops:check', 'deploy', 'user-cmd']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('options.configDir overrides options.env.CLAUDE_CONFIG_DIR in discovery and child env', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-config-prec-'));
  try {
    const optConfig = join(base, 'opt-config');
    const envConfig = join(base, 'env-config');
    await mkdir(join(optConfig, 'projects', 'p'), { recursive: true });
    await mkdir(join(envConfig, 'projects', 'p'), { recursive: true });

    const optSession = '11111111-1111-4111-8111-900000000001';
    const envSession = '11111111-1111-4111-8111-900000000002';
    await writeFile(
      join(optConfig, 'projects', 'p', `${optSession}.jsonl`),
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'from opt' } }) + '\n',
    );
    await writeFile(
      join(envConfig, 'projects', 'p', `${envSession}.jsonl`),
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'from env' } }) + '\n',
    );

    const envLog = join(base, 'child-env.json');
    const bin = join(base, 'claude');
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(envLog)}, JSON.stringify({
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
}));
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: 'ok',
  is_error: false,
  session_id: ${JSON.stringify(optSession)},
}) + '\\n');
`,
    );
    await chmod(bin, 0o755);

    const adapter = new ClaudeAdapter({
      claudeBin: bin,
      configDir: optConfig,
      env: { CLAUDE_CONFIG_DIR: envConfig, HOME: base },
    });
    const listed = await adapter.list();
    assert.deepEqual(listed.map((s) => s.sessionId), [optSession]);

    await adapter.startTurn({ sessionId: optSession, prompt: 'hi', onEvent: () => {} });
    const captured = JSON.parse(await readFile(envLog, 'utf8'));
    assert.equal(captured.configDir, optConfig);
    await adapter.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('custom-title.json sidecar overrides head custom-title on >256 KiB transcripts while tail wins', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-sidecar-title-'));
  const projectsDir = join(base, 'projects');
  const projDir = join(projectsDir, 'proj');
  const sessionId = '11111111-1111-4111-8111-900000000003';
  try {
    await mkdir(join(projDir, sessionId), { recursive: true });
    const file = join(projDir, `${sessionId}.jsonl`);
    const padLine = JSON.stringify({
      type: 'user',
      uuid: 'u_pad',
      parentUuid: null,
      message: { role: 'user', content: 'x'.repeat(32 * 1024) },
    }) + '\n';
    const lines = [
      JSON.stringify({ type: 'custom-title', customTitle: 'Early Head Title', sessionId }) + '\n',
    ];
    for (let i = 0; i < 12; i += 1) lines.push(padLine);
    lines.push(
      JSON.stringify({ type: 'user', uuid: 'u_end', parentUuid: null, message: { role: 'user', content: 'tail msg' } }) + '\n',
    );
    await writeFile(file, lines.join(''));
    await writeFile(
      join(projDir, sessionId, 'custom-title.json'),
      JSON.stringify({ customTitle: 'Newer Sidecar Title' }),
    );

    const adapter = new ClaudeAdapter({ projectsDir });
    let listed = await adapter.list();
    assert.equal(listed[0]?.title, 'Newer Sidecar Title');
    assert.equal(listed[0]?.customTitle, 'Newer Sidecar Title');

    // Now append a tail custom-title -> tail outranks sidecar
    await writeFile(
      file,
      (await readFile(file, 'utf8')) +
        JSON.stringify({ type: 'custom-title', customTitle: 'Latest Tail Title', sessionId }) + '\n',
    );
    await utimes(file, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    listed = await adapter.list();
    assert.equal(listed[0]?.title, 'Latest Tail Title');
    assert.equal(listed[0]?.customTitle, 'Latest Tail Title');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('getHistory openBound rejects parent-swap TOCTOU outside projectsDir and intra-root leaf symlinks', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-toctou-read-'));
  const projectsDir = join(base, 'projects');
  const projDir = join(projectsDir, 'proj');
  const outsideDir = join(base, 'outside');
  const sessionId = '11111111-1111-4111-8111-900000000004';
  const intraId = '11111111-1111-4111-8111-900000000005';
  try {
    await mkdir(projDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    const realFile = join(projDir, `${sessionId}.jsonl`);
    const otherFile = join(projDir, `${intraId}.jsonl`);
    await writeFile(
      realFile,
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'inside' } }) + '\n',
    );
    await writeFile(
      otherFile,
      JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: null, message: { role: 'user', content: 'other' } }) + '\n',
    );
    await writeFile(
      join(outsideDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'user', uuid: 'u3', parentUuid: null, message: { role: 'user', content: 'escaped!' } }) + '\n',
    );

    const adapter = new ClaudeAdapter({ projectsDir });

    // 1) Swap leaf file to intra-root symlink right before anchored open
    await assert.rejects(
      adapter.getHistory(sessionId, {
        beforeAnchoredOpen: async () => {
          await rm(realFile);
          await symlink(otherFile, realFile);
        },
      }),
      /symlinked/,
    );

    // Restore regular file, then swap parent project dir to external symlink right before anchored open
    await rm(realFile);
    await writeFile(
      realFile,
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'inside' } }) + '\n',
    );
    await assert.rejects(
      adapter.getHistory(sessionId, {
        beforeAnchoredOpen: async () => {
          await rm(projDir, { recursive: true, force: true });
          await symlink(outsideDir, projDir);
        },
      }),
      /符号链接|symlink/i,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('delete() anchored traversal refuses symlink-swapped sessionDir without touching external targets', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-toctou-del-'));
  const projectsDir = join(base, 'projects');
  const projDir = join(projectsDir, 'proj');
  const outsideVictim = join(base, 'outside-victim');
  const sessionId = '11111111-1111-4111-8111-900000000006';
  try {
    await mkdir(join(projDir, sessionId, 'subagents'), { recursive: true });
    await mkdir(join(outsideVictim, 'subagents'), { recursive: true });
    await writeFile(join(outsideVictim, 'subagents', 'secret.txt'), 'do not delete');
    await writeFile(
      join(projDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } }) + '\n',
    );

    const adapter = new ClaudeAdapter({ projectsDir });
    await assert.rejects(
      adapter.delete(sessionId, {
        beforeAnchoredOp: async () => {
          await rm(join(projDir, sessionId), { recursive: true, force: true });
          await symlink(outsideVictim, join(projDir, sessionId));
        },
      }),
      /symlink/,
    );

    assert.equal(await readFile(join(outsideVictim, 'subagents', 'secret.txt'), 'utf8'), 'do not delete');
    assert.equal(existsSync(join(projDir, `${sessionId}.jsonl`)), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('rename() anchored open rejects symlink-swapped, parent-swapped, and FIFO-swapped transcripts without blocking', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-toctou-ren-'));
  const projectsDir = join(base, 'projects');
  const projDir = join(projectsDir, 'proj');
  const outsideDir = join(base, 'outside');
  const sessionId = '11111111-1111-4111-8111-900000000007';
  const sessionId2 = '11111111-1111-4111-8111-900000000008';
  try {
    await mkdir(projDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    const file1 = join(projDir, `${sessionId}.jsonl`);
    const file2 = join(projDir, `${sessionId2}.jsonl`);
    const outsideTarget = join(outsideDir, 'outside.jsonl');
    await writeFile(file1, JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } }) + '\n');
    await writeFile(file2, JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: null, message: { role: 'user', content: 'hi2' } }) + '\n');
    await writeFile(outsideTarget, 'untouched\n');

    const adapter = new ClaudeAdapter({ projectsDir });

    // 1) Swap transcript to symlink -> must refuse and leave outsideTarget untouched
    await assert.rejects(
      adapter.rename(sessionId, 'Hacked', {
        beforeAnchoredOp: async () => {
          await rm(file1);
          await symlink(outsideTarget, file1);
        },
      }),
      /non-regular|symlink/,
    );
    assert.equal(await readFile(outsideTarget, 'utf8'), 'untouched\n');

    // 2) Swap transcript to FIFO -> O_NONBLOCK fails fast instead of blocking event loop
    let fifoSupported = true;
    await assert.rejects(
      adapter.rename(sessionId2, 'FifoTitle', {
        beforeAnchoredOp: async () => {
          await rm(file2);
          try {
            execFileSync('mkfifo', [file2]);
          } catch {
            fifoSupported = false;
            await symlink(outsideTarget, file2);
          }
        },
      }),
      fifoSupported ? /non-regular|ENXIO/ : /non-regular|symlink/,
    );

    // 3) Swap parent projectDir to external symlink -> O_DIRECTORY | O_NOFOLLOW rejects
    await rm(file2, { force: true });
    await writeFile(file2, JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: null, message: { role: 'user', content: 'hi2' } }) + '\n');
    await writeFile(join(outsideDir, `${sessionId2}.jsonl`), 'untouched\n');
    await assert.rejects(
      adapter.rename(sessionId2, 'EscapedParent', {
        beforeAnchoredOp: async () => {
          await rm(projDir, { recursive: true, force: true });
          await symlink(outsideDir, projDir);
        },
      }),
      /symlink/,
    );
    assert.equal(await readFile(join(outsideDir, `${sessionId2}.jsonl`), 'utf8'), 'untouched\n');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Live unauthenticated @anthropic-ai/claude-code@2.1.325 handshake test
// ---------------------------------------------------------------------------

const LIVE_21325_BIN = process.env.CLAUDE_LIVE_BIN
  ?? (existsSync('/tmp/claude-survey.nCx4IC/native/package/claude')
    ? '/tmp/claude-survey.nCx4IC/native/package/claude'
    : resolveClaudeBin());

test(
  'live unauthenticated 2.1.325 initialize handshake exposes dynamic models, commands, and mcpStatus',
  {
    skip: process.env.GATEWAY_LIVE_CLI_TESTS !== '1' || !existsSync(LIVE_21325_BIN),
    timeout: 30_000,
  },
  async () => {
    const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-live-21325-'));
    try {
      const configDir = join(base, 'config');
      await mkdir(configDir, { recursive: true });

      const adapter = new ClaudeAdapter({
        claudeBin: LIVE_21325_BIN,
        configDir,
        env: {
          HOME: base,
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_BASE_URL: '',
          CLAUDE_CODE_USE_BEDROCK: '',
          CLAUDE_CODE_USE_VERTEX: '',
          CLAUDE_CODE_USE_FOUNDRY: '',
        },
      });

      const models = await adapter.listBuiltinModels();
      assert.ok(models.length >= 4, `expected at least 4 models, got ${models.length}`);
      const first = models[0]!;
      assert.equal(typeof first.value, 'string');
      assert.equal(typeof first.supportsAdaptiveThinking, 'boolean');
      assert.equal(typeof first.supportsThinkingOff, 'boolean');
      assert.ok(models.some((m) => typeof m.fastMode === 'boolean'));

      const commands = await adapter.listSlashCommands(base);
      assert.ok(commands.length >= 5, `expected built-in commands, got ${commands.length}`);
      assert.ok(commands.some((c) => c.name === 'compact'));

      const mcpServers = await adapter.mcpStatus(undefined, base);
      assert.ok(Array.isArray(mcpServers));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
);

test('preserves local-command-stdout, formats command-name chips, drops caveats, and captures conversation_reset + terminal_slash_commands', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-local-cmd-'));
  const projectsDir = join(base, 'projects');
  const projectDir = join(projectsDir, 'proj');
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const bin = join(base, 'claude');
  try {
    await mkdir(projectDir, { recursive: true });
    const jsonl = [
      JSON.stringify({
        type: 'user',
        uuid: 'u-cav',
        parentUuid: null,
        isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>Disclaimer</local-command-caveat>' },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u-cmd',
        parentUuid: 'u-cav',
        message: {
          role: 'user',
          content: '<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>',
        },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'local_command',
        uuid: 's-out',
        parentUuid: 'u-cmd',
        content: '<local-command-stdout>## Context Usage\n12k / 1m</local-command-stdout>',
        timestamp: '2026-11-15T00:00:01.000Z',
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u-leg',
        parentUuid: 's-out',
        message: { role: 'user', content: '<local-command-stdout>Session renamed to: web-ui</local-command-stdout>' },
      }),
    ].join('\n') + '\n';
    await writeFile(join(projectDir, `${sessionId}.jsonl`), jsonl);

    await writeFile(bin, `#!/usr/bin/env node
process.stdin.on('data', () => {
  process.stdout.write(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: '${sessionId}',
    cwd: ${JSON.stringify(base)},
    tools: ['Bash'],
    terminal_slash_commands: ['doctor', 'color', 'focus', 'reload-plugins'],
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'conversation_reset',
    session_id: '${sessionId}',
    new_conversation_id: '33333333-3333-4333-8333-333333333333',
    trigger: 'clear',
    uuid: 'rst-1',
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: '33333333-3333-4333-8333-333333333333',
    is_error: false,
    result: '',
  }) + '\\n');
});
process.stdin.resume();
`);
    await chmod(bin, 0o755);

    const adapter = new ClaudeAdapter({ claudeBin: bin, projectsDir });
    const history = await adapter.getHistory(sessionId);
    assert.deepEqual(
      history.map((m) => ({ role: m.role, text: m.text })),
      [
        { role: 'user', text: '/context' },
        { role: 'assistant', text: '## Context Usage\n12k / 1m' },
        { role: 'assistant', text: 'Session renamed to: web-ui' },
      ],
    );

    const events: ClaudeAdapterEvent[] = [];
    await adapter.startTurn({
      sessionId,
      cwd: base,
      prompt: '/clear',
      onEvent: (ev) => events.push(ev),
    });
    const initEv = events.find((e): e is Extract<ClaudeAdapterEvent, { type: 'init' }> => e.type === 'init');
    assert.deepEqual(initEv?.terminalSlashCommands, ['doctor', 'color', 'focus', 'reload-plugins']);
    const resetEv = events.find((e): e is Extract<ClaudeAdapterEvent, { type: 'conversation_reset' }> => e.type === 'conversation_reset');
    assert.equal(resetEv?.newConversationId, '33333333-3333-4333-8333-333333333333');
    assert.equal(resetEv?.trigger, 'clear');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('ClaudeAdapter.listSessions includes sessions regardless of entrypoint and filters out pure slash commands', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-entrypoint-'));
  const projectsDir = join(base, 'projects');
  const projDir = join(projectsDir, 'my-proj');
  try {
    await mkdir(projDir, { recursive: true });

    const normalSessionId = '11111111-1111-4111-8111-111111111111';
    const sdkSessionId = '22222222-2222-4222-8222-222222222222';
    const slashSessionId = '33333333-3333-4333-8333-333333333333';

    await writeFile(
      join(projDir, `${normalSessionId}.jsonl`),
      [
        JSON.stringify({ type: 'user', timestamp: '2026-08-11T10:00:00.000Z', entrypoint: 'cli', message: { role: 'user', content: 'Normal CLI turn' } }),
      ].join('\n') + '\n',
    );

    await writeFile(
      join(projDir, `${sdkSessionId}.jsonl`),
      [
        JSON.stringify({ type: 'user', timestamp: '2026-08-11T10:01:00.000Z', entrypoint: 'sdk-cli', message: { role: 'user', content: 'SDK programmatic turn' } }),
      ].join('\n') + '\n',
    );

    await writeFile(
      join(projDir, `${slashSessionId}.jsonl`),
      [
        JSON.stringify({ type: 'user', timestamp: '2026-08-11T10:02:00.000Z', entrypoint: 'sdk-cli', message: { role: 'user', content: '<command-name>/help</command-name>' } }),
        JSON.stringify({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>help output</local-command-stdout>', timestamp: '2026-08-11T10:02:01.000Z', entrypoint: 'sdk-cli' }),
      ].join('\n') + '\n',
    );

    const adapter = new ClaudeAdapter({ projectsDir });
    const sessions = await adapter.listSessions();
    assert.equal(sessions.some((s) => s.sessionId === normalSessionId), true);
    assert.equal(sessions.some((s) => s.sessionId === sdkSessionId), true);
    assert.equal(sessions.some((s) => s.sessionId === slashSessionId), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('ClaudeAdapter.listSubagentDetails reads sidecar metadata fields', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-sub-details-'));
  const projectsDir = join(base, 'projects');
  const projDir = join(projectsDir, 'proj');
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  try {
    await mkdir(join(projDir, sessionId, 'subagents'), { recursive: true });
    await writeFile(
      join(projDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'main' } }) + '\n',
    );
    await writeFile(
      join(projDir, sessionId, 'subagents', 'agent-worker1.jsonl'),
      JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'sub' } }) + '\n',
    );
    await writeFile(
      join(projDir, sessionId, 'subagents', 'agent-worker1.meta.json'),
      JSON.stringify({
        toolUseId: 'toolu_parent_123',
        agentType: 'CodeReviewer',
        taskId: 'task_abc',
        description: 'Reviewing changes',
      }),
    );

    const adapter = new ClaudeAdapter({ projectsDir });
    const details = await adapter.listSubagentDetails(sessionId);
    assert.equal(details.length, 1);
    assert.equal(details[0]?.agentId, 'worker1');
    assert.equal(details[0]?.parentToolUseId, 'toolu_parent_123');
    assert.equal(details[0]?.subagentType, 'CodeReviewer');
    assert.equal(details[0]?.taskId, 'task_abc');
    assert.equal(details[0]?.description, 'Reviewing changes');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('LruCache enforces maxEntries cap, LRU eviction, and close() clears caches', async () => {
  const cache = new LruCache<string, number>(3);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.size, 3);

  // Access 'a' to make it most recently used
  assert.equal(cache.get('a'), 1);

  // Inserting 'd' should evict 'b' (least recently used)
  cache.set('d', 4);
  assert.equal(cache.size, 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.get('d'), 4);

  // Test close() clearing historyCache and summarizeCache
  const adapter = new ClaudeAdapter();
  (adapter as any).historyCache.set('sess1:main', { key: '1:100', messages: [] });
  (adapter as any).summarizeCache.set('/path/to/sess1.jsonl', { mtimeMs: 1, size: 100, summary: { sessionId: 'sess1' } });
  assert.equal((adapter as any).historyCache.size, 1);
  assert.equal((adapter as any).summarizeCache.size, 1);

  await adapter.close();
  assert.equal((adapter as any).historyCache.size, 0);
  assert.equal((adapter as any).summarizeCache.size, 0);
});

test('startTurn rejects if adapter is closed', async () => {
  const adapter = new ClaudeAdapter();
  await adapter.close();
  await assert.rejects(
    adapter.startTurn({
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      prompt: 'hello',
      onEvent: () => {},
    }),
    /claude-adapter: adapter closed/,
  );
});

test('listSlashCommands preserves terminalOnly, allowedTools, and model from catalog', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-commands-'));
  try {
    const bin = join(base, 'claude-mock');
    await writeFile(
      bin,
      `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: {
        request_id: msg.request_id,
        subtype: 'success',
        response: {
          commands: [
            {
              name: 'deploy',
              description: 'Deploy project',
              argumentHint: '<target>',
              aliases: ['dp'],
              terminalOnly: true,
              allowedTools: ['Bash', 'Read'],
              model: 'claude-3-opus',
            },
            {
              name: 'help',
              description: 'Get help',
            },
          ],
        },
      },
    }) + '\\n');
  }
});
rl.on('close', () => process.exit(0));
`,
    );
    await chmod(bin, 0o755);

    const adapter = new ClaudeAdapter({ claudeBin: bin });
    try {
      const commands = await adapter.listSlashCommands();
      const deploy = commands.find((c) => c.name === 'deploy');
      assert.ok(deploy);
      assert.equal(deploy.terminalOnly, true);
      assert.deepEqual(deploy.allowedTools, ['Bash', 'Read']);
      assert.equal(deploy.model, 'claude-3-opus');

      const help = commands.find((c) => c.name === 'help');
      assert.ok(help);
      assert.equal(help.terminalOnly, undefined);
      assert.equal(help.allowedTools, undefined);
      assert.equal(help.model, undefined);
    } finally {
      await adapter.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('listBuiltinModels sets fastMode: false when fast_mode_state is off or sdk_opt_in_required', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-fastmode-'));
  try {
    const bin = join(base, 'claude-mock');
    await writeFile(
      bin,
      `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: {
        request_id: msg.request_id,
        subtype: 'success',
        response: {
          fast_mode_state: 'off',
          fast_mode_disabled_reason: 'sdk_opt_in_required',
          models: [
            {
              value: 'claude-sonnet-4',
              supportsFastMode: true,
              fastMode: true,
            },
          ],
        },
      },
    }) + '\\n');
  }
});
rl.on('close', () => process.exit(0));
`,
    );
    await chmod(bin, 0o755);

    const adapter = new ClaudeAdapter({ claudeBin: bin });
    try {
      const models = await adapter.listBuiltinModels();
      assert.equal(models.length, 1);
      assert.equal(models[0]?.fastMode, false);
      assert.equal(models[0]?.supportsFastMode, true);
      assert.equal(models[0]?.fastModeState, 'off');
      assert.equal(models[0]?.fastModeDisabledReason, 'sdk_opt_in_required');
    } finally {
      await adapter.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('startTurn omits --effort when effort is auto or on, but passes explicit levels', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-effort-'));
  const log = join(base, 'args.log');
  try {
    const bin = join(base, 'claude-mock');
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'user') {
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      session_id: '123e4567-e89b-12d3-a456-426614174000',
    }) + '\\n');
  }
});
rl.on('close', () => process.exit(0));
`,
    );
    await chmod(bin, 0o755);

    const adapter = new ClaudeAdapter({ claudeBin: bin });
    try {
      // 1. effort = 'auto'
      await adapter.startTurn({
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        prompt: 'test auto',
        effort: 'auto',
        onEvent: () => {},
      });

      // 2. effort = 'on'
      await adapter.startTurn({
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        prompt: 'test on',
        effort: 'on',
        onEvent: () => {},
      });

      // 3. effort = 'high'
      await adapter.startTurn({
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        prompt: 'test high',
        effort: 'high',
        onEvent: () => {},
      });

      const lines = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(lines.length, 3);

      const autoArgs: string[] = lines[0];
      assert.ok(!autoArgs.includes('--effort'), `expected no --effort, got: ${autoArgs.join(' ')}`);

      const onArgs: string[] = lines[1];
      assert.ok(!onArgs.includes('--effort'), `expected no --effort, got: ${onArgs.join(' ')}`);

      const highArgs: string[] = lines[2];
      const effortIdx = highArgs.indexOf('--effort');
      assert.ok(effortIdx >= 0, `expected --effort in: ${highArgs.join(' ')}`);
      assert.equal(highArgs[effortIdx + 1], 'high');
    } finally {
      await adapter.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('clearHandshakeCache clears cached handshake response and inflight map', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-handshake-'));
  try {
    const countFile = join(base, 'count.txt');
    await writeFile(countFile, '0');

    const bin = join(base, 'claude-mock');
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const countFile = ${JSON.stringify(countFile)};
const cur = parseInt(fs.readFileSync(countFile, 'utf8') || '0', 10);
fs.writeFileSync(countFile, String(cur + 1));

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: {
        request_id: msg.request_id,
        subtype: 'success',
        response: {
          commands: [{ name: 'cmd1', description: 'test', argumentHint: '', aliases: [] }],
          models: [{ value: 'model1' }],
        },
      },
    }) + '\\n');
  }
});
rl.on('close', () => process.exit(0));
`,
    );
    await chmod(bin, 0o755);

    const adapter = new ClaudeAdapter({ claudeBin: bin });
    try {
      const cmds1 = await adapter.listSlashCommands(base);
      assert.equal(cmds1.length, 1);
      assert.equal(await readFile(countFile, 'utf8'), '1');

      // Second call should hit handshakeCache without spawning another process
      const cmds2 = await adapter.listSlashCommands(base);
      assert.equal(cmds2.length, 1);
      assert.equal(await readFile(countFile, 'utf8'), '1');

      // Clear cache and call again; should spawn a second process
      adapter.clearHandshakeCache();
      assert.equal((adapter as any).handshakeCache.size, 0);
      assert.equal((adapter as any).handshakeInflight.size, 0);

      const cmds3 = await adapter.listSlashCommands(base);
      assert.equal(cmds3.length, 1);
      assert.equal(await readFile(countFile, 'utf8'), '2');
    } finally {
      await adapter.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('clearHandshakeCache prevents stale in-flight handshake from polluting cache and close during waitForExit aborts startTurn', async () => {
  const adapter = new ClaudeAdapter({ claudeBin: '/nonexistent/claude' });
  let releaseProbe!: (value: Record<string, unknown> | null) => void;
  let spawnCalls = 0;
  (adapter as any).spawnHandshake = () => {
    spawnCalls += 1;
    if (spawnCalls === 1) {
      return new Promise<Record<string, unknown> | null>((resolve) => {
        releaseProbe = resolve;
      });
    }
    return Promise.resolve({ commands: [{ name: 'fresh', description: 'fresh' }], models: [{ value: 'sonnet' }] });
  };

  const p1 = adapter.listSlashCommands('/tmp/p1');
  adapter.clearHandshakeCache();
  const p2 = adapter.listSlashCommands('/tmp/p1');
  releaseProbe({ commands: [{ name: 'stale', description: 'stale' }], models: [{ value: 'haiku' }] });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1[0]?.name, 'stale');
  assert.equal(r2[0]?.name, 'fresh');
  // Cache must retain the fresh result, not the stale one that settled afterward
  const r3 = await adapter.listSlashCommands('/tmp/p1');
  assert.equal(r3[0]?.name, 'fresh');
  assert.equal(spawnCalls, 2);

  // If close() happens while waitForExit is waiting, startTurn must abort instead of spawning
  (adapter as any).running.set('sess-wait', { exitCode: null, signalCode: null, kill: () => true });
  (adapter as any).waitForExit = async () => {
    (adapter as any).closed = true;
    (adapter as any).running.delete('sess-wait');
  };
  await assert.rejects(
    adapter.startTurn({ sessionId: 'sess-wait', prompt: 'hi', onEvent: () => undefined }),
    /adapter closed/,
  );
  await adapter.close();
});

test('review regression: listSessions includes sessions with sdk-cli entries and filters out pure slash commands without replies', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-regression-'));
  const projectsDir = join(base, 'projects');
  const projDir = join(projectsDir, 'my-proj');
  try {
    await mkdir(projDir, { recursive: true });

    const sdkSessionId = '11111111-1111-4111-8111-111111111111';
    const pureSlashSessionId = '22222222-2222-4222-8222-222222222222';
    const slashWithReplySessionId = '33333333-3333-4333-8333-333333333333';

    // 1. Session with sdk-cli turn and real question (and assistant reply) - must be included
    await writeFile(
      join(projDir, `${sdkSessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-11-16T10:00:00.000Z',
          entrypoint: 'cli',
          cwd: '/work',
          sessionId: sdkSessionId,
          message: { role: 'user', content: '你是什么模型' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-16T10:00:02.000Z',
          entrypoint: 'cli',
          cwd: '/work',
          sessionId: sdkSessionId,
          message: { role: 'assistant', content: [{ type: 'text', text: '我是 Claude' }] },
        }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-11-16T10:01:00.000Z',
          entrypoint: 'sdk-cli',
          cwd: '/work',
          sessionId: sdkSessionId,
          message: { role: 'user', content: [{ type: 'text', text: '你能做什么？' }] },
        }),
      ].join('\n') + '\n',
    );

    // 2. Pure slash command session without assistant reply - must be filtered out
    await writeFile(
      join(projDir, `${pureSlashSessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-11-15T06:46:15.253Z',
          entrypoint: 'sdk-cli',
          cwd: '/work/project',
          sessionId: pureSlashSessionId,
          isMeta: true,
          message: {
            role: 'user',
            content: '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It\'s recorded here as context for later messages.</local-command-caveat>',
          },
        }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-11-15T06:46:15.246Z',
          entrypoint: 'sdk-cli',
          cwd: '/work/project',
          sessionId: pureSlashSessionId,
          message: {
            role: 'user',
            content: '<command-name>/reload-skills</command-name>\n            <command-message>reload-skills</command-message>\n            <command-args></command-args>',
          },
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'local_command',
          content: '<local-command-stdout>Reloaded skills: 13 skills available (none added or removed).</local-command-stdout>',
          timestamp: '2026-11-15T06:46:15.253Z',
          entrypoint: 'sdk-cli',
          cwd: '/work/project',
          sessionId: pureSlashSessionId,
        }),
      ].join('\n') + '\n',
    );

    // 3. Slash command that has an assistant reply - must be included
    await writeFile(
      join(projDir, `${slashWithReplySessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-11-15T06:47:00.000Z',
          entrypoint: 'sdk-cli',
          cwd: '/work',
          sessionId: slashWithReplySessionId,
          message: {
            role: 'user',
            content: '<command-name>/help</command-name>\n            <command-message>help</command-message>\n            <command-args></command-args>',
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-15T06:47:05.000Z',
          entrypoint: 'sdk-cli',
          cwd: '/work',
          sessionId: slashWithReplySessionId,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Here are the available commands...' }],
          },
        }),
      ].join('\n') + '\n',
    );

    // 4. Large session (> 512 KiB) spanning beyond head and tail 256 KiB windows
    const largeSessionId = '44444444-4444-4444-8444-444444444444';
    const paddingLine = JSON.stringify({ type: 'progress', data: 'x'.repeat(1024) });
    const padding = Array.from({ length: 600 }, () => paddingLine).join('\n');
    await writeFile(
      join(projDir, `${largeSessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-11-15T08:00:00.000Z',
          entrypoint: 'sdk-cli',
          cwd: '/work',
          sessionId: largeSessionId,
          message: { role: 'user', content: 'Large transcript start' },
        }),
        padding,
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-15T08:10:00.000Z',
          entrypoint: 'sdk-cli',
          cwd: '/work',
          sessionId: largeSessionId,
          message: { role: 'assistant', content: [{ type: 'text', text: 'Large transcript end' }] },
        }),
      ].join('\n') + '\n',
    );

    const adapter = new ClaudeAdapter({ projectsDir });
    const sessions = await adapter.listSessions();

    const sdkFound = sessions.find((s) => s.sessionId === sdkSessionId);
    assert.ok(sdkFound, 'session with sdk-cli turns must be listed');
    assert.equal(sdkFound.title, '你能做什么？');
    assert.equal(sdkFound.firstPrompt, '你是什么模型');

    const pureSlashFound = sessions.find((s) => s.sessionId === pureSlashSessionId);
    assert.equal(pureSlashFound, undefined, 'pure slash command session without assistant reply must be filtered out');

    const slashWithReplyFound = sessions.find((s) => s.sessionId === slashWithReplySessionId);
    assert.ok(slashWithReplyFound, 'slash command with assistant reply must be listed');

    const largeFound = sessions.find((s) => s.sessionId === largeSessionId);
    assert.ok(largeFound, 'large session > 512 KiB must be listed');
    assert.equal(largeFound.firstPrompt, 'Large transcript start');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: spawnControlProbe passes --no-session-persistence while conversation turns and forkSession omit it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-probe-persistence-'));
  const log = join(base, 'args.log');
  try {
    const bin = join(base, 'claude-mock');
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: {
        request_id: msg.request_id,
        subtype: 'success',
        response: {
          commands: [{ name: 'help', description: 'Show help', argumentHint: '', aliases: [] }],
          models: [{ value: 'claude-3-5-sonnet' }],
        },
      },
    }) + '\\n');
  } else if (msg.type === 'control_request' && msg.request?.subtype === 'mcp_status') {
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: {
        request_id: msg.request_id,
        subtype: 'success',
        response: [],
      },
    }) + '\\n');
  } else if (msg.type === 'user') {
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      session_id: '123e4567-e89b-12d3-a456-426614174000',
    }) + '\\n');
  }
});
if (process.argv.includes('--fork-session')) {
  process.stdout.write(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'forked-session-id-4567',
  }) + '\\n');
}
rl.on('close', () => process.exit(0));
`,
    );
    await chmod(bin, 0o755);

    const adapter = new ClaudeAdapter({ claudeBin: bin });
    try {
      // 1. Probe: listSlashCommands invokes spawnHandshake -> spawnControlProbe
      const commands = await adapter.listSlashCommands(base);
      assert.equal(commands.length, 1);

      // 2. Real conversation turn: startTurn
      await adapter.startTurn({
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        prompt: 'hello',
        onEvent: () => {},
      });

      // 3. Session fork: forkSession
      const forked = await adapter.forkSession('123e4567-e89b-12d3-a456-426614174000', base);
      assert.equal(forked.sessionId, 'forked-session-id-4567');

      const lines = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(lines.length, 3);

      const probeArgs: string[] = lines[0];
      assert.ok(
        probeArgs.includes('--no-session-persistence'),
        `expected probe args to include --no-session-persistence, got: ${probeArgs.join(' ')}`,
      );
      assert.ok(probeArgs.includes('-p'), 'probe args must include -p');

      const turnArgs: string[] = lines[1];
      assert.equal(
        turnArgs.includes('--no-session-persistence'),
        false,
        `conversation turn must NOT include --no-session-persistence, got: ${turnArgs.join(' ')}`,
      );

      const forkArgs: string[] = lines[2];
      assert.equal(
        forkArgs.includes('--no-session-persistence'),
        false,
        `forkSession must NOT include --no-session-persistence, got: ${forkArgs.join(' ')}`,
      );
    } finally {
      await adapter.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});



