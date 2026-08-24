/**
 * native-commands:claude / codex / grok 的原生斜杠命令目录与展开辅助。
 *
 * 三家机制截然不同(都已实测):
 * - claude:CLI 在 -p stream-json 模式下自己展开并执行 "/name args"
 *   (2.1.226 实测 /compact 产生 compacting 状态事件、/mcp 输出 synthetic
 *   消息),权威目录来自 initialize 握手回包(claude-adapter
 *   listSlashCommands)。网关不展开文本,只透传。
 * - codex:app-server 没有 slash 概念。目录 = web UI 本地 client 命令 +
 *   网关代执行命令(compact/fork/undo/review/status/usage/mcp,提交时由
 *   gateway 拦截,映射到 thread/compact/start 等 RPC)+ skills/list 的
 *   skill(选中后网关读 SKILL.md 正文展开成 prompt 再发,同 TUI 语义)。
 * - grok:ACP (`grok agent stdio`) 是主路径。目录 = client 命令 + 网关代
 *   执行命令(compact/fork/undo/usage)+ 磁盘 skills(.grok/.agents/
 *   ~/.grok/~/.claude)。skill 展开读 SKILL.md,与 codex 同语义。
 */

import * as fs from 'node:fs';
import type { NativeCommand } from './types.js';

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

// ---------------------------------------------------------------------------
// codex 网关代执行命令:目录展示为 prompt 型(留在输入框等参数/直接发送),
// gateway 在 submitPrompt 拦截名字,映射到 app-server RPC。
// ---------------------------------------------------------------------------

export interface CodexGatewayCommand extends NativeCommand {
  /** 是否需要附在命令后的参数文本(如 /status 不需要)。 */
  takesArgs: boolean;
}

const CODEX_GATEWAY_COMMANDS: CodexGatewayCommand[] = [
  { name: 'compact', description: 'Summarize the conversation to free up context', kind: 'prompt', takesArgs: false },
  { name: 'fork', description: 'Fork this thread into a new session', kind: 'prompt', takesArgs: false },
  { name: 'undo', description: 'Roll back the last turn', kind: 'prompt', takesArgs: false },
  { name: 'review', description: 'Review uncommitted changes (inline)', kind: 'prompt', takesArgs: false },
  { name: 'status', description: 'Show session model, effort and context usage', kind: 'prompt', takesArgs: false },
  { name: 'usage', description: 'Show token usage for this session', kind: 'prompt', takesArgs: false },
  { name: 'mcp', description: 'List MCP servers and their status', kind: 'prompt', takesArgs: false },
];

/** codex 网关代执行命令的名字集合(gateway 拦截用)。 */
export function codexGatewayCommandNames(): Set<string> {
  return new Set(CODEX_GATEWAY_COMMANDS.map((c) => c.name));
}

/** codex 完整命令目录:client + 网关代执行 + skills(由 facade 传入)。 */
export function listCodexCommands(
  skills: Array<{ name: string; description: string }> = [],
): NativeCommand[] {
  const out: NativeCommand[] = [
    ...clientCommands(),
    ...CODEX_GATEWAY_COMMANDS.map(({ takesArgs: _t, ...c }) => ({ ...c, acceptsInput: false })),
  ];
  const seen = new Set(out.map((c) => c.name));
  for (const s of skills) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({ name: s.name, description: s.description, kind: 'prompt', acceptsInput: true });
  }
  return out;
}

/**
 * skill 展开:"/name args" 命中 skills 时读 SKILL.md 正文(去
 * frontmatter),$ARGUMENTS 替换为参数文本;没有 $ARGUMENTS 时参数追加到
 * 末尾(与 claude 命令展开语义一致)。未命中返回 null(原样发送)。
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
    body = fs.readFileSync(hit.path, 'utf8');
  } catch {
    return null;
  }
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body);
  if (fm) body = body.slice(fm[0].length);
  body = body.trim();
  const argText = args.trim();
  if (body.includes('$ARGUMENTS')) return body.replaceAll('$ARGUMENTS', argText);
  return argText ? `${body}\n\n${argText}` : body;
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
// grok 网关代执行命令:ACP 上 compact/fork/rewind,用量来自 sessionUsage。
// ---------------------------------------------------------------------------

export interface GrokGatewayCommand extends NativeCommand {
  takesArgs: boolean;
}

const GROK_GATEWAY_COMMANDS: GrokGatewayCommand[] = [
  { name: 'compact', description: 'Summarize the conversation to free up context', kind: 'prompt', takesArgs: false },
  { name: 'fork', description: 'Fork this session into a new session', kind: 'prompt', takesArgs: false },
  { name: 'undo', description: 'Roll back the last turn', kind: 'prompt', takesArgs: false },
  { name: 'usage', description: 'Show token usage for this session', kind: 'prompt', takesArgs: false },
];

/** grok 网关代执行命令的名字集合。 */
export function grokGatewayCommandNames(): Set<string> {
  return new Set(GROK_GATEWAY_COMMANDS.map((c) => c.name));
}

/** grok 完整命令目录:client + 网关代执行 + 磁盘 skills。 */
export function listGrokCommands(
  skills: Array<{ name: string; description: string }> = [],
): NativeCommand[] {
  const out: NativeCommand[] = [
    ...clientCommands(),
    ...GROK_GATEWAY_COMMANDS.map(({ takesArgs: _t, ...c }) => ({ ...c, acceptsInput: false })),
  ];
  const seen = new Set(out.map((c) => c.name));
  for (const s of skills) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({ name: s.name, description: s.description, kind: 'prompt', acceptsInput: true });
  }
  return out;
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

/**
 * claude 完整命令目录:client 命令 + CLI initialize 目录(插件命令/skills/
 * 内置命令,由 claude-adapter 握手获取)。CLI 目录里的 model 剔除——前端
 * /model 是打开模型选择器的本地动作,不应作为文本发出去。
 */
export function listClaudeCommands(
  cliCatalog: Array<{ name: string; description: string; argumentHint: string }>,
): NativeCommand[] {
  const skip = new Set(['model', 'new', 'clear']);
  const prompts: NativeCommand[] = cliCatalog
    .filter((c) => !skip.has(c.name))
    .map((c) => ({
      name: c.name,
      description: c.description,
      kind: 'prompt' as const,
      acceptsInput: c.argumentHint.length > 0,
    }));
  return [...clientCommands(), ...prompts];
}
