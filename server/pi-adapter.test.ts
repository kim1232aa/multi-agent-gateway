import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  JsonlLineFramer,
  PiAdapter,
  PiProviderAdapter,
  PiRpcClient,
  StdinLineWriter,
  buildPiChildEnv,
  decodePiModelId,
  encodePiCwdDir,
  encodePiModelId,
  mapPiStatsToUsage,
  piModelSupportedThinkingLevels,
  readPiActiveBranchHistory,
  resolvePiBin,
} from './pi-adapter.js';
import { ProviderError, type GatewayEvent } from './types.js';

const REAL_PI_BIN = '/home/pi/.local/bin/pi';

async function drainEvents(handle: { events: AsyncIterable<GatewayEvent> }): Promise<GatewayEvent[]> {
  const out: GatewayEvent[] = [];
  for await (const ev of handle.events) {
    out.push(ev);
  }
  return out;
}

async function writeFakePiScript(dir: string, body: string, name = 'pi'): Promise<string> {
  const bin = join(dir, name);
  await writeFile(bin, body, 'utf8');
  await chmod(bin, 0o755);
  return bin;
}

/**
 * Create a general-purpose fake `pi --mode rpc` Python script driven by `FAKE_PI_MODE`
 * and optional log files for argv, env, stdin commands, and spawn counts.
 */
async function writeContractFakePi(dir: string): Promise<{
  bin: string;
  argvLog: string;
  envLog: string;
  stdinLog: string;
  uiRespLog: string;
  spawnCountLog: string;
}> {
  const argvLog = join(dir, 'argv.jsonl');
  const envLog = join(dir, 'env.json');
  const stdinLog = join(dir, 'stdin.jsonl');
  const uiRespLog = join(dir, 'ui-resp.jsonl');
  const spawnCountLog = join(dir, 'spawn.count');

  const script = `#!/usr/bin/env python3
import json, os, signal, sys, time

args = sys.argv[1:]
pid = os.getpid()

def log_line(path, obj):
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj) + "\\n")

log_line(os.environ.get("FAKE_ARGV_LOG"), {"pid": pid, "args": args})
if os.environ.get("FAKE_ENV_LOG"):
    with open(os.environ["FAKE_ENV_LOG"], "w", encoding="utf-8") as f:
        json.dump(dict(os.environ), f)
if os.environ.get("FAKE_SPAWN_COUNT_LOG"):
    with open(os.environ["FAKE_SPAWN_COUNT_LOG"], "a", encoding="utf-8") as f:
        f.write(f"{pid}\\n")

mode = os.environ.get("FAKE_PI_MODE", "standard")
if mode == "ignore_eof_and_sigterm":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)

def send(obj):
    sys.stdout.buffer.write((json.dumps(obj, ensure_ascii=False) + "\\n").encode("utf-8"))
    sys.stdout.buffer.flush()

def send_raw_bytes(b):
    sys.stdout.buffer.write(b)
    sys.stdout.buffer.flush()

session_id = "sess-1"
for i, a in enumerate(args):
    if a == "--session-id" and i + 1 < len(args):
        session_id = args[i + 1]
    elif a == "--session" and i + 1 < len(args):
        base = os.path.basename(args[i + 1])
        if "_" in base:
            session_id = base.rsplit("_", 1)[-1].replace(".jsonl", "")
        else:
            session_id = "opened-session"

session_file = os.path.join(os.environ.get("FAKE_SESSIONS_DIR", "/tmp"), f"{session_id}.jsonl")
current_model = {
    "id": "claude-sonnet-4",
    "name": "Claude Sonnet 4",
    "provider": "anthropic",
    "reasoning": True,
    "contextWindow": 200000,
    "maxTokens": 16384,
}
thinking_level = "medium"
session_name = None
message_count = 2 if "--session" in args else 0
if os.environ.get("FAKE_EMPTY_SESSION") == "1":
    message_count = 0

while True:
    raw = sys.stdin.buffer.readline()
    if not raw:
        if mode == "ignore_eof_and_sigterm":
            time.sleep(10)
            continue
        break
    line = raw.decode("utf-8").rstrip("\\r\\n")
    if not line.strip():
        continue
    cmd = json.loads(line)
    if cmd.get("type") == "extension_ui_response":
        log_line(os.environ.get("FAKE_UI_RESP_LOG"), cmd)
        continue

    log_line(os.environ.get("FAKE_STDIN_LOG"), {"pid": pid, "cmd": cmd})
    cid = cmd.get("id")
    ctype = cmd.get("type")

    if ctype == "get_state":
        send({
            "id": cid,
            "type": "response",
            "command": "get_state",
            "success": True,
            "data": {
                "model": current_model,
                "thinkingLevel": thinking_level,
                "isStreaming": False,
                "isCompacting": False,
                "steeringMode": "one-at-a-time",
                "followUpMode": "one-at-a-time",
                "sessionFile": session_file,
                "sessionId": session_id,
                **({"sessionName": session_name} if session_name else {}),
                "messageCount": message_count,
                "pendingMessageCount": 0,
            },
        })
    elif ctype == "get_available_models":
        send({
            "id": cid,
            "type": "response",
            "command": "get_available_models",
            "success": True,
            "data": {
                "models": [
                    current_model,
                    {
                        "id": "anthropic/claude-sonnet-4",
                        "name": "OR Sonnet",
                        "provider": "openrouter",
                        "reasoning": True,
                        "contextWindow": 128000,
                        "thinkingLevelMap": {"off": None, "low": "low", "medium": "medium", "high": "high"},
                    },
                    {
                        "id": "no-off-model",
                        "name": "No Off Model",
                        "provider": "custom/org",
                        "reasoning": True,
                        "contextWindow": 64000,
                        "thinkingLevelMap": {"off": None, "low": "low", "high": "high"},
                    },
                ],
            },
        })
    elif ctype == "set_model":
        p = cmd.get("provider")
        m = cmd.get("modelId")
        current_model = {
            "id": m,
            "name": m,
            "provider": p,
            "reasoning": True,
            "contextWindow": 128000,
            "thinkingLevelMap": {"off": None, "low": "low", "medium": "medium", "high": "high"},
        }
        if m == "no-off-model":
            thinking_level = "low"
        send({"id": cid, "type": "response", "command": "set_model", "success": True, "data": current_model})
    elif ctype == "get_available_thinking_levels":
        levels = ["low", "medium", "high"] if mode == "no_off_thinking" or current_model.get("id") == "no-off-model" else ["off", "minimal", "low", "medium", "high"]
        send({"id": cid, "type": "response", "command": "get_available_thinking_levels", "success": True, "data": {"levels": levels}})
    elif ctype == "set_thinking_level":
        req_lvl = cmd.get("level")
        if mode == "no_off_thinking" or current_model.get("id") == "no-off-model":
            thinking_level = "low" if req_lvl == "off" else req_lvl
        else:
            thinking_level = req_lvl
        send({"id": cid, "type": "response", "command": "set_thinking_level", "success": True})
    elif ctype == "get_commands":
        send({
            "id": cid,
            "type": "response",
            "command": "get_commands",
            "success": True,
            "data": {
                "commands": [
                    {"name": "skill:deploy", "description": "Deploy skill", "source": "skill", "sourceInfo": {"path": "/tmp/nonexistent/SKILL.md", "scope": "user"}},
                    {"name": "fix-tests", "description": "Fix tests", "source": "prompt", "sourceInfo": {"path": "/tmp/fix.md", "scope": "project"}},
                    {"name": "undo", "description": "Unsupported TUI undo", "source": "extension", "sourceInfo": {"scope": "user"}},
                    {"name": "settings", "description": "TUI settings", "source": "extension", "sourceInfo": {"scope": "user"}},
                ],
            },
        })
    elif ctype == "get_session_stats":
        if mode == "null_context_stats":
            send({
                "id": cid,
                "type": "response",
                "command": "get_session_stats",
                "success": True,
                "data": {
                    "sessionFile": session_file,
                    "sessionId": session_id,
                    "userMessages": 3,
                    "assistantMessages": 3,
                    "tokens": {"input": 1000, "output": 200, "cacheRead": 500, "cacheWrite": 50, "total": 1750},
                    "cost": 0.12,
                    "contextUsage": {"tokens": None, "contextWindow": 200000, "percent": None},
                },
            })
        else:
            send({
                "id": cid,
                "type": "response",
                "command": "get_session_stats",
                "success": True,
                "data": {
                    "sessionFile": session_file,
                    "sessionId": session_id,
                    "userMessages": 1,
                    "assistantMessages": 1,
                    "tokens": {"input": 420, "output": 80, "cacheRead": 10, "cacheWrite": 5, "total": 515},
                    "cost": 0.05,
                    "contextUsage": {"tokens": 500, "contextWindow": 200000, "percent": 0.25},
                },
            })
    elif ctype == "set_session_name":
        session_name = cmd.get("name")
        send({"id": cid, "type": "response", "command": "set_session_name", "success": True})
    elif ctype == "compact":
        mode = "null_context_stats"
        send({"id": cid, "type": "response", "command": "compact", "success": True, "data": {"summary": "compacted", "firstKeptEntryId": "e1", "tokensBefore": 5000}})
    elif ctype == "clone":
        if message_count == 0:
            send({"id": cid, "type": "response", "command": "clone", "success": False, "error": "This session has not been saved yet. Send a message before cloning or forking it."})
        else:
            session_id = f"{session_id}-cloned"
            session_file = os.path.join(os.environ.get("FAKE_SESSIONS_DIR", "/tmp"), f"{session_id}.jsonl")
            send({"id": cid, "type": "response", "command": "clone", "success": True, "data": {"cancelled": False}})
    elif ctype == "get_fork_messages":
        send({"id": cid, "type": "response", "command": "get_fork_messages", "success": True, "data": {"messages": [{"entryId": "u1", "text": "hello"}]}})
    elif ctype == "fork":
        session_id = f"{session_id}-forked"
        session_file = os.path.join(os.environ.get("FAKE_SESSIONS_DIR", "/tmp"), f"{session_id}.jsonl")
        send({"id": cid, "type": "response", "command": "fork", "success": True, "data": {"text": "hello", "cancelled": False}})
    elif ctype == "steer":
        send({"id": cid, "type": "response", "command": "steer", "success": True, "data": {"disposition": "queued"}})
    elif ctype == "follow_up":
        send({"id": cid, "type": "response", "command": "follow_up", "success": True, "data": {"disposition": "queued"}})
    elif ctype == "abort":
        send({"id": cid, "type": "response", "command": "abort", "success": True})
        send({"type": "agent_settled", "aborted": True})
    elif ctype == "prompt":
        message_count += 2
        if mode == "early_events_before_response":
            send({"type": "agent_start"})
            send({"type": "message_start", "message": {"role": "assistant", "content": []}})
            send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "fast-"}})
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "started"}})
            send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "reply"}})
            send({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "fast-reply"}], "stopReason": "stop"}})
            send({"type": "agent_settled", "aborted": False})
        elif mode == "handled_disposition":
            send({"type": "message_start", "message": {"role": "assistant", "content": []}})
            send({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "handled-by-ext"}], "stopReason": "stop"}})
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "handled"}})
        elif mode == "agent_end_not_settled":
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "started"}})
            send({"type": "agent_start"})
            send({"type": "message_start", "message": {"role": "assistant", "content": []}})
            send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "attempt1"}})
            send({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "attempt1"}], "stopReason": "error", "errorMessage": "429 retryable"}})
            send({"type": "agent_end", "messages": [], "willRetry": True})
            send({"type": "message_start", "message": {"role": "assistant", "content": []}})
            send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "-recovered"}})
            send({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "-recovered"}], "stopReason": "stop"}})
            send({"type": "agent_end", "messages": [], "willRetry": False})
            send({"type": "agent_settled", "aborted": False})
        elif mode == "assistant_error":
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "started"}})
            send({"type": "agent_start"})
            send({"type": "message_start", "message": {"role": "assistant", "content": []}})
            send({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": ""}], "stopReason": "error", "errorMessage": "rate limit exceeded"}})
            send({"type": "agent_end", "messages": [], "willRetry": False})
            send({"type": "agent_settled", "aborted": False})
        elif mode == "dedup_and_tools":
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "started"}})
            send({"type": "agent_start"})
            send({"type": "message_start", "message": {"role": "assistant", "content": []}})
            send({"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "contentIndex": 0, "delta": "think1 "}})
            send({"type": "message_update", "assistantMessageEvent": {"type": "thinking_delta", "contentIndex": 0, "delta": "think2"}})
            send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 1, "delta": "call "}})
            send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 1, "delta": "tool"}})
            send({"type": "message_update", "assistantMessageEvent": {"type": "toolcall_start", "contentIndex": 2, "id": "tc1", "toolName": "bash"}})
            send({"type": "message_update", "assistantMessageEvent": {"type": "toolcall_delta", "contentIndex": 2, "delta": "{\\"command\\":\\"ls\\"}"}})
            send({"type": "message_end", "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "think1 think2"},
                    {"type": "text", "text": "call tool"},
                    {"type": "toolCall", "id": "tc1", "name": "bash", "arguments": {"command": "ls"}},
                ],
                "usage": {"input": 100, "output": 50, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 150, "cost": {"total": 0.01}},
                "stopReason": "toolUse",
            }})
            send({"type": "tool_execution_start", "toolCallId": "tc1", "toolName": "bash", "args": {"command": "ls"}})
            send({"type": "tool_execution_update", "toolCallId": "tc1", "toolName": "bash", "args": {"command": "ls"}, "partialResult": {"content": [{"type": "text", "text": "a\\n"}]}})
            send({"type": "tool_execution_update", "toolCallId": "tc1", "toolName": "bash", "args": {"command": "ls"}, "partialResult": {"content": [{"type": "text", "text": "a\\nb\\n"}]}})
            send({"type": "tool_execution_end", "toolCallId": "tc1", "toolName": "bash", "result": {"content": [{"type": "text", "text": "a\\nb\\n"}], "details": {"exitCode": 0}}, "isError": False})
            send({"type": "message_end", "message": {"role": "toolResult", "toolCallId": "tc1", "toolName": "bash", "content": [{"type": "text", "text": "a\\nb\\n"}], "isError": False}})
            send({"type": "agent_settled", "aborted": False})
        elif mode == "split_utf8_u2028_crlf":
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "started"}})
            send({"type": "agent_start"})
            send({"type": "message_start", "message": {"role": "assistant", "content": []}})
            payload = ('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"A\\u2028B\\u2029🚀"}}').encode("utf-8") + b"\\r\\n"
            # Split inside the 4-byte emoji and around U+2028
            cut = payload.index("🚀".encode("utf-8")) + 2
            send_raw_bytes(payload[:cut])
            time.sleep(0.02)
            send_raw_bytes(payload[cut:])
            send({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "A\\u2028B\\u2029🚀"}], "stopReason": "stop"}})
            send({"type": "agent_settled", "aborted": False})
        elif mode == "ui_dialogs":
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "started"}})
            send({"type": "agent_start"})
            # Fire-and-forget methods (no response expected)
            send({"type": "extension_ui_request", "id": "ff-1", "method": "notify", "message": "heads up", "notifyType": "info"})
            send({"type": "extension_ui_request", "id": "ff-2", "method": "setStatus", "statusKey": "k", "statusText": "v"})
            send({"type": "extension_ui_request", "id": "ff-3", "method": "setWidget", "widgetKey": "w", "widgetLines": ["line1"]})
            send({"type": "extension_ui_request", "id": "ff-4", "method": "setTitle", "title": "t"})
            send({"type": "extension_ui_request", "id": "ff-5", "method": "set_editor_text", "text": "prefill"})
            # Unsupported editor -> expect immediate cancelled:true
            send({"type": "extension_ui_request", "id": "ed-1", "method": "editor", "title": "Edit", "prefill": "x"})
            ed_resp = json.loads(sys.stdin.buffer.readline().decode("utf-8"))
            log_line(os.environ.get("FAKE_UI_RESP_LOG"), ed_resp)
            # Confirm dialog -> expect client response
            send({"type": "extension_ui_request", "id": "cf-1", "method": "confirm", "title": "Proceed?", "message": "Really?"})
            cf_resp = json.loads(sys.stdin.buffer.readline().decode("utf-8"))
            log_line(os.environ.get("FAKE_UI_RESP_LOG"), cf_resp)
            # Select dialog -> expect client response
            send({"type": "extension_ui_request", "id": "sl-1", "method": "select", "title": "Pick", "options": ["OptA", "OptB"]})
            sl_resp = json.loads(sys.stdin.buffer.readline().decode("utf-8"))
            log_line(os.environ.get("FAKE_UI_RESP_LOG"), sl_resp)
            # Input dialog -> expect client response
            send({"type": "extension_ui_request", "id": "in-1", "method": "input", "title": "Enter", "placeholder": "name"})
            in_resp = json.loads(sys.stdin.buffer.readline().decode("utf-8"))
            log_line(os.environ.get("FAKE_UI_RESP_LOG"), in_resp)
            send({"type": "message_start", "message": {"role": "assistant", "content": []}})
            send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "ui-done"}})
            send({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "ui-done"}], "stopReason": "stop"}})
            send({"type": "agent_settled", "aborted": False})
        elif mode == "ui_timeout_or_abort":
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "started"}})
            send({"type": "agent_start"})
            send({"type": "extension_ui_request", "id": "cf-timeout", "method": "confirm", "title": "Timeout?", "message": "Wait", "timeout": 80})
            resp_raw = sys.stdin.buffer.readline()
            if resp_raw:
                log_line(os.environ.get("FAKE_UI_RESP_LOG"), json.loads(resp_raw.decode("utf-8")))
            send({"type": "agent_settled", "aborted": False})
        elif mode == "no_deltas_message_end":
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "started"}})
            send({"type": "agent_start"})
            send({"type": "message_start", "message": {"role": "assistant", "content": []}})
            send({"type": "message_end", "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "fallback-thought"},
                    {"type": "text", "text": "fallback-text"},
                ],
                "stopReason": "stop",
            }})
            send({"type": "message_end", "message": {
                "role": "toolResult",
                "toolCallId": "tr-fallback",
                "toolName": "read",
                "content": [{"type": "text", "text": "file-data"}],
                "isError": False,
            }})
            send({"type": "agent_settled", "aborted": False})
        elif mode == "crash_mid_turn":
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "started"}})
            send({"type": "agent_start"})
            send({"type": "message_start", "message": {"role": "assistant", "content": []}})
            send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "partial"}})
            sys.stderr.write("boom crashed\\n")
            sys.stderr.flush()
            sys.exit(42)
        elif mode == "wait_for_abort":
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "started"}})
            send({"type": "agent_start"})
        else:
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "started"}})
            send({"type": "agent_start"})
            send({"type": "message_start", "message": {"role": "assistant", "content": []}})
            send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "ok"}})
            send({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}], "stopReason": "stop"}})
            send({"type": "agent_settled", "aborted": False})
    else:
        send({"id": cid, "type": "response", "command": ctype or "unknown", "success": True})
`;

  const bin = await writeFakePiScript(dir, script, 'pi');
  return { bin, argvLog, envLog, stdinLog, uiRespLog, spawnCountLog };
}

test('resolvePiBin precedence: piBin > PI_BIN > ~/.local/bin/pi > PATH', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-bin-prec-'));
  try {
    const fakeHome = join(base, 'home');
    const localBinDir = join(fakeHome, '.local', 'bin');
    await mkdir(localBinDir, { recursive: true });
    const localPi = await writeFakePiScript(localBinDir, '#!/bin/sh\nexit 0\n', 'pi');

    const prevPiBin = process.env.PI_BIN;
    try {
      process.env.PI_BIN = '/custom/env/pi';
      assert.equal(resolvePiBin('/explicit/pi', { HOME: fakeHome }), '/explicit/pi');
      assert.equal(resolvePiBin(undefined, { HOME: fakeHome }), '/custom/env/pi');
      delete process.env.PI_BIN;
      assert.equal(resolvePiBin(undefined, { HOME: fakeHome }), localPi);
      assert.equal(resolvePiBin(undefined, { HOME: join(base, 'empty-home') }), 'pi');
    } finally {
      if (prevPiBin === undefined) delete process.env.PI_BIN;
      else process.env.PI_BIN = prevPiBin;
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('buildPiChildEnv strips GATEWAY_* env vars from spawned Pi child', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-env-strip-'));
  let adapter: PiProviderAdapter | undefined;
  const prevGatewayToken = process.env.GATEWAY_TOKEN;
  const prevGatewayPort = process.env.GATEWAY_PORT;
  try {
    process.env.GATEWAY_TOKEN = 'secret-gateway-token';
    process.env.GATEWAY_PORT = '58629';

    const built = buildPiChildEnv({
      GATEWAY_EXTRA: 'should-be-stripped',
      PI_CODING_AGENT_DIR: base,
    });
    assert.equal('GATEWAY_TOKEN' in built, false);
    assert.equal('GATEWAY_PORT' in built, false);
    assert.equal('GATEWAY_EXTRA' in built, false);
    assert.equal(built.PI_CODING_AGENT_DIR, base);

    const { bin, envLog } = await writeContractFakePi(base);
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      env: { FAKE_ENV_LOG: envLog, PI_CODING_AGENT_DIR: base, GATEWAY_INJECTED: 'bad' },
    });
    const sess = await adapter.create({ provider: 'pi', cwd: base });
    await drainEvents(await adapter.startTurn({ sessionId: sess.id, input: 'hi' }));

    const childEnv = JSON.parse(await readFile(envLog, 'utf8')) as Record<string, string>;
    assert.equal(Object.keys(childEnv).some((k) => k.startsWith('GATEWAY_')), false);
    assert.equal(childEnv.PI_CODING_AGENT_DIR, base);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    if (prevGatewayToken === undefined) delete process.env.GATEWAY_TOKEN;
    else process.env.GATEWAY_TOKEN = prevGatewayToken;
    if (prevGatewayPort === undefined) delete process.env.GATEWAY_PORT;
    else process.env.GATEWAY_PORT = prevGatewayPort;
    await rm(base, { recursive: true, force: true });
  }
});

test('JsonlLineFramer handles split UTF-8, U+2028/U+2029, and CRLF without splitting on Unicode separators', async () => {
  const framer = new JsonlLineFramer();
  const rec1 = '{"type":"text","text":"line1\\u2028still1\\u2029end1 🚀"}';
  const rec2 = '{"type":"text","text":"line2"}';
  // Use actual raw UTF-8 U+2028 and U+2029 characters inside JSON string literal.
  const rawWithLiteralSep = Buffer.from(
    `{"text":"a\u2028b\u2029c 🚀"}\r\n${rec2}\n${rec1}`,
    'utf8',
  );

  // Split every 3 bytes to break multi-byte UTF-8 sequences across chunks!
  const lines: string[] = [];
  for (let i = 0; i < rawWithLiteralSep.length; i += 3) {
    lines.push(...framer.push(rawWithLiteralSep.subarray(i, i + 3)));
  }
  lines.push(...framer.flush());

  assert.equal(lines.length, 3);
  assert.equal((JSON.parse(lines[0]!) as { text: string }).text, 'a\u2028b\u2029c 🚀');
  assert.equal((JSON.parse(lines[1]!) as { type: string }).type, 'text');
  assert.equal((JSON.parse(lines[2]!) as { text: string }).text, 'line1\u2028still1\u2029end1 🚀');
});

test('handles split UTF-8 + U+2028/U+2029 + CRLF and early events in fake-RPC turn', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-utf8-crlf-'));
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin } = await writeContractFakePi(base);
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      env: { FAKE_PI_MODE: 'split_utf8_u2028_crlf' },
    });
    const sess = await adapter.create({ provider: 'pi', cwd: base });
    const events = await drainEvents(await adapter.startTurn({ sessionId: sess.id, input: 'go' }));
    const deltas = events
      .filter((e) => e.kind === 'message' && e.status === 'delta')
      .map((e) => (e.payload as { delta: string }).delta);
    assert.deepEqual(deltas, ['A\u2028B\u2029🚀']);
    assert.equal(events.at(-1)?.kind, 'turn');
    assert.equal(events.at(-1)?.status, 'completed');
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('PiRpcClient correlates out-of-order responses by id and enforces backpressure on stdin', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-ooo-bp-'));
  let client: PiRpcClient | undefined;
  try {
    const script = `#!/usr/bin/env python3
import json, sys, time

reqs = []
for raw in sys.stdin.buffer:
    line = raw.decode("utf-8").strip()
    if not line:
        continue
    reqs.append(json.loads(line))
    if len(reqs) == 2:
        # Respond out of order: second request first, first request second!
        r2, r1 = reqs[1], reqs[0]
        sys.stdout.write(json.dumps({"id": r2["id"], "type": "response", "command": r2["type"], "success": True, "data": {"order": 2}}) + "\\n")
        sys.stdout.flush()
        time.sleep(0.02)
        sys.stdout.write(json.dumps({"id": r1["id"], "type": "response", "command": r1["type"], "success": True, "data": {"order": 1}}) + "\\n")
        sys.stdout.flush()
`;
    const bin = await writeFakePiScript(base, script);
    client = new PiRpcClient({ piBin: bin, cwd: base });
    client.start();

    const [first, second] = await Promise.all([
      client.request<{ order: number }>({ type: 'get_state' }),
      client.request<{ order: number }>({ type: 'get_available_models' }),
    ]);
    assert.equal(first.order, 1);
    assert.equal(second.order, 2);

    // Real StdinLineWriter backpressure test: second write must wait for `drain`.
    const fakeStream = new PassThrough({ highWaterMark: 16 });
    const writtenChunks: string[] = [];
    const origWrite = fakeStream.write.bind(fakeStream);
    let callCount = 0;
    (fakeStream as any).write = (chunk: any, enc: any, cb: any) => {
      callCount += 1;
      writtenChunks.push(String(chunk));
      if (callCount === 1) {
        cb?.();
        return false; // Simulate full kernel pipe buffer
      }
      return origWrite(chunk, enc, cb);
    };

    const writer = new StdinLineWriter(fakeStream);
    const p1 = writer.writeLine('{"id":"1"}\n');
    const p2 = writer.writeLine('{"id":"2"}\n');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(writtenChunks, ['{"id":"1"}\n'], 'second write must wait until drain');
    fakeStream.emit('drain');
    await Promise.all([p1, p2]);
    assert.deepEqual(writtenChunks, ['{"id":"1"}\n', '{"id":"2"}\n']);
    await writer.endAndFlush();
  } finally {
    await client?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('captures events emitted BEFORE prompt response arrives', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-early-events-'));
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin } = await writeContractFakePi(base);
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      env: { FAKE_PI_MODE: 'early_events_before_response' },
    });
    const sess = await adapter.create({ provider: 'pi', cwd: base });
    const events = await drainEvents(await adapter.startTurn({ sessionId: sess.id, input: 'hi' }));
    const deltas = events
      .filter((e) => e.kind === 'message' && e.status === 'delta')
      .map((e) => (e.payload as { delta: string }).delta);
    assert.deepEqual(deltas, ['fast-', 'reply']);
    assert.equal(events.at(-1)?.status, 'completed');
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('handles data.disposition=handled without waiting for agent_settled', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-handled-'));
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin } = await writeContractFakePi(base);
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      env: { FAKE_PI_MODE: 'handled_disposition' },
    });
    const sess = await adapter.create({ provider: 'pi', cwd: base });
    const events = await drainEvents(await adapter.startTurn({ sessionId: sess.id, input: '/my-ext' }));
    const deltas = events
      .filter((e) => e.kind === 'message' && e.status === 'delta')
      .map((e) => (e.payload as { delta: string }).delta);
    assert.deepEqual(deltas, ['handled-by-ext']);
    assert.equal(events.at(-1)?.kind, 'turn');
    assert.equal(events.at(-1)?.status, 'completed');
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('settles on agent_settled (not agent_end) and maps error/aborted states accurately', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-settle-'));
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin } = await writeContractFakePi(base);

    // 1. Retry recovery across agent_end(willRetry=true) -> agent_settled
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      env: { FAKE_PI_MODE: 'agent_end_not_settled' },
    });
    const s1 = await adapter.create({ provider: 'pi', cwd: base });
    const ev1 = await drainEvents(await adapter.startTurn({ sessionId: s1.id, input: 'retry' }));
    const text1 = ev1
      .filter((e) => e.kind === 'message' && e.status === 'delta')
      .map((e) => (e.payload as { delta: string }).delta)
      .join('');
    assert.equal(text1, 'attempt1-recovered');
    assert.equal(ev1.at(-1)?.status, 'completed');
    await adapter.dispose();

    // 2. Assistant stopReason=error -> failed with errorMessage
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      env: { FAKE_PI_MODE: 'assistant_error' },
    });
    const s2 = await adapter.create({ provider: 'pi', cwd: base });
    const ev2 = await drainEvents(await adapter.startTurn({ sessionId: s2.id, input: 'fail' }));
    assert.equal(ev2.at(-1)?.kind, 'turn');
    assert.equal(ev2.at(-1)?.status, 'failed');
    assert.match(String((ev2.at(-1)?.payload as { error?: string }).error), /rate limit exceeded/);
    await adapter.dispose();

    // 3. Abort -> agent_settled(aborted=true) -> cancelled
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      env: { FAKE_PI_MODE: 'wait_for_abort' },
    });
    const s3 = await adapter.create({ provider: 'pi', cwd: base });
    const handle = await adapter.startTurn({ sessionId: s3.id, input: 'slow' });
    const eventsPromise = drainEvents(handle);
    await new Promise((r) => setTimeout(r, 40));
    await adapter.interrupt(s3.id);
    const ev3 = await eventsPromise;
    assert.equal(ev3.at(-1)?.kind, 'turn');
    assert.equal(ev3.at(-1)?.status, 'cancelled');
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('deduplicates message_update + tool_execution_* against message_end and diffs tool partials', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-dedup-'));
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin } = await writeContractFakePi(base);
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      env: { FAKE_PI_MODE: 'dedup_and_tools' },
    });
    const sess = await adapter.create({ provider: 'pi', cwd: base });
    const events = await drainEvents(await adapter.startTurn({ sessionId: sess.id, input: 'run ls' }));

    const thinking = events
      .filter((e) => e.kind === 'thinking' && e.status === 'delta')
      .map((e) => (e.payload as { delta: string }).delta);
    assert.deepEqual(thinking, ['think1 ', 'think2']);

    const texts = events
      .filter((e) => e.kind === 'message' && e.status === 'delta')
      .map((e) => (e.payload as { delta: string }).delta);
    assert.deepEqual(texts, ['call ', 'tool']);

    const toolStarted = events.filter((e) => e.kind === 'tool' && e.status === 'started');
    const toolDeltas = events.filter((e) => e.kind === 'tool' && e.status === 'delta');
    const toolCompleted = events.filter((e) => e.kind === 'tool' && e.status === 'completed');

    assert.equal(toolStarted.length, 1);
    assert.equal((toolStarted[0]?.payload as { toolCallId: string }).toolCallId, 'tc1');
    assert.deepEqual(toolDeltas.map((e) => (e.payload as { output: string }).output), ['a\n', 'b\n']);
    assert.equal(toolCompleted.length, 1);
    assert.equal((toolCompleted[0]?.payload as { output: string }).output, 'a\nb\n');
    assert.deepEqual((toolCompleted[0]?.payload as { structuredOutput?: unknown }).structuredOutput, { exitCode: 0 });
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('validates base64 image size/MIME and converts non-image files to safe path text', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-attach-'));
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin, stdinLog } = await writeContractFakePi(base);
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      maxImageBytes: 64,
      env: { FAKE_STDIN_LOG: stdinLog },
    });
    const sess = await adapter.create({ provider: 'pi', cwd: base });
    const imgPath = join(base, 'ok.png');
    await writeFile(imgPath, Buffer.from('89504e470d0a1a0a', 'hex'));

    // Valid image + non-image file with control chars in name
    await drainEvents(await adapter.startTurn({
      sessionId: sess.id,
      input: 'describe',
      attachments: [
        { kind: 'localImage', path: imgPath, mediaType: 'image/png', name: 'ok.png', size: 8 },
        { kind: 'imageDataUrl', dataUrl: `data:image/jpg;base64,${Buffer.from('jpegbytes').toString('base64')}` },
        { kind: 'filePathText', path: '/tmp/doc\ninjected.pdf', name: 'doc\r\n.pdf', mediaType: 'application/pdf', size: 123 },
      ],
    }));

    const sent = (await readFile(stdinLog, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).cmd as Record<string, unknown>);
    const promptCmd = sent.find((c) => c.type === 'prompt')!;
    assert.ok(Array.isArray(promptCmd.images));
    assert.equal((promptCmd.images as unknown[]).length, 2);
    assert.equal((promptCmd.images as Array<{ mimeType: string }>)[1]?.mimeType, 'image/jpeg');
    assert.ok(String(promptCmd.message).includes('Attached file "doc .pdf" (application/pdf, 123 bytes): /tmp/doc injected.pdf'));
    assert.ok(!String(promptCmd.message).includes('\r'));

    // Unsupported MIME rejected
    await assert.rejects(
      adapter.startTurn({
        sessionId: sess.id,
        input: 'bad mime',
        attachments: [{ kind: 'imageDataUrl', dataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}` }],
      }),
      (err: unknown) => err instanceof ProviderError && err.code === 'invalid_request' && err.httpStatus === 400,
    );

    // Oversized image rejected
    await assert.rejects(
      adapter.startTurn({
        sessionId: sess.id,
        input: 'too big',
        attachments: [{ kind: 'imageDataUrl', dataUrl: `data:image/png;base64,${Buffer.alloc(128).toString('base64')}` }],
      }),
      (err: unknown) => err instanceof ProviderError && err.code === 'invalid_request' && err.httpStatus === 400,
    );

    // Invalid base64 rejected
    await assert.rejects(
      adapter.startTurn({
        sessionId: sess.id,
        input: 'bad b64',
        attachments: [{ kind: 'imageDataUrl', dataUrl: 'data:image/png;base64,!!!not-base64!!!' }],
      }),
      (err: unknown) => err instanceof ProviderError && err.code === 'invalid_request' && err.httpStatus === 400,
    );
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('honest capabilities and unsupported approval/rollback/goal contracts', async () => {
  const adapter = new PiProviderAdapter();
  const caps = adapter.capabilities();
  assert.equal(caps.approvals, false);
  assert.equal(caps.manualApproval, false);
  assert.equal(caps.planMode, false);
  assert.equal(caps.rollback, false);
  assert.equal(caps.swarm, false);
  assert.equal(caps.tower, false);
  assert.equal(caps.btw, false);
  assert.equal(caps.goals, false);
  assert.equal(caps.clone, true);
  assert.equal(caps.fork, true);
  assert.equal(caps.compact, true);
  assert.equal(caps.rename, true);
  assert.equal(caps.archive, true);
  assert.equal(caps.delete, true);
  assert.equal(caps.steer, true);
  assert.equal(caps.thinkingLevels, true);
  assert.equal(caps.commands, true);
  assert.equal(caps.skills, true);
  assert.equal(caps.usage, true);
  assert.equal(caps.questions, true);

  await assert.rejects(
    adapter.resolveApproval('s1', 'a1', 'approve'),
    (e: unknown) => e instanceof ProviderError && e.code === 'unsupported',
  );
  await assert.rejects(
    adapter.rollback('s1', 1),
    (e: unknown) => e instanceof ProviderError && e.code === 'unsupported',
  );
  await assert.rejects(
    adapter.setGoal(),
    (e: unknown) => e instanceof ProviderError && e.code === 'unsupported',
  );
  await assert.rejects(
    adapter.getGoal(),
    (e: unknown) => e instanceof ProviderError && e.code === 'unsupported',
  );
  await assert.rejects(
    adapter.controlGoal(),
    (e: unknown) => e instanceof ProviderError && e.code === 'unsupported',
  );
});

test('bridges select/confirm/input extension UI safely and fails closed on editor/invalid/timeout/disconnect', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-ui-'));
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin, uiRespLog } = await writeContractFakePi(base);
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      env: { FAKE_PI_MODE: 'ui_dialogs', FAKE_UI_RESP_LOG: uiRespLog },
    });
    const sess = await adapter.create({ provider: 'pi', cwd: base });
    const handle = await adapter.startTurn({ sessionId: sess.id, input: 'trigger ui' });

    const seen: GatewayEvent[] = [];
    const done = (async () => {
      for await (const ev of handle.events) {
        seen.push(ev);
        if (ev.kind === 'question' && ev.status === 'started') {
          const p = ev.payload as { questionId: string; prompt: string };
          if (p.questionId === 'cf-1') {
            await adapter!.resolveQuestion(sess.id, p.questionId, { q_0: ['yes'] });
          } else if (p.questionId === 'sl-1') {
            // Invalid selection -> must fail closed { cancelled: true }!
            await adapter!.resolveQuestion(sess.id, p.questionId, { q_0: ['NotAnOption'] });
          } else if (p.questionId === 'in-1') {
            await adapter!.resolveQuestion(sess.id, p.questionId, 'typed-value');
          }
        }
      }
    })();
    await done;

    assert.ok(seen.some((e) => e.kind === 'notice' && (e.payload as { message: string }).message === 'heads up'));
    assert.equal(seen.at(-1)?.status, 'completed');

    const resps = (await readFile(uiRespLog, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(resps, [
      { type: 'extension_ui_response', id: 'ed-1', cancelled: true },
      { type: 'extension_ui_response', id: 'cf-1', confirmed: true },
      { type: 'extension_ui_response', id: 'sl-1', cancelled: true },
      { type: 'extension_ui_response', id: 'in-1', value: 'typed-value' },
    ]);
    await adapter.dispose();

    // Timeout fail-closed test
    const uiTimeoutLog = join(base, 'ui-timeout.jsonl');
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      env: { FAKE_PI_MODE: 'ui_timeout_or_abort', FAKE_UI_RESP_LOG: uiTimeoutLog },
    });
    const s2 = await adapter.create({ provider: 'pi', cwd: base });
    const evs2 = await drainEvents(await adapter.startTurn({ sessionId: s2.id, input: 'timeout ui' }));
    assert.equal(evs2.at(-1)?.status, 'completed');
    const timeoutResps = (await readFile(uiTimeoutLog, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(timeoutResps, [{ type: 'extension_ui_response', id: 'cf-timeout', cancelled: true }]);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('reversible model encoding, dynamic thinking levels without off, commands without duplicate expansion, stats with null context', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-models-think-'));
  let adapter: PiProviderAdapter | undefined;
  try {
    // Reversible model encoding checks
    assert.equal(encodePiModelId('openrouter', 'anthropic/claude-sonnet-4'), 'openrouter/anthropic/claude-sonnet-4');
    assert.deepEqual(decodePiModelId('openrouter/anthropic/claude-sonnet-4'), {
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
    });
    const weirdEnc = encodePiModelId('custom/org', 'ns/model-1');
    assert.deepEqual(decodePiModelId(weirdEnc), { provider: 'custom/org', modelId: 'ns/model-1' });

    // Dynamic thinking level filtering (no `off`)
    assert.deepEqual(
      piModelSupportedThinkingLevels({
        id: 'm1',
        provider: 'p1',
        reasoning: true,
        thinkingLevelMap: { off: null, low: 'l', high: 'h' },
      }),
      ['minimal', 'low', 'medium', 'high'],
    );
    assert.deepEqual(
      piModelSupportedThinkingLevels({
        id: 'm2',
        provider: 'p1',
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, low: 'l', medium: 'm', high: 'h', max: 'max' },
      }),
      ['low', 'medium', 'high', 'max'],
    );

    // Null contextUsage.tokens -> context_unavailable: true
    const mappedNullStats = mapPiStatsToUsage({
      sessionId: 's',
      assistantMessages: 2,
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
      cost: 0.02,
      contextUsage: { tokens: null, contextWindow: 200000, percent: null },
    });
    assert.equal(mappedNullStats.context_unavailable, true);
    assert.equal(mappedNullStats.context_tokens, 0);
    assert.equal(mappedNullStats.context_limit, 200000);

    const { bin, stdinLog } = await writeContractFakePi(base);
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      env: { FAKE_STDIN_LOG: stdinLog, FAKE_PI_MODE: 'no_off_thinking' },
    });

    const models = await adapter.listModels();
    assert.deepEqual(models.map((m) => m.model), [
      'anthropic/claude-sonnet-4',
      'openrouter/anthropic/claude-sonnet-4',
      'custom%2Forg/no-off-model',
    ]);
    assert.equal(models[1]?.support_efforts?.includes('off'), false);

    const sess = await adapter.create({ provider: 'pi', cwd: base });
    const levels = await adapter.listThinkingLevels(sess.id);
    assert.deepEqual(levels, ['low', 'medium', 'high']);

    // Setting `off` when model lacks `off` reads back Pi's clamped `low` via `get_state`.
    await adapter.setThinking(sess.id, 'off');
    assert.equal(adapter.getThinking(sess.id), 'low');

    await adapter.setModel(sess.id, 'openrouter/anthropic/claude-sonnet-4');
    assert.equal(adapter.getModel(sess.id), 'openrouter/anthropic/claude-sonnet-4');

    // Commands & skills without TUI-only entries and without gateway prompt expansion
    const cmds = await adapter.listCommands(sess.id);
    assert.ok(cmds.some((c) => c.name === 'skill:deploy'));
    assert.ok(cmds.some((c) => c.name === 'fix-tests'));
    assert.equal(cmds.some((c) => c.name === 'undo' || c.name === 'settings'), false);
    const skills = await adapter.listSkills(sess.id);
    assert.deepEqual(skills.map((s) => s.name), ['skill:deploy']);

    await drainEvents(await adapter.startTurn({ sessionId: sess.id, input: '/skill:deploy prod' }));
    const sentPrompt = (await readFile(stdinLog, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).cmd as Record<string, unknown>)
      .find((c) => c.type === 'prompt');
    assert.equal(sentPrompt?.message, '/skill:deploy prod');

    // Compact & stats with null contextUsage.tokens
    await adapter.compact(sess.id, 'keep recent code');
    const usageAfterCompact = adapter.getUsage(sess.id);
    assert.equal(usageAfterCompact?.context_unavailable, true);
    assert.equal(usageAfterCompact?.context_limit, 200000);
    assert.equal(usageAfterCompact?.input_tokens, 1000);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('clone isolates source and cloned processes and rejects empty unsaved sessions', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-clone-iso-'));
  const sessionsDir = join(base, 'sessions');
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin, argvLog, stdinLog } = await writeContractFakePi(base);
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir,
      env: { FAKE_STDIN_LOG: stdinLog, FAKE_ARGV_LOG: argvLog, FAKE_SESSIONS_DIR: sessionsDir },
    });

    // Empty unsaved session must reject cleanly.
    const emptySess = await adapter.create({ provider: 'pi', cwd: base });
    await assert.rejects(
      adapter.clone(emptySess.id),
      (e: unknown) => e instanceof ProviderError && e.code === 'invalid_request' && e.httpStatus === 400,
    );

    // Persisted non-empty session on disk
    const cwdDir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(cwdDir, { recursive: true });
    const srcId = '11111111-1111-4111-8111-111111111111';
    const srcFile = join(cwdDir, `2026-11-14T21-00-00-000Z_${srcId}.jsonl`);
    await writeFile(srcFile, [
      JSON.stringify({ type: 'session', version: 3, id: srcId, timestamp: '2026-11-14T21:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-11-14T21:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 } }),
      JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-11-14T21:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'world' }], stopReason: 'stop', timestamp: 2 } }),
    ].join('\n') + '\n');

    await adapter.setThinking(srcId, 'high');
    const cloned = await adapter.clone(srcId);
    assert.notEqual(cloned.id, srcId);
    assert.equal(adapter.getThinking(cloned.id), 'high');

    // Run a turn on source and a turn on cloned — verify TWO distinct PIDs handled them!
    await drainEvents(await adapter.startTurn({ sessionId: srcId, input: 'on-source' }));
    await drainEvents(await adapter.startTurn({ sessionId: cloned.id, input: 'on-cloned' }));

    const stdinLines = (await readFile(stdinLog, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { pid: number; cmd: { type: string; message?: string } });
    const srcPrompt = stdinLines.find((r) => r.cmd.type === 'prompt' && r.cmd.message === 'on-source');
    const clonePrompt = stdinLines.find((r) => r.cmd.type === 'prompt' && r.cmd.message === 'on-cloned');
    assert.ok(srcPrompt && clonePrompt);
    assert.notEqual(srcPrompt.pid, clonePrompt.pid, 'source and cloned sessions must run in isolated processes');
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('steer, followUp, rename fallback, sidecar archive, safe delete (busy/symlink/traversal), crash, and SIGKILL escalation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-lifecycle-'));
  const sessionsDir = join(base, 'sessions');
  const settingsPath = join(base, 'pi-settings.json');
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin, stdinLog } = await writeContractFakePi(base);
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir,
      settingsPath,
      env: { FAKE_STDIN_LOG: stdinLog, FAKE_PI_MODE: 'wait_for_abort' },
    });

    const cwdDir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(cwdDir, { recursive: true });
    const sid = '22222222-2222-4222-8222-222222222222';
    const sfile = join(cwdDir, `2026-11-14T21-00-00-000Z_${sid}.jsonl`);
    await writeFile(sfile, [
      JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-14T21:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-11-14T21:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'first' }], timestamp: 1 } }),
    ].join('\n') + '\n');

    // Rename & sidecar archive
    await adapter.rename(sid, 'Custom Title');
    await adapter.setArchived(sid, true);
    const archivedList = await adapter.list({ archived: true });
    assert.deepEqual(archivedList.items.map((s) => s.id), [sid]);
    assert.equal(archivedList.items[0]?.title, 'Custom Title');
    const activeList = await adapter.list({ archived: false });
    assert.equal(activeList.items.length, 0);

    // Sidecar archive persists across adapter restart
    await adapter.dispose();
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir,
      settingsPath,
      env: { FAKE_STDIN_LOG: stdinLog, FAKE_PI_MODE: 'wait_for_abort' },
    });
    assert.deepEqual((await adapter.list({ archived: true })).items.map((s) => s.id), [sid]);
    await adapter.setArchived(sid, false);

    // Busy lock blocks delete and steer sends steer command
    const turn = await adapter.startTurn({ sessionId: sid, input: 'working' });
    const turnPromise = drainEvents(turn);
    await adapter.steer(sid, turn.turnId, 'change direction');
    await assert.rejects(
      adapter.delete(sid),
      (e: unknown) => e instanceof ProviderError && e.code === 'busy' && e.httpStatus === 409,
    );
    await adapter.interrupt(sid);
    await turnPromise;

    // Traversal delete rejected
    await assert.rejects(
      adapter.delete('../../etc/passwd'),
      (e: unknown) => e instanceof ProviderError && e.code === 'not_found',
    );

    // Symlink inside sessionsDir must NOT be followed or delete external target
    const outsideTarget = join(base, 'outside-secret.jsonl');
    await writeFile(outsideTarget, JSON.stringify({ type: 'session', version: 3, id: 'sym-id', cwd: base }) + '\n');
    const symlinkSession = join(cwdDir, '2026-11-14T21-00-00-000Z_sym-id.jsonl');
    await symlink(outsideTarget, symlinkSession);
    await adapter.delete('sym-id');
    assert.ok((await lstat(outsideTarget)).isFile(), 'external symlink target must remain untouched');

    // Genuine session delete removes file inside sessionsDir
    await adapter.delete(sid);
    await assert.rejects(lstat(sfile));
    await adapter.dispose();

    // Crash mid-turn emits single failed turn event
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir,
      settingsPath,
      env: { FAKE_PI_MODE: 'crash_mid_turn' },
    });
    const crashSess = await adapter.create({ provider: 'pi', cwd: base });
    const crashEvents = await drainEvents(await adapter.startTurn({ sessionId: crashSess.id, input: 'crash' }));
    const turnEnds = crashEvents.filter((e) => e.kind === 'turn');
    assert.equal(turnEnds.length, 1);
    assert.equal(turnEnds[0]?.status, 'failed');
    await adapter.dispose();

    // Shutdown escalation: EOF -> SIGTERM -> SIGKILL when child ignores EOF & SIGTERM
    const hangClient = new PiRpcClient({
      piBin: bin,
      cwd: base,
      env: { FAKE_PI_MODE: 'ignore_eof_and_sigterm' },
      shutdownGraceMs: 60,
      killGraceMs: 60,
    });
    hangClient.start();
    const state = await hangClient.request<{ sessionId: string }>({ type: 'get_state' });
    assert.ok(state.sessionId);
    await hangClient.close();
    assert.equal(hangClient.isAlive, false);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('16 MiB tail-windowed O_NOFOLLOW active-branch JSONL history reader', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-history-'));
  const sessionsDir = join(base, 'sessions');
  try {
    const cwdDir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(cwdDir, { recursive: true });
    const sid = '33333333-3333-4333-8333-333333333333';
    const sfile = join(cwdDir, `2026-11-14T21-00-00-000Z_${sid}.jsonl`);

    // Build branched tree: u1 -> a1 -> [abandoned u2 -> a2], [active u3 -> a3 -> tr3 -> comp -> u4]
    // Include context_edit on a1 and U+2028 in u3.
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-14T21:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'message', id: 'sys1', parentId: null, timestamp: '2026-11-14T21:00:00.100Z', message: { role: 'system', content: 'sys', timestamp: 1 } }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: 'sys1', timestamp: '2026-11-14T21:00:01.000Z', message: { role: 'user', content: 'root prompt', timestamp: 2 } }),
      JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-11-14T21:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'old reply' }], stopReason: 'stop', timestamp: 3 } }),
      // Abandoned branch off a1
      JSON.stringify({ type: 'message', id: 'u2', parentId: 'a1', timestamp: '2026-11-14T21:00:03.000Z', message: { role: 'user', content: 'abandoned branch', timestamp: 4 } }),
      JSON.stringify({ type: 'message', id: 'a2', parentId: 'u2', timestamp: '2026-11-14T21:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned reply' }], stopReason: 'stop', timestamp: 5 } }),
      // Active branch off a1
      JSON.stringify({ type: 'message', id: 'u3', parentId: 'a1', timestamp: '2026-11-14T21:00:05.000Z', message: { role: 'user', content: [{ type: 'text', text: 'active\u2028branch' }], timestamp: 6 } }),
      JSON.stringify({ type: 'message', id: 'a3', parentId: 'u3', timestamp: '2026-11-14T21:00:06.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc3', name: 'bash', arguments: { command: 'pwd' } }], stopReason: 'toolUse', timestamp: 7 } }),
      JSON.stringify({ type: 'message', id: 'tr3', parentId: 'a3', timestamp: '2026-11-14T21:00:07.000Z', message: { role: 'toolResult', toolCallId: 'tc3', toolName: 'bash', content: [{ type: 'text', text: base }], isError: false, timestamp: 8 } }),
      JSON.stringify({ type: 'context_edit', id: 'ce1', parentId: 'tr3', timestamp: '2026-11-14T21:00:08.000Z', targetId: 'a1', replacement: { content: [{ type: 'text', text: 'edited reply' }] } }),
    ];
    await writeFile(sfile, lines.join('\n') + '\n');

    const adapter = new PiProviderAdapter({ sessionsDir });
    const history = await adapter.getHistory(sid);
    // System message excluded, abandoned u2/a2 excluded, context_edit applied to a1, U+2028 preserved.
    assert.deepEqual(history.map((m) => m.id), ['u1', 'a1', 'u3', 'a3', 'tr3']);
    assert.equal((history[1]?.content[0] as { text: string }).text, 'edited reply');
    assert.equal((history[2]?.content[0] as { text: string }).text, 'active\u2028branch');
    assert.equal(history[4]?.role, 'tool');

    // Symlink target refused via O_NOFOLLOW
    const symFile = join(cwdDir, '2026-11-14T21-00-00-000Z_sym.jsonl');
    await symlink(sfile, symFile);
    await assert.rejects(
      readPiActiveBranchHistory(symFile, { sessionId: 'sym', sessionsRoot: sessionsDir }),
      (e: unknown) => e instanceof ProviderError && e.code === 'not_found',
    );

    // 16 MiB tail-window: test actual >16 MiB file truncation cleanly drops partial head line.
    const bigFile = join(cwdDir, `2026-11-14T21-00-00-000Z_big.jsonl`);
    const fillerText = 'x'.repeat(4000);
    const chunkLines: string[] = [
      JSON.stringify({ type: 'session', version: 3, id: 'big', timestamp: '2026-11-14T21:00:00.000Z', cwd: base }),
    ];
    let prevId: string | null = null;
    for (let i = 0; i < 4400; i += 1) {
      const id = `e${i}`;
      chunkLines.push(JSON.stringify({
        type: 'message',
        id,
        parentId: prevId,
        timestamp: '2026-11-14T21:00:01.000Z',
        message: { role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `${id}:${fillerText}` }], timestamp: i },
      }));
      prevId = id;
    }
    await writeFile(bigFile, chunkLines.join('\n') + '\n');
    const tailHistory = await readPiActiveBranchHistory(bigFile, {
      sessionId: 'big',
      sessionsRoot: sessionsDir,
    });
    assert.ok(tailHistory.length > 0 && tailHistory.length < 4400, `expected tail window slice, got ${tailHistory.length}`);
    assert.equal(tailHistory.at(-1)?.id, 'e4399');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('real isolated pi --mode rpc smoke verification against local pi 1.5.2', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-real-smoke-'));
  const agentDir = join(base, 'agent');
  const sessionsDir = join(agentDir, 'sessions');
  const workDir = join(base, 'work');
  let adapter: PiProviderAdapter | undefined;
  try {
    await mkdir(workDir, { recursive: true });
    const cwdDir = join(sessionsDir, encodePiCwdDir(workDir));
    await mkdir(cwdDir, { recursive: true });

    const srcId = '44444444-4444-4444-8444-444444444444';
    const srcFile = join(cwdDir, `2026-11-14T21-00-00-000Z_${srcId}.jsonl`);
    await writeFile(srcFile, [
      JSON.stringify({ type: 'session', version: 3, id: srcId, timestamp: '2026-11-14T21:00:00.000Z', cwd: workDir }),
      JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-11-14T21:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'smoke hello\u2028world' }], timestamp: 1763154001000 } }),
      JSON.stringify({
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        timestamp: '2026-11-14T21:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'smoke ok' }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          usage: { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: 1763154002000,
        },
      }),
    ].join('\n') + '\n');

    adapter = new PiProviderAdapter({
      piBin: REAL_PI_BIN,
      sessionsDir,
      settingsPath: join(base, 'pi-settings.json'),
      extraArgs: ['--offline', '--no-extensions', '--no-skills', '--no-prompt-templates'],
      env: {
        HOME: base,
        PI_CODING_AGENT_DIR: agentDir,
      },
    });

    // 1. Models, commands, thinking levels (isolated empty agentDir)
    const models = await adapter.listModels();
    assert.ok(Array.isArray(models));
    const commands = await adapter.listCommands(srcId);
    assert.ok(commands.some((c) => c.name === 'compact'));
    assert.ok(commands.some((c) => c.name === 'clone'));
    assert.equal(commands.some((c) => c.name === 'undo'), false);
    const levels = await adapter.listThinkingLevels(srcId);
    assert.ok(levels.length >= 1);

    // 2. Rename persisted via real set_session_name + stats + history
    await adapter.rename(srcId, 'Real Smoke Session');
    const usage = await adapter.refreshUsage(srcId);
    assert.equal(usage.input_tokens, 12);
    assert.equal(usage.output_tokens, 8);
    assert.equal(usage.context_unavailable, true);

    const listed = await adapter.list({ cwd: workDir });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]?.title, 'Real Smoke Session');

    const history = await adapter.getHistory(srcId);
    assert.equal(history.length, 2);
    assert.equal((history[0]?.content[0] as { text: string }).text, 'smoke hello\u2028world');

    // 3. Real Pi clone isolation + empty session rejection
    const empty = await adapter.create({ provider: 'pi', cwd: workDir });
    await assert.rejects(
      adapter.clone(empty.id),
      (e: unknown) => e instanceof ProviderError && e.code === 'invalid_request',
    );
    const cloned = await adapter.clone(srcId);
    assert.notEqual(cloned.id, srcId);
    const clonedHistory = await adapter.getHistory(cloned.id);
    assert.equal(clonedHistory.length, 2);

    // 4. Real delete + clean stdin EOF dispose
    await adapter.delete(cloned.id);
    const afterDelete = await adapter.list({ cwd: workDir });
    assert.deepEqual(afterDelete.items.map((s) => s.id), [srcId]);
    await adapter.dispose();
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('followUp, fork at entryId, non-streamed message_end fallback, and fail-closed UI cancel on abort', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-extra-contracts-'));
  const sessionsDir = join(base, 'sessions');
  let piAdapter: PiAdapter | undefined;
  let providerAdapter: PiProviderAdapter | undefined;
  try {
    const { bin, stdinLog, uiRespLog } = await writeContractFakePi(base);
    const cwdDir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(cwdDir, { recursive: true });
    const sid = '55555555-5555-4555-8555-555555555555';
    const sfile = join(cwdDir, `2026-11-14T21-00-00-000Z_${sid}.jsonl`);
    await writeFile(sfile, [
      JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-14T21:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-11-14T21:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 } }),
      JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-11-14T21:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'world' }], stopReason: 'stop', timestamp: 2 } }),
    ].join('\n') + '\n');

    piAdapter = new PiAdapter({
      piBin: bin,
      sessionsDir,
      env: { FAKE_STDIN_LOG: stdinLog, FAKE_UI_RESP_LOG: uiRespLog, FAKE_PI_MODE: 'ui_timeout_or_abort' },
    });

    // 1. Abort while confirm dialog is parked -> sends { cancelled: true } fail-closed!
    const turn = await piAdapter.startTurn(sid, 'park ui');
    const seen: GatewayEvent[] = [];
    let sawQuestion!: () => void;
    const questionReady = new Promise<void>((resolve) => {
      sawQuestion = resolve;
    });
    const consumer = (async () => {
      for await (const ev of turn.events) {
        seen.push(ev);
        if (ev.kind === 'question' && ev.status === 'started') sawQuestion();
      }
    })();
    await questionReady;
    await piAdapter.abort(sid);
    await consumer;

    const uiResps = (await readFile(uiRespLog, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(uiResps.some((r) => r.id === 'cf-timeout' && r.cancelled === true));
    assert.equal(seen.at(-1)?.status, 'cancelled');

    // 2. Explicit entryId fork via PiAdapter + getForkMessages
    const forkMsgs = await piAdapter.getForkMessages(sid);
    assert.deepEqual(forkMsgs, [{ entryId: 'u1', text: 'hello' }]);
    const forked = await piAdapter.fork(sid, 'u1');
    assert.equal(forked.sessionId, `${sid}-forked`);
    await piAdapter.dispose();

    // 3. followUp during running turn
    piAdapter = new PiAdapter({
      piBin: bin,
      sessionsDir,
      env: { FAKE_STDIN_LOG: stdinLog, FAKE_PI_MODE: 'wait_for_abort' },
    });
    const fuTurn = await piAdapter.startTurn(sid, 'active');
    const fuEvents = drainEvents(fuTurn);
    const fu = await piAdapter.followUp(sid, 'after this');
    assert.equal(fu, 'queued');
    await piAdapter.abort(sid);
    await fuEvents;
    const sentCmds = (await readFile(stdinLog, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).cmd as Record<string, unknown>);
    assert.ok(sentCmds.some((c) => c.type === 'follow_up' && c.message === 'after this'));
    await piAdapter.dispose();

    // 4. Non-streamed message_end fallback (when no message_update deltas or tool_execution_* arrived)
    providerAdapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir,
      env: { FAKE_PI_MODE: 'no_deltas_message_end' },
    });
    const fbEvents = await drainEvents(await providerAdapter.startTurn({ sessionId: sid, input: 'no-stream' }));
    assert.deepEqual(
      fbEvents.filter((e) => e.kind === 'thinking').map((e) => (e.payload as { delta: string }).delta),
      ['fallback-thought'],
    );
    assert.deepEqual(
      fbEvents.filter((e) => e.kind === 'message').map((e) => (e.payload as { delta: string }).delta),
      ['fallback-text'],
    );
    assert.equal(
      fbEvents.filter((e) => e.kind === 'tool' && e.status === 'completed').length,
      1,
    );

    // 5. Provider fork(sid) uses isolated process and returns distinct session
    const providerForked = await providerAdapter.fork(sid);
    assert.notEqual(providerForked.id, sid);
  } finally {
    await piAdapter?.dispose().catch(() => undefined);
    await providerAdapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});
