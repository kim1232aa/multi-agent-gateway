import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GrokAdapter, GrokProviderAdapter, grokContextWindow, grokEffort, resolveGrokBin } from './grok-adapter.js';
import { ProviderError } from './types.js';

async function writeFakeGrok(dir: string): Promise<{ bin: string; argvLog: string; stdinLog: string }> {
  const bin = join(dir, 'grok');
  const argvLog = join(dir, 'argv.log');
  const stdinLog = join(dir, 'stdin.log');
  const script = `#!/usr/bin/env python3
import json, os, select, sys

args = sys.argv[1:]
if args[:1] == ["--resume"] and "--fork-session" in args:
    new_id = args[args.index("--session-id") + 1] if "--session-id" in args else ""
    sys.stdout.write('{"type":"system","subtype":"init","session_id":"%s"}\\n' % new_id)
    sys.stdout.write('{"type":"result","subtype":"success","result":"forked","is_error":false,"session_id":"%s"}\\n' % new_id)
    sys.exit(0)
argv_log = os.environ.get("GROK_ARGV_LOG")
stdin_log = os.environ.get("GROK_STDIN_LOG")
spawn_log = os.environ.get("GROK_SPAWN_LOG")
rpc_log = os.environ.get("GROK_RPC_LOG")
if spawn_log:
    with open(spawn_log, "a", encoding="utf-8") as f:
        f.write("x")
if argv_log:
    with open(argv_log, "w", encoding="utf-8") as f:
        json.dump(args, f)

stdin = ""
if args[:2] == ["agent", "stdio"]:
    pass
elif not sys.stdin.isatty():
    ready, _, _ = select.select([sys.stdin], [], [], 0.15)
    if ready:
        stdin = sys.stdin.read()
if stdin_log:
    with open(stdin_log, "w", encoding="utf-8") as f:
        f.write(stdin)

# ACP is opt-in and answered inline so headless -p tests exit immediately.
if args[:2] == ["agent", "stdio"]:
    if os.environ.get("GROK_FAKE_ACP") != "1":
        sys.exit(1)
    sys.stdout.reconfigure(line_buffering=True)
    pending_prompt = None
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        msg = json.loads(line)
        method, mid = msg.get("method"), msg.get("id")
        params = msg.get("params") or {}
        if method is None and mid is not None:
            if rpc_log:
                with open(rpc_log, "a", encoding="utf-8") as f:
                    f.write(json.dumps({"id": mid, "result": msg.get("result"), "error": msg.get("error")}) + "\\n")
            if pending_prompt is not None and str(mid) == "ask-req-1":
                print(json.dumps({"jsonrpc": "2.0", "id": pending_prompt, "result": {"stopReason": "end_turn"}}), flush=True)
                pending_prompt = None
            continue
        if rpc_log and method:
            with open(rpc_log, "a", encoding="utf-8") as f:
                f.write(json.dumps({"method": method, "params": params}) + "\\n")
        if method == "initialize":
            print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1, "_meta": {
                "modelState": {"currentModelId": "grok-4.6", "availableModels": [{"modelId": "grok-4.6"}]},
                "availableCommands": [{"name": n} for n in ["compact", "always-approve", "context", "session-info", "feedback", "deep-research", "workflow", "goal", "loop"]],
            }}}), flush=True)
        elif method == "session/new":
            print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": params.get("sessionId") or "acp-assigned"}}), flush=True)
        elif method == "session/prompt":
            sid = params.get("sessionId") or ""
            blocks = params.get("prompt")
            text = "".join(b.get("text", "") for b in blocks if isinstance(b, dict)) if isinstance(blocks, list) else ""
            if text.startswith("/goal "):
                print(json.dumps({"jsonrpc": "2.0", "method": "_x.ai/session_notification", "params": {"sessionId": sid, "update": {
                    "sessionUpdate": "goal_updated", "goal_id": "g1", "objective": text[6:].strip(),
                    "status": "active", "tokens_used": 7, "elapsed_ms": 2000, "token_budget": 500,
                }}}), flush=True)
            if os.environ.get("GROK_FAKE_QUESTION") == "1":
                pending_prompt = mid
                print(json.dumps({"jsonrpc": "2.0", "id": "ask-req-1", "method": "_x.ai/ask_user_question", "params": {
                    "sessionId": sid, "toolCallId": "ask-1",
                    "questions": [{"id": "q_0", "question": "Pick one", "options": [{"id": "a", "label": "Alpha"}]}],
                }}), flush=True)
            else:
                print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "acp-ok"}}}}), flush=True)
                print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}}), flush=True)
        elif method == "session/cancel":
            pass
        elif mid is not None:
            print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"configOptions": [
                {"id": params.get("configId") or "mode", "currentValue": params.get("value") or params.get("modeId") or params.get("modelId")},
            ]}}), flush=True)
    sys.exit(0)

if args[:1] == ["models"]:
    sys.stdout.write(
        "Model 'grok' is using its own API key.\\n"
        "\\n"
        "Default model: grok-4.5\\n"
        "\\n"
        "Available models:\\n"
        "  - grok-4.6\\n"
        "  * grok-4.5 (default)\\n"
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
    assert.deepEqual(models.map((m) => m.model), ['grok-4.5', 'grok-4.6', 'grok']);
    assert.equal(models[0]?.provider, 'grok');
    assert.ok(models.every((m) => m.max_context_size === 500_000));
    assert.ok(models.every((m) => m.max_context_size !== 0));
    assert.ok(models.every((m) => m.max_context_size !== 200_000));
    assert.equal(grokContextWindow('grok-4.6'), 500_000);
    assert.equal(grokContextWindow('grok-4.5'), 500_000);
    assert.equal(grokContextWindow('grok'), 500_000);
    assert.equal(grokContextWindow('unknown-family-model'), 500_000);
    assert.equal(grokContextWindow(), 500_000);
    assert.deepEqual(models[0]?.support_efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(models[0]?.default_effort, 'high');
    assert.ok(models.every((m) => m.capabilities?.includes('thinking')));
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

test('maps kimi thinking chips onto grok --effort', async () => {
  assert.equal(grokEffort(undefined), undefined);
  assert.equal(grokEffort('off'), undefined);
  assert.equal(grokEffort('on'), 'high');
  assert.equal(grokEffort('low'), 'low');
  assert.equal(grokEffort('medium'), 'medium');
  assert.equal(grokEffort('high'), 'high');
  assert.equal(grokEffort('xhigh'), 'xhigh');
  assert.equal(grokEffort('max'), 'max');
  assert.equal(grokEffort('unknown'), undefined);

  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-effort-'));
  try {
    const { bin, argvLog, stdinLog } = await writeFakeGrok(base);
    const adapter = new GrokProviderAdapter({
      grokBin: bin,
      env: { GROK_ARGV_LOG: argvLog, GROK_STDIN_LOG: stdinLog },
    });
    const session = await adapter.create({ provider: 'grok', cwd: base });
    const run = async (): Promise<string[]> => {
      const handle = await adapter.startTurn({ sessionId: session.id, input: 'effort-check' });
      await drain(handle);
      return JSON.parse(await readFile(argvLog, 'utf8')) as string[];
    };

    await adapter.setThinking(session.id, 'on');
    let argv = await run();
    assert.equal(argv[argv.indexOf('--effort') + 1], 'high', JSON.stringify(argv));

    await adapter.setThinking(session.id, 'max');
    argv = await run();
    assert.equal(argv[argv.indexOf('--effort') + 1], 'max', JSON.stringify(argv));

    await adapter.setThinking(session.id, 'off');
    argv = await run();
    assert.equal(argv.includes('--effort'), false, JSON.stringify(argv));
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

test('ACP spawn failure falls back to -p for that turn and retries ACP on the next turn', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-acp-retry-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const bin = join(base, 'grok');
    const spawnLog = join(base, 'spawn.log');
    const countFile = join(base, 'acp.count');
    await writeFile(bin, `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
spawn_log = os.environ.get("GROK_SPAWN_LOG")
if spawn_log:
    with open(spawn_log, "a", encoding="utf-8") as f:
        f.write(json.dumps(args) + "\\n")
if args[:2] == ["agent", "stdio"]:
    count_path = os.environ.get("GROK_ACP_COUNT")
    n = 1
    if count_path:
        try:
            n = int(open(count_path, encoding="utf-8").read() or "0") + 1
        except Exception:
            n = 1
        open(count_path, "w", encoding="utf-8").write(str(n))
    if n == 1:
        sys.exit(1)
    sys.stdout.reconfigure(line_buffering=True)
    try:
        sys.stdin.reconfigure(line_buffering=True)
    except Exception:
        pass
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        msg = json.loads(line)
        method = msg.get("method")
        mid = msg.get("id")
        if method == "initialize":
            print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": "0.1"}}), flush=True)
        elif method == "session/new":
            print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "acp-assigned"}}), flush=True)
        elif method == "session/load":
            print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {}}), flush=True)
        elif method == "session/prompt":
            sid = (msg.get("params") or {}).get("sessionId") or ""
            print(json.dumps({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": sid,
                    "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "acp-ok"}},
                },
            }), flush=True)
            print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}}), flush=True)
        elif mid is not None:
            print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {}}), flush=True)
    sys.exit(0)
if args[:1] == ["models"]:
    sys.stdout.write("Default model: grok-4.6\\nAvailable models:\\n  * grok-4.6 (default)\\n")
    sys.exit(0)
sys.stdout.write(
    '{"type":"system","subtype":"init","session_id":"s","cwd":"/tmp","tools":[]}\\n'
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"p-ok"}}}\\n'
    '{"type":"result","subtype":"success","result":"p-ok","is_error":false,"session_id":"s"}\\n'
)
sys.exit(0)
`)
    await chmod(bin, 0o755);
    adapter = new GrokProviderAdapter({
      grokBin: bin,
      env: { GROK_SPAWN_LOG: spawnLog, GROK_ACP_COUNT: countFile },
    });
    const session = await adapter.create({ provider: 'grok', cwd: base });
    await drain(await adapter.startTurn({ sessionId: session.id, input: 'first' }));
    await drain(await adapter.startTurn({ sessionId: session.id, input: 'second' }));
    assert.equal((adapter as any).acpSessionIds.get(session.id), 'acp-assigned');
    const spawns = (await readFile(spawnLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
    assert.ok(spawns.length >= 3, JSON.stringify(spawns));
    assert.deepEqual(spawns[0].slice(0, 2), ['agent', 'stdio']);
    assert.ok(spawns[1].includes('-p') || spawns[1][0] === '-p', JSON.stringify(spawns[1]));
    assert.deepEqual(spawns[2].slice(0, 2), ['agent', 'stdio']);
    assert.equal(spawns.filter((args) => args[0] === 'agent' && args[1] === 'stdio').length, 2);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

const SID = '33333333-3333-4333-8333-333333333333';

async function seedSession(sessionsDir: string, sessionId: string, files: Record<string, string>): Promise<string> {
  const dir = join(sessionsDir, encodeURIComponent('/tmp/work'), sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'summary.json'), JSON.stringify({
    info: { id: sessionId, cwd: '/tmp/work' },
    created_at: '2026-08-16T06:20:33Z',
    updated_at: '2026-08-16T16:32:39Z',
  }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, ...name.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

test('capabilities advertise the 1.0.77 surface', () => {
  const caps = new GrokProviderAdapter().capabilities();
  assert.equal(caps.questions, true);
  assert.equal(caps.goals, true);
  assert.equal(caps.fork, true);
  assert.equal(caps.rollback, true);
  assert.equal(caps.compact, true);
  assert.equal(caps.skills, true);
  assert.equal(caps.usage, true);
  assert.equal(caps.manualApproval, true);
  assert.deepEqual(caps.permissionModes, ['default', 'auto', 'bypassPermissions', 'plan']);
  assert.equal(new GrokAdapter().capabilities.questions, true);
  assert.equal(new GrokAdapter().capabilities.fork, true);
});

test('binary resolution prefers GROK_BIN over ~/.local/bin/grok and PATH', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-bin-'));
  const savedBin = process.env.GROK_BIN;
  const savedPath = process.env.PATH;
  try {
    const explicit = join(base, 'explicit');
    const fromEnv = join(base, 'from-env');
    const onPath = join(base, 'pathbin', 'grok');
    await writeFile(explicit, '#!/bin/sh\n');
    await writeFile(fromEnv, '#!/bin/sh\n');
    await mkdir(join(base, 'pathbin'), { recursive: true });
    await writeFile(onPath, '#!/bin/sh\n');
    await chmod(onPath, 0o755);
    assert.equal(resolveGrokBin(explicit), explicit);
    process.env.GROK_BIN = fromEnv;
    assert.equal(resolveGrokBin(), fromEnv);
    delete process.env.GROK_BIN;
    process.env.PATH = `${join(base, 'pathbin')}${savedPath ? `:${savedPath}` : ''}`;
    const resolved = resolveGrokBin();
    assert.ok(resolved === onPath || resolved.endsWith(`${join('.local', 'bin', 'grok')}`), resolved);
  } finally {
    if (savedBin === undefined) delete process.env.GROK_BIN;
    else process.env.GROK_BIN = savedBin;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(base, { recursive: true, force: true });
  }
});

test('child env strips GATEWAY_* and keeps loopback out of the proxy', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-env-'));
  const saved = process.env.GATEWAY_TOKEN;
  try {
    process.env.GATEWAY_TOKEN = 'super-secret';
    const { bin, argvLog } = await writeFakeGrok(base);
    const envDump = join(base, 'env.json');
    const script = await readFile(bin, 'utf8');
    await writeFile(bin, script.replace(
      'args = sys.argv[1:]',
      `args = sys.argv[1:]\nif os.environ.get("GROK_ENV_DUMP"):\n    open(os.environ["GROK_ENV_DUMP"], "w").write(json.dumps({k: os.environ.get(k) for k in ("GATEWAY_TOKEN", "NO_PROXY")}))`,
    ));
    const adapter = new GrokAdapter({ grokBin: bin, env: { GROK_ARGV_LOG: argvLog, GROK_ENV_DUMP: envDump, NO_PROXY: 'example.com' } });
    const { sessionId } = await adapter.create(base);
    await adapter.startTurn({ sessionId, prompt: 'env-check', cwd: base, isNew: true, onEvent: () => undefined });
    const dumped = JSON.parse(await readFile(envDump, 'utf8')) as { GATEWAY_TOKEN?: string; NO_PROXY?: string };
    assert.ok(dumped.GATEWAY_TOKEN == null, `GATEWAY_TOKEN leaked: ${dumped.GATEWAY_TOKEN}`);
    assert.ok(String(dumped.NO_PROXY).split(',').includes('127.0.0.1'), dumped.NO_PROXY);
    assert.ok(String(dumped.NO_PROXY).includes('example.com'), dumped.NO_PROXY);
  } finally {
    if (saved === undefined) delete process.env.GATEWAY_TOKEN;
    else process.env.GATEWAY_TOKEN = saved;
    await rm(base, { recursive: true, force: true });
  }
});

test('large prompts go through --prompt-file and the temp file is removed', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-e2big-'));
  try {
    const { bin, argvLog } = await writeFakeGrok(base);
    const adapter = new GrokAdapter({ grokBin: bin, env: { GROK_ARGV_LOG: argvLog } });
    const { sessionId } = await adapter.create(base);
    const big = 'x'.repeat(40 * 1024);
    await adapter.startTurn({ sessionId, prompt: big, cwd: base, isNew: true, onEvent: () => undefined });
    const argv = JSON.parse(await readFile(argvLog, 'utf8')) as string[];
    const fileIdx = argv.indexOf('--prompt-file');
    assert.ok(fileIdx >= 0, JSON.stringify(argv.slice(0, 4)));
    assert.equal(argv.includes('-p'), false);
    const promptFile = argv[fileIdx + 1];
    assert.equal(await readFile(promptFile, 'utf8').catch(() => 'gone'), 'gone');

    const bigBlocks = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(40 * 1024) } }];
    await adapter.startTurn({ sessionId, prompt: 'img', cwd: base, isNew: false, contentBlocks: bigBlocks, onEvent: () => undefined });
    const argv2 = JSON.parse(await readFile(argvLog, 'utf8')) as string[];
    assert.ok(argv2.includes('--prompt-file'), JSON.stringify(argv2.slice(0, 4)));
    assert.equal(argv2.includes('--prompt-json'), false);
    assert.equal(await readFile(argv2[argv2.indexOf('--prompt-file') + 1], 'utf8').catch(() => 'gone'), 'gone');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('getHistory honors rewind_marker and rewind_points within a 16MiB tail window', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-rewind-'));
  const sessionsDir = join(base, 'sessions');
  try {
    const updates = [
      JSON.stringify({ method: '_x.ai/session/update', params: { sessionId: SID, update: { sessionUpdate: 'user_message_chunk', _meta: { promptIndex: 0 } } } }),
      JSON.stringify({ method: '_x.ai/session/update', params: { sessionId: SID, update: { sessionUpdate: 'rewind_marker', target_prompt_index: 1 } } }),
    ].join('\n') + '\n';
    await seedSession(sessionsDir, SID, {
      'chat_history.jsonl': [
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'keep me' }] }),
        JSON.stringify({ type: 'assistant', content: 'kept reply' }),
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'drop me' }] }),
        JSON.stringify({ type: 'assistant', content: 'dropped reply' }),
      ].join('\n') + '\n',
      'updates.jsonl': updates,
      'rewind_points.jsonl': JSON.stringify({ prompt_index: 0 }) + '\n' + JSON.stringify({ prompt_index: 1 }) + '\n',
    });
    const history = await new GrokProviderAdapter({ sessionsDir }).getHistory(SID);
    const texts = history.flatMap((m) => m.content).map((p) => 'text' in p ? p.text : '').filter(Boolean);
    assert.deepEqual(texts, ['keep me', 'kept reply']);

    const adapter = new GrokProviderAdapter({ sessionsDir });
    await adapter.rollback(SID, 1);
    const after = await adapter.getHistory(SID);
    assert.equal(after.length, 0);
    const marker = (await readFile(join(sessionsDir, encodeURIComponent('/tmp/work'), SID, 'updates.jsonl'), 'utf8'))
      .trim().split('\n').pop() ?? '';
    assert.equal(JSON.parse(marker).params.update.target_prompt_index, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('getHistory refuses to follow a symlinked session file', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-nofollow-'));
  const sessionsDir = join(base, 'sessions');
  try {
    const outside = join(base, 'secret.jsonl');
    await writeFile(outside, JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'leaked' }] }) + '\n');
    const dir = await seedSession(sessionsDir, SID, {});
    await symlink(outside, join(dir, 'chat_history.jsonl'));
    await assert.rejects(new GrokProviderAdapter({ sessionsDir }).getHistory(SID), /not found/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('usage.json feeds getUsage with cache, reasoning and turn counts', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-usage-'));
  const sessionsDir = join(base, 'sessions');
  try {
    await seedSession(sessionsDir, SID, {
      'usage.json': JSON.stringify({
        sessionId: SID,
        session: {
          inputTokens: 100, outputTokens: 40, cachedReadTokens: 25, cacheCreationTokens: 5,
          reasoningTokens: 9, turnCount: 3, costUsdTicks: 15_000_000_000,
        },
      }),
    });
    const usage = new GrokProviderAdapter({ sessionsDir }).getUsage(SID);
    assert.equal(usage?.input_tokens, 100);
    assert.equal(usage?.output_tokens, 40);
    assert.equal(usage?.cache_read_tokens, 25);
    assert.equal(usage?.cache_creation_tokens, 5);
    assert.equal(usage?.reasoning_output_tokens, 9);
    assert.equal(usage?.turn_count, 3);
    assert.equal(usage?.total_cost_usd, 1.5);
    assert.equal(usage?.authoritative, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('fork clones the session directory when the CLI cannot fork', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-fork-'));
  const sessionsDir = join(base, 'sessions');
  try {
    await seedSession(sessionsDir, SID, {
      'chat_history.jsonl': JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'origin' }] }) + '\n',
    });
    const adapter = new GrokProviderAdapter({ sessionsDir, grokBin: join(base, 'missing-grok') });
    await adapter.list();
    const forked = await adapter.fork(SID);
    assert.notEqual(forked.id, SID);
    assert.equal(forked.metadata.cwd, '/tmp/work');
    const history = await adapter.getHistory(forked.id);
    assert.equal(history[0]?.content[0] && 'text' in history[0].content[0] ? history[0].content[0].text : '', 'origin');
    const summary = JSON.parse(await readFile(
      join(sessionsDir, encodeURIComponent('/tmp/work'), forked.id, 'summary.json'), 'utf8',
    )) as { parent_session_id?: string };
    assert.equal(summary.parent_session_id, SID);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('goal commands report a snapshot through the ACP slash command', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-goal-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const bin = join(base, 'grok');
    const rpcLog = join(base, 'rpc.log');
    await writeFile(bin, `#!/usr/bin/env python3
import json, os, sys
sys.stdout.reconfigure(line_buffering=True)
rpc_log = os.environ.get("GROK_RPC_LOG")
for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    msg = json.loads(line)
    method, mid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
    if rpc_log and method:
        open(rpc_log, "a").write(json.dumps({"method": method, "params": params}) + "\\n")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1}}), flush=True)
    elif method == "session/new":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "acp-goal"}}), flush=True)
    elif method == "session/load":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {}}), flush=True)
    elif method == "session/prompt":
        text = ""
        prompt = params.get("prompt")
        if isinstance(prompt, list):
            text = "".join(b.get("text", "") for b in prompt if isinstance(b, dict))
        assert isinstance(prompt, list), "prompt must be a content block array"
        sid = params.get("sessionId") or ""
        if text.startswith("/goal "):
            print(json.dumps({"jsonrpc": "2.0", "method": "_x.ai/session_notification", "params": {"sessionId": sid, "update": {
                "sessionUpdate": "goal_updated", "goal_id": "g1", "objective": text[6:].strip(),
                "status": "active", "tokens_used": 7, "elapsed_ms": 2000, "token_budget": 500,
            }}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}}), flush=True)
    elif mid is not None:
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {}}), flush=True)
`);
    await chmod(bin, 0o755);
    adapter = new GrokProviderAdapter({ grokBin: bin, env: { GROK_RPC_LOG: rpcLog } });
    const session = await adapter.create({ provider: 'grok', cwd: base });
    const goal = await adapter.setGoal(session.id, 'ship the adapter');
    assert.equal(goal?.objective, 'ship the adapter');
    assert.equal(goal?.threadId, 'g1');
    assert.equal(goal?.tokensUsed, 7);
    assert.equal(goal?.timeUsedSeconds, 2);
    assert.equal(goal?.tokenBudget, 500);
    assert.equal((await adapter.getGoal(session.id))?.status, 'active');
    await assert.rejects(adapter.setGoal(session.id, '   '), (err: unknown) => err instanceof ProviderError && err.httpStatus === 400);
    const rpcs = (await readFile(rpcLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { method: string; params: { prompt?: unknown } });
    const prompt = rpcs.find((r) => r.method === 'session/prompt');
    assert.ok(Array.isArray(prompt?.params.prompt), 'session/prompt must send a content block array');
    assert.equal(await adapter.controlGoal(session.id, 'cancel'), null);
    assert.equal(await adapter.getGoal(session.id), null);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('resolveQuestion answers and dismisses pending ask_user_question requests', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-question-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const { bin } = await writeFakeGrok(base);
    const rpcLog = join(base, 'rpc.log');
    adapter = new GrokProviderAdapter({ grokBin: bin, env: { GROK_RPC_LOG: rpcLog, GROK_FAKE_ACP: '1', GROK_FAKE_QUESTION: '1' } });
    const session = await adapter.create({ provider: 'grok', cwd: base });
    const handle = await adapter.startTurn({ sessionId: session.id, input: 'ask me' });
    const events = [];
    for await (const event of handle.events) {
      events.push(event);
      if ((event as { kind?: string }).kind === 'question') break;
    }
    const question = events.find((e) => (e as { kind?: string }).kind === 'question') as { payload?: { questionId?: string } } | undefined;
    assert.equal(question?.payload?.questionId, 'ask-1');
    await adapter.resolveQuestion(session.id, 'ask-1', { q_0: ['Alpha'] });
    const answered = (await readFile(rpcLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { id?: number; result?: { outcome?: string } });
    assert.equal(answered.at(-1)?.id, 'ask-req-1');
    assert.equal(answered.at(-1)?.result?.outcome, 'accepted');

    await assert.rejects(
      adapter.resolveQuestion(session.id, 'missing', 'x'),
      (err: unknown) => err instanceof ProviderError && err.code === 'not_found',
    );
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('listCommands merges ACP native commands with disk skills', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-skills-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    await mkdir(join(base, '.grok', 'skills', 'ship-it'), { recursive: true });
    await writeFile(join(base, '.grok', 'skills', 'ship-it', 'SKILL.md'), '---\nname: ship-it\n---\nShip $ARGUMENTS now\n');
    const { bin } = await writeFakeGrok(base);
    adapter = new GrokProviderAdapter({ grokBin: bin, env: { GROK_FAKE_ACP: '1' } });
    const session = await adapter.create({ provider: 'grok', cwd: base });
    await drain(await adapter.startTurn({ sessionId: session.id, input: 'hi' }));
    const commands = await adapter.listCommands(session.id);
    for (const name of ['compact', 'always-approve', 'context', 'session-info', 'feedback', 'deep-research', 'workflow', 'goal', 'loop']) {
      assert.ok(commands.some((c) => c.name === name), `missing native command ${name}`);
    }
    assert.ok(commands.some((c) => c.name === 'ship-it'), 'disk skill missing');
    const skills = await adapter.listSkills(session.id);
    assert.ok(skills.some((s) => s.name === 'ship-it' && s.enabled === true && s.scope === 'project'));
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('live ACP sync sends set_mode, set_model and set_config_option', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-config-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const { bin } = await writeFakeGrok(base);
    const rpcLog = join(base, 'rpc.log');
    adapter = new GrokProviderAdapter({ grokBin: bin, env: { GROK_FAKE_ACP: '1', GROK_RPC_LOG: rpcLog } });
    const session = await adapter.create({ provider: 'grok', cwd: base });
    await adapter.setModel(session.id, 'grok-4.6');
    await adapter.setThinking(session.id, 'xhigh');
    await adapter.setPlanMode(session.id, true);
    await drain(await adapter.startTurn({ sessionId: session.id, input: 'configure' }));
    const methods = (await readFile(rpcLog, 'utf8')).trim().split('\n')
      .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> });
    const setMode = methods.find((m) => m.method === 'session/set_mode');
    const setModel = methods.find((m) => m.method === 'session/set_model');
    const setConfig = methods.find((m) => m.method === 'session/set_config_option');
    assert.equal(setMode?.params.modeId, 'plan');
    assert.equal(setModel?.params.modelId, 'grok-4.6');
    assert.equal(setConfig?.params.configId, 'reasoning_effort');
    assert.equal(setConfig?.params.value, 'xhigh');
    const prompt = methods.find((m) => m.method === 'session/prompt');
    assert.ok(Array.isArray(prompt?.params.prompt));
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

const LIVE_GROK_BIN = process.env.GROK_LIVE_BIN ?? '/tmp/grok-survey-80NQ6R/bin-1.0.77/grok';

test('live 1.0.77 binary speaks the ACP surface this adapter targets', { skip: !existsSync(LIVE_GROK_BIN) }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'multi-agent-grok-live-'));
  const child = spawn(LIVE_GROK_BIN, ['agent', 'stdio'], {
    cwd: home,
    env: { ...process.env, HOME: home, GROK_HOME: join(home, '.grok'), XAI_API_KEY: 'xai-test-key' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines: string[] = [];
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      lines.push(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  });
  const waitFor = async (predicate: (msg: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (predicate(msg)) return msg;
        } catch {
          // partial line
        }
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ACP response; tail=${lines.slice(-3).join(' | ')}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const send = (msg: Record<string, unknown>): void => {
    child.stdin?.write(JSON.stringify(msg) + '\n');
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'probe', version: '0' } } });
    const init = await waitFor((msg) => msg.id === 1);
    const result = init.result as { _meta?: { modelState?: { currentModelId?: string } } } | undefined;
    assert.equal(typeof result?._meta?.modelState?.currentModelId, 'string');
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: home, mcpServers: [] } });
    const created = await waitFor((msg) => msg.id === 2);
    const sessionId = (created.result as { sessionId?: string } | undefined)?.sessionId;
    assert.equal(typeof sessionId, 'string');
    send({ jsonrpc: '2.0', id: 3, method: 'session/set_mode', params: { sessionId, modeId: 'plan' } });
    send({ jsonrpc: '2.0', id: 4, method: 'session/set_model', params: { sessionId, modelId: 'grok-4.5' } });
    send({ jsonrpc: '2.0', id: 5, method: 'session/set_config_option', params: { sessionId, configId: 'reasoning_effort', value: 'high' } });
    const config = await waitFor((msg) => msg.id === 5);
    assert.equal(config.error, undefined, JSON.stringify(config.error));
    send({ jsonrpc: '2.0', id: 6, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '/goal status' }] } });
    const prompt = await waitFor((msg) => msg.id === 6);
    assert.equal(prompt.error, undefined, JSON.stringify(prompt.error));
  } finally {
    child.kill('SIGKILL');
    await rm(home, { recursive: true, force: true });
  }
});


