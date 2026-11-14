/**
 * CodexAdapter — wraps `codex app-server` (Codex CLI 0.147.x–0.152.1, JSON-RPC over
 * newline-delimited stdio) behind a ProviderAdapter-shaped interface so the
 * gateway can treat Codex like any other provider.
 *
 * Protocol notes (verified against /home/ubuntu/temp/proto-recon/codex-schema):
 * - Handshake: client → {id, method:'initialize', params:{clientInfo,
 *   capabilities:{experimentalApi:true}}} → server result → client sends
 *   {method:'initialized'} notification.
 * - Messages have NO `jsonrpc:'2.0'` field. A message with both `id` and
 *   `method` is a server→client *request* (approvals, user-input) that must be
 *   answered with {id, result} / {id, error}. `{method, params}` is a
 *   notification; `{id, result|error}` is a response to a client request.
 * - Threads: thread/start | thread/list | thread/read(includeTurns) |
 *   thread/resume. Turns: turn/start({threadId, input:[{type:'text',text}]}),
 *   streaming via item/* and turn/* notifications, turn/interrupt to abort.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { z } from 'zod';
import { findCodexRollout } from './local-transcript.js';
import {
  ProviderError,
  type GranularApprovalDecision,
  type GranularApprovalDetails,
} from './types.js';

// ---------------------------------------------------------------------------
// Wire schemas (loose on purpose: unknown fields are kept via catchall so the
// adapter survives protocol additions; only the fields we rely on are typed).
// ---------------------------------------------------------------------------

const RequestIdSchema = z.union([z.string(), z.number()]);
export type CodexRequestId = z.infer<typeof RequestIdSchema>;

const ThreadItemSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    startedAtMs: z.number().nullish(),
    completedAtMs: z.number().nullish(),
  })
  .catchall(z.unknown());
export type CodexThreadItem = z.infer<typeof ThreadItemSchema>;

const TurnErrorSchema = z
  .object({
    message: z.string(),
    codexErrorInfo: z.unknown().nullish(),
    additionalDetails: z.string().nullish(),
    misalignment: z.unknown().nullish(),
  })
  .catchall(z.unknown());
export type CodexTurnError = z.infer<typeof TurnErrorSchema>;

const TurnSchema = z
  .object({
    id: z.string(),
    rootTurnId: z.string().nullish(),
    status: z.string(), // 'inProgress' | 'completed' | 'interrupted' | 'failed'
    itemsView: z.enum(['notLoaded', 'summary', 'full']).nullish(),
    error: TurnErrorSchema.nullish(),
    items: z.array(ThreadItemSchema).nullish(),
    startedAt: z.number().nullish(),
    completedAt: z.number().nullish(),
    durationMs: z.number().nullish(),
  })
  .catchall(z.unknown());
export type CodexTurn = z.infer<typeof TurnSchema>;

const ThreadSchema = z
  .object({
    id: z.string(),
    preview: z.string().nullish(),
    name: z.string().nullish(),
    cwd: z.string().nullish(),
    createdAt: z.number().nullish(),
    updatedAt: z.number().nullish(),
    recencyAt: z.number().nullish(),
    historyMode: z.enum(['legacy', 'paginated']).nullish(),
    modelProvider: z.string().nullish(),
    model: z.string().nullish(),
    reasoningEffort: z.string().nullish(),
    cliVersion: z.string().nullish(),
    status: z.unknown().nullish(),
    turns: z.array(TurnSchema).nullish(),
  })
  .catchall(z.unknown());
export type CodexThread = z.infer<typeof ThreadSchema>;

const ThreadStartResponseSchema = z
  .object({
    thread: ThreadSchema,
    model: z.string().nullish(),
    reasoningEffort: z.string().nullish(),
    serviceTier: z.string().nullish(),
  })
  .catchall(z.unknown());

const ThreadListResponseSchema = z.object({
  data: z.array(ThreadSchema),
  nextCursor: z.string().nullish(),
  backwardsCursor: z.string().nullish(),
});

const ThreadTurnsListResponseSchema = z.object({
  data: z.array(TurnSchema),
  nextCursor: z.string().nullish(),
  backwardsCursor: z.string().nullish(),
});

const ThreadItemEntrySchema = z
  .object({
    turnId: z.string().optional(),
    item: ThreadItemSchema.optional(),
    outputDeferred: z.boolean().nullish(),
    startedAtMs: z.number().nullish(),
    completedAtMs: z.number().nullish(),
  })
  .catchall(z.unknown());
export type CodexThreadItemEntry = {
  turnId: string;
  item: CodexThreadItem;
  outputDeferred?: boolean;
  startedAtMs: number | null;
  completedAtMs: number | null;
};

const ThreadItemsListResponseSchema = z.object({
  data: z.array(ThreadItemEntrySchema),
  nextCursor: z.string().nullish(),
  backwardsCursor: z.string().nullish(),
});

const ThreadReadResponseSchema = z.object({ thread: ThreadSchema });
const ThreadResumeResponseSchema = z
  .object({
    thread: ThreadSchema,
    model: z.string().nullish(),
    reasoningEffort: z.string().nullish(),
    serviceTier: z.string().nullish(),
  })
  .catchall(z.unknown());
const TurnStartResponseSchema = z.object({ turn: TurnSchema });
const ReviewStartResponseSchema = z
  .object({
    turn: TurnSchema.optional(),
    reviewThreadId: z.string().optional(),
  })
  .catchall(z.unknown());

const ItemRefSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
});

const ApprovalRequestParamsSchema = ItemRefSchema.extend({
  kind: z.string().nullish(),
  startedAtMs: z.number().nullish(),
  reason: z.string().nullish(),
  command: z.string().nullish(),
  cwd: z.string().nullish(),
  approvalId: z.string().nullish(),
  environmentId: z.string().nullish(),
  grantRoot: z.string().nullish(),
  commandActions: z.array(z.unknown()).nullish(),
  networkApprovalContext: z.unknown().nullish(),
  additionalPermissions: z.unknown().nullish(),
  proposedExecpolicyAmendment: z.unknown().nullish(),
  proposedNetworkPolicyAmendments: z.array(z.unknown()).nullish(),
  availableDecisions: z.array(z.unknown()).nullish(),
}).catchall(z.unknown());

const PermissionsApprovalRequestParamsSchema = ItemRefSchema.extend({
  startedAtMs: z.number().nullish(),
  environmentId: z.string().nullish(),
  cwd: z.string().nullish(),
  reason: z.string().nullish(),
  permissions: z.record(z.string(), z.unknown()).nullish(),
}).catchall(z.unknown());

const McpElicitationRequestParamsSchema = z
  .object({
    threadId: z.string(),
    turnId: z.string().nullish(),
    serverName: z.string(),
    environmentId: z.string().nullish(),
    mode: z.string(),
    message: z.string().nullish(),
    url: z.string().nullish(),
    elicitationId: z.string().nullish(),
    requestedSchema: z.unknown().nullish(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    challenge: z.string().nullish(),
    _meta: z.unknown().nullish(),
  })
  .catchall(z.unknown());

const LegacyPatchApprovalParamsSchema = z
  .object({
    conversationId: z.string().optional(),
    threadId: z.string().optional(),
    turnId: z.string().nullish(),
    callId: z.string().optional(),
    itemId: z.string().optional(),
    fileChanges: z.record(z.string(), z.unknown()).nullish(),
    reason: z.string().nullish(),
    grantRoot: z.string().nullish(),
  })
  .catchall(z.unknown());

const LegacyExecApprovalParamsSchema = z
  .object({
    conversationId: z.string().optional(),
    threadId: z.string().optional(),
    turnId: z.string().nullish(),
    callId: z.string().optional(),
    itemId: z.string().optional(),
    approvalId: z.string().nullish(),
    command: z.union([z.array(z.string()), z.string()]).nullish(),
    cwd: z.string().nullish(),
    reason: z.string().nullish(),
    parsedCmd: z.array(z.unknown()).nullish(),
  })
  .catchall(z.unknown());

const UserInputRequestParamsSchema = ItemRefSchema.extend({
  questions: z.array(z.unknown()),
  isBlocking: z.boolean().nullish(),
  autoResolutionMs: z.number().nullish(),
}).catchall(z.unknown());

const DynamicToolCallParamsSchema = z
  .object({
    threadId: z.string(),
    turnId: z.string(),
    callId: z.string(),
    namespace: z.string().nullish(),
    tool: z.string(),
    arguments: z.unknown().optional(),
  })
  .catchall(z.unknown());

// ---------------------------------------------------------------------------
// Text / Tag filtering & Item normalization helpers
// ---------------------------------------------------------------------------

const TARGET_SYSTEM_TAG_RE = /^<(INSTRUCTIONS|user_instructions|environment_context|turn_aborted)\b/i;
const TARGET_CITATION_TAG_RE = /^<oai-mem-citation\b/i;

function findOpeningTagEnd(text: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function findFencedBlockEnd(text: string, start: number): number {
  const len = text.length;
  let indent = start;
  while (indent < len && indent - start < 4 && (text[indent] === ' ' || text[indent] === '\t')) {
    indent++;
  }
  const ch = text[indent];
  if (ch !== '`' && ch !== '~') return -1;
  let fenceEnd = indent;
  while (fenceEnd < len && text[fenceEnd] === ch) fenceEnd++;
  const fenceLen = fenceEnd - indent;
  if (fenceLen < 3) return -1;
  const lineEnd = text.indexOf('\n', fenceEnd);
  if (lineEnd === -1) return len;
  let searchPos = lineEnd + 1;
  while (searchPos <= len) {
    let cIndent = searchPos;
    while (cIndent < len && cIndent - searchPos < 4 && (text[cIndent] === ' ' || text[cIndent] === '\t')) {
      cIndent++;
    }
    let cFence = cIndent;
    while (cFence < len && text[cFence] === ch) cFence++;
    if (cFence - cIndent >= fenceLen) {
      let trail = cFence;
      while (trail < len && (text[trail] === ' ' || text[trail] === '\t' || text[trail] === '\r')) {
        trail++;
      }
      if (trail === len || text[trail] === '\n') {
        return trail < len ? trail + 1 : trail;
      }
    }
    const nextNl = text.indexOf('\n', searchPos);
    if (nextNl === -1) break;
    searchPos = nextNl + 1;
  }
  return len;
}

function findInlineCodeSpanEnd(text: string, start: number): { tickCount: number; end: number } {
  const len = text.length;
  let tickEnd = start;
  while (tickEnd < len && text[tickEnd] === '`') tickEnd++;
  const tickCount = tickEnd - start;
  const needle = '`'.repeat(tickCount);
  let searchPos = tickEnd;
  while (searchPos < len) {
    const idx = text.indexOf(needle, searchPos);
    if (idx === -1) break;
    let after = idx + tickCount;
    while (after < len && text[after] === '`') after++;
    if ((idx === 0 || text[idx - 1] !== '`') && after - idx === tickCount) {
      return { tickCount, end: after };
    }
    searchPos = after;
  }
  return { tickCount, end: -1 };
}

function isLineLeadingWhitespace(text: string, pos: number): boolean {
  let k = pos - 1;
  while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--;
  return k < 0 || text[k] === '\n';
}

function stripTagsOutsideMarkdownCode(
  text: string,
  options: { systemTags: boolean; citations: boolean },
): string {
  if (!text) return text;
  const out: string[] = [];
  const lower = text.toLowerCase();
  const len = text.length;
  let i = 0;
  let copyFrom = 0;

  while (i < len) {
    const atLineStart = i === 0 || text[i - 1] === '\n';
    if (atLineStart) {
      const fenceEnd = findFencedBlockEnd(text, i);
      if (fenceEnd !== -1) {
        i = fenceEnd;
        continue;
      }
    }

    if (text[i] === '`') {
      const span = findInlineCodeSpanEnd(text, i);
      if (span.end !== -1) {
        i = span.end;
      } else {
        i += span.tickCount;
      }
      continue;
    }

    if (text[i] === '<') {
      const tail = text.slice(i);
      const citeMatch = options.citations ? TARGET_CITATION_TAG_RE.exec(tail) : null;
      const sysMatch = !citeMatch && options.systemTags ? TARGET_SYSTEM_TAG_RE.exec(tail) : null;
      const tagName = citeMatch ? 'oai-mem-citation' : sysMatch ? sysMatch[1] : null;
      if (tagName) {
        const gt = findOpeningTagEnd(text, i + 1);
        if (gt !== -1) {
          if (text[gt - 1] === '/') {
            if (i > copyFrom) out.push(text.slice(copyFrom, i));
            i = gt + 1;
            copyFrom = i;
            continue;
          }
          const closeToken = `</${tagName.toLowerCase()}>`;
          const closeIdx = lower.indexOf(closeToken, gt + 1);
          if (closeIdx !== -1) {
            if (i > copyFrom) out.push(text.slice(copyFrom, i));
            i = closeIdx + closeToken.length;
            copyFrom = i;
            continue;
          }
          if (sysMatch) {
            if (tagName.toLowerCase() === 'turn_aborted') {
              if (i > copyFrom) out.push(text.slice(copyFrom, i));
              i = gt + 1;
              copyFrom = i;
              continue;
            }
            if (isLineLeadingWhitespace(text, i)) {
              if (i > copyFrom) out.push(text.slice(copyFrom, i));
              return out.join('');
            }
          }
        }
      }
    }

    i++;
  }

  if (copyFrom === 0) return text;
  if (copyFrom < len) out.push(text.slice(copyFrom));
  return out.join('');
}

/** Strip `<oai-mem-citation>` blocks outside markdown code spans/fences. */
export function stripCodexMemoryCitations(text: string): string {
  if (!text || !/oai-mem-citation/i.test(text)) return text;
  return stripTagsOutsideMarkdownCode(text, { systemTags: false, citations: true });
}

/**
 * Strip Codex system-injected blocks (`<INSTRUCTIONS>`, `<environment_context>`,
 * `<turn_aborted>`) and `<oai-mem-citation>` outside markdown code spans/fences.
 */
export function stripCodexSystemTags(text: string): string {
  if (!text || !text.includes('<')) return text;
  return stripTagsOutsideMarkdownCode(text, { systemTags: true, citations: true });
}

/** Extract reasoning summary text from either `string[]` (0.169.0) or `{text}[]` (legacy). */
export function extractCodexReasoningSummary(item: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(item.summary)) {
    for (const entry of item.summary) {
      if (typeof entry === 'string') {
        if (entry.trim()) parts.push(entry);
      } else if (entry && typeof entry === 'object' && typeof (entry as { text?: unknown }).text === 'string') {
        const t = ((entry as { text: string }).text).trim();
        if (t) parts.push((entry as { text: string }).text);
      }
    }
  }
  if (parts.length === 0 && Array.isArray(item.content)) {
    for (const entry of item.content) {
      if (typeof entry === 'string' && entry.trim()) {
        parts.push(entry);
      } else if (entry && typeof entry === 'object' && typeof (entry as { text?: unknown }).text === 'string') {
        const t = ((entry as { text: string }).text).trim();
        if (t) parts.push((entry as { text: string }).text);
      }
    }
  }
  return stripCodexMemoryCitations(parts.join('\n').trim());
}

/**
 * Normalize and sanitize a Codex ThreadItem for 0.169.0 / 0.171.0-alpha.5.
 * Returns `null` if a `userMessage` item contained only system-injected tags
 * (`<INSTRUCTIONS>`, `<environment_context>`, `<turn_aborted>`) and is now empty.
 */
export function normalizeCodexThreadItem(rawItem: CodexThreadItem): CodexThreadItem | null {
  const item: Record<string, unknown> = { ...rawItem };
  if (item.createdAt === undefined) {
    if (typeof item.startedAtMs === 'number') item.createdAt = item.startedAtMs;
    else if (typeof item.completedAtMs === 'number') item.createdAt = item.completedAtMs;
  }

  switch (item.type) {
    case 'userMessage': {
      let hasNonTextInput = false;
      const cleanedTexts: string[] = [];
      if (Array.isArray(item.content)) {
        const nextContent: unknown[] = [];
        for (const part of item.content as Array<Record<string, unknown>>) {
          if (part && typeof part === 'object' && (part.type === 'text' || typeof part.text === 'string')) {
            const rawText = typeof part.text === 'string' ? part.text : '';
            const cleaned = stripCodexSystemTags(rawText).trim();
            if (cleaned) {
              nextContent.push({ ...part, text: cleaned });
              cleanedTexts.push(cleaned);
            }
          } else if (part && typeof part === 'object') {
            hasNonTextInput = true;
            nextContent.push(part);
          }
        }
        item.content = nextContent;
      }
      if (typeof item.text === 'string') {
        const cleaned = stripCodexSystemTags(item.text).trim();
        item.text = cleaned;
        if (cleaned && cleanedTexts.length === 0) cleanedTexts.push(cleaned);
      }
      if (cleanedTexts.length === 0 && !hasNonTextInput) {
        return null;
      }
      break;
    }
    case 'agentMessage': {
      if (typeof item.text === 'string') {
        item.text = stripCodexSystemTags(item.text);
      }
      break;
    }
    case 'reasoning': {
      const summaryStrings: string[] = [];
      if (Array.isArray(item.summary)) {
        for (const s of item.summary) {
          if (typeof s === 'string') {
            const cleaned = stripCodexMemoryCitations(s);
            if (cleaned.trim()) summaryStrings.push(cleaned);
          } else if (s && typeof s === 'object' && typeof (s as { text?: unknown }).text === 'string') {
            const cleaned = stripCodexMemoryCitations((s as { text: string }).text);
            if (cleaned.trim()) summaryStrings.push(cleaned);
          }
        }
      }
      const summaryText = summaryStrings.join('\n').trim() || extractCodexReasoningSummary(item);
      item.summaryStrings = summaryStrings;
      item.summaryText = summaryText;
      // Normalize `.summary` entries to plain strings (0.169.0 schema: `string[]`).
      if (Array.isArray(item.summary)) {
        item.summary = item.summary.map((s) => {
          if (typeof s === 'string') return stripCodexMemoryCitations(s);
          if (s && typeof s === 'object' && typeof (s as { text?: unknown }).text === 'string') {
            return stripCodexMemoryCitations((s as { text: string }).text);
          }
          return s;
        });
      }
      break;
    }
    case 'collabAgentToolCall':
    case 'collabToolCall': {
      const toolName =
        typeof item.name === 'string' && item.name
          ? item.name
          : typeof item.tool === 'string' && item.tool
            ? item.tool
            : 'collabAgentToolCall';
      item.name = toolName;
      if (item.input === undefined) {
        item.input = {
          tool: item.tool ?? toolName,
          prompt: item.prompt ?? null,
          senderThreadId: item.senderThreadId ?? null,
          receiverThreadIds: Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [],
          model: item.model ?? null,
          reasoningEffort: item.reasoningEffort ?? null,
        };
      }
      if (
        item.output === undefined &&
        item.result === undefined &&
        item.aggregatedOutput === undefined &&
        (item.status === 'completed' || item.status === 'failed') &&
        item.agentsStates &&
        typeof item.agentsStates === 'object'
      ) {
        item.result = JSON.stringify(item.agentsStates);
      }
      break;
    }
    case 'subAgentActivity': {
      if (typeof item.agentThreadId === 'string' && !item.agentId) {
        item.agentId = item.agentThreadId;
      }
      break;
    }
    case 'plan': {
      if (typeof item.text === 'string') {
        item.text = stripCodexMemoryCitations(item.text);
      }
      break;
    }
    case 'enteredReviewMode':
    case 'exitedReviewMode': {
      if (typeof item.review === 'string' && item.text === undefined) {
        item.text = stripCodexMemoryCitations(item.review);
      }
      break;
    }
    default:
      break;
  }

  return item as CodexThreadItem;
}

// ---------------------------------------------------------------------------
// Public event surface.
// ---------------------------------------------------------------------------

export type ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | 'approve'
  | 'approve_always'
  | 'reject'
  | 'accept_with_execpolicy_amendment'
  | 'apply_network_policy_amendment'
  | 'accept_with_permissions'
  | 'accept_elicitation'
  | 'decline_elicitation'
  | Record<string, unknown>; // e.g. {acceptWithExecpolicyAmendment:{...}}

export type CodexApprovalKind =
  | 'commandExecution'
  | 'fileChange'
  | 'permissions'
  | 'mcpElicitation';

export type CodexEvent =
  | { type: 'connected' }
  | { type: 'disconnected'; code: number | null; signal: string | null }
  | { type: 'log'; line: string }
  | { type: 'thread-started'; thread: CodexThread }
  | { type: 'thread-reverted'; threadId: string; beforeTurnId?: string }
  | { type: 'thread-compacted'; threadId: string; turnId?: string }
  | { type: 'skills-changed' }
  | { type: 'turn-started'; threadId: string; turnId: string; turn: CodexTurn }
  | { type: 'text-delta'; threadId: string; turnId: string; itemId: string; delta: string }
  | {
      type: 'reasoning-delta';
      threadId: string;
      turnId: string;
      itemId: string;
      contentIndex: number;
      summaryIndex?: number;
      delta: string;
    }
  | { type: 'command-output-delta'; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: 'plan-delta'; threadId: string; turnId: string; itemId: string; delta: string }
  | {
      type: 'plan-updated';
      threadId: string;
      turnId: string;
      explanation: string | null;
      plan: Array<{ step: string; status: string }>;
    }
  | { type: 'diff-updated'; threadId: string; turnId: string; diff: string }
  | { type: 'item-started'; threadId: string; turnId: string; item: CodexThreadItem }
  | { type: 'item-completed'; threadId: string; turnId: string; item: CodexThreadItem }
  | {
      type: 'turn-completed';
      threadId: string;
      turnId: string;
      turn: CodexTurn;
      error?: string;
      turnError?: CodexTurnError | null;
    }
  | {
      type: 'approval-request';
      requestId: CodexRequestId;
      method?: string;
      kind: CodexApprovalKind;
      approvalKind?: string;
      approvalId?: string;
      threadId: string;
      turnId: string;
      itemId: string;
      command?: string;
      cwd?: string;
      reason?: string;
      grantRoot?: string;
      availableDecisions?: unknown[];
      commandActions?: unknown[];
      networkApprovalContext?: unknown;
      additionalPermissions?: unknown;
      permissions?: Record<string, unknown>;
      proposedExecpolicyAmendment?: unknown;
      proposedNetworkPolicyAmendments?: unknown[];
      elicitation?: {
        serverName: string;
        mode: string;
        environmentId?: string | null;
        message?: string;
        url?: string;
        elicitationId?: string;
        requestedSchema?: unknown;
        title?: string;
        description?: string;
        challenge?: string;
        _meta?: unknown;
      };
      params: Record<string, unknown>;
    }
  | {
      type: 'question-request';
      requestId: CodexRequestId;
      threadId: string;
      turnId: string;
      itemId: string;
      questions: unknown[];
      isBlocking?: boolean;
      autoResolutionMs?: number | null;
      params: Record<string, unknown>;
    }
  | {
      type: 'server-request';
      requestId: CodexRequestId;
      method: string;
      threadId?: string;
      turnId?: string;
      params: unknown;
      handled?: boolean;
    }
  | {
      type: 'server-request-resolved';
      threadId: string;
      turnId?: string;
      requestId: CodexRequestId;
      interactionKind?: 'approval' | 'question' | 'elicitation' | 'permissions';
    }
  /** thread/tokenUsage/updated(0.147.0–0.169.0):last=本 turn,total=累计。 */
  | {
      type: 'token-usage';
      threadId: string;
      turnId: string;
      usage: {
        last: Record<string, unknown>;
        total: Record<string, unknown>;
        modelContextWindow: number | null;
        reasoningOutputTokens?: number;
      };
    }
  /** thread/goal/updated & thread/goal/cleared:set/clear 后广播(goal 为 null = 已清除)。 */
  | { type: 'goal-updated'; threadId: string; goal: Record<string, unknown> | null; cleared?: boolean }
  /** thread/archived / thread/unarchived。 */
  | { type: 'thread-archived-changed'; threadId: string; archived: boolean }
  | { type: 'error'; message: string; threadId?: string; turnId?: string; willRetry?: boolean; raw?: unknown };

export type CodexEventHandler = (event: CodexEvent) => void;

export interface CodexAdapterOptions {
  /** Path to the codex binary. Defaults to $CODEX_PATH or 'codex' on PATH. */
  codexPath?: string;
  /** Extra CLI args after `app-server` (default stdio transport). */
  args?: string[];
  /** Environment overrides for the child process. */
  env?: NodeJS.ProcessEnv;
  /** clientInfo sent during initialize. */
  clientInfo?: { name: string; title?: string; version: string };
  /** Timeout for individual JSON-RPC requests (ms). Default 120_000. */
  requestTimeoutMs?: number;
  /**
   * Recycle the app-server after this much idle time (ms). thread/resume
   * acquires codex's single-writer lock and only process exit releases it;
   * without recycling, viewing a session in the web UI blocks `codex resume`
   * in the CLI until the gateway restarts. Default 60_000; 0 disables.
   */
  recycleGraceMs?: number;
  /**
   * When true, approval requests are answered immediately with 'accept' and
   * user-input questions with empty answers instead of being parked until
   * resolveApproval/resolveQuestion is called. Default false (park + emit).
   */
  autoApprove?: boolean;
  /** Called with each raw stderr line from the codex process. */
  onStderr?: (line: string) => void;
}

export type ThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'subAgent'
  | 'subAgentReview'
  | 'subAgentCompact'
  | 'subAgentThreadSpawn'
  | 'subAgentOther'
  | 'unknown';

export interface ThreadListOptions {
  cursor?: string;
  limit?: number;
  cwd?: string;
  archived?: boolean;
  searchTerm?: string;
  sourceKinds?: ThreadSourceKind[];
}

export interface ThreadTurnsListOptions {
  cursor?: string | null;
  limit?: number | null;
  sortDirection?: 'asc' | 'desc' | null;
  itemsView?: 'notLoaded' | 'summary' | 'full' | null;
}

export interface ThreadItemsListOptions {
  turnId?: string | null;
  cursor?: string | null;
  limit?: number | null;
  sortDirection?: 'asc' | 'desc' | null;
}

export interface ThreadStartOptions {
  cwd?: string;
  model?: string;
  serviceTier?: string | null;
  approvalPolicy?: 'untrusted' | 'on-request' | 'never' | Record<string, unknown>;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  permissions?: string | null;
  serviceName?: string;
  baseInstructions?: string;
  developerInstructions?: string;
  config?: Record<string, unknown>;
  ephemeral?: boolean;
  historyMode?: 'legacy' | 'paginated';
}

export interface TurnStartOptions {
  model?: string;
  effort?: string;
  serviceTier?: string | null;
  serviceTierForTurn?: string | null;
  summary?: string | null;
  cwd?: string;
  approvalPolicy?: 'untrusted' | 'on-request' | 'never' | Record<string, unknown>;
  sandboxPolicy?: Record<string, unknown>;
  permissions?: string | null;
  outputSchema?: Record<string, unknown> | null;
  collaborationMode?: Record<string, unknown> | null;
  clientUserMessageId?: string;
}

export type ReviewTargetOption =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title?: string | null }
  | { type: 'custom'; instructions: string };

export interface ReviewStartOptions {
  target?: ReviewTargetOption;
  delivery?: 'inline';
  instructions?: string;
}

export interface CodexTurnHandle {
  threadId: string;
  reviewThreadId?: string;
  turnId: string;
  turn?: CodexTurn;
  /** Events for this turn; ends after 'turn-completed' (or errors/close). */
  events: AsyncIterable<CodexEvent>;
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

interface PendingClientRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingServerRequest {
  /** 线上回包要用的原始 id(可能是数字);Map 键统一 String(id),防止
   * 数字 id 的 parked 请求在 resolve 时因键类型不匹配找不到(审查发现)。 */
  id: CodexRequestId;
  method: string;
  params: unknown;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  approvalId?: string;
  interactionKind?: 'approval' | 'question' | 'elicitation' | 'permissions';
}

class TurnEventQueue implements AsyncIterable<CodexEvent> {
  private buffer: CodexEvent[] = [];
  private waiter: {
    resolve: (r: IteratorResult<CodexEvent>) => void;
    reject: (err: Error) => void;
  } | null = null;
  private done = false;
  private failure: Error | null = null;

  push(event: CodexEvent): void {
    if (this.done) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve({ value: event, done: false });
    } else {
      this.buffer.push(event);
    }
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve({ value: undefined as unknown as CodexEvent, done: true });
    }
  }

  fail(err: Error): void {
    if (this.done) return;
    this.failure = err;
    this.done = true;
    // 有人在等下一帧时必须 reject,不能走 close() 的 done:true——
    // 否则 driveTurn 会把进程崩溃收成假成功。
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexEvent> {
    return {
      next: (): Promise<IteratorResult<CodexEvent>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.failure) return Promise.reject(this.failure);
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as CodexEvent, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// CodexAdapter
// ---------------------------------------------------------------------------

export class CodexAdapter {
  readonly provider = 'codex' as const;
  /** 未落盘线程的回收保护期:覆盖"新建会话→想一下→发首条消息"的正常间隔。 */
  private static readonly UNPERSISTED_PROTECT_MS = 15 * 60_000;

  private opts: Required<Pick<CodexAdapterOptions, 'requestTimeoutMs' | 'recycleGraceMs'>> & CodexAdapterOptions;
  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pendingClient = new Map<CodexRequestId, PendingClientRequest>();
  private pendingServer = new Map<string, PendingServerRequest>(); // 键统一 String(requestId)
  private listeners = new Set<CodexEventHandler>();
  private turnQueues = new Map<string, TurnEventQueue>(); // key: `${threadId}:${turnId}`
  // queue 注册前到达的 turn 事件缓冲:startTurn 的 queue 注册在 request 响应
  // 之后(多个微任务跳),app-server 同一 chunk 内"响应行之后"的通知在那之前
  // 就派发,直接路由会静默丢掉(turn/completed 丢失挂死消费方)。注册时按序
  // drain;永不注册的外部 turn 由 FIFO/单 key 上限兜底,内存有界。
  private pendingTurnEvents = new Map<string, CodexEvent[]>();
  private seenTurnStarts = new Set<string>(); // dedupe synthesized vs server turn-started
  /**
   * 本进程内已激活的 thread(thread/start|resume 过)。app-server 是有状态的:
   * 进程重启后内存里的 thread 全丢,turn/start 直打会以 "thread not found"
   * 失败(实测)——跨重启续聊必须先 thread/resume。
   */
  private liveThreads = new Set<string>();
  /** 线程启动/恢复时显式指定的模型(thread/settings/update 的 model 必填,要用它)。 */
  private threadModels = new Map<string, string>();
  private threadEfforts = new Map<string, string>();
  private threadServiceTiers = new Map<string, string | null>();
  private threadCwds = new Map<string, string>();
  private configModelCache: string | null = null;
  private skillsDirty = false;
  private skillsVersion = 0;
  private readyPromise: Promise<void> | null = null;
  private closed = false;
  private recycleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * thread/start 创建但未落盘的线程(codex 要等首个 turn 才写 rollout)及其
   * 创建时间。回收会杀掉 app-server,这类线程随之蒸发("no rollout found",
   * 且从会话列表消失)——保护期内禁止回收;首个 turn 后 rollout 出现,
   * recycleIfIdle 自查文件并移出。超过保护期(用户建了就走)放弃保护,
   * 否则一个废弃草稿线程会把回收永久钉死,CLI 锁又回不来。
   */
  private unpersistedThreads = new Map<string, number>();

  constructor(options: CodexAdapterOptions = {}) {
    this.opts = { requestTimeoutMs: 120_000, recycleGraceMs: 60_000, ...options };
  }

  // -- lifecycle ------------------------------------------------------------

  /** Spawn `codex app-server` and run the initialize handshake. Idempotent. */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('CodexAdapter is closed'));
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.doConnect().catch((err) => {
      this.readyPromise = null;
      throw err;
    });
    return this.readyPromise;
  }

  private async doConnect(): Promise<void> {
    const bin = this.opts.codexPath ?? process.env.CODEX_PATH ?? process.env.CODEX_BIN ?? 'codex';
    const args = ['app-server', ...(this.opts.args ?? [])];
    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^GATEWAY_/i.test(key)),
    );
    this.child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...inheritedEnv, ...(this.opts.env ?? {}) },
    });
    this.child.on('error', (err) => this.handleProcessExit(err));
    this.child.on('exit', (code, signal) => this.handleProcessExit(null, code, signal));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.opts.onStderr?.(line);
        this.emit({ type: 'log', line });
      }
    });
    this.rl = readline.createInterface({ input: this.child.stdout! });
    this.rl.on('line', (line) => this.handleLine(line));

    const initParams = {
      clientInfo: this.opts.clientInfo ?? {
        name: 'multi-agent-gateway',
        title: 'Multi Agent Gateway',
        version: '0.1.0',
      },
      capabilities: { experimentalApi: true },
    };
    await this.request('initialize', initParams);
    this.notify('initialized', {});
    this.emit({ type: 'connected' });
  }

  /** Terminate the app-server process and fail all pending state. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.recycleTimer) {
      clearTimeout(this.recycleTimer);
      this.recycleTimer = null;
    }
    this.rl?.close();
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
          res();
        }, 3_000);
        child.once('exit', () => {
          clearTimeout(t);
          res();
        });
      });
    }
    this.handleProcessExit(null, child?.exitCode ?? null, null);
  }

  // -- event subscription ----------------------------------------------------

  /** Subscribe to every adapter event. Returns an unsubscribe function. */
  onEvent(handler: CodexEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  private findActiveTurnId(threadId?: string | null): string | undefined {
    if (!threadId) return undefined;
    const prefix = `${threadId}:`;
    for (const key of this.turnQueues.keys()) {
      if (key.startsWith(prefix)) {
        return key.slice(prefix.length);
      }
    }
    return undefined;
  }

  private emit(event: CodexEvent): void {
    this.notifyListeners(event);
    const key = this.eventTurnKey(event);
    if (!key) {
      // Null-turn thread events (e.g. mcpServer/elicitation/request with turnId:null,
      // serverRequest/resolved) should still reach an active turn stream on that thread.
      if ('threadId' in event && typeof event.threadId === 'string' && event.threadId) {
        const activeTurnId = this.findActiveTurnId(event.threadId);
        if (activeTurnId) {
          const activeQ = this.turnQueues.get(`${event.threadId}:${activeTurnId}`);
          if (activeQ) {
            this.lastTurnActivityAt = Date.now();
            activeQ.push(event);
          }
        }
      }
      return;
    }
    this.lastTurnActivityAt = Date.now();
    const q = this.turnQueues.get(key);
    if (q) {
      q.push(event);
      if (event.type === 'turn-completed') {
        q.close();
        this.turnQueues.delete(key);
      }
      return;
    }
    // queue 还没注册(startTurn 的响应 continuation 还没跑完):缓冲,注册时 drain。
    let pending = this.pendingTurnEvents.get(key);
    if (!pending) {
      pending = [];
      this.pendingTurnEvents.set(key, pending);
      // 外部 client 的 turn 永远不会注册:淘汰最旧 key,防缓慢泄漏。
      if (this.pendingTurnEvents.size > 50) {
        const oldest = this.pendingTurnEvents.keys().next().value;
        if (oldest !== undefined) this.pendingTurnEvents.delete(oldest);
      }
    }
    if (pending.length < 500) pending.push(event);
  }

  private notifyListeners(event: CodexEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        // listener errors must not break the dispatch loop
      }
    }
  }

  private eventTurnKey(event: CodexEvent): string | null {
    if ('threadId' in event && 'turnId' in event && event.threadId && event.turnId) {
      return `${event.threadId}:${event.turnId}`;
    }
    return null;
  }

  // -- JSON-RPC plumbing ------------------------------------------------------

  private write(msg: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new Error('codex app-server is not running');
    stdin.write(JSON.stringify(msg) + '\n');
  }

  private notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  private request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const budget = timeoutMs ?? this.opts.requestTimeoutMs;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingClient.delete(id);
        reject(new Error(`codex request '${method}' timed out after ${budget}ms`));
      }, budget);
      this.pendingClient.set(id, { method, resolve, reject, timer });
      try {
        this.write(params === undefined ? { id, method } : { id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pendingClient.delete(id);
        reject(err);
      }
    });
  }

  private respond(id: CodexRequestId, result: unknown): void {
    this.write({ id, result });
  }

  private respondError(id: CodexRequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit({ type: 'log', line: `[non-json stdout] ${line}` });
      return;
    }
    const id = msg.id as CodexRequestId | undefined;
    const method = msg.method as string | undefined;

    if (id !== undefined && method !== undefined) {
      this.handleServerRequest(id, method, msg.params);
    } else if (id !== undefined) {
      this.handleResponse(id, msg);
    } else if (method !== undefined) {
      this.handleNotification(method, msg.params);
    }
  }

  private handleResponse(id: CodexRequestId, msg: Record<string, unknown>): void {
    const pending = this.pendingClient.get(id);
    if (!pending) return;
    this.pendingClient.delete(id);
    clearTimeout(pending.timer);
    const err = msg.error as { code?: number; message?: string } | undefined;
    if (err) {
      pending.reject(new Error(`codex '${pending.method}' failed (${err.code ?? '?'}): ${err.message ?? 'unknown error'}`));
    } else {
      pending.resolve(msg.result);
    }
    // 任何请求落定都是潜在空闲点(thread/resume 也会占写手锁,不能只看 turn)。
    this.scheduleRecycleWhenIdle();
  }

  // -- server → client reverse requests ----------------------------------------

  private safeRespond(id: CodexRequestId, result: unknown): void {
    try {
      this.respond(id, result);
    } catch (err) {
      if (!(err instanceof Error) || !/not running/i.test(err.message)) throw err;
    }
  }

  private safeRespondError(id: CodexRequestId, code: number, message: string): void {
    try {
      this.respondError(id, code, message);
    } catch (err) {
      if (!(err instanceof Error) || !/not running/i.test(err.message)) throw err;
    }
  }

  private findPendingServerKey(requestId: CodexRequestId): string | undefined {
    const direct = String(requestId);
    if (this.pendingServer.has(direct)) return direct;
    for (const [k, entry] of this.pendingServer.entries()) {
      if (entry.approvalId && entry.approvalId === direct) return k;
    }
    return undefined;
  }

  private handleServerRequest(id: CodexRequestId, method: string, params: unknown): void {
    const key = String(id);
    const rawParams = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;

    const approvalMethod =
      method === 'item/commandExecution/requestApproval'
        ? 'commandExecution'
        : method === 'item/fileChange/requestApproval'
          ? 'fileChange'
          : null;

    if (approvalMethod) {
      const parsed = ApprovalRequestParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.pendingServer.delete(key);
        this.safeRespondError(id, -32602, `invalid ${method} params: ${parsed.error.message}`);
        return;
      }
      const p = parsed.data;
      if (this.opts.autoApprove) {
        this.pendingServer.delete(key);
        this.safeRespond(id, { decision: 'accept' });
        return;
      }
      const approvalId =
        typeof p.approvalId === 'string' && p.approvalId ? p.approvalId : String(id);
      const availableDecisions = Array.isArray(p.availableDecisions)
        ? p.availableDecisions
        : approvalMethod === 'fileChange'
          ? ['accept', 'acceptForSession', 'decline', 'cancel']
          : undefined;
      this.pendingServer.set(key, {
        id,
        method,
        params: p,
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        approvalId,
        interactionKind: 'approval',
      });
      this.emit({
        type: 'approval-request',
        requestId: id,
        method,
        kind: approvalMethod,
        approvalKind: typeof p.kind === 'string' ? p.kind : 'command',
        approvalId,
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        command: p.command ?? undefined,
        cwd: p.cwd ?? undefined,
        reason: p.reason ?? undefined,
        grantRoot: p.grantRoot ?? undefined,
        availableDecisions,
        commandActions: Array.isArray(p.commandActions) ? p.commandActions : undefined,
        networkApprovalContext: p.networkApprovalContext ?? undefined,
        additionalPermissions: p.additionalPermissions ?? undefined,
        proposedExecpolicyAmendment: p.proposedExecpolicyAmendment ?? undefined,
        proposedNetworkPolicyAmendments: Array.isArray(p.proposedNetworkPolicyAmendments)
          ? p.proposedNetworkPolicyAmendments
          : undefined,
        params: p as Record<string, unknown>,
      });
      return;
    }

    if (method === 'item/permissions/requestApproval') {
      const parsed = PermissionsApprovalRequestParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.pendingServer.delete(key);
        this.safeRespondError(id, -32602, `invalid ${method} params: ${parsed.error.message}`);
        return;
      }
      const p = parsed.data;
      const requestedPermissions =
        p.permissions && typeof p.permissions === 'object'
          ? (p.permissions as Record<string, unknown>)
          : {};
      if (this.opts.autoApprove) {
        this.pendingServer.delete(key);
        this.safeRespond(id, { permissions: requestedPermissions, scope: 'turn' });
        return;
      }
      this.pendingServer.set(key, {
        id,
        method,
        params: p,
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        approvalId: String(id),
        interactionKind: 'permissions',
      });
      this.emit({
        type: 'approval-request',
        requestId: id,
        method,
        kind: 'permissions',
        approvalId: String(id),
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        cwd: p.cwd ?? undefined,
        reason: p.reason ?? undefined,
        permissions: requestedPermissions,
        additionalPermissions: requestedPermissions,
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
        params: p as Record<string, unknown>,
      });
      return;
    }

    if (method === 'mcpServer/elicitation/request') {
      const parsed = McpElicitationRequestParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.pendingServer.delete(key);
        this.safeRespondError(id, -32602, `invalid ${method} params: ${parsed.error.message}`);
        return;
      }
      const p = parsed.data;
      const resolvedTurnId =
        (typeof p.turnId === 'string' && p.turnId) || this.findActiveTurnId(p.threadId) || '';
      if (this.opts.autoApprove) {
        this.pendingServer.delete(key);
        this.safeRespond(id, { action: 'accept', content: {}, _meta: p._meta ?? null });
        return;
      }
      const approvalId =
        typeof p.elicitationId === 'string' && p.elicitationId ? p.elicitationId : String(id);
      this.pendingServer.set(key, {
        id,
        method,
        params: p,
        threadId: p.threadId,
        turnId: resolvedTurnId || undefined,
        itemId: typeof p.elicitationId === 'string' ? p.elicitationId : '',
        approvalId,
        interactionKind: 'elicitation',
      });
      this.emit({
        type: 'approval-request',
        requestId: id,
        method,
        kind: 'mcpElicitation',
        approvalId,
        threadId: p.threadId,
        turnId: resolvedTurnId,
        itemId: typeof p.elicitationId === 'string' ? p.elicitationId : '',
        reason:
          typeof p.message === 'string'
            ? p.message
            : typeof p.description === 'string'
              ? p.description
              : undefined,
        availableDecisions: ['accept', 'decline', 'cancel'],
        elicitation: {
          serverName: p.serverName,
          mode: p.mode,
          environmentId: p.environmentId ?? null,
          message: p.message ?? undefined,
          url: p.url ?? undefined,
          elicitationId: p.elicitationId ?? undefined,
          requestedSchema: p.requestedSchema ?? undefined,
          title: p.title ?? undefined,
          description: p.description ?? undefined,
          challenge: p.challenge ?? undefined,
          _meta: p._meta ?? undefined,
        },
        params: p as Record<string, unknown>,
      });
      return;
    }

    if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
      const parsed =
        method === 'applyPatchApproval'
          ? LegacyPatchApprovalParamsSchema.safeParse(params)
          : LegacyExecApprovalParamsSchema.safeParse(params);
      const p = parsed.success ? parsed.data : rawParams;
      const threadId =
        (typeof p.conversationId === 'string' && p.conversationId) ||
        (typeof p.threadId === 'string' && p.threadId) ||
        '';
      if (!threadId) {
        this.pendingServer.delete(key);
        this.safeRespondError(id, -32602, `invalid ${method} params: missing conversationId/threadId`);
        return;
      }
      const turnId =
        (typeof p.turnId === 'string' && p.turnId) || this.findActiveTurnId(threadId) || '';
      const itemId =
        (typeof p.callId === 'string' && p.callId) ||
        (typeof p.itemId === 'string' && p.itemId) ||
        '';
      if (this.opts.autoApprove) {
        this.pendingServer.delete(key);
        this.safeRespond(id, { decision: 'approved' });
        return;
      }
      const approvalId =
        typeof (p as { approvalId?: unknown }).approvalId === 'string' &&
        (p as { approvalId: string }).approvalId
          ? (p as { approvalId: string }).approvalId
          : String(id);
      const cmdRaw = (p as { command?: unknown }).command;
      const command = Array.isArray(cmdRaw)
        ? cmdRaw.map(String).join(' ')
        : typeof cmdRaw === 'string'
          ? cmdRaw
          : undefined;
      this.pendingServer.set(key, {
        id,
        method,
        params: p,
        threadId,
        turnId: turnId || undefined,
        itemId,
        approvalId,
        interactionKind: 'approval',
      });
      this.emit({
        type: 'approval-request',
        requestId: id,
        method,
        kind: method === 'applyPatchApproval' ? 'fileChange' : 'commandExecution',
        approvalId,
        threadId,
        turnId,
        itemId,
        command,
        cwd: typeof (p as { cwd?: unknown }).cwd === 'string' ? (p as { cwd: string }).cwd : undefined,
        reason: typeof p.reason === 'string' ? p.reason : undefined,
        grantRoot:
          typeof (p as { grantRoot?: unknown }).grantRoot === 'string'
            ? (p as { grantRoot: string }).grantRoot
            : undefined,
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
        params: p as Record<string, unknown>,
      });
      return;
    }

    if (method === 'item/tool/requestUserInput') {
      const parsed = UserInputRequestParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.pendingServer.delete(key);
        this.safeRespondError(id, -32602, `invalid ${method} params: ${parsed.error.message}`);
        return;
      }
      const p = parsed.data;
      if (this.opts.autoApprove) {
        this.pendingServer.delete(key);
        this.safeRespond(id, { answers: {} });
        return;
      }
      this.pendingServer.set(key, {
        id,
        method,
        params: p,
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        approvalId: String(id),
        interactionKind: 'question',
      });
      this.emit({
        type: 'question-request',
        requestId: id,
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.itemId,
        questions: p.questions,
        isBlocking: typeof p.isBlocking === 'boolean' ? p.isBlocking : true,
        autoResolutionMs: typeof p.autoResolutionMs === 'number' ? p.autoResolutionMs : null,
        params: p as Record<string, unknown>,
      });
      return;
    }

    // Host / non-approval requests:
    // - item/tool/call (DynamicToolCall)
    // - account/chatgptAuthTokens/refresh
    // - attestation/generate
    // - currentTime/read
    // - any future unknown ServerRequest method
    // Correlate to threadId/turnId (or session channel), emit for observability,
    // and return an explicit JSON-RPC -32601 error if not answered synchronously
    // by a listener via respondTo/respondServerRequest — never leave parked forever.
    const corrThreadId =
      typeof rawParams.threadId === 'string' && rawParams.threadId
        ? rawParams.threadId
        : typeof rawParams.conversationId === 'string' && rawParams.conversationId
          ? rawParams.conversationId
          : undefined;
    const corrTurnId =
      (typeof rawParams.turnId === 'string' && rawParams.turnId) ||
      this.findActiveTurnId(corrThreadId);

    if (method === 'item/tool/call') {
      const parsed = DynamicToolCallParamsSchema.safeParse(params);
      if (!parsed.success) {
        this.pendingServer.delete(key);
        this.safeRespondError(id, -32602, `invalid ${method} params: ${parsed.error.message}`);
        return;
      }
    }

    const serverReqEvent: CodexEvent = {
      type: 'server-request',
      requestId: id,
      method,
      threadId: corrThreadId,
      turnId: corrTurnId,
      params,
      handled: false,
    };
    this.pendingServer.set(key, {
      id,
      method,
      params,
      threadId: corrThreadId,
      turnId: corrTurnId,
    });
    this.emit(serverReqEvent);
    if (this.pendingServer.has(key) && serverReqEvent.handled !== true) {
      this.pendingServer.delete(key);
      this.safeRespondError(id, -32601, `unsupported server request '${method}'`);
    }
  }

  // -- Granular approval / server-request resolution helpers ------------------

  static acceptWithExecpolicyAmendment(
    amendment: string[],
  ): { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } } {
    return { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } };
  }

  static applyNetworkPolicyAmendment(amendment: {
    host: string;
    action: 'allow' | 'deny' | string;
  }): { applyNetworkPolicyAmendment: { network_policy_amendment: { host: string; action: string } } } {
    return { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } };
  }

  static acceptWithPermissions(
    permissions: Record<string, unknown>,
    scope: 'turn' | 'session' = 'turn',
    strictAutoReview?: boolean,
  ): {
    acceptWithPermissions: {
      permissions: Record<string, unknown>;
      scope: 'turn' | 'session';
      strictAutoReview?: boolean;
    };
  } {
    return {
      acceptWithPermissions: {
        permissions,
        scope,
        ...(strictAutoReview !== undefined ? { strictAutoReview } : {}),
      },
    };
  }

  static elicitationResponse(
    action: 'accept' | 'decline' | 'cancel',
    content: unknown = null,
    _meta: unknown = null,
  ): { action: 'accept' | 'decline' | 'cancel'; content: unknown; _meta: unknown } {
    return {
      action,
      content: action === 'accept' ? (content ?? {}) : null,
      _meta: _meta ?? null,
    };
  }

  /**
   * Answer a parked approval request (commandExecution, fileChange, permissions,
   * mcpServer/elicitation/request, or legacy applyPatchApproval/execCommandApproval).
   */
  resolveApproval(
    requestId: CodexRequestId,
    decision: ApprovalDecision | GranularApprovalDecision,
    details?: GranularApprovalDetails,
  ): void {
    const key = this.findPendingServerKey(requestId);
    if (!key) throw new Error(`no pending server request with id ${String(requestId)}`);
    const parked = this.pendingServer.get(key)!;

    const isApprovalMethod =
      parked.method === 'item/commandExecution/requestApproval' ||
      parked.method === 'item/fileChange/requestApproval' ||
      parked.method === 'item/permissions/requestApproval' ||
      parked.method === 'mcpServer/elicitation/request' ||
      parked.method === 'applyPatchApproval' ||
      parked.method === 'execCommandApproval';
    if (!isApprovalMethod) {
      throw new Error(`pending request ${key} is '${parked.method}', not an approval`);
    }

    this.pendingServer.delete(key);

    if (parked.method === 'item/permissions/requestApproval') {
      const requestedPerms =
        parked.params &&
        typeof parked.params === 'object' &&
        (parked.params as { permissions?: unknown }).permissions &&
        typeof (parked.params as { permissions?: unknown }).permissions === 'object'
          ? ((parked.params as { permissions: Record<string, unknown> }).permissions)
          : {};
      if (
        decision &&
        typeof decision === 'object' &&
        'permissions' in decision &&
        typeof (decision as { permissions?: unknown }).permissions === 'object' &&
        (decision as { permissions?: unknown }).permissions !== null &&
        !('decision' in decision)
      ) {
        const d = decision as {
          permissions: Record<string, unknown>;
          scope?: 'turn' | 'session';
          strictAutoReview?: boolean;
        };
        this.respond(parked.id, {
          permissions: d.permissions,
          scope: d.scope ?? 'turn',
          ...(d.strictAutoReview !== undefined ? { strictAutoReview: d.strictAutoReview } : {}),
        });
        return;
      }
      if (
        decision &&
        typeof decision === 'object' &&
        'acceptWithPermissions' in decision &&
        typeof (decision as { acceptWithPermissions?: unknown }).acceptWithPermissions === 'object'
      ) {
        const awp = (decision as {
          acceptWithPermissions: {
            permissions?: Record<string, unknown>;
            scope?: 'turn' | 'session';
            strictAutoReview?: boolean;
          };
        }).acceptWithPermissions;
        this.respond(parked.id, {
          permissions: awp.permissions ?? requestedPerms,
          scope: awp.scope ?? 'turn',
          ...(awp.strictAutoReview !== undefined ? { strictAutoReview: awp.strictAutoReview } : {}),
        });
        return;
      }
      const decStr =
        typeof decision === 'string'
          ? decision
          : typeof (decision as { decision?: unknown })?.decision === 'string'
            ? ((decision as { decision: string }).decision)
            : 'accept';
      const isReject = decStr === 'decline' || decStr === 'reject' || decStr === 'cancel';
      if (isReject) {
        this.respond(parked.id, { permissions: {}, scope: 'turn' });
        return;
      }
      const granted = details?.permissions ?? requestedPerms;
      const scope =
        details?.scope === 'session' ||
        details?.scope === 'always' ||
        decStr === 'acceptForSession' ||
        decStr === 'approve_always'
          ? 'session'
          : 'turn';
      this.respond(parked.id, { permissions: granted, scope });
      return;
    }

    if (parked.method === 'mcpServer/elicitation/request') {
      if (details?.elicitation) {
        const act = details.elicitation.action;
        this.respond(parked.id, {
          action: act,
          content: act === 'accept' ? (details.elicitation.content ?? {}) : null,
          _meta: details.elicitation._meta ?? null,
        });
        return;
      }
      if (
        decision &&
        typeof decision === 'object' &&
        'action' in decision &&
        typeof (decision as { action?: unknown }).action === 'string'
      ) {
        const d = decision as { action: 'accept' | 'decline' | 'cancel'; content?: unknown; _meta?: unknown };
        this.respond(parked.id, {
          action: d.action,
          content: d.action === 'accept' ? (d.content ?? {}) : null,
          _meta: d._meta ?? null,
        });
        return;
      }
      const decStr =
        typeof decision === 'string'
          ? decision
          : typeof (decision as { decision?: unknown })?.decision === 'string'
            ? ((decision as { decision: string }).decision)
            : 'decline';
      if (
        decStr === 'accept' ||
        decStr === 'acceptForSession' ||
        decStr === 'approve' ||
        decStr === 'approve_always' ||
        decStr === 'accept_elicitation'
      ) {
        const content =
          details?.updatedInput && typeof details.updatedInput === 'object'
            ? details.updatedInput
            : {};
        this.respond(parked.id, { action: 'accept', content, _meta: null });
      } else if (decStr === 'cancel') {
        this.respond(parked.id, { action: 'cancel', content: null, _meta: null });
      } else {
        this.respond(parked.id, { action: 'decline', content: null, _meta: null });
      }
      return;
    }

    const wireDecision = this.normalizeWireApprovalDecision(parked.method, decision, details);
    this.respond(parked.id, { decision: wireDecision });
  }

  private normalizeWireApprovalDecision(
    method: string,
    decision: ApprovalDecision | GranularApprovalDecision,
    details?: GranularApprovalDetails,
  ): unknown {
    const isLegacy = method === 'applyPatchApproval' || method === 'execCommandApproval';

    if (details?.nativeDecision !== undefined) {
      return details.nativeDecision;
    }
    if (details?.execpolicyAmendment) {
      return isLegacy
        ? { approved_execpolicy_amendment: { proposed_execpolicy_amendment: details.execpolicyAmendment } }
        : { acceptWithExecpolicyAmendment: { execpolicy_amendment: details.execpolicyAmendment } };
    }
    if (details?.networkPolicyAmendment) {
      return isLegacy
        ? { network_policy_amendment: { network_policy_amendment: details.networkPolicyAmendment } }
        : { applyNetworkPolicyAmendment: { network_policy_amendment: details.networkPolicyAmendment } };
    }

    if (decision && typeof decision === 'object') {
      if ('acceptWithExecpolicyAmendment' in decision && isLegacy) {
        const inner = (decision as { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } })
          .acceptWithExecpolicyAmendment;
        return { approved_execpolicy_amendment: { proposed_execpolicy_amendment: inner.execpolicy_amendment } };
      }
      if ('applyNetworkPolicyAmendment' in decision && isLegacy) {
        const inner = (
          decision as { applyNetworkPolicyAmendment: { network_policy_amendment: Record<string, unknown> } }
        ).applyNetworkPolicyAmendment;
        return { network_policy_amendment: { network_policy_amendment: inner.network_policy_amendment } };
      }
      if ('decision' in decision && typeof (decision as { decision?: unknown }).decision === 'string') {
        const subDetails = decision as GranularApprovalDetails;
        return this.normalizeWireApprovalDecision(
          method,
          (decision as { decision: ApprovalDecision }).decision,
          { ...details, ...subDetails },
        );
      }
      return decision;
    }

    if (isLegacy) {
      switch (decision) {
        case 'accept':
        case 'approve':
          return 'approved';
        case 'acceptForSession':
        case 'approve_always':
          return 'approved_for_session';
        case 'cancel':
          return 'abort';
        case 'decline':
        case 'reject':
        default:
          return { denied: { rejection: details?.message ?? 'Rejected by user' } };
      }
    }

    switch (decision) {
      case 'accept':
      case 'approve':
        return 'accept';
      case 'acceptForSession':
      case 'approve_always':
        return 'acceptForSession';
      case 'cancel':
        return 'cancel';
      case 'decline':
      case 'reject':
      default:
        return 'decline';
    }
  }

  /** Answer a parked item/permissions/requestApproval explicitly. */
  resolvePermissionsApproval(
    requestId: CodexRequestId,
    permissions: Record<string, unknown>,
    scope: 'turn' | 'session' = 'turn',
    strictAutoReview?: boolean,
  ): void {
    this.resolveApproval(
      requestId,
      CodexAdapter.acceptWithPermissions(permissions, scope, strictAutoReview),
    );
  }

  /** Answer a parked mcpServer/elicitation/request explicitly. */
  resolveElicitation(
    requestId: CodexRequestId,
    action: 'accept' | 'decline' | 'cancel',
    content: unknown = null,
    _meta: unknown = null,
  ): void {
    this.resolveApproval(requestId, CodexAdapter.elicitationResponse(action, content, _meta));
  }

  /**
   * Answer a parked item/tool/requestUserInput request.
   * Accepts {questionId: string[]} (or string) and wraps it into the protocol shape
   * {answers: {questionId: {answers: string[]}}}. Maps synthetic q_0/q_N keys onto
   * actual question IDs from the request when present.
   */
  resolveQuestion(requestId: CodexRequestId, answers: string | Record<string, string[]>): void {
    const key = this.findPendingServerKey(requestId);
    if (!key) throw new Error(`no pending server request with id ${String(requestId)}`);
    const parked = this.pendingServer.get(key)!;
    if (parked.method !== 'item/tool/requestUserInput') {
      throw new Error(`pending request ${key} is '${parked.method}', not a user-input request`);
    }
    this.pendingServer.delete(key);

    const rawQuestions = Array.isArray((parked.params as { questions?: unknown })?.questions)
      ? ((parked.params as { questions: Array<Record<string, unknown>> }).questions)
      : [];
    const questionIds = rawQuestions
      .map((q) => (q && typeof q === 'object' && typeof q.id === 'string' ? q.id : ''))
      .filter(Boolean);

    const normalizedInput: Record<string, string[]> =
      typeof answers === 'string' ? { [questionIds[0] ?? 'q_0']: [answers] } : answers;

    const wrapped: Record<string, { answers: string[] }> = {};
    for (const [qid, ans] of Object.entries(normalizedInput)) {
      let targetId = qid;
      const syntheticMatch = /^q_(\d+)$/.exec(qid);
      if (syntheticMatch && !questionIds.includes(qid)) {
        const idx = Number(syntheticMatch[1]);
        if (questionIds[idx]) targetId = questionIds[idx];
      }
      wrapped[targetId] = { answers: Array.isArray(ans) ? ans.map(String) : [String(ans)] };
    }
    this.respond(parked.id, { answers: wrapped });
  }

  /** Escape hatch for reverse requests not covered by the helpers above. */
  respondTo(requestId: CodexRequestId, result: unknown): void {
    const key = this.findPendingServerKey(requestId);
    if (!key) throw new Error(`no pending server request with id ${String(requestId)}`);
    const parked = this.pendingServer.get(key)!;
    this.pendingServer.delete(key);
    this.respond(parked.id, result);
  }

  /** Respond to a reverse server request with a result (alias of respondTo). */
  respondServerRequest(requestId: CodexRequestId, result: unknown): void {
    this.respondTo(requestId, result);
  }

  /** Reject a parked reverse server request with a JSON-RPC error. */
  rejectServerRequest(requestId: CodexRequestId, code = -32601, message = 'Rejected server request'): void {
    const key = this.findPendingServerKey(requestId);
    if (!key) return;
    const parked = this.pendingServer.get(key)!;
    this.pendingServer.delete(key);
    this.safeRespondError(parked.id, code, message);
  }

  // -- notifications -------------------------------------------------------------

  private handleNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'thread/started': {
        const parsed = ThreadSchema.safeParse(p.thread);
        if (parsed.success) {
          if (parsed.data.cwd) this.threadCwds.set(parsed.data.id, parsed.data.cwd);
          if (parsed.data.model) this.threadModels.set(parsed.data.id, parsed.data.model);
          if (parsed.data.reasoningEffort) this.threadEfforts.set(parsed.data.id, parsed.data.reasoningEffort);
          this.emit({ type: 'thread-started', thread: parsed.data });
        }
        break;
      }
      case 'thread/reverted': {
        if (typeof p.threadId === 'string') {
          this.emit({ type: 'thread-reverted', threadId: p.threadId });
        }
        break;
      }
      case 'thread/compacted': {
        if (typeof p.threadId === 'string') {
          this.emit({
            type: 'thread-compacted',
            threadId: p.threadId,
            turnId: typeof p.turnId === 'string' ? p.turnId : undefined,
          });
        }
        break;
      }
      case 'skills/changed': {
        this.skillsDirty = true;
        this.skillsVersion += 1;
        this.emit({ type: 'skills-changed' });
        break;
      }
      case 'serverRequest/resolved': {
        const reqId = p.requestId as CodexRequestId | undefined;
        const threadId = typeof p.threadId === 'string' ? p.threadId : '';
        if (reqId !== undefined) {
          const key = this.findPendingServerKey(reqId) ?? String(reqId);
          const parked = this.pendingServer.get(key);
          this.pendingServer.delete(key);
          const turnId = parked?.turnId ?? this.findActiveTurnId(threadId || parked?.threadId);
          this.emit({
            type: 'server-request-resolved',
            threadId: threadId || parked?.threadId || '',
            turnId,
            requestId: reqId,
            interactionKind: parked?.interactionKind,
          });
          this.scheduleRecycleWhenIdle();
        }
        break;
      }
      case 'turn/started': {
        const turn = TurnSchema.safeParse(p.turn);
        if (turn.success && typeof p.threadId === 'string') {
          const key = `${p.threadId}:${turn.data.id}`;
          // startTurn() already emits a synthesized turn-started when it
          // registers the queue; suppress the duplicate from the server.
          if (!this.seenTurnStarts.has(key)) {
            this.seenTurnStarts.add(key);
            this.emit({ type: 'turn-started', threadId: p.threadId, turnId: turn.data.id, turn: turn.data });
          }
        }
        break;
      }
      case 'turn/completed': {
        const turn = TurnSchema.safeParse(p.turn);
        if (turn.success && typeof p.threadId === 'string') {
          // turn 结束,去重记录一并清掉,防 seenTurnStarts 无限增长。
          this.seenTurnStarts.delete(`${p.threadId}:${turn.data.id}`);
          const turnError = turn.data.error ?? null;
          const errorMessage =
            turnError && typeof turnError.message === 'string'
              ? turnError.additionalDetails
                ? `${turnError.message}: ${turnError.additionalDetails}`
                : turnError.message
              : undefined;
          this.emit({
            type: 'turn-completed',
            threadId: p.threadId,
            turnId: turn.data.id,
            turn: turn.data,
            ...(errorMessage ? { error: errorMessage } : {}),
            ...(turnError ? { turnError } : {}),
          });
          this.scheduleRecycleWhenIdle();
        }
        break;
      }
      case 'turn/plan/updated': {
        if (typeof p.threadId === 'string' && typeof p.turnId === 'string') {
          const rawPlan = Array.isArray(p.plan) ? p.plan : [];
          const plan = rawPlan
            .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === 'object'))
            .map((s) => ({
              step: typeof s.step === 'string' ? s.step : '',
              status: typeof s.status === 'string' ? s.status : 'pending',
            }));
          this.emit({
            type: 'plan-updated',
            threadId: p.threadId,
            turnId: p.turnId,
            explanation: typeof p.explanation === 'string' ? p.explanation : null,
            plan,
          });
        }
        break;
      }
      case 'item/plan/delta': {
        const r = ItemRefSchema.extend({ delta: z.string() }).safeParse(p);
        if (r.success) {
          this.emit({ type: 'plan-delta', ...r.data });
        }
        break;
      }
      case 'turn/diff/updated': {
        if (
          typeof p.threadId === 'string' &&
          typeof p.turnId === 'string' &&
          typeof p.diff === 'string'
        ) {
          this.emit({
            type: 'diff-updated',
            threadId: p.threadId,
            turnId: p.turnId,
            diff: p.diff,
          });
        }
        break;
      }
      case 'item/agentMessage/delta': {
        const r = ItemRefSchema.extend({ delta: z.string() }).safeParse(p);
        if (r.success) this.emit({ type: 'text-delta', ...r.data });
        break;
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const r = ItemRefSchema.extend({
          delta: z.string(),
          contentIndex: z.number().nullish(),
          summaryIndex: z.number().nullish(),
        }).safeParse(p);
        if (r.success) {
          const summaryIndex =
            typeof r.data.summaryIndex === 'number' ? r.data.summaryIndex : undefined;
          const contentIndex =
            typeof r.data.contentIndex === 'number'
              ? r.data.contentIndex
              : summaryIndex ?? 0;
          this.emit({
            type: 'reasoning-delta',
            threadId: r.data.threadId,
            turnId: r.data.turnId,
            itemId: r.data.itemId,
            delta: r.data.delta,
            contentIndex,
            ...(summaryIndex !== undefined ? { summaryIndex } : {}),
          });
        }
        break;
      }
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta': {
        const r = ItemRefSchema.extend({ delta: z.string() }).safeParse(p);
        if (r.success) this.emit({ type: 'command-output-delta', ...r.data });
        break;
      }
      case 'item/started': {
        const item = ThreadItemSchema.safeParse(p.item);
        if (item.success && typeof p.threadId === 'string' && typeof p.turnId === 'string') {
          const normalized = normalizeCodexThreadItem(item.data) ?? item.data;
          this.emit({ type: 'item-started', threadId: p.threadId, turnId: p.turnId, item: normalized });
        }
        break;
      }
      case 'item/completed': {
        const item = ThreadItemSchema.safeParse(p.item);
        if (item.success && typeof p.threadId === 'string' && typeof p.turnId === 'string') {
          const normalized = normalizeCodexThreadItem(item.data) ?? item.data;
          this.emit({ type: 'item-completed', threadId: p.threadId, turnId: p.turnId, item: normalized });
        }
        break;
      }
      case 'error': {
        const err = (p.error ?? {}) as Record<string, unknown>;
        this.emit({
          type: 'error',
          message: typeof err.message === 'string' ? err.message : JSON.stringify(p),
          threadId: typeof p.threadId === 'string' ? p.threadId : undefined,
          turnId: typeof p.turnId === 'string' ? p.turnId : undefined,
          willRetry: typeof p.willRetry === 'boolean' ? p.willRetry : undefined,
          raw: p,
        });
        break;
      }
      case 'thread/tokenUsage/updated': {
        if (typeof p.threadId === 'string' && typeof p.turnId === 'string') {
          const u = (p.tokenUsage ?? {}) as Record<string, unknown>;
          const last = ((u.last ?? {}) as Record<string, unknown>);
          const total = ((u.total ?? {}) as Record<string, unknown>);
          const reasoningOutputTokens =
            typeof total.reasoningOutputTokens === 'number'
              ? total.reasoningOutputTokens
              : typeof last.reasoningOutputTokens === 'number'
                ? last.reasoningOutputTokens
                : undefined;
          this.emit({
            type: 'token-usage',
            threadId: p.threadId,
            turnId: p.turnId,
            usage: {
              last,
              total,
              modelContextWindow: typeof u.modelContextWindow === 'number' ? u.modelContextWindow : null,
              ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
            },
          });
        }
        break;
      }
      case 'thread/goal/updated': {
        if (typeof p.threadId === 'string') {
          this.emit({
            type: 'goal-updated',
            threadId: p.threadId,
            goal: (p.goal as Record<string, unknown> | null) ?? null,
          });
        }
        break;
      }
      case 'thread/goal/cleared': {
        if (typeof p.threadId === 'string') {
          this.emit({
            type: 'goal-updated',
            threadId: p.threadId,
            goal: null,
            cleared: true,
          });
        }
        break;
      }
      case 'thread/archived':
      case 'thread/unarchived': {
        if (typeof p.threadId === 'string') {
          this.emit({ type: 'thread-archived-changed', threadId: p.threadId, archived: method === 'thread/archived' });
        }
        break;
      }
      default:
        // Dozens of informational notifications exist (hooks, realtime, ...);
        // they are intentionally not surfaced unless needed.
        break;
    }
  }

  // -- process exit ----------------------------------------------------------------

  private handleProcessExit(err: Error | null, code: number | null = null, signal: string | null = null): void {
    const reason = err ?? (code !== null || signal !== null
      ? new Error(`codex app-server exited (code=${code}, signal=${signal})`)
      : new Error('codex app-server closed'));
    for (const [, pending] of this.pendingClient) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pendingClient.clear();
    this.pendingServer.clear();
    for (const q of this.turnQueues.values()) q.fail(reason);
    this.turnQueues.clear();
    this.pendingTurnEvents.clear();
    // 进程死了,内存里的激活 thread 一并失效;下次 connect 后需重新 resume。
    this.liveThreads.clear();
    this.seenTurnStarts.clear();
    // 未落盘线程随进程蒸发,保护记录一并清掉(它们已不可恢复)。
    this.unpersistedThreads.clear();
    // config/read 的模型缓存属于旧进程语境,重连后必须重读。
    this.configModelCache = null;
    if (this.readyPromise) {
      this.readyPromise = null;
      this.emit({ type: 'disconnected', code, signal });
    }
  }

  // -- idle recycle --------------------------------------------------------------
  // thread/resume 会拿下 codex 的单写者锁,只有进程退出才释放(codex 0.147 无
  // unload/release RPC)。不回收的话,web 端看一眼会话,CLI 的 codex resume 就被
  // 锁到网关重启。回收走既有 'exit' → handleProcessExit 路径;重连由下次请求的
  // connect()/ensureLive 惰性完成(进程退出重连已有测试覆盖)。

  private scheduleRecycleWhenIdle(): void {
    const grace = this.opts.recycleGraceMs;
    if (grace <= 0 || this.closed || !this.child) return;
    if (this.recycleTimer) clearTimeout(this.recycleTimer);
    this.recycleTimer = setTimeout(() => {
      this.recycleTimer = null;
      this.recycleIfIdle();
    }, grace);
    this.recycleTimer.unref?.();
  }

  /** turn 静默超过该时长就主动探活(实测慢上游 TTFT 71s,阈值须远大于它)。 */
  private static readonly TURN_STALL_MS = 5 * 60_000;
  /** 看门狗 thread/read 探测的预算(901MB 大会话正常 ~9s,wedged 会挂死)。 */
  private static readonly STALL_PROBE_TIMEOUT_MS = 45_000;

  private lastTurnActivityAt = 0;
  private stallProbeInflight = false;

  private recycleIfIdle(): void {
    if (this.closed || !this.child || this.child.exitCode !== null) return;
    // pendingServer(parked 审批/提问)也算 busy:审批是 turn 中段的反向请求,
    // 用户在斟酌的 60s 里进程被回收,审批会静默蒸发。
    const busy =
      this.pendingClient.size > 0 ||
      this.pendingServer.size > 0 ||
      this.turnQueues.size > 0 ||
      this.pendingTurnEvents.size > 0;
    if (busy) {
      // turn 流长期静默:可能 app-server  wedge(实测:rollout 已写
      // task_complete,但 turn/completed 始终不上线,写者锁被一直占着,
      // CLI resume 被拒)。探活区分"慢但活着"与"卡死"。
      if (this.turnQueues.size > 0 && Date.now() - this.lastTurnActivityAt > CodexAdapter.TURN_STALL_MS) {
        void this.probeStalledTurn().catch((err) => {
          this.emit({ type: 'log', line: `stall probe failed: ${err}` });
        });
      }
      // 有在途请求/活跃 turn 流,过个 grace 再看(不 cancel 只 re-check)。
      this.scheduleRecycleWhenIdle();
      return;
    }
    void this.guardUnpersistedThenKill().catch((err) => {
      this.emit({ type: 'log', line: `recycle guard failed: ${err}` });
    });
  }

  /**
   * 卡死 turn 探活:用短预算 thread/read 问 app-server 该 turn 的真实状态。
   * - 服务端已终态但通知没到 → 补发 turn-completed(走正常通知路径收口,
   *   前端拿到终帧,busy 清除,下个 grace 可回收)。
   * - 读不动/超时 → 判定 wedge,杀进程(handleProcessExit 会让队列以
   *   disconnected 失败收尾,是响亮错误而非静默挂起,同时释放写者锁)。
   * - 仍在跑 → 更新活动时间,下个周期再看。
   */
  private async probeStalledTurn(): Promise<void> {
    if (this.stallProbeInflight) return;
    this.stallProbeInflight = true;
    try {
      const key = this.turnQueues.keys().next().value;
      if (!key) return;
      const sep = key.indexOf(':');
      const threadId = key.slice(0, sep);
      const turnId = key.slice(sep + 1);
      let turn: CodexTurn | undefined;
      try {
        const rawTurns = await this.request(
          'thread/turns/list',
          { threadId, limit: 20, sortDirection: 'desc', itemsView: 'notLoaded' },
          CodexAdapter.STALL_PROBE_TIMEOUT_MS,
        );
        const parsedTurns = ThreadTurnsListResponseSchema.parse(rawTurns);
        turn = parsedTurns.data.find((t) => t.id === turnId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/unknown variant|method not found|unexpected thread\/turns\/list/i.test(msg)) {
          try {
            const raw = await this.request(
              'thread/read',
              { threadId, includeTurns: true },
              CodexAdapter.STALL_PROBE_TIMEOUT_MS,
            );
            turn = (ThreadReadResponseSchema.parse(raw).thread.turns ?? []).find((t) => t.id === turnId);
          } catch (fbErr) {
            const fbMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
            if (/^codex '[^']+' failed \(/i.test(fbMsg)) {
              this.emit({ type: 'log', line: `stall probe received RPC error (${fbMsg}); process responsive` });
              this.lastTurnActivityAt = Date.now();
              return;
            }
            if (this.child && this.child.exitCode === null) {
              this.emit({ type: 'log', line: `turn ${turnId} stalled and probe unreadable; killing wedged app-server` });
              this.terminateChild();
            }
            return;
          }
        } else if (/^codex '[^']+' failed \(/i.test(msg)) {
          // Process replied with a JSON-RPC error, so it is responsive, not wedged.
          this.emit({ type: 'log', line: `stall probe received RPC error (${msg}); process responsive` });
          this.lastTurnActivityAt = Date.now();
          return;
        } else {
          if (this.child && this.child.exitCode === null) {
            this.emit({ type: 'log', line: `turn ${turnId} stalled and probe unreadable; killing wedged app-server` });
            this.terminateChild();
          }
          return;
        }
      }
      if (turn && turn.status !== 'inProgress') {
        this.emit({ type: 'log', line: `turn ${turnId} terminal on server (${turn.status}) but notification never arrived; synthesizing turn-completed` });
        this.handleNotification('turn/completed', { threadId, turn });
      } else {
        // 服务端确认还在跑:不是 wedge,是慢。重置活动时间,避免误杀。
        this.lastTurnActivityAt = Date.now();
      }
    } finally {
      this.stallProbeInflight = false;
    }
  }

  /** 未落盘线程保护 + 杀进程;文件检查是异步的,单独拆出来。 */
  private async guardUnpersistedThenKill(): Promise<void> {
    const now = Date.now();
    for (const [id, createdAt] of this.unpersistedThreads) {
      if (now - createdAt > CodexAdapter.UNPERSISTED_PROTECT_MS) {
        this.unpersistedThreads.delete(id); // 废弃草稿,放弃保护
      } else if (await findCodexRollout(id)) {
        this.unpersistedThreads.delete(id); // 首个 turn 已落盘
      }
    }
    if (this.closed || !this.child || this.child.exitCode !== null) return;
    // await 窗口内可能来了新请求:杀之前按与 recycleIfIdle 相同的口径重检,
    // 否则在飞请求会被无谓杀掉(虽能 reject 兜底,但用户看到的是偶发失败)。
    const busy =
      this.pendingClient.size > 0 ||
      this.pendingServer.size > 0 ||
      this.turnQueues.size > 0 ||
      this.pendingTurnEvents.size > 0;
    if (busy) {
      this.scheduleRecycleWhenIdle();
      return;
    }
    if (this.unpersistedThreads.size > 0) {
      // 有新建未落盘的线程,回收会让它蒸发;顺延。
      this.scheduleRecycleWhenIdle();
      return;
    }
    this.emit({ type: 'log', line: `codex app-server idle ${this.opts.recycleGraceMs}ms, recycling to release writer lock` });
    this.terminateChild();
  }

  /** 杀 app-server:SIGTERM,3s 不退升级 SIGKILL(close 的同款兜底,回收/wedge 共用)。 */
  private terminateChild(): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 3_000).unref?.();
  }

  // -- public API: threads & turns -------------------------------------------------

  /** List known threads (thread/list). */
  async list(options: ThreadListOptions = {}): Promise<{
    threads: CodexThread[];
    nextCursor: string | null;
    backwardsCursor: string | null;
  }> {
    await this.connect();
    const raw = await this.request('thread/list', {
      cursor: options.cursor ?? null,
      limit: options.limit ?? null,
      cwd: options.cwd ?? null,
      archived: options.archived ?? null,
      searchTerm: options.searchTerm ?? null,
      sourceKinds: options.sourceKinds ?? null,
    });
    const parsed = ThreadListResponseSchema.parse(raw);
    return {
      threads: parsed.data,
      nextCursor: parsed.nextCursor ?? null,
      backwardsCursor: parsed.backwardsCursor ?? null,
    };
  }

  /** Create a new thread (thread/start). Returns the Thread object. */
  async create(options: ThreadStartOptions = {}): Promise<CodexThread> {
    await this.connect();
    const raw = await this.request('thread/start', {
      cwd: options.cwd ?? null,
      model: options.model ?? null,
      ...(options.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
      approvalPolicy: options.approvalPolicy ?? null,
      sandbox: options.sandbox ?? null,
      ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
      serviceName: options.serviceName ?? null,
      baseInstructions: options.baseInstructions ?? null,
      developerInstructions: options.developerInstructions ?? null,
      config: options.config ?? null,
      ephemeral: options.ephemeral ?? null,
      ...(options.historyMode !== undefined ? { historyMode: options.historyMode } : {}),
    });
    const parsed = ThreadStartResponseSchema.parse(raw);
    const thread = parsed.thread;
    this.liveThreads.add(thread.id);
    this.unpersistedThreads.set(thread.id, Date.now());
    const effectiveModel = options.model ?? parsed.model ?? thread.model ?? undefined;
    if (effectiveModel) this.threadModels.set(thread.id, effectiveModel);
    if (parsed.reasoningEffort ?? thread.reasoningEffort) {
      this.threadEfforts.set(thread.id, (parsed.reasoningEffort ?? thread.reasoningEffort)!);
    }
    if (options.serviceTier !== undefined || parsed.serviceTier !== undefined) {
      this.threadServiceTiers.set(thread.id, options.serviceTier ?? parsed.serviceTier ?? null);
    }
    if (options.cwd ?? thread.cwd) {
      this.threadCwds.set(thread.id, (options.cwd ?? thread.cwd)!);
    }
    return thread;
  }

  /** Resume an existing thread (thread/resume) so turns can be sent to it. */
  async resume(threadId: string, options: ThreadStartOptions = {}): Promise<CodexThread> {
    await this.connect();
    let raw: unknown;
    try {
      raw = await this.request('thread/resume', {
        threadId,
        cwd: options.cwd ?? null,
        model: options.model ?? null,
        ...(options.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
        approvalPolicy: options.approvalPolicy ?? null,
        sandbox: options.sandbox ?? null,
        ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
        baseInstructions: options.baseInstructions ?? null,
        developerInstructions: options.developerInstructions ?? null,
        config: options.config ?? null,
      });
    } catch (err) {
      // codex 单写者语义:另一个客户端(常见是 codex CLI resume 了同一
      // thread)持有写入者时,app-server 报 -32600 already has an active
      // writer。对齐 kap-server 的 busy 模型(409 + busy 子码):这是"会话
      // 正忙"而非服务器故障,前端可按 busy 形态展示并提示稍后再试。
      if (err instanceof Error && /already has an active writer/i.test(err.message)) {
        throw new ProviderError(
          'busy',
          '会话正忙：该 codex 会话被另一个客户端占用(codex 同一时间只允许一个写入者,通常是 codex CLI 里 resume 了同一会话)。请先退出占用方,或稍后再试。',
          409,
        );
      }
      throw err;
    }
    const parsed = ThreadResumeResponseSchema.parse(raw);
    const thread = parsed.thread;
    this.liveThreads.add(threadId);
    const effectiveModel = options.model ?? parsed.model ?? thread.model ?? undefined;
    if (effectiveModel) this.threadModels.set(threadId, effectiveModel);
    if (parsed.reasoningEffort ?? thread.reasoningEffort) {
      this.threadEfforts.set(threadId, (parsed.reasoningEffort ?? thread.reasoningEffort)!);
    }
    if (options.serviceTier !== undefined || parsed.serviceTier !== undefined) {
      this.threadServiceTiers.set(threadId, options.serviceTier ?? parsed.serviceTier ?? null);
    }
    if (options.cwd ?? thread.cwd) {
      this.threadCwds.set(threadId, (options.cwd ?? thread.cwd)!);
    }
    return thread;
  }

  /**
   * 确保 thread 在本进程是激活的;未激活先 thread/resume。turn 级 RPC
   * (turn/start、turn/steer、compact、rollback、review)都打它。
   */
  private async ensureLive(threadId: string): Promise<void> {
    if (this.liveThreads.has(threadId)) return;
    await this.resume(threadId);
  }

  /** "thread not found" 重试兜底:标记失效 → resume → 重放一次调用。 */
  private async withThreadRetry<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    await this.ensureLive(threadId);
    try {
      return await fn();
    } catch (err) {
      // codex 线程级串行:上一个操作(rollback/turn/compact)没做完时,-32600
      // "X already in progress"。对齐 kap-server 的 busy 模型(409+子码),
      // 别当 500 服务器故障抛给前端。
      if (err instanceof Error && /already in progress/i.test(err.message)) {
        throw new ProviderError(
          'busy',
          '会话正忙：该 codex 会话上有操作仍在执行(codex 同一线程的操作是串行的,常见是上一次撤销/压缩还没完成)。请等它完成后再试。',
          409,
        );
      }
      if (!(err instanceof Error) || !/thread not found/i.test(err.message)) throw err;
      this.liveThreads.delete(threadId);
      await this.ensureLive(threadId);
      return fn();
    }
  }

  /** List a page of turns for a paginated thread (thread/turns/list). */
  async listTurns(
    threadId: string,
    options: ThreadTurnsListOptions = {},
  ): Promise<{
    turns: CodexTurn[];
    nextCursor: string | null;
    backwardsCursor: string | null;
  }> {
    await this.connect();
    const raw = await this.request('thread/turns/list', {
      threadId,
      cursor: options.cursor ?? null,
      limit: options.limit ?? null,
      sortDirection: options.sortDirection ?? null,
      itemsView: options.itemsView ?? null,
    });
    const parsed = ThreadTurnsListResponseSchema.parse(raw);
    return {
      turns: parsed.data,
      nextCursor: parsed.nextCursor ?? null,
      backwardsCursor: parsed.backwardsCursor ?? null,
    };
  }

  /** List a page of items for a paginated thread (thread/items/list). */
  async listItems(
    threadId: string,
    options: ThreadItemsListOptions = {},
  ): Promise<{
    items: CodexThreadItemEntry[];
    nextCursor: string | null;
    backwardsCursor: string | null;
  }> {
    await this.connect();
    const raw = await this.request('thread/items/list', {
      threadId,
      ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
      cursor: options.cursor ?? null,
      limit: options.limit ?? null,
      sortDirection: options.sortDirection ?? null,
    });
    const parsed = ThreadItemsListResponseSchema.parse(raw);
    const items: CodexThreadItemEntry[] = [];
    for (const entry of parsed.data) {
      if (entry.item && typeof entry.item === 'object') {
        const mergedItem: CodexThreadItem = {
          ...entry.item,
          ...(entry.item.startedAtMs == null && entry.startedAtMs != null
            ? { startedAtMs: entry.startedAtMs }
            : {}),
          ...(entry.item.completedAtMs == null && entry.completedAtMs != null
            ? { completedAtMs: entry.completedAtMs }
            : {}),
        };
        items.push({
          turnId: entry.turnId ?? options.turnId ?? '',
          item: mergedItem,
          ...(entry.outputDeferred !== undefined && entry.outputDeferred !== null
            ? { outputDeferred: entry.outputDeferred }
            : {}),
          startedAtMs: entry.startedAtMs ?? mergedItem.startedAtMs ?? null,
          completedAtMs: entry.completedAtMs ?? mergedItem.completedAtMs ?? null,
        });
      } else if (typeof (entry as { id?: unknown }).id === 'string' && typeof (entry as { type?: unknown }).type === 'string') {
        // Fallback when a mock returns flat ThreadItem objects in thread/items/list data.
        const flatItem = entry as unknown as CodexThreadItem;
        items.push({
          turnId: entry.turnId ?? options.turnId ?? '',
          item: flatItem,
          startedAtMs: flatItem.startedAtMs ?? null,
          completedAtMs: flatItem.completedAtMs ?? null,
        });
      }
    }
    return {
      items,
      nextCursor: parsed.nextCursor ?? null,
      backwardsCursor: parsed.backwardsCursor ?? null,
    };
  }

  private normalizeTurnHistory(turns: CodexTurn[]): CodexTurn[] {
    return turns.map((turn) => {
      const rawItems = Array.isArray(turn.items) ? turn.items : [];
      const normalizedItems: CodexThreadItem[] = [];
      for (const rawItem of rawItems) {
        const normalized = normalizeCodexThreadItem(rawItem);
        if (normalized !== null) normalizedItems.push(normalized);
      }
      return {
        ...turn,
        items: normalizedItems,
      };
    });
  }

  /**
   * Read a thread's turn history: prefers 0.169.0 paginated `thread/turns/list` +
   * `thread/items/list`, falling back to legacy `thread/read (includeTurns: true)`
   * when the server or thread does not use paginated history. Filters out system
   * injection blocks (`<INSTRUCTIONS>`, `<environment_context>`, `<turn_aborted>`,
   * `<oai-mem-citation>`) and normalizes `reasoning.summary` (`string[]`) +
   * `collabAgentToolCall`.
   */
  async getHistory(threadId: string): Promise<CodexTurn[]> {
    await this.connect();

    try {
      const turns: CodexTurn[] = [];
      const seenTurnCursors = new Set<string>();
      let turnCursor: string | null = null;
      for (let page = 0; page < 100; page++) {
        const res = await this.listTurns(threadId, {
          cursor: turnCursor,
          sortDirection: 'asc',
        });
        turns.push(...res.turns);
        if (!res.nextCursor || seenTurnCursors.has(res.nextCursor)) break;
        seenTurnCursors.add(res.nextCursor);
        turnCursor = res.nextCursor;
      }

      if (turns.length === 0) {
        return [];
      }

      // Ensure chronological order if a server/mock returned descending turns.
      const firstTurnStart = turns[0]?.startedAt;
      const lastTurnStart = turns[turns.length - 1]?.startedAt;
      if (
        turns.length >= 2 &&
        typeof firstTurnStart === 'number' &&
        typeof lastTurnStart === 'number' &&
        firstTurnStart > lastTurnStart
      ) {
        turns.reverse();
      }

      // Fetch paginated items via thread/items/list to populate/replace summary turn items.
      try {
        const allEntries: CodexThreadItemEntry[] = [];
        const seenItemCursors = new Set<string>();
        let itemCursor: string | null = null;
        for (let page = 0; page < 200; page++) {
          const itemPage = await this.listItems(threadId, {
            cursor: itemCursor,
            sortDirection: 'asc',
          });
          allEntries.push(...itemPage.items);
          if (!itemPage.nextCursor || seenItemCursors.has(itemPage.nextCursor)) break;
          seenItemCursors.add(itemPage.nextCursor);
          itemCursor = itemPage.nextCursor;
        }

        if (allEntries.length > 0) {
          const byTurn = new Map<string, CodexThreadItem[]>();
          for (const entry of allEntries) {
            const tid = entry.turnId || (turns.length === 1 ? (turns[0]?.id ?? '') : '');
            if (!tid) continue;
            let list = byTurn.get(tid);
            if (!list) {
              list = [];
              byTurn.set(tid, list);
            }
            list.push(entry.item);
          }
          for (const turn of turns) {
            const loaded = byTurn.get(turn.id);
            if (loaded && loaded.length > 0) {
              turn.items = loaded;
            }
          }
        }
      } catch {
        // If thread/items/list is not stubbed or fails, keep the items already on `turns`.
      }

      return this.normalizeTurnHistory(turns);
    } catch (err) {
      // Unmaterialized new thread before first user message: try thread/read fallback,
      // and if still unmaterialized, return empty history.
      try {
        const raw = await this.request('thread/read', { threadId, includeTurns: true });
        const thread = ThreadReadResponseSchema.parse(raw).thread;
        return this.normalizeTurnHistory(thread.turns ?? []);
      } catch (fallbackErr) {
        const msg = err instanceof Error ? err.message : String(err);
        const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        if (/not materialized yet|no rollout found/i.test(msg) || /not materialized yet|no rollout found/i.test(fbMsg)) {
          return [];
        }
        throw fallbackErr;
      }
    }
  }

  /**
   * Start a turn (turn/start) with text input. Returns the turnId plus an
   * async-iterable event stream scoped to this turn; the stream terminates
   * after the 'turn-completed' event.
   */
  async startTurn(
    threadId: string,
    input: string | Array<Record<string, unknown>>,
    options: TurnStartOptions = {},
  ): Promise<CodexTurnHandle> {
    await this.connect();
    if (options.model) this.threadModels.set(threadId, options.model);
    if (options.effort) this.threadEfforts.set(threadId, options.effort);
    if (options.serviceTier !== undefined) this.threadServiceTiers.set(threadId, options.serviceTier);
    if (options.cwd) this.threadCwds.set(threadId, options.cwd);

    const items =
      typeof input === 'string' ? [{ type: 'text', text: input, text_elements: [] }] : input;
    const turn = await this.withThreadRetry(threadId, async () => {
      const raw = await this.request('turn/start', {
        threadId,
        input: items,
        model: options.model ?? null,
        effort: options.effort ?? null,
        ...(options.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
        ...(options.serviceTierForTurn !== undefined ? { serviceTierForTurn: options.serviceTierForTurn } : {}),
        ...(options.summary !== undefined ? { summary: options.summary } : {}),
        cwd: options.cwd ?? null,
        approvalPolicy: options.approvalPolicy ?? null,
        sandboxPolicy: options.sandboxPolicy ?? null,
        ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
        ...(options.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
        ...(options.collaborationMode !== undefined ? { collaborationMode: options.collaborationMode } : {}),
        clientUserMessageId: options.clientUserMessageId ?? null,
      });
      return TurnStartResponseSchema.parse(raw).turn;
    });
    const key = `${threadId}:${turn.id}`;
    const queue = new TurnEventQueue();
    this.turnQueues.set(key, queue);
    this.seenTurnStarts.add(key);
    // 合成的 turn-started 必须先进 queue:缓冲 drain 的事件才能按真实到达序跟在后面。
    const started: CodexEvent = { type: 'turn-started', threadId, turnId: turn.id, turn };
    queue.push(started);
    this.notifyListeners(started);
    this.lastTurnActivityAt = Date.now();
    // 注册前到达的同 chunk 事件(含可能的 turn/completed)按序补进 queue。
    const pending = this.pendingTurnEvents.get(key);
    if (pending) {
      this.pendingTurnEvents.delete(key);
      for (const ev of pending) {
        if (ev.type === 'turn-started') continue; // 服务器通知与合成事件重复
        queue.push(ev);
        if (ev.type === 'turn-completed') {
          this.seenTurnStarts.delete(key);
          queue.close();
          this.turnQueues.delete(key);
        }
      }
    }
    return { threadId, turnId: turn.id, turn, events: queue };
  }

  private async collectCursorPages<T>(
    method: string,
    buildParams: (cursor: string | null) => Record<string, unknown>,
    extract: (raw: unknown) => T[],
    maxPages = 50,
  ): Promise<T[]> {
    const out: T[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const raw = await this.request(method, buildParams(cursor));
      out.push(...extract(raw));
      const nextCursor = (raw as { nextCursor?: unknown })?.nextCursor;
      if (typeof nextCursor !== 'string' || !nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return out;
  }

  /**
   * List available models (model/list), following `nextCursor` across all pages.
   * Preserves 0.169.0 `serviceTiers`, `defaultServiceTier`, and `supportedReasoningEfforts` (`ultra` etc.).
   */
  async listModels(options?: {
    modelProvider?: string;
    includeHidden?: boolean;
    limit?: number;
  }): Promise<Array<Record<string, unknown>>> {
    await this.connect();
    return this.collectCursorPages(
      'model/list',
      (cursor) => {
        const params: Record<string, unknown> = {};
        if (cursor !== null) params.cursor = cursor;
        if (options?.modelProvider !== undefined) params.modelProvider = options.modelProvider;
        if (options?.includeHidden !== undefined) params.includeHidden = options.includeHidden;
        if (options?.limit !== undefined) params.limit = options.limit;
        return params;
      },
      (raw) => {
        const data = (raw as { data?: unknown })?.data;
        return Array.isArray(data)
          ? data.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'))
          : [];
      },
    );
  }

  /** Interrupt a running turn (turn/interrupt). */
  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.connect();
    await this.request('turn/interrupt', { threadId, turnId });
  }

  // -- 扩展 RPC(0.169.0 schema + 实测验证) ------------------------------------

  /**
   * 插话(turn/steer):向进行中的 turn 注入一条用户消息。
   * expectedTurnId 是前置条件,不匹配时服务端报错。
   */
  async steerTurn(
    threadId: string,
    turnId: string,
    input: string | Array<Record<string, unknown>>,
  ): Promise<void> {
    await this.connect();
    const items =
      typeof input === 'string' ? [{ type: 'text', text: input, text_elements: [] }] : input;
    await this.withThreadRetry(threadId, () =>
      this.request('turn/steer', {
        threadId,
        expectedTurnId: turnId,
        input: items,
      }),
    );
  }

  /**
   * 压缩会话(thread/compact/start)。
   * 在发起 RPC 之前先注册完成/错误监听器,消除响应与同帧 `contextCompaction` /
   * `thread/compacted` 通知的竞态;超时或失败显式 reject,绝不假报成功。
   */
  async compact(threadId: string, timeoutMs = 180_000): Promise<void> {
    await this.connect();
    let off: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completionAborted = false;

    const completion = new Promise<void>((resolve, reject) => {
      const failWith = (err: Error): void => {
        completionAborted = true;
        clearTimeout(timer);
        off();
        reject(err);
      };
      timer = setTimeout(() => {
        failWith(new Error(`codex thread compact timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      off = this.onEvent((ev) => {
        if (ev.type === 'disconnected') {
          failWith(new Error('codex app-server disconnected during thread compact'));
          return;
        }
        if (ev.type === 'error' && (!ev.threadId || ev.threadId === threadId) && ev.willRetry !== true) {
          failWith(new Error(ev.message || 'codex thread compact failed'));
          return;
        }
        if (ev.type === 'thread-compacted' && ev.threadId === threadId) {
          clearTimeout(timer);
          off();
          resolve();
          return;
        }
        if (ev.type === 'item-completed' && ev.threadId === threadId && ev.item?.type === 'contextCompaction') {
          clearTimeout(timer);
          off();
          resolve();
          return;
        }
        if (ev.type === 'turn-completed' && ev.threadId === threadId && ev.turn?.status === 'failed') {
          failWith(new Error(ev.error || ev.turn?.error?.message || 'codex thread compact turn failed'));
        }
      });
    });
    // Guard against unhandled rejection if the timer/disconnect rejects while withThreadRetry is still pending.
    completion.catch(() => undefined);

    try {
      await this.withThreadRetry(threadId, () =>
        this.request('thread/compact/start', { threadId }),
      );
    } catch (err) {
      clearTimeout(timer);
      off();
      throw err;
    }
    if (completionAborted) {
      await completion;
      return;
    }
    await completion;
  }

  /** 归档/取消归档(thread/archive|unarchive)。 */
  async setArchived(threadId: string, archived: boolean): Promise<void> {
    await this.connect();
    await this.request(archived ? 'thread/archive' : 'thread/unarchive', { threadId });
  }

  /** 删除线程(thread/delete)——真删,不可恢复。 */
  async deleteThread(threadId: string): Promise<void> {
    await this.connect();
    await this.request('thread/delete', { threadId });
    this.liveThreads.delete(threadId);
    this.unpersistedThreads.delete(threadId);
    this.threadModels.delete(threadId);
    this.threadEfforts.delete(threadId);
    this.threadServiceTiers.delete(threadId);
    this.threadCwds.delete(threadId);
  }

  /** 持久改名(thread/name/set;schema 里的 thread/setName 已实测不存在)。 */
  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.connect();
    await this.request('thread/name/set', { threadId, name });
  }

  /** 分叉线程(thread/fork),返回新 thread。 */
  async forkThread(threadId: string): Promise<Record<string, unknown>> {
    await this.connect();
    const raw = await this.request('thread/fork', { threadId });
    return (raw as { thread?: Record<string, unknown> }).thread ?? (raw as Record<string, unknown>);
  }

  private mapRevertError(err: unknown): ProviderError | null {
    if (err instanceof ProviderError) return err;
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /does not use paginated history|legacy history|unpaginated|only supports paginated threads|ephemeral threads do not support/i.test(
        msg,
      )
    ) {
      return new ProviderError(
        'unsupported',
        '该 Codex 会话不支持撤销（Codex 0.169.0 的 thread/revert 仅支持持久化分页历史会话，不支持旧版或临时会话）。',
        400,
        err,
      );
    }
    if (/not materialized yet|no rollout found/i.test(msg)) {
      return new ProviderError(
        'invalid_request',
        '当前会话尚未产生可撤销的对话轮次(turn)。',
        400,
        err,
      );
    }
    return null;
  }

  /**
   * Revert a paginated thread's durable history before `beforeTurnId`
   * (`thread/revert { threadId, beforeTurnId }` in Codex 0.169.0).
   */
  async revert(threadId: string, beforeTurnId: string): Promise<Record<string, unknown>> {
    if (!beforeTurnId || typeof beforeTurnId !== 'string') {
      throw new ProviderError('invalid_request', 'beforeTurnId 不能为空', 400);
    }
    await this.connect();
    return this.withThreadRetry(threadId, async () => {
      try {
        const raw = await this.request('thread/revert', { threadId, beforeTurnId });
        return (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      } catch (err) {
        const mapped = this.mapRevertError(err);
        if (mapped) throw mapped;
        throw err;
      }
    });
  }

  /**
   * 回滚最后 numTurns 轮:使用 Codex 0.169.0 的 `thread/turns/list` 定位目标
   * `beforeTurnId`，再调用 `thread/revert { threadId, beforeTurnId }`。
   * 对旧版非分页线程(legacy history)或无可撤销轮次显式报错，绝不静默假装成功。
   */
  async rollback(
    threadId: string,
    numTurns = 1,
    options?: { beforeTurnId?: string },
  ): Promise<void> {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new ProviderError('invalid_request', '回滚轮数必须为正整数', 400);
    }
    if (options?.beforeTurnId) {
      await this.revert(threadId, options.beforeTurnId);
      return;
    }
    await this.connect();
    await this.withThreadRetry(threadId, async () => {
      const turns: CodexTurn[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;

      try {
        while (turns.length < numTurns && seenCursors.size < 50) {
          const raw = await this.request('thread/turns/list', {
            threadId,
            cursor,
            limit: Math.max(numTurns + 5, 20),
            sortDirection: 'desc',
            itemsView: 'notLoaded',
          });
          const parsed = ThreadTurnsListResponseSchema.parse(raw);
          turns.push(...parsed.data);
          if (!parsed.nextCursor || seenCursors.has(parsed.nextCursor)) break;
          seenCursors.add(parsed.nextCursor);
          cursor = parsed.nextCursor;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/already in progress/i.test(msg) || /thread not found/i.test(msg)) {
          throw err;
        }
        const mapped = this.mapRevertError(err);
        if (mapped) throw mapped;
        // Only if the server explicitly reports unknown variant / method not found for
        // thread/turns/list (an older pre-0.169 binary), try legacy thread/rollback.
        if (/unknown variant [`']?thread\/turns\/list|method not found/i.test(msg)) {
          await this.request('thread/rollback', { threadId, numTurns });
          return;
        }
        throw err;
      }

      if (turns.length < numTurns) {
        throw new ProviderError(
          'invalid_request',
          `当前会话仅有 ${turns.length} 轮历史，无法撤销最后 ${numTurns} 轮。`,
          400,
        );
      }

      // If a mock returned ascending order (oldest -> newest by startedAt), reverse to newest-first.
      const firstStart = turns[0]?.startedAt;
      const lastStart = turns[turns.length - 1]?.startedAt;
      if (
        turns.length >= 2 &&
        typeof firstStart === 'number' &&
        typeof lastStart === 'number' &&
        firstStart < lastStart
      ) {
        turns.reverse();
      }

      if (turns.some((t) => t.status === 'inProgress')) {
        throw new ProviderError(
          'busy',
          '会话正忙：当前仍有进行中的 turn，请等待或打断后再执行撤销。',
          409,
        );
      }

      const targetTurn = turns[numTurns - 1];
      if (!targetTurn?.id) {
        throw new ProviderError('invalid_request', '无法解析要撤销的目标 turnId', 400);
      }

      try {
        await this.request('thread/revert', { threadId, beforeTurnId: targetTurn.id });
      } catch (err) {
        const mapped = this.mapRevertError(err);
        if (mapped) throw mapped;
        throw err;
      }
    });
  }

  /** 目标(thread/goal/set);objective/status 传 null 表示不改动该字段。 */
  async goalSet(
    threadId: string,
    objective?: string | null,
    status?: string | null,
    options?: { origin?: 'user' | 'automatic' | null; tokenBudget?: number | null },
  ): Promise<Record<string, unknown> | null> {
    await this.connect();
    const raw = await this.request('thread/goal/set', {
      threadId,
      objective: objective ?? null,
      status: status ?? null,
      ...(options?.origin !== undefined ? { origin: options.origin } : {}),
      ...(options?.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
    });
    return ((raw as { goal?: Record<string, unknown> | null }).goal ?? null) as Record<string, unknown> | null;
  }

  /** 目标回读(thread/goal/get),无目标返回 null。 */
  async goalGet(threadId: string): Promise<Record<string, unknown> | null> {
    await this.connect();
    const raw = await this.request('thread/goal/get', { threadId });
    return ((raw as { goal?: Record<string, unknown> | null }).goal ?? null) as Record<string, unknown> | null;
  }

  /** 目标清除(thread/goal/clear)。 */
  async goalClear(threadId: string): Promise<void> {
    await this.connect();
    await this.request('thread/goal/clear', { threadId });
  }

  /** Whether a `skills/changed` notification arrived since the last `listSkills` call. */
  isSkillsDirty(): boolean {
    return this.skillsDirty;
  }

  /** Monotonic counter incremented on every `skills/changed` notification. */
  getSkillsVersion(): number {
    return this.skillsVersion;
  }

  /** Return the last recorded serviceTier for a thread, if any. */
  getThreadServiceTier(threadId: string): string | null | undefined {
    return this.threadServiceTiers.get(threadId);
  }

  /**
   * 原生 skills 目录(skills/list):支持按会话 cwd 传入 `cwds` 并在收到
   * `skills/changed` 后自动带上 `forceReload: true`。
   */
  async listSkills(
    options?: string | { cwd?: string; cwds?: string[]; threadId?: string; forceReload?: boolean },
  ): Promise<Array<{ name: string; description: string; path: string; scope: string; enabled: boolean; cwd?: string }>> {
    await this.connect();
    let cwds: string[] | undefined;
    const startVersion = this.skillsVersion;
    let forceReload = this.skillsDirty;

    if (typeof options === 'string') {
      if (options.trim()) cwds = [options.trim()];
    } else if (options && typeof options === 'object') {
      if (Array.isArray(options.cwds) && options.cwds.length > 0) {
        cwds = options.cwds.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
      } else if (typeof options.cwd === 'string' && options.cwd.trim()) {
        cwds = [options.cwd.trim()];
      } else if (typeof options.threadId === 'string' && this.threadCwds.get(options.threadId)) {
        cwds = [this.threadCwds.get(options.threadId)!];
      }
      if (options.forceReload === true) forceReload = true;
    }

    const params: Record<string, unknown> = {};
    if (cwds && cwds.length > 0) params.cwds = cwds;
    if (forceReload) params.forceReload = true;

    const raw = await this.request('skills/list', params);
    if (this.skillsVersion === startVersion) {
      this.skillsDirty = false;
    }
    const groups = (raw as { data?: unknown }).data;
    const out: Array<{ name: string; description: string; path: string; scope: string; enabled: boolean; cwd?: string }> = [];
    if (!Array.isArray(groups)) return out;
    for (const g of groups as Record<string, unknown>[]) {
      const groupCwd = typeof g.cwd === 'string' ? g.cwd : undefined;
      for (const s of (g.skills as Record<string, unknown>[]) ?? []) {
        if (s.enabled === false) continue;
        if (typeof s.name !== 'string' || typeof s.path !== 'string') continue;
        out.push({
          name: s.name,
          description: typeof s.description === 'string' ? s.description : s.name,
          path: s.path,
          scope: typeof s.scope === 'string' ? s.scope : 'user',
          enabled: s.enabled !== false,
          ...(groupCwd ? { cwd: groupCwd } : {}),
        });
      }
    }
    return out;
  }

  /**
   * MCP 服务器状态(mcpServerStatus/list)，支持 `nextCursor` 自动翻页与
   * 0.169.0 / 0.171.0-alpha.5 的可选过滤参数(`detail`, `threadId`, `serverName`, `environmentId`)。
   */
  async mcpStatus(options?: {
    detail?: string;
    threadId?: string;
    serverName?: string;
    environmentId?: string;
    limit?: number;
  }): Promise<Array<Record<string, unknown>>> {
    await this.connect();
    return this.collectCursorPages(
      'mcpServerStatus/list',
      (cursor) => {
        const params: Record<string, unknown> = {};
        if (cursor !== null) params.cursor = cursor;
        if (options?.detail !== undefined) params.detail = options.detail;
        if (options?.threadId !== undefined) params.threadId = options.threadId;
        if (options?.serverName !== undefined) params.serverName = options.serverName;
        if (options?.environmentId !== undefined) params.environmentId = options.environmentId;
        if (options?.limit !== undefined) params.limit = options.limit;
        return params;
      },
      (raw) => {
        const data = (raw as { data?: unknown })?.data;
        return Array.isArray(data)
          ? data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
          : [];
      },
    );
  }

  /** 后台终端(thread/backgroundTerminals/list)，支持 `nextCursor` 翻页。 */
  async backgroundTerminals(threadId: string): Promise<Array<Record<string, unknown>>> {
    await this.connect();
    return this.collectCursorPages(
      'thread/backgroundTerminals/list',
      (cursor) => ({ threadId, cursor, limit: null }),
      (raw) => {
        const data = (raw as { data?: unknown })?.data;
        return Array.isArray(data)
          ? data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
          : [];
      },
    );
  }

  /** 线程有效模型:显式设置过的优先,否则读 config/read 的全局默认(缓存)。 */
  private async effectiveModel(threadId: string): Promise<string> {
    const explicit = this.threadModels.get(threadId);
    if (explicit) return explicit;
    if (!this.configModelCache) {
      const raw = (await this.request('config/read', {})) as { config?: { model?: unknown } };
      const m = raw?.config?.model;
      if (typeof m !== 'string' || !m) throw new Error('config/read 未返回 model');
      this.configModelCache = m;
    }
    return this.configModelCache;
  }

  async setCollaborationMode(
    threadId: string,
    mode: 'plan' | 'default',
    options?: { model?: string; reasoningEffort?: string | null; developerInstructions?: string | null },
  ): Promise<void> {
    await this.connect();
    const model = options?.model ?? (await this.effectiveModel(threadId));
    const reasoningEffort =
      options?.reasoningEffort !== undefined
        ? options.reasoningEffort
        : (this.threadEfforts.get(threadId) ?? null);
    await this.withThreadRetry(threadId, () =>
      this.request('thread/settings/update', {
        threadId,
        collaborationMode: {
          mode,
          settings: {
            model,
            reasoningEffort,
            developerInstructions: options?.developerInstructions ?? null,
          },
        },
      }),
    );
  }

  /**
   * 发起一次 review(review/start)。
   * - Codex 0.169.0 响应直接返回 `{ turn, reviewThreadId }`:立即关联 `reviewThreadId` 与
   *   `turn.id`，合成 `turn-started` 并排空注册前已到达的同帧事件。
   * - 兼容旧版(0.147.0 返回 `{}`):等待 `turn/started` 通知并在 30s 超时时报错。
   */
  async reviewTurn(
    threadId: string,
    options?: ReviewStartOptions & { timeoutMs?: number },
  ): Promise<CodexTurnHandle> {
    await this.connect();
    const queue = new TurnEventQueue();
    const trackedThreads = new Set<string>([threadId]);
    let resolvedReviewThreadId = threadId;
    let firstTurnId = '';
    let resolvedTurn: CodexTurn | undefined;
    let settled = false;
    let startAborted = false;
    let off: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveTurnStarted!: (turnId: string) => void;

    const cleanupTurnKeys = (turnId: string): void => {
      for (const tId of trackedThreads) {
        this.pendingTurnEvents.delete(`${tId}:${turnId}`);
        this.seenTurnStarts.delete(`${tId}:${turnId}`);
      }
    };

    const budget = options?.timeoutMs ?? 30_000;
    const turnStarted = new Promise<string>((resolve, reject) => {
      const failWith = (error: Error): void => {
        startAborted = true;
        clearTimeout(timer);
        off();
        if (firstTurnId) cleanupTurnKeys(firstTurnId);
        reject(error);
        queue.fail(error);
      };
      resolveTurnStarted = resolve;
      timer = setTimeout(() => {
        failWith(new Error(`review turn did not start within ${budget}ms`));
      }, budget);
      timer.unref?.();

      off = this.onEvent((ev) => {
        if (ev.type === 'disconnected') {
          failWith(new Error('codex app-server disconnected during review turn'));
          return;
        }
        if (!('threadId' in ev) || !ev.threadId || !trackedThreads.has(ev.threadId)) return;
        if (ev.type === 'turn-started') {
          if (!firstTurnId) {
            firstTurnId = ev.turnId;
            resolvedTurn = ev.turn;
            clearTimeout(timer);
            settled = true;
            resolve(ev.turnId);
            queue.push(ev);
          } else if (ev.turnId !== firstTurnId) {
            queue.push(ev);
          }
          return;
        }
        if (firstTurnId) queue.push(ev);
        if (ev.type === 'turn-completed') {
          off();
          cleanupTurnKeys(firstTurnId || ev.turnId);
          queue.close();
        }
      });
    });
    // Guard against unhandled rejection if timeout/disconnect fires while withThreadRetry is still pending.
    turnStarted.catch(() => undefined);

    const target: ReviewTargetOption = options?.target
      ? options.target
      : options?.instructions && options.instructions.trim()
        ? { type: 'custom', instructions: options.instructions.trim() }
        : { type: 'uncommittedChanges' };

    let raw: unknown;
    try {
      raw = await this.withThreadRetry(threadId, () =>
        this.request('review/start', {
          threadId,
          target,
          delivery: options?.delivery ?? 'inline',
        }),
      );
    } catch (err) {
      clearTimeout(timer);
      off();
      throw err;
    }

    if (startAborted) {
      await turnStarted;
    }

    const parsedResp = ReviewStartResponseSchema.safeParse(raw);
    if (parsedResp.success && parsedResp.data.turn) {
      const respTurn = parsedResp.data.turn;
      if (parsedResp.data.reviewThreadId) {
        resolvedReviewThreadId = parsedResp.data.reviewThreadId;
        trackedThreads.add(resolvedReviewThreadId);
      }
      if (!firstTurnId) {
        firstTurnId = respTurn.id;
        resolvedTurn = respTurn;
        clearTimeout(timer);
        this.seenTurnStarts.add(`${resolvedReviewThreadId}:${respTurn.id}`);
        const startedEv: CodexEvent = {
          type: 'turn-started',
          threadId: resolvedReviewThreadId,
          turnId: respTurn.id,
          turn: respTurn,
        };
        queue.push(startedEv);
        this.notifyListeners(startedEv);
        if (!settled) {
          settled = true;
          resolveTurnStarted(respTurn.id);
        }
        // Events that arrived in the same stdout chunk as the response were
        // buffered by emit() before this continuation ran; replay them in order.
        for (const tId of trackedThreads) {
          const key = `${tId}:${respTurn.id}`;
          const pending = this.pendingTurnEvents.get(key);
          if (!pending) continue;
          this.pendingTurnEvents.delete(key);
          for (const ev of pending) {
            if (ev.type === 'turn-started') continue;
            queue.push(ev);
            if (ev.type === 'turn-completed') {
              off();
              cleanupTurnKeys(respTurn.id);
              queue.close();
            }
          }
        }
      }
    } else if (parsedResp.success && parsedResp.data.reviewThreadId) {
      resolvedReviewThreadId = parsedResp.data.reviewThreadId;
      trackedThreads.add(resolvedReviewThreadId);
    }

    const turnId = await turnStarted;
    return {
      threadId,
      reviewThreadId: resolvedReviewThreadId,
      turnId,
      ...(resolvedTurn ? { turn: resolvedTurn } : {}),
      events: queue,
    };
  }
}

export default CodexAdapter;
