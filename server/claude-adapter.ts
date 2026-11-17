/**
 * ClaudeAdapter — wraps the Claude Code CLI (2.1.220–2.1.325, including 2.1.311 compat)
 * as a backend adapter for the multi-agent gateway.
 *
 * Driving mechanism: each turn spawns
 *   claude -p --input-format stream-json --output-format stream-json \
 *          --include-partial-messages --verbose --permission-prompt-tool=stdio \
 *          --forward-subagent-text [--session-id <id> | --resume <id> [--fork-session]]
 * The first user message (stream-json line) is written to stdin, which stays
 * open so mid-turn 插话 (steer) and bidirectional control requests/responses
 * can flow until the terminal `result` event, interrupt, or process close/error.
 * Multi-turn conversations continue via `--resume`. Session transcripts live in
 * `<CLAUDE_CONFIG_DIR || ~/.claude>/projects/<cwd-slug>/<sessionId>.jsonl`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { constants as fsConstants, promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { FsError, openBound, type OpenBoundOptions } from "./fs-local.js";
import { discoverClaudeDiskCommands } from "./native-commands.js";
import { ProviderError } from "./types.js";

/** 会话列表扫描文件头/尾的窗口大小。 */
const HEAD_BYTES = 256 * 1024;
/** 历史读取与 continued-in 内容核验的最大尾部/扫描窗口 (16 MiB)。 */
const MAX_HISTORY_TAIL_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_SIDECAR_BYTES = 4096;
const MAX_UNMATCHED_CONTROL_RESPONSES = 256;

const BOUNDED_APPEND_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_APPEND |
  (fsConstants.O_NONBLOCK ?? 0) |
  (fsConstants.O_NOFOLLOW ?? 0);

const OPEN_DIR_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_DIRECTORY ?? 0) |
  (fsConstants.O_NONBLOCK ?? 0) |
  (fsConstants.O_NOFOLLOW ?? 0);

const CREATE_BOUND_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (fsConstants.O_NONBLOCK ?? 0) |
  (fsConstants.O_NOFOLLOW ?? 0);

const HAS_PROC_SELF_FD = process.platform === "linux" && fs.existsSync("/proc/self/fd");

export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(public readonly maxEntries: number = 64) {}

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      const first = this.map.keys().next().value;
      if (first !== undefined) {
        this.map.delete(first);
      }
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  get size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClaudeSessionSummary {
  sessionId: string;
  /** Custom title / AI title / summary / first or last user prompt, best effort. */
  title: string;
  /** Explicit user title from JSONL `custom-title` or `custom-title.json` sidecar. */
  customTitle?: string;
  /** First meaningful user prompt in the session. */
  firstPrompt?: string;
  /** Git branch recorded in the session transcript. */
  gitBranch?: string;
  /** Working directory the session ran in (from transcript entries). */
  cwd: string;
  /** Project dir slug under ~/.claude/projects. */
  projectDir: string;
  /** ISO timestamp of last transcript entry (file mtime fallback). */
  updatedAt: string;
  /** Creation ISO timestamp from earliest transcript entry, when present. */
  createdAt?: string;
  /** Transcript file size in bytes. */
  fileSize?: number;
  /** Native archive status synchronized with `<sessionId>/archived.json`. */
  archived?: boolean;
  /** Continuation target if the tail contains an un-superseded `continued-in` entry. */
  continuedInSessionId?: string;
  /** Session creation entrypoint (e.g. 'cli', 'sdk-cli'), when known. */
  entrypoint?: string;
}

/** initialize 握手回包或磁盘发现的单条斜杠命令描述。 */
export interface ClaudeSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
  builtin?: boolean;
  source?: string;
  path?: string;
  scope?: string;
  terminalOnly?: boolean;
  allowedTools?: string[];
  model?: string;
}

/** initialize 握手回包里的单条内置模型描述(CLI 权威目录,无需登录即可获取)。 */
export interface ClaudeBuiltinModel {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsThinkingOff?: boolean;
  supportsFastMode?: boolean;
  fastMode?: boolean;
  supportsAutoMode?: boolean;
  fastModeState?: "off" | "cooldown" | "on" | string;
  fastModeDisabledReason?: string;
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
  isCompactSummary?: boolean;
  isLocalBashOutput?: boolean;
  uuid?: string;
  parentUuid?: string | null;
  agentId?: string;
  parentToolUseId?: string | null;
}

export type ClaudeApprovalDecision =
  | "allow"
  | "deny"
  | "approve"
  | "approve_always"
  | "reject";

export interface ResolveClaudeApprovalOptions {
  message?: string;
  interrupt?: boolean;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  scope?: string;
}

export type ClaudeQuestionAnswerInput = string | Record<string, string[] | string>;

export type ClaudeAdapterEvent =
  | {
      type: "init";
      sessionId: string;
      cwd: string;
      tools: string[];
      uuid?: string;
      model?: string;
      permissionMode?: string;
      slashCommands?: string[];
      terminalSlashCommands?: string[];
      skills?: string[];
      capabilities?: string[];
      claudeCodeVersion?: string;
      fastModeState?: string;
      effort?: string | null;
    }
  | {
      type: "conversation_reset";
      sessionId: string;
      newConversationId?: string;
      trigger?: string;
      uuid?: string;
    }
  | {
      type: "compact_boundary";
      sessionId: string;
      uuid?: string;
      logicalParentUuid?: string;
      parentUuid?: string | null;
      compactMetadata?: Record<string, unknown>;
    }
  | {
      type: "text_delta";
      text: string;
      uuid?: string;
      parentToolUseId?: string;
      agentId?: string;
      subagentType?: string;
    }
  | {
      type: "thinking_delta";
      text: string;
      uuid?: string;
      parentToolUseId?: string;
      agentId?: string;
      subagentType?: string;
    }
  /**
   * 本地命令(/mcp、/usage、/compact 等)的输出:assistant 事件 model 为
   * "<synthetic>",没有 stream_event delta,整段文本一次到达。
   */
  | {
      type: "synthetic_text";
      text: string;
      uuid?: string;
      parentToolUseId?: string;
      agentId?: string;
    }
  | {
      type: "tool_use";
      toolUseId: string;
      name: string;
      input: unknown;
      uuid?: string;
      parentToolUseId?: string;
      agentId?: string;
      subagentType?: string;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError: boolean;
      toolUseResult?: unknown;
      uuid?: string;
      parentToolUseId?: string;
      agentId?: string;
      subagentType?: string;
    }
  | {
      type: "tool_progress";
      toolUseId: string;
      toolName: string;
      elapsedTimeSeconds: number;
      parentToolUseId?: string;
      taskId?: string;
      subagentType?: string;
      uuid?: string;
    }
  | {
      type: "tool_use_summary";
      summary: string;
      precedingToolUseIds: string[];
      uuid?: string;
    }
  | {
      type: "task_started";
      sessionId: string;
      taskId: string;
      description: string;
      toolUseId?: string;
      subagentType?: string;
      isBackgrounded?: boolean;
      spawnDepth?: number;
      parentTaskId?: string;
      taskType?: string;
      uuid?: string;
    }
  | {
      type: "task_progress";
      sessionId: string;
      taskId: string;
      description: string;
      toolUseId?: string;
      subagentType?: string;
      usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
      lastToolName?: string;
      summary?: string;
      uuid?: string;
    }
  | {
      type: "task_updated";
      sessionId: string;
      taskId: string;
      patch: Record<string, unknown>;
      uuid?: string;
    }
  | {
      type: "task_notification";
      sessionId: string;
      taskId: string;
      status: string;
      summary: string;
      toolUseId?: string;
      outputFile?: string;
      usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
      uuid?: string;
    }
  | {
      type: "approval";
      approvalId: string;
      tool: string;
      input?: unknown;
      itemId?: string;
      suggestions?: unknown[];
      blockedPath?: string;
      decisionReason?: string;
      decisionReasonType?: string;
      suppressAlwaysAllow?: boolean;
      defaultToNo?: boolean;
      requiresUserInteraction?: boolean;
      title?: string;
      displayName?: string;
      description?: string;
      agentId?: string;
      parentToolUseId?: string;
      matchedAskRule?: Record<string, unknown>;
      classifierApprovable?: boolean;
      mcpServer?: { name: string; source: string };
    }
  | {
      type: "question";
      questionId: string;
      prompt: string;
      rawQuestions?: unknown[];
      itemId?: string;
      agentId?: string;
      parentToolUseId?: string;
    }
  | {
      type: "control_cancelled";
      requestId: string;
      kind: "approval" | "question";
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
      totalCostUsd?: number;
      modelUsage?: Record<string, unknown>;
      numTurns?: number;
      fastModeState?: string;
      durationMs?: number;
      uuid?: string;
    }
  | { type: "interrupted"; sessionId: string }
  | { type: "error"; message: string };

/** Parked CLI control_request waiting for resolveApproval / resolveQuestion. */
interface PendingControl {
  sessionId: string;
  kind: "approval" | "question";
  request: Record<string, unknown>;
}

interface PendingOutboundControl {
  resolve: (response: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface SessionControlState {
  pendingOutbound: Map<string, PendingOutboundControl>;
  unmatchedResponses: Map<string, Record<string, unknown>>;
}

interface StreamMapperState {
  streamedParentKeys: Set<string>;
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
  /** 思考档位(透传 CLI 的 --effort: low/medium/high/xhigh/max)。 */
  effort?: string;
  /**
   * 权限模式(透传 CLI 的 --permission-mode,choices:
   * default/acceptEdits/auto/bypassPermissions/manual/dontAsk/plan)。
   */
  permissionMode?: string;
  permission_mode?: string;
  /** Optional max thinking tokens budget passed to CLI. */
  maxThinkingTokens?: number;
  /** Whether to forward subagent text & thinking (`--forward-subagent-text`, default true). */
  forwardSubagentText?: boolean;
  /** Whether to enable stdio permission prompt tool (`--permission-prompt-tool=stdio`, default true). */
  permissionPromptTool?: boolean;
  /** Optional settings JSON object passed via `--settings`. */
  settings?: Record<string, unknown>;
  /**
   * 完整 user content 块(图片/PDF 附件时优先于 prompt 单文本块;
   * stream-json 接受 image/document base64 block)。
   */
  contentBlocks?: Array<Record<string, unknown>>;
  onEvent: (event: ClaudeAdapterEvent) => void;
}

export interface GetHistoryOptions {
  /** Follow `continued-in` chain to the latest valid continuation transcript. */
  followContinuedIn?: boolean;
  /** Include subagent transcripts under `<sessionId>/subagents/agent-*.jsonl`. */
  includeSubagents?: boolean;
  /** Test/verification hook invoked inside `openBound` after preflight checks. */
  beforeAnchoredOpen?: () => void | Promise<void>;
}

export interface AnchoredOpOptions {
  /** Test/verification hook invoked after discovery and before anchored handle traversal. */
  beforeAnchoredOp?: () => void | Promise<void>;
}

export interface ListSlashCommandsOptions {
  /** Fall back to zero-spawn disk discovery if initialize fails (default true). */
  diskFallback?: boolean;
  /** Skip spawning the CLI entirely and use zero-spawn disk discovery. */
  diskOnly?: boolean;
}

export class UnsupportedCapability extends Error {
  constructor(capability: string) {
    super(
      `claude-adapter: "${capability}" is not supported by the Claude CLI in ` +
        `non-interactive stream-json mode (tools needing permission require ` +
        `--permission-prompt-tool=stdio).`,
    );
    this.name = "UnsupportedCapability";
  }
}

export interface ClaudeAdapterOptions {
  /** Path to the claude binary. */
  claudeBin?: string;
  /** Extra/override env for the claude subprocess (merged over the defaults). */
  env?: Record<string, string>;
  /** Root of claude session transcripts. Default `<configDir>/projects`. */
  projectsDir?: string;
  /** Root Claude config dir. Default `CLAUDE_CONFIG_DIR || ~/.claude`. */
  configDir?: string;
  /** Gateway-managed provider (`--settings <gateway file>`), read at every spawn. */
  injection?: () => { args: string[]; env: Record<string, string> };
}

// ---------------------------------------------------------------------------
// Default environment & path/executable resolution
// ---------------------------------------------------------------------------

// 只放无密默认值;上游地址/密钥/模型一律由部署方经进程环境变量注入。
const DEFAULT_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

/** Claude transcript 会话 id 是 UUID;列表/路径拼接统一用它把关。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTROL_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
]);

function findExecutableOnPath(binName: string, pathEnv: string | undefined): string | null {
  if (!pathEnv) return null;
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const ext of exts) {
      const candidateName =
        ext && !binName.toLowerCase().endsWith(ext.toLowerCase()) ? `${binName}${ext}` : binName;
      const candidate = path.join(trimmed, candidateName);
      try {
        const st = fs.statSync(candidate);
        if (!st.isFile()) continue;
        if (process.platform !== "win32") {
          fs.accessSync(candidate, fsConstants.X_OK);
        }
        return candidate;
      } catch {
        // continue scanning PATH
      }
    }
  }
  return null;
}

/**
 * Resolve the Claude CLI binary path with precedence:
 * 1. `options.claudeBin`
 * 2. `CLAUDE_BIN` (`options.env.CLAUDE_BIN` then `process.env.CLAUDE_BIN`)
 * 3. `claude` executable on `PATH` (`options.env.PATH` then `process.env.PATH`)
 * 4. `~/.local/bin/claude` fallback
 */
export function resolveClaudeBin(options: { claudeBin?: string; env?: Record<string, string> } = {}): string {
  const explicit = options.claudeBin?.trim();
  if (explicit) return explicit;

  const rawEnvBin =
    options.env && "CLAUDE_BIN" in options.env ? options.env.CLAUDE_BIN : process.env.CLAUDE_BIN;
  const envBin = rawEnvBin?.trim();
  if (envBin) return envBin;

  const pathEnv = options.env && "PATH" in options.env ? options.env.PATH : process.env.PATH;
  const onPath = findExecutableOnPath("claude", pathEnv);
  if (onPath) return onPath;

  const rawHome = options.env && "HOME" in options.env ? options.env.HOME : undefined;
  const home = rawHome?.trim() || os.homedir();
  const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
  return path.join(home, ".local", "bin", binaryName);
}

/**
 * Build child environment stripping inherited `GATEWAY_*` variables while
 * preserving explicit `envOverrides` and `DEFAULT_ENV`.
 */
export function buildClaudeChildEnv(
  envOverrides?: Record<string, string>,
  configDir?: string,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GATEWAY_/i.test(key)),
  );
  return {
    ...inherited,
    ...DEFAULT_ENV,
    ...(envOverrides ?? {}),
    ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
  };
}

/**
 * Map gateway / CLI permission mode strings to valid control-protocol
 * `set_permission_mode` modes without ever sending CLI-only `manual` over control.
 */
export function mapControlPermissionMode(mode: string): string {
  const trimmed = mode.trim();
  if (trimmed === "manual") return "default";
  if (trimmed === "yolo") return "bypassPermissions";
  if (CONTROL_PERMISSION_MODES.has(trimmed)) return trimmed;
  throw new ProviderError("invalid_request", `claude-adapter: unsupported permission mode: ${mode}`, 400);
}

function validateCliArg(name: string, val: unknown): void {
  if (val === undefined || val === null || val === "") return;
  if (typeof val !== "string" || val.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(val)) {
    throw new ProviderError(
      "invalid_request",
      `claude-adapter: invalid ${name} "${val}": cannot start with '-' or contain whitespace/control characters`,
      400,
    );
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeAdapter {
  private readonly claudeBin: string;
  private readonly env: Record<string, string>;
  private readonly homeDir: string;
  private readonly configDir: string;
  private readonly explicitConfigDir?: string;
  private readonly projectsDir: string;
  /** sessionId -> running turn process (at most one turn per session). */
  private readonly running = new Map<string, ChildProcess>();
  /** sessionId -> outbound control_request correlation state. */
  private readonly sessionControls = new Map<string, SessionControlState>();
  /** Parked control_request rows keyed by request_id (approval / question). */
  private readonly pendingControls = new Map<string, PendingControl>();
  /** Sessions whose current turn was interrupted via interrupt(). */
  private readonly interruptRequested = new Set<string>();
  /** Active interrupt fallback timers per session, cleared on exit. */
  private readonly interruptTimers = new Map<string, Set<NodeJS.Timeout>>();
  /** Child processes that have already initiated interrupt escalation. */
  private readonly interruptingChildren = new WeakSet<ChildProcess>();
  /** startTurn 的中断窗口等待者:旧进程退出时唤醒(见 startTurn/waitForExit)。 */
  private readonly exitWaiters = new Map<string, Array<() => void>>();
  /** Ephemeral fork/control-probe children tracked so close() terminates them immediately. */
  private readonly activeProbes = new Set<ChildProcess>();
  private closed = false;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.claudeBin = resolveClaudeBin(options);
    const rawHome = options.env && "HOME" in options.env ? options.env.HOME : undefined;
    this.homeDir = rawHome?.trim() || os.homedir();
    const rawEnvConfigDir =
      options.env && "CLAUDE_CONFIG_DIR" in options.env
        ? options.env.CLAUDE_CONFIG_DIR
        : process.env.CLAUDE_CONFIG_DIR;
    this.explicitConfigDir =
      options.configDir?.trim() ||
      rawEnvConfigDir?.trim() ||
      undefined;
    this.configDir = this.explicitConfigDir ?? path.join(this.homeDir, ".claude");
    this.env = { ...DEFAULT_ENV, ...(options.env ?? {}) };
    this.projectsDir = options.projectsDir ?? path.join(this.configDir, "projects");
    this.injection = options.injection;
  }

  private readonly injection?: () => { args: string[]; env: Record<string, string> };

  private childEnv(): NodeJS.ProcessEnv {
    return buildClaudeChildEnv({ ...this.env, ...(this.injection?.().env ?? {}) }, this.explicitConfigDir);
  }

  /**
   * `--settings` for a spawn. Claude takes one `--settings`; a turn's own inline settings are
   * merged over the gateway provider file so neither is dropped.
   */
  private settingsArgs(inline?: Record<string, unknown>): string[] {
    const injected = this.injection?.().args ?? [];
    const at = injected.indexOf("--settings");
    const file = at >= 0 ? injected[at + 1] : undefined;
    if (!inline) return file ? ["--settings", file] : [];
    if (!file) return ["--settings", JSON.stringify(inline)];
    let base: Record<string, unknown> = {};
    try { base = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>; } catch { /* missing: inline only */ }
    const env = { ...((base.env as Record<string, unknown>) ?? {}), ...((inline.env as Record<string, unknown>) ?? {}) };
    return ["--settings", JSON.stringify({ ...base, ...inline, ...(Object.keys(env).length ? { env } : {}) })];
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

  private trackInterruptTimer(sessionId: string, timer: NodeJS.Timeout): void {
    let set = this.interruptTimers.get(sessionId);
    if (!set) {
      set = new Set();
      this.interruptTimers.set(sessionId, set);
    }
    set.add(timer);
  }

  private clearInterruptTimers(sessionId: string): void {
    const set = this.interruptTimers.get(sessionId);
    if (!set) return;
    for (const timer of set) clearTimeout(timer);
    this.interruptTimers.delete(sessionId);
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
    approvals: true,
    questions: true,
    subagents: true,
    nativeArchive: true,
    rename: true,
    delete: true,
    mcp: true,
  };

  // -- list -----------------------------------------------------------------

  /**
   * Scan `<configDir>/projects/<slug>/<sessionId>.jsonl` into session summaries.
   * Only lists top-level UUID `.jsonl` transcripts; skips symlinks/FIFOs via
   * `openBound`, resolves `continued-in` chains, reads `custom-title` and
   * `archived.json` native metadata.
   */
  async list(): Promise<ClaudeSessionSummary[]> {
    const rawSummaries: ClaudeSessionSummary[] = [];
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return rawSummaries;
    }

    let realRoot: string;
    try {
      realRoot = fs.realpathSync(this.projectsDir);
    } catch {
      realRoot = path.resolve(this.projectsDir);
    }

    const tasks: (() => Promise<void>)[] = [];
    for (const dirEnt of projectDirs) {
      if (dirEnt.isSymbolicLink() || !dirEnt.isDirectory()) continue;
      const dirPath = path.join(this.projectsDir, dirEnt.name);
      let realDir: string;
      try {
        realDir = fs.realpathSync(dirPath);
      } catch {
        continue;
      }
      if (!isWithinDir(realRoot, realDir)) continue;

      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(realDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const fileEnt of files) {
        if (fileEnt.isSymbolicLink() || !fileEnt.isFile()) continue;
        if (!fileEnt.name.endsWith(".jsonl")) continue;
        const sessionId = fileEnt.name.slice(0, -".jsonl".length);
        if (!UUID_RE.test(sessionId)) continue;
        const filePath = path.join(realDir, fileEnt.name);
        tasks.push(async () => {
          try {
            const s = await this.summarizeSessionFile(sessionId, dirEnt.name, filePath, realRoot);
            if (s) rawSummaries.push(s);
          } catch {
            // unreadable / symlink / malformed transcript — skip
          }
        });
      }
    }

    const CONCURRENCY = 8;
    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
      await Promise.all(tasks.slice(i, i + CONCURRENCY).map((t) => t()));
    }

    // Filter out sessions superseded by a valid non-empty `continued-in` chain.
    const byId = new Map<string, ClaudeSessionSummary>();
    for (const s of rawSummaries) byId.set(s.sessionId, s);

    const out: ClaudeSessionSummary[] = [];
    for (const s of rawSummaries) {
      if (s.continuedInSessionId && (await this.hasValidContinuedTarget(s, byId, realRoot))) {
        continue;
      }
      out.push(s);
    }

    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }

  /** Alias for list() matching ProviderAdapter / store discovery conventions. */
  async listSessions(): Promise<ClaudeSessionSummary[]> {
    return this.list();
  }

  private async hasValidContinuedTarget(
    source: ClaudeSessionSummary,
    byId: Map<string, ClaudeSessionSummary>,
    realRoot: string,
  ): Promise<boolean> {
    const visited = new Set<string>([source.sessionId]);
    let currentId: string | undefined = source.continuedInSessionId;
    while (currentId && UUID_RE.test(currentId) && !visited.has(currentId)) {
      visited.add(currentId);
      const candidateFile =
        this.findSessionFileInProjectDir(path.join(this.projectsDir, source.projectDir), currentId, realRoot) ??
        this.findSessionFile(currentId);
      if (!candidateFile) return false;
      const hasMessages = await this.transcriptHasConversation(candidateFile, realRoot);
      if (hasMessages) return true;
      const nextSummary = byId.get(currentId);
      currentId = nextSummary?.continuedInSessionId;
    }
    return false;
  }

  private async transcriptHasConversation(filePath: string, realRoot: string): Promise<boolean> {
    try {
      const { fh, stat } = await this.openTranscriptBound(filePath, realRoot);
      try {
        if (stat.size === 0) return false;
        const scanMax = Math.min(stat.size, MAX_HISTORY_TAIL_BYTES);
        const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, scanMax));
        let offset = 0;
        let carry = "";
        while (offset < scanMax) {
          const toRead = Math.min(buf.length, scanMax - offset);
          const { bytesRead } = await fh.read(buf, 0, toRead, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
          const chunkStr = carry + buf.toString("utf8", 0, bytesRead);
          if (chunkStr.includes('"parentUuid":')) return true;
          const lines = chunkStr.split("\n");
          carry = lines.pop() ?? "";
          for (const line of lines) {
            if (lineHasConversationEntry(line)) return true;
          }
        }
        if (carry && lineHasConversationEntry(carry)) return true;
        return stat.size > MAX_HISTORY_TAIL_BYTES;
      } finally {
        await fh.close().catch(() => undefined);
      }
    } catch {
      return false;
    }
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

  /** Parse the session transcript into user/assistant messages using 16 MiB tail + branch pruning. */
  private historyCache = new LruCache<string, { key: string; messages: ClaudeHistoryMessage[] }>(64);

  async getHistory(sessionId: string, options: GetHistoryOptions = {}): Promise<ClaudeHistoryMessage[]> {
    const resolvedId = options.followContinuedIn
      ? await this.resolveContinuedSessionId(sessionId)
      : sessionId;
    const filePath = this.findSessionFile(resolvedId);
    if (!filePath) throw new Error(`claude-adapter: session not found: ${sessionId}`);

    const realRoot = await this.realProjectsRoot();
    let opened: { fh: fsp.FileHandle; stat: fs.Stats };
    try {
      opened = await this.openTranscriptBound(
        filePath,
        realRoot,
        options.beforeAnchoredOpen ? { beforeAnchoredOpen: options.beforeAnchoredOpen } : undefined,
      );
    } catch (err) {
      if (err instanceof FsError && err.code === "not_found") {
        throw new Error(`claude-adapter: session not found: ${sessionId}`);
      }
      throw err;
    }

    const { fh, stat: st } = opened;
    try {
      let subMtime = 0;
      if (options.includeSubagents) {
        try {
          const subagentsDir = path.join(path.dirname(filePath), resolvedId, "subagents");
          const subStat = await fsp.stat(subagentsDir);
          subMtime = subStat.mtimeMs;
        } catch {
          subMtime = 0;
        }
      }

      const cacheKey = `${resolvedId}:${options.includeSubagents ? "sub" : "main"}`;
      const cacheTag = options.includeSubagents
        ? `${st.mtimeMs}:${st.size}:${subMtime}`
        : `${st.mtimeMs}:${st.size}`;
      const hit = this.historyCache.get(cacheKey);
      if (hit && hit.key === cacheTag) {
        return hit.messages;
      }

      const text = await readTailWindowUtf8(fh, st.size, MAX_HISTORY_TAIL_BYTES);
      const messages = parseHistoryTranscript(text);

      if (options.includeSubagents) {
        const subIds = await this.listSubagents(resolvedId).catch(() => []);
        for (const agentId of subIds) {
          const subMsgs = await this.getSubagentMessages(resolvedId, agentId).catch(() => []);
          messages.push(...subMsgs);
        }
      }

      this.historyCache.set(cacheKey, { key: cacheTag, messages });
      return messages;
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  /** Follow `continued-in` chain up to the latest valid continuation session ID (cycle-safe). */
  async resolveContinuedSessionId(sessionId: string): Promise<string> {
    if (!UUID_RE.test(sessionId)) return sessionId;
    const realRoot = await this.realProjectsRoot();
    const visited = new Set<string>();
    let current = sessionId;

    while (!visited.has(current)) {
      visited.add(current);
      const filePath = this.findSessionFile(current);
      if (!filePath) break;
      let tail = "";
      try {
        const { fh, stat } = await this.openTranscriptBound(filePath, realRoot);
        try {
          tail = await readTailWindowUtf8(fh, stat.size, HEAD_BYTES);
        } finally {
          await fh.close().catch(() => undefined);
        }
      } catch {
        break;
      }
      const nextId = extractTrailingContinuedIn(tail);
      if (!nextId || visited.has(nextId)) break;
      const nextFile =
        this.findSessionFileInProjectDir(path.dirname(filePath), nextId, realRoot) ??
        this.findSessionFile(nextId);
      if (!nextFile) break;
      const hasContent = await this.transcriptHasConversation(nextFile, realRoot);
      if (!hasContent) break;
      current = nextId;
    }
    return current;
  }

  // -- subagents ------------------------------------------------------------

  // List subagent IDs from `<projectDir>/<sessionId>/subagents/.../agent-*.jsonl`.
  async listSubagents(sessionId: string): Promise<string[]> {
    if (!UUID_RE.test(sessionId)) return [];
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) return [];

    const realRoot = await this.realProjectsRoot();
    const sessionDir = path.join(path.dirname(filePath), sessionId);
    const subagentsDir = path.join(sessionDir, "subagents");
    if (!(await this.isSafeDirectoryWithinRoot(sessionDir, realRoot))) return [];
    if (!(await this.isSafeDirectoryWithinRoot(subagentsDir, realRoot))) return [];

    const found = await this.scanSubagentFiles(subagentsDir, realRoot);
    return found.map((entry) => entry.agentId);
  }

  /** List subagent details including metadata mapped from `<session>/subagents/agent-*.meta.json`. */
  async listSubagentDetails(sessionId: string): Promise<Array<{
    agentId: string;
    parentToolUseId?: string;
    description?: string;
    subagentType?: string;
    taskId?: string;
  }>> {
    if (!UUID_RE.test(sessionId)) return [];
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) return [];

    const realRoot = await this.realProjectsRoot();
    const sessionDir = path.join(path.dirname(filePath), sessionId);
    const subagentsDir = path.join(sessionDir, "subagents");
    if (!(await this.isSafeDirectoryWithinRoot(sessionDir, realRoot))) return [];
    if (!(await this.isSafeDirectoryWithinRoot(subagentsDir, realRoot))) return [];

    const files = await this.scanSubagentFiles(subagentsDir, realRoot);
    const results: Array<{
      agentId: string;
      parentToolUseId?: string;
      description?: string;
      subagentType?: string;
      taskId?: string;
    }> = [];

    for (const f of files) {
      let parentToolUseId: string | undefined;
      let description: string | undefined;
      let subagentType: string | undefined;
      let taskId: string | undefined;

      const metaPath = f.filePath.replace(/\.jsonl$/, ".meta.json");
      const metaText = await this.readBoundedSidecarText(metaPath, realRoot, MAX_SIDECAR_BYTES);
      if (metaText) {
        try {
          const meta = JSON.parse(metaText) as Record<string, unknown>;
          if (typeof meta.toolUseId === "string" && meta.toolUseId) parentToolUseId = meta.toolUseId;
          else if (typeof meta.parentToolUseId === "string" && meta.parentToolUseId) parentToolUseId = meta.parentToolUseId;
          if (typeof meta.description === "string" && meta.description) description = meta.description;
          if (typeof meta.agentType === "string" && meta.agentType) subagentType = meta.agentType;
          else if (typeof meta.subagentType === "string" && meta.subagentType) subagentType = meta.subagentType;
          if (typeof meta.taskId === "string" && meta.taskId) taskId = meta.taskId;
        } catch {
          // ignore malformed sidecar
        }
      }

      results.push({
        agentId: f.agentId,
        ...(parentToolUseId ? { parentToolUseId } : {}),
        ...(description ? { description } : {}),
        ...(subagentType ? { subagentType } : {}),
        ...(taskId ? { taskId } : {}),
      });
    }

    return results;
  }

  /** Read and branch-prune a subagent transcript `subagents/agent-<agentId>.jsonl`. */
  async getSubagentMessages(sessionId: string, agentId: string): Promise<ClaudeHistoryMessage[]> {
    if (!UUID_RE.test(sessionId)) return [];
    if (!isSafeAgentId(agentId)) {
      throw new ProviderError("invalid_request", `claude-adapter: invalid subagent id: ${agentId}`, 400);
    }
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) return [];

    const realRoot = await this.realProjectsRoot();
    const sessionDir = path.join(path.dirname(filePath), sessionId);
    const subagentsDir = path.join(sessionDir, "subagents");
    if (!(await this.isSafeDirectoryWithinRoot(sessionDir, realRoot))) return [];
    if (!(await this.isSafeDirectoryWithinRoot(subagentsDir, realRoot))) return [];

    const files = await this.scanSubagentFiles(subagentsDir, realRoot);
    const match = files.find((f) => f.agentId === agentId);
    if (!match) return [];

    const { fh, stat } = await this.openTranscriptBound(match.filePath, realRoot);
    let text: string;
    try {
      text = await readTailWindowUtf8(fh, stat.size, MAX_HISTORY_TAIL_BYTES);
    } finally {
      await fh.close().catch(() => undefined);
    }

    let parentToolUseId: string | null = null;
    const metaPath = match.filePath.replace(/\.jsonl$/, ".meta.json");
    const metaText = await this.readBoundedSidecarText(metaPath, realRoot, MAX_SIDECAR_BYTES);
    if (metaText) {
      try {
        const meta = JSON.parse(metaText) as Record<string, unknown>;
        if (typeof meta.toolUseId === "string" && meta.toolUseId) {
          parentToolUseId = meta.toolUseId;
        }
      } catch {
        // ignore malformed sidecar
      }
    }

    const messages = parseHistoryTranscript(text, { allowSidechain: true });
    return messages.map((m) => ({
      ...m,
      agentId,
      ...(parentToolUseId ? { parentToolUseId } : {}),
    }));
  }

  private async scanSubagentFiles(
    subagentsDir: string,
    realRoot: string,
  ): Promise<Array<{ agentId: string; filePath: string }>> {
    const out: Array<{ agentId: string; filePath: string }> = [];
    const queue: string[] = [subagentsDir];
    let visitedDirs = 0;

    while (queue.length > 0 && visitedDirs < 128) {
      const dir = queue.shift()!;
      visitedDirs += 1;
      if (!(await this.isSafeDirectoryWithinRoot(dir, realRoot))) continue;
      let dirents: fs.Dirent[];
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of dirents) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          queue.push(full);
          continue;
        }
        if (entry.isFile() && entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl")) {
          const agentId = entry.name.slice("agent-".length, -".jsonl".length);
          if (isSafeAgentId(agentId)) {
            out.push({ agentId, filePath: full });
          }
        }
      }
    }
    return out;
  }

  // -- rename / archive / delete --------------------------------------------

  /**
   * Persist a custom session title by appending a `custom-title` entry to the
   * session JSONL transcript via anchored directory handles (O_WRONLY | O_APPEND | O_NONBLOCK | O_NOFOLLOW).
   */
  async rename(sessionId: string, title: string, options?: AnchoredOpOptions): Promise<void> {
    if (!UUID_RE.test(sessionId)) {
      throw new ProviderError("invalid_request", `claude-adapter: invalid sessionId: ${sessionId}`, 400);
    }
    const trimmed = sanitizeTitle(title);
    if (!trimmed) {
      throw new ProviderError("invalid_request", "claude-adapter: title must be non-empty", 400);
    }

    const filePath = this.findSessionFile(sessionId);
    if (!filePath) {
      if (this.running.has(sessionId)) {
        await this.sendControlRequest(sessionId, {
          subtype: "rename_session",
          title: trimmed,
          source: "host",
          session_id: sessionId,
        });
        return;
      }
      throw new ProviderError("not_found", `claude-adapter: session not found: ${sessionId}`, 404);
    }

    const realRoot = await this.realProjectsRoot();
    const anchoredTarget = this.anchorTargetToRoot(filePath, realRoot);
    const relSegments = splitSafeRelSegments(path.relative(realRoot, anchoredTarget));
    if (relSegments.length < 2) {
      throw new ProviderError("invalid_request", "claude-adapter: invalid transcript location", 400);
    }
    const leafName = relSegments[relSegments.length - 1]!;
    const dirSegments = relSegments.slice(0, -1);

    if (options?.beforeAnchoredOp) {
      await options.beforeAnchoredOp();
    }

    const dirHandle = await openAnchoredDir(realRoot, dirSegments);
    try {
      const leafTarget = dirChildPath(dirHandle, leafName);
      const expectedLst = await fsp.lstat(leafTarget).catch((err: unknown) => {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          throw new ProviderError("not_found", `claude-adapter: session not found: ${sessionId}`, 404);
        }
        throw err;
      });
      if (expectedLst.isSymbolicLink() || !expectedLst.isFile()) {
        throw new ProviderError("invalid_request", "claude-adapter: refusing to append to non-regular file", 400);
      }

      let fh: fsp.FileHandle;
      try {
        fh = await fsp.open(leafTarget, BOUNDED_APPEND_FLAGS);
      } catch (err) {
        throw mapAppendOpenError(err, anchoredTarget);
      }
      try {
        const st = await fh.stat();
        if (
          !st.isFile() ||
          st.dev !== expectedLst.dev ||
          (process.platform !== "win32" && st.ino !== expectedLst.ino)
        ) {
          throw new ProviderError("invalid_request", "claude-adapter: transcript changed during rename", 400);
        }
        const line =
          JSON.stringify({
            type: "custom-title",
            customTitle: trimmed,
            sessionId,
            timestamp: new Date().toISOString(),
          }) + "\n";
        const buf = Buffer.from(line, "utf8");
        let written = 0;
        const position = process.platform === "win32" ? st.size : null;
        while (written < buf.length) {
          const { bytesWritten } = await fh.write(
            buf,
            written,
            buf.length - written,
            position === null ? null : position + written,
          );
          if (bytesWritten <= 0) {
            throw new ProviderError("upstream_error", "claude-adapter: short write during rename", 500);
          }
          written += bytesWritten;
        }
      } finally {
        await fh.close().catch(() => undefined);
      }
    } finally {
      await dirHandle.dirFd.close().catch(() => undefined);
    }

    this.summarizeCache.delete(filePath);
    this.invalidateHistoryCacheForSession(sessionId);

    if (this.running.has(sessionId)) {
      await this.sendControlRequest(sessionId, {
        subtype: "rename_session",
        title: trimmed,
        source: "host",
        session_id: sessionId,
      }).catch(() => undefined);
    }
  }

  /**
   * Synchronize native archive state to `<projectDir>/<sessionId>/archived.json`
   * through anchored directory handles within the validated projects root.
   */
  async setArchived(sessionId: string, archived: boolean, options?: AnchoredOpOptions): Promise<void> {
    if (!UUID_RE.test(sessionId)) {
      throw new ProviderError("invalid_request", `claude-adapter: invalid sessionId: ${sessionId}`, 400);
    }
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) {
      throw new ProviderError("not_found", `claude-adapter: session not found: ${sessionId}`, 404);
    }

    const realRoot = await this.realProjectsRoot();
    const anchoredTarget = this.anchorTargetToRoot(filePath, realRoot);
    const relSegments = splitSafeRelSegments(path.relative(realRoot, anchoredTarget));
    if (relSegments.length < 2) {
      throw new ProviderError("invalid_request", "claude-adapter: invalid transcript location", 400);
    }
    const dirSegments = relSegments.slice(0, -1);

    if (options?.beforeAnchoredOp) {
      await options.beforeAnchoredOp();
    }

    const projectHandle = await openAnchoredDir(realRoot, dirSegments);
    try {
      const sessionHandle = await ensureAnchoredDirChild(projectHandle, sessionId);
      try {
        const archiveTarget = dirChildPath(sessionHandle, "archived.json");
        const lst = await fsp.lstat(archiveTarget).catch(() => null);
        if (lst && lst.isSymbolicLink()) {
          throw new ProviderError("invalid_request", "claude-adapter: archived.json must not be a symlink", 400);
        }

        const payload = JSON.stringify({
          archived: Boolean(archived),
          at: new Date().toISOString(),
          by: "gateway",
        });
        const tmpName = `.archived.${randomUUID()}.tmp`;
        const tmpTarget = dirChildPath(sessionHandle, tmpName);
        const tmpFh = await fsp.open(tmpTarget, CREATE_BOUND_FLAGS, 0o600);
        try {
          await tmpFh.writeFile(payload, "utf8");
        } finally {
          await tmpFh.close().catch(() => undefined);
        }
        try {
          await fsp.rename(tmpTarget, archiveTarget);
        } catch (err) {
          await fsp.unlink(tmpTarget).catch(() => undefined);
          throw err;
        }
      } finally {
        await sessionHandle.dirFd.close().catch(() => undefined);
      }
    } finally {
      await projectHandle.dirFd.close().catch(() => undefined);
    }

    this.summarizeCache.delete(filePath);
  }

  /**
   * Unlink the session transcript `.jsonl` and safely remove its validated
   * `subagents` directory (and owned session artifact dir) through anchored
   * `O_DIRECTORY | O_NOFOLLOW` handles within `projectsDir`. Missing file is a
   * no-op (idempotent). Refuses symlink escapes outside root.
   */
  async delete(sessionId: string, options?: AnchoredOpOptions): Promise<void> {
    this.interrupt(sessionId);
    this.invalidateHistoryCacheForSession(sessionId);
    if (!UUID_RE.test(sessionId)) return;

    const filePath = this.findSessionFile(sessionId);
    if (!filePath) return;

    this.summarizeCache.delete(filePath);

    const realRoot = await this.realProjectsRoot();
    const anchoredTarget = this.anchorTargetToRoot(filePath, realRoot);
    const relSegments = splitSafeRelSegments(path.relative(realRoot, anchoredTarget));
    if (relSegments.length < 2) {
      throw new ProviderError("invalid_request", "claude-adapter: invalid transcript location", 400);
    }
    const leafName = relSegments[relSegments.length - 1]!;
    const dirSegments = relSegments.slice(0, -1);

    if (options?.beforeAnchoredOp) {
      await options.beforeAnchoredOp();
    }

    const projectHandle = await openAnchoredDir(realRoot, dirSegments);
    let sessionHandle: AnchoredDirHandle | null = null;
    let subagentsHandle: AnchoredDirHandle | null = null;
    try {
      const leafTarget = dirChildPath(projectHandle, leafName);
      const fileLst = await fsp.lstat(leafTarget).catch((err: unknown) => {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw err;
      });
      if (fileLst && (fileLst.isSymbolicLink() || !fileLst.isFile())) {
        throw new ProviderError("invalid_request", "claude-adapter: refusing to delete symlinked or non-regular transcript", 400);
      }

      sessionHandle = await openAnchoredDirChildOptional(projectHandle, sessionId, "session directory");
      if (sessionHandle) {
        subagentsHandle = await openAnchoredDirChildOptional(sessionHandle, "subagents", "subagents directory");
      }

      if (fileLst) {
        try {
          await fsp.unlink(leafTarget);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== "ENOENT") throw err;
        }
      }

      if (sessionHandle) {
        if (subagentsHandle) {
          await purgeAnchoredDirContents(subagentsHandle);
          await subagentsHandle.dirFd.close().catch(() => undefined);
          subagentsHandle = null;
          await fsp.rmdir(dirChildPath(sessionHandle, "subagents")).catch((err: unknown) => {
            const code = (err as NodeJS.ErrnoException | undefined)?.code;
            if (code !== "ENOENT") throw err;
          });
        }
        for (const sidecar of ["archived.json", "custom-title.json"]) {
          await fsp.unlink(dirChildPath(sessionHandle, sidecar)).catch((err: unknown) => {
            const code = (err as NodeJS.ErrnoException | undefined)?.code;
            if (code !== "ENOENT") throw err;
          });
        }
        await sessionHandle.dirFd.close().catch(() => undefined);
        sessionHandle = null;
        await fsp.rmdir(dirChildPath(projectHandle, sessionId)).catch(() => undefined);
      }
    } finally {
      if (subagentsHandle) await subagentsHandle.dirFd.close().catch(() => undefined);
      if (sessionHandle) await sessionHandle.dirFd.close().catch(() => undefined);
      await projectHandle.dirFd.close().catch(() => undefined);
    }
  }

  // -- startTurn ------------------------------------------------------------

  /**
   * Run one turn. Streams events via onEvent; resolves when the terminal
   * `result` event has been emitted (or rejects on spawn/protocol failure).
   */
  async startTurn(opts: StartTurnOptions): Promise<void> {
    if (this.closed) {
      throw new Error("claude-adapter: adapter closed");
    }
    const { sessionId, prompt, onEvent } = opts;
    if (this.running.has(sessionId)) {
      await this.waitForExit(sessionId, 8_000);
      if (this.closed) {
        throw new Error("claude-adapter: adapter closed");
      }
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
    if (opts.permissionPromptTool !== false) {
      args.push("--permission-prompt-tool=stdio");
    }
    if (opts.forwardSubagentText !== false) {
      args.push("--forward-subagent-text");
    }
    if (opts.isNew) {
      args.push("--session-id", sessionId);
    } else {
      args.push("--resume", sessionId);
      if (opts.fork) args.push("--fork-session");
    }
    const model = opts.model;
    const effort = opts.effort;
    const permissionMode = opts.permissionMode ?? opts.permission_mode;

    validateCliArg("model", model);
    validateCliArg("effort", effort);
    validateCliArg("permission_mode", permissionMode);

    if (model) args.push("--model", model);
    if (effort && effort !== "auto" && effort !== "on") {
      args.push("--effort", effort);
    }
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (opts.maxThinkingTokens !== undefined) {
      args.push("--max-thinking-tokens", String(opts.maxThinkingTokens));
    }
    args.push(...this.settingsArgs(opts.settings));

    const child = spawn(this.claudeBin, args, {
      cwd,
      env: this.childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.running.set(sessionId, child);
    const controlState: SessionControlState = {
      pendingOutbound: new Map(),
      unmatchedResponses: new Map(),
    };
    this.sessionControls.set(sessionId, controlState);
    const mapperState: StreamMapperState = { streamedParentKeys: new Set() };

    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
    });

    const cleanupTurnState = (err?: Error): void => {
      this.clearInterruptTimers(sessionId);
      this.running.delete(sessionId);
      this.dropPendingForSession(sessionId);
      this.rejectOutboundControls(sessionId, err ?? new ProviderError("not_found", "claude process closed", 404));
      this.sessionControls.delete(sessionId);
      this.resolveExitWaiters(sessionId);
    };

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

        if (ev?.type === "control_response") {
          this.handleOutboundControlResponse(sessionId, ev);
          return;
        }

        if (ev?.type === "control_cancel_request") {
          const cancelledId = typeof ev.request_id === "string" ? ev.request_id : "";
          if (cancelledId) {
            const pending = this.pendingControls.get(cancelledId);
            if (pending && pending.sessionId === sessionId) {
              this.pendingControls.delete(cancelledId);
              onEvent({ type: "control_cancelled", requestId: cancelledId, kind: pending.kind });
            }
          }
          return;
        }

        if (ev?.type === "control_request") {
          const requestId = String(ev.request_id ?? ev.request?.request_id ?? "");
          if (!requestId) return;
          if (this.pendingControls.has(requestId)) return; // ignore duplicate delivery
          const req =
            ev.request && typeof ev.request === "object" ? (ev.request as Record<string, unknown>) : {};
          const kind = controlKind(req);
          if (kind === null) {
            const subtype = typeof req.subtype === "string" && req.subtype ? req.subtype : "unknown";
            void this.writeControlResponse(sessionId, {
              type: "control_response",
              response: {
                subtype: "error",
                request_id: requestId,
                error: `Unsupported control request subtype: ${subtype}`,
                error_code: "unsupported_request",
              },
            }).catch(() => undefined);
            return;
          }
          this.parkControlRequest(sessionId, ev, kind);
        }

        for (const mapped of mapStreamEvent(ev, mapperState)) {
          if (mapped.type === "done") {
            sawResult = true;
            // Turn naturally finished: close stdin so the CLI can exit.
            // Must not close earlier — steer/control needs the pipe during the turn.
            endStdin(child);
          }
          onEvent(mapped);
        }
      });

      child.on("error", (err) => {
        endStdin(child);
        cleanupTurnState(err);
        onEvent({ type: "error", message: `spawn failed: ${err.message}` });
        reject(err);
      });

      child.on("close", (code, signal) => {
        endStdin(child);
        cleanupTurnState();
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

    const userLine = JSON.stringify({
      type: "user",
      message: { role: "user", content: opts.contentBlocks ?? [{ type: "text", text: prompt }] },
    });
    child.stdin!.on("error", () => undefined);
    child.stdin!.write(userLine + "\n");

    return done;
  }

  /**
   * Resume `sessionId` with `--fork-session` and capture the NEW session id
   * from the CLI's system/init (or result) event. Does not write a user
   * prompt — that would land in the forked transcript. Throws ProviderError
   * unsupported if the CLI never yields a different id.
   */
  async forkSession(sessionId: string, cwd?: string): Promise<{ sessionId: string }> {
    if (this.running.has(sessionId)) {
      await this.waitForExit(sessionId, 8_000);
    }
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--resume", sessionId,
      "--fork-session",
      ...this.settingsArgs(),
    ];
    if (this.closed) {
      throw new ProviderError("not_found", "claude adapter closed", 404);
    }
    const child = spawn(this.claudeBin, args, {
      cwd: cwd ?? os.homedir(),
      env: this.childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.activeProbes.add(child);
    let probeTimer: NodeJS.Timeout | null = null;
    const cleanupProbe = (): void => {
      if (probeTimer) {
        clearTimeout(probeTimer);
        probeTimer = null;
      }
      this.activeProbes.delete(child);
    };
    child.once("close", cleanupProbe);
    child.once("error", cleanupProbe);

    child.stdin?.on("error", () => undefined);
    child.stderr?.resume();

    let newSessionId: string | undefined;
    const takeId = (id: string | undefined): void => {
      if (id && id !== sessionId) newSessionId = id;
    };

    const killWithEscalation = (): void => {
      endStdin(child);
      if (child.exitCode === null && child.signalCode === null) {
        this.killGroup(child, "SIGTERM");
        if (!probeTimer) {
          probeTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              this.killGroup(child, "SIGKILL");
            }
          }, 1_000);
          probeTimer.unref?.();
        }
      }
    };

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const rl = readline.createInterface({ input: child.stdout! });
        const finish = (err?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          rl.close();
          if (err) reject(err);
          else resolve();
        };
        const timer = setTimeout(() => {
          killWithEscalation();
          finish(new Error(`claude-adapter: --fork-session timed out waiting for system/init for ${sessionId}`));
        }, 20_000);
        timer.unref();
        rl.on("line", (line) => {
          if (!line.trim()) return;
          let ev: any;
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          for (const mapped of mapStreamEvent(ev)) {
            if (mapped.type === "init") takeId(mapped.sessionId);
            if (mapped.type === "done") takeId(mapped.sessionId);
          }
          if (newSessionId) {
            killWithEscalation();
            finish();
          }
        });
        child.on("error", (err) => finish(err));
        child.on("close", () => {
          if (newSessionId) finish();
          else finish(new Error(`claude-adapter: CLI did not yield a new session id on --fork-session for ${sessionId}`));
        });
      });
    } catch (err) {
      if (!newSessionId) {
        throw err instanceof ProviderError
          ? err
          : new ProviderError(
            "unsupported",
            err instanceof Error ? err.message : String(err),
            400,
          );
      }
    }

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

  // -- interrupt & bidirectional control requests ---------------------------

  /**
   * Interrupt the running turn of a session: first sends an `interrupt`
   * `control_request` over open stdin; if unacknowledged within 400ms (or if
   * the process does not exit within 1s after ack), falls back to SIGINT and
   * escalates to SIGKILL after 5s. Returns false if no turn is running.
   */
  interrupt(sessionId: string): boolean {
    const child = this.running.get(sessionId);
    if (!child) return false;
    this.interruptRequested.add(sessionId);
    if (this.interruptingChildren.has(child)) return true;
    this.interruptingChildren.add(child);

    let escalated = false;
    const escalateToSignals = (): void => {
      if (escalated) return;
      escalated = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      endStdin(child);
      try {
        this.killGroup(child, "SIGINT");
      } catch {
        // ignore if already dead
      }
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          this.killGroup(child, "SIGKILL");
        }
      }, 5_000);
      killTimer.unref?.();
      this.trackInterruptTimer(sessionId, killTimer);
    };

    const stdin = child.stdin;
    if (stdin && !stdin.destroyed && !stdin.writableEnded && stdin.writable) {
      this.sendControlRequest(sessionId, { subtype: "interrupt", cancel_queued: true }, 400)
        .then(() => {
          endStdin(child);
          const exitGrace = setTimeout(() => escalateToSignals(), 1_000);
          exitGrace.unref?.();
          this.trackInterruptTimer(sessionId, exitGrace);
        })
        .catch(() => {
          escalateToSignals();
        });
    } else {
      escalateToSignals();
    }

    return true;
  }

  /** Switch model mid-session via `set_model` control_request. */
  async setModel(sessionId: string, model: string | null): Promise<Record<string, unknown>> {
    return this.sendControlRequest(sessionId, { subtype: "set_model", model });
  }

  /** Switch permission mode mid-session via `set_permission_mode` (mapping `manual` -> `default`). */
  async setPermissionMode(sessionId: string, mode: string): Promise<Record<string, unknown>> {
    const mapped = mapControlPermissionMode(mode);
    return this.sendControlRequest(sessionId, { subtype: "set_permission_mode", mode: mapped });
  }

  /** Update thinking budget/display mid-session via `set_max_thinking_tokens`. */
  async setMaxThinkingTokens(
    sessionId: string,
    maxThinkingTokens?: number | null,
    thinkingDisplay?: "summarized" | "omitted" | "highlights" | null,
  ): Promise<Record<string, unknown>> {
    return this.sendControlRequest(sessionId, {
      subtype: "set_max_thinking_tokens",
      ...(maxThinkingTokens !== undefined ? { max_thinking_tokens: maxThinkingTokens } : {}),
      ...(thinkingDisplay !== undefined ? { thinking_display: thinkingDisplay } : {}),
    });
  }

  /** Merge flag-tier settings overlay mid-session via `apply_flag_settings` (e.g. `effortLevel`). */
  async applyFlagSettings(sessionId: string, settings: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.sendControlRequest(sessionId, { subtype: "apply_flag_settings", settings });
  }

  /** Convenience helper for setting `effortLevel` via `apply_flag_settings`. */
  async setEffortLevel(sessionId: string, effortLevel: string): Promise<Record<string, unknown>> {
    return this.applyFlagSettings(sessionId, { effortLevel });
  }

  /**
   * Query MCP server connection statuses via `mcp_status` control_request.
   * Uses the live turn's control channel when running, or spawns a short-lived
   * control probe when idle.
   */
  async mcpStatus(sessionId?: string, cwd?: string): Promise<Array<Record<string, unknown>>> {
    if (sessionId && this.running.has(sessionId)) {
      const resp = await this.sendControlRequest(sessionId, { subtype: "mcp_status" });
      return Array.isArray(resp.mcpServers) ? (resp.mcpServers as Array<Record<string, unknown>>) : [];
    }
    const resp = await this.spawnControlProbe({ subtype: "mcp_status" }, cwd);
    return Array.isArray(resp?.mcpServers) ? (resp.mcpServers as Array<Record<string, unknown>>) : [];
  }

  /** 整组收割(detached spawn 的组 id = 主 pid);组不在时兜底单发。 */
  private killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already exited
      }
    }
  }

  private sendControlRequest(
    sessionId: string,
    request: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    const child = this.running.get(sessionId);
    const stdin = child?.stdin;
    const state = this.sessionControls.get(sessionId);
    if (!child || !state || !stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) {
      return Promise.reject(
        new ProviderError("not_found", `claude-adapter: no running turn for session ${sessionId}`, 404),
      );
    }

    const requestId = `ctrl_${randomUUID()}`;
    const unmatched = state.unmatchedResponses.get(requestId);
    if (unmatched) {
      state.unmatchedResponses.delete(requestId);
      return Promise.resolve(unmatched);
    }

    const payload = JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request,
    }) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pendingOutbound.delete(requestId);
        reject(new ProviderError("upstream_error", `claude-adapter: control_request timed out: ${String(request.subtype ?? "")}`, 504));
      }, timeoutMs);
      timer.unref?.();

      state.pendingOutbound.set(requestId, { resolve, reject, timer });

      stdin.write(payload, (err) => {
        if (err) {
          const entry = state.pendingOutbound.get(requestId);
          if (entry) {
            clearTimeout(entry.timer);
            state.pendingOutbound.delete(requestId);
          }
          reject(
            new ProviderError(
              "not_found",
              `claude-adapter: control_request write failed: ${err.message}`,
              404,
              err,
            ),
          );
        }
      });
    });
  }

  private handleOutboundControlResponse(sessionId: string, ev: any): void {
    const state = this.sessionControls.get(sessionId);
    const resp = ev?.response;
    if (!state || !resp || typeof resp !== "object") return;
    const requestId = typeof resp.request_id === "string" ? resp.request_id : "";
    if (!requestId) return;

    const pending = state.pendingOutbound.get(requestId);
    const body =
      resp.response && typeof resp.response === "object" && !Array.isArray(resp.response)
        ? (resp.response as Record<string, unknown>)
        : {};

    if (!pending) {
      if (state.unmatchedResponses.size >= MAX_UNMATCHED_CONTROL_RESPONSES) {
        const oldest = state.unmatchedResponses.keys().next().value;
        if (oldest !== undefined) state.unmatchedResponses.delete(oldest);
      }
      state.unmatchedResponses.set(requestId, body);
      return;
    }

    clearTimeout(pending.timer);
    state.pendingOutbound.delete(requestId);
    if (resp.subtype === "success") {
      pending.resolve(body);
    } else {
      const errMsg = typeof resp.error === "string" && resp.error ? resp.error : "control_request rejected";
      pending.reject(new ProviderError("invalid_request", errMsg, 400));
    }
  }

  private rejectOutboundControls(sessionId: string, err: Error): void {
    const state = this.sessionControls.get(sessionId);
    if (!state) return;
    for (const pending of state.pendingOutbound.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    state.pendingOutbound.clear();
    state.unmatchedResponses.clear();
  }

  // -- approvals / questions (control_request on a live stdin) --------------

  /**
   * Answer a parked `can_use_tool` control_request.
   * - `allow` / `approve`: `{ behavior: "allow", updatedInput, toolUseID, decisionClassification: "user_temporary" }`
   * - `approve_always`: includes `updatedPermissions` (from `options.updatedPermissions` or `permission_suggestions`)
   *   when `suppress_always_allow_rule` and `requires_user_interaction` are not set; otherwise single-allow only.
   * - `deny` / `reject`: `{ behavior: "deny", message, interrupt?, toolUseID, decisionClassification: "user_reject" }`.
   */
  async resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: ClaudeApprovalDecision,
    options?: ResolveClaudeApprovalOptions,
  ): Promise<void> {
    const pending = this.pendingControls.get(approvalId);
    if (!pending || pending.kind !== "approval" || pending.sessionId !== sessionId) {
      throw new ProviderError(
        "not_found",
        `claude-adapter: no pending approval ${approvalId} for session ${sessionId}`,
        404,
      );
    }

    const req = pending.request;
    const isDeny = decision === "deny" || decision === "reject";
    const isAlways = decision === "approve_always";
    const rawToolUseId = req.tool_use_id ?? req.toolUseID;
    const toolUseId = typeof rawToolUseId === "string" && rawToolUseId ? rawToolUseId : undefined;

    let response: Record<string, unknown>;
    if (isDeny) {
      const denyMessage =
        typeof options?.message === "string" && options.message.trim()
          ? options.message.trim()
          : "User denied tool use";
      response = {
        behavior: "deny",
        message: denyMessage,
        ...(options?.interrupt === true ? { interrupt: true } : {}),
        ...(toolUseId ? { toolUseID: toolUseId } : {}),
        decisionClassification: "user_reject",
      };
    } else {
      const updatedInput = options?.updatedInput ?? req.input;
      const alwaysAllowed =
        req.suppress_always_allow_rule !== true && req.requires_user_interaction !== true;
      const explicitPermissions =
        Array.isArray(options?.updatedPermissions) && options.updatedPermissions.length > 0
          ? options.updatedPermissions
          : undefined;
      const suggestedPermissions =
        Array.isArray(req.permission_suggestions) && req.permission_suggestions.length > 0
          ? req.permission_suggestions
          : undefined;
      const updatedPermissions =
        alwaysAllowed && (isAlways || explicitPermissions !== undefined)
          ? (explicitPermissions ?? (isAlways ? suggestedPermissions : undefined))
          : undefined;

      response = {
        behavior: "allow",
        ...(updatedInput !== undefined ? { updatedInput } : {}),
        ...(updatedPermissions !== undefined ? { updatedPermissions } : {}),
        ...(toolUseId ? { toolUseID: toolUseId } : {}),
        decisionClassification: updatedPermissions !== undefined ? "user_permanent" : "user_temporary",
      };
    }

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
   * Answer a parked `AskUserQuestion` / questions control_request.
   * Translates `q_N` keys to `Record<question.question, string>` (comma-joined
   * for multi-select), validates index bounds, and preserves original `input`.
   */
  async resolveQuestion(
    sessionId: string,
    questionId: string,
    answer: ClaudeQuestionAnswerInput,
  ): Promise<void> {
    const pending = this.pendingControls.get(questionId);
    if (!pending || pending.kind !== "question" || pending.sessionId !== sessionId) {
      throw new ProviderError(
        "not_found",
        `claude-adapter: no pending question ${questionId} for session ${sessionId}`,
        404,
      );
    }

    const req = pending.request;
    const questions = extractQuestions(req);
    const encodedAnswers = encodeAskUserQuestionAnswers(questions, answer);
    const rawInput =
      req.input && typeof req.input === "object" && !Array.isArray(req.input)
        ? (req.input as Record<string, unknown>)
        : {};
    const rawToolUseId = req.tool_use_id ?? req.toolUseID;
    const toolUseId = typeof rawToolUseId === "string" && rawToolUseId ? rawToolUseId : undefined;

    const isEmptyAnswers =
      !answer ||
      (typeof answer === "string" && !answer.trim()) ||
      (typeof answer === "object" && Object.keys(encodedAnswers).length === 0);

    const response: Record<string, unknown> =
      req.subtype === "can_use_tool"
        ? isEmptyAnswers
          ? {
              behavior: "deny",
              message: "User dismissed question",
              ...(toolUseId ? { toolUseID: toolUseId } : {}),
            }
          : {
              behavior: "allow",
              updatedInput: {
                ...rawInput,
                answers: encodedAnswers,
              },
              ...(toolUseId ? { toolUseID: toolUseId } : {}),
            }
        : { answers: encodedAnswers };

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

  private parkControlRequest(sessionId: string, ev: any, kind: "approval" | "question"): void {
    const requestId = String(ev.request_id ?? ev.request?.request_id ?? "");
    if (!requestId) return;
    const req =
      ev.request && typeof ev.request === "object" ? (ev.request as Record<string, unknown>) : {};
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

  // -- 原生斜杠命令目录(initialize 握手 + 零子进程磁盘兜底) ----------------------

  private static readonly COMMANDS_TTL_MS = 5 * 60_000;
  /** initialize 握手整包缓存(按 cwd):commands/models 同一次 spawn 都能取到。 */
  private handshakeCache = new Map<string, { ts: number; response: any }>();
  private handshakeInflight = new Map<string, Promise<any | null>>();
  private handshakeEpoch = 0;

  /** Clear cached initialize handshake responses and any in-flight promises. */
  clearHandshakeCache(): void {
    this.handshakeEpoch += 1;
    this.handshakeCache.clear();
    this.handshakeInflight.clear();
  }

  /** Zero-spawn disk discovery for `.claude/commands` and `.claude/skills` / `.agents/skills`. */
  async discoverDiskCommands(cwd?: string): Promise<ClaudeSlashCommand[]> {
    const disk = await discoverClaudeDiskCommands(cwd, this.configDir, { homeDir: this.homeDir });
    return disk.map((c) => ({
      name: c.name,
      description: c.description || c.name,
      argumentHint: c.argumentHint ?? "",
      aliases: Array.isArray(c.aliases) ? c.aliases : [],
      ...(c.builtin !== undefined ? { builtin: c.builtin } : {}),
      ...(c.source ? { source: c.source } : {}),
      ...(c.path ? { path: c.path } : {}),
      ...(c.scope ? { scope: c.scope } : {}),
    }));
  }

  async listSlashCommands(
    cwd?: string,
    options: ListSlashCommandsOptions = {},
  ): Promise<ClaudeSlashCommand[]> {
    if (options.diskOnly) {
      return this.discoverDiskCommands(cwd);
    }
    const response = await this.getHandshakeResponse(cwd);
    const list = response?.commands;
    if (!Array.isArray(list)) {
      if (options.diskFallback !== false) {
        const disk = await this.discoverDiskCommands(cwd);
        if (disk.length > 0) return disk;
      }
      throw new Error("claude-adapter: initialize handshake returned no commands (CLI missing, broken, or too old)");
    }
    return list
      .filter((c: any) => c && typeof c.name === "string")
      .map((c: any) => ({
        name: c.name as string,
        description: typeof c.description === "string" ? c.description : (c.name as string),
        argumentHint: typeof c.argumentHint === "string" ? c.argumentHint : "",
        aliases: Array.isArray(c.aliases) ? c.aliases.filter((a: any) => typeof a === "string") : [],
        ...(typeof c.builtin === "boolean" ? { builtin: c.builtin } : {}),
        ...(typeof c.source === "string" ? { source: c.source } : {}),
        ...(typeof c.path === "string" ? { path: c.path } : {}),
        ...(typeof c.scope === "string" ? { scope: c.scope } : {}),
        ...(typeof c.terminalOnly === "boolean" ? { terminalOnly: c.terminalOnly } : {}),
        ...(Array.isArray(c.allowedTools)
          ? { allowedTools: c.allowedTools.filter((t: any) => typeof t === "string") }
          : {}),
        ...(typeof c.model === "string" ? { model: c.model } : {}),
      }));
  }

  // -- 内置模型目录(initialize 握手) ------------------------------------------

  async listBuiltinModels(): Promise<ClaudeBuiltinModel[]> {
    const response = await this.getHandshakeResponse(undefined);
    const list = response?.models;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("claude-adapter: initialize handshake returned no models (CLI missing, broken, or too old)");
    }
    const fastModeState = typeof response.fast_mode_state === "string" ? response.fast_mode_state : undefined;
    const fastModeDisabledReason =
      typeof response.fast_mode_disabled_reason === "string" ? response.fast_mode_disabled_reason : undefined;

    return list
      .filter((m: any) => m && typeof m.value === "string" && !/qwen/i.test(m.value))
      .map((m: any) => {
        const supportsFastMode = typeof m.supportsFastMode === "boolean" ? m.supportsFastMode : undefined;
        let fastMode =
          typeof m.fastMode === "boolean"
            ? m.fastMode
            : supportsFastMode;
        if (fastModeState === "off" || fastModeDisabledReason === "sdk_opt_in_required") {
          fastMode = false;
        }
        return {
          value: m.value as string,
          resolvedModel: typeof m.resolvedModel === "string" ? m.resolvedModel : undefined,
          displayName: typeof m.displayName === "string" ? m.displayName : undefined,
          description: typeof m.description === "string" ? m.description : undefined,
          supportsEffort: m.supportsEffort === true,
          supportedEffortLevels: Array.isArray(m.supportedEffortLevels)
            ? m.supportedEffortLevels.filter((e: any) => typeof e === "string")
            : undefined,
          ...(typeof m.supportsAdaptiveThinking === "boolean"
            ? { supportsAdaptiveThinking: m.supportsAdaptiveThinking }
            : {}),
          ...(typeof m.supportsThinkingOff === "boolean"
            ? { supportsThinkingOff: m.supportsThinkingOff }
            : {}),
          ...(supportsFastMode !== undefined ? { supportsFastMode } : {}),
          ...(fastMode !== undefined ? { fastMode } : {}),
          ...(typeof m.supportsAutoMode === "boolean"
            ? { supportsAutoMode: m.supportsAutoMode }
            : {}),
          ...(fastModeState !== undefined ? { fastModeState } : {}),
          ...(fastModeDisabledReason !== undefined ? { fastModeDisabledReason } : {}),
        };
      });
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
    const epoch = this.handshakeEpoch;
    const pending = this.spawnHandshake(cwd).then((response) => {
      if (this.handshakeEpoch === epoch && this.handshakeInflight.get(key) === pending) {
        this.handshakeInflight.delete(key);
        if (response) this.handshakeCache.set(key, { ts: Date.now(), response });
      }
      return response;
    });
    this.handshakeInflight.set(key, pending);
    return pending;
  }

  /** initialize 控制握手:起一个短命进程(不跑模型),回整包 response (按 request_id 精确关联)。 */
  private spawnHandshake(cwd: string | undefined): Promise<any | null> {
    return this.spawnControlProbe({ subtype: "initialize" }, cwd);
  }

  private spawnControlProbe(
    request: Record<string, unknown>,
    cwd?: string,
  ): Promise<Record<string, unknown> | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const requestId = request.subtype === "initialize" ? "gw_init" : `probe_${randomUUID()}`;
      const child = spawn(
        this.claudeBin,
        ["-p", "--no-session-persistence", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...this.settingsArgs()],
        { cwd: cwd ?? os.homedir(), env: this.childEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true },
      );
      this.activeProbes.add(child);
      let probeTimer: NodeJS.Timeout | null = null;
      const cleanupProbe = (): void => {
        if (probeTimer) {
          clearTimeout(probeTimer);
          probeTimer = null;
        }
        this.activeProbes.delete(child);
      };
      child.once("close", cleanupProbe);
      child.once("error", cleanupProbe);

      let settled = false;
      const rl = readline.createInterface({ input: child.stdout! });
      const finish = (value: Record<string, unknown> | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rl.close();
        endStdin(child);
        if (child.exitCode === null && child.signalCode === null) {
          this.killGroup(child, "SIGTERM");
          if (!probeTimer) {
            probeTimer = setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) {
                this.killGroup(child, "SIGKILL");
              }
            }, 1_000);
            probeTimer.unref?.();
          }
        }
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 20_000);
      timer.unref();
      child.on("error", () => finish(null));
      child.on("exit", () => finish(null));
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
        const respId = typeof resp?.request_id === "string" ? resp.request_id : "";
        if (respId !== requestId) return;
        if (resp.subtype !== "success") {
          finish(null);
          return;
        }
        const body =
          resp.response && typeof resp.response === "object" && !Array.isArray(resp.response)
            ? (resp.response as Record<string, unknown>)
            : {};
        finish(body);
      });
      child.stdin!.on("error", () => undefined);
      child.stderr?.resume();
      child.stdin!.write(
        JSON.stringify({ type: "control_request", request_id: requestId, request }) + "\n",
      );
    });
  }

  // -- close ----------------------------------------------------------------

  /** Kill all running turn processes. */
  async close(): Promise<void> {
    this.closed = true;
    this.clearHandshakeCache();
    this.historyCache.clear();
    this.summarizeCache.clear();

    const targets: ChildProcess[] = [];

    for (const [sessionId, child] of this.running) {
      this.clearInterruptTimers(sessionId);
      endStdin(child);
      this.dropPendingForSession(sessionId);
      this.rejectOutboundControls(sessionId, new ProviderError("not_found", "claude adapter closed", 404));
      this.sessionControls.delete(sessionId);
      this.resolveExitWaiters(sessionId);
      targets.push(child);
    }
    for (const probe of this.activeProbes) {
      endStdin(probe);
      targets.push(probe);
    }

    // Send SIGTERM to all running children and active probes
    for (const child of targets) {
      if (child.exitCode === null && child.signalCode === null) {
        this.killGroup(child, "SIGTERM");
      }
    }

    // Wait briefly (up to 2.5s) for processes to exit after SIGTERM
    const aliveTargets = targets.filter((c) => c.exitCode === null && c.signalCode === null);
    if (aliveTargets.length > 0) {
      const waitPromises = aliveTargets.map((proc) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const onDone = () => {
            proc.removeListener("close", onDone);
            proc.removeListener("exit", onDone);
            resolve();
          };
          proc.once("close", onDone);
          proc.once("exit", onDone);
        });
      });
      await Promise.race([
        Promise.all(waitPromises),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 2_500);
          t.unref?.();
        }),
      ]);
    }

    // Escalate any still-alive child/group with SIGKILL
    for (const child of targets) {
      if (child.exitCode === null && child.signalCode === null) {
        this.killGroup(child, "SIGKILL");
      }
    }

    this.running.clear();
    this.activeProbes.clear();
  }

  // -- internals --------------------------------------------------------------

  private async realProjectsRoot(): Promise<string> {
    try {
      return await fsp.realpath(this.projectsDir);
    } catch {
      return path.resolve(this.projectsDir);
    }
  }

  private anchorTargetToRoot(targetPath: string, realRoot: string): string {
    const resolvedRoot = path.resolve(realRoot);
    const resolvedTarget = path.resolve(targetPath);
    if (isWithinDir(resolvedRoot, resolvedTarget)) {
      return resolvedTarget;
    }
    const resolvedProjects = path.resolve(this.projectsDir);
    if (isWithinDir(resolvedProjects, resolvedTarget)) {
      return path.join(resolvedRoot, path.relative(resolvedProjects, resolvedTarget));
    }
    throw new ProviderError("invalid_request", "claude-adapter: path escapes projectsDir", 400);
  }

  private async isSafeDirectoryWithinRoot(dirPath: string, realRoot: string): Promise<boolean> {
    try {
      const lst = await fsp.lstat(dirPath);
      if (lst.isSymbolicLink() || !lst.isDirectory()) return false;
      const realDir = await fsp.realpath(dirPath);
      return isWithinDir(realRoot, realDir);
    } catch {
      return false;
    }
  }

  private async openTranscriptBound(
    filePath: string,
    realRoot: string,
    openOptions?: OpenBoundOptions,
  ): Promise<{ fh: fsp.FileHandle; stat: fs.Stats }> {
    const anchoredTarget = this.anchorTargetToRoot(filePath, realRoot);
    const opened = await openBound(anchoredTarget, realRoot, openOptions);
    if (path.resolve(opened.realPath) !== anchoredTarget) {
      await opened.fh.close().catch(() => undefined);
      throw new ProviderError("invalid_request", "claude-adapter: refusing symlinked transcript or ancestor", 400);
    }
    return { fh: opened.fh, stat: opened.stat };
  }

  private async readBoundedSidecarText(
    sidecarPath: string,
    realRoot: string,
    maxBytes: number,
  ): Promise<string | null> {
    try {
      const anchoredTarget = this.anchorTargetToRoot(sidecarPath, realRoot);
      const opened = await openBound(anchoredTarget, realRoot);
      if (path.resolve(opened.realPath) !== anchoredTarget) {
        await opened.fh.close().catch(() => undefined);
        return null;
      }
      const { fh, stat } = opened;
      try {
        if (stat.size <= 0 || stat.size > maxBytes) return null;
        const buf = Buffer.allocUnsafe(stat.size);
        let offset = 0;
        while (offset < stat.size) {
          const { bytesRead } = await fh.read(buf, offset, stat.size - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        return buf.toString("utf8", 0, offset);
      } finally {
        await fh.close().catch(() => undefined);
      }
    } catch {
      return null;
    }
  }

  private invalidateHistoryCacheForSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.historyCache.keys()) {
      if (key === sessionId || key.startsWith(prefix)) {
        this.historyCache.delete(key);
      }
    }
  }

  private findSessionFileInProjectDir(projectDir: string, sessionId: string, realRoot?: string): string | null {
    if (!UUID_RE.test(sessionId)) return null;
    try {
      const dirLst = fs.lstatSync(projectDir);
      if (dirLst.isSymbolicLink() || !dirLst.isDirectory()) return null;
      const realDir = fs.realpathSync(projectDir);
      const root = realRoot ?? fs.realpathSync(this.projectsDir);
      if (!isWithinDir(root, realDir)) return null;
      const candidate = path.join(realDir, `${sessionId}.jsonl`);
      const fileLst = fs.lstatSync(candidate);
      if (fileLst.isSymbolicLink() || !fileLst.isFile()) return null;
      return candidate;
    } catch {
      return null;
    }
  }

  private findSessionFile(sessionId: string): string | null {
    if (!UUID_RE.test(sessionId)) {
      return null;
    }
    let projectDirs: fs.Dirent[];
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(this.projectsDir);
      projectDirs = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const dirEnt of projectDirs) {
      if (dirEnt.isSymbolicLink() || !dirEnt.isDirectory()) continue;
      const candidate = this.findSessionFileInProjectDir(
        path.join(this.projectsDir, dirEnt.name),
        sessionId,
        realRoot,
      );
      if (candidate) return candidate;
    }
    return null;
  }

  /** 该会话的 transcript 文件是否已落盘——facade 据此决定 --session-id 还是 --resume。 */
  hasSessionFile(sessionId: string): boolean {
    return this.findSessionFile(sessionId) !== null;
  }

  private summarizeCache = new LruCache<string, { mtimeMs: number; size: number; summary: ClaudeSessionSummary }>(64);

  /**
   * Extract session summary with O_RDONLY|O_NONBLOCK|O_NOFOLLOW `openBound`,
   * reading head+tail 256 KiB windows, custom-title JSONL + sidecar,
   * native archived.json (unarchived by newer human prompts), and continued-in chain.
   */
  private async summarizeSessionFile(
    sessionId: string,
    projectDir: string,
    filePath: string,
    realRoot: string,
  ): Promise<ClaudeSessionSummary | null> {
    const { fh, stat } = await this.openTranscriptBound(filePath, realRoot);
    try {
      const hit = this.summarizeCache.get(filePath);
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
        return hit.summary;
      }

      let headCustomTitle = "";
      let tailCustomTitle = "";
      let headTitle = "";
      let tailTitle = "";
      let headUser = "";
      let tailUser = "";
      let firstPrompt = "";
      let headCmd = "";
      let tailCmd = "";
      let cwd = "";
      let gitBranch = "";
      let createdAt: string | undefined;
      let latestUserPromptMs = Number.NEGATIVE_INFINITY;
      let isSidechainHead = false;
      let hasRealUser = false;
      let hasAssistant = false;
      let sessionEntrypoint: string | undefined;
      const updatedAt = stat.mtime.toISOString();

      const aiTitleOf = (entry: any): string => {
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
        isHead: boolean,
        setCustomTitle: (t: string) => void,
        setTitle: (t: string) => void,
        setUser: (t: string) => void,
        setCmd: (t: string) => void,
      ): void => {
        let lineIdx = 0;
        for (const line of text.split("\n")) {
          if (!line) continue;
          const idx = lineIdx++;
          let entry: any;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          if (isHead && idx === 0 && entry.isSidechain === true) {
            isSidechainHead = true;
            return;
          }
          const ep =
            typeof entry.entrypoint === "string"
              ? entry.entrypoint
              : typeof entry.metadata?.entrypoint === "string"
                ? entry.metadata.entrypoint
                : undefined;
          if (ep && !sessionEntrypoint) {
            sessionEntrypoint = ep;
          }
          if (!createdAt && typeof entry.timestamp === "string" && !Number.isNaN(Date.parse(entry.timestamp))) {
            createdAt = entry.timestamp;
          }
          if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
          if (typeof entry.relocatedCwd === "string" && entry.type === "relocated") cwd = entry.relocatedCwd;
          if (typeof entry.gitBranch === "string" && entry.gitBranch) gitBranch = entry.gitBranch;
          if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
            const sanitized = sanitizeTitle(entry.customTitle);
            if (sanitized) setCustomTitle(sanitized);
          }
          const t = aiTitleOf(entry);
          if (t) setTitle(t);
          if (
            entry.type === "user" &&
            !entry.isSidechain &&
            entry.isMeta !== true &&
            entry.isCompactSummary !== true &&
            entry.isVisibleInTranscriptOnly !== true
          ) {
            const c = userTextCandidate(entry.message?.content);
            if (c?.kind === "text") {
              hasRealUser = true;
              if (!firstPrompt) firstPrompt = c.text;
              setUser(c.text);
              const tsMs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
              if (!Number.isNaN(tsMs) && tsMs > latestUserPromptMs) {
                latestUserPromptMs = tsMs;
              }
            } else if (c?.kind === "cmd") {
              setCmd(c.text);
            }
          }
          if (
            entry.type === "assistant" &&
            !entry.isSidechain &&
            entry.isApiErrorMessage !== true
          ) {
            hasAssistant = true;
          }
          if (
            entry.type === "attachment" &&
            !entry.isSidechain &&
            entry.attachment?.type === "queued_command" &&
            entry.attachment?.isMeta !== true
          ) {
            const c = userTextCandidate(entry.attachment?.prompt);
            if (c?.kind === "text") {
              hasRealUser = true;
              const tsMs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
              if (!Number.isNaN(tsMs) && tsMs > latestUserPromptMs) {
                latestUserPromptMs = tsMs;
              }
            }
          }
        }
      };

      const headLen = Math.min(HEAD_BYTES, stat.size);
      const headSlice = headLen > 0 ? await readRange(fh, 0, headLen) : Buffer.alloc(0);
      let head = "";
      if (headSlice.length > 0) {
        let trimmedHead = headSlice;
        if (headSlice.length < stat.size) {
          const headNl = headSlice.lastIndexOf(0x0a);
          if (headNl > 0) trimmedHead = headSlice.subarray(0, headNl);
        }
        head = trimmedHead.toString("utf8");
      }
      scan(
        head,
        true,
        (t) => { headCustomTitle = t; },
        (t) => { headTitle = t; },
        (u) => { headUser = u; },
        (c) => { headCmd = c; },
      );
      if (isSidechainHead) return null;

      let tail = head;
      if (headSlice.length < stat.size) {
        const tailStart = Math.max(0, stat.size - HEAD_BYTES);
        const tailLen = stat.size - tailStart;
        let tailSlice = await readRange(fh, tailStart, tailLen);
        if (tailStart > 0) {
          const firstNl = tailSlice.indexOf(0x0a);
          tailSlice = firstNl >= 0 ? tailSlice.subarray(firstNl + 1) : Buffer.alloc(0);
        }
        tail = tailSlice.toString("utf8");
        scan(
          tail,
          false,
          (t) => { tailCustomTitle = t; },
          (t) => { tailTitle = t; },
          (u) => { tailUser = u; },
          (c) => { tailCmd = c; },
        );
      }

      // 过滤纯斜杠命令且无回复的垃圾会话。
      // 文件大小在 2 * HEAD_BYTES (512 KiB) 以内时，head + tail 完全覆盖全文；
      // 若文件超出 512 KiB，中间段未读，但真实纯命令会话无模型回复极小(实测约 1.5~5 KiB)，
      // 超过 512 KiB 必为多轮对话真实会话，避免误过滤。
      const hasConversation = hasRealUser || hasAssistant || stat.size > 2 * HEAD_BYTES;
      if (!hasConversation) return null;

      const sessionArtifactsDir = path.join(path.dirname(filePath), sessionId);
      let sidecarCustomTitle = "";
      if (!tailCustomTitle) {
        const rawCt = await this.readBoundedSidecarText(
          path.join(sessionArtifactsDir, "custom-title.json"),
          realRoot,
          MAX_SIDECAR_BYTES,
        );
        if (rawCt) {
          try {
            const parsed = JSON.parse(rawCt) as Record<string, unknown>;
            if (typeof parsed.customTitle === "string") {
              sidecarCustomTitle = sanitizeTitle(parsed.customTitle);
            }
          } catch {
            // ignore invalid sidecar
          }
        }
      }

      let archived: boolean | undefined;
      const rawArch = await this.readBoundedSidecarText(
        path.join(sessionArtifactsDir, "archived.json"),
        realRoot,
        MAX_SIDECAR_BYTES,
      );
      if (rawArch) {
        try {
          const parsed = JSON.parse(rawArch) as Record<string, unknown>;
          if (typeof parsed.archived === "boolean" && typeof parsed.at === "string") {
            const archAtMs = Date.parse(parsed.at);
            if (!Number.isNaN(archAtMs)) {
              if (!parsed.archived) {
                archived = false;
              } else {
                archived = !(latestUserPromptMs > archAtMs);
              }
            }
          }
        } catch {
          // ignore invalid sidecar
        }
      }

      const customTitle = tailCustomTitle || sidecarCustomTitle || headCustomTitle || undefined;
      const continuedInSessionId = extractTrailingContinuedIn(tail);
      const bestTitle =
        customTitle ||
        tailTitle ||
        headTitle ||
        tailUser ||
        headUser ||
        tailCmd ||
        headCmd ||
        "";

      const summary: ClaudeSessionSummary = {
        sessionId,
        title: bestTitle.slice(0, 120),
        ...(customTitle ? { customTitle } : {}),
        ...(firstPrompt ? { firstPrompt: firstPrompt.slice(0, 200) } : {}),
        ...(gitBranch ? { gitBranch } : {}),
        cwd,
        projectDir,
        updatedAt,
        ...(createdAt ? { createdAt } : {}),
        fileSize: stat.size,
        ...(sessionEntrypoint ? { entrypoint: sessionEntrypoint } : {}),
        ...(archived !== undefined ? { archived } : {}),
        ...(continuedInSessionId ? { continuedInSessionId } : {}),
      };
      this.summarizeCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
      return summary;
    } finally {
      await fh.close().catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure protocol & transcript helpers
// ---------------------------------------------------------------------------

function isWithinDir(baseDir: string, targetPath: string): boolean {
  const b = path.resolve(baseDir);
  const t = path.resolve(targetPath);
  if (t === b) return true;
  const prefix = b.endsWith(path.sep) ? b : b + path.sep;
  return t.startsWith(prefix);
}

interface AnchoredDirHandle {
  dirFd: fsp.FileHandle;
  fallbackDir: string;
}

function splitSafeRelSegments(rel: string): string[] {
  if (!rel || rel === "." || path.isAbsolute(rel)) return [];
  const parts = rel.split(path.sep).filter(Boolean);
  for (const seg of parts) {
    if (seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\") || seg.includes("\0")) {
      throw new ProviderError("invalid_request", `claude-adapter: invalid path segment: ${seg}`, 400);
    }
  }
  return parts;
}

function dirChildPath(handle: AnchoredDirHandle, childName: string): string {
  return HAS_PROC_SELF_FD
    ? `/proc/self/fd/${handle.dirFd.fd}/${childName}`
    : path.join(handle.fallbackDir, childName);
}

function mapDirOpenError(err: unknown, label: string): ProviderError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return new ProviderError("not_found", `claude-adapter: directory missing: ${label}`, 404, err);
  }
  if (code === "ELOOP") {
    return new ProviderError("invalid_request", `claude-adapter: refusing symlinked ${label}`, 400, err);
  }
  if (code === "ENOTDIR" || code === "ENXIO") {
    return new ProviderError("invalid_request", `claude-adapter: invalid directory (${code}): ${label}`, 400, err);
  }
  return new ProviderError("invalid_request", `claude-adapter: directory open failed: ${(err as Error).message}`, 400, err);
}

function mapAppendOpenError(err: unknown, target: string): ProviderError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new ProviderError("not_found", `claude-adapter: session file missing: ${target}`, 404, err);
  }
  if (code === "ELOOP" || code === "ENXIO" || code === "EISDIR") {
    return new ProviderError("invalid_request", `claude-adapter: refusing non-regular or symlinked file (${code}): ${target}`, 400, err);
  }
  return new ProviderError("invalid_request", `claude-adapter: open failed (${code ?? "ERR"}): ${(err as Error).message}`, 400, err);
}

async function openAnchoredDirChildOptional(
  parentHandle: AnchoredDirHandle,
  childName: string,
  label: string,
): Promise<AnchoredDirHandle | null> {
  if (!childName || childName === "." || childName === ".." || childName.includes("/") || childName.includes("\\") || childName.includes("\0")) {
    throw new ProviderError("invalid_request", `claude-adapter: invalid directory name: ${childName}`, 400);
  }
  const childTarget = dirChildPath(parentHandle, childName);
  const childFallback = path.join(parentHandle.fallbackDir, childName);

  if (!HAS_PROC_SELF_FD) {
    const lst = await fsp.lstat(childTarget).catch((err: unknown) => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") return null;
      throw mapDirOpenError(err, label);
    });
    if (!lst) return null;
    if (lst.isSymbolicLink()) {
      throw new ProviderError("invalid_request", `claude-adapter: refusing symlinked ${label}`, 400);
    }
    if (!lst.isDirectory()) {
      throw new ProviderError("invalid_request", `claude-adapter: ${label} is not a directory`, 400);
    }
  }

  let dirFd: fsp.FileHandle;
  try {
    dirFd = await fsp.open(childTarget, OPEN_DIR_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "ENOTDIR") {
      const lst = await fsp.lstat(childTarget).catch(() => null);
      if (lst?.isSymbolicLink()) {
        throw new ProviderError("invalid_request", `claude-adapter: refusing symlinked ${label}`, 400, err);
      }
    }
    throw mapDirOpenError(err, label);
  }

  try {
    const st = await dirFd.stat();
    if (!st.isDirectory()) {
      throw new ProviderError("invalid_request", `claude-adapter: ${label} is not a directory`, 400);
    }
    return { dirFd, fallbackDir: childFallback };
  } catch (err) {
    await dirFd.close().catch(() => undefined);
    throw err;
  }
}

async function openAnchoredDir(realRoot: string, segments: string[]): Promise<AnchoredDirHandle> {
  const actualRoot = await fsp.realpath(path.resolve(realRoot)).catch((err: unknown) => {
    throw mapDirOpenError(err, "projectsDir");
  });
  const rootLst = await fsp.lstat(actualRoot).catch((err: unknown) => {
    throw mapDirOpenError(err, "projectsDir");
  });
  if (rootLst.isSymbolicLink() || !rootLst.isDirectory()) {
    throw new ProviderError("invalid_request", "claude-adapter: invalid projects root", 400);
  }
  const rootFd = await fsp.open(actualRoot, OPEN_DIR_FLAGS).catch((err: unknown) => {
    throw mapDirOpenError(err, "projectsDir");
  });

  let current: AnchoredDirHandle = { dirFd: rootFd, fallbackDir: actualRoot };
  try {
    const rootSt = await rootFd.stat();
    if (
      !rootSt.isDirectory() ||
      rootSt.dev !== rootLst.dev ||
      (process.platform !== "win32" && rootSt.ino !== rootLst.ino)
    ) {
      throw new ProviderError("invalid_request", "claude-adapter: projects root changed during open", 400);
    }

    for (const seg of segments) {
      const next = await openAnchoredDirChildOptional(current, seg, `directory ${seg}`);
      if (!next) {
        throw new ProviderError("not_found", `claude-adapter: directory missing: ${seg}`, 404);
      }
      await current.dirFd.close().catch(() => undefined);
      current = next;
    }
    return current;
  } catch (err) {
    await current.dirFd.close().catch(() => undefined);
    throw err;
  }
}

async function ensureAnchoredDirChild(
  parentHandle: AnchoredDirHandle,
  childName: string,
): Promise<AnchoredDirHandle> {
  const existing = await openAnchoredDirChildOptional(parentHandle, childName, "session directory");
  if (existing) return existing;

  const target = dirChildPath(parentHandle, childName);
  try {
    await fsp.mkdir(target, { mode: 0o700 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EEXIST") throw err;
  }
  const created = await openAnchoredDirChildOptional(parentHandle, childName, "session directory");
  if (!created) {
    throw new ProviderError("not_found", `claude-adapter: failed to open session directory ${childName}`, 404);
  }
  return created;
}

async function purgeAnchoredDirContents(handle: AnchoredDirHandle): Promise<void> {
  const dirRef = HAS_PROC_SELF_FD ? `/proc/self/fd/${handle.dirFd.fd}` : handle.fallbackDir;
  let dirents: fs.Dirent[];
  try {
    dirents = await fsp.readdir(dirRef, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return;
    throw err;
  }

  for (const entry of dirents) {
    if (entry.name === "." || entry.name === "..") continue;
    const childTarget = dirChildPath(handle, entry.name);
    const lst = await fsp.lstat(childTarget).catch((err: unknown) => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") return null;
      throw err;
    });
    if (!lst) continue;
    if (lst.isDirectory()) {
      const childHandle = await openAnchoredDirChildOptional(handle, entry.name, "subagents directory");
      if (childHandle) {
        try {
          await purgeAnchoredDirContents(childHandle);
        } finally {
          await childHandle.dirFd.close().catch(() => undefined);
        }
        await fsp.rmdir(childTarget).catch((err: unknown) => {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          if (code !== "ENOENT") throw err;
        });
      }
    } else {
      // Regular files, symlinks (unlinks link itself without traversing), FIFOs, etc.
      await fsp.unlink(childTarget).catch((err: unknown) => {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT") throw err;
      });
    }
  }
}

function isSafeAgentId(agentId: string): boolean {
  return (
    typeof agentId === "string" &&
    agentId.length > 0 &&
    agentId.length <= 128 &&
    /^[A-Za-z0-9._-]+$/.test(agentId) &&
    agentId !== "." &&
    agentId !== ".."
  );
}

function sanitizeTitle(title: string): string {
  return title.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().slice(0, 200);
}

async function readRange(fh: fsp.FileHandle, offset: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await fh.read(buf, total, length - total, offset + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total === length ? buf : buf.subarray(0, total);
}

async function readTailWindowUtf8(fh: fsp.FileHandle, size: number, maxBytes: number): Promise<string> {
  if (size <= 0) return "";
  const startOffset = size > maxBytes ? size - maxBytes : 0;
  const targetBytes = size - startOffset;
  const out = Buffer.allocUnsafe(targetBytes);
  let totalRead = 0;
  while (totalRead < targetBytes) {
    const chunkSize = Math.min(READ_CHUNK_BYTES, targetBytes - totalRead);
    const { bytesRead } = await fh.read(out, totalRead, chunkSize, startOffset + totalRead);
    if (bytesRead === 0) break;
    totalRead += bytesRead;
  }
  let slice = out.subarray(0, totalRead);
  if (startOffset > 0) {
    // Drop partial leading line before decoding UTF-8 so multi-byte characters never split.
    const firstNl = slice.indexOf(0x0a);
    if (firstNl < 0) return "";
    slice = slice.subarray(firstNl + 1);
  }
  return slice.toString("utf8");
}

function lineHasConversationEntry(line: string): boolean {
  if (!line) return false;
  if (!line.includes('"type":"user"') && !line.includes('"type": "user"') &&
      !line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) {
    return false;
  }
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.type === "user") {
      return parsed.isMeta !== true && parsed.isCompactSummary !== true;
    }
    if (parsed.type === "assistant") {
      const msg = parsed.message as Record<string, unknown> | undefined;
      return parsed.isApiErrorMessage !== true && typeof msg?.stop_reason === "string";
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Scan backward from the end of transcript tail for an active `continued-in`
 * marker, stopping if a real user or assistant turn occurred after it.
 */
function extractTrailingContinuedIn(tailText: string): string | undefined {
  if (!tailText.includes('"continued-in"')) return undefined;
  let end = tailText.length;
  while (end > 0) {
    const nl = tailText.lastIndexOf("\n", end - 1);
    const line = tailText.slice(nl + 1, end).trim();
    end = nl;
    if (!line) {
      if (nl < 0) break;
      continue;
    }
    const isCont = line.includes('"continued-in"');
    const isMsg = line.includes('"user"') || line.includes('"assistant"');
    if (isCont || isMsg) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "continued-in" && typeof entry.continuedInSessionId === "string") {
          return UUID_RE.test(entry.continuedInSessionId) ? entry.continuedInSessionId : undefined;
        }
        if (entry.type === "assistant") {
          const msg = entry.message as Record<string, unknown> | undefined;
          if (entry.isApiErrorMessage !== true && typeof msg?.stop_reason === "string") {
            return undefined;
          }
        }
        if (entry.type === "user") {
          const candidate = userTextCandidate((entry.message as Record<string, unknown> | undefined)?.content);
          if (candidate !== null && entry.isMeta !== true && entry.isCompactSummary !== true) {
            return undefined;
          }
        }
      } catch {
        // ignore unparseable line
      }
    }
    if (nl < 0) break;
  }
  return undefined;
}

/**
 * Prune rewound/abandoned branches in Claude JSONL transcripts by walking the
 * active chain from the latest main-thread leaf via `parentUuid` / `logicalParentUuid`.
 * Legacy transcripts without `uuid` fields are returned verbatim in file order.
 */
export function followClaudeBranch<T extends Record<string, unknown>>(entries: T[]): T[] {
  if (entries.length === 0) return [];

  const withUuid = entries.filter((e) => typeof e.uuid === "string" && e.uuid.length > 0);
  if (withUuid.length === 0) {
    return entries;
  }

  const byUuid = new Map<string, T>();
  const indexByUuid = new Map<string, number>();
  for (let i = 0; i < withUuid.length; i += 1) {
    const entry = withUuid[i]!;
    const uuid = entry.uuid as string;
    byUuid.set(uuid, entry);
    indexByUuid.set(uuid, i);
  }

  // Relink compact_boundary preservedMessages / preservedSegment when present.
  for (const entry of [...byUuid.values()]) {
    if (entry.type !== "system" || entry.subtype !== "compact_boundary") continue;
    const meta = entry.compactMetadata as Record<string, unknown> | undefined;
    const preservedMessages = meta?.preservedMessages as { anchorUuid?: string; uuids?: string[] } | undefined;
    const preservedSegment = meta?.preservedSegment as
      | { anchorUuid?: string; headUuid?: string; tailUuid?: string }
      | undefined;

    if (
      preservedMessages &&
      Array.isArray(preservedMessages.uuids) &&
      preservedMessages.uuids.length > 0 &&
      typeof preservedMessages.anchorUuid === "string" &&
      preservedMessages.uuids.every((u) => byUuid.has(u))
    ) {
      let anchor = preservedMessages.anchorUuid;
      for (const u of preservedMessages.uuids) {
        const target = byUuid.get(u)!;
        byUuid.set(u, { ...target, parentUuid: anchor });
        anchor = u;
      }
      const firstU = preservedMessages.uuids[0]!;
      const lastU = preservedMessages.uuids[preservedMessages.uuids.length - 1]!;
      for (const [u, cur] of byUuid) {
        if (cur.parentUuid === preservedMessages.anchorUuid && u !== firstU) {
          byUuid.set(u, { ...cur, parentUuid: lastU });
        }
      }
    } else if (
      preservedSegment &&
      typeof preservedSegment.anchorUuid === "string" &&
      typeof preservedSegment.headUuid === "string" &&
      typeof preservedSegment.tailUuid === "string"
    ) {
      const headNode = byUuid.get(preservedSegment.headUuid);
      if (headNode) {
        byUuid.set(preservedSegment.headUuid, { ...headNode, parentUuid: preservedSegment.anchorUuid });
      }
      for (const [u, cur] of byUuid) {
        if (cur.parentUuid === preservedSegment.anchorUuid && u !== preservedSegment.headUuid) {
          byUuid.set(u, { ...cur, parentUuid: preservedSegment.tailUuid });
        }
      }
    }
  }

  const parentOf = (entry: T): string | undefined => {
    if (typeof entry.parentUuid === "string" && entry.parentUuid) return entry.parentUuid;
    if (typeof entry.logicalParentUuid === "string" && entry.logicalParentUuid) return entry.logicalParentUuid;
    return undefined;
  };

  const isMainTrack = (entry: T): boolean =>
    entry.isSidechain !== true && !entry.teamName && entry.type !== "progress";

  const referencedParents = new Set<string>();
  for (const entry of byUuid.values()) {
    if (!isMainTrack(entry)) continue;
    const p = parentOf(entry);
    if (p) referencedParents.add(p);
  }

  const tips = [...byUuid.values()]
    .filter((entry) => isMainTrack(entry) && !referencedParents.has(entry.uuid as string))
    .sort((a, b) => (indexByUuid.get(b.uuid as string) ?? -1) - (indexByUuid.get(a.uuid as string) ?? -1));

  let leaf: T | undefined;
  for (const tip of tips) {
    const seen = new Set<string>();
    let cursor: T | undefined = tip;
    while (cursor && !seen.has(cursor.uuid as string)) {
      seen.add(cursor.uuid as string);
      if (
        cursor.type === "user" ||
        cursor.type === "assistant" ||
        (cursor.type === "system" && cursor.subtype === "local_command")
      ) {
        leaf = cursor;
        break;
      }
      const p = parentOf(cursor);
      cursor = p ? byUuid.get(p) : undefined;
    }
    if (leaf) break;
  }

  if (!leaf) {
    const fallbacks = [...byUuid.values()].filter(
      (e) =>
        e.type === "user" ||
        e.type === "assistant" ||
        (e.type === "system" && e.subtype === "local_command"),
    );
    const nonMeta = fallbacks.filter((e) => isMainTrack(e) && e.isMeta !== true);
    const pool = nonMeta.length > 0 ? nonMeta : fallbacks;
    if (pool.length === 0) return [];
    leaf = pool.reduce((best, cur) =>
      (indexByUuid.get(cur.uuid as string) ?? -1) > (indexByUuid.get(best.uuid as string) ?? -1) ? cur : best,
    );
  }

  const chain: T[] = [];
  const visited = new Set<string>();
  let cursor: T | undefined = leaf;
  while (cursor) {
    const uuid = cursor.uuid as string;
    if (visited.has(uuid)) break;
    visited.add(uuid);
    chain.push(cursor);
    const p = parentOf(cursor);
    cursor = p ? byUuid.get(p) : undefined;
  }
  chain.reverse();
  return chain;
}

function parseHistoryTranscript(
  text: string,
  options: { allowSidechain?: boolean } = {},
): ClaudeHistoryMessage[] {
  const rawEntries: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    if (!options.allowSidechain && rec.isSidechain === true) continue;
    if (rec.teamName) continue;
    rawEntries.push(rec);
  }

  const branchEntries = followClaudeBranch(rawEntries);
  const messages: ClaudeHistoryMessage[] = [];

  for (const entry of branchEntries) {
    const type = entry.type;
    if (type === "system" && entry.subtype === "local_command") {
      const localOutput = extractLocalCommandOutput(typeof entry.content === "string" ? entry.content : extractText(entry.content));
      if (localOutput) {
        messages.push({
          role: "assistant",
          text: localOutput,
          timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
          model: "<synthetic>",
          ...(typeof entry.uuid === "string" ? { uuid: entry.uuid } : {}),
          ...(entry.parentUuid !== undefined ? { parentUuid: entry.parentUuid as string | null } : {}),
        });
      }
      continue;
    }
    if (type !== "user" && type !== "assistant") continue;
    if (entry.isMeta === true && entry.isCompactSummary !== true) continue;

    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg || msg.role !== type) continue;

    const blocks: NonNullable<ClaudeHistoryMessage["blocks"]> = [];
    let hasNonTextStructuredBlock = false;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          blocks.push({ type: "text", text: b.text });
        } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
          hasNonTextStructuredBlock = true;
          blocks.push({ type: "thinking", text: b.thinking });
        } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          hasNonTextStructuredBlock = true;
          blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
        } else if (b.type === "tool_result") {
          hasNonTextStructuredBlock = true;
          const raw = b.content;
          const out =
            typeof raw === "string"
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

    const rawText = extractText(msg.content);
    if (type === "user" && !hasNonTextStructuredBlock) {
      const legacyOutput = extractLocalCommandOutput(rawText);
      if (legacyOutput !== null) {
        if (legacyOutput) {
          messages.push({
            role: "assistant",
            text: legacyOutput,
            timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
            model: "<synthetic>",
            ...(typeof entry.uuid === "string" ? { uuid: entry.uuid } : {}),
            ...(entry.parentUuid !== undefined ? { parentUuid: entry.parentUuid as string | null } : {}),
          });
        }
        continue;
      }
    }
    const isBashOut = type === "user" && (rawText.includes("<bash-stdout>") || rawText.includes("<bash-stderr>"));
    const formattedText = type === "user" ? formatTranscriptUserText(rawText) : rawText;
    if (formattedText === null && !hasNonTextStructuredBlock) continue;
    // 清洗后为空(caveat 等纯噪音)且没有结构化块:整条丢弃,不留空 user 消息。
    if (formattedText !== null && !formattedText.trim() && !hasNonTextStructuredBlock) continue;
    const finalText = formattedText ?? "";
    if (!finalText && blocks.length === 0) continue;

    // 对 user 角色且没有非文本结构化块（thinking/tool_use/tool_result）的消息，
    // 不透传原始未清洗的 blocks，使 facade 能够使用经过 formatTranscriptUserText 清洗后的 text；
    // 同时保留 assistant 的纯文本或混合 thinking/tool_use blocks。
    const effectiveBlocks =
      type === "user" && !hasNonTextStructuredBlock
        ? undefined
        : blocks.length > 0
          ? blocks
          : undefined;

    messages.push({
      role: type,
      text: finalText,
      ...(effectiveBlocks ? { blocks: effectiveBlocks } : {}),
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
      model: type === "assistant" && typeof msg.model === "string" ? msg.model : undefined,
      isError: type === "assistant" && entry.isApiErrorMessage === true,
      ...(entry.isCompactSummary === true ? { isCompactSummary: true } : {}),
      ...(isBashOut ? { isLocalBashOutput: true } : {}),
      ...(typeof entry.uuid === "string" ? { uuid: entry.uuid } : {}),
      ...(entry.parentUuid !== undefined ? { parentUuid: entry.parentUuid as string | null } : {}),
    });
  }

  return messages;
}

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

export function unwrapPastedContent(text: string): string {
  if (!text.includes("<pasted_content")) return text;
  let out = text.replace(
    /<pasted_content(?:\s+id="([0-9a-f]{4})")?>\r?\n?([\s\S]*?)\r?\n?<\/pasted_content(?:\s+id="\1")?>/gi,
    (_m, _id, body: string) => body,
  );
  out = out.replace(
    /<pasted_content(?:\s+[^>]*)?>\r?\n?([\s\S]*?)\r?\n?<\/pasted_content(?:\s+[^>]*)?>/gi,
    (_m, body: string) => body,
  );
  return out;
}

/** Pull human-readable text out of a transcript message content field, unwrapping `<pasted_content>`. */
function extractText(content: unknown): string {
  if (typeof content === "string") return unwrapPastedContent(content).trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string") {
      parts.push(unwrapPastedContent((block as any).text));
    }
  }
  return parts.join("").trim();
}

/** Extract clean body from `<local-command-stdout>` / `<local-command-stderr>`; returns null if unrelated. */
function extractLocalCommandOutput(text: string): string | null {
  if (!text) return null;
  if (!text.includes("<local-command-stdout") && !text.includes("<local-command-stderr")) return null;
  const outMatch = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
  const errMatch = /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/.exec(text);
  const stdoutText = outMatch?.[1]?.trim() ?? "";
  const stderrText = errMatch?.[1]?.trim() ?? "";
  const combined = [stdoutText, stderrText ? `Error: ${stderrText}` : ""].filter(Boolean).join("\n").trim();
  return combined;
}

/** Format user text in transcript history (`<command-name>`, `<bash-input>`, `<bash-stdout>`, `<bash-stderr>`, skipping caveats). */
function formatTranscriptUserText(text: string): string | null {
  if (!text) return null;
  if (text.startsWith("<local-command-caveat") || text.startsWith("Caveat:")) return null;

  const cmdMatch = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text);
  if (cmdMatch) {
    const rawCmd = cmdMatch[1]!.trim();
    const cmd = rawCmd.startsWith("/") ? rawCmd : `/${rawCmd}`;
    const argsMatch = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    const argsText = argsMatch?.[1]?.trim() ?? "";
    const stripped = text
      .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
      .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
      .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
      .trim();
    if (!stripped) {
      return argsText ? `${cmd} ${argsText}` : cmd;
    }
    return stripped;
  }

  if (isLocalCommandText(text)) return null;

  const bashIn = /^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*$/.exec(text);
  if (bashIn) {
    const cmd = bashIn[1]!.trim();
    return cmd ? `! ${cmd}` : null;
  }

  if (text.includes("<bash-stdout>") || text.includes("<bash-stderr>")) {
    const outMatch = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(text);
    const errMatch = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/.exec(text);
    const stdoutText = outMatch?.[1]?.trim() ?? "";
    const stderrText = errMatch?.[1]?.trim() ?? "";
    const combined = [stdoutText, stderrText].filter(Boolean).join("\n").trim();
    return combined || null;
  }

  return text;
}

/** True for CLI-local noise (`<local-command-...>`, `<command-name>`, `<command-message>`, `<command-args>`, caveats). */
function isLocalCommandText(text: string): boolean {
  return (
    text.startsWith("<local-command") ||
    text.startsWith("<command-name") ||
    text.startsWith("<command-message") ||
    text.startsWith("<command-args") ||
    text.startsWith("Caveat:") ||
    text.startsWith("<local-command-caveat")
  );
}

/** 原生 /resume 标题兜底候选:真实消息 → {kind:'text'};斜杠命令(还原 "/x") → {kind:'cmd'}。 */
function userTextCandidate(content: unknown): { kind: "text" | "cmd"; text: string } | null {
  const text = extractText(content);
  if (!text) return null;
  const cmd = /<command-name>([^<]+)<\/command-name>/.exec(text);
  if (cmd) return { kind: "cmd", text: cmd[1]!.trim() };
  const bashIn = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text);
  if (bashIn) {
    const cmdText = bashIn[1]!.trim();
    return cmdText ? { kind: "text", text: `! ${cmdText}` } : null;
  }
  if (text.startsWith("<bash-stdout") || text.startsWith("<bash-stderr")) return null;
  if (isLocalCommandText(text)) return null;
  if (text === "[Request interrupted by user]") return null;
  if (text.startsWith("⎿")) return null;
  return { kind: "text", text };
}

function formatMultiSelectAnswer(values: string[], multiSelect: boolean): string {
  const cleaned = values.map((v) => String(v));
  if (multiSelect || cleaned.length > 1) {
    return cleaned
      .map((v) => (v.includes(", ") || v.includes('"') ? JSON.stringify(v) : v))
      .join(", ");
  }
  return cleaned[0] ?? "";
}

/**
 * Translate gateway question answers (`string` or `Record<q_N | questionId | questionText, string[] | string>`)
 * into Claude CLI's expected `Record<question.question, string>` map, validating `q_N` bounds.
 */
export function encodeAskUserQuestionAnswers(
  questions: unknown[],
  answer: ClaudeQuestionAnswerInput,
): Record<string, string> {
  const qRecords = questions.map((q) =>
    q && typeof q === "object" && !Array.isArray(q) ? (q as Record<string, unknown>) : {},
  );

  if (typeof answer === "string") {
    if (qRecords.length === 0) return { q_0: answer };
    const first = qRecords[0]!;
    const key =
      (typeof first.question === "string" && first.question) ||
      (typeof first.header === "string" && first.header) ||
      "q_0";
    return { [key]: answer };
  }

  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    throw new ProviderError("invalid_request", "claude-adapter: invalid question answer payload", 400);
  }

  const encoded: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(answer)) {
    let targetKey = rawKey;
    let isMulti = false;

    const indexMatch = /^q_(-?\d+)$/.exec(rawKey);
    if (indexMatch) {
      const idx = Number(indexMatch[1]);
      if (qRecords.length === 0) {
        if (idx !== 0) {
          throw new ProviderError(
            "invalid_request",
            `claude-adapter: question index ${rawKey} out of bounds (no questions)`,
            400,
          );
        }
      } else {
        if (!Number.isInteger(idx) || idx < 0 || idx >= qRecords.length) {
          throw new ProviderError(
            "invalid_request",
            `claude-adapter: question index ${rawKey} out of bounds (0..${qRecords.length - 1})`,
            400,
          );
        }
        const q = qRecords[idx]!;
        const qText =
          (typeof q.question === "string" && q.question) ||
          (typeof q.header === "string" && q.header) ||
          "";
        if (!qText) {
          throw new ProviderError(
            "invalid_request",
            `claude-adapter: question at index ${idx} is missing question text`,
            400,
          );
        }
        targetKey = qText;
        isMulti = q.multiSelect === true || q.multi_select === true;
      }
    } else if (qRecords.length > 0) {
      const byText = qRecords.find((q) => q.question === rawKey);
      const byId = byText ?? qRecords.find((q) => q.id === rawKey);
      if (!byId) {
        throw new ProviderError(
          "invalid_request",
          `claude-adapter: unknown question key "${rawKey}"`,
          400,
        );
      }
      targetKey =
        (typeof byId.question === "string" && byId.question) ||
        (typeof byId.header === "string" && byId.header) ||
        rawKey;
      isMulti = byId.multiSelect === true || byId.multi_select === true;
    }

    if (Array.isArray(rawVal)) {
      encoded[targetKey] = formatMultiSelectAnswer(
        rawVal.map((item) => {
          if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
            throw new ProviderError(
              "invalid_request",
              `claude-adapter: invalid answer item for "${rawKey}"`,
              400,
            );
          }
          return String(item);
        }),
        isMulti,
      );
    } else if (typeof rawVal === "string") {
      encoded[targetKey] = rawVal;
    } else {
      throw new ProviderError(
        "invalid_request",
        `claude-adapter: invalid answer value for "${rawKey}"`,
        400,
      );
    }
  }

  return encoded;
}

/** Translate one CLI stream-json line into zero or more adapter events. */
function mapStreamEvent(ev: any, state?: StreamMapperState): ClaudeAdapterEvent[] {
  const out: ClaudeAdapterEvent[] = [];
  const uuid = typeof ev?.uuid === "string" && ev.uuid ? ev.uuid : undefined;
  const parentToolUseId =
    typeof ev?.parent_tool_use_id === "string" && ev.parent_tool_use_id
      ? ev.parent_tool_use_id
      : undefined;
  const agentId = typeof ev?.agent_id === "string" && ev.agent_id ? ev.agent_id : undefined;
  const subagentType =
    typeof ev?.subagent_type === "string" && ev.subagent_type ? ev.subagent_type : undefined;

  switch (ev?.type) {
    case "system":
      if (ev.subtype === "init") {
        const rawPermMode = ev.permissionMode ?? ev.permission_mode;
        const permissionMode = typeof rawPermMode === "string" ? rawPermMode : undefined;
        const rawSlash = Array.isArray(ev.slash_commands)
          ? ev.slash_commands
          : Array.isArray(ev.commands)
            ? ev.commands
            : undefined;
        const slashCommands = rawSlash
          ?.map((c: unknown) => (typeof c === "string" ? c : (c && typeof c === "object" && typeof (c as any).name === "string" ? (c as any).name : undefined)))
          .filter((c: unknown): c is string => typeof c === "string");
        out.push({
          type: "init",
          sessionId: ev.session_id,
          cwd: ev.cwd,
          tools: Array.isArray(ev.tools) ? ev.tools : [],
          ...(uuid ? { uuid } : {}),
          ...(typeof ev.model === "string" ? { model: ev.model } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(slashCommands ? { slashCommands } : {}),
          ...(Array.isArray(ev.terminal_slash_commands)
            ? {
                terminalSlashCommands: ev.terminal_slash_commands
                  .map((c: unknown) => (typeof c === "string" ? c : (c && typeof c === "object" && typeof (c as any).name === "string" ? (c as any).name : undefined)))
                  .filter((c: unknown): c is string => typeof c === "string"),
              }
            : {}),
          ...(Array.isArray(ev.skills) ? { skills: ev.skills } : {}),
          ...(Array.isArray(ev.capabilities) ? { capabilities: ev.capabilities } : {}),
          ...(typeof ev.claude_code_version === "string" ? { claudeCodeVersion: ev.claude_code_version } : {}),
          ...(typeof ev.fast_mode_state === "string" ? { fastModeState: ev.fast_mode_state } : {}),
          ...(ev.effort !== undefined ? { effort: ev.effort as string | null } : {}),
        });
      } else if (ev.subtype === "compact_boundary") {
        const rawLogicalParentUuid = ev.logical_parent_uuid ?? ev.logicalParentUuid;
        const logicalParentUuid =
          typeof rawLogicalParentUuid === "string" && rawLogicalParentUuid ? rawLogicalParentUuid : undefined;
        const rawParentUuid = ev.parent_uuid !== undefined ? ev.parent_uuid : ev.parentUuid;
        const parentUuid = typeof rawParentUuid === "string" || rawParentUuid === null ? rawParentUuid : undefined;
        const rawMeta = ev.compact_metadata ?? ev.compactMetadata;
        const compactMetadata =
          rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)
            ? (rawMeta as Record<string, unknown>)
            : undefined;
        out.push({
          type: "compact_boundary",
          sessionId: String(ev.session_id ?? ""),
          ...(uuid ? { uuid } : {}),
          ...(logicalParentUuid ? { logicalParentUuid } : {}),
          ...(parentUuid !== undefined ? { parentUuid } : {}),
          ...(compactMetadata ? { compactMetadata } : {}),
        });
      } else if (ev.subtype === "conversation_reset") {
        out.push({
          type: "conversation_reset",
          sessionId: String(ev.session_id ?? ""),
          ...(typeof ev.new_conversation_id === "string" ? { newConversationId: ev.new_conversation_id } : {}),
          ...(typeof ev.trigger === "string" ? { trigger: ev.trigger } : {}),
          ...(uuid ? { uuid } : {}),
        });
      } else if (ev.subtype === "task_started" && typeof ev.task_id === "string") {
        const rawTaskToolUseId = ev.tool_use_id ?? ev.parent_tool_use_id;
        const toolUseId = typeof rawTaskToolUseId === "string" && rawTaskToolUseId ? rawTaskToolUseId : undefined;
        out.push({
          type: "task_started",
          sessionId: String(ev.session_id ?? ""),
          taskId: ev.task_id,
          description: String(ev.description ?? ""),
          ...(toolUseId ? { toolUseId } : {}),
          ...(typeof ev.subagent_type === "string" ? { subagentType: ev.subagent_type } : {}),
          ...(typeof ev.is_backgrounded === "boolean" ? { isBackgrounded: ev.is_backgrounded } : {}),
          ...(typeof ev.spawn_depth === "number" ? { spawnDepth: ev.spawn_depth } : {}),
          ...(typeof ev.parent_task_id === "string" ? { parentTaskId: ev.parent_task_id } : {}),
          ...(typeof ev.task_type === "string" ? { taskType: ev.task_type } : {}),
          ...(uuid ? { uuid } : {}),
        });
      } else if (ev.subtype === "task_progress" && typeof ev.task_id === "string") {
        const rawTaskToolUseId = ev.tool_use_id ?? ev.parent_tool_use_id;
        const toolUseId = typeof rawTaskToolUseId === "string" && rawTaskToolUseId ? rawTaskToolUseId : undefined;
        out.push({
          type: "task_progress",
          sessionId: String(ev.session_id ?? ""),
          taskId: ev.task_id,
          description: String(ev.description ?? ""),
          ...(toolUseId ? { toolUseId } : {}),
          ...(typeof ev.subagent_type === "string" ? { subagentType: ev.subagent_type } : {}),
          ...(ev.usage && typeof ev.usage === "object" ? { usage: ev.usage } : {}),
          ...(typeof ev.last_tool_name === "string" ? { lastToolName: ev.last_tool_name } : {}),
          ...(typeof ev.summary === "string" ? { summary: ev.summary } : {}),
          ...(uuid ? { uuid } : {}),
        });
      } else if (ev.subtype === "task_updated" && typeof ev.task_id === "string") {
        out.push({
          type: "task_updated",
          sessionId: String(ev.session_id ?? ""),
          taskId: ev.task_id,
          patch: ev.patch && typeof ev.patch === "object" ? (ev.patch as Record<string, unknown>) : {},
          ...(uuid ? { uuid } : {}),
        });
      } else if (ev.subtype === "task_notification" && typeof ev.task_id === "string") {
        const rawTaskToolUseId = ev.tool_use_id ?? ev.parent_tool_use_id;
        const toolUseId = typeof rawTaskToolUseId === "string" && rawTaskToolUseId ? rawTaskToolUseId : undefined;
        out.push({
          type: "task_notification",
          sessionId: String(ev.session_id ?? ""),
          taskId: ev.task_id,
          status: String(ev.status ?? ""),
          summary: String(ev.summary ?? ""),
          ...(toolUseId ? { toolUseId } : {}),
          ...(typeof ev.output_file === "string" ? { outputFile: ev.output_file } : {}),
          ...(ev.usage && typeof ev.usage === "object" ? { usage: ev.usage } : {}),
          ...(uuid ? { uuid } : {}),
        });
      }
      break;

    case "conversation_reset":
      out.push({
        type: "conversation_reset",
        sessionId: String(ev.session_id ?? ""),
        ...(typeof ev.new_conversation_id === "string" ? { newConversationId: ev.new_conversation_id } : {}),
        ...(typeof ev.trigger === "string" ? { trigger: ev.trigger } : {}),
        ...(uuid ? { uuid } : {}),
      });
      break;

    case "stream_event": {
      const e = ev.event;
      if (e?.type === "content_block_delta") {
        const d = e.delta;
        if (d?.type === "text_delta" && typeof d.text === "string") {
          state?.streamedParentKeys.add(parentToolUseId ?? "__main__");
          out.push({
            type: "text_delta",
            text: d.text,
            ...(uuid ? { uuid } : {}),
            ...(parentToolUseId ? { parentToolUseId } : {}),
            ...(agentId ? { agentId } : {}),
            ...(subagentType ? { subagentType } : {}),
          });
        } else if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
          state?.streamedParentKeys.add(parentToolUseId ?? "__main__");
          out.push({
            type: "thinking_delta",
            text: d.thinking,
            ...(uuid ? { uuid } : {}),
            ...(parentToolUseId ? { parentToolUseId } : {}),
            ...(agentId ? { agentId } : {}),
            ...(subagentType ? { subagentType } : {}),
          });
        }
      }
      break;
    }

    case "assistant": {
      const content = ev.message?.content;
      if (Array.isArray(content)) {
        if (ev.message?.model === "<synthetic>") {
          const text = extractText(content);
          if (text) {
            out.push({
              type: "synthetic_text",
              text,
              ...(uuid ? { uuid } : {}),
              ...(parentToolUseId ? { parentToolUseId } : {}),
              ...(agentId ? { agentId } : {}),
            });
          }
        } else {
          const streamKey = parentToolUseId ?? "__main__";
          const alreadyStreamed = state?.streamedParentKeys.has(streamKey) ?? false;
          state?.streamedParentKeys.delete(streamKey);
          if (!alreadyStreamed) {
            for (const block of content) {
              if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
                out.push({
                  type: "thinking_delta",
                  text: block.thinking,
                  ...(uuid ? { uuid } : {}),
                  ...(parentToolUseId ? { parentToolUseId } : {}),
                  ...(agentId ? { agentId } : {}),
                  ...(subagentType ? { subagentType } : {}),
                });
              } else if (block?.type === "text" && typeof block.text === "string" && block.text) {
                out.push({
                  type: "text_delta",
                  text: block.text,
                  ...(uuid ? { uuid } : {}),
                  ...(parentToolUseId ? { parentToolUseId } : {}),
                  ...(agentId ? { agentId } : {}),
                  ...(subagentType ? { subagentType } : {}),
                });
              }
            }
          }
        }

        for (const block of content) {
          if (block?.type === "tool_use") {
            out.push({
              type: "tool_use",
              toolUseId: String(block.id ?? ""),
              name: String(block.name ?? ""),
              input: block.input,
              ...(uuid ? { uuid } : {}),
              ...(parentToolUseId ? { parentToolUseId } : {}),
              ...(agentId ? { agentId } : {}),
              ...(subagentType ? { subagentType } : {}),
            });
          }
        }
      }
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
                  : Array.isArray(block.content)
                    ? (block.content as Array<Record<string, unknown>>).map((x) => (x?.text as string) ?? "").join("")
                    : JSON.stringify(block.content ?? ""),
              isError: block.is_error === true,
              ...(ev.tool_use_result !== undefined ? { toolUseResult: ev.tool_use_result } : {}),
              ...(uuid ? { uuid } : {}),
              ...(parentToolUseId ? { parentToolUseId } : {}),
              ...(agentId ? { agentId } : {}),
              ...(subagentType ? { subagentType } : {}),
            });
          }
        }
      }
      break;
    }

    case "tool_progress":
      out.push({
        type: "tool_progress",
        toolUseId: String(ev.tool_use_id ?? ""),
        toolName: String(ev.tool_name ?? ""),
        elapsedTimeSeconds: typeof ev.elapsed_time_seconds === "number" ? ev.elapsed_time_seconds : 0,
        ...(parentToolUseId ? { parentToolUseId } : {}),
        ...(typeof ev.task_id === "string" ? { taskId: ev.task_id } : {}),
        ...(subagentType ? { subagentType } : {}),
        ...(uuid ? { uuid } : {}),
      });
      break;

    case "tool_use_summary":
      out.push({
        type: "tool_use_summary",
        summary: String(ev.summary ?? ""),
        precedingToolUseIds: Array.isArray(ev.preceding_tool_use_ids)
          ? ev.preceding_tool_use_ids.filter((id: unknown): id is string => typeof id === "string")
          : [],
        ...(uuid ? { uuid } : {}),
      });
      break;

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
      const totalCostUsd = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined;
      const rawModelUsage = ev.modelUsage ?? ev.model_usage;
      const modelUsage =
        rawModelUsage && typeof rawModelUsage === "object" && !Array.isArray(rawModelUsage)
          ? (rawModelUsage as Record<string, unknown>)
          : undefined;
      out.push({
        type: "done",
        sessionId: String(ev.session_id ?? ""),
        result: typeof ev.result === "string" ? ev.result : "",
        isError: ev.is_error === true,
        subtype: String(ev.subtype ?? ""),
        stopReason: ev.stop_reason ?? null,
        usage: ev.usage,
        ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
        ...(modelUsage !== undefined ? { modelUsage } : {}),
        ...(typeof ev.num_turns === "number" ? { numTurns: ev.num_turns } : {}),
        ...(typeof ev.fast_mode_state === "string" ? { fastModeState: ev.fast_mode_state } : {}),
        durationMs: ev.duration_ms,
        ...(uuid ? { uuid } : {}),
      });
      break;
    }

    case "control_request": {
      const requestId = String(ev.request_id ?? ev.request?.request_id ?? "");
      const req =
        ev.request && typeof ev.request === "object" ? (ev.request as Record<string, unknown>) : {};
      if (!requestId) break;
      const kind = controlKind(req);
      const reqParentToolUseId =
        typeof req.parent_tool_use_id === "string" && req.parent_tool_use_id
          ? req.parent_tool_use_id
          : parentToolUseId;
      const reqAgentId =
        typeof req.agent_id === "string" && req.agent_id ? req.agent_id : agentId;
      const rawToolUseId = req.tool_use_id ?? req.toolUseID;
      const itemId = typeof rawToolUseId === "string" && rawToolUseId ? rawToolUseId : undefined;

      if (kind === "question") {
        const questions = extractQuestions(req);
        const first =
          questions[0] && typeof questions[0] === "object"
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
          ...(itemId ? { itemId } : {}),
          ...(reqAgentId ? { agentId: reqAgentId } : {}),
          ...(reqParentToolUseId ? { parentToolUseId: reqParentToolUseId } : {}),
        });
      } else if (kind === "approval") {
        out.push({
          type: "approval",
          approvalId: requestId,
          tool: String(req.tool_name ?? ""),
          input: req.input,
          ...(itemId ? { itemId } : {}),
          ...(Array.isArray(req.permission_suggestions) ? { suggestions: req.permission_suggestions } : {}),
          ...(typeof req.blocked_path === "string" ? { blockedPath: req.blocked_path } : {}),
          ...(typeof req.decision_reason === "string" ? { decisionReason: req.decision_reason } : {}),
          ...(typeof req.decision_reason_type === "string" ? { decisionReasonType: req.decision_reason_type } : {}),
          ...(typeof req.suppress_always_allow_rule === "boolean"
            ? { suppressAlwaysAllow: req.suppress_always_allow_rule }
            : {}),
          ...(typeof req.default_to_no === "boolean" ? { defaultToNo: req.default_to_no } : {}),
          ...(typeof req.requires_user_interaction === "boolean"
            ? { requiresUserInteraction: req.requires_user_interaction }
            : {}),
          ...(typeof req.title === "string" ? { title: req.title } : {}),
          ...(typeof req.display_name === "string" ? { displayName: req.display_name } : {}),
          ...(typeof req.description === "string" ? { description: req.description } : {}),
          ...(reqAgentId ? { agentId: reqAgentId } : {}),
          ...(reqParentToolUseId ? { parentToolUseId: reqParentToolUseId } : {}),
          ...(req.matched_ask_rule && typeof req.matched_ask_rule === "object"
            ? { matchedAskRule: req.matched_ask_rule as Record<string, unknown> }
            : {}),
          ...(typeof req.classifier_approvable === "boolean"
            ? { classifierApprovable: req.classifier_approvable }
            : {}),
          ...(req.mcp_server && typeof req.mcp_server === "object"
            ? { mcpServer: req.mcp_server as { name: string; source: string } }
            : {}),
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
