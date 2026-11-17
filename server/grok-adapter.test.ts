import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  GrokAdapter,
  GrokProviderAdapter,
  grokContextWindow,
  grokEffort,
  resolveGrokBin,
  GROK_EFFORTS,
  acpPrompt,
  materializePromptFile,
  discoverGrokDiskSkills,
  isKnownGrokReasoningModel,
} from './grok-adapter.js';
import { GrokAcpClient } from './grok-acp.js';
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
                "availableCommands": [{"name": n} for n in ["compact", "always-approve", "context", "session-info", "deep-research", "workflow", "goal", "doctor", "docs", "dashboard"]],
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
    assert.deepEqual(models[0]?.support_efforts, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
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
  assert.equal(grokEffort('off'), 'none');
  assert.equal(grokEffort('none'), 'none');
  assert.equal(grokEffort('minimal'), 'minimal');
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

    await adapter.setThinking(session.id, 'minimal');
    argv = await run();
    assert.equal(argv[argv.indexOf('--effort') + 1], 'minimal', JSON.stringify(argv));

    await adapter.setThinking(session.id, 'off');
    argv = await run();
    assert.equal(argv[argv.indexOf('--effort') + 1], 'none', JSON.stringify(argv));
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
    for (const name of ['compact', 'always-approve', 'context', 'session-info', 'deep-research', 'workflow', 'goal']) {
      assert.ok(commands.some((c) => c.name === name), `missing native command ${name}`);
    }
    assert.equal(commands.some((c) => c.name === 'feedback' || c.name === 'loop'), false);
    assert.ok(commands.some((c) => c.name === 'ship-it'), 'disk skill missing');
    const discovered = await adapter.listCommands();
    assert.ok(discovered.some((c) => c.name === 'doctor'), 'ACP command catalog not discovered without a session');
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

const LIVE_GROK_BIN = process.env.GROK_LIVE_BIN
  ?? (existsSync('/tmp/grok-survey-80NQ6R/bin-1.0.77/grok')
    ? '/tmp/grok-survey-80NQ6R/bin-1.0.77/grok'
    : resolveGrokBin());

test('live 1.0.77 binary speaks the ACP surface this adapter targets', {
  skip: process.env.GATEWAY_LIVE_CLI_TESTS !== '1' || !existsSync(LIVE_GROK_BIN),
  timeout: 30_000,
}, async () => {
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

test('maps ACP-assigned sessionId across events, approvals, history and usage', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-acpid-'));
  const sessionsDir = join(base, 'sessions');
  const assignedId = '01999999-9999-7999-8999-999999999999';
  let adapter: GrokProviderAdapter | undefined;
  try {
    const bin = join(base, 'grok');
    await writeFile(bin, `#!/usr/bin/env python3
import json, os, sys
sys.stdout.reconfigure(line_buffering=True)
sessions_dir = os.environ["TEST_SESSIONS_DIR"]
assigned = os.environ["TEST_ASSIGNED_ID"]
cwd = os.environ["TEST_CWD"]
pending_prompt = None
for raw in sys.stdin:
    line = raw.strip()
    if not line: continue
    msg = json.loads(line)
    method, mid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
    if method is None and mid == "perm-1":
        print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": assigned, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "approved-reply"}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": pending_prompt, "result": {"stopReason": "end_turn"}}), flush=True)
        pending_prompt = None
        continue
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1}}), flush=True)
    elif method == "session/new":
        sdir = os.path.join(sessions_dir, "%2Ftmp%2Fwork", assigned)
        os.makedirs(sdir, exist_ok=True)
        open(os.path.join(sdir, "summary.json"), "w").write(json.dumps({"info": {"id": assigned, "cwd": cwd}, "created_at": "2026-08-16T06:20:33Z", "updated_at": "2026-08-16T06:21:00Z"}))
        open(os.path.join(sdir, "chat_history.jsonl"), "w").write(json.dumps({"type": "user", "content": [{"type": "text", "text": "hi"}]}) + "\\n")
        open(os.path.join(sdir, "usage.json"), "w").write(json.dumps({"session": {"inputTokens": 12, "outputTokens": 5, "turnCount": 1}}))
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": assigned}}), flush=True)
    elif method == "session/prompt":
        pending_prompt = mid
        print(json.dumps({"jsonrpc": "2.0", "id": "perm-1", "method": "session/request_permission", "params": {"sessionId": assigned, "toolCall": {"toolCallId": "tc-1", "title": "Bash"}, "options": [{"optionId": "allow_once", "kind": "allow_once"}]}}), flush=True)
    elif mid is not None:
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {}}), flush=True)
`);
    await chmod(bin, 0o755);
    adapter = new GrokProviderAdapter({
      grokBin: bin,
      sessionsDir,
      settingsPath: join(base, 'settings.json'),
      env: { TEST_SESSIONS_DIR: sessionsDir, TEST_ASSIGNED_ID: assignedId, TEST_CWD: base },
    });
    const session = await adapter.create({ provider: 'grok', cwd: base });
    assert.notEqual(session.id, assignedId);
    const handle = await adapter.startTurn({ sessionId: session.id, input: 'hi' });
    const seen: string[] = [];
    for await (const ev of handle.events) {
      seen.push(`${ev.kind}:${ev.status}`);
      if (ev.kind === 'approval') {
        await adapter.resolveApproval(session.id, 'perm-1', 'approve');
      }
      if (ev.kind === 'message') {
        assert.equal((ev.payload as { delta?: string }).delta, 'approved-reply');
      }
    }
    assert.ok(seen.includes('approval:started'), seen.join(','));
    assert.ok(seen.includes('message:delta'), seen.join(','));
    assert.ok(seen.includes('turn:completed'), seen.join(','));
    const history = await adapter.getHistory(session.id);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.session_id, session.id);
    assert.equal(adapter.getUsage(session.id)?.input_tokens, 12);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('rewind_points without rewind_marker does not truncate history and post-rewind updates survive', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-points-'));
  const sessionsDir = join(base, 'sessions');
  try {
    await seedSession(sessionsDir, SID, {
      'chat_history.jsonl': [
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'turn 0' }] }),
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'turn 1' }] }),
      ].join('\n') + '\n',
      'rewind_points.jsonl': JSON.stringify({ prompt_index: 0 }) + '\n',
    });
    const adapter = new GrokProviderAdapter({ sessionsDir });
    const history = await adapter.getHistory(SID);
    const texts = history.flatMap((m) => m.content).map((p) => ('text' in p ? p.text : '')).filter(Boolean);
    assert.deepEqual(texts, ['turn 0', 'turn 1']);

    // Updates-only fallback with rewind_marker followed by a new user turn keeps the new turn.
    const sid2 = '44444444-4444-4444-8444-444444444444';
    await seedSession(sessionsDir, sid2, {
      'updates.jsonl': [
        JSON.stringify({ params: { sessionId: sid2, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'keep' } } } }),
        JSON.stringify({ params: { sessionId: sid2, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'rewound' } } } }),
        JSON.stringify({ params: { sessionId: sid2, update: { sessionUpdate: 'rewind_marker', target_prompt_index: 1 } } }),
        JSON.stringify({ params: { sessionId: sid2, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'after-rewind' } } } }),
      ].join('\n') + '\n',
    });
    const history2 = await adapter.getHistory(sid2);
    const texts2 = history2.flatMap((m) => m.content).map((p) => ('text' in p ? p.text : '')).filter(Boolean);
    assert.deepEqual(texts2, ['keep', 'after-rewind']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('alwaysApprove isolation prevents slash command ACP calls from killing active yolo turn', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-yolo-iso-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const bin = join(base, 'grok');
    await writeFile(bin, `#!/usr/bin/env python3
import json, sys
sys.stdout.reconfigure(line_buffering=True)
always = "--always-approve" in sys.argv[1:]
for raw in sys.stdin:
    line = raw.strip()
    if not line: continue
    msg = json.loads(line)
    method, mid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1}}), flush=True)
    elif method == "session/new":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": params.get("sessionId") or "s"}}), flush=True)
    elif method == "session/prompt":
        sid = params.get("sessionId") or ""
        text = "".join(b.get("text", "") for b in (params.get("prompt") or []) if isinstance(b, dict))
        if always:
            import time
            time.sleep(0.15)
        print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "yolo-ok" if always else "norm-ok"}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}}), flush=True)
    elif mid is not None:
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {}}), flush=True)
`);
    await chmod(bin, 0o755);
    adapter = new GrokProviderAdapter({ grokBin: bin, settingsPath: join(base, 'settings.json') });
    const sYolo = await adapter.create({ provider: 'grok', cwd: base });
    await adapter.setPermission(sYolo.id, 'yolo');
    const sNorm = await adapter.create({ provider: 'grok', cwd: base });
    const yoloTurn = await adapter.startTurn({ sessionId: sYolo.id, input: 'slow yolo' });
    const compactPromise = adapter.compact(sNorm.id);
    const [yoloEvents] = await Promise.all([drain(yoloTurn), compactPromise]);
    const text = yoloEvents.filter((e: any) => e.kind === 'message').map((e: any) => e.payload?.delta ?? '').join('');
    assert.equal(text, 'yolo-ok');
    assert.ok(yoloEvents.some((e: any) => e.kind === 'turn' && e.status === 'completed'));
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('list skips symlinked summary.json and creates collision-resistant workspace ids', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-list-nofollow-'));
  const sessionsDir = join(base, 'sessions');
  try {
    const cwd1 = join(base, 'very-long-workspace-prefix-segment-alpha-one');
    const cwd2 = join(base, 'very-long-workspace-prefix-segment-alpha-two');
    const outside = join(base, 'outside.json');
    await writeFile(outside, JSON.stringify({ info: { id: SID, cwd: cwd1 }, session_summary: 'secret' }));
    const dir = join(sessionsDir, encodeURIComponent(cwd1), SID);
    await mkdir(dir, { recursive: true });
    await symlink(outside, join(dir, 'summary.json'));
    const adapter = new GrokProviderAdapter({ sessionsDir });
    assert.equal((await adapter.list()).items.length, 0);
    const s1 = await adapter.create({ provider: 'grok', cwd: cwd1 });
    const s2 = await adapter.create({ provider: 'grok', cwd: cwd2 });
    assert.notEqual(s1.workspace_id, s2.workspace_id);
    assert.ok(s1.workspace_id.length <= 60 && s2.workspace_id.length <= 60);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('GROK_EFFORTS includes minimal', () => {
  assert.deepEqual(GROK_EFFORTS, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('getThinking falls back to __default__ and setThinking persists __default__ without throwing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-default-thinking-'));
  try {
    const settingsPath = join(base, 'settings.json');
    const adapter = new GrokProviderAdapter({ settingsPath });
    const s1 = await adapter.create({ provider: 'grok', cwd: base });
    assert.equal(adapter.getThinking(s1.id), undefined);

    await adapter.setThinking('__default__', 'minimal');
    assert.equal(adapter.getThinking('__default__'), 'minimal');
    assert.equal(adapter.getThinking(s1.id), 'minimal');

    await adapter.setThinking(s1.id, 'max');
    assert.equal(adapter.getThinking(s1.id), 'max');
    assert.equal(adapter.getThinking('__default__'), 'minimal');

    const s2 = await adapter.create({ provider: 'grok', cwd: base });
    assert.equal(adapter.getThinking(s2.id), 'minimal');
    await adapter.dispose();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('live ACP sync sends reasoning_effort for minimal and none (off)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-effort-sync-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const { bin } = await writeFakeGrok(base);
    const rpcLog = join(base, 'rpc.log');
    adapter = new GrokProviderAdapter({ grokBin: bin, env: { GROK_FAKE_ACP: '1', GROK_RPC_LOG: rpcLog } });
    const session = await adapter.create({ provider: 'grok', cwd: base });
    await drain(await adapter.startTurn({ sessionId: session.id, input: 'init' }));

    await adapter.setThinking(session.id, 'minimal');
    await adapter.setThinking(session.id, 'off');
    await adapter.setThinking(session.id, 'none');

    const methods = (await readFile(rpcLog, 'utf8')).trim().split('\n')
      .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> });
    const configCalls = methods.filter((m) => m.method === 'session/set_config_option' && m.params.configId === 'reasoning_effort');
    assert.ok(configCalls.length >= 3);
    assert.equal(configCalls.at(-3)?.params.value, 'minimal');
    assert.equal(configCalls.at(-2)?.params.value, 'none');
    assert.equal(configCalls.at(-1)?.params.value, 'none');
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('listModels ACP branch omits efforts and default_effort when supportsReasoningEffort is false', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-no-effort-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const bin = join(base, 'grok');
    await writeFile(bin, `#!/usr/bin/env python3
import json, sys
sys.stdout.reconfigure(line_buffering=True)
for raw in sys.stdin:
    line = raw.strip()
    if not line: continue
    msg = json.loads(line)
    method, mid = msg.get("method"), msg.get("id")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1, "_meta": {
            "modelState": {"currentModelId": "grok-no-reason", "availableModels": [
                {"modelId": "grok-no-reason", "name": "No Reasoning", "supportsReasoningEffort": False},
                {"modelId": "grok-with-reason", "name": "With Reasoning", "supportsReasoningEffort": True}
            ]},
        }}}), flush=True)
    elif method == "session/new":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {"sessionId": "s1"}}), flush=True)
    elif mid is not None:
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {}}), flush=True)
`);
    await chmod(bin, 0o755);
    adapter = new GrokProviderAdapter({ grokBin: bin, env: { GROK_FAKE_ACP: '1' } });
    const session = await adapter.create({ provider: 'grok', cwd: base });
    await drain(await adapter.startTurn({ sessionId: session.id, input: 'prime' }));
    (adapter as any).inner.listModels = async () => { throw new Error('force-acp'); };
    const models = await adapter.listModels();
    const noReason = models.find((m) => m.model === 'grok-no-reason');
    assert.ok(noReason);
    assert.deepEqual(noReason.capabilities, []);
    assert.equal(noReason.support_efforts, undefined);
    assert.equal(noReason.default_effort, undefined);

    const withReason = models.find((m) => m.model === 'grok-with-reason');
    assert.ok(withReason);
    assert.deepEqual(withReason.capabilities, ['thinking']);
    assert.deepEqual(withReason.support_efforts, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(withReason.default_effort, 'high');
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('acpPrompt validates non-empty prompt or throws clean ProviderError', () => {
  assert.throws(() => acpPrompt(''), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, 'invalid_request');
    assert.equal(err.httpStatus, 400);
    assert.equal(err.message, 'empty prompt');
    return true;
  });
  assert.throws(() => acpPrompt('   ', []), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, 'invalid_request');
    assert.equal(err.httpStatus, 400);
    return true;
  });
  assert.throws(() => acpPrompt('', [{ type: 'text', text: '   ' }]), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, 'invalid_request');
    assert.equal(err.httpStatus, 400);
    return true;
  });

  const textRes = acpPrompt('hello world');
  assert.deepEqual(textRes, [{ type: 'text', text: 'hello world' }]);

  const blockRes = acpPrompt('', [{ type: 'text', text: 'block text' }]);
  assert.deepEqual(blockRes, [{ type: 'text', text: 'block text' }]);
});

test('materializePromptFile decodes base64 images into temp files and writes plain text prompt', async () => {
  const base64Png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  const bigBase64 = base64Png + 'A'.repeat(35 * 1024);
  const contentBlocks = [
    { type: 'text', text: 'Please review this architecture diagram' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigBase64 } },
  ];

  const promptFile = materializePromptFile('prompt header', contentBlocks);
  assert.ok(promptFile);
  assert.ok(promptFile.path.endsWith('.txt'));

  const fileContent = await readFile(promptFile.path, 'utf8');
  assert.ok(!fileContent.startsWith('[{"type"'));
  assert.ok(fileContent.includes('prompt header'));
  assert.ok(fileContent.includes('Please review this architecture diagram'));
  assert.ok(fileContent.includes('Attached image: '));

  const match = /Attached image: (\S+)/.exec(fileContent);
  assert.ok(match && match[1]);
  const imgPath = match[1];
  assert.ok(existsSync(imgPath));

  promptFile.cleanup();
  assert.equal(existsSync(promptFile.path), false);
  assert.equal(existsSync(imgPath), false);
});

test('commandsCache caches discovered ACP commands and clearCommandsCache invalidates it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-cache-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const { bin } = await writeFakeGrok(base);
    const spawnLog = join(base, 'spawn.log');
    adapter = new GrokProviderAdapter({
      grokBin: bin,
      env: { GROK_FAKE_ACP: '1', GROK_SPAWN_LOG: spawnLog },
    });
    const cmds1 = await adapter.listCommands();
    assert.ok(cmds1.some((c) => c.name === 'doctor'));
    assert.equal(await readFile(spawnLog, 'utf8'), 'x');

    const cmds2 = await adapter.listCommands();
    assert.ok(cmds2.some((c) => c.name === 'doctor'));
    assert.equal(await readFile(spawnLog, 'utf8'), 'x');

    adapter.clearCommandsCache();
    await (adapter as any).recycleAcpClients();
    assert.equal(adapter.client, null);

    const cmds3 = await adapter.listCommands();
    assert.ok(cmds3.some((c) => c.name === 'doctor'));
    assert.equal(await readFile(spawnLog, 'utf8'), 'xx');
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('recycles idle ACP child process after recycleGraceMs when not busy', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-idle-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const { bin } = await writeFakeGrok(base);
    adapter = new GrokProviderAdapter({
      grokBin: bin,
      env: { GROK_FAKE_ACP: '1' },
      recycleGraceMs: 30,
    });
    const cmds = await adapter.listCommands();
    assert.ok(cmds.some((c) => c.name === 'doctor'));
    assert.ok(adapter.client?.ready);

    await new Promise((r) => setTimeout(r, 70));
    assert.equal(adapter.client, null);

    const cmds2 = await adapter.listCommands();
    assert.ok(cmds2.some((c) => c.name === 'doctor'));
    assert.equal(adapter.client, null);

    const session = await adapter.create({ provider: 'grok', cwd: base });
    await drain(await adapter.startTurn({ sessionId: session.id, input: 'hi' }));

    await new Promise((r) => setTimeout(r, 70));
    assert.equal(adapter.client, null);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('does not recycle ACP child process while question or turn is active', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-q-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const { bin } = await writeFakeGrok(base);
    adapter = new GrokProviderAdapter({
      grokBin: bin,
      env: { GROK_FAKE_ACP: '1', GROK_FAKE_QUESTION: '1' },
      recycleGraceMs: 25,
    });
    const session = await adapter.create({ provider: 'grok', cwd: base });
    const handle = await adapter.startTurn({ sessionId: session.id, input: 'ask me' });
    let qId = '';
    for await (const ev of handle.events) {
      if ((ev as any).kind === 'question') {
        qId = (ev as any).payload.questionId;
        break;
      }
    }
    assert.ok(qId);
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(adapter.client?.ready);

    await adapter.resolveQuestion(session.id, qId, 'Alpha');
    await drain(handle);

    await new Promise((r) => setTimeout(r, 60));
    assert.equal(adapter.client, null);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('listModels merges acp modelState when ready and protects non-Grok models offline', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-models-parity-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const { bin } = await writeFakeGrok(base);
    adapter = new GrokProviderAdapter({ grokBin: bin });

    // 1. Offline fallback: inner.listModels returns a Grok model and a non-Grok model (gemini-3.8-flash)
    (adapter as any).inner.listModels = async () => ({
      defaultModel: 'grok-4.5',
      models: ['grok-4.5', 'gemini-3.8-flash'],
    });

    const offlineModels = await adapter.listModels();
    const grokModel = offlineModels.find((m) => m.model === 'grok-4.5');
    const geminiModel = offlineModels.find((m) => m.model === 'gemini-3.8-flash');

    assert.ok(grokModel);
    assert.deepEqual(grokModel.capabilities, ['thinking']);
    assert.equal(grokModel.default_effort, 'high');
    assert.deepEqual(grokModel.support_efforts, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

    assert.ok(geminiModel);
    assert.deepEqual(geminiModel.capabilities, []);
    assert.equal(geminiModel.default_effort, undefined);
    assert.equal(geminiModel.support_efforts, undefined);

    // 2. ACP client ready: merges modelState with reasoningEfforts & custom totalContextTokens
    const fakeClient = {
      ready: true,
      modelState: {
        currentModelId: 'gemini-3.8-flash',
        availableModels: [
          {
            modelId: 'gemini-3.8-flash',
            name: 'Gemini 3.8 Flash',
            description: 'Fast multimodal model',
            totalContextTokens: 1_048_576,
            supportsReasoningEffort: true,
            reasoningEffort: 'low',
            reasoningEfforts: [{ id: '1', value: 'low' }, { id: '2', value: 'high' }],
          },
        ],
      },
    };
    (adapter as any).acpClients.set(false, fakeClient);

    const mergedModels = await adapter.listModels();
    const mergedGemini = mergedModels.find((m) => m.model === 'gemini-3.8-flash');
    assert.ok(mergedGemini);
    assert.equal(mergedGemini.display_name, 'Gemini 3.8 Flash');
    assert.equal(mergedGemini.description, 'Fast multimodal model');
    assert.equal(mergedGemini.max_context_size, 1_048_576);
    assert.deepEqual(mergedGemini.capabilities, ['thinking']);
    assert.deepEqual(mergedGemini.support_efforts, ['low', 'high']);
    assert.equal(mergedGemini.default_effort, 'low');

    // 3. ACP client reports supportsReasoningEffort: false
    fakeClient.modelState.availableModels[0]!.supportsReasoningEffort = false;
    const noEffortModels = await adapter.listModels();
    const noEffortGemini = noEffortModels.find((m) => m.model === 'gemini-3.8-flash');
    assert.ok(noEffortGemini);
    assert.deepEqual(noEffortGemini.capabilities, []);
    assert.equal(noEffortGemini.support_efforts, undefined);
    assert.equal(noEffortGemini.default_effort, undefined);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('auto permission mode forwards autoMode: true to ACP session/new', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-auto-'));
  const rpcLog = join(base, 'rpc.log');
  let adapter: GrokProviderAdapter | undefined;
  try {
    const { bin } = await writeFakeGrok(base);
    adapter = new GrokProviderAdapter({
      grokBin: bin,
      env: { GROK_FAKE_ACP: '1', GROK_RPC_LOG: rpcLog },
    });
    const session = await adapter.create({ provider: 'grok', cwd: base });
    await adapter.setPermission(session.id, 'auto');
    assert.equal(adapter.getPermission(session.id), 'auto');
    const handle = await adapter.startTurn({ sessionId: session.id, input: 'hello' });
    await drain(handle);

    const logContent = await readFile(rpcLog, 'utf8');
    const calls = logContent.trim().split('\n').map((l) => JSON.parse(l));
    const sessionNewCall = calls.find((c) => c.method === 'session/new');
    assert.ok(sessionNewCall);
    assert.equal(sessionNewCall.params?._meta?.autoMode, true);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('setThinking normalizes on to high and auto to undefined/deleted', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-thinking-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const { bin } = await writeFakeGrok(base);
    adapter = new GrokProviderAdapter({ grokBin: bin });
    const session = await adapter.create({ provider: 'grok', cwd: base });

    await adapter.setThinking(session.id, 'on');
    assert.equal(adapter.getThinking(session.id), 'high');
    assert.equal(grokEffort(adapter.getThinking(session.id)), 'high');

    await adapter.setThinking(session.id, 'auto');
    assert.equal(adapter.getThinking(session.id), undefined);
    assert.equal(grokEffort(adapter.getThinking(session.id)), undefined);

    await adapter.setThinking('__default__', 'on');
    assert.equal(adapter.getThinking(session.id), 'high');

    await adapter.setThinking('__default__', 'auto');
    assert.equal(adapter.getThinking(session.id), undefined);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('tool_call_update emits status: delta on in_progress and terminal on completed/failed', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-tool-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const { bin } = await writeFakeGrok(base);
    adapter = new GrokProviderAdapter({ grokBin: bin });
    const sessionId = 'test-session';
    const turnId = 'test-turn';
    const events: any[] = [];
    const stream = {
      push: (ev: any) => events.push(ev),
    };

    // in_progress should emit status: 'delta'
    (adapter as any).mapAcpEvent(sessionId, turnId, stream, {
      type: 'tool_call_update',
      sessionId,
      toolCallId: 'call-1',
      title: 'Bash',
      status: 'in_progress',
      rawOutput: 'running command...',
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'tool');
    assert.equal(events[0].status, 'delta');
    assert.equal(events[0].payload.is_error, false);

    // pending should emit status: 'delta'
    (adapter as any).mapAcpEvent(sessionId, turnId, stream, {
      type: 'tool_call_update',
      sessionId,
      toolCallId: 'call-1',
      title: 'Bash',
      status: 'pending',
      rawOutput: '',
    });
    assert.equal(events.length, 2);
    assert.equal(events[1].status, 'delta');

    // completed should emit status: 'completed'
    (adapter as any).mapAcpEvent(sessionId, turnId, stream, {
      type: 'tool_call_update',
      sessionId,
      toolCallId: 'call-1',
      title: 'Bash',
      status: 'completed',
      rawOutput: 'done',
    });
    assert.equal(events.length, 3);
    assert.equal(events[2].status, 'completed');
    assert.equal(events[2].payload.is_error, false);

    // failed should emit status: 'failed'
    (adapter as any).mapAcpEvent(sessionId, turnId, stream, {
      type: 'tool_call_update',
      sessionId,
      toolCallId: 'call-1',
      title: 'Bash',
      status: 'failed',
      rawOutput: 'command failed',
    });
    assert.equal(events.length, 4);
    assert.equal(events[3].status, 'failed');
    assert.equal(events[3].payload.is_error, true);

    // missing rawOutput must NOT serialize as '""'
    (adapter as any).mapAcpEvent(sessionId, turnId, stream, {
      type: 'tool_call_update',
      sessionId,
      toolCallId: 'call-1',
      title: 'Bash',
      status: 'in_progress',
    });
    assert.equal(events.length, 5);
    assert.equal(events[4].payload.output, undefined);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('non-grok ACP model with empty reasoningEfforts does not inherit GROK_EFFORTS and setThinking auto resets live reasoning_effort', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-efforts-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const { bin } = await writeFakeGrok(base);
    adapter = new GrokProviderAdapter({ grokBin: bin });

    const setConfigCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
    const fakeClient = {
      ready: true,
      alwaysApproveEnabled: false,
      modelState: {
        currentModelId: 'grok-4.6',
        availableModels: [
          {
            modelId: 'grok-4.6',
            supportsReasoningEffort: true,
            reasoningEffort: 'high',
            reasoningEfforts: [{ id: 'low', value: 'low' }, { id: 'high', value: 'high', default: true }],
          },
          {
            modelId: 'gemini-3.8-flash',
            supportsReasoningEffort: true,
            reasoningEfforts: [],
          },
        ],
      },
      getConfigOptions: () => [{ id: 'reasoning_effort', currentValue: 'low' }],
      sessionSetModel: async () => undefined,
      sessionSetConfigOption: async (sessionId: string, configId: string, value: string) => {
        setConfigCalls.push({ sessionId, configId, value });
        return [];
      },
    };
    (adapter as any).acpClients.set(false, fakeClient);
    (adapter as any).sessionClient.set('sess-1', fakeClient);
    (adapter as any).acpSessionIds.set('sess-1', 'acp-1');
    await adapter.setModel('sess-1', 'grok-4.6');

    const models = await adapter.listModels();
    const geminiFromFallback = models.find((m) => m.model === 'gemini-3.8-flash');
    // Fake models CLI only returns grok-4.5/4.6/grok; force catch branch for gemini-3.8-flash
    (adapter as any).inner.listModels = async () => { throw new Error('offline'); };
    const acpOnlyModels = await adapter.listModels();
    const geminiModel = acpOnlyModels.find((m) => m.model === 'gemini-3.8-flash');
    assert.ok(geminiModel);
    assert.equal(geminiModel.support_efforts, undefined);
    assert.equal(geminiModel.default_effort, undefined);
    assert.equal(geminiFromFallback?.support_efforts, undefined);

    await adapter.setThinking('sess-1', 'low');
    await adapter.setThinking('sess-1', 'auto');
    assert.deepEqual(setConfigCalls, [
      { sessionId: 'acp-1', configId: 'reasoning_effort', value: 'low' },
      { sessionId: 'acp-1', configId: 'reasoning_effort', value: 'high' },
    ]);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('recycleIfIdle recycles both standard client and alwaysApproveClient', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-recycle-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const { bin } = await writeFakeGrok(base);
    adapter = new GrokProviderAdapter({
      grokBin: bin,
      env: { GROK_FAKE_ACP: '1' },
      recycleGraceMs: 0,
    });
    const client1 = await (adapter as any).ensureAcp(false);
    const client2 = await (adapter as any).ensureAcp(true);
    assert.ok(client1);
    assert.ok(client2);
    assert.equal(adapter.client, client1);
    assert.equal(adapter.alwaysApproveClient, client2);

    await adapter.recycleIfIdle();

    assert.equal(adapter.client, null);
    assert.equal(adapter.alwaysApproveClient, null);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('bounds skillCache and commandsCache and clears state on close, delete, and dispose', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-bounds-'));
  let adapter: GrokProviderAdapter | undefined;
  try {
    const { bin } = await writeFakeGrok(base);
    adapter = new GrokProviderAdapter({ grokBin: bin });

    // Test commandsCache bounding
    for (let i = 0; i < 70; i++) {
      (adapter as any).setCommandsCache(`key-${i}`, [{ name: `cmd-${i}` }]);
    }
    assert.ok((adapter as any).commandsCache.size <= 64);

    // Test skillCache bounding
    for (let i = 0; i < 70; i++) {
      (adapter as any).setSkillCache(`dir-${i}`, [{ name: `skill-${i}`, description: 'd' }]);
    }
    assert.ok((adapter as any).skillCache.size <= 64);

    // Set per-session state
    const sId = 'sess-123';
    (adapter as any).sessionCwd.set(sId, '/tmp');
    (adapter as any).acpSessionIds.set(sId, 'acp-123');
    (adapter as any).sessionUsage.set(sId, { input_tokens: 10, output_tokens: 20 });
    (adapter as any).renames.set(sId, 'Renamed');
    (adapter as any).commandsCache.set(sId, [{ name: 'test' }]);

    // Close session should clear per-session state
    await adapter.close(sId);
    assert.equal((adapter as any).sessionCwd.has(sId), false);
    assert.equal((adapter as any).acpSessionIds.has(sId), false);
    assert.equal((adapter as any).sessionUsage.has(sId), false);
    assert.equal((adapter as any).renames.has(sId), false);
    assert.equal((adapter as any).commandsCache.has(sId), false);

    // Dispose should clear all caches
    await adapter.dispose();
    assert.equal((adapter as any).commandsCache.size, 0);
    assert.equal((adapter as any).skillCache.size, 0);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('discoverGrokDiskSkills adheres to maxEntries bound', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-disk-'));
  try {
    const skillsDir = join(base, '.grok', 'skills');
    await mkdir(skillsDir, { recursive: true });
    for (let i = 0; i < 20; i++) {
      await writeFile(join(skillsDir, `skill-${i}.md`), `# Skill ${i}\nDescription`);
    }
    const skills = await discoverGrokDiskSkills(base, { maxEntries: 5 });
    assert.ok(skills.length <= 5);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('GrokProviderAdapter hides zero-turn seed-only (session) directories and extracts firstPrompt title when summary is empty', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-empty-filter-'));
  const sessionsDir = join(base, 'sessions');
  const cwdKey = encodeURIComponent('/tmp/grok-proj');
  let adapter: GrokProviderAdapter | undefined;
  try {
    const { bin } = await writeFakeGrok(base);

    // 1. Seed-only 0-message session with "(session)" placeholder -> must be filtered out
    const emptyId = '11111111-1111-4111-8111-111111111111';
    const emptyDir = join(sessionsDir, cwdKey, emptyId);
    await mkdir(emptyDir, { recursive: true });
    await writeFile(
      join(emptyDir, 'summary.json'),
      JSON.stringify({
        info: { id: emptyId, cwd: '/tmp/grok-proj' },
        num_messages: 0,
        session_summary: '(session)',
        updated_at: '2026-11-15T10:00:00.000Z',
      }),
    );
    await writeFile(
      join(emptyDir, 'chat_history.jsonl'),
      `${JSON.stringify({ type: 'user', content: '<system-reminder>workflow seed</system-reminder>' })}\n`,
    );

    // 2. Real conversation session with empty summary -> must be shown with first user prompt title
    const realId = '22222222-2222-4222-8222-222222222222';
    const realDir = join(sessionsDir, cwdKey, realId);
    await mkdir(realDir, { recursive: true });
    await writeFile(
      join(realDir, 'summary.json'),
      JSON.stringify({
        info: { id: realId, cwd: '/tmp/grok-proj' },
        num_messages: 2,
        session_summary: '',
        updated_at: '2026-11-15T10:01:00.000Z',
      }),
    );
    await writeFile(
      join(realDir, 'chat_history.jsonl'),
      [
        JSON.stringify({ type: 'user', content: '<system-reminder>seed</system-reminder>' }),
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\n\n</user_query>' }] }),
        JSON.stringify({ type: 'user', content: '<user_query>\nExplain Grok session filtering\n</user_query>' }),
        JSON.stringify({ type: 'assistant', content: 'Sure!' }),
      ].join('\n') + '\n',
    );

    adapter = new GrokProviderAdapter({ grokBin: bin, sessionsDir });
    const page = await adapter.list();
    assert.deepEqual(page.items.map((s) => s.id), [realId]);
    assert.equal(page.items[0]?.title, 'Explain Grok session filtering');
    assert.equal(page.items[0]?.extras?.last_prompt, 'Explain Grok session filtering');

    // Empty session remains visible only while actively running a turn
    (adapter as any).acpTurns.set(emptyId, {});
    const livePage = await adapter.list();
    assert.deepEqual(livePage.items.map((s) => s.id), [realId, emptyId]);
    assert.notEqual(livePage.items[1]?.title, '(session)');
    assert.equal(livePage.items[1]?.extras?.last_prompt, '');
    (adapter as any).acpTurns.delete(emptyId);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});






test('review regression: tool snapshot replacements flag outputMode replace', async () => {
  const base = await mkdtemp(join(tmpdir(), 'grok-review-snapshot-'));
  const adapter = new GrokProviderAdapter({ grokBin: join(base, 'grok'), sessionsDir: base });
  try {
    const events: any[] = [];
    const stream = { push: (event: any) => events.push(event) };
    for (const rawOutput of ['abc', 'abcdef', 'xyz']) {
      (adapter as any).mapAcpEvent('session', 'turn', stream, {
        type: 'tool_call_update', sessionId: 'session', toolCallId: 'tool', status: 'in_progress', rawOutput,
      });
    }
    assert.equal(events[0].payload.output, 'abc');
    assert.equal(events[0].payload.outputMode, 'replace');
    assert.equal(events[1].payload.output, 'def');
    assert.equal(events[1].payload.outputMode, undefined);
    assert.equal(events[2].payload.output, 'xyz');
    assert.equal(events[2].payload.outputMode, 'replace');
  } finally {
    await adapter.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: terminal tool update retains omitted output', async () => {
  const base = await mkdtemp(join(tmpdir(), 'grok-review-terminal-'));
  const adapter = new GrokProviderAdapter({ grokBin: join(base, 'grok'), sessionsDir: base });
  try {
    const events: any[] = [];
    const stream = { push: (event: any) => events.push(event) };
    (adapter as any).mapAcpEvent('session', 'turn', stream, {
      type: 'tool_call_update', sessionId: 'session', toolCallId: 'tool', status: 'in_progress', rawOutput: 'partial output',
    });
    (adapter as any).mapAcpEvent('session', 'turn', stream, {
      type: 'tool_call_update', sessionId: 'session', toolCallId: 'tool', status: 'completed',
    });
    assert.equal(events[1].status, 'completed');
    assert.equal(events[1].payload.output, 'partial output');
  } finally {
    await adapter.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

for (const outcome of ['cancelled', 'error'] as const) {
  test(`review regression: ${outcome} turn clears only its tool snapshots`, async () => {
    const base = await mkdtemp(join(tmpdir(), 'grok-review-cleanup-'));
    const adapter = new GrokProviderAdapter({ grokBin: join(base, 'grok'), sessionsDir: base });
    try {
      let listener: (event: unknown) => void = () => undefined;
      const client = {
        onEvent: (handler: (event: unknown) => void) => { listener = handler; return () => undefined; },
        sessionNew: async () => ({ sessionId: 'session' }),
        sessionSetMode: async () => undefined,
        getConfigOptions: () => undefined,
        sessionPrompt: async () => {
          listener({ type: 'tool_call_update', sessionId: 'session', toolCallId: 'tool', status: 'in_progress', rawOutput: 'unfinished' });
          if (outcome === 'error') throw new Error('disconnected');
          return { stopReason: 'cancelled' };
        },
        cancelSessionPending: () => undefined,
      };
      const snapshots = (adapter as any).toolOutputSnapshots as Map<string, string>;
      snapshots.set('other:tool', 'other output');
      const run = (adapter as any).runAcpTurn(client, {
        sessionId: 'session', turnId: 'turn', prompt: 'test', cwd: base, isNew: true,
        plan: false, yolo: false, stream: { push: () => undefined, end: () => undefined }, emit: () => undefined,
      });
      if (outcome === 'error') await assert.rejects(run, /disconnected/);
      else await run;
      assert.equal(snapshots.has('session:tool'), false);
      assert.equal(snapshots.get('other:tool'), 'other output');
    } finally {
      await adapter.dispose();
      await rm(base, { recursive: true, force: true });
    }
  });
}

test('review regression: reject selects reject_once ahead of reject_always', async () => {
  const base = await mkdtemp(join(tmpdir(), 'grok-review-reject-'));
  const adapter = new GrokProviderAdapter({ grokBin: join(base, 'grok'), sessionsDir: base });
  try {
    let selected: string | undefined;
    const client = {
      ready: true,
      getPendingPermission: () => ({ id: 42, sessionId: 'session', options: [
        { optionId: 'persistent', kind: 'reject_always' },
        { optionId: 'one-time', kind: 'reject_once' },
      ] }),
      resolvePermission: (_id: number, optionId: string) => { selected = optionId; },
      close: async () => undefined,
    };
    (adapter as any).acpClients.set(false, client);
    await adapter.resolveApproval('session', '42', 'reject');
    assert.equal(selected, 'one-time');
  } finally {
    await adapter.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: initial catalog includes CLI-only and ACP-only models', async () => {
  const base = await mkdtemp(join(tmpdir(), 'grok-review-model-union-'));
  const adapter = new GrokProviderAdapter({ grokBin: join(base, 'grok'), sessionsDir: base });
  try {
    const client = {
      ready: true,
      modelState: { currentModelId: 'acp-model', availableModels: [{ modelId: 'acp-model', supportsReasoningEffort: false }] },
      close: async () => undefined,
    };
    (adapter as any).acpClients.set(false, client);
    (adapter as any).inner.listModels = async () => ({ defaultModel: 'cli-model', models: ['cli-model'] });
    const models = await adapter.listModels();
    assert.ok(models.some((model) => model.model === 'cli-model'));
    const acpModel = models.find((model) => model.model === 'acp-model');
    assert.ok(acpModel);
    assert.equal(acpModel.support_efforts, undefined);
  } finally {
    await adapter.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: expired CLI model cache is refreshed alongside live ACP models', async () => {
  const base = await mkdtemp(join(tmpdir(), 'grok-review-model-expiry-'));
  const adapter = new GrokProviderAdapter({ grokBin: join(base, 'grok'), sessionsDir: base });
  try {
    const client = {
      ready: true,
      modelState: { currentModelId: 'acp-model', availableModels: [{ modelId: 'acp-model' }] },
      close: async () => undefined,
    };
    (adapter as any).acpClients.set(false, client);
    const old = { defaultModel: 'old-model', models: ['old-model'] };
    (adapter as any).lastCliModels = old;
    (adapter as any).inner.modelsCache = { ts: Date.now() - 10 * 60_000, value: old };
    let calls = 0;
    (adapter as any).inner.listModels = async () => {
      calls++;
      return { defaultModel: 'new-model', models: ['new-model'] };
    };
    const models = await adapter.listModels();
    assert.equal(calls, 1);
    assert.ok(models.some((model) => model.model === 'new-model'));
    assert.ok(models.some((model) => model.model === 'acp-model'));
    assert.equal(models.some((model) => model.model === 'old-model'), false);
  } finally {
    await adapter.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: group escalation delivers SIGKILL when group survives leader exit', async () => {
  const adapter = new GrokProviderAdapter();
  try {
    const killedSignals: string[] = [];
    let groupAlive = true;
    const fakeChild: any = {
      pid: 99999,
      exitCode: null,
      signalCode: null,
      kill: (sig: string) => { killedSignals.push(sig); },
      once: () => undefined,
      stdin: { destroyed: false, write: () => true },
    };
    const origKill = process.kill;
    (process as any).kill = (pid: number, signal?: string | number) => {
      if (pid === -99999) {
        if (signal === 0) {
          if (!groupAlive) throw new Error('ESRCH');
          return true;
        }
        killedSignals.push(String(signal));
        return true;
      }
      return (origKill as any).call(process, pid, signal);
    };
    try {
      const client = new GrokAcpClient({ grokBin: 'grok' });
      (client as any).child = fakeChild;
      (client as any).connected = true;

      const closePromise = client.close();
      // Simulate leader exiting after SIGTERM while background descendants stay alive.
      fakeChild.exitCode = 0;
      await new Promise((resolve) => setTimeout(resolve, 3100));
      assert.ok(killedSignals.includes('SIGKILL'), `expected SIGKILL escalation, got: ${JSON.stringify(killedSignals)}`);
      // Simulate group finally dying on SIGKILL so close cleans up without hanging.
      groupAlive = false;
      await closePromise;
    } finally {
      process.kill = origKill;
    }
  } finally {
    await adapter.dispose();
  }
});

test('review regression: compacted session merges pre-compaction updates and unique post-compaction chat tail', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-compact-merge-'));
  const sessionsDir = join(base, 'sessions');
  const sessionId = '01a1de65-a11b-7d81-b7d0-9a3f7eb03d8b';
  try {
    const encoded = encodeURIComponent('/work');
    const dir = join(sessionsDir, encoded, sessionId);
    await mkdir(dir, { recursive: true });
    // chat_history.jsonl has post-compaction Turn 1 and a new Turn 2 tail unique to chat
    await writeFile(join(dir, 'chat_history.jsonl'), [
      JSON.stringify({ type: 'system', content: 'You are Grok' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_info>rules</user_info>' }], synthetic_reason: 'compaction_meta' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\nTurn 1 prompt\n</user_query>' }] }),
      JSON.stringify({ type: 'assistant', content: 'Turn 1 reply' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\nTurn 2 unique tail prompt\n</user_query>' }] }),
      JSON.stringify({ type: 'assistant', content: 'Turn 2 unique tail reply' }),
    ].join('\n') + '\n');
    // updates.jsonl has pre-compaction Turn 0 and Turn 1
    await writeFile(join(dir, 'updates.jsonl'), [
      JSON.stringify({ timestamp: 1794732571, method: 'session/update', params: { sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Turn 0 prompt' } } } }),
      JSON.stringify({ timestamp: 1794732603, method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Turn 0 reply' } } } }),
      JSON.stringify({ timestamp: 1794732603, method: '_x.ai/session/update', params: { sessionId, update: { sessionUpdate: 'turn_completed' } } }),
      JSON.stringify({ timestamp: 1794732700, method: 'session/update', params: { sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Turn 1 prompt' } } } }),
      JSON.stringify({ timestamp: 1794732705, method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Turn 1 reply' } } } }),
      JSON.stringify({ timestamp: 1794732705, method: '_x.ai/session/update', params: { sessionId, update: { sessionUpdate: 'turn_completed' } } }),
      JSON.stringify({ timestamp: 1794732710, method: 'session/update', params: { sessionId, update: { sessionUpdate: 'auto_compact_completed' } } }),
    ].join('\n') + '\n');

    const adapter = new GrokProviderAdapter({ sessionsDir });
    const history = await adapter.getHistory(sessionId);
    const userPrompts = history.filter(m => m.role === 'user').map(m => m.content.map((c: any) => c.text).join(''));
    assert.ok(userPrompts.some(p => p.includes('Turn 0 prompt')), 'expected pre-compaction Turn 0 from updates');
    assert.ok(userPrompts.some(p => p.includes('Turn 1 prompt')), 'expected overlapping Turn 1');
    assert.ok(userPrompts.some(p => p.includes('Turn 2 unique tail prompt')), 'expected post-compaction unique Turn 2 tail from chat not to be dropped');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: historyFromUpdates aggregates tool_call_update by callId and retains latest output snapshot', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-tool-agg-'));
  const sessionsDir = join(base, 'sessions');
  const sessionId = '01a1de87-1f93-7b02-b088-72941185c930';
  try {
    const encoded = encodeURIComponent('/tmp/proj');
    const dir = join(sessionsDir, encoded, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'updates.jsonl'), [
      JSON.stringify({ timestamp: 1794734759, params: { sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'run tool' } } } }),
      JSON.stringify({ timestamp: 1794734760, params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call_agg_1', title: 'run_cmd', rawInput: { cmd: 'ls' } } } }),
      // in_progress update with output snapshot
      JSON.stringify({ timestamp: 1794734761, params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_agg_1', status: 'in_progress', rawOutput: 'snapshot stdout line 1\n' } } }),
      // completed update that omits output
      JSON.stringify({ timestamp: 1794734762, params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_agg_1', status: 'completed' } } }),
      JSON.stringify({ timestamp: 1794734763, params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } }),
    ].join('\n') + '\n');

    const adapter = new GrokProviderAdapter({ sessionsDir });
    const history = await adapter.getHistory(sessionId);
    const toolResults = history.filter(m => m.role === 'tool');
    assert.equal(toolResults.length, 1, `expected exactly 1 tool result message, got ${toolResults.length}`);
    const part = toolResults[0]?.content.find((p: any) => p.type === 'tool_result') as any;
    assert.ok(part, 'expected tool_result block');
    assert.equal(part.tool_call_id, 'call_agg_1');
    assert.equal(part.output, 'snapshot stdout line 1\n', 'expected latest snapshot output to be retained');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: session timestamps match in sequence across chunks and maintain monotonic order', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-mono-ts-'));
  const sessionsDir = join(base, 'sessions');
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const t0 = 1794732571000; // 2026-11-15T08:49:31.000Z
  const t1 = 1794732573000;
  const t2 = 1794732576000;
  const t3 = 1794732600000;
  const t4 = 1794732602000;
  const t5 = 1794732606000;
  try {
    const encoded = encodeURIComponent('/tmp/proj');
    const dir = join(sessionsDir, encoded, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'summary.json'), JSON.stringify({
      info: { id: sessionId, cwd: '/tmp/proj' },
      created_at: new Date(t0).toISOString(),
      updated_at: new Date(t5).toISOString(),
    }));
    await writeFile(join(dir, 'chat_history.jsonl'), [
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'turn 0 question' }] }),
      JSON.stringify({ type: 'assistant', content: 'turn 0 answer chunk A chunk B' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'turn 1 question' }] }),
      JSON.stringify({ type: 'assistant', content: 'turn 1 answer chunk C chunk D' }),
    ].join('\n') + '\n');
    await writeFile(join(dir, 'updates.jsonl'), [
      JSON.stringify({ timestamp: Math.floor(t0/1000), params: { sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'turn 0 question' } }, _meta: { agentTimestampMs: t0 } } }),
      JSON.stringify({ timestamp: Math.floor(t1/1000), params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn 0 answer chunk A ' } }, _meta: { agentTimestampMs: t1 } } }),
      JSON.stringify({ timestamp: Math.floor(t2/1000), params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk B' } }, _meta: { agentTimestampMs: t2 } } }),
      JSON.stringify({ timestamp: Math.floor(t2/1000), params: { sessionId, update: { sessionUpdate: 'turn_completed' } } }),
      JSON.stringify({ timestamp: Math.floor(t3/1000), params: { sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'turn 1 question' } }, _meta: { agentTimestampMs: t3 } } }),
      JSON.stringify({ timestamp: Math.floor(t4/1000), params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn 1 answer chunk C ' } }, _meta: { agentTimestampMs: t4 } } }),
      JSON.stringify({ timestamp: Math.floor(t5/1000), params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk D' } }, _meta: { agentTimestampMs: t5 } } }),
      JSON.stringify({ timestamp: Math.floor(t5/1000), params: { sessionId, update: { sessionUpdate: 'turn_completed' } } }),
    ].join('\n') + '\n');

    const adapter = new GrokProviderAdapter({ sessionsDir });
    const history = await adapter.getHistory(sessionId);
    assert.equal(history.length, 4);
    assert.equal(history[0]?.created_at, new Date(t0).toISOString());
    assert.equal(history[1]?.created_at, new Date(t1).toISOString());
    assert.equal(history[2]?.created_at, new Date(t3).toISOString());
    assert.equal(history[3]?.created_at, new Date(t4).toISOString());
    for (let i = 1; i < history.length; i++) {
      assert.ok(Date.parse(history[i]?.created_at ?? '') >= Date.parse(history[i - 1]?.created_at ?? ''), 'timestamps must be monotonic');
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: message IDs remain stable across message appending and session compaction', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-stable-id-'));
  const sessionsDir = join(base, 'sessions');
  const sessionId = '44444444-4444-4444-8444-444444444444';
  try {
    const encoded = encodeURIComponent('/tmp/proj');
    const dir = join(sessionsDir, encoded, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'summary.json'), JSON.stringify({
      info: { id: sessionId, cwd: '/tmp/proj' },
      created_at: '2026-08-16T00:00:00.000Z',
      updated_at: '2026-08-16T01:00:00.000Z',
    }));
    await writeFile(join(dir, 'chat_history.jsonl'), [
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'first prompt' }] }),
      JSON.stringify({ type: 'assistant', content: 'first answer' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'second prompt' }] }),
      JSON.stringify({ type: 'assistant', content: 'second answer' }),
    ].join('\n') + '\n');

    const adapter = new GrokProviderAdapter({ sessionsDir });
    const initialHistory = await adapter.getHistory(sessionId);
    assert.equal(initialHistory.length, 4);
    const idSecondUser = initialHistory[2]?.id;
    const idSecondAsst = initialHistory[3]?.id;

    // Append a third turn
    await writeFile(join(dir, 'chat_history.jsonl'), [
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'first prompt' }] }),
      JSON.stringify({ type: 'assistant', content: 'first answer' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'second prompt' }] }),
      JSON.stringify({ type: 'assistant', content: 'second answer' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'third prompt' }] }),
      JSON.stringify({ type: 'assistant', content: 'third answer' }),
    ].join('\n') + '\n');

    const extendedHistory = await adapter.getHistory(sessionId);
    assert.equal(extendedHistory.length, 6);
    assert.equal(extendedHistory[2]?.id, idSecondUser, 'id of second user must be stable after append');
    assert.equal(extendedHistory[3]?.id, idSecondAsst, 'id of second asst must be stable after append');

    // Simulate compaction where chat_history.jsonl now only contains second turn onwards with compaction marker
    await writeFile(join(dir, 'chat_history.jsonl'), [
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'rules' }], synthetic_reason: 'compaction_meta' }),
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'second prompt' }] }),
      JSON.stringify({ type: 'assistant', content: 'second answer' }),
    ].join('\n') + '\n');

    const compactedHistory = await adapter.getHistory(sessionId);
    const compactedSecondUser = compactedHistory.find(m => m.role === 'user' && m.content.some((c: any) => c.text === 'second prompt'));
    const compactedSecondAsst = compactedHistory.find(m => m.role === 'assistant' && m.content.some((c: any) => c.text === 'second answer'));
    assert.ok(compactedSecondUser, 'expected second user message');
    assert.ok(compactedSecondAsst, 'expected second asst message');
    assert.equal(compactedSecondUser?.id, idSecondUser, 'id must not depend on array index changing from 2 to 0 after compaction');
    assert.equal(compactedSecondAsst?.id, idSecondAsst, 'id must not depend on array index changing after compaction');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: historyFromUpdates preserves explicit empty user turns', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-empty-up-'));
  const sessionsDir = join(base, 'sessions');
  const sessionId = '55555555-5555-4555-8555-555555555555';
  try {
    const encoded = encodeURIComponent('/tmp/proj');
    const dir = join(sessionsDir, encoded, sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'updates.jsonl'), [
      JSON.stringify({ timestamp: 1794734759, params: { sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '' } } } }),
      JSON.stringify({ timestamp: 1794734760, params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'How can I help you today?' } } } }),
      JSON.stringify({ timestamp: 1794734761, params: { sessionId, update: { sessionUpdate: 'turn_completed' } } }),
    ].join('\n') + '\n');

    const adapter = new GrokProviderAdapter({ sessionsDir });
    const history = await adapter.getHistory(sessionId);
    assert.equal(history.length, 2, `expected 2 messages, got ${history.length}`);
    assert.equal(history[0]?.role, 'user');
    assert.deepEqual(history[0]?.content, [{ type: 'text', text: '' }]);
    assert.equal(history[1]?.role, 'assistant');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});


function acpRow(sessionId: string, update: Record<string, unknown>, ms?: number): string {
  return JSON.stringify({
    method: 'session/update',
    params: { sessionId, update, ...(ms !== undefined ? { _meta: { agentTimestampMs: ms } } : {}) },
  });
}

test('review regression: compacted merge never pairs empty-text messages of different kinds', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-merge-empty-'));
  const sessionsDir = join(base, 'sessions');
  const sid = '66666666-6666-4666-8666-666666666666';
  const t0 = Date.parse('2026-08-16T06:21:00.000Z');
  try {
    await seedSession(sessionsDir, sid, {
      'chat_history.jsonl': [
        JSON.stringify({ type: 'user', synthetic_reason: 'compaction_meta', content: [{ type: 'text', text: 'This session is being continued from a previous conversation.' }] }),
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\nsecond\n</user_query>' }] }),
        JSON.stringify({ type: 'assistant', content: '', tool_calls: [{ id: 'call_b', name: 'run_cmd', arguments: '{"cmd":"ls"}' }] }),
        JSON.stringify({ type: 'tool_result', tool_call_id: 'call_b', content: 'out-b' }),
        JSON.stringify({ type: 'assistant', content: 'answer b' }),
      ].join('\n') + '\n',
      'updates.jsonl': [
        acpRow(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first' }, _meta: { promptIndex: 0 } }, t0),
        acpRow(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thought a' } }, t0 + 1000),
        acpRow(sid, { sessionUpdate: 'tool_call', toolCallId: 'call_a', title: 'run_cmd', rawInput: { cmd: 'pwd' } }, t0 + 2000),
        acpRow(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call_a', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'out-a' } }] }, t0 + 3000),
        acpRow(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer a' } }, t0 + 4000),
        acpRow(sid, { sessionUpdate: 'turn_completed' }, t0 + 4000),
        acpRow(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'second' }, _meta: { promptIndex: 1 } }, t0 + 10000),
        acpRow(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thought b' } }, t0 + 11000),
        acpRow(sid, { sessionUpdate: 'tool_call', toolCallId: 'call_b', title: 'run_cmd', rawInput: { cmd: 'ls' } }, t0 + 12000),
        acpRow(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call_b', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'out-b' } }] }, t0 + 13000),
        acpRow(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer b' } }, t0 + 14000),
        acpRow(sid, { sessionUpdate: 'turn_completed' }, t0 + 14000),
        acpRow(sid, { sessionUpdate: 'auto_compact_completed' }, t0 + 20000),
      ].join('\n') + '\n',
    });
    const history = await new GrokProviderAdapter({ sessionsDir }).getHistory(sid);
    const parts = history.flatMap((m) => m.content);
    assert.deepEqual(parts.filter((p) => p.type === 'tool_use').map((p: any) => p.tool_call_id), ['call_a', 'call_b']);
    assert.deepEqual(parts.filter((p) => p.type === 'tool_result').map((p: any) => p.tool_call_id), ['call_a', 'call_b']);
    assert.deepEqual(parts.filter((p) => p.type === 'thinking').map((p: any) => p.thinking), ['thought a', 'thought b']);
    assert.deepEqual(
      history.filter((m) => m.role === 'user').map((m) => m.content.map((p: any) => p.text).join('')),
      ['first', 'second'],
    );
    assert.equal(new Set(history.map((m) => m.id)).size, history.length, 'message ids must be unique');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: messages missing from updates get interpolated, strictly increasing timestamps', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-ts-interp-'));
  const sessionsDir = join(base, 'sessions');
  const sid = '88888888-8888-4888-8888-888888888888';
  const createdMs = Date.parse('2026-08-16T06:20:33.000Z');
  const t1 = createdMs + 1000;
  const t2 = createdMs + 2000;
  const updatedMs = createdMs + 62_000;
  try {
    const dir = await seedSession(sessionsDir, sid, {
      'chat_history.jsonl': [
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'q1' }] }),
        JSON.stringify({ type: 'assistant', content: 'a1' }),
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'q2' }] }),
        JSON.stringify({ type: 'assistant', content: 'a2' }),
      ].join('\n') + '\n',
      'updates.jsonl': [
        acpRow(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q1' } }, t1),
        acpRow(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a1' } }, t2),
        acpRow(sid, { sessionUpdate: 'turn_completed' }, t2),
      ].join('\n') + '\n',
    });
    await writeFile(join(dir, 'summary.json'), JSON.stringify({
      info: { id: sid, cwd: '/tmp/work' },
      created_at: new Date(createdMs).toISOString(),
      updated_at: new Date(updatedMs).toISOString(),
    }));
    const history = await new GrokProviderAdapter({ sessionsDir }).getHistory(sid);
    const ms = history.map((m) => Date.parse(m.created_at));
    assert.equal(ms[0], t1);
    assert.equal(ms[1], t2);
    assert.ok(ms[2]! > ms[1]!, `q2 must be later than a1: ${ms.join(',')}`);
    assert.ok(ms[3]! > ms[2]!, `a2 must be later than q2: ${ms.join(',')}`);
    assert.ok(ms[3]! <= updatedMs, 'interpolated timestamps stay inside the session window');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: a replayed identical user chunk for the same promptIndex is not appended twice', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-user-replay-'));
  const sessionsDir = join(base, 'sessions');
  const sid = '99999999-9999-4999-8999-999999999999';
  try {
    await seedSession(sessionsDir, sid, {
      'updates.jsonl': [
        acpRow(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '你是什么模型 你有什么工具' }, _meta: { promptIndex: 0 } }, 1794732571919),
        acpRow(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '你是什么模型 你有什么工具' }, _meta: { promptIndex: 0 } }, 1794732584774),
        acpRow(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '我是 Grok' } }, 1794732603000),
        acpRow(sid, { sessionUpdate: 'turn_completed' }, 1794732603000),
        acpRow(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'ab' }, _meta: { promptIndex: 1 } }, 1794732700000),
        acpRow(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'cd' }, _meta: { promptIndex: 1 } }, 1794732700100),
        acpRow(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }, 1794732710000),
        acpRow(sid, { sessionUpdate: 'turn_completed' }, 1794732710000),
      ].join('\n') + '\n',
    });
    const history = await new GrokProviderAdapter({ sessionsDir }).getHistory(sid);
    const users = history.filter((m) => m.role === 'user').map((m) => m.content.map((p: any) => p.text).join(''));
    assert.deepEqual(users, ['你是什么模型 你有什么工具', 'abcd']);
    assert.equal(Date.parse(history[0]!.created_at), 1794732571919, 'the first chunk timestamp wins');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: rollback counts distinct prompt indexes, not replayed user chunks', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-rollback-replay-'));
  const sessionsDir = join(base, 'sessions');
  const sid = '77777777-7777-4777-8777-777777777777';
  try {
    await seedSession(sessionsDir, sid, {
      'chat_history.jsonl': [
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\np0\n</user_query>' }] }),
        JSON.stringify({ type: 'assistant', content: 'r0' }),
        JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\np1\n</user_query>' }] }),
        JSON.stringify({ type: 'assistant', content: 'r1' }),
      ].join('\n') + '\n',
      'updates.jsonl': [
        acpRow(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'p0' }, _meta: { promptIndex: 0 } }),
        acpRow(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'p0' }, _meta: { promptIndex: 0 } }),
        acpRow(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'r0' } }),
        acpRow(sid, { sessionUpdate: 'turn_completed' }),
        acpRow(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'p1' }, _meta: { promptIndex: 1 } }),
        acpRow(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'r1' } }),
        acpRow(sid, { sessionUpdate: 'turn_completed' }),
      ].join('\n') + '\n',
      'rewind_points.jsonl': JSON.stringify({ prompt_index: 0 }) + '\n' + JSON.stringify({ prompt_index: 1 }) + '\n',
    });
    const adapter = new GrokProviderAdapter({ sessionsDir });
    await adapter.rollback(sid, 1);
    const marker = (await readFile(join(sessionsDir, encodeURIComponent('/tmp/work'), sid, 'updates.jsonl'), 'utf8'))
      .trim().split('\n').pop() ?? '';
    assert.equal(JSON.parse(marker).params.update.target_prompt_index, 1);
    const after = await adapter.getHistory(sid);
    assert.deepEqual(after.flatMap((m) => m.content).map((p: any) => p.text), ['p0', 'r0']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: duplicate prompt texts keep their ids when compaction drops the head of chat_history', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-grok-dup-id-'));
  const sessionsDir = join(base, 'sessions');
  const sid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  try {
    const turn = (n: number) => [
      acpRow(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'ok' }, _meta: { promptIndex: n } }, 1794732000000 + n * 10_000),
      acpRow(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }, 1794732001000 + n * 10_000),
      acpRow(sid, { sessionUpdate: 'turn_completed' }, 1794732001000 + n * 10_000),
    ];
    const userQuery = JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\nok\n</user_query>' }] });
    const reply = JSON.stringify({ type: 'assistant', content: 'done' });
    const dir = await seedSession(sessionsDir, sid, {
      'chat_history.jsonl': [userQuery, reply, userQuery, reply, userQuery, reply].join('\n') + '\n',
      'updates.jsonl': [...turn(0), ...turn(1), ...turn(2)].join('\n') + '\n',
    });
    const adapter = new GrokProviderAdapter({ sessionsDir });
    const before = (await adapter.getHistory(sid)).map((m) => m.id);
    assert.equal(before.length, 6);
    assert.equal(new Set(before).size, 6);

    await writeFile(join(dir, 'chat_history.jsonl'), [
      JSON.stringify({ type: 'user', synthetic_reason: 'compaction_meta', content: [{ type: 'text', text: 'summary' }] }),
      userQuery,
      reply,
    ].join('\n') + '\n');
    await writeFile(join(dir, 'updates.jsonl'), [
      ...turn(0), ...turn(1), ...turn(2),
      acpRow(sid, { sessionUpdate: 'auto_compact_completed' }, 1794732100000),
    ].join('\n') + '\n');
    const after = (await adapter.getHistory(sid)).map((m) => m.id);
    assert.deepEqual(after, before);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('grok acp: x.ai/exit_plan_mode parks as a question and answers with native verdicts', () => {
  const client = new GrokAcpClient({ grokBin: '/nonexistent/grok' });
  const sent: Array<{ id: unknown; result: unknown }> = [];
  (client as any).respond = (id: unknown, result: unknown) => sent.push({ id, result });
  const events: any[] = [];
  client.onEvent((ev) => events.push(ev));

  (client as any).handleServerRequest(7, '_x.ai/exit_plan_mode', {
    sessionId: 's1',
    toolCallId: 'call-plan-1',
    planContent: '1. edit a.ts\n2. run tests',
  });
  const q = events.find((e) => e.type === 'question_request');
  assert.ok(q, 'exit_plan_mode must surface as a question');
  assert.equal(q.questionId, 'call-plan-1');
  assert.ok(q.prompt.includes('1. edit a.ts'));
  assert.deepEqual(q.questions[0].options.map((o: any) => o.id), ['approved', 'cancelled', 'abandoned']);

  assert.equal(client.resolveQuestion('call-plan-1', { exit_plan_mode: ['approved'] }), true);
  assert.deepEqual(sent.at(-1), { id: 7, result: { outcome: 'approved' } });

  (client as any).handleServerRequest(8, 'x.ai/exit_plan_mode', { sessionId: 's1', planContent: null });
  assert.equal(client.resolveQuestion('8', '放弃计划'), true);
  assert.deepEqual(sent.at(-1), { id: 8, result: { outcome: 'abandoned' } });

  (client as any).handleServerRequest(9, 'x.ai/exit_plan_mode', { sessionId: 's1' });
  assert.equal(client.cancelQuestion('9'), true);
  assert.deepEqual(sent.at(-1), { id: 9, result: { outcome: 'cancelled' } });
});

test('grok acp: ask_user_question answers are keyed by question text only (StringOrVec)', () => {
  const client = new GrokAcpClient({ grokBin: '/nonexistent/grok' });
  const sent: Array<{ id: unknown; result: any }> = [];
  (client as any).respond = (id: unknown, result: unknown) => sent.push({ id, result });
  (client as any).handleServerRequest('r1', '_x.ai/ask_user_question', {
    sessionId: 's1',
    toolCallId: 'call-q',
    questions: [
      { question: 'Colour?', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false },
      { question: 'Extras?', options: [{ label: 'Logo' }, { label: 'Icon' }], multiSelect: true },
    ],
  });
  assert.equal(client.resolveQuestion('call-q', { q_0: ['Red'], q_1: ['Logo', 'Icon'] }), true);
  assert.deepEqual(sent.at(-1)?.result, {
    outcome: 'accepted',
    answers: { 'Colour?': 'Red', 'Extras?': ['Logo', 'Icon'] },
    annotations: {},
  });
});
