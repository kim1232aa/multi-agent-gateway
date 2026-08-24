import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GrokAdapter, GrokProviderAdapter, grokContextWindow } from './grok-adapter.js';
import { ProviderError } from './types.js';

async function writeFakeGrok(dir: string): Promise<{ bin: string; argvLog: string; stdinLog: string }> {
  const bin = join(dir, 'grok');
  const argvLog = join(dir, 'argv.log');
  const stdinLog = join(dir, 'stdin.log');
  const script = `#!/usr/bin/env python3
import json, os, select, sys

args = sys.argv[1:]
argv_log = os.environ.get("GROK_ARGV_LOG")
stdin_log = os.environ.get("GROK_STDIN_LOG")
spawn_log = os.environ.get("GROK_SPAWN_LOG")
if spawn_log:
    with open(spawn_log, "a", encoding="utf-8") as f:
        f.write("x")
if argv_log:
    with open(argv_log, "w", encoding="utf-8") as f:
        json.dump(args, f)

stdin = ""
if not sys.stdin.isatty():
    ready, _, _ = select.select([sys.stdin], [], [], 0.15)
    if ready:
        stdin = sys.stdin.read()
if stdin_log:
    with open(stdin_log, "w", encoding="utf-8") as f:
        f.write(stdin)

if args[:1] == ["models"]:
    sys.stdout.write(
        "Model 'grok' is using its own API key.\\n"
        "\\n"
        "Default model: grok-4.6\\n"
        "\\n"
        "Available models:\\n"
        "  * grok-4.6 (default)\\n"
        "  - grok-4.5\\n"
        "  - grok\\n"
    )
    sys.exit(0)

sys.stdout.write(
    '{"type":"system","subtype":"init","session_id":"s","cwd":"/tmp","tools":[]}\\n'
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}\\n'
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"pwd"}}]}}\\n'
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"/tmp"}]}}\\n'
    '{"type":"result","subtype":"success","result":"ok","is_error":false,"session_id":"s"}\\n'
)
sys.exit(0)
`;
  await writeFile(bin, script);
  await chmod(bin, 0o755);
  return { bin, argvLog, stdinLog };
}

async function drain(handle: { events: AsyncIterable<unknown> }): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

test('listModels max_context_size is 500000 not 0/200000', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-models-'));
  try {
    const { bin } = await writeFakeGrok(base);
    const adapter = new GrokProviderAdapter({ grokBin: bin });
    const models = await adapter.listModels();
    assert.deepEqual(models.map((m) => m.model), ['grok-4.6', 'grok-4.5', 'grok']);
    assert.equal(models[0]?.provider, 'grok');
    assert.ok(models.every((m) => m.max_context_size === 500_000));
    assert.ok(models.every((m) => m.max_context_size !== 0));
    assert.ok(models.every((m) => m.max_context_size !== 200_000));
    assert.equal(grokContextWindow('grok-4.6'), 500_000);
    assert.equal(grokContextWindow('grok-4.5'), 500_000);
    assert.equal(grokContextWindow('grok'), 500_000);
    assert.equal(grokContextWindow('unknown-family-model'), 500_000);
    assert.equal(grokContextWindow(), 500_000);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('caches grok models instead of spawning per call', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-models-cache-'));
  try {
    const { bin } = await writeFakeGrok(base);
    const spawnLog = join(base, 'spawn.log');
    const adapter = new GrokProviderAdapter({ grokBin: bin, env: { GROK_SPAWN_LOG: spawnLog } });
    await adapter.listModels();
    await adapter.listModels();
    assert.equal(await readFile(spawnLog, 'utf8'), 'x');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('startTurn passes the prompt via -p or --prompt-json and does not treat stdin as the prompt', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-start-'));
  try {
    const { bin, argvLog, stdinLog } = await writeFakeGrok(base);
    const adapter = new GrokAdapter({
      grokBin: bin,
      env: { GROK_ARGV_LOG: argvLog, GROK_STDIN_LOG: stdinLog },
    });
    const { sessionId } = await adapter.create(base);
    assert.equal(await readFile(argvLog, 'utf8').catch(() => 'missing'), 'missing');

    const prompt = 'hello-from-test-prompt';
    const events: string[] = [];
    await adapter.startTurn({
      sessionId,
      prompt,
      cwd: base,
      isNew: true,
      onEvent: (ev) => { events.push(ev.type); },
    });

    const argv = JSON.parse(await readFile(argvLog, 'utf8')) as string[];
    const viaP = argv.includes('-p') && argv.includes(prompt);
    const jsonIdx = argv.indexOf('--prompt-json');
    const viaJson = jsonIdx >= 0 && String(argv[jsonIdx + 1] ?? '').includes(prompt);
    const fileIdx = argv.indexOf('--prompt-file');
    const viaFile = fileIdx >= 0;
    assert.ok(viaP || viaJson || viaFile, `prompt missing from argv: ${JSON.stringify(argv)}`);
    assert.ok(argv.includes('--output-format'));
    assert.ok(argv.includes('streaming-messages-json'));
    assert.ok(argv.includes('--include-partial-messages'));
    assert.ok(argv.includes('--session-id'));
    assert.ok(argv.includes(sessionId));
    assert.ok(!argv.includes('--input-format'));
    assert.ok(!argv.includes('stream-json') || argv.includes('streaming-messages-json'));

    const stdin = await readFile(stdinLog, 'utf8').catch(() => '');
    assert.ok(!stdin.includes(prompt), `stdin must not carry the prompt, got ${JSON.stringify(stdin)}`);
    assert.ok(!/"type"\s*:\s*"user"/.test(stdin), 'stdin must not be a stream-json user line');
    assert.ok(events.includes('done'), events.join(','));

    await adapter.startTurn({
      sessionId,
      prompt: 'ignored-when-blocks',
      cwd: base,
      isNew: false,
      contentBlocks: [{ type: 'text', text: 'block-prompt' }],
      onEvent: () => undefined,
    });
    const argv2 = JSON.parse(await readFile(argvLog, 'utf8')) as string[];
    assert.ok(argv2.includes('--resume'));
    assert.ok(argv2.includes('--prompt-json'));
    assert.ok(String(argv2[argv2.indexOf('--prompt-json') + 1]).includes('block-prompt'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('list reads summary.json from a temp sessionsDir', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-list-'));
  const sessionsDir = join(base, 'sessions');
  const sessionId = '123e4567-e89b-12d3-a456-426614174000';
  try {
    const encoded = encodeURIComponent('/tmp/work');
    await mkdir(join(sessionsDir, encoded, sessionId), { recursive: true });
    await writeFile(join(sessionsDir, encoded, sessionId, 'summary.json'), JSON.stringify({
      info: { id: sessionId, cwd: '/tmp/work' },
      session_summary: 'Fix the grok adapter',
      generated_title: 'Older title',
      updated_at: '2026-08-11T10:00:00.000Z',
      last_active_at: '2026-08-11T09:00:00.000Z',
      current_model_id: 'grok-4.6',
    }));
    await writeFile(join(sessionsDir, 'session_search.sqlite'), 'not a session');

    const adapter = new GrokProviderAdapter({ sessionsDir, grokBin: join(base, 'missing-grok') });
    const page = await adapter.list();
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.id, sessionId);
    assert.equal(page.items[0]?.title, 'Fix the grok adapter');
    assert.equal(page.items[0]?.metadata.cwd, '/tmp/work');
    assert.equal(page.items[0]?.updated_at, '2026-08-11T10:00:00.000Z');
    assert.equal(page.items[0]?.created_at, '2026-08-11T10:00:00.000Z');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('list returns summary created_at distinct from updated_at', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-list-created-'));
  const sessionsDir = join(base, 'sessions');
  const sessionId = '223e4567-e89b-12d3-a456-426614174000';
  try {
    const encoded = encodeURIComponent('/tmp/work');
    await mkdir(join(sessionsDir, encoded, sessionId), { recursive: true });
    await writeFile(join(sessionsDir, encoded, sessionId, 'summary.json'), JSON.stringify({
      info: { id: sessionId, cwd: '/tmp/work' },
      session_summary: 'Created at is not updated at',
      created_at: '2026-08-16T06:20:33Z',
      updated_at: '2026-08-16T16:32:39Z',
      last_active_at: '2026-08-16T16:32:00Z',
    }));

    const adapter = new GrokProviderAdapter({ sessionsDir, grokBin: join(base, 'missing-grok') });
    const page = await adapter.list();
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.created_at, '2026-08-16T06:20:33Z');
    assert.equal(page.items[0]?.updated_at, '2026-08-16T16:32:39Z');
    assert.notEqual(page.items[0]?.created_at, page.items[0]?.updated_at);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('history maps reasoning and tool blocks onto Kimi message parts', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-history-'));
  const sessionsDir = join(base, 'sessions');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  try {
    const encoded = encodeURIComponent('/tmp/project');
    const dir = join(sessionsDir, encoded, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'chat_history.jsonl'), [
      JSON.stringify({ type: 'system', content: 'You are Grok' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'run tool' }] }),
      JSON.stringify({
        type: 'reasoning',
        id: 'r1',
        summary: [{ type: 'summary_text', text: 'plan the call' }],
      }),
      JSON.stringify({
        type: 'assistant',
        content: 'calling bash',
        tool_calls: [{ id: 'call_1', name: 'Bash', arguments: '{"command":"pwd"}' }],
        model_id: 'grok-4.6',
      }),
      JSON.stringify({ type: 'tool_result', tool_call_id: 'call_1', content: '/tmp/project' }),
      JSON.stringify({
        type: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'also from user' }],
      }),
      JSON.stringify({
        type: 'user',
        synthetic_reason: 'system_reminder',
        content: [{ type: 'text', text: '<system-reminder>\nMCP servers connected\n</system-reminder>' }],
      }),
      JSON.stringify({
        type: 'user',
        content: [{ type: 'text', text: '<user_info>\nOS: linux\n</user_info>\n<user_query>\nreal question\n</user_query>' }],
      }),
    ].join('\n') + '\n');

    const history = await new GrokProviderAdapter({ sessionsDir }).getHistory(sessionId);
    assert.equal(history.some((m) => m.content.some((p) => p.type === 'text' && 'text' in p && p.text === 'You are Grok')), false);

    const user = history.find((m) => m.role === 'user');
    assert.ok(user);
    assert.deepEqual(user.content, [{ type: 'text', text: 'run tool' }]);

    const thinking = history.find((m) => m.content.some((p) => p.type === 'thinking'));
    assert.ok(thinking);
    assert.equal(thinking.role, 'assistant');
    assert.deepEqual(thinking.content, [{ type: 'thinking', thinking: 'plan the call' }]);

    const assistant = history.find((m) => m.content.some((p) => p.type === 'tool_use'));
    assert.ok(assistant);
    assert.equal(assistant.role, 'assistant');
    assert.deepEqual(assistant.content, [
      { type: 'text', text: 'calling bash' },
      { type: 'tool_use', tool_call_id: 'call_1', tool_name: 'Bash', input: { command: 'pwd' } },
    ]);

    const tool = history.find((m) => m.role === 'tool' && m.content.some((p) => p.type === 'tool_result' && 'output' in p && p.output === '/tmp/project'));
    assert.ok(tool);
    assert.deepEqual(tool.content, [
      { type: 'tool_result', tool_call_id: 'call_1', output: '/tmp/project', is_error: false },
    ]);

    const userTool = history.find((m) => m.role === 'tool' && m.content.some((p) => p.type === 'tool_result' && 'output' in p && p.output === 'also from user'));
    assert.ok(userTool);
    assert.equal(history.some((m) => m.content.some((p) => p.type === 'text' && 'text' in p && String(p.text).includes('MCP servers'))), false);
    const query = history.find((m) => m.role === 'user' && m.content.some((p) => p.type === 'text' && 'text' in p && p.text === 'real question'));
    assert.ok(query);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('history lines without timestamp get stable times from summary created_at/updated_at', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-history-ts-'));
  const sessionsDir = join(base, 'sessions');
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const createdAt = '2026-08-16T06:20:33.425871041Z';
  const updatedAt = '2026-08-16T16:32:39.491629237Z';
  try {
    const encoded = encodeURIComponent('/tmp/project');
    const dir = join(sessionsDir, encoded, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'summary.json'), JSON.stringify({
      info: { id: sessionId, cwd: '/tmp/project' },
      created_at: createdAt,
      updated_at: updatedAt,
    }));
    await writeFile(join(dir, 'chat_history.jsonl'), [
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'first' }] }),
      JSON.stringify({ type: 'assistant', content: 'middle', model_id: 'grok-4.6' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'last' }] }),
    ].join('\n') + '\n');

    const adapter = new GrokProviderAdapter({ sessionsDir });
    const beforeNow = Date.now();
    const first = await adapter.getHistory(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await adapter.getHistory(sessionId);
    const afterNow = Date.now();

    assert.equal(first.length, 3);
    assert.equal(first[0]?.created_at, createdAt);
    assert.equal(first[2]?.created_at, updatedAt);
    const mid = Date.parse(first[1]?.created_at ?? '');
    assert.ok(Number.isFinite(mid));
    assert.ok(mid > Date.parse(createdAt));
    assert.ok(mid < Date.parse(updatedAt));
    assert.deepEqual(first.map((m) => m.created_at), second.map((m) => m.created_at));
    for (const message of first) {
      const ts = Date.parse(message.created_at);
      assert.ok(Number.isFinite(ts));
      assert.ok(ts < beforeNow - 1000 || ts > afterNow + 1000 || (ts >= Date.parse(createdAt) && ts <= Date.parse(updatedAt)));
      assert.ok(ts !== afterNow);
      assert.ok(Math.abs(ts - afterNow) > 60_000, `history timestamp must not be wall-clock now, got ${message.created_at}`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('maps kimi permission and plan_mode onto grok --permission-mode flags', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-perm-'));
  try {
    const { bin, argvLog, stdinLog } = await writeFakeGrok(base);
    const adapter = new GrokProviderAdapter({
      grokBin: bin,
      env: { GROK_ARGV_LOG: argvLog, GROK_STDIN_LOG: stdinLog },
    });
    const session = await adapter.create({ provider: 'grok', cwd: base });

    const run = async (): Promise<string[]> => {
      const handle = await adapter.startTurn({ sessionId: session.id, input: 'perm-check' });
      await drain(handle);
      return JSON.parse(await readFile(argvLog, 'utf8')) as string[];
    };

    await adapter.setPermission(session.id, 'manual');
    let argv = await run();
    const manualIdx = argv.indexOf('--permission-mode');
    assert.ok(manualIdx >= 0, JSON.stringify(argv));
    assert.equal(argv[manualIdx + 1], 'default');

    await adapter.setPermission(session.id, 'auto');
    argv = await run();
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'auto');

    await adapter.setPermission(session.id, 'yolo');
    argv = await run();
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'bypassPermissions');

    await adapter.setPlanMode(session.id, true);
    argv = await run();
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'plan');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('steer rejects because grok has no stdin channel', async () => {
  const adapter = new GrokProviderAdapter();
  await assert.rejects(
    adapter.steer('session-1', 'turn-1', 'hello'),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.code, 'unsupported');
      assert.equal(err.httpStatus, 400);
      return true;
    },
  );
  await assert.rejects(
    adapter.setGoal('session-1', 'do the thing'),
    (err: unknown) => err instanceof ProviderError && err.code === 'unsupported' && err.httpStatus === 400,
  );
  await assert.rejects(
    adapter.controlGoal('session-1', 'pause'),
    (err: unknown) => err instanceof ProviderError && err.code === 'unsupported' && err.httpStatus === 400,
  );
});

test('provider startTurn forwards image attachments as --prompt-json', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-attach-'));
  try {
    const { bin, argvLog, stdinLog } = await writeFakeGrok(base);
    const adapter = new GrokProviderAdapter({
      grokBin: bin,
      env: { GROK_ARGV_LOG: argvLog, GROK_STDIN_LOG: stdinLog },
    });
    const imagePath = join(base, 'pic.png');
    await writeFile(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    const session = await adapter.create({ provider: 'grok', cwd: base });
    const handle = await adapter.startTurn({
      sessionId: session.id,
      input: 'see this',
      attachments: [{ kind: 'localImage', path: imagePath, mediaType: 'image/png', name: 'pic.png', size: 8 }],
    });
    await drain(handle);
    const argv = JSON.parse(await readFile(argvLog, 'utf8')) as string[];
    assert.ok(argv.includes('--prompt-json'), JSON.stringify(argv));
    const payload = JSON.parse(argv[argv.indexOf('--prompt-json') + 1] ?? '[]') as Array<Record<string, unknown>>;
    assert.ok(payload.some((block) => block.type === 'image'));
    assert.ok(payload.some((block) => block.type === 'text' && String(block.text).includes('see this')));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
