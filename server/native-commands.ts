/**
 * native-commands:claude / codex / grok / pi 的原生斜杠命令目录与展开辅助。
 *
 * 四家机制截然不同(均已实测):
 * - claude:CLI 在 -p stream-json 模式下自己展开并执行 "/name args",
 *   权威目录来自 initialize 握手回包(aliases / argumentHint),也可通过
 *   discoverClaudeDiskCommands 做零子进程有界磁盘发现。网关不展开文本,只透传。
 * - codex:app-server 没有 slash 概念。目录 = web UI 本地 client 命令 +
 *   网关代执行命令(compact/fork/undo/review/status/usage/mcp)+ skills/list。
 *   acceptsInput 按 takesArgs 对齐(例如 /review 支持附加指令参数)。
 * - grok:ACP (`grok agent stdio`) 为主路径。目录 = client 命令 + 网关代执行
 *   命令(compact/fork/undo/usage)+ Grok 1.0.77 原生命令(always-approve/
 *   context/session-info/feedback/deep-research/workflow/goal/loop)+ 磁盘 skills。
 * - pi:RPC (`pi --mode rpc`) 为主路径。目录 = client 命令 + Pi 网关代执行命令
 *   (compact/clone/fork/status/usage;无 /undo、不含 TUI 独占内置命令)+
 *   `get_commands` 返回的 extension/prompt/skill 命令(Pi 自己展开,网关不重复展开)。
 */

import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NativeCommand, NativeCommandForm } from './types.js';

// ---------------------------------------------------------------------------
// 命令形态（form）：与 Ovis 的 "catalog describes forms, not just names" 对齐。
// 名字相同不代表行为相同；形态决定前端与网关各自该做什么，避免三处各自猜。
// ---------------------------------------------------------------------------

/** 本机实测各 CLI 的目录钉子版本；CLI 版本变化时这些行标为未核实。 */
export const COMMAND_PINS = {
  claude: '2.1.325',
  codex: '0.169.0',
  grok: '1.0.77',
  pi: '1.5.2',
  dsh: '0.2.2-rc.1',
} as const;

export type PinnableProvider = keyof typeof COMMAND_PINS;

/** 给一条命令补 form / pinnedVersion / verified；已有的 form 不覆盖。 */
export function withForm(
  command: NativeCommand,
  form: NativeCommandForm,
  provider?: PinnableProvider,
  actualVersion?: string,
): NativeCommand {
  const pin = provider ? COMMAND_PINS[provider] : undefined;
  return {
    ...command,
    form: command.form ?? form,
    ...(pin ? { pinnedVersion: pin } : {}),
    ...(pin && actualVersion ? { verified: actualVersion === pin || actualVersion.startsWith(`${pin}.`) } : {}),
  };
}

/**
 * 客户端命令的形态恒为 client；终端的恒为 terminal。
 * 其余按命令本来的处理方判定：网关拦截集合 → gateway；来自 CLI 自己目录或扩展的 → cli。
 * 兜底为 cli：发给 CLI 由它自己展开，不认识的它会明确报错——这比静默当成聊天消息好。
 * `unknown` 留给来源显式标注（例如目录探测失败）。
 */
export function classifyCommand(
  command: NativeCommand,
  gatewayNames: ReadonlySet<string>,
): NativeCommandForm {
  if (command.terminalOnly === true) return 'terminal';
  if (command.kind === 'client') return 'client';
  if (gatewayNames.has(command.name)) return 'gateway';
  if (command.source === 'extension' || command.source === 'prompt') return 'cli';
  if (command.builtin === true) return 'cli';
  if (command.path) return 'cli';
  return 'cli';
}

/** 深拷贝并统一补形态；`actualVersion` 给出时顺带算 verified。 */
export function applyForms(
  commands: NativeCommand[],
  gatewayNames: ReadonlySet<string>,
  provider: PinnableProvider,
  actualVersion?: string,
): NativeCommand[] {
  return commands.map((c) => withForm({ ...c }, classifyCommand(c, gatewayNames), provider, actualVersion));
}

// ---------------------------------------------------------------------------
// client 命令:web UI 本地动作(前端 handleCommand 已能实现)
// ---------------------------------------------------------------------------

const CLIENT_COMMANDS: NativeCommand[] = [
  { name: 'new', description: 'New session', kind: 'client' },
  { name: 'clear', description: 'Clear conversation and start a new session', kind: 'client' },
  { name: 'model', description: 'Switch model', kind: 'client' },
];

export function clientCommands(): NativeCommand[] {
  return CLIENT_COMMANDS.map((c) => ({ ...c }));
}

export interface SkillCommandInput {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  path?: string;
  scope?: string;
}

// ---------------------------------------------------------------------------
// codex 网关代执行命令:目录展示为 prompt 型(留在输入框等参数/直接发送),
// gateway 在 submitPrompt 拦截名字,映射到 app-server RPC。
// ---------------------------------------------------------------------------

export interface CodexGatewayCommand extends NativeCommand {
  /** 是否接收命令后的参数文本(对齐 acceptsInput)。 */
  takesArgs: boolean;
}

const CODEX_GATEWAY_COMMANDS: CodexGatewayCommand[] = [
  { name: 'compact', description: 'Summarize the conversation to free up context', kind: 'prompt', takesArgs: false },
  { name: 'fork', description: 'Fork this thread into a new session', kind: 'prompt', takesArgs: false },
  { name: 'undo', description: 'Roll back the last turn', kind: 'prompt', takesArgs: false },
  {
    name: 'review',
    description: 'Review uncommitted changes, a branch/commit, or custom instructions',
    kind: 'prompt',
    takesArgs: true,
    argumentHint: '[instructions | --base <branch> | --commit <sha>]',
  },
  {
    name: 'goal',
    description: 'Set, check, pause, resume, or clear a session goal',
    kind: 'prompt',
    takesArgs: true,
    argumentHint: '<objective> | status | pause | resume | clear',
  },
  { name: 'diff', description: 'Show git diff against remote tracking branch or working tree', kind: 'prompt', takesArgs: false },
  { name: 'status', description: 'Show session model, effort, rate limits and context usage', kind: 'prompt', takesArgs: false },
  { name: 'usage', description: 'Show token usage and quota summary for this session', kind: 'prompt', takesArgs: false },
  { name: 'mcp', description: 'List MCP servers and their status', kind: 'prompt', takesArgs: false },
  { name: 'terminals', description: 'List active background terminals in this thread', kind: 'prompt', takesArgs: false },
  { name: 'terminals-clean', description: 'Clean up background terminals in this thread', kind: 'prompt', takesArgs: false },
  { name: 'skills', description: 'List available skills for this workspace', kind: 'prompt', takesArgs: false },
  { name: 'help', description: 'Show available Web UI commands for Codex', kind: 'prompt', takesArgs: false },
];

/** codex 网关代执行命令的名字集合(gateway 拦截用)。 */
export function codexGatewayCommandNames(): Set<string> {
  return new Set(CODEX_GATEWAY_COMMANDS.map((c) => c.name));
}

/** codex 完整命令目录:client + 网关代执行 + skills(由 facade 传入)。 */
export function listCodexCommands(
  skills: SkillCommandInput[] = [],
): NativeCommand[] {
  const out: NativeCommand[] = [
    ...clientCommands(),
    ...CODEX_GATEWAY_COMMANDS.map(({ takesArgs, ...c }) => ({
      ...c,
      acceptsInput: takesArgs,
    })),
  ];
  const seen = new Set(out.map((c) => c.name));
  for (const s of skills) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({
      name: s.name,
      description: s.description,
      kind: 'prompt',
      acceptsInput: true,
      ...(s.argumentHint ? { argumentHint: s.argumentHint } : {}),
      ...(s.aliases && s.aliases.length > 0 ? { aliases: [...s.aliases] } : {}),
      ...(s.path ? { path: s.path } : {}),
      ...(s.scope ? { scope: s.scope } : {}),
    });
  }
  return applyForms(out, codexGatewayCommandNames(), 'codex');
}

function tokenizeSkillArgs(argText: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  for (;;) {
    const match = re.exec(argText);
    if (!match) break;
    if (match[1] !== undefined) tokens.push(match[1].replace(/\\(["\\])/g, '$1'));
    else if (match[2] !== undefined) tokens.push(match[2].replace(/\\(['\\])/g, '$1'));
    else if (match[3] !== undefined) tokens.push(match[3]);
  }
  return tokens;
}

/**
 * skill 展开:"/name args" 命中 skills 时读 SKILL.md 正文(去 frontmatter),
 * 单趟函数替换 $ARGUMENTS(保留换行与全文)、$ARGUMENTS[N] 与位置参数 $0/$1..$N(按 shell 引号分词):
 * - 若正文显式使用 $0 或 $ARGUMENTS[N],按 Claude SKILL.md 零基索引;
 * - 否则 $1..$N 按一基索引(兼容 .claude/commands 与 Pi Prompt Template);
 * - 支持 \$ 反转义保留字面量 $;两者都没有时把参数追加到末尾。未命中返回 null。
 */
function expandSkillMarkdown(
  text: string,
  skills: Array<{ name: string; path: string }>,
): string | null {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const [, name, args] = m;
  const hit = skills.find((s) => s.name === name);
  if (!hit) return null;
  let body: string;
  try {
    const st = fs.statSync(hit.path);
    if (!st.isFile() || st.size > 512 * 1024) return null;
    body = fs.readFileSync(hit.path, 'utf8');
  } catch {
    return null;
  }
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body);
  if (fm) body = body.slice(fm[0].length);
  body = body.trim();
  const argText = args.trim();
  const tokenRe = /(?<!\$)(\\)?(?:\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)\b)/g;
  const zeroIndexed = /(?<!\$)(?<!\\)(?:\$0\b|\$ARGUMENTS\[\d+\])/.test(body);
  let hasUnescapedPlaceholder = false;
  for (const match of body.matchAll(tokenRe)) {
    if (!match[1]) {
      hasUnescapedPlaceholder = true;
      break;
    }
  }
  const tokens = hasUnescapedPlaceholder && argText ? tokenizeSkillArgs(argText) : [];
  const replaced = body.replace(tokenRe, (full, bs?: string, bracketIdx?: string, numIdx?: string) => {
    if (bs) return full.slice(1);
    if (bracketIdx !== undefined) {
      const idx = Number(bracketIdx);
      return idx >= 0 && idx < tokens.length ? tokens[idx]! : full;
    }
    if (numIdx === undefined) return argText;
    const rawNum = Number(numIdx);
    const idx = zeroIndexed ? rawNum : rawNum - 1;
    if (!zeroIndexed && rawNum === 0) return full;
    return idx >= 0 && idx < tokens.length ? tokens[idx]! : full;
  });
  if (hasUnescapedPlaceholder) return replaced;
  return argText ? `${replaced}\n\n${argText}` : replaced;
}

/**
 * codex skill 展开:"/name args" 命中 skills 时读 SKILL.md 正文(去
 * frontmatter),$ARGUMENTS 替换为参数文本;没有 $ARGUMENTS 时参数追加到
 * 末尾(与 claude 命令展开语义一致)。未命中返回 null(原样发送)。
 */
export function expandCodexSkill(
  text: string,
  skills: Array<{ name: string; path: string }>,
): string | null {
  return expandSkillMarkdown(text, skills);
}

// ---------------------------------------------------------------------------
// grok 网关代执行命令 + Grok 1.0.77 原生 ACP 命令
// ---------------------------------------------------------------------------

export interface GrokGatewayCommand extends NativeCommand {
  takesArgs: boolean;
}

const GROK_GATEWAY_COMMANDS: GrokGatewayCommand[] = [
  { name: 'compact', description: 'Compress conversation history to save context window', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'fork', description: 'Fork this session into a new session', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'undo', description: 'Roll back the last turn', kind: 'prompt', takesArgs: false, aliases: ['rewind'], builtin: true },
  {
    name: 'thinking',
    description: 'Show or set thinking level (off|minimal|low|medium|high|xhigh)',
    kind: 'prompt',
    takesArgs: true,
    argumentHint: '[level]',
    aliases: ['effort'],
    builtin: true,
  },
  { name: 'usage', description: 'Show token usage for this session', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'diff', description: 'Show git diff for uncommitted changes in this workspace', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'skills', description: 'List available Grok skills in this workspace', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'help', description: 'Show available Web UI commands for Grok', kind: 'prompt', takesArgs: false, builtin: true },
];

const GROK_NATIVE_COMMANDS: GrokGatewayCommand[] = [
  {
    name: 'always-approve',
    description: 'Toggle always-approve mode (skip all permission prompts)',
    kind: 'prompt',
    takesArgs: true,
    argumentHint: '[on|off]',
    builtin: true,
  },
  {
    name: 'context',
    description: 'Show context window usage and session stats',
    kind: 'prompt',
    takesArgs: false,
    builtin: true,
  },
  {
    name: 'session-info',
    description: 'Show session details (model, turns, context usage)',
    kind: 'prompt',
    takesArgs: false,
    aliases: ['status', 'info'],
    builtin: true,
  },
  {
    name: 'deep-research',
    description: 'Research with bounded parallel agents, cross-check evidence, and write a cited report',
    kind: 'prompt',
    takesArgs: true,
    argumentHint: '<query>',
    builtin: true,
  },
  {
    name: 'workflow',
    description: 'Launch a saved workflow, list runs, or manage a run (pause, resume, stop, save)',
    kind: 'prompt',
    takesArgs: true,
    argumentHint: '<name> [--agent-budget N] [--effort LEVEL] [args] | runs | pause|resume|stop|save [name]',
    builtin: true,
  },
  {
    name: 'goal',
    description: 'Set, manage, or check an autonomous goal',
    kind: 'prompt',
    takesArgs: true,
    argumentHint: '<objective> [--budget <tokens>] | status | pause | resume | clear',
    builtin: true,
  },
];

const GROK_TUI_ONLY_UNSUPPORTED = new Set(['feedback', 'loop']);

/** grok 网关代执行/别名拦截命令的名字集合(gateway submitPrompt 拦截用)。 */
export function grokGatewayCommandNames(): Set<string> {
  return new Set([
    ...GROK_GATEWAY_COMMANDS.map((c) => c.name),
    'session-info',
    'status',
    'info',
    'always-approve',
    'thinking',
    'effort',
  ]);
}

/** Grok 1.0.77 仅在交互 TUI Shell 中存在、ACP 不支持的命令。 */
export function grokUnsupportedTuiCommandNames(): Set<string> {
  return new Set(GROK_TUI_ONLY_UNSUPPORTED);
}

/** Grok 1.0.77 原生可用命令名集合(含 compact 与 ACP 原生指令)。 */
export function grokNativeCommandNames(): Set<string> {
  return new Set(['compact', ...GROK_NATIVE_COMMANDS.map((c) => c.name)]);
}

export interface GrokNativeCommandInput {
  name: string;
  description?: string;
  input?: { hint?: string | null } | null;
  argumentHint?: string;
  aliases?: string[];
  source?: string;
  path?: string;
  scope?: string;
}

/** grok 完整命令目录:client + 网关代执行 + Grok 1.0.77 原生命令 + 磁盘 skills。 */
export function listGrokCommands(
  skills: SkillCommandInput[] = [],
  nativeCommands: GrokNativeCommandInput[] = [],
): NativeCommand[] {
  const byName = new Map<string, NativeCommand>();
  for (const c of clientCommands()) {
    byName.set(c.name, c);
  }
  for (const { takesArgs, ...c } of GROK_GATEWAY_COMMANDS) {
    byName.set(c.name, { ...c, acceptsInput: takesArgs });
  }
  for (const { takesArgs, ...c } of GROK_NATIVE_COMMANDS) {
    if (!byName.has(c.name)) {
      byName.set(c.name, { ...c, acceptsInput: takesArgs });
    }
  }
  const clientSkip = new Set(['new', 'clear', 'model']);
  for (const raw of nativeCommands) {
    if (!raw?.name || clientSkip.has(raw.name) || GROK_TUI_ONLY_UNSUPPORTED.has(raw.name)) continue;
    const hint = typeof raw.argumentHint === 'string'
      ? raw.argumentHint
      : typeof raw.input?.hint === 'string'
        ? raw.input.hint
        : '';
    const existing = byName.get(raw.name);
    const acceptsInput = hint.length > 0 || (raw.input !== null && raw.input !== undefined);
    byName.set(raw.name, {
      name: raw.name,
      description: raw.description || existing?.description || raw.name,
      kind: 'prompt',
      acceptsInput: acceptsInput || existing?.acceptsInput === true,
      builtin: true,
      ...(hint ? { argumentHint: hint } : existing?.argumentHint ? { argumentHint: existing.argumentHint } : {}),
      ...(raw.aliases && raw.aliases.length > 0
        ? { aliases: [...raw.aliases] }
        : existing?.aliases
          ? { aliases: [...existing.aliases] }
          : {}),
      ...(raw.source ? { source: raw.source } : existing?.source ? { source: existing.source } : {}),
      ...(raw.path ? { path: raw.path } : existing?.path ? { path: existing.path } : {}),
      ...(raw.scope ? { scope: raw.scope } : existing?.scope ? { scope: existing.scope } : {}),
    });
  }
  for (const s of skills) {
    if (byName.has(s.name)) continue;
    byName.set(s.name, {
      name: s.name,
      description: s.description,
      kind: 'prompt',
      acceptsInput: true,
      ...(s.argumentHint ? { argumentHint: s.argumentHint } : {}),
      ...(s.aliases && s.aliases.length > 0 ? { aliases: [...s.aliases] } : {}),
      ...(s.path ? { path: s.path } : {}),
      ...(s.scope ? { scope: s.scope } : {}),
    });
  }
  return applyForms([...byName.values()], grokGatewayCommandNames(), 'grok');
}

/**
 * grok skill 展开:与 expandCodexSkill 同语义(读 SKILL.md,$ARGUMENTS)。
 * "/compact" 等网关命令未命中 skills 时返回 null,由 gateway/adapter 处理。
 */
export function expandGrokSkill(
  text: string,
  skills: Array<{ name: string; path: string }>,
): string | null {
  return expandSkillMarkdown(text, skills);
}

// ---------------------------------------------------------------------------
// pi 网关代执行命令 + get_commands 原生目录(不含 /undo 与 TUI 独占内置命令)
// ---------------------------------------------------------------------------

export interface PiGatewayCommand extends NativeCommand {
  takesArgs: boolean;
}

const PI_GATEWAY_COMMANDS: PiGatewayCommand[] = [
  {
    name: 'compact',
    description: 'Compact the current context, optionally with custom instructions',
    kind: 'prompt',
    takesArgs: true,
    argumentHint: '[instructions]',
    builtin: true,
  },
  {
    name: 'auto-compact',
    description: 'Toggle or set automatic compaction (on|off)',
    kind: 'prompt',
    takesArgs: true,
    argumentHint: '[on|off]',
    builtin: true,
  },
  { name: 'clone', description: 'Clone this session into a new session', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'fork', description: 'Fork this session into a new session', kind: 'prompt', takesArgs: false, builtin: true },
  {
    name: 'name',
    description: 'Rename the current session',
    kind: 'prompt',
    takesArgs: true,
    argumentHint: '<title>',
    builtin: true,
  },
  {
    name: 'thinking',
    description: 'Show or set thinking level (off|minimal|low|medium|high|xhigh)',
    kind: 'prompt',
    takesArgs: true,
    argumentHint: '[level]',
    builtin: true,
  },
  { name: 'status', description: 'Show current session information and state', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'session', description: 'Show detailed session stats and context state', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'usage', description: 'Show token usage and cost for this session', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'copy', description: 'Show the last assistant reply for easy copying', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'tree', description: 'Show session message branch tree summary', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'diff', description: 'Show git diff for uncommitted changes in this workspace', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'skills', description: 'List available Pi skills and extension commands', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'help', description: 'Show available Web UI commands for Pi', kind: 'prompt', takesArgs: false, builtin: true },
];

/** Pi 仅在交互 TUI 中生效的内置命令 + 不支持的 /undo + 纯 TUI 扩展命令，RPC 路径禁止暴露/透传 LLM。 */
const PI_TUI_ONLY_OR_UNSUPPORTED = new Set([
  'undo',
  'settings',
  'hotkeys',
  'scoped-models',
  'login',
  'logout',
  'resume',
  'export',
  'share',
  'bug',
  'trust',
  'reload',
  'changelog',
  'quit',
  'exit',
  'import',
  'wtf',
  'wtf?',
  'wtf!',
  'fuck',
  'fuck?',
  'fuck!',
  'plannotator-review',
  'plannotator-annotate',
  'plannotator-last',
  'plannotator-inbox',
  'plannotator-reload',
  'pi-subagents-bridge',
]);

export interface PiNativeCommandInput {
  name: string;
  description?: string;
  source?: string;
  argumentHint?: string;
  aliases?: string[];
  sourceInfo?: {
    path?: string;
    scope?: string;
    source?: string;
    origin?: string;
    baseDir?: string;
  };
  path?: string;
  scope?: string;
}

/** pi 网关代执行命令的名字集合(含 alias rename 与 Web UI 拦截名)。 */
export function piGatewayCommandNames(): Set<string> {
  return new Set([...PI_GATEWAY_COMMANDS.map((c) => c.name), 'rename', 'settings']);
}

/** Pi RPC 模式下禁止暴露/透传给 LLM 的纯 TUI 或不支持命令。 */
export function piUnsupportedTuiCommandNames(): Set<string> {
  return new Set(PI_TUI_ONLY_OR_UNSUPPORTED);
}

/** pi 完整命令目录:client + 网关代执行 + `get_commands` 原生扩展/模板/skill 命令。 */
export function listPiCommands(
  nativeCommands: PiNativeCommandInput[] = [],
): NativeCommand[] {
  const out: NativeCommand[] = [
    ...clientCommands(),
    ...PI_GATEWAY_COMMANDS.map(({ takesArgs, ...c }) => ({
      ...c,
      acceptsInput: takesArgs,
    })),
  ];
  const seen = new Set(out.map((c) => c.name));
  for (const c of nativeCommands) {
    if (!c?.name || seen.has(c.name) || PI_TUI_ONLY_OR_UNSUPPORTED.has(c.name)) continue;
    seen.add(c.name);
    const hint = typeof c.argumentHint === 'string' ? c.argumentHint.trim() : '';
    const cmdPath = c.path ?? c.sourceInfo?.path;
    const scope = c.scope ?? c.sourceInfo?.scope;
    const source = c.source ?? c.sourceInfo?.source ?? (cmdPath ? (scope === 'project' ? 'project' : 'user') : 'extension');
    out.push({
      name: c.name,
      description: c.description || c.name,
      kind: 'prompt',
      acceptsInput: true,
      ...(hint ? { argumentHint: hint } : {}),
      ...(c.aliases && c.aliases.length > 0 ? { aliases: [...c.aliases] } : {}),
      ...(source ? { source } : {}),
      ...(cmdPath ? { path: cmdPath } : {}),
      ...(scope ? { scope } : {}),
    });
  }
  return applyForms(out, piGatewayCommandNames(), 'pi');
}

// ---------------------------------------------------------------------------
// claude 命令目录 + 零子进程有界磁盘命令/skill 发现
// ---------------------------------------------------------------------------

export interface ClaudeCatalogCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  builtin?: boolean;
  source?: string;
  path?: string;
  scope?: string;
  terminalOnly?: boolean;
  allowedTools?: string[];
  model?: string;
}

/** Claude Code 仅在本地终端界面生效的命令（Web UI 不可交互执行，会在菜单中过滤并在网关友好提示）。 */
const CLAUDE_TUI_ONLY_COMMANDS = new Set([
  'login',
  'logout',
  'resume',
  'rewind',
  'voice',
  'terminal-setup',
  'exit',
  'quit',
  'btw',
  'theme',
  'focus',
  'keybindings',
  'stickers',
  'ide',
  'mobile',
  'scroll-speed',
  'privacy-settings',
  'rate-limit-options',
  'remote-control',
  'remote-env',
  'teleport',
  'upgrade',
  'usage-credits',
  'web-setup',
  'install-github-app',
  'install-slack-app',
  'design-login',
  'desktop',
  'chrome',
  'feedback',
  'bug',
  'passes',
  'powerup',
  'artifacts',
  '__remote-workflow',
  'workflow-launch-exec',
  'heapdump',
  'fast',
]);

/** 网关为 Claude Web UI 补齐/适配的命令（原本 CLI 在 -p 模式提示不可用）。 */
const CLAUDE_GATEWAY_COMMANDS: Array<{
  name: string;
  description: string;
  takesArgs: boolean;
  argumentHint?: string;
}> = [
  { name: 'status', description: 'Show Claude session model, effort, permission and usage', takesArgs: false },
  { name: 'fork', description: 'Fork this session into a new session', takesArgs: false },
  { name: 'diff', description: 'Show git diff for uncommitted changes in this workspace', takesArgs: false },
  { name: 'skills', description: 'List available Claude commands and skills in this workspace', takesArgs: false },
  {
    name: 'permissions',
    description: 'Show or set permission mode (manual | auto | yolo)',
    takesArgs: true,
    argumentHint: '[manual|auto|yolo]',
  },
  { name: 'tasks', description: 'Show background tasks status for this session', takesArgs: false },
  {
    name: 'fast',
    description: 'Toggle fast mode (applies to the running session and future turns)',
    takesArgs: true,
    argumentHint: '[on|off]',
  },
  {
    name: 'color',
    description: 'Set the prompt bar color for this session',
    takesArgs: true,
    argumentHint: '[red|blue|green|yellow|purple|orange|pink|cyan|default]',
  },
  { name: 'help', description: 'Show available Web UI commands for Claude', takesArgs: false },
];

/** Claude 在网关层拦截代执行的 Web UI 适配命令集合。 */
export function claudeGatewayCommandNames(): Set<string> {
  return new Set(CLAUDE_GATEWAY_COMMANDS.map((c) => c.name));
}

/** Claude 在无头模式下无法交互执行、需在网关拦截提示的终端独占命令。 */
export function claudeUnsupportedTuiCommandNames(): Set<string> {
  return new Set(CLAUDE_TUI_ONLY_COMMANDS);
}

/**
 * claude 完整命令目录:client 命令 + CLI initialize 目录(或磁盘回退目录) + Web UI 网关适配命令。
 * 保留 aliases / argumentHint / terminalOnly 等元信息;剔除 client 独占的 model/new/clear。
 */
export function listClaudeCommands(
  cliCatalog: ClaudeCatalogCommand[],
  terminalSlashCommands: string[] = [],
): NativeCommand[] {
  const skip = new Set(['model', 'new', 'clear']);
  const terminalSlashSet = new Set<string>(terminalSlashCommands);
  const prompts: NativeCommand[] = cliCatalog
    .filter((c) => !skip.has(c.name))
    .map((c) => {
      let hint = typeof c.argumentHint === 'string' ? c.argumentHint.trim() : '';
      if (!hint && c.name === 'fast') hint = 'on|off';
      const aliases = Array.isArray(c.aliases)
        ? c.aliases.filter((a): a is string => typeof a === 'string' && a.length > 0)
        : undefined;
      const terminalOnly = c.terminalOnly === true
        || CLAUDE_TUI_ONLY_COMMANDS.has(c.name)
        || terminalSlashSet.has(c.name);
      return {
        name: c.name,
        description: c.description,
        kind: 'prompt' as const,
        acceptsInput: hint.length > 0,
        ...(hint ? { argumentHint: hint } : {}),
        ...(aliases && aliases.length > 0 ? { aliases } : {}),
        ...(c.builtin !== undefined ? { builtin: c.builtin } : {}),
        ...(c.source ? { source: c.source } : {}),
        ...(c.path ? { path: c.path } : {}),
        ...(c.scope ? { scope: c.scope } : {}),
        ...(terminalOnly ? { terminalOnly: true } : {}),
        ...(c.allowedTools && c.allowedTools.length > 0 ? { allowedTools: [...c.allowedTools] } : {}),
        ...(c.model ? { model: c.model } : {}),
      };
    });
  const seen = new Set([...skip, ...prompts.map((c) => c.name)]);
  for (const gw of CLAUDE_GATEWAY_COMMANDS) {
    if (seen.has(gw.name)) continue;
    seen.add(gw.name);
    prompts.push({
      name: gw.name,
      description: gw.description,
      kind: 'prompt',
      acceptsInput: gw.takesArgs,
      builtin: true,
      ...(gw.argumentHint ? { argumentHint: gw.argumentHint } : {}),
    });
  }
  return applyForms([...clientCommands(), ...prompts], claudeGatewayCommandNames(), 'claude');
}

export interface DiscoverClaudeDiskCommandsOptions {
  maxEntries?: number;
  maxDepth?: number;
  maxFileBytes?: number;
  homeDir?: string;
}

const DISK_SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'dist', '.next', 'target']);
const BOUNDED_OPEN_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_NONBLOCK ?? 0) |
  (fsConstants.O_NOFOLLOW ?? 0);

/**
 * 零子进程有界扫描 Claude 磁盘斜杠命令与 skills:
 * - `<cwd>/.claude/commands`、`~/.claude/commands` (`*.md`, 子目录映射 `sub:name`)
 * - `<cwd>/.claude/skills`、`<cwd>/.agents/skills`、`~/.claude/skills`、`~/.agents/skills` (`SKILL.md`)
 * 不派生 CLI 子进程,跳过 symlink/FIFO/超大文件,限制深度与总条目数。
 */
export async function discoverClaudeDiskCommands(
  cwd?: string,
  configDir?: string,
  options?: DiscoverClaudeDiskCommandsOptions,
): Promise<ClaudeCatalogCommand[]> {
  const home = options?.homeDir ?? os.homedir();
  const resolvedConfigDir = configDir || process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const maxEntries = Math.max(1, Math.min(2000, options?.maxEntries ?? 500));
  const maxDepth = Math.max(1, Math.min(8, options?.maxDepth ?? 4));
  const maxFileBytes = Math.max(1024, Math.min(512 * 1024, options?.maxFileBytes ?? 64 * 1024));

  const seenNames = new Set<string>();
  const out: ClaudeCatalogCommand[] = [];
  let scannedEntries = 0;

  const readBoundedText = async (filePath: string): Promise<string | null> => {
    let fh: fsp.FileHandle | undefined;
    try {
      const lst = await fsp.lstat(filePath);
      if (lst.isSymbolicLink() || !lst.isFile() || lst.size > maxFileBytes) return null;
      fh = await fsp.open(filePath, BOUNDED_OPEN_FLAGS);
      const st = await fh.stat();
      if (!st.isFile() || st.dev !== lst.dev || (process.platform !== 'win32' && st.ino !== lst.ino)) {
        return null;
      }
      if (st.size > maxFileBytes) return null;
      const buf = Buffer.alloc(st.size);
      let offset = 0;
      while (offset < st.size) {
        const { bytesRead } = await fh.read(buf, offset, st.size - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const slice = buf.subarray(0, offset);
      if (slice.includes(0)) return null;
      return slice.toString('utf8');
    } catch {
      return null;
    } finally {
      await fh?.close().catch(() => undefined);
    }
  };

  const scanRoot = async (
    rootDir: string,
    mode: 'command' | 'skill',
    scope: 'project' | 'user',
  ): Promise<void> => {
    const queue: Array<{ dir: string; relParts: string[]; depth: number }> = [
      { dir: rootDir, relParts: [], depth: 0 },
    ];
    while (queue.length > 0 && scannedEntries < maxEntries) {
      const { dir, relParts, depth } = queue.shift()!;
      let dirents: fs.Dirent[];
      try {
        const rootLst = await fsp.lstat(dir);
        if (rootLst.isSymbolicLink() && depth > 0) continue;
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of dirents) {
        if (scannedEntries >= maxEntries) break;
        scannedEntries += 1;
        if (entry.name.startsWith('.') || DISK_SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth + 1 < maxDepth) {
            queue.push({ dir: full, relParts: [...relParts, entry.name], depth: depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        if (mode === 'command') {
          if (!entry.name.toLowerCase().endsWith('.md')) continue;
          const raw = await readBoundedText(full);
          if (raw === null) continue;
          const parsed = parseCommandMarkdown(raw);
          if (parsed.userInvocable === false) continue;
          const baseName = entry.name.slice(0, -3);
          const defaultName = [...relParts, baseName].join(':');
          const name = parsed.name || defaultName;
          if (!name || seenNames.has(name)) continue;
          seenNames.add(name);
          out.push({
            name,
            description: parsed.description || name,
            argumentHint: parsed.argumentHint,
            ...(parsed.aliases.length > 0 ? { aliases: parsed.aliases } : {}),
            ...(parsed.allowedTools.length > 0 ? { allowedTools: parsed.allowedTools } : {}),
            ...(parsed.model ? { model: parsed.model } : {}),
            source: 'command',
            path: full,
            scope,
          });
        } else {
          if (entry.name !== 'SKILL.md' || relParts.length === 0) continue;
          const raw = await readBoundedText(full);
          if (raw === null) continue;
          const parsed = parseCommandMarkdown(raw);
          if (parsed.userInvocable === false) continue;
          const defaultName = relParts[relParts.length - 1];
          const name = parsed.name || defaultName;
          if (!name || seenNames.has(name)) continue;
          seenNames.add(name);
          out.push({
            name,
            description: parsed.description || name,
            argumentHint: parsed.argumentHint,
            ...(parsed.aliases.length > 0 ? { aliases: parsed.aliases } : {}),
            ...(parsed.allowedTools.length > 0 ? { allowedTools: parsed.allowedTools } : {}),
            ...(parsed.model ? { model: parsed.model } : {}),
            source: 'skill',
            path: full,
            scope,
          });
        }
      }
    }
  };

  if (cwd) {
    await scanRoot(path.join(cwd, '.claude', 'commands'), 'command', 'project');
    await scanRoot(path.join(cwd, '.claude', 'skills'), 'skill', 'project');
    await scanRoot(path.join(cwd, '.agents', 'skills'), 'skill', 'project');
  }
  await scanRoot(path.join(resolvedConfigDir, 'commands'), 'command', 'user');
  await scanRoot(path.join(resolvedConfigDir, 'skills'), 'skill', 'user');
  await scanRoot(path.join(home, '.agents', 'skills'), 'skill', 'user');

  return out;
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseAliasesValue(raw: string): string[] {
  const trimmed = raw.trim();
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  return inner
    .split(',')
    .map((part) => stripYamlQuotes(part).replace(/^\//, '').trim())
    .filter(Boolean);
}

function splitTopLevel(raw: string, delimiter: 'comma' | 'space'): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote && raw[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')' && depth > 0) depth -= 1;
    const isDelim = depth === 0 && (delimiter === 'comma' ? ch === ',' : /\s/.test(ch));
    if (isDelim) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseAllowedToolsValue(raw: string): string[] {
  const trimmed = raw.trim();
  const bracketed = trimmed.startsWith('[') && trimmed.endsWith(']');
  const inner = bracketed ? trimmed.slice(1, -1).trim() : trimmed;
  if (!inner) return [];
  const commaParts = splitTopLevel(inner, 'comma');
  const rawParts = !bracketed && commaParts.length <= 1
    ? splitTopLevel(inner, 'space')
    : commaParts;
  return rawParts
    .map((part) => stripYamlQuotes(part).trim())
    .filter(Boolean);
}

function parseCommandMarkdown(raw: string): {
  name?: string;
  description: string;
  argumentHint: string;
  aliases: string[];
  allowedTools: string[];
  model?: string;
  userInvocable?: boolean;
} {
  let name: string | undefined;
  let description = '';
  let argumentHint = '';
  const aliases: string[] = [];
  const allowedTools: string[] = [];
  let model: string | undefined;
  let userInvocable: boolean | undefined;
  let body = raw;

  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length);
    const lines = fm[1].split(/\r?\n/);
    let listKey: 'aliases' | 'allowedTools' | null = null;
    for (const line of lines) {
      if (listKey) {
        const item = /^\s*-\s+(.+)$/.exec(line);
        if (item) {
          const val = stripYamlQuotes(item[1]);
          if (listKey === 'aliases') {
            const cleaned = val.replace(/^\//, '').trim();
            if (cleaned) aliases.push(cleaned);
          } else if (val) {
            allowedTools.push(val);
          }
          continue;
        }
        if (line.trim() !== '') listKey = null;
      }
      const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const val = kv[2].trim();
      if (key === 'name' && val) name = stripYamlQuotes(val).replace(/^\//, '');
      else if (key === 'description' && val) description = stripYamlQuotes(val);
      else if ((key === 'argument-hint' || key === 'argumenthint') && val) argumentHint = stripYamlQuotes(val);
      else if (key === 'model' && val) model = stripYamlQuotes(val);
      else if (key === 'aliases') {
        if (!val) listKey = 'aliases';
        else aliases.push(...parseAliasesValue(val));
      } else if (key === 'allowed-tools' || key === 'allowedtools') {
        if (!val) listKey = 'allowedTools';
        else allowedTools.push(...parseAllowedToolsValue(val));
      } else if (key === 'user-invocable' || key === 'userinvocable') {
        const lower = stripYamlQuotes(val).toLowerCase();
        if (lower === 'false' || lower === 'no' || lower === 'off' || lower === '0') userInvocable = false;
        else if (lower === 'true' || lower === 'yes' || lower === 'on' || lower === '1') userInvocable = true;
      }
    }
  }

  if (!description) {
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      description = trimmed.replace(/^#+\s*/, '').trim();
      if (description) break;
    }
  }

  return { name, description, argumentHint, aliases, allowedTools, model, userInvocable };
}

// ---------------------------------------------------------------------------
// dsh 网关代执行命令与目录
// ---------------------------------------------------------------------------

export interface DshGatewayCommand extends NativeCommand {
  takesArgs: boolean;
}

const DSH_GATEWAY_COMMANDS: DshGatewayCommand[] = [
  { name: 'status', description: 'Show DSH session model, ACP channel limitations, and active plugins', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'diff', description: 'Show git diff for uncommitted changes in this workspace', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'skills', description: 'List active DSH plugins and bundles from ACP profile', kind: 'prompt', takesArgs: false, builtin: true },
  { name: 'help', description: 'Show available Web UI commands and DSH ACP channel capabilities', kind: 'prompt', takesArgs: false, builtin: true },
];

export function dshGatewayCommandNames(): Set<string> {
  return new Set(DSH_GATEWAY_COMMANDS.map((c) => c.name));
}

export function listDshCommands(
  skills: SkillCommandInput[] = [],
): NativeCommand[] {
  const out: NativeCommand[] = [
    ...clientCommands(),
    ...DSH_GATEWAY_COMMANDS.map(({ takesArgs, ...c }) => ({
      ...c,
      acceptsInput: takesArgs,
    })),
  ];
  const seen = new Set(out.map((c) => c.name));
  for (const s of skills) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({
      name: s.name,
      description: s.description,
      kind: 'prompt',
      acceptsInput: true,
      ...(s.argumentHint ? { argumentHint: s.argumentHint } : {}),
      ...(s.aliases && s.aliases.length > 0 ? { aliases: [...s.aliases] } : {}),
      ...(s.path ? { path: s.path } : {}),
      ...(s.scope ? { scope: s.scope } : {}),
    });
  }
  return applyForms(out, dshGatewayCommandNames(), 'dsh');
}

export function expandDshSkill(
  text: string,
  skills: Array<{ name: string; path: string }>,
): string | null {
  return expandSkillMarkdown(text, skills);
}
