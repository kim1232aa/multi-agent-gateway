import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
import { PassThrough, Writable } from 'node:stream';
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
  parsePiSessionEntry,
  piModelSupportedThinkingLevels,
  readPiActiveBranchHistory,
  resolvePiBin,
} from './pi-adapter.js';
import { ProviderError, type GatewayEvent } from './types.js';

/** Real-CLI tests run only when PI_REAL_BIN names a binary; never assume the author's home. */
const REAL_PI_BIN = process.env.PI_REAL_BIN ?? '';

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
import json, os, signal, sys, threading, time

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

send_lock = threading.Lock()

def send(obj):
    with send_lock:
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
    "input": ["text", "image"],
    "contextWindow": 200000,
    "maxTokens": 16384,
}
thinking_level = "medium"
session_name = None
auto_compaction = True
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
        if mode == "startup_ui_dialog" and os.environ.get("FAKE_STARTUP_UI_ONCE", "1") == "1":
            os.environ["FAKE_STARTUP_UI_ONCE"] = "0"
            send({"type": "extension_ui_request", "id": "startup-cf", "method": "confirm", "title": "Trust?", "message": "Workspace?"})
            resp_raw = sys.stdin.buffer.readline()
            if resp_raw:
                log_line(os.environ.get("FAKE_UI_RESP_LOG"), json.loads(resp_raw.decode("utf-8")))
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
                "autoCompactionEnabled": auto_compaction,
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
        if mode == "duplicate_thinking_levels":
            levels = ["off", "low", "low", "medium", "high", "off"]
        elif mode == "no_off_thinking" or current_model.get("id") == "no-off-model":
            levels = ["low", "medium", "high"]
        else:
            levels = ["off", "minimal", "low", "medium", "high"]
        send({"id": cid, "type": "response", "command": "get_available_thinking_levels", "success": True, "data": {"levels": levels}})
    elif ctype == "set_thinking_level":
        req_lvl = cmd.get("level")
        if mode == "no_off_thinking" or current_model.get("id") == "no-off-model":
            thinking_level = "low" if req_lvl == "off" else req_lvl
        else:
            thinking_level = req_lvl
        send({"id": cid, "type": "response", "command": "set_thinking_level", "success": True})
    elif ctype == "review_wait":
        continue
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
                    {"name": "mcp", "description": "Manage MCP servers", "source": "extension", "sourceInfo": {"path": "builtin:mcp", "scope": "temporary"}},
                    {"name": "llama", "description": "Manage llama.cpp", "source": "extension", "sourceInfo": {"path": "builtin:llama.cpp", "scope": "temporary"}},
                    {"name": "undo", "description": "Unsupported TUI undo", "source": "extension", "sourceInfo": {"scope": "user"}},
                    {"name": "settings", "description": "TUI settings", "source": "extension", "sourceInfo": {"scope": "user"}},
                ],
            },
        })
    elif ctype == "set_auto_compaction":
        auto_compaction = bool(cmd.get("enabled", True))
        send({"id": cid, "type": "response", "command": "set_auto_compaction", "success": True})
    elif ctype == "get_last_assistant_text":
        send({"id": cid, "type": "response", "command": "get_last_assistant_text", "success": True, "data": {"text": "Pi last reply"}})
    elif ctype == "get_tree":
        send({"id": cid, "type": "response", "command": "get_tree", "success": True, "data": {"leafId": "e2", "tree": [{"entry": {"id": "e1", "type": "message", "message": {"role": "user"}}, "children": [{"entry": {"id": "e2", "type": "message", "message": {"role": "assistant"}}, "children": []}]}]}})
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
        if mode == "idle_compact_ui":
            send({"type": "extension_ui_request", "id": "idle-ff-1", "method": "notify", "message": "compacting", "notifyType": "info"})
            send({"type": "extension_ui_request", "id": "idle-compact-confirm", "method": "confirm", "title": "Compact?", "message": "Proceed?"})
            resp_raw = sys.stdin.buffer.readline()
            if resp_raw:
                log_line(os.environ.get("FAKE_UI_RESP_LOG"), json.loads(resp_raw.decode("utf-8")))
        mode = "null_context_stats"
        send({"id": cid, "type": "response", "command": "compact", "success": True, "data": {"summary": "compacted", "firstKeptEntryId": "e1", "tokensBefore": 5000}})
    elif ctype == "clone":
        if mode == "clone_ui_dialog":
            send({"type": "extension_ui_request", "id": "clone-ui-1", "method": "input", "title": "Clone note?"})
            resp_raw = sys.stdin.buffer.readline()
            if resp_raw:
                log_line(os.environ.get("FAKE_UI_RESP_LOG"), json.loads(resp_raw.decode("utf-8")))
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
        if mode == "root_fork_empty":
            message_count = 0
        send({"id": cid, "type": "response", "command": "fork", "success": True, "data": {"text": "hello", "cancelled": False}})
    elif ctype == "steer":
        send({"id": cid, "type": "response", "command": "steer", "success": True, "data": {"disposition": "queued"}})
    elif ctype == "follow_up":
        send({"id": cid, "type": "response", "command": "follow_up", "success": True, "data": {"disposition": "queued"}})
    elif ctype == "abort":
        send({"id": cid, "type": "response", "command": "abort", "success": True})
        if mode != "handled_idle_abort":
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
        elif mode == "handled_late_run":
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "handled"}})
            def delayed_run():
                time.sleep(0.05)
                send({"type": "agent_start"})
                send({"type": "message_start", "message": {"role": "assistant", "content": []}})
                send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "late-run"}})
                send({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "late-run"}], "stopReason": "stop"}})
                send({"type": "agent_end", "messages": []})
                send({"type": "agent_settled", "aborted": False})
            threading.Thread(target=delayed_run, daemon=True).start()
        elif mode == "handled_idle_abort":
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
            # Unknown dialog -> expect immediate cancelled:true
            send({"type": "extension_ui_request", "id": "uk-1", "method": "unsupported_modal", "title": "Unknown"})
            uk_resp = json.loads(sys.stdin.buffer.readline().decode("utf-8"))
            log_line(os.environ.get("FAKE_UI_RESP_LOG"), uk_resp)
            # Editor dialog -> expect client response
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
        elif mode == "compaction_end_turn":
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "started"}})
            send({"type": "agent_start"})
            send({"type": "message_start", "message": {"role": "assistant", "content": []}})
            send({"type": "message_end", "message": {
                "role": "assistant",
                "provider": "anthropic",
                "model": "claude-sonnet-4",
                "content": [{"type": "text", "text": "before compact"}],
                "usage": {"input": 100, "output": 50, "cacheRead": 0, "cacheWrite": 0, "cost": {"total": 0.01}},
                "stopReason": "stop",
            }})
            send({"type": "compaction_end", "reason": "threshold", "result": {"summary": "sum", "firstKeptEntryId": "e1", "tokensBefore": 150, "usage": {"input": 20, "output": 10, "cacheRead": 0, "cacheWrite": 0, "cost": {"total": 0.005}}}, "aborted": False, "willRetry": False})
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

test('buildPiChildEnv strips GATEWAY_*, PORT, NODE_ENV, and PI_WEB_PASSWORD env vars from spawned Pi child', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-env-strip-'));
  let adapter: PiProviderAdapter | undefined;
  const prevGatewayToken = process.env.GATEWAY_TOKEN;
  const prevGatewayPort = process.env.GATEWAY_PORT;
  const prevPort = process.env.PORT;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevPassword = process.env.PI_WEB_PASSWORD;
  try {
    process.env.GATEWAY_TOKEN = 'secret-gateway-token';
    process.env.GATEWAY_PORT = '58629';
    process.env.PORT = '8080';
    process.env.NODE_ENV = 'production';
    process.env.PI_WEB_PASSWORD = 'super-secret-password';

    const built = buildPiChildEnv({
      GATEWAY_EXTRA: 'should-be-stripped',
      PI_CODING_AGENT_DIR: base,
    });
    assert.equal('GATEWAY_TOKEN' in built, false);
    assert.equal('GATEWAY_PORT' in built, false);
    assert.equal('GATEWAY_EXTRA' in built, false);
    assert.equal('PORT' in built, false);
    assert.equal('NODE_ENV' in built, false);
    assert.equal('PI_WEB_PASSWORD' in built, false);
    assert.equal(built.PI_CODING_AGENT_DIR, base);

    // Also verify stripping when passed directly in extraEnv
    const builtFromExtra = buildPiChildEnv({
      PORT: '9000',
      NODE_ENV: 'development',
      PI_WEB_PASSWORD: 'plain-password',
      GATEWAY_KEY: 'strip-me',
    });
    assert.equal('PORT' in builtFromExtra, false);
    assert.equal('NODE_ENV' in builtFromExtra, false);
    assert.equal('PI_WEB_PASSWORD' in builtFromExtra, false);
    assert.equal('GATEWAY_KEY' in builtFromExtra, false);

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
    assert.equal('PORT' in childEnv, false);
    assert.equal('NODE_ENV' in childEnv, false);
    assert.equal('PI_WEB_PASSWORD' in childEnv, false);
    assert.equal(childEnv.PI_CODING_AGENT_DIR, base);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    if (prevGatewayToken === undefined) delete process.env.GATEWAY_TOKEN;
    else process.env.GATEWAY_TOKEN = prevGatewayToken;
    if (prevGatewayPort === undefined) delete process.env.GATEWAY_PORT;
    else process.env.GATEWAY_PORT = prevGatewayPort;
    if (prevPort === undefined) delete process.env.PORT;
    else process.env.PORT = prevPort;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = prevPassword;
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
  assert.equal(caps.approvals, true);
  assert.equal(caps.manualApproval, true);
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
    (e: unknown) => e instanceof ProviderError && e.code === 'not_found',
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

test('bridges editor/select/confirm/input extension UI safely and fails closed on unsupported/invalid/timeout/disconnect', async () => {
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
          if (p.questionId === 'ed-1') {
            await adapter!.resolveQuestion(sess.id, p.questionId, 'edited-body');
          } else if (p.questionId === 'cf-1') {
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
      { type: 'extension_ui_response', id: 'uk-1', cancelled: true },
      { type: 'extension_ui_response', id: 'ed-1', value: 'edited-body' },
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
    assert.ok(models[0]?.capabilities?.includes('vision'));
    assert.ok(models[0]?.capabilities?.includes('thinking'));
    assert.equal(models[0]?.supportsThinkingOff, true);
    assert.equal(models[0]?.capabilities?.includes('always_thinking'), false);
    assert.equal(models[1]?.support_efforts?.includes('off'), false);
    assert.equal(models[1]?.supportsThinkingOff, false);
    assert.equal(models[1]?.capabilities?.includes('always_thinking'), true);

    const sess = await adapter.create({ provider: 'pi', cwd: base });
    const levels = await adapter.listThinkingLevels(sess.id);
    assert.deepEqual(levels, ['low', 'medium', 'high']);

    // Setting `off` when model lacks `off` reads back Pi's clamped `low` via `get_state`
    // without issuing a redundant get_available_thinking_levels RPC on the live process.
    await drainEvents(await adapter.startTurn({ sessionId: sess.id, input: 'warm-live' }));
    const beforeSetCount = (await readFile(stdinLog, 'utf8')).trim().split('\n').length;
    await adapter.setThinking(sess.id, 'off');
    assert.equal(adapter.getThinking(sess.id), 'low');
    assert.equal(((adapter as any).inner as any).appliedPreferences.get(sess.id)?.thinking, 'low');
    const afterSetLines = (await readFile(stdinLog, 'utf8'))
      .trim()
      .split('\n')
      .slice(beforeSetCount)
      .map((l) => (JSON.parse(l) as { cmd: { type: string } }).cmd.type);
    assert.deepEqual(afterSetLines, ['set_thinking_level', 'get_state']);

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
      .find((c) => c.type === 'prompt' && c.message === '/skill:deploy prod');
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

test('real isolated pi --mode rpc smoke verification against local pi 1.5.2', { skip: !REAL_PI_BIN && 'set PI_REAL_BIN to a pi binary' }, async () => {
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

test('SettingsStore restart and __default__ model/thinking preferences sync into PiAdapter startTurn', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-settings-sync-'));
  const sessionsDir = join(base, 'sessions');
  const settingsPath = join(base, 'pi-settings.json');
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin, stdinLog } = await writeContractFakePi(base);
    const cwdDir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(cwdDir, { recursive: true });
    const resumedId = '66666666-6666-4666-8666-666666666666';
    await writeFile(join(cwdDir, `2026-11-14T21-00-00-000Z_${resumedId}.jsonl`), [
      JSON.stringify({ type: 'session', version: 3, id: resumedId, timestamp: '2026-11-14T21:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-11-14T21:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 } }),
    ].join('\n') + '\n');

    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir,
      settingsPath,
      env: { FAKE_STDIN_LOG: stdinLog },
    });
    await adapter.setModel('__default__', 'openrouter/anthropic/claude-sonnet-4');
    await adapter.setThinking('__default__', 'high');

    const draft = await adapter.create({ provider: 'pi', cwd: base });
    assert.equal(adapter.getModel(draft.id), 'openrouter/anthropic/claude-sonnet-4');
    assert.equal(adapter.getThinking(draft.id), 'high');
    await adapter.dispose();

    // Simulate gateway restart: fresh PiProviderAdapter reads SettingsStore from disk
    // while PiAdapter starts with empty in-memory maps.
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir,
      settingsPath,
      env: { FAKE_STDIN_LOG: stdinLog },
    });
    assert.equal(adapter.getModel(resumedId), 'openrouter/anthropic/claude-sonnet-4');
    assert.equal(adapter.getThinking(resumedId), 'high');

    await drainEvents(await adapter.startTurn({ sessionId: resumedId, input: 'after restart' }));
    const cmds = (await readFile(stdinLog, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).cmd as Record<string, unknown>);
    const setModelIdx = cmds.findIndex(
      (c) => c.type === 'set_model' && c.provider === 'openrouter' && c.modelId === 'anthropic/claude-sonnet-4',
    );
    const setThinkIdx = cmds.findIndex(
      (c) => c.type === 'set_thinking_level' && c.level === 'high',
    );
    const promptIdx = cmds.findIndex((c) => c.type === 'prompt' && c.message === 'after restart');
    assert.ok(setModelIdx >= 0 && setThinkIdx > setModelIdx && promptIdx > setThinkIdx, JSON.stringify(cmds));
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('fails closed {cancelled:true} on extension_ui_request outside active turns (startup, compact, clone)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-ui-outside-turn-'));
  const sessionsDir = join(base, 'sessions');
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin, uiRespLog } = await writeContractFakePi(base);
    const cwdDir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(cwdDir, { recursive: true });
    const sid = '77777777-7777-4777-8777-777777777777';
    await writeFile(join(cwdDir, `2026-11-14T21-00-00-000Z_${sid}.jsonl`), [
      JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-14T21:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-11-14T21:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 } }),
    ].join('\n') + '\n');

    // 1. UI dialog during idle compact -> fail-closed {cancelled:true}, fire-and-forget ignored
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir,
      env: { FAKE_PI_MODE: 'idle_compact_ui', FAKE_UI_RESP_LOG: uiRespLog },
    });
    await adapter.compact(sid);
    await adapter.dispose();

    // 2. UI dialog during clone -> fail-closed {cancelled:true}
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir,
      env: { FAKE_PI_MODE: 'clone_ui_dialog', FAKE_UI_RESP_LOG: uiRespLog },
    });
    const cloned = await adapter.clone(sid);
    assert.notEqual(cloned.id, sid);
    await adapter.dispose();

    // 3. UI dialog during process startup (get_state) -> fail-closed {cancelled:true}
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir,
      env: { FAKE_PI_MODE: 'startup_ui_dialog', FAKE_UI_RESP_LOG: uiRespLog },
    });
    await drainEvents(await adapter.startTurn({ sessionId: sid, input: 'ok' }));

    const uiResps = (await readFile(uiRespLog, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(uiResps, [
      { type: 'extension_ui_response', id: 'idle-compact-confirm', cancelled: true },
      { type: 'extension_ui_response', id: 'clone-ui-1', cancelled: true },
      { type: 'extension_ui_response', id: 'startup-cf', cancelled: true },
    ]);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('clone/fork reject busy sessions with 409 and root-message fork keeps empty draft history', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-clone-busy-root-'));
  const sessionsDir = join(base, 'sessions');
  let piAdapter: PiAdapter | undefined;
  try {
    const { bin } = await writeContractFakePi(base);
    const cwdDir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(cwdDir, { recursive: true });
    const sid = '88888888-8888-4888-8888-888888888888';
    await writeFile(join(cwdDir, `2026-11-14T21-00-00-000Z_${sid}.jsonl`), [
      JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-14T21:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-11-14T21:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'root' }], timestamp: 1 } }),
    ].join('\n') + '\n');

    // 1. Busy session rejects clone and fork with 409 busy
    piAdapter = new PiAdapter({
      piBin: bin,
      sessionsDir,
      env: { FAKE_PI_MODE: 'wait_for_abort' },
    });
    const turn = await piAdapter.startTurn(sid, 'running');
    const turnEvs = drainEvents(turn);
    await assert.rejects(
      piAdapter.clone(sid),
      (e: unknown) => e instanceof ProviderError && e.code === 'busy' && e.httpStatus === 409,
    );
    await assert.rejects(
      piAdapter.fork(sid),
      (e: unknown) => e instanceof ProviderError && e.code === 'busy' && e.httpStatus === 409,
    );
    await piAdapter.abort(sid);
    await turnEvs;
    await piAdapter.dispose();

    // 2. Root-message fork (messageCount: 0, no file yet) returns [] on getHistory instead of 404
    piAdapter = new PiAdapter({
      piBin: bin,
      sessionsDir,
      env: { FAKE_PI_MODE: 'root_fork_empty', FAKE_SESSIONS_DIR: cwdDir },
    });
    const forked = await piAdapter.fork(sid, 'u1');
    assert.deepEqual(await piAdapter.getHistory(forked.sessionId), []);
    await piAdapter.dispose();

    // 3. Also verify root-message fork against real local pi 1.5.2 binary
    const realBase = await mkdtemp(join(tmpdir(), 'pi-real-root-fork-'));
    const realSessions = join(realBase, 'agent', 'sessions');
    const realWork = join(realBase, 'work');
    let realAdapter: PiAdapter | undefined;
    try {
      await mkdir(realWork, { recursive: true });
      const realCwdDir = join(realSessions, encodePiCwdDir(realWork));
      await mkdir(realCwdDir, { recursive: true });
      const rSid = '99999999-9999-4999-8999-999999999999';
      await writeFile(join(realCwdDir, `2026-11-14T21-00-00-000Z_${rSid}.jsonl`), [
        JSON.stringify({ type: 'session', version: 3, id: rSid, timestamp: '2026-11-14T21:00:00.000Z', cwd: realWork }),
        JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-11-14T21:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'first' }], timestamp: 1 } }),
        JSON.stringify({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-11-14T21:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }], stopReason: 'stop', timestamp: 2 } }),
      ].join('\n') + '\n');

      realAdapter = new PiAdapter({
        piBin: REAL_PI_BIN,
        sessionsDir: realSessions,
        extraArgs: ['--offline', '--no-extensions', '--no-skills', '--no-prompt-templates'],
        env: { HOME: realBase, PI_CODING_AGENT_DIR: join(realBase, 'agent') },
      });
      const rootForked = await realAdapter.fork(rSid, 'm1');
      assert.notEqual(rootForked.sessionId, rSid);
      assert.deepEqual(await realAdapter.getHistory(rootForked.sessionId), []);
    } finally {
      await realAdapter?.dispose().catch(() => undefined);
      await rm(realBase, { recursive: true, force: true });
    }
  } finally {
    await piAdapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('StdinLineWriter endAndFlush timeout and abort reject both in-flight and queued writes', async () => {
  // 1. Backpressured / stalled write times out in endAndFlush -> rejects both in-flight and queued
  const stalledStream = new PassThrough();
  (stalledStream as any).write = () => false; // Never invokes callback and never drains!
  const writer1 = new StdinLineWriter(stalledStream);
  const inFlight = writer1.writeLine('{"id":"a"}\n');
  const queued = writer1.writeLine('{"id":"b"}\n');
  await writer1.endAndFlush(25);
  await assert.rejects(inFlight, /stdin closed before flush completed/);
  await assert.rejects(queued, /stdin closed before flush completed/);

  // 2. Explicit abort rejects in-flight write whose callback has not fired
  const stalledStream2 = new PassThrough();
  (stalledStream2 as any).write = () => true; // Callback intentionally never called
  const writer2 = new StdinLineWriter(stalledStream2);
  const p = writer2.writeLine('{"id":"c"}\n');
  await new Promise((r) => setTimeout(r, 10));
  writer2.abort(new Error('stream aborted'));
  await assert.rejects(p, /stream aborted/);

  // 3. Microtask race: Writable invokes cb() synchronously/on nextTick while abort() runs on nextTick
  const fastWritable = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const writer3 = new StdinLineWriter(fastWritable);
  const p3 = writer3.writeLine('{"id":"d"}\n');
  process.nextTick(() => writer3.abort(new Error('boom')));
  await p3; // Must settle (resolve once cb() ran) rather than staying pending indefinitely

  // 4. Microtask race: abort() runs on nextTick BEFORE deferred Writable cb() runs
  const deferredCbs: Array<(err?: Error | null) => void> = [];
  const slowWritable = new Writable({
    write(_chunk, _enc, cb) {
      deferredCbs.push(cb);
    },
  });
  const writer4 = new StdinLineWriter(slowWritable);
  const p4 = writer4.writeLine('{"id":"e"}\n');
  process.nextTick(() => writer4.abort(new Error('boom')));
  await assert.rejects(p4, /boom/);
  deferredCbs[0]?.();

  // 5. Synchronous throw inside stream.write rejects cleanly
  const throwingStream = new PassThrough();
  (throwingStream as any).write = () => {
    throw new Error('sync write boom');
  };
  const writer5 = new StdinLineWriter(throwingStream);
  await assert.rejects(writer5.writeLine('{"id":"f"}\n'), /sync write boom/);
});

test('StdinLineWriter handles real Writable, PassThrough, and child.stdin OS pipe backpressure without losing drain', async () => {
  // 1. Real Node Writable with highWaterMark: 1 and async cb (Node emits 'drain' in same turn as cb)
  const receivedWritable: string[] = [];
  const realWritable = new Writable({
    highWaterMark: 1,
    write(chunk, _enc, cb) {
      receivedWritable.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      setTimeout(cb, 5);
    },
  });
  const w1 = new StdinLineWriter(realWritable);
  await Promise.all([
    w1.writeLine('line1\n'),
    w1.writeLine('line2\n'),
    w1.writeLine('line3\n'),
  ]);
  await w1.endAndFlush();
  assert.equal(receivedWritable.join(''), 'line1\nline2\nline3\n');

  // 2. Real PassThrough with highWaterMark: 1 and delayed consumer
  const pt = new PassThrough({ highWaterMark: 1 });
  const ptChunks: string[] = [];
  const w2 = new StdinLineWriter(pt);
  const ptWrites = Promise.all([
    w2.writeLine('alpha-long-line\n'),
    w2.writeLine('beta-long-line\n'),
    w2.writeLine('gamma\n'),
  ]);
  setTimeout(() => {
    pt.on('data', (chunk: Buffer) => ptChunks.push(chunk.toString('utf8')));
  }, 15);
  await ptWrites;
  await w2.endAndFlush();
  assert.equal(ptChunks.join(''), 'alpha-long-line\nbeta-long-line\ngamma\n');

  // 3. Real child_process.spawn child.stdin OS pipe backpressure (200KB line + follow-up line)
  const child = spawn(
    process.execPath,
    [
      '-e',
      'setTimeout(() => { let n = 0; process.stdin.on("data", (d) => { n += d.length; }); process.stdin.on("end", () => { process.stdout.write(String(n)); }); }, 20);',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '';
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
  const bigLine = `${'x'.repeat(200_000)}\n`;
  const smallLine = 'small\n';
  const w3 = new StdinLineWriter(child.stdin);
  await Promise.all([
    w3.writeLine(bigLine),
    w3.writeLine(smallLine),
  ]);
  await w3.endAndFlush();
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  assert.equal(Number(stdout), bigLine.length + smallLine.length);

  // 4. PiRpcClient end-to-end with 200KB payload followed by a second request
  const base = await mkdtemp(join(tmpdir(), 'pi-bp-rpc-'));
  let rpcClient: PiRpcClient | undefined;
  try {
    const script = `#!/usr/bin/env python3
import json, sys, time
time.sleep(0.02)
for raw in sys.stdin.buffer:
    line = raw.decode("utf-8").strip()
    if not line:
        continue
    cmd = json.loads(line)
    sys.stdout.write(json.dumps({"id": cmd["id"], "type": "response", "command": cmd["type"], "success": True, "data": {"len": len(line)}}) + "\\n")
    sys.stdout.flush()
`;
    const bin = await writeFakePiScript(base, script);
    rpcClient = new PiRpcClient({ piBin: bin, cwd: base, requestTimeoutMs: 5_000 });
    rpcClient.start();
    const [r1, r2] = await Promise.all([
      rpcClient.request<{ len: number }>({ type: 'prompt', message: 'y'.repeat(200_000) }),
      rpcClient.request<{ len: number }>({ type: 'get_state' }),
    ]);
    assert.ok(r1.len > 200_000);
    assert.ok(r2.len > 0 && r2.len < 200);
  } finally {
    await rpcClient?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('symlinked sessionsRoot works, intermediate symlinked dir fails, string context_edit on toolResult and compaction_end usage work', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-root-edit-compact-'));
  const realRoot = join(base, 'real-sessions');
  const linkRoot = join(base, 'link-sessions');
  let adapter: PiProviderAdapter | undefined;
  try {
    const cwdDir = join(realRoot, encodePiCwdDir(base));
    await mkdir(cwdDir, { recursive: true });
    await symlink(realRoot, linkRoot);

    const sid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const fileName = `2026-11-14T21-00-00-000Z_${sid}.jsonl`;
    const fileViaLink = join(linkRoot, encodePiCwdDir(base), fileName);
    await writeFile(join(cwdDir, fileName), [
      JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-14T21:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-11-14T21:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'run' }], timestamp: 1 } }),
      JSON.stringify({ type: 'message', id: 'tr1', parentId: 'u1', timestamp: '2026-11-14T21:00:02.000Z', message: { role: 'toolResult', toolCallId: 'tc1', toolName: 'bash', content: [{ type: 'text', text: 'raw output' }], isError: false, timestamp: 2 } }),
      JSON.stringify({ type: 'context_edit', id: 'ce1', parentId: 'tr1', timestamp: '2026-11-14T21:00:03.000Z', targetId: 'tr1', replacement: { content: 'redacted string output' } }),
    ].join('\n') + '\n');

    // Symlinked sessionsRoot + string context_edit replacement on toolResult
    const history = await readPiActiveBranchHistory(fileViaLink, {
      sessionId: sid,
      sessionsRoot: linkRoot,
    });
    assert.equal(history.length, 2);
    assert.equal(history[1]?.role, 'tool');
    assert.equal(
      (history[1]?.content[0] as { type: 'tool_result'; output: string }).output,
      'redacted string output',
    );

    // Intermediate symlinked directory inside sessionsRoot must still be rejected
    const outsideDir = join(base, 'outside-dir');
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, 'evil.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'evil', cwd: base }) + '\n');
    await symlink(outsideDir, join(realRoot, 'symlink-cwd-dir'));
    await assert.rejects(
      readPiActiveBranchHistory(join(linkRoot, 'symlink-cwd-dir', 'evil.jsonl'), {
        sessionId: 'evil',
        sessionsRoot: linkRoot,
      }),
      (e: unknown) => e instanceof ProviderError && e.code === 'not_found',
    );

    // compaction_end clears stale pre-compaction context_tokens and marks context_unavailable: true
    const { bin } = await writeContractFakePi(base);
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: linkRoot,
      env: { FAKE_PI_MODE: 'compaction_end_turn' },
    });
    const s = await adapter.create({ provider: 'pi', cwd: base });
    await drainEvents(await adapter.startTurn({ sessionId: s.id, input: 'go' }));
    const usage = adapter.getUsage(s.id);
    assert.equal(usage?.input_tokens, 120);
    assert.equal(usage?.output_tokens, 60);
    assert.equal(usage?.context_tokens, 0);
    assert.equal(usage?.context_unavailable, true);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('keeps turn active after disposition=handled for delayed agent_start runs and supports idle abort', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-handled-late-'));
  let lateAdapter: PiProviderAdapter | undefined;
  let abortAdapter: PiProviderAdapter | undefined;
  try {
    const { bin } = await writeContractFakePi(base);

    // 1. Extension command returns disposition=handled, then fires async agent_start 50ms later
    lateAdapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions-late'),
      handledGraceMs: 200,
      env: { FAKE_PI_MODE: 'handled_late_run' },
    });
    const s1 = await lateAdapter.create({ provider: 'pi', cwd: base });
    const handle1 = await lateAdapter.startTurn({ sessionId: s1.id, input: '/ext-async' });

    // Session must remain busy (409) until the delayed run emits agent_settled
    await assert.rejects(
      lateAdapter.startTurn({ sessionId: s1.id, input: 'overlap' }),
      (e: unknown) => e instanceof ProviderError && e.httpStatus === 409,
    );

    const events1 = await drainEvents(handle1);
    const deltas1 = events1
      .filter((e) => e.kind === 'message' && e.status === 'delta')
      .map((e) => (e.payload as { delta: string }).delta);
    assert.deepEqual(deltas1, ['late-run']);
    assert.equal(events1.at(-1)?.kind, 'turn');
    assert.equal(events1.at(-1)?.status, 'completed');

    // After agent_settled, a subsequent turn is allowed
    const events1Followup = await drainEvents(await lateAdapter.startTurn({ sessionId: s1.id, input: '/ext-async-2' }));
    assert.equal(events1Followup.at(-1)?.status, 'completed');

    // 2. Abort during the disposition=handled grace window settles cancelled without hanging
    abortAdapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions-abort'),
      handledGraceMs: 500,
      env: { FAKE_PI_MODE: 'handled_idle_abort' },
    });
    const s2 = await abortAdapter.create({ provider: 'pi', cwd: base });
    const handle2 = await abortAdapter.startTurn({ sessionId: s2.id, input: '/ext-idle' });
    await abortAdapter.interrupt(s2.id, handle2.turnId);
    const events2 = await drainEvents(handle2);
    assert.equal(events2.at(-1)?.kind, 'turn');
    assert.equal(events2.at(-1)?.status, 'cancelled');
  } finally {
    await lateAdapter?.dispose().catch(() => undefined);
    await abortAdapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('exposes Pi builtin extension commands (mcp/llama) and Web UI RPC helpers (auto-compact, copy, tree)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-web-rpc-cmds-'));
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin } = await writeContractFakePi(base);
    adapter = new PiProviderAdapter({ piBin: bin, sessionsDir: join(base, 'sessions') });
    const s = await adapter.create({ provider: 'pi', cwd: base });
    const cmds = await adapter.listCommands(s.id);
    assert.ok(cmds.some((c) => c.name === 'mcp'));
    assert.ok(cmds.some((c) => c.name === 'llama'));
    assert.ok(cmds.some((c) => c.name === 'auto-compact'));
    assert.ok(cmds.some((c) => c.name === 'tree'));
    assert.ok(cmds.some((c) => c.name === 'copy'));
    assert.ok(cmds.some((c) => c.name === 'name'));
    assert.ok(cmds.some((c) => c.name === 'thinking'));

    assert.equal(await adapter.getAutoCompaction(s.id), true);
    assert.equal(await adapter.setAutoCompaction(s.id, false), false);
    assert.equal(await adapter.getAutoCompaction(s.id), false);
    await (adapter as unknown as { inner: { ensureSessionProcess(id: string): Promise<unknown> } }).inner.ensureSessionProcess(s.id);
    assert.equal(await adapter.getLastAssistantText(s.id), 'Pi last reply');
    const tree = await adapter.getSessionTree(s.id);
    assert.equal(tree?.leafId, 'e2');
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('PiProviderAdapter prioritizes settings.json defaultProvider/defaultModel in listModels and getModel(__default__)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-default-model-settings-'));
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin } = await writeContractFakePi(base);
    await writeFile(
      join(base, 'settings.json'),
      JSON.stringify({ defaultProvider: 'openrouter', defaultModel: 'anthropic/claude-sonnet-4' }),
    );
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      env: { PI_CODING_AGENT_DIR: base, FAKE_PI_MODE: 'no_off_thinking' },
    });
    const models = await adapter.listModels();
    assert.equal(models[0]?.model, 'openrouter/anthropic/claude-sonnet-4');
    assert.equal(models[0]?.isDefault, true);
    assert.equal(adapter.getModel('__default__'), 'openrouter/anthropic/claude-sonnet-4');
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('thinking level deduplication in getAvailableThinkingLevels and listThinkingLevels', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-thinking-dedup-'));
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin, stdinLog } = await writeContractFakePi(base);
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      env: { FAKE_STDIN_LOG: stdinLog, FAKE_PI_MODE: 'duplicate_thinking_levels' },
    });

    const sess = await adapter.create({ provider: 'pi', cwd: base });
    // 1. Thinking level deduplication via listThinkingLevels
    const levels = await adapter.listThinkingLevels(sess.id);
    assert.deepEqual(levels, ['off', 'low', 'medium', 'high']);

    // Direct check on inner PiAdapter getAvailableThinkingLevels
    const innerLevels = await (adapter as any).inner.getAvailableThinkingLevels(sess.id);
    assert.deepEqual(innerLevels, ['off', 'low', 'medium', 'high']);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('clamped appliedPreferences synchronization in setThinkingLevel and fork/clone', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-applied-prefs-'));
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin, stdinLog } = await writeContractFakePi(base);
    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      env: { FAKE_STDIN_LOG: stdinLog, FAKE_PI_MODE: 'no_off_thinking' },
    });

    const sess = await adapter.create({ provider: 'pi', cwd: base });
    const inner = (adapter as any).inner;

    // Create a saved session on disk so clone/fork succeeds
    const cwdDir = join(base, 'sessions', encodePiCwdDir(base));
    await mkdir(cwdDir, { recursive: true });
    const fileName = `2026-11-14T22-00-00-000Z_${sess.id}.jsonl`;
    await writeFile(
      join(cwdDir, fileName),
      [
        JSON.stringify({ type: 'session', version: 3, id: sess.id, timestamp: '2026-11-14T22:00:00.000Z', cwd: base }),
        JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-11-14T22:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
        JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-11-14T22:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }),
      ].join('\n') + '\n',
    );

    // Ensure sess has a live process so setThinking hits live RPC clamping,
    // then clone/fork inherit the clamped effective level 'low' in appliedPreferences.
    await drainEvents(await adapter.startTurn({ sessionId: sess.id, input: 'hi' }));

    // Requesting 'off' is clamped by the model/mode to 'low'.
    // appliedPreferences must record the clamped effective level 'low', not 'off'.
    await adapter.setThinking(sess.id, 'off');
    assert.equal(adapter.getThinking(sess.id), 'low');
    assert.equal(inner.appliedPreferences.get(sess.id)?.thinking, 'low');

    // Clone session — should inherit the clamped effective level 'low' in appliedPreferences
    const cloned = await adapter.clone(sess.id);
    assert.equal(adapter.getThinking(cloned.id), 'low');
    assert.equal(inner.appliedPreferences.get(cloned.id)?.thinking, 'low');

    // Fork session — should also record the clamped effective level 'low' in appliedPreferences
    const forked = await adapter.fork(sess.id);
    assert.equal(adapter.getThinking(forked.id), 'low');
    assert.equal(inner.appliedPreferences.get(forked.id)?.thinking, 'low');
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('parsePiSessionEntry and readPiActiveBranchHistory map bashExecution to assistant tool_use and tool result', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-bash-exec-'));
  try {
    // 1. Direct unit test of parsePiSessionEntry for role === 'bashExecution'
    const entrySuccess = {
      type: 'message',
      id: 'entry_cmd_1',
      timestamp: '2026-11-14T22:00:00.000Z',
      message: {
        role: 'bashExecution',
        command: 'npm test',
        output: 'All 10 tests passed',
        exitCode: 0,
        timestamp: 1763157600000,
      },
    };
    const mapped = parsePiSessionEntry(entrySuccess, 'test-session-id');
    assert.ok(Array.isArray(mapped));
    assert.equal(mapped.length, 2);

    const [callMsg, resultMsg] = mapped;
    assert.equal(callMsg?.id, 'entry_cmd_1_call');
    assert.equal(callMsg?.session_id, 'test-session-id');
    assert.equal(callMsg?.role, 'assistant');
    assert.deepEqual(callMsg?.content, [
      {
        type: 'tool_use',
        tool_call_id: 'call_entry_cmd_1',
        tool_name: 'bash',
        input: { command: 'npm test' },
      },
    ]);

    assert.equal(resultMsg?.id, 'entry_cmd_1_result');
    assert.equal(resultMsg?.session_id, 'test-session-id');
    assert.equal(resultMsg?.role, 'tool');
    assert.deepEqual(resultMsg?.content, [
      {
        type: 'tool_result',
        tool_call_id: 'call_entry_cmd_1',
        output: 'All 10 tests passed',
        is_error: false,
      },
    ]);

    // Error case with custom toolCallId and non-zero exitCode
    const entryError = {
      type: 'message',
      id: 'entry_cmd_2',
      timestamp: '2026-11-14T22:01:00.000Z',
      message: {
        role: 'bashExecution',
        toolCallId: 'custom_bash_call',
        command: 'cat missing.txt',
        output: 'cat: missing.txt: No such file or directory',
        exitCode: 1,
      },
    };
    const mappedError = parsePiSessionEntry(entryError, 'test-session-id');
    assert.ok(Array.isArray(mappedError));
    assert.equal(mappedError.length, 2);
    assert.equal((mappedError[0]?.content[0] as any)?.tool_call_id, 'custom_bash_call');
    assert.equal((mappedError[1]?.content[0] as any)?.tool_call_id, 'custom_bash_call');
    assert.equal((mappedError[1]?.content[0] as any)?.is_error, true);
    assert.equal((mappedError[1]?.content[0] as any)?.output, 'cat: missing.txt: No such file or directory');

    // 2. Integration test via readPiActiveBranchHistory on disk
    const sessionsDir = join(base, 'sessions');
    const cwdDir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(cwdDir, { recursive: true });
    const sid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const filePath = join(cwdDir, `2026-11-14T22-00-00-000Z_${sid}.jsonl`);
    await writeFile(
      filePath,
      [
        JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-14T22:00:00.000Z', cwd: base }),
        JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-11-14T22:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'run status' }] } }),
        JSON.stringify({
          type: 'message',
          id: 'b1',
          parentId: 'u1',
          timestamp: '2026-11-14T22:00:02.000Z',
          message: { role: 'bashExecution', command: 'git status', output: 'clean', exitCode: 0 },
        }),
        JSON.stringify({ type: 'message', id: 'a1', parentId: 'b1', timestamp: '2026-11-14T22:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'All clean!' }] } }),
      ].join('\n') + '\n',
    );

    const history = await readPiActiveBranchHistory(filePath, { sessionId: sid, sessionsRoot: sessionsDir });
    assert.equal(history.length, 4);
    assert.equal(history[0]?.role, 'user');
    assert.equal(history[1]?.role, 'assistant');
    assert.equal(history[1]?.content[0]?.type, 'tool_use');
    assert.equal((history[1]?.content[0] as any)?.tool_name, 'bash');
    assert.deepEqual((history[1]?.content[0] as any)?.input, { command: 'git status' });

    assert.equal(history[2]?.role, 'tool');
    assert.equal(history[2]?.content[0]?.type, 'tool_result');
    assert.equal((history[2]?.content[0] as any)?.output, 'clean');
    assert.equal((history[2]?.content[0] as any)?.is_error, false);

    assert.equal(history[3]?.role, 'assistant');
    assert.equal((history[3]?.content[0] as any)?.text, 'All clean!');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('disk-only methods and idle setModel/setThinkingLevel do not spawn session processes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-disk-fallbacks-'));
  const sessionsDir = join(base, 'sessions');
  const agentDir = base;
  let adapter: PiProviderAdapter | undefined;
  try {
    const { bin, argvLog, stdinLog } = await writeContractFakePi(base);

    // Create session file on disk
    const sid = '12345678-1234-4234-8234-123456789abc';
    const cwdDir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(cwdDir, { recursive: true });
    const sessFile = join(cwdDir, `2026-11-15T00-00-00-000Z_${sid}.jsonl`);
    await writeFile(
      sessFile,
      [
        JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-15T00:00:00.000Z', cwd: base }),
        JSON.stringify({ type: 'session_info', id: 'info1', parentId: null, timestamp: '2026-11-15T00:00:01.000Z', name: 'Disk Title' }),
        JSON.stringify({ type: 'model_change', id: 'mc1', parentId: 'info1', timestamp: '2026-11-15T00:00:02.000Z', provider: 'anthropic', modelId: 'claude-sonnet-4' }),
        JSON.stringify({ type: 'thinking_level_change', id: 'tc1', parentId: 'mc1', timestamp: '2026-11-15T00:00:03.000Z', thinkingLevel: 'high' }),
        JSON.stringify({ type: 'message', id: 'u1', parentId: 'tc1', timestamp: '2026-11-15T00:00:04.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello from disk' }] } }),
        JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-11-15T00:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'reply from disk' }], usage: { input: 120, output: 60, cacheRead: 15, cacheWrite: 5, totalTokens: 200, cost: { total: 0.004 } } } }),
        JSON.stringify({ type: 'usage', id: 'u-extra', parentId: 'a1', timestamp: '2026-11-15T00:00:06.000Z', kind: 'summary', provider: 'anthropic', model: 'claude-sonnet-4', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } } }),
      ].join('\n') + '\n',
    );

    // Write settings.json with compaction.enabled = false
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false } }), 'utf8');

    adapter = new PiProviderAdapter({
      piBin: bin,
      sessionsDir,
      env: { FAKE_STDIN_LOG: stdinLog, FAKE_ARGV_LOG: argvLog, PI_CODING_AGENT_DIR: agentDir },
    });

    // 1. getState
    const state = await adapter.getSessionState(sid);
    assert.equal(state.sessionId, sid);
    assert.equal(state.sessionName, 'Disk Title');
    assert.equal(state.model?.provider, 'anthropic');
    assert.equal(state.model?.id, 'claude-sonnet-4');
    assert.equal(state.thinkingLevel, 'high');
    assert.equal(state.messageCount, 2);
    assert.equal(state.autoCompactionEnabled, false);

    // 2. getAutoCompaction
    const autoComp = await adapter.getAutoCompaction(sid);
    assert.equal(autoComp, false);

    // 3. getSessionStats (populate modelsCache first via ephemeral --no-session listModels)
    await adapter.listModels();
    const stats = await adapter.getSessionStats(sid);
    assert.equal(stats.sessionId, sid);
    assert.equal(stats.userMessages, 1);
    assert.equal(stats.assistantMessages, 1);
    assert.equal(stats.tokens?.input, 130);
    assert.equal(stats.tokens?.output, 65);
    assert.equal(stats.tokens?.cacheRead, 15);
    assert.equal(stats.tokens?.cacheWrite, 5);
    assert.equal(stats.tokens?.total, 215);
    assert.ok(Math.abs((stats.cost ?? 0) - 0.005) < 1e-9);
    // 200 contextTokens / 200000 default claude-sonnet-4 window -> 0.1% (0-100 scale)
    assert.equal(stats.contextUsage?.tokens, 200);
    assert.equal(stats.contextUsage?.contextWindow, 200000);
    assert.ok(Math.abs((stats.contextUsage?.percent ?? 0) - 0.1) < 1e-6);

    // 4. getSessionTree
    const treeData = await adapter.getSessionTree(sid);
    assert.ok(treeData);
    assert.equal(treeData.leafId, 'u-extra');
    assert.ok(Array.isArray((treeData as any).tree));

    // 5. getLastAssistantText
    const lastText = await adapter.getLastAssistantText(sid);
    assert.equal(lastText, 'reply from disk');

    // 6. getForkMessages
    const forkMsgs = await adapter.getForkMessages(sid);
    assert.deepEqual(forkMsgs, [{ entryId: 'u1', text: 'hello from disk' }]);

    // 7. idle setModel and setThinking (with validation against available models)
    await assert.rejects(
      adapter.setModel(sid, 'bogus/nonexistent-model'),
      (err: unknown) => err instanceof ProviderError && err.code === 'invalid_request',
    );
    await adapter.setModel(sid, 'anthropic/claude-sonnet-4');
    assert.equal(adapter.getModel(sid), 'anthropic/claude-sonnet-4');
    await adapter.setThinking(sid, 'low');
    assert.equal(adapter.getThinking(sid), 'low');

    // Verify argvLog has NO session spawns!
    let argvLines: Array<{ pid: number; args: string[] }> = [];
    try {
      const raw = await readFile(argvLog, 'utf8');
      argvLines = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      // File may not exist if no spawns occurred
    }
    const sessionSpawns = argvLines.filter((l) => l.args.includes('--session') || l.args.includes('--session-id'));
    assert.equal(sessionSpawns.length, 0, 'Must not spawn a session process for disk reads or idle settings');
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('idle process recycling recycles idle process and protects active turns and parked questions', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-recycle-'));
  const sessionsDir = join(base, 'sessions');
  let adapter: PiAdapter | undefined;
  try {
    const { bin, argvLog, stdinLog } = await writeContractFakePi(base);
    adapter = new PiAdapter({
      piBin: bin,
      sessionsDir,
      recycleGraceMs: 60,
      env: { FAKE_STDIN_LOG: stdinLog, FAKE_ARGV_LOG: argvLog },
    });

    // Case 1: normal turn completes, then recycles when idle
    const { sessionId: sess1 } = adapter.create(base, 'Session 1');
    const turn1 = await adapter.startTurn(sess1, 'hello');
    await drainEvents(turn1);

    // Process is currently alive
    const procs = (adapter as any).processes as Map<string, PiRpcClient>;
    assert.equal(procs.get(sess1)?.isAlive, true);

    // Wait past recycleGraceMs (60ms)
    await new Promise((r) => setTimeout(r, 120));

    // Process has been recycled
    assert.equal(procs.has(sess1), false, 'Idle process should be recycled after grace period');
    // Metadata caches preserved
    assert.equal(adapter.getCachedSessionName(sess1), 'Session 1');

    // Case 2: Active turn protection (turn in progress must NOT be recycled)
    let adapterBusy: PiAdapter | undefined;
    try {
      const { bin: binBusy, stdinLog: stdinBusy, argvLog: argvBusy } = await writeContractFakePi(base);
      adapterBusy = new PiAdapter({
        piBin: binBusy,
        sessionsDir,
        recycleGraceMs: 60,
        env: { FAKE_STDIN_LOG: stdinBusy, FAKE_ARGV_LOG: argvBusy, FAKE_PI_MODE: 'wait_for_abort' },
      });
      const sessBusy = '22222222-2222-4222-8222-222222222222';
      const turnBusy = await adapterBusy.startTurn(sessBusy, 'hold');
      const busyProcs = (adapterBusy as any).processes as Map<string, PiRpcClient>;
      assert.equal(busyProcs.get(sessBusy)?.isAlive, true);

      // Wait past grace period
      await new Promise((r) => setTimeout(r, 120));

      // Process must still be alive!
      assert.equal(busyProcs.has(sessBusy), true, 'Process running an active turn must not be recycled');
      assert.equal(adapterBusy.isBusy(sessBusy), true);

      // Abort turn to cleanly finish
      await adapterBusy.abort(sessBusy);
      await drainEvents(turnBusy);
    } finally {
      await adapterBusy?.dispose().catch(() => undefined);
    }

    // Case 3: Parked question protection (unanswered question must NOT be recycled)
    let adapterQ: PiAdapter | undefined;
    try {
      const { bin: binQ, stdinLog: stdinQ, argvLog: argvQ } = await writeContractFakePi(base);
      adapterQ = new PiAdapter({
        piBin: binQ,
        sessionsDir,
        recycleGraceMs: 60,
        env: { FAKE_STDIN_LOG: stdinQ, FAKE_ARGV_LOG: argvQ, FAKE_PI_MODE: 'ui_dialogs' },
      });
      const sessQ = '33333333-3333-4333-8333-333333333333';
      const turnQ = await adapterQ.startTurn(sessQ, 'trigger dialog');
      // Wait for parked confirm question
      for (let i = 0; i < 40; i++) {
        if ((adapterQ as any).parkedQuestions.size > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal((adapterQ as any).parkedQuestions.size, 1);
      const qProcs = (adapterQ as any).processes as Map<string, PiRpcClient>;
      assert.equal(qProcs.get(sessQ)?.isAlive, true);

      // Wait past grace period
      await new Promise((r) => setTimeout(r, 120));

      // Must NOT be recycled while question is parked
      assert.equal(qProcs.has(sessQ), true, 'Process with parked question must not be recycled');

      // Resolve all parked dialogs in sequence: editor ('edited-body'), confirm ('yes'), select ('OptA'), input ('test input')
      const answers = ['edited-body', 'yes', 'OptA', 'test input'];
      for (const ans of answers) {
        for (let i = 0; i < 40; i++) {
          if ((adapterQ as any).parkedQuestions.size > 0) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        const qId = [...(adapterQ as any).parkedQuestions.keys()][0];
        if (qId) await adapterQ.resolveQuestion(sessQ, qId, ans);
      }
      await drainEvents(turnQ);
    } finally {
      await adapterQ?.dispose().catch(() => undefined);
    }
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('maxLiveProcesses evicts oldest-activity idle process and protects busy processes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-lru-'));
  const sessionsDir = join(base, 'sessions');
  let adapter: PiAdapter | undefined;
  try {
    const { bin, argvLog, stdinLog } = await writeContractFakePi(base);
    adapter = new PiAdapter({
      piBin: bin,
      sessionsDir,
      maxLiveProcesses: 2,
      recycleGraceMs: 0, // disable timer-based recycling
      env: { FAKE_STDIN_LOG: stdinLog, FAKE_ARGV_LOG: argvLog },
    });

    const procs = (adapter as any).processes as Map<string, PiRpcClient>;

    // Start turn on sess-1
    const sess1 = '11111111-1111-4111-8111-111111111111';
    await drainEvents(await adapter.startTurn(sess1, 'msg1'));
    assert.equal(procs.size, 1);
    assert.ok(procs.has(sess1));

    await new Promise((r) => setTimeout(r, 20));

    // Start turn on sess-2
    const sess2 = '22222222-2222-4222-8222-222222222222';
    await drainEvents(await adapter.startTurn(sess2, 'msg2'));
    assert.equal(procs.size, 2);
    assert.ok(procs.has(sess1));
    assert.ok(procs.has(sess2));

    await new Promise((r) => setTimeout(r, 20));

    // Start turn on sess-3 -> should evict sess-1 (oldest activity)
    const sess3 = '33333333-3333-4333-8333-333333333333';
    await drainEvents(await adapter.startTurn(sess3, 'msg3'));
    assert.equal(procs.size, 2);
    assert.equal(procs.has(sess1), false, 'sess-1 should be evicted as oldest idle process');
    assert.ok(procs.has(sess2));
    assert.ok(procs.has(sess3));

    // Test busy process immunity:
    // Mark sess-2 as busy
    (adapter as any).activeTurns.set(sess2, {
      sessionId: sess2,
      turnId: 'dummy',
      settled: false,
    });
    // sess-2 has older activity than sess-3, but sess-2 is busy!
    // Start sess-4 -> sess-3 should be evicted instead because sess-2 is busy!
    const sess4 = '44444444-4444-4444-8444-444444444444';
    await drainEvents(await adapter.startTurn(sess4, 'msg4'));
    assert.ok(procs.has(sess2), 'Busy process sess-2 must never be killed by LRU eviction');
    assert.equal(procs.has(sess3), false, 'sess-3 should be evicted since sess-2 is busy');
    assert.ok(procs.has(sess4));

    (adapter as any).activeTurns.delete(sess2);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('maxSessionFileBytes throws invalid_request on oversized session file before spawning', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-max-size-'));
  const sessionsDir = join(base, 'sessions');
  let adapter: PiAdapter | undefined;
  try {
    const { bin, argvLog, stdinLog } = await writeContractFakePi(base);
    adapter = new PiAdapter({
      piBin: bin,
      sessionsDir,
      maxSessionFileBytes: 1024, // 1 KiB limit
      env: { FAKE_STDIN_LOG: stdinLog, FAKE_ARGV_LOG: argvLog },
    });

    const sid = '55555555-5555-4555-8555-555555555555';
    const cwdDir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(cwdDir, { recursive: true });
    const sessFile = join(cwdDir, `2026-11-15T00-00-00-000Z_${sid}.jsonl`);

    // Create an oversized file > 1024 bytes (e.g., 2048 bytes)
    const padding = 'x'.repeat(2048);
    await writeFile(
      sessFile,
      JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-15T00:00:00.000Z', cwd: base, pad: padding }) + '\n',
    );

    await assert.rejects(
      adapter.startTurn(sid, 'hello'),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.code, 'invalid_request');
        assert.equal(err.httpStatus, 400);
        assert.ok(err.message.includes('exceeds maximum allowed size'));
        return true;
      },
    );

    // Verify pi was NOT spawned for this oversized session file
    let argvLines: Array<{ pid: number; args: string[] }> = [];
    try {
      const raw = await readFile(argvLog, 'utf8');
      argvLines = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      // not created
    }
    const spawnedForFile = argvLines.filter((l) => l.args.includes(sessFile));
    assert.equal(spawnedForFile.length, 0, 'Must not spawn pi for oversized session file');
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('ensureSessionProcess coalesces concurrent starts, rejects when maxLiveProcesses all busy, and ignores self-parent cycles', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-concurrency-guard-'));
  const sessionsDir = join(base, 'sessions');
  let adapter: PiAdapter | undefined;
  try {
    const { bin, argvLog, stdinLog } = await writeContractFakePi(base);
    adapter = new PiAdapter({
      piBin: bin,
      sessionsDir,
      maxLiveProcesses: 1,
      recycleGraceMs: 0,
      env: { FAKE_STDIN_LOG: stdinLog, FAKE_ARGV_LOG: argvLog, FAKE_PI_MODE: 'wait_for_abort' },
    });

    const sid1 = '66666666-6666-4666-8666-666666666661';
    const sid2 = '66666666-6666-4666-8666-666666666662';
    const cwdDir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(cwdDir, { recursive: true });

    // Corrupted self-parent entry + non-active branch fork message
    const sess1File = join(cwdDir, `2026-11-15T00-00-00-000Z_${sid1}.jsonl`);
    await writeFile(
      sess1File,
      [
        JSON.stringify({ type: 'session', version: 3, id: sid1, timestamp: '2026-11-15T00:00:00.000Z', cwd: base }),
        JSON.stringify({ type: 'message', id: 'u-side', parentId: null, timestamp: '2026-11-15T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'side branch user' }] } }),
        JSON.stringify({ type: 'message', id: 'u-self', parentId: 'u-self', timestamp: '2026-11-15T00:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'main branch user' }] } }),
      ].join('\n') + '\n',
    );

    const tree = await adapter.getSessionTree(sid1);
    assert.ok(tree);
    assert.equal(JSON.stringify(tree).includes('u-self'), true);
    const forkMsgs = await adapter.getForkMessages(sid1);
    assert.equal(forkMsgs.length, 2, 'getForkMessages must scan all entries across branches');

    // Concurrent ensureSessionProcess for sid1 must only spawn once
    const inner = adapter as any;
    const [c1, c2] = await Promise.all([
      inner.ensureSessionProcess(sid1),
      inner.ensureSessionProcess(sid1),
    ]);
    assert.equal(c1, c2);
    const rawArgv = await readFile(argvLog, 'utf8');
    const sid1Spawns = rawArgv
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { args: string[] })
      .filter((l) => l.args.includes(sess1File));
    assert.equal(sid1Spawns.length, 1, 'concurrent ensureSessionProcess must coalesce into a single spawn');

    // Start an active turn on sid1 -> sid2 must be rejected with busy instead of exceeding maxLiveProcesses=1
    const turn1 = await adapter.startTurn(sid1, 'hold slot');
    await assert.rejects(
      adapter.startTurn(sid2, 'overflow'),
      (err: unknown) => err instanceof ProviderError && err.code === 'busy',
    );
    await adapter.abort(sid1);
    await drainEvents(turn1);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('interactive extension command avoids preflight deadlock, dedupes custom messages, tracks setStatus/setWidget/planMode, and discovers subagents', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-ext-integration-'));
  const sessionsDir = join(base, 'sessions');
  const scriptPath = join(base, 'fake-pi-ext');
  const respLog = join(base, 'ext-resp.jsonl');
  const childTranscript = join(base, 'subagent-child.jsonl');
  let adapter: PiProviderAdapter | undefined;
  try {
    const subSessionId = 'sub-agent-001';
    await writeFile(
      childTranscript,
      [
        JSON.stringify({ type: 'session', version: 3, id: subSessionId, timestamp: '2026-11-15T01:00:00.000Z', cwd: base }),
        JSON.stringify({ type: 'message', id: 'sm1', parentId: null, timestamp: '2026-11-15T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Inspect files' }] } }),
        JSON.stringify({ type: 'message', id: 'sm2', parentId: 'sm1', timestamp: '2026-11-15T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Subagent finished inspection.' }] } }),
      ].join('\n') + '\n',
    );

    const py = `#!/usr/bin/env python3
import json, os, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()

resp_log = os.environ["RESP_LOG"]
sub_transcript = os.environ["SUB_TRANSCRIPT"]
session_id = "77777777-7777-4777-8777-777777777777"

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    cmd = json.loads(raw)
    cid = cmd.get("id")
    ctype = cmd.get("type")
    if ctype == "get_state":
        send({"id": cid, "type": "response", "command": "get_state", "success": True, "data": {
            "sessionId": session_id, "thinkingLevel": "medium", "isStreaming": False, "isCompacting": False,
            "steeringMode": "one-at-a-time", "followUpMode": "one-at-a-time", "autoCompactionEnabled": True,
            "messageCount": 0, "pendingMessageCount": 0
        }})
    elif ctype == "get_available_models":
        send({"id": cid, "type": "response", "command": "get_available_models", "success": True, "data": {"models": []}})
    elif ctype == "get_commands":
        send({"id": cid, "type": "response", "command": "get_commands", "success": True, "data": {"commands": []}})
    elif ctype == "prompt":
        msg = cmd.get("message", "")
        if msg == "/interactive-cmd":
            # Emit blocking select WITH duplicate labels BEFORE prompt response arrives (no deadlock!)
            send({"type": "extension_ui_request", "id": "sel-dup", "method": "select", "title": "Choose", "options": ["Same", "Other", "Same"]})
            ans = json.loads(sys.stdin.readline())
            with open(resp_log, "a") as f:
                f.write(json.dumps(ans) + "\\n")
            send({"type": "extension_ui_request", "id": "st-1", "method": "setStatus", "statusKey": "plan-mode", "statusText": "Plan active"})
            send({"type": "extension_ui_request", "id": "wg-1", "method": "setWidget", "widgetKey": "plan", "widgetLines": ["Step 1", "Step 2"]})
            send({"type": "extension_ui_request", "id": "tt-1", "method": "setTitle", "title": "Planning"})
            send({"type": "entry_appended", "entry": {"id": "c1", "type": "custom_message", "customType": "plan", "display": True, "content": "Custom Entry Output"}})
            send({"type": "message_end", "message": {"role": "custom", "customType": "plan", "display": True, "content": "Custom Entry Output"}})
            send({"type": "message_end", "message": {"role": "custom", "customType": "hidden", "display": False, "content": "Hidden Output"}})
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "handled"}})
        else:
            send({"id": cid, "type": "response", "command": "prompt", "success": True, "data": {"disposition": "started"}})
            send({"type": "agent_start"})
            send({"type": "tool_execution_start", "toolCallId": "tc-sub-1", "toolName": "acp_delegate", "args": {"agent": "explorer", "task": "Explore repo"}})
            send({"type": "tool_execution_end", "toolCallId": "tc-sub-1", "toolName": "acp_delegate", "isError": False, "result": {
                "content": [{"type": "text", "text": "Delegated result"}],
                "details": {"runId": "sub-agent-001", "agent": "explorer", "transcriptPath": sub_transcript}
            }})
            send({"type": "agent_settled", "aborted": False})
    elif ctype == "abort":
        send({"id": cid, "type": "response", "command": "abort", "success": True})
`;
    await writeFile(scriptPath, py);
    await chmod(scriptPath, 0o755);

    adapter = new PiProviderAdapter({
      piBin: scriptPath,
      sessionsDir,
      requestTimeoutMs: 1500,
      handledGraceMs: 40,
      env: { RESP_LOG: respLog, SUB_TRANSCRIPT: childTranscript },
    });

    const sess = await adapter.create({ provider: 'pi', cwd: base });

    // 1. Blocking dialog inside slash command before prompt response -> resolves without deadlock!
    const handle = await adapter.startTurn({ sessionId: sess.id, input: '/interactive-cmd' });
    const events: GatewayEvent[] = [];
    for await (const ev of handle.events) {
      events.push(ev);
      if (ev.kind === 'question' && ev.status === 'started') {
        const q = ev.payload as { questionId: string; rawQuestions: Array<{ options: Array<{ id: string; label: string }> }> };
        // Pick the 3rd option ("Same__2") -> must translate back to raw label "Same"
        assert.equal(q.rawQuestions[0]?.options[2]?.id, 'Same__2');
        await adapter.resolveQuestion(sess.id, q.questionId, { q_0: ['Same__2'] });
      }
    }

    const recorded = JSON.parse((await readFile(respLog, 'utf8')).trim()) as Record<string, unknown>;
    assert.deepEqual(recorded, { type: 'extension_ui_response', id: 'sel-dup', value: 'Same' });

    // Check custom_message deduplication + hidden display:false suppression
    const customTexts = events
      .filter((e) => e.kind === 'message' && e.status === 'delta')
      .map((e) => (e.payload as { delta?: string }).delta);
    assert.deepEqual(customTexts, ['Custom Entry Output']);

    // Check extension UI state + planMode tracking
    assert.equal(adapter.getPlanMode(sess.id), true);
    assert.deepEqual(adapter.getExtensionUiState(sess.id), {
      statuses: { 'plan-mode': 'Plan active' },
      widgets: { plan: { lines: ['Step 1', 'Step 2'] } },
      title: 'Planning',
    });

    // 2. Subagent discovery via acp_delegate + child JSONL read
    const subEvents = await drainEvents(await adapter.startTurn({ sessionId: sess.id, input: 'delegate work' }));
    assert.ok(subEvents.some((e) => e.kind === 'subagent' && e.status === 'started' && e.agentId === 'sub-agent-001'));
    assert.ok(subEvents.some((e) => e.kind === 'subagent' && e.status === 'completed' && e.agentId === 'sub-agent-001'));

    const subs = await adapter.listSubagents(sess.id);
    assert.equal(subs.length, 1);
    assert.equal(subs[0]?.agentId, 'sub-agent-001');
    assert.equal(subs[0]?.subagentType, 'explorer');
    const subMsgs = await adapter.getSubagentMessages(sess.id, 'sub-agent-001');
    assert.equal(subMsgs.length, 2);
    assert.equal((subMsgs[1]?.content[0] as { text?: string })?.text, 'Subagent finished inspection.');
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});


test('review regression: fork without an entry clones the full active branch', async () => {
  const adapter = new PiAdapter({ sessionsDir: join(tmpdir(), 'unused-review-sessions') });
  const calls: Array<{ mode: string; entryId?: string }> = [];
  const expected = { sessionId: 'new-session' };
  (adapter as any).cloneOrForkIsolated = async (_sessionId: string, mode: string, entryId?: string) => {
    calls.push({ mode, entryId });
    return expected;
  };
  assert.equal(await adapter.fork('source-session'), expected);
  assert.equal(await adapter.fork('source-session', 'u1'), expected);
  assert.deepEqual(calls, [
    { mode: 'clone', entryId: undefined },
    { mode: 'fork', entryId: 'u1' },
  ]);
});

test('review regression: offline rename preserves history when the final entry exceeds 64 KiB', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-review-rename-long-'));
  const sessionsDir = join(base, 'sessions');
  const sid = '11111111-1111-4111-8111-111111111111';
  let adapter: PiAdapter | undefined;
  try {
    const { bin } = await writeContractFakePi(base);
    adapter = new PiAdapter({ piBin: bin, sessionsDir, env: { HOME: base, PI_CODING_AGENT_DIR: base } });
    const dir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `2026-11-15T00-00-00-000Z_${sid}.jsonl`);
    await writeFile(file, [
      JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-15T00:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-11-15T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
      JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-11-15T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(65 * 1024) }] } }),
    ].join('\n') + '\n');
    const before = await adapter.getHistory(sid);
    assert.equal(before.length, 2);
    await adapter.setSessionName(sid, 'Renamed');
    assert.deepEqual(await adapter.getHistory(sid), before);
    const reopened = new PiAdapter({ piBin: bin, sessionsDir, env: { HOME: base, PI_CODING_AGENT_DIR: base } });
    try {
      assert.equal((await reopened.getState(sid)).sessionName, 'Renamed');
      assert.deepEqual(await reopened.getHistory(sid), before);
    } finally {
      await reopened.dispose();
    }
  } finally {
    await adapter?.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: failed offline rename rejects without caching the new title', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-review-rename-fail-'));
  const adapter = new PiProviderAdapter({ sessionsDir: base, env: { HOME: base, PI_CODING_AGENT_DIR: base } });
  try {
    const session = await adapter.create({ provider: 'pi', cwd: base, title: 'Original' });
    const inner = (adapter as any).inner as PiAdapter;
    (inner as any).locateSessionFile = async () => base;
    await assert.rejects(adapter.rename(session.id, 'Not saved'));
    assert.equal(inner.getCachedSessionName(session.id), 'Original');
    assert.equal((adapter as any).renames.has(session.id), false);
  } finally {
    await adapter.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: RPC framing overflow rejects pending requests and fails the active turn', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-review-framing-'));
  let adapter: PiAdapter | undefined;
  try {
    const { bin } = await writeContractFakePi(base);
    adapter = new PiAdapter({
      piBin: bin,
      sessionsDir: join(base, 'sessions'),
      env: { HOME: base, PI_CODING_AGENT_DIR: base, FAKE_PI_MODE: 'wait_for_abort' },
      recycleGraceMs: 0,
      requestTimeoutMs: 5_000,
    });
    const { sessionId } = adapter.create(base);
    const turn = await adapter.startTurn(sessionId, 'hold');
    const client = (adapter as any).processes.get(sessionId) as PiRpcClient;
    (client as any).framer = new JsonlLineFramer(1024);
    const pending = client.request({ type: 'review_wait' }).then(
      () => 'resolved',
      () => 'rejected',
    );
    const events = drainEvents(turn);
    (client as any).child.stdout.emit('data', Buffer.alloc(1025, 'x'));
    const outcome = await Promise.race([
      Promise.all([pending, events]).then(([request, turnEvents]) => ({ request, turnEvents })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
    ]);
    assert.ok(outcome, 'framing failure must settle the request and turn promptly');
    assert.equal(outcome.request, 'rejected');
    assert.ok(outcome.turnEvents.some((event) => event.kind === 'turn' && event.status === 'failed'));
    assert.equal(client.isAlive, false);
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: failed auto-compaction application remains retryable', async () => {
  const adapter = new PiAdapter({ sessionsDir: join(tmpdir(), 'unused-review-sessions') });
  const sessionId = 'review-compaction';
  (adapter as any).sessionAutoCompaction.set(sessionId, false);
  let attempts = 0;
  let enabled = true;
  const client = {
    async request(command: { type: string; enabled?: boolean }) {
      if (command.type === 'set_auto_compaction') {
        attempts++;
        if (attempts === 1) throw new Error('temporary RPC failure');
        enabled = command.enabled!;
      }
      return { autoCompactionEnabled: enabled };
    },
  };
  const sync = (initial?: { autoCompactionEnabled: boolean }) =>
    (adapter as any).syncSessionPreferencesToClient(client, sessionId, initial) as Promise<void>;
  await sync({ autoCompactionEnabled: true }).catch(() => undefined);
  await sync();
  assert.equal(attempts, 2);
  assert.equal(enabled, false);
});

test('review regression: capacity counts a starting session only once', async () => {
  const adapter = new PiAdapter({ sessionsDir: join(tmpdir(), 'unused-review-sessions'), maxLiveProcesses: 2 });
  const inner = adapter as any;
  const sessionId = 'review-starting';
  inner.processes.set(sessionId, { isAlive: true, hasPendingRequests: () => false });
  inner.startingSessions.add(sessionId);
  await inner.evictOldestIdleProcessIfNeeded('review-clone', true);
  assert.equal(inner.processes.has(sessionId), true);
});

test('review regression: same-cwd metadata commands reuse the live session', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-review-cwd-'));
  const adapter = new PiAdapter({ sessionsDir: join(base, 'sessions'), env: { HOME: base, PI_CODING_AGENT_DIR: base } });
  try {
    const { sessionId } = adapter.create(base);
    const commands = [{ name: 'skill:local', description: 'Local', source: 'skill' }];
    let requests = 0;
    const inner = adapter as any;
    inner.processes.set(sessionId, {
      isAlive: true,
      request: async (command: { type: string }) => {
        assert.equal(command.type, 'get_commands');
        requests++;
        return { commands };
      },
    });
    inner.runEphemeralRpc = async () => { throw new Error('unexpected ephemeral process'); };
    assert.deepEqual(await adapter.getCommands(sessionId, base), commands);
    assert.equal(requests, 1);
    inner.processes.delete(sessionId);
  } finally {
    (adapter as any).processes.clear();
    await adapter.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: head reader skips long system prompt lines to extract first user prompt and does not pick failed tail prompt as title', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-review-head-long-'));
  const sessionsDir = join(base, 'sessions');
  const sid = '22222222-2222-4222-8222-222222222222';
  const adapter = new PiProviderAdapter({ sessionsDir, env: { HOME: base, PI_CODING_AGENT_DIR: base } });
  try {
    const dir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `2026-11-15T00-00-00-000Z_${sid}.jsonl`);
    const systemPayload = 'System prompt tools '.repeat(5 * 1024); // ~100 KB
    const intermediateFiller = 'Intermediate conversation data '.repeat(12 * 1024); // ~360 KB filler
    await writeFile(file, [
      JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-15T00:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'model_change', model: 'gpt-5' }),
      JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'high' }),
      JSON.stringify({ type: 'custom', customType: 'init' }),
      JSON.stringify({ type: 'message', id: 's1', message: { role: 'system', content: systemPayload } }),
      JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: '搜下现在什么有什么比较好的建站程序' }] } }),
      JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'WordPress and Discuz' }] } }),
      JSON.stringify({ type: 'message', id: 'a_mid', message: { role: 'assistant', content: [{ type: 'text', text: intermediateFiller }] } }),
      JSON.stringify({ type: 'message', id: 'u2', message: { role: 'user', content: [{ type: 'text', text: '//aaddvviissoorr' }] } }),
      JSON.stringify({ type: 'message', id: 'a2', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '401 "API key required for remote API access"' } }),
    ].join('\n') + '\n');

    const innerSummary = (await (adapter as any).inner.list()).find((s: any) => s.sessionId === sid);
    assert.ok(innerSummary);
    assert.equal(innerSummary.firstUserPrompt, '搜下现在什么有什么比较好的建站程序');
    assert.equal(innerSummary.lastPrompt, undefined, 'unknown lastPrompt across unscanned gap must be undefined, not first prompt');

    const list = await adapter.list({ cwd: base });
    assert.equal(list.items.length, 1);
    const item = list.items[0]!;
    assert.equal(item.title, '搜下现在什么有什么比较好的建站程序');
    assert.notEqual(item.title, '//aaddvviissoorr');
    assert.notEqual(item.extras?.last_prompt, '//aaddvviissoorr');
  } finally {
    await adapter.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: failed turn with empty reply or error does not overwrite last valid prompt', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-review-failed-turn-'));
  const sessionsDir = join(base, 'sessions');
  const sid = '33333333-3333-4333-8333-333333333333';
  const adapter = new PiProviderAdapter({ sessionsDir, env: { HOME: base, PI_CODING_AGENT_DIR: base } });
  try {
    const dir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `2026-11-15T00-00-00-000Z_${sid}.jsonl`);
    await writeFile(file, [
      JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-15T00:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: '首条有效提问' }] } }),
      JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '回复1' }] } }),
      JSON.stringify({ type: 'message', id: 'u2', message: { role: 'user', content: [{ type: 'text', text: '中间有效提问' }] } }),
      JSON.stringify({ type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: '回复2' }] } }),
      JSON.stringify({ type: 'message', id: 'u3', message: { role: 'user', content: [{ type: 'text', text: '末尾失败提问' }] } }),
      JSON.stringify({ type: 'message', id: 'a3', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '500 internal error' } }),
    ].join('\n') + '\n');

    const list = await adapter.list({ cwd: base });
    assert.equal(list.items.length, 1);
    const item = list.items[0]!;
    assert.equal(item.title, '首条有效提问');
    assert.equal(item.extras?.last_prompt, '中间有效提问');
  } finally {
    await adapter.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: large session file with no user message in tail window preserves title and leaves lastPrompt undefined', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-review-large-tail-'));
  const sessionsDir = join(base, 'sessions');
  const sid = '44444444-4444-4444-8444-444444444444';
  const adapter = new PiProviderAdapter({ sessionsDir, env: { HOME: base, PI_CODING_AGENT_DIR: base } });
  try {
    const dir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `2026-11-15T00-00-00-000Z_${sid}.jsonl`);
    const systemPayload = 'System tools '.repeat(5 * 1024); // ~65 KB
    const tailFiller = 'Tool output data line '.repeat(20 * 1024); // ~440 KB of tail content
    await writeFile(file, [
      JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-15T00:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'message', id: 's1', message: { role: 'system', content: systemPayload } }),
      JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: '大文件头部首条提问' }] } }),
      JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '初始回复' }] } }),
      JSON.stringify({ type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: tailFiller }] } }),
    ].join('\n') + '\n');

    const innerSummary = (await (adapter as any).inner.list()).find((s: any) => s.sessionId === sid);
    assert.ok(innerSummary);
    assert.equal(innerSummary.firstUserPrompt, '大文件头部首条提问');
    assert.equal(innerSummary.lastPrompt, undefined, 'tail with no user messages must leave lastPrompt undefined');

    const list = await adapter.list({ cwd: base });
    assert.equal(list.items.length, 1);
    const item = list.items[0]!;
    assert.equal(item.title, '大文件头部首条提问');
    assert.equal(item.extras?.last_prompt, '大文件头部首条提问');
  } finally {
    await adapter.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: thinking content strips ANSI escape sequences while preserving text and Thinking label', async () => {
  const sid = '55555555-5555-4555-8555-555555555555';
  const entry = {
    type: 'message',
    id: 'm1',
    timestamp: '2026-11-15T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: '\x1b[38;2;136;88;228mThinking:\x1b[39m \x1b[38;2;135;145;156mInitial focus is on CMS platforms.\x1b[39m',
        },
        {
          type: 'text',
          text: 'Here is the answer.',
        },
      ],
    },
  };
  const mapped = parsePiSessionEntry(entry, sid);
  assert.ok(mapped && !Array.isArray(mapped));
  const thinkingPart = mapped.content?.find((p) => p.type === 'thinking');
  assert.ok(thinkingPart && 'thinking' in thinkingPart);
  assert.equal(/\x1b/.test(thinkingPart.thinking as string), false);
  assert.equal(thinkingPart.thinking, 'Thinking: Initial focus is on CMS platforms.');
});

test('review regression: session_info with empty name clears title and falls back to first prompt', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-review-session-info-clear-'));
  const sessionsDir = join(base, 'sessions');
  const sid = '66666666-6666-4666-8666-666666666666';
  const adapter = new PiProviderAdapter({ sessionsDir, env: { HOME: base, PI_CODING_AGENT_DIR: base } });
  try {
    const dir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `2026-11-15T00-00-00-000Z_${sid}.jsonl`);
    await writeFile(file, [
      JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-15T00:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: '首条真实提问' }] } }),
      JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '答复1' }] } }),
      JSON.stringify({ type: 'session_info', name: '临时旧标题' }),
      JSON.stringify({ type: 'session_info', name: '' }),
    ].join('\n') + '\n');

    const list = await adapter.list({ cwd: base });
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0]!.title, '首条真实提问');
  } finally {
    await adapter.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: intermediate tool use followed by terminal error fails the entire turn', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-review-tool-error-'));
  const sessionsDir = join(base, 'sessions');
  const sid = '77777777-7777-4777-8777-777777777777';
  const adapter = new PiProviderAdapter({ sessionsDir, env: { HOME: base, PI_CODING_AGENT_DIR: base } });
  try {
    const dir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `2026-11-15T00-00-00-000Z_${sid}.jsonl`);
    await writeFile(file, [
      JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-15T00:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: '首条提问成功' }] } }),
      JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '答复成功' }] } }),
      JSON.stringify({ type: 'message', id: 'u2', message: { role: 'user', content: [{ type: 'text', text: '带有工具但最终失败的提问' }] } }),
      JSON.stringify({ type: 'message', id: 'a2_tool', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: {} }] } }),
      JSON.stringify({ type: 'message', id: 't2', message: { role: 'toolResult', toolCallId: 'call_1', content: 'output' } }),
      JSON.stringify({ type: 'message', id: 'a2_err', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '500 service unavailable' } }),
    ].join('\n') + '\n');

    const innerSummary = (await (adapter as any).inner.list()).find((s: any) => s.sessionId === sid);
    assert.ok(innerSummary);
    assert.equal(innerSummary.firstUserPrompt, '首条提问成功');
    assert.equal(innerSummary.lastPrompt, '首条提问成功');
  } finally {
    await adapter.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: summary bounds prompt lengths and cache tracks dev, ino, ctime', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-review-cache-meta-'));
  const sessionsDir = join(base, 'sessions');
  const sid = '88888888-8888-4888-8888-888888888888';
  const adapter = new PiProviderAdapter({ sessionsDir, env: { HOME: base, PI_CODING_AGENT_DIR: base } });
  try {
    const dir = join(sessionsDir, encodePiCwdDir(base));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `2026-11-15T00-00-00-000Z_${sid}.jsonl`);
    const hugePrompt = '用户长提示词 '.repeat(500); // ~3500 字符
    await writeFile(file, [
      JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-15T00:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: hugePrompt }] } }),
      JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '完成' }] } }),
    ].join('\n') + '\n');

    const summary1 = (await (adapter as any).inner.list()).find((s: any) => s.sessionId === sid);
    assert.ok(summary1);
    assert.ok(summary1.firstUserPrompt.length <= 300, `prompt length ${summary1.firstUserPrompt.length} must be <= 300`);
    assert.ok(summary1.lastPrompt.length <= 300, `lastPrompt length ${summary1.lastPrompt.length} must be <= 300`);

    // Replace file with different inode (same length, different prompt)
    const fileTmp = `${file}.tmp`;
    await writeFile(fileTmp, [
      JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-15T00:00:00.000Z', cwd: base }),
      JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: '新内容提问换inode' }] } }),
      JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '完成' }] } }),
    ].join('\n') + '\n');
    await rm(file);
    const { rename } = await import('node:fs/promises');
    await rename(fileTmp, file);

    const summary2 = (await (adapter as any).inner.list()).find((s: any) => s.sessionId === sid);
    assert.ok(summary2);
    assert.equal(summary2.firstUserPrompt, '新内容提问换inode');
  } finally {
    await adapter.dispose();
    await rm(base, { recursive: true, force: true });
  }
});



async function writePiSummaryFixture(base: string, sid: string, lines: string[]): Promise<void> {
  const dir = join(base, 'sessions', encodePiCwdDir(base));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `2026-11-15T00-00-00-000Z_${sid}.jsonl`), lines.join('\n') + '\n');
}

function piMsg(id: string, role: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'message', id, message: { role, content, ...extra } });
}

const PI_HEADER = (sid: string, cwd: string): string =>
  JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: '2026-11-15T00:00:00.000Z', cwd });

test('review regression: an empty tail session_info clears the head name while a non-empty tail name still wins', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-review-name-'));
  const adapter = new PiProviderAdapter({ sessionsDir: join(base, 'sessions'), env: { HOME: base, PI_CODING_AGENT_DIR: base } });
  const sidA = 'cccccccc-1111-4111-8111-cccccccccccc';
  const sidB = 'dddddddd-1111-4111-8111-dddddddddddd';
  try {
    const pad = piMsg('pad', 'assistant', [{ type: 'text', text: 'y'.repeat(700 * 1024) }]);
    await writePiSummaryFixture(base, sidA, [
      PI_HEADER(sidA, base),
      JSON.stringify({ type: 'session_info', id: 'n1', name: '头部真名' }),
      piMsg('u1', 'user', [{ type: 'text', text: '首问A' }]),
      piMsg('a1', 'assistant', [{ type: 'text', text: '答A' }]),
      pad,
      JSON.stringify({ type: 'session_info', id: 'n2', name: '' }),
      piMsg('u2', 'user', [{ type: 'text', text: '尾问A' }]),
      piMsg('a2', 'assistant', [{ type: 'text', text: '尾答A' }]),
    ]);
    await writePiSummaryFixture(base, sidB, [
      PI_HEADER(sidB, base),
      JSON.stringify({ type: 'session_info', id: 'n1', name: '头部旧名' }),
      piMsg('u1', 'user', [{ type: 'text', text: '首问B' }]),
      piMsg('a1', 'assistant', [{ type: 'text', text: '答B' }]),
      pad,
      JSON.stringify({ type: 'session_info', id: 'n2', name: '尾部新名' }),
      piMsg('u2', 'user', [{ type: 'text', text: '尾问B' }]),
      piMsg('a2', 'assistant', [{ type: 'text', text: '尾答B' }]),
    ]);
    const list = await adapter.list({ cwd: base });
    const byId = new Map(list.items.map((s) => [s.id, s]));
    assert.equal(byId.get(sidA)?.title, '首问A', 'empty tail session_info clears the head name');
    assert.equal(byId.get(sidB)?.title, '尾部新名');
  } finally {
    await adapter.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: an unconfirmed recent prompt falls back to the first prompt, never to the rename', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-review-last-prompt-'));
  const adapter = new PiProviderAdapter({ sessionsDir: join(base, 'sessions'), env: { HOME: base, PI_CODING_AGENT_DIR: base } });
  const sid = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
  try {
    await writePiSummaryFixture(base, sid, [
      PI_HEADER(sid, base),
      piMsg('u1', 'user', [{ type: 'text', text: '真正的首问' }]),
      piMsg('a1', 'assistant', [{ type: 'text', text: '答' }]),
      JSON.stringify({ type: 'session_info', id: 'n1', name: '用户改的名字' }),
      piMsg('pad', 'assistant', [{ type: 'text', text: 'y'.repeat(700 * 1024) }]),
    ]);
    const list = await adapter.list({ cwd: base });
    assert.equal(list.items[0]!.title, '用户改的名字');
    assert.equal(list.items[0]!.extras?.last_prompt, '真正的首问');
  } finally {
    await adapter.dispose();
    await rm(base, { recursive: true, force: true });
  }
});
