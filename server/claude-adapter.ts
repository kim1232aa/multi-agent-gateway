/**
 * ClaudeAdapter — wraps the Claude Code CLI (tested with 2.1.220) as a
 * ProviderAdapter for the multi-agent gateway.
 *
 * Driving mechanism: each turn spawns
 *   claude -p --input-format stream-json --output-format stream-json \
 *          --include-partial-messages --verbose [--session-id <id> | --resume <id> [--fork-session]]
 * The first user message (stream-json line) is written to stdin, which stays
 * open so mid-turn 插话 can write another user line (steer). stdin closes on
 * the terminal `result` event, interrupt, or process close/error — not right
 * after the first prompt. Multi-turn conversations are continued via
 * --resume. Session transcripts live in ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl.
 *
 * Verified behaviors (2.1.220, against the configured Anthropic-compatible endpoint):
 *  - `system/subtype=init` carries session_id, cwd, tool list.
 *  - `stream_event` carries raw Anthropic SSE deltas (text_delta / thinking_delta).
 *  - `assistant` events carry complete message blocks incl. tool_use.
 *  - `user` events carry tool_result blocks.
 *  - `result` is the terminal event: { subtype: "success"|..., result, is_error,
 *    usage, permission_denials[], session_id }.
 *  - 2.1.239 实测(-p stream-json, permission-mode=manual 或缺省,stdin 开/关
 *    两种):Bash 等工具会直接执行,result.permission_denials 为空,stdout 也
 *    没有 can_use_tool control_request(工具直接执行)。因此缺省行为与从前
 *    一致,不强制 --permission-mode。若 CLI 发出 control_request,适配器
 *    park 并以 approval/question 事件上报,resolveApproval/resolveQuestion
 *    写回 control_response,不自动 deny。若 CLI 仍拒绝某次工具,会以
 *    permission_denied 事件上报。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { ProviderError } from "./types.js";

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

/** initialize 握手回包里的单条内置模型描述(CLI 权威目录,无需登录即可获取)。 */
export interface ClaudeBuiltinModel {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

export interface ClaudeHistoryMessage {
  role: "user" | "assistant";
  /** Concatenated text blocks (tool_use/tool_result blocks are skipped). */
  text: string;
  /** 结构化内容块:thinking/tool_use/tool_result,刷新后重投影用。 */
  blocks?: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  >;
  timestamp?: string;
  model?: string;
  isError?: boolean;
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
      type: "approval";
      approvalId: string;
      tool: string;
      input?: unknown;
      itemId?: string;
    }
  | {
      type: "question";
      questionId: string;
      prompt: string;
      rawQuestions?: unknown[];
    }
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

/** Parked CLI control_request waiting for resolveApproval / resolveQuestion. */
interface PendingControl {
  sessionId: string;
  kind: "approval" | "question";
  request: Record<string, unknown>;
}

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

/** Claude transcript 会话 id 是 UUID;列表/路径拼接统一用它把关。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeAdapter {
  private readonly claudeBin: string;
  private readonly env: Record<string, string>;
  private readonly projectsDir: string;
  /** sessionId -> running turn process (at most one turn per session). */
  private readonly running = new Map<string, ChildProcess>();
  /** Parked control_request rows keyed by request_id (approval / question). */
  private readonly pendingControls = new Map<string, PendingControl>();
  /** Sessions whose current turn was interrupted via interrupt(). */
  private readonly interruptRequested = new Set<string>();
  /** startTurn 的中断窗口等待者:旧进程退出时唤醒(见 startTurn/waitForExit)。 */
  private readonly exitWaiters = new Map<string, Array<() => void>>();

  constructor(options: ClaudeAdapterOptions = {}) {
    this.claudeBin = options.claudeBin ?? DEFAULT_CLAUDE_BIN;
    this.env = { ...DEFAULT_ENV, ...(options.env ?? {}) };
    this.projectsDir = options.projectsDir ?? path.join(os.homedir(), ".claude", "projects");
  }

  /** 等某会话的 running 进程退出;超时返回(不抛错,调用方自行判活)。 */
  private waitForExit(sessionId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.exitWaiters.get(sessionId);
        if (waiters) {
          const index = waiters.indexOf(done);
          if (index >= 0) waiters.splice(index, 1);
          if (waiters.length === 0) this.exitWaiters.delete(sessionId);
        }
        resolve();
      }, timeoutMs);
      timer.unref();
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const waiters = this.exitWaiters.get(sessionId) ?? [];
      waiters.push(done);
      this.exitWaiters.set(sessionId, waiters);
    });
  }

  private resolveExitWaiters(sessionId: string): void {
    const waiters = this.exitWaiters.get(sessionId);
    if (!waiters) return;
    this.exitWaiters.delete(sessionId);
    for (const done of waiters) done();
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
    /** Best-effort: emit/resolve when CLI sends can_use_tool control_request. */
    approvals: true,
    /** AskUserQuestion / questions control_request, when the shape is obvious. */
    questions: true,
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
        // 只收 UUID 会话(对齐原生 claude resume):非 UUID 的 .jsonl(用户误放/
        // 未来新命名)会进列表但 findSessionFile 打不开——点不开的条目不如不列。
        if (!UUID_RE.test(sessionId)) continue;
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
  private historyCache = new Map<string, { mtimeMs: number; size: number; messages: ClaudeHistoryMessage[] }>();

  async getHistory(sessionId: string): Promise<ClaudeHistoryMessage[]> {
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) throw new Error(`claude-adapter: session not found: ${sessionId}`);
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch {
      throw new Error(`claude-adapter: session not found: ${sessionId}`);
    }
    const hit = this.historyCache.get(sessionId);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      return hit.messages;
    }
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
      // 先收结构化块,再决定是否丢弃——原先 `if (!text) continue` 会把
      // tool_use / tool_result / 纯 thinking 整条蒸发(刷新后工具卡全没)。
      const blocks: NonNullable<ClaudeHistoryMessage["blocks"]> = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
            blocks.push({ type: "thinking", text: b.thinking });
          } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
            blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
          } else if (b.type === "tool_result") {
            const raw = b.content;
            const out = typeof raw === "string"
              ? raw
              : Array.isArray(raw)
                ? (raw as Array<Record<string, unknown>>).map((x) => (x.text as string) ?? "").join("")
                : "";
            blocks.push({
              type: "tool_result",
              tool_use_id: (b.tool_use_id as string) ?? "",
              content: out,
              ...(b.is_error === true ? { is_error: true } : {}),
            });
          }
        }
      }
      const text = extractText(msg.content);
      if (!text && blocks.length === 0) continue;
      if (type === "user" && text && isLocalCommandText(text)) continue;
      messages.push({
        role: type,
        text,
        ...(blocks.length > 0 ? { blocks } : {}),
        timestamp: entry.timestamp,
        model: type === "assistant" ? msg.model : undefined,
        isError: type === "assistant" && entry.isApiErrorMessage === true,
      });
    }
    this.historyCache.set(sessionId, { mtimeMs: st.mtimeMs, size: st.size, messages });
    return messages;
  }

  /**
   * Unlink the session transcript .jsonl. Missing file is a no-op (idempotent).
   * Clears the history / summarize caches so a later list/getHistory cannot
   * revive the deleted session.
   */
  async delete(sessionId: string): Promise<void> {
    this.interrupt(sessionId);
    this.historyCache.delete(sessionId);
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) return;
    this.summarizeCache.delete(filePath);
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") throw err;
    }
  }

  // -- startTurn ------------------------------------------------------------

  /**
   * Run one turn. Streams events via onEvent; resolves when the terminal
   * `result` event has been emitted (or rejects on spawn/protocol failure).
   */
  async startTurn(opts: StartTurnOptions): Promise<void> {
    const { sessionId, prompt, onEvent } = opts;
    if (this.running.has(sessionId)) {
      // 中断后旧进程还没退出(SIGINT→SIGKILL 最长 5s)就接到新 turn:
      // 等它退干净再起,而不是直接失败(审查实测:abort 后立刻重提 100% 撞此)。
      await this.waitForExit(sessionId, 8_000);
      if (this.running.has(sessionId)) {
        throw new Error(`claude-adapter: a turn is already running for session ${sessionId}`);
      }
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
      // 独立进程组:SIGKILL 升级/close 时整组收割,CLI 跑工具spawn的孙进程
      // 不成孤儿(此前只杀主 pid,孙子活下来继续写文件/占资源)。
      detached: true,
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
        if (ev?.type === "control_request") {
          this.parkControlRequest(sessionId, ev);
        }
        for (const mapped of mapStreamEvent(ev)) {
          if (mapped.type === "done") {
            sawResult = true;
            // Turn naturally finished: close stdin so the CLI can exit.
            // Must not close earlier — steer needs the pipe during the turn.
            endStdin(child);
          }
          onEvent(mapped);
        }
      });

      child.on("error", (err) => {
        endStdin(child);
        this.running.delete(sessionId);
        this.dropPendingForSession(sessionId);
        this.resolveExitWaiters(sessionId);
        onEvent({ type: "error", message: `spawn failed: ${err.message}` });
        reject(err);
      });

      child.on("close", (code, signal) => {
        endStdin(child);
        this.running.delete(sessionId);
        this.dropPendingForSession(sessionId);
        this.resolveExitWaiters(sessionId);
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

    // Send the first user message for this turn. Keep stdin open so steer()
    // can inject another stream-json user line mid-turn. stdin is closed on
    // result / interrupt / process close — not here.
    const userLine = JSON.stringify({
      type: "user",
      message: { role: "user", content: opts.contentBlocks ?? [{ type: "text", text: prompt }] },
    });
    // CLI 秒退时 stdin 写会异步 EPIPE,没有监听就是 uncaught;失败由 close
    // 事件如实上报(见 child.on("close"))。
    child.stdin!.on("error", () => undefined);
    child.stdin!.write(userLine + "\n");

    return done;
  }

  /**
   * Resume `sessionId` with `--fork-session` and capture the NEW session id
   * from the CLI's system/init (or result) event. Throws ProviderError
   * unsupported if the CLI never yields a different id.
   */
  async forkSession(sessionId: string, cwd?: string): Promise<{ sessionId: string }> {
    let newSessionId: string | undefined;
    const takeId = (id: string | undefined): void => {
      if (id && id !== sessionId) newSessionId = id;
    };
    await this.startTurn({
      sessionId,
      prompt: "Continue from this fork.",
      cwd,
      isNew: false,
      fork: true,
      onEvent: (ev) => {
        if (ev.type === "init") takeId(ev.sessionId);
        if (ev.type === "done") takeId(ev.sessionId);
      },
    });
    if (!newSessionId) {
      throw new ProviderError(
        "unsupported",
        `claude-adapter: CLI did not yield a new session id on --fork-session for ${sessionId}`,
        400,
      );
    }
    return { sessionId: newSessionId };
  }

  /**
   * Inject another user stream-json line into the running turn (Kimi 插话).
   * Requires a live child with writable stdin — never faked as interrupt+new turn.
   * Resolves only after the write is flushed; EPIPE / write-after-end fail so
   * the gateway can keep the prompt queued instead of marking it steered.
   */
  steer(sessionId: string, text: string): Promise<void> {
    const child = this.running.get(sessionId);
    const stdin = child?.stdin;
    if (!child || !stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) {
      return Promise.reject(
        new ProviderError("not_found", `claude-adapter: no running turn for session ${sessionId}`, 404),
      );
    }
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n";
    return new Promise((resolve, reject) => {
      stdin.write(line, (err) => {
        if (err) {
          reject(new ProviderError("not_found", `claude-adapter: steer write failed: ${err.message}`, 404, err));
          return;
        }
        resolve();
      });
    });
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
    endStdin(child);
    child.kill("SIGINT");
    const ref = setTimeout(() => {
      // child.killed 只表示信号已发出(调用即置 true),不代表进程已退出;
      // 判活要用 exitCode/signalCode,否则 SIGKILL 升级永远不生效。
      if (child.exitCode === null && child.signalCode === null) this.killGroup(child, "SIGKILL");
    }, 5000);
    ref.unref?.();
    return true;
  }

  /** 整组收割(detached spawn 的组 id = 主 pid);组不在时兜底单发。 */
  private killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
  }

  // -- approvals / questions (control_request on a live stdin) --------------

  /**
   * Answer a parked can_use_tool control_request. approve/always → allow;
   * reject → deny. Does not auto-deny: if the CLI never sent control_request
   * this throws not_found (same as no running turn).
   */
  async resolveApproval(sessionId: string, approvalId: string, decision: "allow" | "deny"): Promise<void> {
    const pending = this.pendingControls.get(approvalId);
    if (!pending || pending.kind !== "approval" || pending.sessionId !== sessionId) {
      throw new ProviderError(
        "not_found",
        `claude-adapter: no pending approval ${approvalId} for session ${sessionId}`,
        404,
      );
    }
    const input = pending.request.input;
    const response: Record<string, unknown> = { behavior: decision };
    if (decision === "allow" && input !== undefined) response.updatedInput = input;
    await this.writeControlResponse(sessionId, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: approvalId,
        response,
      },
    });
    this.pendingControls.delete(approvalId);
  }

  /**
   * Answer a parked AskUserQuestion / questions control_request. Best-effort
   * control_response: can_use_tool AskUserQuestion is allow + answers in
   * updatedInput; a dedicated AskUserQuestion subtype sends answers only.
   */
  async resolveQuestion(
    sessionId: string,
    questionId: string,
    answer: string | Record<string, string[]>,
  ): Promise<void> {
    const pending = this.pendingControls.get(questionId);
    if (!pending || pending.kind !== "question" || pending.sessionId !== sessionId) {
      throw new ProviderError(
        "not_found",
        `claude-adapter: no pending question ${questionId} for session ${sessionId}`,
        404,
      );
    }
    const answers = typeof answer === "string" ? { q_0: [answer] } : answer;
    const req = pending.request;
    const response: Record<string, unknown> =
      req.subtype === "can_use_tool"
        ? {
            behavior: "allow",
            updatedInput: {
              ...(req.input && typeof req.input === "object" ? (req.input as Record<string, unknown>) : {}),
              answers,
            },
          }
        : { answers };
    await this.writeControlResponse(sessionId, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: questionId,
        response,
      },
    });
    this.pendingControls.delete(questionId);
  }

  private parkControlRequest(sessionId: string, ev: any): void {
    const requestId = String(ev.request_id ?? ev.request?.request_id ?? "");
    if (!requestId) return;
    const req =
      ev.request && typeof ev.request === "object" ? (ev.request as Record<string, unknown>) : {};
    const kind = controlKind(req);
    if (!kind) return;
    this.pendingControls.set(requestId, { sessionId, kind, request: req });
  }

  private dropPendingForSession(sessionId: string): void {
    for (const [id, pending] of this.pendingControls) {
      if (pending.sessionId === sessionId) this.pendingControls.delete(id);
    }
  }

  private writeControlResponse(sessionId: string, payload: unknown): Promise<void> {
    const child = this.running.get(sessionId);
    const stdin = child?.stdin;
    if (!child || !stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) {
      return Promise.reject(
        new ProviderError("not_found", `claude-adapter: no running turn for session ${sessionId}`, 404),
      );
    }
    const line = JSON.stringify(payload) + "\n";
    return new Promise((resolve, reject) => {
      stdin.write(line, (err) => {
        if (err) {
          reject(
            new ProviderError(
              "not_found",
              `claude-adapter: control_response write failed: ${err.message}`,
              404,
              err,
            ),
          );
          return;
        }
        resolve();
      });
    });
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
  private static readonly COMMANDS_TTL_MS = 5 * 60_000;
  /** initialize 握手整包缓存(按 cwd):commands/models 同一次 spawn 都能取到。 */
  private handshakeCache = new Map<string, { ts: number; response: any }>();
  private handshakeInflight = new Map<string, Promise<any | null>>();

  async listSlashCommands(cwd?: string): Promise<ClaudeSlashCommand[]> {
    const response = await this.getHandshakeResponse(cwd);
    const list = response?.commands;
    if (!Array.isArray(list)) {
      // 与 listBuiltinModels 同一口径:握手失败如实抛错,不吞成空目录——
      // 空目录会让前端把"CLI 坏了"显示成"没有命令"(错误就报错,不掩盖)。
      throw new Error("claude-adapter: initialize handshake returned no commands (CLI missing, broken, or too old)");
    }
    return list
      .filter((c: any) => c && typeof c.name === "string")
      .map((c: any) => ({
        name: c.name as string,
        description: typeof c.description === "string" ? c.description : (c.name as string),
        argumentHint: typeof c.argumentHint === "string" ? c.argumentHint : "",
        aliases: Array.isArray(c.aliases) ? c.aliases.filter((a: any) => typeof a === "string") : [],
      }));
  }

  // -- 内置模型目录(initialize 握手) ------------------------------------------

  /**
   * 权威的 claude 内置模型目录 = CLI initialize 握手回包的 models 字段
   * (2.1.226 实测:default/opus[1m]/fable/sonnet/haiku,带 displayName、
   * description、supportedEffortLevels;握手不需要登录态)。未配置自定义
   * 端点时,Web 选择器必须展示这个目录,而不是拿环境变量拼占位模型。
   *
   * 与 listSlashCommands 共用握手整包缓存:切到 Claude 时 /models+/commands
   * 只 spawn 一次,不再各起一个 ~1s 进程。
   */
  async listBuiltinModels(): Promise<ClaudeBuiltinModel[]> {
    const response = await this.getHandshakeResponse(undefined);
    const list = response?.models;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("claude-adapter: initialize handshake returned no models (CLI missing, broken, or too old)");
    }
    return list
      .filter((m: any) => m && typeof m.value === "string")
      .map((m: any) => ({
        value: m.value as string,
        resolvedModel: typeof m.resolvedModel === "string" ? m.resolvedModel : undefined,
        displayName: typeof m.displayName === "string" ? m.displayName : undefined,
        description: typeof m.description === "string" ? m.description : undefined,
        supportsEffort: m.supportsEffort === true,
        supportedEffortLevels: Array.isArray(m.supportedEffortLevels)
          ? m.supportedEffortLevels.filter((e: any) => typeof e === "string")
          : undefined,
      }));
  }

  /** 取 initialize 整包(成功结果缓存 5 分钟;并发合并;失败不进缓存)。 */
  private getHandshakeResponse(cwd?: string): Promise<any | null> {
    const key = cwd ?? "";
    const hit = this.handshakeCache.get(key);
    if (hit && Date.now() - hit.ts < ClaudeAdapter.COMMANDS_TTL_MS) {
      return Promise.resolve(hit.response);
    }
    const inflight = this.handshakeInflight.get(key);
    if (inflight) return inflight;
    const pending = this.spawnHandshake(cwd).then((response) => {
      this.handshakeInflight.delete(key);
      if (response) this.handshakeCache.set(key, { ts: Date.now(), response });
      return response;
    });
    this.handshakeInflight.set(key, pending);
    return pending;
  }

  /** initialize 控制握手:起一个短命进程(不跑模型),回整包 response。 */
  private spawnHandshake(cwd: string | undefined): Promise<any | null> {
    return new Promise((resolve) => {
      const child = spawn(
        this.claudeBin,
        ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        { cwd: cwd ?? os.homedir(), env: { ...process.env, ...this.env }, stdio: ["pipe", "pipe", "pipe"] },
      );
      let settled = false;
      const finish = (value: any | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 20_000);
      timer.unref();
      child.on("error", () => finish(null));
      // spawn 成功但 CLI 启动即退(二进制损坏/缺库)不会触发 error——
      // 此前只能等满 20s 超时,且失败不进缓存,每次请求都重新卡 20s。
      child.on("exit", () => finish(null));
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
        finish(ev.response?.response ?? null);
      });
      // CLI 秒退时 stdin 写会异步 EPIPE——没有监听就是 uncaught(网关直接崩)。
      child.stdin!.on("error", () => undefined);
      // stderr 不排空会在 --verbose 输出超 ~64KB 时阻塞子进程写端,导致
      // control_response 永不到达(与 startTurn 的 stderr 消费对齐)。
      child.stderr?.resume();
      child.stdin!.write(
        JSON.stringify({ type: "control_request", request_id: "gw_init", request: { subtype: "initialize" } }) + "\n",
      );
    });
  }

  // -- close ----------------------------------------------------------------

  /** Kill all running turn processes. */
  async close(): Promise<void> {
    for (const [sessionId, child] of this.running) {
      endStdin(child);
      this.killGroup(child, "SIGTERM");
      this.running.delete(sessionId);
      this.dropPendingForSession(sessionId);
      this.resolveExitWaiters(sessionId);
    }
  }

  // -- internals --------------------------------------------------------------

  private findSessionFile(sessionId: string): string | null {
    // Claude transcript ids are UUIDs; reject separators before constructing a path.
    if (!UUID_RE.test(sessionId)) {
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

  /** 该会话的 transcript 文件是否已落盘——facade 据此决定 --session-id 还是 --resume。 */
  hasSessionFile(sessionId: string): boolean {
    return this.findSessionFile(sessionId) !== null;
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

/** Close stdin if it is still open; safe on already-ended / destroyed pipes. */
function endStdin(child: ChildProcess): void {
  const stdin = child.stdin;
  if (!stdin || stdin.destroyed || stdin.writableEnded) return;
  try {
    stdin.end();
  } catch {
    // already closed
  }
}

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

    case "control_request": {
      const requestId = String(ev.request_id ?? ev.request?.request_id ?? "");
      const req =
        ev.request && typeof ev.request === "object" ? (ev.request as Record<string, unknown>) : {};
      if (!requestId) break;
      const kind = controlKind(req);
      if (kind === "question") {
        const questions = extractQuestions(req);
        const first = questions[0] && typeof questions[0] === "object"
          ? (questions[0] as Record<string, unknown>)
          : undefined;
        const prompt =
          (typeof first?.question === "string" && first.question) ||
          (typeof first?.header === "string" && first.header) ||
          String(req.tool_name ?? "question");
        out.push({
          type: "question",
          questionId: requestId,
          prompt,
          ...(questions.length > 0 ? { rawQuestions: questions } : {}),
        });
      } else if (kind === "approval") {
        const itemId = req.tool_use_id;
        out.push({
          type: "approval",
          approvalId: requestId,
          tool: String(req.tool_name ?? ""),
          input: req.input,
          ...(typeof itemId === "string" && itemId ? { itemId } : {}),
        });
      }
      break;
    }

    default:
      break; // forward-compatible: ignore unknown event types
  }
  return out;
}

/** Classify a control_request payload: can_use_tool → approval; AskUserQuestion/questions → question. */
function controlKind(req: Record<string, unknown>): "approval" | "question" | null {
  const subtype = String(req.subtype ?? "");
  if (subtype === "AskUserQuestion" || subtype === "ask_user_question") return "question";
  if (Array.isArray(req.questions) && req.questions.length > 0) return "question";
  if (subtype === "can_use_tool") {
    const tool = String(req.tool_name ?? "");
    const input = req.input && typeof req.input === "object" ? (req.input as Record<string, unknown>) : undefined;
    if (tool === "AskUserQuestion" && Array.isArray(input?.questions)) return "question";
    return "approval";
  }
  return null;
}

function extractQuestions(req: Record<string, unknown>): unknown[] {
  if (Array.isArray(req.questions)) return req.questions;
  const input = req.input && typeof req.input === "object" ? (req.input as Record<string, unknown>) : undefined;
  if (Array.isArray(input?.questions)) return input.questions;
  return [];
}
