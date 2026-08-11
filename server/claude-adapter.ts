/**
 * ClaudeAdapter — wraps the Claude Code CLI (tested with 2.1.220) as a
 * ProviderAdapter for the multi-agent gateway.
 *
 * Driving mechanism: each turn spawns
 *   claude -p --input-format stream-json --output-format stream-json \
 *          --include-partial-messages --verbose [--session-id <id> | --resume <id> [--fork-session]]
 * One user message (stream-json line) is written to stdin, then stdin closes;
 * the process exits after the turn. Multi-turn conversations are continued via
 * --resume. Session transcripts live in ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl.
 *
 * Verified behaviors (2.1.220, against the configured Anthropic-compatible endpoint):
 *  - `system/subtype=init` carries session_id, cwd, tool list.
 *  - `stream_event` carries raw Anthropic SSE deltas (text_delta / thinking_delta).
 *  - `assistant` events carry complete message blocks incl. tool_use.
 *  - `user` events carry tool_result blocks.
 *  - `result` is the terminal event: { subtype: "success"|..., result, is_error,
 *    usage, permission_denials[], session_id }.
 *  - Tools that require permission are AUTO-DENIED in this non-interactive mode:
 *    the turn continues with an error tool_result ("Claude requested permissions...")
 *    and the denial is listed in result.permission_denials. There is NO interactive
 *    approval/question channel over plain CLI stream-json — even after a successful
 *    control_request/initialize handshake, no can_use_tool control_request is
 *    emitted (verified 2.1.220). resolveApproval / resolveQuestion therefore throw
 *    UnsupportedCapability; denials are surfaced as `permission_denied` events.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

/** 会话列表只解析文件头这么多字节(ai-title/cwd/首条用户消息都在前 ~20 行)。 */
const HEAD_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClaudeSessionSummary {
  sessionId: string;
  /** AI-generated title / summary / first user prompt, best effort. */
  title: string;
  /** Working directory the session ran in (from transcript entries). */
  cwd: string;
  /** Project dir slug under ~/.claude/projects. */
  projectDir: string;
  /** ISO timestamp of last transcript entry (file mtime fallback). */
  updatedAt: string;
}

/** initialize 握手回包里的单条斜杠命令描述。 */
export interface ClaudeSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
}

export interface ClaudeHistoryMessage {
  role: "user" | "assistant";
  /** Concatenated text blocks (tool_use/tool_result blocks are skipped). */
  text: string;
  timestamp?: string;
  model?: string;
}

export type ClaudeAdapterEvent =
  | { type: "init"; sessionId: string; cwd: string; tools: string[] }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  /**
   * 本地命令(/mcp、/usage、/compact 等)的输出:assistant 事件 model 为
   * "<synthetic>",没有 stream_event delta,整段文本一次到达(2.1.226 实测)。
   */
  | { type: "synthetic_text"; text: string }
  | { type: "tool_use"; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | {
      type: "permission_denied";
      denials: Array<{ tool_name: string; tool_use_id: string; tool_input: unknown }>;
    }
  | {
      type: "done";
      sessionId: string;
      result: string;
      isError: boolean;
      subtype: string;
      stopReason: string | null;
      usage?: Record<string, unknown>;
      durationMs?: number;
    }
  | { type: "interrupted"; sessionId: string }
  | { type: "error"; message: string };

export interface StartTurnOptions {
  /** Session id from create(), or an existing session id to resume. */
  sessionId: string;
  /** User prompt for this turn. */
  prompt: string;
  /** cwd for the claude process; also decides the transcript project dir. */
  cwd?: string;
  /**
   * true  → pass --session-id (first turn of a create()d session);
   * false → pass --resume (continue an existing session). Default false.
   */
  isNew?: boolean;
  /** With isNew=false, also pass --fork-session (resume into a new session id). */
  fork?: boolean;
  /** 覆盖本 turn 的模型(透传 CLI 的 --model;缺省由 CLI 配置/环境决定)。 */
  model?: string;
  /** 思考档位(透传 CLI 的 --effort,2.1.226 --help 取证:low/medium/high/xhigh/max)。 */
  effort?: string;
  /**
   * 权限模式(透传 CLI 的 --permission-mode,choices 实测:
   * acceptEdits/auto/bypassPermissions/manual/dontAsk/plan)。
   */
  permissionMode?: string;
  /**
   * 完整 user content 块(图片/PDF 附件时优先于 prompt 单文本块;
   * 2.1.226 复核:stream-json 接受 image/document base64 block)。
   */
  contentBlocks?: Array<Record<string, unknown>>;
  onEvent: (event: ClaudeAdapterEvent) => void;
}

export class UnsupportedCapability extends Error {
  constructor(capability: string) {
    super(
      `claude-adapter: "${capability}" is not supported by the Claude CLI in ` +
        `non-interactive stream-json mode (verified on 2.1.220: tools needing ` +
        `permission are auto-denied and reported via result.permission_denials).`,
    );
    this.name = "UnsupportedCapability";
  }
}

export interface ClaudeAdapterOptions {
  /** Path to the claude binary. */
  claudeBin?: string;
  /** Extra/override env for the claude subprocess (merged over the defaults). */
  env?: Record<string, string>;
  /** Root of claude session transcripts. Default ~/.claude/projects */
  projectsDir?: string;
}

// ---------------------------------------------------------------------------
// Default environment for the claude CLI child process.
// ---------------------------------------------------------------------------

// 只放无密默认值;上游地址/密钥/模型一律由部署方经进程环境变量注入
// (网关启动命令 export ANTHROPIC_*),源码不内置任何凭据。
const DEFAULT_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

const DEFAULT_CLAUDE_BIN = path.join(os.homedir(), ".local", "bin", "claude");

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeAdapter {
  private readonly claudeBin: string;
  private readonly env: Record<string, string>;
  private readonly projectsDir: string;
  /** sessionId -> running turn process (at most one turn per session). */
  private readonly running = new Map<string, ChildProcess>();
  /** Sessions whose current turn was interrupted via interrupt(). */
  private readonly interruptRequested = new Set<string>();

  constructor(options: ClaudeAdapterOptions = {}) {
    this.claudeBin = options.claudeBin ?? DEFAULT_CLAUDE_BIN;
    this.env = { ...DEFAULT_ENV, ...(options.env ?? {}) };
    this.projectsDir = options.projectsDir ?? path.join(os.homedir(), ".claude", "projects");
  }

  // -- capability surface ---------------------------------------------------

  readonly provider = "claude" as const;

  readonly capabilities = {
    streamingText: true,
    thinking: true,
    toolEvents: true,
    interrupt: true,
    resume: true,
    fork: true,
    /** Auto-denied by the CLI; only reported, never answerable. */
    approvals: false,
    questions: false,
  };

  // -- list -----------------------------------------------------------------

  /**
   * Scan ~/.claude/projects/<slug>/<sessionId>.jsonl into session summaries.
   * 只列顶层 .jsonl(主会话);子 agent transcript 位于 <id>/subagents/ 下,天然排除。
   *
   * 性能:本机 121 个文件共 343MB,全量解析会把事件循环卡死(实测 99% CPU
   * 无法响应)。因此只读文件头 HEAD_BYTES(ai-title/cwd/首条用户消息都在前
   * ~20 行),updatedAt 用 mtime,并按 (mtimeMs,size) 做缓存。
   */
  async list(): Promise<ClaudeSessionSummary[]> {
    const out: ClaudeSessionSummary[] = [];
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return out;
    }
    const tasks: (() => Promise<void>)[] = [];
    for (const dirEnt of projectDirs) {
      if (!dirEnt.isDirectory()) continue;
      const dirPath = path.join(this.projectsDir, dirEnt.name);
      let files: string[];
      try {
        files = fs.readdirSync(dirPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const sessionId = file.slice(0, -".jsonl".length);
        const filePath = path.join(dirPath, file);
        tasks.push(async () => {
          try {
            const s = await this.summarizeSessionFile(sessionId, dirEnt.name, filePath);
            if (s) out.push(s);
          } catch {
            // unreadable / malformed transcript — skip
          }
        });
      }
    }
    // 有限并发,避免一次性 121 个同步读阻塞事件循环。
    const CONCURRENCY = 8;
    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
      await Promise.all(tasks.slice(i, i + CONCURRENCY).map((t) => t()));
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }

  // -- create ---------------------------------------------------------------

  /**
   * Allocate a fresh session id. The transcript file is only materialized by
   * the CLI on the first startTurn (with isNew: true).
   */
  async create(): Promise<{ sessionId: string }> {
    return { sessionId: randomUUID() };
  }

  // -- getHistory -----------------------------------------------------------

  /** Parse the session transcript into user/assistant text messages. */
  async getHistory(sessionId: string): Promise<ClaudeHistoryMessage[]> {
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) throw new Error(`claude-adapter: session not found: ${sessionId}`);
    const messages: ClaudeHistoryMessage[] = [];
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
      if (!line) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.isSidechain) continue;
      const type = entry.type;
      if (type !== "user" && type !== "assistant") continue;
      const msg = entry.message;
      if (!msg || msg.role !== type) continue;
      const text = extractText(msg.content);
      if (!text) continue; // tool_result-only user entries, empty thinking, etc.
      if (type === "user" && isLocalCommandText(text)) continue;
      messages.push({
        role: type,
        text,
        timestamp: entry.timestamp,
        model: type === "assistant" ? msg.model : undefined,
      });
    }
    return messages;
  }

  // -- startTurn ------------------------------------------------------------

  /**
   * Run one turn. Streams events via onEvent; resolves when the terminal
   * `result` event has been emitted (or rejects on spawn/protocol failure).
   */
  async startTurn(opts: StartTurnOptions): Promise<void> {
    const { sessionId, prompt, onEvent } = opts;
    if (this.running.has(sessionId)) {
      throw new Error(`claude-adapter: a turn is already running for session ${sessionId}`);
    }
    const cwd = opts.cwd ?? os.homedir();

    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    if (opts.isNew) {
      args.push("--session-id", sessionId);
    } else {
      args.push("--resume", sessionId);
      if (opts.fork) args.push("--fork-session");
    }
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--effort", opts.effort);
    if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);

    const child = spawn(this.claudeBin, args, {
      cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.running.set(sessionId, child);

    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
    });

    const done = new Promise<void>((resolve, reject) => {
      let sawResult = false;

      const rl = readline.createInterface({ input: child.stdout! });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return; // non-JSON noise
        }
        for (const mapped of mapStreamEvent(ev)) {
          if (mapped.type === "done") sawResult = true;
          onEvent(mapped);
        }
      });

      child.on("error", (err) => {
        this.running.delete(sessionId);
        onEvent({ type: "error", message: `spawn failed: ${err.message}` });
        reject(err);
      });

      child.on("close", (code, signal) => {
        this.running.delete(sessionId);
        // The CLI handles SIGINT gracefully and exits code=0/signal=null
        // without a result event — so key off our own interrupt request flag,
        // not the exit signal.
        const wasInterrupted =
          this.interruptRequested.delete(sessionId) ||
          signal === "SIGINT" ||
          signal === "SIGTERM";
        if (sawResult) {
          resolve();
        } else if (wasInterrupted) {
          onEvent({ type: "interrupted", sessionId });
          resolve();
        } else {
          const message =
            `claude exited without a result event (code=${code}, signal=${signal}). ` +
            (stderrTail ? `stderr tail: ${stderrTail.trim()}` : "");
          onEvent({ type: "error", message });
          reject(new Error(message));
        }
      });
    });

    // Send the single user message for this turn, then close stdin so the CLI
    // finishes the turn and exits. contentBlocks carries image/document
    // attachments (2.1.226 verified); otherwise a single text block.
    const userLine = JSON.stringify({
      type: "user",
      message: { role: "user", content: opts.contentBlocks ?? [{ type: "text", text: prompt }] },
    });
    child.stdin!.write(userLine + "\n");
    child.stdin!.end();

    return done;
  }

  // -- interrupt ------------------------------------------------------------

  /**
   * Interrupt the running turn of a session: SIGINT, escalating to SIGKILL
   * after 5s. Returns false if no turn is running for the session.
   */
  interrupt(sessionId: string): boolean {
    const child = this.running.get(sessionId);
    if (!child) return false;
    this.interruptRequested.add(sessionId);
    child.kill("SIGINT");
    const ref = setTimeout(() => {
      // child.killed 只表示信号已发出(调用即置 true),不代表进程已退出;
      // 判活要用 exitCode/signalCode,否则 SIGKILL 升级永远不生效。
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5000);
    ref.unref?.();
    return true;
  }

  // -- approvals / questions (unsupported, verified) -------------------------

  async resolveApproval(): Promise<never> {
    throw new UnsupportedCapability("resolveApproval");
  }

  async resolveQuestion(): Promise<never> {
    throw new UnsupportedCapability("resolveQuestion");
  }

  // -- 原生斜杠命令目录(initialize 握手) ---------------------------------------

  /**
   * 权威的 claude 斜杠命令目录 = CLI initialize 握手回包的 commands 字段
   * (2.1.226 实测 154 条:插件命令 + skills + 内置 compact/usage/mcp/doctor
   * 等,带 description/argumentHint/aliases)。这些命令由 CLI 自己展开/执行
   * (-p stream-json 输入 "/name args" 实测会触发,如 /compact 产生
   * system status compacting 事件),网关只做目录展示,不做文本展开。
   *
   * 每次调用spawn一个短命进程只做握手(不跑模型),按 cwd 缓存 5 分钟
   * (项目级命令随 cwd 不同)。
   */
  private commandsCache = new Map<string, { ts: number; commands: ClaudeSlashCommand[] }>();
  private static readonly COMMANDS_TTL_MS = 5 * 60_000;

  async listSlashCommands(cwd?: string): Promise<ClaudeSlashCommand[]> {
    const key = cwd ?? "";
    const hit = this.commandsCache.get(key);
    if (hit && Date.now() - hit.ts < ClaudeAdapter.COMMANDS_TTL_MS) return hit.commands;
    const commands = await this.fetchSlashCommands(cwd).catch(() => null);
    if (!commands) return hit?.commands ?? [];
    this.commandsCache.set(key, { ts: Date.now(), commands });
    return commands;
  }

  private fetchSlashCommands(cwd?: string): Promise<ClaudeSlashCommand[] | null> {
    return new Promise((resolve) => {
      const child = spawn(
        this.claudeBin,
        ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        { cwd: cwd ?? os.homedir(), env: { ...process.env, ...this.env }, stdio: ["pipe", "pipe", "pipe"] },
      );
      let settled = false;
      const finish = (value: ClaudeSlashCommand[] | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 20_000);
      child.on("error", () => finish(null));
      const rl = readline.createInterface({ input: child.stdout! });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type !== "control_response") return;
        const resp = ev.response;
        const list = resp?.response?.commands;
        if (Array.isArray(list)) {
          finish(
            list
              .filter((c: any) => c && typeof c.name === "string")
              .map((c: any) => ({
                name: c.name as string,
                description: typeof c.description === "string" ? c.description : (c.name as string),
                argumentHint: typeof c.argumentHint === "string" ? c.argumentHint : "",
                aliases: Array.isArray(c.aliases) ? c.aliases.filter((a: any) => typeof a === "string") : [],
              })),
          );
        }
      });
      child.stdin!.write(
        JSON.stringify({ type: "control_request", request_id: "gw_init", request: { subtype: "initialize" } }) + "\n",
      );
    });
  }

  // -- close ----------------------------------------------------------------

  /** Kill all running turn processes. */
  async close(): Promise<void> {
    for (const [sessionId, child] of this.running) {
      child.kill("SIGTERM");
      this.running.delete(sessionId);
    }
  }

  // -- internals --------------------------------------------------------------

  private findSessionFile(sessionId: string): string | null {
    // Claude transcript ids are UUIDs; reject separators before constructing a path.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      return null;
    }
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const dirEnt of projectDirs) {
      if (!dirEnt.isDirectory()) continue;
      const candidate = path.join(this.projectsDir, dirEnt.name, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  private summarizeCache = new Map<string, { mtimeMs: number; size: number; summary: ClaudeSessionSummary }>();

  /** 提取标题/cwd。标题逐条对齐原生 /resume(实测核验):
   *  1) 文件中最后一个 ai-title/agent-name/summary(标题随会话演变,原生显示最新)
   *  2) 无标题条目时取最后一条真实用户消息(不是第一条!原生对 "测试" 会话
   *     显示的是最后的 prompt);caveat/stdout/interrupted/⎿ 错误回显跳过
   *  3) 连真实消息都没有时用最后一条斜杠命令("/model" 会话实测)
   *  4) 啥都没有 → "(session)"
   *  头+尾各读 256KB(大文件最后的条目必在尾部),按 (mtime,size) 缓存;
   *  原生连空会话也显示,这里不做内容过滤。 */
  private async summarizeSessionFile(
    sessionId: string,
    projectDir: string,
    filePath: string,
  ): Promise<ClaudeSessionSummary | null> {
    const stat = await fsp.stat(filePath);
    const hit = this.summarizeCache.get(filePath);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.summary;

    let headTitle = "";
    let tailTitle = "";
    let headUser = "";
    let tailUser = "";
    let headCmd = "";
    let tailCmd = "";
    let cwd = "";
    const updatedAt = stat.mtime.toISOString();

    const titleOf = (entry: any): string => {
      if (entry.type === "ai-title" && typeof entry.aiTitle === "string") return entry.aiTitle;
      if (entry.type === "agent-name" && typeof entry.agentName === "string") return entry.agentName;
      if (entry.type === "summary" && entry.summary) {
        const s = entry.summary;
        return typeof s === "string" ? s : String(s.title ?? s.summary ?? "");
      }
      return "";
    };
    const scan = (
      text: string,
      setTitle: (t: string) => void,
      setUser: (t: string) => void,
      setCmd: (t: string) => void,
    ): void => {
      for (const line of text.split("\n")) {
        if (!line) continue;
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
        const t = titleOf(entry);
        if (t) setTitle(t);
        if (entry.type === "user" && !entry.isSidechain) {
          const c = userTextCandidate(entry.message?.content);
          if (c?.kind === "text") setUser(c.text);
          else if (c?.kind === "cmd") setCmd(c.text);
        }
      }
    };

    const fh = await fsp.open(filePath, "r");
    try {
      const headBuf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead: headN } = await fh.read(headBuf, 0, HEAD_BYTES, 0);
      let head = headBuf.toString("utf8", 0, headN);
      const headNl = head.lastIndexOf("\n");
      if (headNl > 0) head = head.slice(0, headNl);
      scan(head, (t) => { headTitle = t; }, (u) => { headUser = u; }, (c) => { headCmd = c; });
      // 文件大于头部窗口时再读尾部:最后的标题/用户消息在尾部(实测 26MB 会话
      // 的最新标题在倒数几行)。小文件头部已覆盖,跳过。
      if (headN < stat.size) {
        const tailStart = Math.max(0, stat.size - HEAD_BYTES);
        const tailBuf = Buffer.alloc(HEAD_BYTES);
        const { bytesRead: tailN } = await fh.read(tailBuf, 0, HEAD_BYTES, tailStart);
        let tail = tailBuf.toString("utf8", 0, tailN);
        // 丢掉第一行(可能半截),保留完整行。
        const firstNl = tail.indexOf("\n");
        if (firstNl >= 0) tail = tail.slice(firstNl + 1);
        scan(tail, (t) => { tailTitle = t; }, (u) => { tailUser = u; }, (c) => { tailCmd = c; });
      }
    } finally {
      await fh.close();
    }

    const summary: ClaudeSessionSummary = {
      sessionId,
      title: (tailTitle || headTitle || tailUser || headUser || tailCmd || headCmd || "(session)").slice(0, 120),
      cwd,
      projectDir,
      updatedAt,
    };
    this.summarizeCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
    return summary;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull human-readable text out of a transcript message content field. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("").trim();
}

/** True for CLI-local noise (`<local-command-...>`, `<command-name>`, caveats). */
function isLocalCommandText(text: string): boolean {
  return text.startsWith("<local-command") || text.startsWith("<command-name") || text.startsWith("Caveat:");
}

/** 原生 /resume 标题兜底候选:真实消息 → {kind:'text'};斜杠命令(还原 "/x")
 *  → {kind:'cmd'}(弱于真实消息,实测 "/model" 会话只有命令时原生才用它);
 *  caveat/stdout/中断/⎿ 错误回显 → null。 */
function userTextCandidate(content: unknown): { kind: "text" | "cmd"; text: string } | null {
  const text = extractText(content);
  if (!text) return null;
  const cmd = /^<command-name>([^<]+)<\/command-name>/.exec(text);
  if (cmd) return { kind: "cmd", text: cmd[1]!.trim() };
  if (isLocalCommandText(text)) return null;
  if (text === "[Request interrupted by user]") return null;
  if (text.startsWith("⎿")) return null;
  return { kind: "text", text };
}

/** Translate one CLI stream-json line into zero or more adapter events. */
function mapStreamEvent(ev: any): ClaudeAdapterEvent[] {
  const out: ClaudeAdapterEvent[] = [];
  switch (ev?.type) {
    case "system":
      if (ev.subtype === "init") {
        out.push({
          type: "init",
          sessionId: ev.session_id,
          cwd: ev.cwd,
          tools: Array.isArray(ev.tools) ? ev.tools : [],
        });
      }
      // hook_started/hook_response/status/thinking_tokens: internal noise, skip.
      break;

    case "stream_event": {
      const e = ev.event;
      if (e?.type === "content_block_delta") {
        const d = e.delta;
        if (d?.type === "text_delta" && typeof d.text === "string") {
          out.push({ type: "text_delta", text: d.text });
        } else if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
          out.push({ type: "thinking_delta", text: d.thinking });
        }
      }
      break;
    }

    case "assistant": {
      const content = ev.message?.content;
      if (Array.isArray(content)) {
        // 本地命令输出(/mcp 等):model 为 <synthetic>,无 delta 流,
        // 整段文本直接上来(2.1.226 实测 /mcp、/compact)。
        if (ev.message?.model === "<synthetic>") {
          const text = extractText(content);
          if (text) out.push({ type: "synthetic_text", text });
        }
        for (const block of content) {
          if (block?.type === "tool_use") {
            out.push({
              type: "tool_use",
              toolUseId: String(block.id ?? ""),
              name: String(block.name ?? ""),
              input: block.input,
            });
          }
        }
      }
      // text blocks are already covered by text_delta streaming; skip here.
      break;
    }

    case "user": {
      const content = ev.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_result") {
            out.push({
              type: "tool_result",
              toolUseId: String(block.tool_use_id ?? ""),
              content:
                typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content ?? ""),
              isError: block.is_error === true,
            });
          }
        }
      }
      break;
    }

    case "result": {
      const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
      if (denials.length > 0) {
        out.push({
          type: "permission_denied",
          denials: denials.map((d: any) => ({
            tool_name: String(d.tool_name ?? ""),
            tool_use_id: String(d.tool_use_id ?? ""),
            tool_input: d.tool_input,
          })),
        });
      }
      out.push({
        type: "done",
        sessionId: String(ev.session_id ?? ""),
        result: typeof ev.result === "string" ? ev.result : "",
        isError: ev.is_error === true,
        subtype: String(ev.subtype ?? ""),
        stopReason: ev.stop_reason ?? null,
        usage: ev.usage,
        durationMs: ev.duration_ms,
      });
      break;
    }

    default:
      break; // forward-compatible: ignore unknown event types
  }
  return out;
}
