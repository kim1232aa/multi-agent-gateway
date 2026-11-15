import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Message, MessageContentPart } from './types.js';

export type TranscriptActivity = 'idle' | 'turn';

export interface LocalTranscriptQuery {
  agentId: string;
  beforeTurn?: string;
  afterTurn?: string;
  pageSize?: number;
}

export interface TranscriptFrame extends Record<string, unknown> {
  kind: 'text' | 'thinking' | 'tool' | 'notice';
  frameId: string;
}

export interface TranscriptStep {
  kind: 'step';
  stepId: string;
  turnId: string;
  ordinal: number;
  state: 'running' | 'completed' | 'interrupted' | 'failed';
  frames: TranscriptFrame[];
  startedAt?: string;
  endedAt?: string;
  phase?: string;
  parentToolUseId?: string;
  agentId?: string;
}

export interface TranscriptTurn {
  kind: 'turn';
  turnId: string;
  ordinal: number;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  origin: { kind: 'user' | 'other' };
  prompt?: string;
  attachmentIds?: string[];
  steps: TranscriptStep[];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  phase?: string;
  parentToolUseId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

export interface TranscriptAttachment extends Record<string, unknown> {
  attachmentId: string;
  mediaType: string;
  name?: string;
  size?: number;
  source?:
    | { kind: 'url'; url: string }
    | { kind: 'file'; fileId: string }
    | { kind: 'session_media'; fileId: string };
  placeholder?: string;
}

export interface TranscriptTask extends Record<string, unknown> {
  taskId: string;
  kind: 'shell' | 'subagent' | 'tool' | 'other';
  state: 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
  detached: boolean;
  description?: string;
  agentId?: string;
  parentToolUseId?: string;
  outputTail: string;
  startedAt?: string;
  endedAt?: string;
  resultSummary?: string;
  error?: string;
}

export interface InvalidateHistoryOptions {
  /** Freshly fetched persisted messages after undo/compact (optional). */
  messages?: readonly Message[];
  /** Activity reported on emitted reset snapshot (defaults to active turn presence). */
  activity?: TranscriptActivity;
  /** Whether to emit transcript.reset to active seeded subscribers (default true). */
  notify?: boolean;
  /** Explicit override for has_more_older on reset frames. */
  hasMoreOlder?: boolean;
  /** Clear recorded prompts as well (default false). */
  clearPrompts?: boolean;
  /** Clear recorded interactions as well (default false). */
  clearInteractions?: boolean;
  /** Optional invalidation reason (e.g. 'undo' | 'compact'). */
  reason?: string;
}

export interface FrameMeta {
  phase?: string;
  parentToolUseId?: string;
  agentId?: string;
  taskId?: string;
  agentRefs?: Array<{ agentId: string; role?: 'child' | 'member' }>;
}

export type TranscriptOperation = Record<string, unknown> & { op: string };
export type TranscriptEmission =
  | { type: 'transcript.reset'; payload: Record<string, unknown> }
  | { type: 'transcript.ops'; payload: Record<string, unknown> };

type TranscriptListener = (emission: TranscriptEmission) => void;

interface TranscriptBatch {
  seq: number;
  ops: TranscriptOperation[];
}

export interface TranscriptInteraction extends Record<string, unknown> {
  interactionId: string;
  interactionKind: 'approval' | 'question';
  toolCallId?: string;
  state: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'answered' | 'dismissed';
  request?: unknown;
  response?: unknown;
}

export interface TranscriptPrompt extends Record<string, unknown> {
  promptId: string;
  status: 'running' | 'queued' | 'blocked' | 'completed' | 'failed' | 'aborted';
  userMessageId?: string;
  content?: unknown;
  createdAt: string;
  finishedAt?: string;
  steeredAt?: string;
}

interface TranscriptSessionState {
  seq: number;
  lastResetSeq: number;
  generation: number;
  nextOrdinal: number;
  historyObserved: boolean;
  journal: TranscriptBatch[];
  subscribers: Set<TranscriptSubscriber>;
  activeTurns: Map<string, TranscriptTurn>;
  recentTurns: Map<string, TranscriptTurn>;
  /** 首次历史观察前(beginTurn 时 historyObserved=false)分配了 ordinal 的 turnId。
   *  这些 ordinal 可能与持久化历史撞号,首次成功观察时要重编号(见 rebase)。 */
  unbasedTurns: Set<string>;
  interactions: Map<string, TranscriptInteraction>;
  prompts: Map<string, TranscriptPrompt>;
  tasks: Map<string, TranscriptTask>;
  meta: Record<string, unknown>;
  plans: unknown[];
  toolSubagentLinks: Map<string, Set<string>>;
}

interface TranscriptSubscriber {
  closed: boolean;
  seeded: boolean;
  startSeq: number;
  baselineActiveItems: TranscriptTurn[];
  hasCompletedBaseline: boolean;
  baselineInteractions: TranscriptInteraction[];
  baselinePrompts: TranscriptPrompt[];
  pending: TranscriptBatch[];
  send: TranscriptListener;
}

export interface LocalTranscriptSubscription {
  seed(messages: readonly Message[], activity: TranscriptActivity, since?: number): void;
  close(): void;
}

const SHELL_TOOL_NAMES = new Set([
  'commandexecution',
  'exec_command',
  'shell_command',
  'local_shell_call',
  'run_terminal_command',
  'run_command',
  'execute_command',
  'powershell',
  'bash',
  'shell',
]);

const SUBAGENT_TOOL_NAMES = new Set([
  'spawn_agent',
  'spawn_subagent',
  'spawnagent',
  'spawnsubagent',
  'collabagenttoolcall',
  'collab_agent_tool_call',
  'collab_tool_call',
  'agent',
  'task',
  'subagent',
]);

const FILE_SEARCH_ALIASES: Record<string, string> = {
  read: 'Read',
  read_file: 'Read',
  view_file: 'Read',
  write: 'Write',
  write_file: 'Write',
  create_file: 'Write',
  edit: 'Edit',
  apply_patch: 'Edit',
  filechange: 'Edit',
  str_replace: 'Edit',
  replace_file: 'Edit',
  grep: 'Grep',
  grep_search: 'Grep',
  search_grep: 'Grep',
  find: 'Glob',
  find_by_name: 'Glob',
  find_files: 'Glob',
  list_dir: 'ListDir',
  listdir: 'ListDir',
};

/** Normalize tool name and input for Kimi Web 2.6.2 tool presentation. */
export function normalizeKimiWebTool(name: string, input: unknown): { name: string; input: unknown } {
  let parsedInput: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        parsedInput = JSON.parse(trimmed);
      } catch {
        // keep original string
      }
    }
  }

  const rawLower = (name ?? '').toLowerCase().replace(/[\s-]+/g, '_');

  // 1. Shell tool names -> 'Bash'
  if (name === 'Bash' || SHELL_TOOL_NAMES.has(rawLower) || SHELL_TOOL_NAMES.has(name)) {
    let normInput: Record<string, unknown>;
    if (typeof parsedInput === 'string') {
      normInput = { command: parsedInput };
    } else if (typeof parsedInput === 'object' && parsedInput !== null && !Array.isArray(parsedInput)) {
      const raw = parsedInput as Record<string, unknown>;
      const command = typeof raw.command === 'string'
        ? raw.command
        : typeof raw.cmd === 'string'
          ? raw.cmd
          : typeof raw.script === 'string'
            ? raw.script
            : raw.command !== undefined && raw.command !== null
              ? String(raw.command)
              : '';
      const cwd = raw.cwd ?? raw.workdir;
      normInput = {
        ...raw,
        command,
        ...(cwd !== undefined ? { cwd } : {}),
      };
    } else {
      normInput = { command: parsedInput !== undefined && parsedInput !== null ? String(parsedInput) : '' };
    }
    return { name: 'Bash', input: normInput };
  }

  // 2. Subagent tool names -> 'Agent'
  if (name === 'Agent' || SUBAGENT_TOOL_NAMES.has(rawLower) || SUBAGENT_TOOL_NAMES.has(name)) {
    let normInput: Record<string, unknown>;
    if (typeof parsedInput === 'string') {
      normInput = {
        description: parsedInput.split(/\r?\n/)[0]?.slice(0, 80) || parsedInput,
        prompt: parsedInput,
      };
    } else if (typeof parsedInput === 'object' && parsedInput !== null && !Array.isArray(parsedInput)) {
      const raw = parsedInput as Record<string, unknown>;
      const prompt = raw.prompt ?? raw.message;
      const fallbackDesc = typeof prompt === 'string' && prompt.trim()
        ? prompt.trim().split(/\r?\n/)[0]?.slice(0, 80)
        : undefined;
      const description = raw.description ?? raw.task_name ?? raw.task ?? raw.title ?? fallbackDesc;
      const subagentType = raw.subagent_type ?? raw.agent_type ?? raw.agent;
      normInput = {
        ...raw,
        ...(description !== undefined ? { description } : {}),
        ...(subagentType !== undefined ? { subagent_type: subagentType } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(raw.run_in_background !== undefined ? { run_in_background: raw.run_in_background } : {}),
      };
    } else {
      normInput = {};
    }
    return { name: 'Agent', input: normInput };
  }

  // 3. File / search aliases
  const mappedName = FILE_SEARCH_ALIASES[rawLower] ?? FILE_SEARCH_ALIASES[name];
  const targetName = mappedName ?? name;

  if (targetName === 'Read' || targetName === 'Write' || targetName === 'Edit') {
    let normInput: unknown = parsedInput;
    if (typeof parsedInput === 'string') {
      normInput = { path: parsedInput };
    } else if (typeof parsedInput === 'object' && parsedInput !== null && !Array.isArray(parsedInput)) {
      const raw = parsedInput as Record<string, unknown>;
      const pathVal = raw.path ?? raw.file_path;
      normInput = {
        ...raw,
        ...(pathVal !== undefined ? { path: pathVal } : {}),
      };
    }
    return { name: targetName, input: normInput };
  }

  if (targetName === 'Grep' || targetName === 'Glob') {
    let normInput: unknown = parsedInput;
    if (typeof parsedInput === 'string') {
      normInput = { pattern: parsedInput };
    } else if (typeof parsedInput === 'object' && parsedInput !== null && !Array.isArray(parsedInput)) {
      const raw = parsedInput as Record<string, unknown>;
      const pattern = raw.pattern ?? raw.query ?? raw.regex ?? raw.glob ?? raw.name;
      const pathVal = raw.path ?? raw.dir ?? raw.directory;
      normInput = {
        ...raw,
        ...(pattern !== undefined ? { pattern } : {}),
        ...(pathVal !== undefined ? { path: pathVal } : {}),
      };
    }
    return { name: targetName, input: normInput };
  }

  if (targetName === 'ListDir') {
    let normInput: unknown = parsedInput;
    if (typeof parsedInput === 'string') {
      normInput = { path: parsedInput };
    } else if (typeof parsedInput === 'object' && parsedInput !== null && !Array.isArray(parsedInput)) {
      const raw = parsedInput as Record<string, unknown>;
      const pathVal = raw.path ?? raw.dir ?? raw.directory;
      normInput = {
        ...raw,
        ...(pathVal !== undefined ? { path: pathVal } : {}),
      };
    }
    return { name: 'ListDir', input: normInput };
  }

  return { name: targetName, input: parsedInput };
}

/** Extract subagent ID from tool output (supports agent_id, subagent_id, JSON, and text). */
export function extractSubagentIdFromOutput(output: unknown): string | undefined {
  if (output === null || output === undefined) return undefined;

  if (typeof output === 'object') {
    if (Array.isArray(output)) {
      for (const item of output) {
        const found = extractSubagentIdFromOutput(item);
        if (found) return found;
      }
      return undefined;
    }
    const rec = output as Record<string, unknown>;
    const direct = rec.subagent_id
      ?? rec.agent_id
      ?? rec.subagentId
      ?? rec.agentId
      ?? rec.agent_thread_id
      ?? rec.agentThreadId
      ?? (Array.isArray(rec.receiverThreadIds) ? rec.receiverThreadIds[0] : undefined)
      ?? (Array.isArray(rec.receiver_thread_ids) ? rec.receiver_thread_ids[0] : undefined);
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    if (typeof rec.data === 'object' && rec.data !== null) {
      const found = extractSubagentIdFromOutput(rec.data);
      if (found) return found;
    }
    if (typeof rec.result === 'object' && rec.result !== null) {
      const found = extractSubagentIdFromOutput(rec.result);
      if (found) return found;
    }
    if (typeof rec.text === 'string') {
      const found = extractSubagentIdFromOutput(rec.text);
      if (found) return found;
    }
  }

  const text = typeof output === 'string' ? output : '';
  if (!text) return undefined;

  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed);
      const found = extractSubagentIdFromOutput(parsed);
      if (found) return found;
    } catch {
      // fallback to regex
    }
  }

  const match = /(?:subagent_id|agent_id|subagentId|agentId)["']?\s*[:=]\s*["'<]?([a-zA-Z0-9_\-\.]+)/i.exec(text);
  if (match?.[1]) {
    const id = match[1].replace(/^[<"']+|[>"',;\.]+$/g, '').trim();
    if (id) return id;
  }

  return undefined;
}

/** In-memory transcript-v2 journal for local Claude/Codex/Grok/Pi sessions. */
export class LocalTranscriptHub {
  private readonly sessions = new Map<string, TranscriptSessionState>();
  private readonly activeLocalTurns = new Map<string, LocalTranscriptTurn>();
  private static readonly JOURNAL_CAP = 200;

  currentSeq(sessionId: string): number {
    return this.state(sessionId).seq;
  }

  currentGeneration(sessionId: string): number {
    return this.state(sessionId).generation;
  }

  hasObservedHistory(sessionId: string): boolean {
    return this.state(sessionId).historyObserved;
  }

  observeHistory(sessionId: string, messages: readonly Message[]): void {
    const state = this.state(sessionId);
    state.historyObserved = true;
    const persistedTurns = historyTurns(messages).turns;
    state.nextOrdinal = Math.max(state.nextOrdinal, persistedTurns.length + 1);

    const trailingCount = Math.max(5, state.unbasedTurns.size * 2);
    const trailingPersisted = persistedTurns.slice(-trailingCount);

    for (const [turnId, turn] of [...state.recentTurns.entries()]) {
      // 当 unbasedTurns 中的已完成 turn 与新观察到的末尾持久化 turn prompt 匹配时,
      // 驱逐它而不是重编号为重复的 turn。
      if (state.unbasedTurns.has(turnId) && turn.state !== 'running') {
        const turnPrompt = turn.prompt?.trim();
        if (turnPrompt && trailingPersisted.some((pt) => pt.prompt?.trim() === turnPrompt)) {
          state.recentTurns.delete(turnId);
          state.unbasedTurns.delete(turnId);
          continue;
        }
      }
      // 未基准的 turn 不能按 ordinal 驱逐——它的 ordinal 是在历史未知时分配的,
      // 撞号不代表是同一个 turn;重编号后自然落到 persisted 之后。
      if (turn.ordinal <= persistedTurns.length && !state.unbasedTurns.has(turnId)) {
        state.recentTurns.delete(turnId);
      }
    }
    if (state.unbasedTurns.size > 0) this.rebaseUnbasedTurns(state);
  }

  linkSubagentToToolCall(sessionId: string, parentToolUseId: string, agentId: string): void {
    if (!parentToolUseId || !agentId) return;
    const state = this.state(sessionId);

    let set = state.toolSubagentLinks.get(parentToolUseId);
    if (!set) {
      set = new Set<string>();
      state.toolSubagentLinks.set(parentToolUseId, set);
    }
    set.add(agentId);

    for (const turn of [...state.activeTurns.values(), ...state.recentTurns.values()]) {
      for (const step of turn.steps) {
        for (const frame of step.frames) {
          if (frame.kind === 'tool' && frame.toolCallId === parentToolUseId) {
            const refs = Array.isArray(frame.agentRefs)
              ? (frame.agentRefs as Array<{ agentId: string; role?: 'child' | 'member' }>)
              : [];
            if (!refs.some((r) => r.agentId === agentId)) {
              frame.agentRefs = [...refs, { agentId, role: 'child' }];
              this.publish(sessionId, [{
                op: 'frame.upsert',
                turnId: turn.turnId,
                stepId: step.stepId,
                frame: { ...frame },
              }]);
            }
          }
        }
      }
    }
  }

  getLinkedSubagents(sessionId: string, toolCallId: string): string[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    const set = state.toolSubagentLinks.get(toolCallId);
    return set ? [...set] : [];
  }

  toolStarted(sessionId: string, toolCallId: string, name: string, input: unknown, meta?: FrameMeta): void {
    const active = this.activeLocalTurns.get(sessionId);
    if (active) {
      active.toolStarted(toolCallId, name, input, meta);
      return;
    }
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const runningTurn = [...state.activeTurns.values()].reverse().find((t) => t.state === 'running');
    if (runningTurn) {
      const localTurn = new LocalTranscriptTurn(this, sessionId, runningTurn);
      localTurn.toolStarted(toolCallId, name, input, meta);
    }
  }

  toolResult(
    sessionId: string,
    toolCallId: string,
    output: unknown,
    isError: boolean,
    extra?: { structuredOutput?: unknown } & FrameMeta,
  ): void {
    const active = this.activeLocalTurns.get(sessionId);
    if (active) {
      active.toolResult(toolCallId, output, isError, extra);
      return;
    }
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const runningTurn = [...state.activeTurns.values()].reverse().find((t) => t.state === 'running')
      ?? [...state.recentTurns.values()].reverse().find((t) => t.steps.some((s) => s.frames.some((f) => f.toolCallId === toolCallId)));
    if (runningTurn) {
      const localTurn = new LocalTranscriptTurn(this, sessionId, runningTurn);
      localTurn.toolResult(toolCallId, output, isError, extra);
    }
  }

  activeItems(sessionId: string): TranscriptTurn[] {
    const state = this.state(sessionId);
    return cloneTurns([...state.recentTurns.values(), ...state.activeTurns.values()]);
  }

  /**
   * 首次成功观察历史时,把历史未知期间分配了 ordinal 的 turn(可能撞号)
   * 就地改号到持久化历史之后,恢复 live.ordinal > persisted 不变量。
   * 就地改而不换对象:driveTurn 持有的 LocalTranscriptTurn 引用后续 op
   * 会自动用上新 turnId;journal 里已发布的旧号 op 同步重写,保证
   * catchup/seed 重放不出现旧号幽灵 turn。
   */
  private rebaseUnbasedTurns(state: TranscriptSessionState): void {
    const turnRemap = new Map<string, string>();
    const stepRemap = new Map<string, string>();
    const rebaseFrom = (map: Map<string, TranscriptTurn>): void => {
      const targets = [...map.values()]
        .filter((turn) => state.unbasedTurns.has(turn.turnId))
        .sort((a, b) => a.ordinal - b.ordinal);
      for (const turn of targets) {
        map.delete(turn.turnId);
        const oldTurnId = turn.turnId;
        turn.ordinal = state.nextOrdinal++;
        turn.turnId = `t${turn.ordinal}`;
        for (const step of turn.steps) {
          const oldStepId = step.stepId;
          step.turnId = turn.turnId;
          step.stepId = `${turn.turnId}.${step.ordinal}`;
          stepRemap.set(oldStepId, step.stepId);
          for (const frame of step.frames) {
            if (frame.frameId.startsWith(`${oldStepId}.`)) {
              frame.frameId = step.stepId + frame.frameId.slice(oldStepId.length);
            }
          }
        }
        turnRemap.set(oldTurnId, turn.turnId);
        map.set(turn.turnId, turn);
      }
    };
    rebaseFrom(state.activeTurns);
    rebaseFrom(state.recentTurns);
    state.unbasedTurns.clear();
    if (turnRemap.size > 0) this.rewriteJournalIds(state, turnRemap, stepRemap);
  }

  /** 重编号后把 journal 与未 seed 订阅方缓存里旧 turnId/stepId 改写到新号,重放不产生幽灵。 */
  private rewriteJournalIds(
    state: TranscriptSessionState,
    turnRemap: Map<string, string>,
    stepRemap: Map<string, string>,
  ): void {
    const mapFrameId = (frameId: string): string => {
      for (const [oldStepId, newStepId] of stepRemap) {
        if (frameId.startsWith(`${oldStepId}.`)) return newStepId + frameId.slice(oldStepId.length);
      }
      return frameId;
    };
    const rewriteTurnObj = (turn: TranscriptTurn | undefined): void => {
      if (!turn || typeof turn.turnId !== 'string' || !turnRemap.has(turn.turnId)) return;
      turn.turnId = turnRemap.get(turn.turnId) as string;
      turn.ordinal = Number.parseInt(turn.turnId.slice(1), 10);
      for (const step of turn.steps ?? []) {
        if (stepRemap.has(step.stepId)) {
          step.turnId = turn.turnId;
          step.stepId = stepRemap.get(step.stepId) as string;
        }
        for (const frame of step.frames ?? []) {
          if (typeof frame.frameId === 'string') frame.frameId = mapFrameId(frame.frameId);
        }
      }
    };
    const visitedBatches = new Set<TranscriptBatch>();
    const rewriteBatch = (batch: TranscriptBatch): void => {
      if (visitedBatches.has(batch)) return;
      visitedBatches.add(batch);
      for (const op of batch.ops) {
        if (typeof op.turnId === 'string' && turnRemap.has(op.turnId)) op.turnId = turnRemap.get(op.turnId);
        if (typeof op.stepId === 'string' && stepRemap.has(op.stepId)) op.stepId = stepRemap.get(op.stepId);
        // append op 的 id 在 target 里({type:'frame', turnId, stepId, frameId})。
        const target = op.target as { turnId?: unknown; stepId?: unknown; frameId?: unknown } | undefined;
        if (target) {
          if (typeof target.turnId === 'string' && turnRemap.has(target.turnId)) target.turnId = turnRemap.get(target.turnId);
          if (typeof target.stepId === 'string' && stepRemap.has(target.stepId)) target.stepId = stepRemap.get(target.stepId);
          if (typeof target.frameId === 'string') target.frameId = mapFrameId(target.frameId);
        }
        rewriteTurnObj(op.turn as TranscriptTurn | undefined);
        const step = op.step as TranscriptStep | undefined;
        if (step && typeof step.stepId === 'string' && stepRemap.has(step.stepId)) {
          if (typeof step.turnId === 'string' && turnRemap.has(step.turnId)) step.turnId = turnRemap.get(step.turnId) as string;
          step.stepId = stepRemap.get(step.stepId) as string;
        }
        const frame = op.frame as TranscriptFrame | undefined;
        if (frame && typeof frame.frameId === 'string') frame.frameId = mapFrameId(frame.frameId);
      }
    };

    for (const batch of state.journal) {
      rewriteBatch(batch);
    }
    for (const subscriber of state.subscribers) {
      for (const turn of subscriber.baselineActiveItems) {
        rewriteTurnObj(turn);
      }
      for (const batch of subscriber.pending) {
        rewriteBatch(batch);
      }
    }
  }

  currentInteractions(sessionId: string): TranscriptInteraction[] {
    return structuredClone([...this.state(sessionId).interactions.values()]) as TranscriptInteraction[];
  }

  currentPrompts(sessionId: string): TranscriptPrompt[] {
    return structuredClone([...this.state(sessionId).prompts.values()]) as TranscriptPrompt[];
  }

  currentTasks(sessionId: string): TranscriptTask[] {
    return structuredClone([...this.state(sessionId).tasks.values()]) as TranscriptTask[];
  }

  currentMeta(sessionId: string): Record<string, unknown> {
    return structuredClone(this.state(sessionId).meta) as Record<string, unknown>;
  }

  currentPlans(sessionId: string): unknown[] {
    return structuredClone(this.state(sessionId).plans) as unknown[];
  }

  mergeMeta(sessionId: string, meta: Record<string, unknown>): void {
    const state = this.state(sessionId);
    mergeMetaInto(state.meta, meta);
    this.publish(sessionId, [{ op: 'meta.merge', meta }]);
  }

  upsertTask(sessionId: string, task: TranscriptTask): void {
    const state = this.state(sessionId);
    state.tasks.set(task.taskId, structuredClone(task) as TranscriptTask);
    this.publish(sessionId, [{ op: 'task.upsert', task }]);
  }

  setPlans(sessionId: string, plans: readonly unknown[], modeMeta?: Record<string, unknown>): void {
    const state = this.state(sessionId);
    state.plans = structuredClone([...plans]) as unknown[];
    if (modeMeta !== undefined) {
      const meta = { modes: { plan: modeMeta } };
      mergeMetaInto(state.meta, meta);
      this.publish(sessionId, [{ op: 'meta.merge', meta }]);
    }
  }

  submitPrompt(
    sessionId: string,
    promptId: string,
    status: 'running' | 'queued' | 'blocked',
    content: unknown,
    createdAt = new Date().toISOString(),
  ): void {
    const state = this.state(sessionId);
    const previous = state.prompts.get(promptId);
    const prompt: TranscriptPrompt = {
      promptId,
      status,
      userMessageId: previous?.userMessageId ?? promptId,
      content,
      createdAt: previous?.createdAt ?? createdAt,
      ...(previous?.steeredAt === undefined ? {} : { steeredAt: previous.steeredAt }),
    };
    state.prompts.set(promptId, prompt);
    this.publish(sessionId, [{ op: 'prompt.upsert', prompt }]);
  }

  finishPrompt(
    sessionId: string,
    promptId: string,
    status: 'completed' | 'failed' | 'aborted',
    finishedAt = new Date().toISOString(),
  ): void {
    const state = this.state(sessionId);
    const previous = state.prompts.get(promptId);
    const prompt: TranscriptPrompt = {
      promptId,
      status,
      ...(previous?.userMessageId === undefined ? {} : { userMessageId: previous.userMessageId }),
      ...(previous?.content === undefined ? {} : { content: previous.content }),
      createdAt: previous?.createdAt ?? finishedAt,
      finishedAt,
      ...(previous?.steeredAt === undefined ? {} : { steeredAt: previous.steeredAt }),
    };
    state.prompts.set(promptId, prompt);
    this.publish(sessionId, [{ op: 'prompt.upsert', prompt }]);
  }

  steerPrompts(
    sessionId: string,
    activePromptId: string,
    promptIds: readonly string[],
    content: unknown,
    steeredAt = new Date().toISOString(),
  ): void {
    const state = this.state(sessionId);
    const ops: TranscriptOperation[] = [];
    const previousActive = state.prompts.get(activePromptId);
    const active: TranscriptPrompt = {
      promptId: activePromptId,
      status: previousActive?.status ?? 'running',
      ...(previousActive?.userMessageId === undefined ? {} : { userMessageId: previousActive.userMessageId }),
      content,
      createdAt: previousActive?.createdAt ?? steeredAt,
      ...(previousActive?.finishedAt === undefined ? {} : { finishedAt: previousActive.finishedAt }),
      steeredAt,
    };
    state.prompts.set(activePromptId, active);
    ops.push({ op: 'prompt.upsert', prompt: active });

    for (const promptId of promptIds) {
      const previous = state.prompts.get(promptId);
      const prompt: TranscriptPrompt = {
        promptId,
        status: 'completed',
        ...(previous?.userMessageId === undefined ? {} : { userMessageId: previous.userMessageId }),
        ...(previous?.content === undefined ? {} : { content: previous.content }),
        createdAt: previous?.createdAt ?? steeredAt,
        finishedAt: steeredAt,
        steeredAt,
      };
      state.prompts.set(promptId, prompt);
      ops.push({ op: 'prompt.upsert', prompt });
    }
    this.publish(sessionId, ops);
  }

  requestInteraction(sessionId: string, interaction: TranscriptInteraction): void {
    const state = this.state(sessionId);
    state.interactions.set(interaction.interactionId, interaction);
    this.publish(sessionId, [{ op: 'interaction.upsert', interaction }]);
  }

  resolveInteraction(
    sessionId: string,
    interactionId: string,
    stateName: TranscriptInteraction['state'],
    response: unknown,
  ): void {
    const state = this.state(sessionId);
    const interaction = state.interactions.get(interactionId);
    if (!interaction) return;
    const resolved = { ...interaction, state: stateName, response };
    state.interactions.set(interactionId, resolved);
    this.publish(sessionId, [{ op: 'interaction.upsert', interaction: resolved }]);
  }

  subscribe(sessionId: string, send: TranscriptListener): LocalTranscriptSubscription {
    const state = this.state(sessionId);
    const subscriber: TranscriptSubscriber = {
      closed: false,
      seeded: false,
      startSeq: state.seq,
      baselineActiveItems: cloneTurns([...state.activeTurns.values()]),
      hasCompletedBaseline: state.recentTurns.size > 0,
      baselineInteractions: structuredClone([...state.interactions.values()]) as TranscriptInteraction[],
      baselinePrompts: structuredClone([...state.prompts.values()]) as TranscriptPrompt[],
      pending: [],
      send,
    };
    state.subscribers.add(subscriber);

    return {
      seed: (messages, activity, since) => {
        if (subscriber.closed || subscriber.seeded) return;
        this.observeHistory(sessionId, messages);
        const catchup = since === undefined
          ? undefined
          : this.opsSince(state, since, subscriber.startSeq);
        if (catchup?.complete) {
          for (const batch of catchup.batches) send(opsEmission(batch));
        } else {
          const hasOlder = historyTurns(messages).turns.length > 0 || subscriber.hasCompletedBaseline;
          send({
            type: 'transcript.reset',
            payload: {
              type: 'transcript.reset',
              agent_id: 'main',
              snapshot: snapshotFromState(
                subscriber.baselineActiveItems,
                subscriber.baselineInteractions,
                subscriber.baselinePrompts,
                [...state.tasks.values()],
                state.meta,
                activity,
              ),
              has_more_older: hasOlder,
              seq: subscriber.startSeq,
            },
          });
        }
        subscriber.seeded = true;
        for (const batch of subscriber.pending) send(opsEmission(batch));
        subscriber.pending = [];
      },
      close: () => {
        subscriber.closed = true;
        subscriber.pending = [];
        state.subscribers.delete(subscriber);
      },
    };
  }

  getOpsSince(sessionId: string, since: number): {
    batches: TranscriptBatch[];
    latestSeq: number;
    complete: boolean;
  } {
    const state = this.sessions.get(sessionId);
    if (!state) return { batches: [], latestSeq: 0, complete: false };
    return this.opsSince(state, since, state.seq);
  }

  beginTurn(
    sessionId: string,
    prompt: string,
    startedAt = new Date().toISOString(),
    meta?: {
      origin?: TranscriptTurn['origin'];
      attachmentIds?: string[];
      phase?: string;
      parentToolUseId?: string;
      agentId?: string;
      metadata?: Record<string, unknown>;
    },
  ): LocalTranscriptTurn {
    const state = this.state(sessionId);
    const ordinal = state.nextOrdinal++;
    const turn: TranscriptTurn = {
      kind: 'turn',
      turnId: `t${ordinal}`,
      ordinal,
      state: 'running',
      origin: meta?.origin ?? { kind: 'user' },
      prompt,
      ...(meta?.attachmentIds && meta.attachmentIds.length > 0 ? { attachmentIds: [...meta.attachmentIds] } : {}),
      ...(meta?.phase ? { phase: meta.phase } : {}),
      ...(meta?.parentToolUseId ? { parentToolUseId: meta.parentToolUseId } : {}),
      ...(meta?.agentId ? { agentId: meta.agentId } : {}),
      ...(meta?.metadata ? { metadata: structuredClone(meta.metadata) as Record<string, unknown> } : {}),
      steps: [],
      startedAt,
    };
    // 历史还没观察到就分配 ordinal(首次拉取失败窗口):与持久化历史撞号
    // 的风险记入 unbasedTurns,首次成功观察时重编号。
    if (!state.historyObserved) state.unbasedTurns.add(turn.turnId);
    state.activeTurns.set(turn.turnId, turn);
    this.mergeMeta(sessionId, { activity: 'turn' });
    this.publish(sessionId, [{ op: 'turn.upsert', turn: turnHeader(turn) }]);
    const localTurn = new LocalTranscriptTurn(this, sessionId, turn);
    this.activeLocalTurns.set(sessionId, localTurn);
    return localTurn;
  }

  publish(sessionId: string, ops: TranscriptOperation[]): void {
    if (ops.length === 0) return;
    const state = this.state(sessionId);
    const batch = { seq: ++state.seq, ops };
    state.journal.push(batch);
    if (state.journal.length > LocalTranscriptHub.JOURNAL_CAP) {
      state.journal.splice(0, state.journal.length - LocalTranscriptHub.JOURNAL_CAP);
    }
    for (const subscriber of state.subscribers) {
      if (subscriber.closed) continue;
      if (subscriber.seeded) subscriber.send(opsEmission(batch));
      else subscriber.pending.push(batch);
    }
  }

  finishTurn(sessionId: string, turn: TranscriptTurn): void {
    const state = this.state(sessionId);
    state.activeTurns.delete(turn.turnId);
    state.recentTurns.set(turn.turnId, cloneTurns([turn])[0]);
    if (state.recentTurns.size > 20) {
      const oldest = state.recentTurns.keys().next().value as string | undefined;
      if (oldest) state.recentTurns.delete(oldest);
    }
    if (this.activeLocalTurns.get(sessionId)?.turnId === turn.turnId) {
      this.activeLocalTurns.delete(sessionId);
    }
  }

  drop(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const subscriber of state.subscribers) subscriber.closed = true;
    this.sessions.delete(sessionId);
    this.activeLocalTurns.delete(sessionId);
  }

  /**
   * undo/compact 后使旧投影失效并协调活跃订阅方:
   * - 保持 seq 严格单调递增并设置 lastResetSeq 边界,防止失效前游标误判为 complete;
   * - 若传入新鲜历史 messages 则立刻重新 observeHistory(含在途 turn 重编号);
   * - 清理未 seed 订阅方挂起的过期批并更新其基线,向已 seed 订阅方推送包含当前
   *   activeTurns 的 `transcript.reset`(除非 options.notify === false)。
   */
  invalidateHistory(sessionId: string, options?: InvalidateHistoryOptions): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.generation += 1;
    state.historyObserved = false;
    state.recentTurns.clear();
    state.unbasedTurns.clear();
    let maxActiveOrdinal = 0;
    for (const [turnId, turn] of state.activeTurns) {
      state.unbasedTurns.add(turnId);
      if (turn.ordinal > maxActiveOrdinal) maxActiveOrdinal = turn.ordinal;
    }
    state.journal = [];
    state.seq += 1;
    state.lastResetSeq = state.seq;
    state.nextOrdinal = options?.messages !== undefined ? 1 : maxActiveOrdinal + 1;
    if (options?.clearPrompts) state.prompts.clear();
    if (options?.clearInteractions) state.interactions.clear();

    if (options?.messages !== undefined) {
      this.observeHistory(sessionId, options.messages);
    }

    const activity: TranscriptActivity = options?.activity ?? (state.activeTurns.size > 0 ? 'turn' : 'idle');
    const activeList = cloneTurns([...state.activeTurns.values()]);
    const hasMoreOlder = options?.hasMoreOlder
      ?? (options?.messages !== undefined
        ? historyTurns(options.messages).turns.length > 0
        : true);

    const notify = options?.notify !== false;
    const interactions = [...state.interactions.values()];
    const prompts = [...state.prompts.values()];
    const tasks = [...state.tasks.values()];

    for (const subscriber of state.subscribers) {
      if (subscriber.closed) continue;
      subscriber.pending = [];
      subscriber.startSeq = state.seq;
      subscriber.baselineActiveItems = cloneTurns(activeList);
      subscriber.hasCompletedBaseline = false;
      subscriber.baselineInteractions = structuredClone(interactions) as TranscriptInteraction[];
      subscriber.baselinePrompts = structuredClone(prompts) as TranscriptPrompt[];
      if (subscriber.seeded && notify) {
        subscriber.send({
          type: 'transcript.reset',
          payload: {
            type: 'transcript.reset',
            agent_id: 'main',
            snapshot: snapshotFromState(activeList, interactions, prompts, tasks, state.meta, activity),
            has_more_older: hasMoreOlder,
            seq: state.seq,
            ...(options?.reason ? { reason: options.reason } : {}),
          },
        });
      }
    }
  }

  private state(sessionId: string): TranscriptSessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        seq: 0,
        lastResetSeq: 0,
        generation: 0,
        nextOrdinal: 1,
        historyObserved: false,
        journal: [],
        subscribers: new Set(),
        activeTurns: new Map(),
        recentTurns: new Map(),
        unbasedTurns: new Set(),
        interactions: new Map(),
        prompts: new Map(),
        tasks: new Map(),
        meta: {},
        plans: [],
        toolSubagentLinks: new Map(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private opsSince(
    state: TranscriptSessionState,
    since: number,
    through: number,
  ): { batches: TranscriptBatch[]; latestSeq: number; complete: boolean } {
    if (!Number.isInteger(since) || since < 0 || since > through || since < state.lastResetSeq) {
      return { batches: [], latestSeq: through, complete: false };
    }
    const batches = state.journal.filter((batch) => batch.seq > since && batch.seq <= through);
    const complete = since === through || batches[0]?.seq === since + 1;
    return { batches, latestSeq: through, complete };
  }
}

export class LocalTranscriptTurn {
  private stepOrdinal = 0;
  private noticeOrdinal = 0;
  private step: TranscriptStep | undefined;
  private streamText = new Map<string, string>();
  private readonly tools = new Map<string, TranscriptFrame>();
  private ended = false;

  constructor(
    private readonly hub: LocalTranscriptHub,
    private readonly sessionId: string,
    private readonly turn: TranscriptTurn,
  ) {}

  get ordinal(): number {
    return this.turn.ordinal;
  }

  get turnId(): string {
    return this.turn.turnId;
  }

  append(kind: 'assistant' | 'thinking', text: string, meta?: FrameMeta): void {
    if (!text || this.ended) return;
    const step = this.ensureStep(meta);
    const suffix = streamKeySuffix(meta);
    const streamKey = suffix ? `${kind}.${suffix}` : kind;
    const frameId = `${step.stepId}.${streamKey}`;
    const current = this.streamText.get(streamKey) ?? '';
    if (current.length === 0) {
      const frame: TranscriptFrame = kind === 'assistant'
        ? { kind: 'text', frameId, role: 'assistant', text: '', ...compactFrameMeta(meta) }
        : { kind: 'thinking', frameId, text: '', ...compactFrameMeta(meta) };
      step.frames.push(frame);
      this.hub.publish(this.sessionId, [{ op: 'frame.upsert', turnId: this.turn.turnId, stepId: step.stepId, frame }]);
    }
    this.hub.publish(this.sessionId, [{
      op: 'append',
      target: { type: 'frame', turnId: this.turn.turnId, stepId: step.stepId, frameId },
      offset: current.length,
      text,
    }]);
    const next = current + text;
    this.streamText.set(streamKey, next);
    const frame = step.frames.find((item) => item.frameId === frameId);
    if (frame) frame.text = next;
  }

  notice(
    message: string,
    options?: { level?: 'info' | 'warning' | 'error'; source?: string; detail?: unknown } & FrameMeta,
  ): void {
    if (!message || this.ended) return;
    const step = this.ensureStep(options);
    const frameId = `${step.stepId}.notice.${++this.noticeOrdinal}`;
    const frame: TranscriptFrame = {
      kind: 'notice',
      frameId,
      level: options?.level ?? 'info',
      ...(options?.source ? { source: options.source } : {}),
      message,
      ...(options?.detail !== undefined ? { detail: options.detail } : {}),
      ...compactFrameMeta(options),
    };
    step.frames.push(frame);
    this.hub.publish(this.sessionId, [{ op: 'frame.upsert', turnId: this.turn.turnId, stepId: step.stepId, frame }]);
  }

  setPhase(phase: Record<string, unknown> | string): void {
    if (this.ended) return;
    const patch = typeof phase === 'string'
      ? { agent: { phase: { kind: phase } } }
      : { agent: { phase } };
    this.hub.mergeMeta(this.sessionId, patch);
  }

  toolStarted(toolCallId: string, name: string, input: unknown, meta?: FrameMeta): void {
    if (this.ended) return;
    const normalized = normalizeKimiWebTool(name, input);
    const step = this.ensureStep(meta);
    const agentRefs = meta?.agentRefs
      ? [...meta.agentRefs]
      : (meta?.agentId && meta.agentId !== 'main' ? [{ agentId: meta.agentId, role: 'child' as const }] : []);

    const linkedAgents = this.hub.getLinkedSubagents(this.sessionId, toolCallId);
    for (const linkedId of linkedAgents) {
      if (!agentRefs.some((r) => r.agentId === linkedId)) {
        agentRefs.push({ agentId: linkedId, role: 'child' });
      }
    }

    if (normalized.name === 'Agent') {
      const inputSubagentId = extractSubagentIdFromOutput(normalized.input);
      if (inputSubagentId && !agentRefs.some((r) => r.agentId === inputSubagentId)) {
        agentRefs.push({ agentId: inputSubagentId, role: 'child' });
        this.hub.linkSubagentToToolCall(this.sessionId, toolCallId, inputSubagentId);
      }
    }

    if (meta?.parentToolUseId && meta?.agentId && meta.agentId !== 'main') {
      this.hub.linkSubagentToToolCall(this.sessionId, meta.parentToolUseId, meta.agentId);
    }

    const frame: TranscriptFrame = {
      kind: 'tool',
      frameId: `${step.stepId}.${toolCallId}`,
      toolCallId,
      name: normalized.name,
      state: 'running',
      input: normalized.input,
      ...compactFrameMeta(meta),
      ...(agentRefs.length > 0 ? { agentRefs } : {}),
    };
    this.tools.set(toolCallId, frame);
    step.frames.push(frame);
    this.hub.publish(this.sessionId, [{ op: 'frame.upsert', turnId: this.turn.turnId, stepId: step.stepId, frame }]);
  }

  toolResult(
    toolCallId: string,
    output: unknown,
    isError: boolean,
    extra?: { structuredOutput?: unknown } & FrameMeta,
  ): void {
    if (this.ended) return;
    const step = this.ensureStep(extra);
    const existing = this.tools.get(toolCallId);
    const resolvedOutput = output === '' && extra?.structuredOutput !== undefined
      ? extra.structuredOutput
      : output;
    const agentRefs = extra?.agentRefs
      ? [...extra.agentRefs]
      : (extra?.agentId && extra.agentId !== 'main' ? [{ agentId: extra.agentId, role: 'child' as const }] : []);

    if (existing?.agentRefs && Array.isArray(existing.agentRefs)) {
      for (const ref of existing.agentRefs as Array<{ agentId: string; role?: 'child' | 'member' }>) {
        if (!agentRefs.some((r) => r.agentId === ref.agentId)) {
          agentRefs.push(ref);
        }
      }
    }

    const linkedAgents = this.hub.getLinkedSubagents(this.sessionId, toolCallId);
    for (const linkedId of linkedAgents) {
      if (!agentRefs.some((r) => r.agentId === linkedId)) {
        agentRefs.push({ agentId: linkedId, role: 'child' });
      }
    }

    const extractedId = extractSubagentIdFromOutput(resolvedOutput)
      ?? extractSubagentIdFromOutput(extra?.structuredOutput);
    if (extractedId && !agentRefs.some((r) => r.agentId === extractedId)) {
      agentRefs.push({ agentId: extractedId, role: 'child' });
      this.hub.linkSubagentToToolCall(this.sessionId, toolCallId, extractedId);
    }

    if (extra?.parentToolUseId && extra?.agentId && extra.agentId !== 'main') {
      this.hub.linkSubagentToToolCall(this.sessionId, extra.parentToolUseId, extra.agentId);
    }

    const frame: TranscriptFrame = {
      ...(existing ?? {
        kind: 'tool',
        frameId: `${step.stepId}.${toolCallId}`,
        toolCallId,
        name: 'tool',
      }),
      state: isError ? 'error' : 'done',
      output: resolvedOutput,
      ...(extra?.structuredOutput !== undefined && extra.structuredOutput !== resolvedOutput
        ? { structuredOutput: extra.structuredOutput }
        : {}),
      ...(isError ? { error: toolErrorText(resolvedOutput) } : {}),
      ...compactFrameMeta(extra),
      ...(agentRefs.length > 0 ? { agentRefs } : {}),
    };
    this.tools.set(toolCallId, frame);
    const frameIndex = step.frames.findIndex((item) => item.frameId === frame.frameId);
    if (frameIndex === -1) step.frames.push(frame);
    else step.frames[frameIndex] = frame;
    this.hub.publish(this.sessionId, [{ op: 'frame.upsert', turnId: this.turn.turnId, stepId: step.stepId, frame }]);
  }

  completeStep(state: 'completed' | 'interrupted' | 'failed' = 'completed'): void {
    if (!this.step || this.step.state !== 'running') return;
    const step = this.step;
    const ops: TranscriptOperation[] = [];
    for (const frame of step.frames) {
      if (frame.kind === 'text' || frame.kind === 'thinking') {
        ops.push({ op: 'frame.upsert', turnId: this.turn.turnId, stepId: step.stepId, frame: { ...frame } });
      }
    }
    step.state = state;
    step.endedAt = new Date().toISOString();
    ops.push({ op: 'step.upsert', turnId: this.turn.turnId, step: stepHeader(step) });
    this.hub.publish(this.sessionId, ops);
    this.step = undefined;
    this.streamText.clear();
    this.tools.clear();
  }

  end(reason: 'completed' | 'failed' | 'cancelled', durationMs?: number): void {
    if (this.ended) return;
    this.completeStep(reason === 'completed' ? 'completed' : 'interrupted');
    this.ended = true;
    this.turn.state = reason;
    this.turn.endedAt = new Date().toISOString();
    if (durationMs !== undefined) this.turn.durationMs = durationMs;
    this.hub.publish(this.sessionId, [{ op: 'turn.upsert', turn: turnHeader(this.turn) }]);
    this.hub.mergeMeta(this.sessionId, { activity: 'idle' });
    this.hub.finishTurn(this.sessionId, this.turn);
  }

  private ensureStep(meta?: FrameMeta): TranscriptStep {
    if (this.step) return this.step;
    const ordinal = ++this.stepOrdinal;
    this.step = {
      kind: 'step',
      stepId: `${this.turn.turnId}.${ordinal}`,
      turnId: this.turn.turnId,
      ordinal,
      state: 'running',
      frames: [],
      startedAt: new Date().toISOString(),
      ...(meta?.phase ? { phase: meta.phase } : {}),
      ...(meta?.parentToolUseId ? { parentToolUseId: meta.parentToolUseId } : {}),
      ...(meta?.agentId ? { agentId: meta.agentId } : {}),
    };
    this.turn.steps.push(this.step);
    this.hub.publish(this.sessionId, [{ op: 'step.upsert', turnId: this.turn.turnId, step: stepHeader(this.step) }]);
    return this.step;
  }
}

export interface LocalTranscriptPage {
  agent_id: string;
  items: TranscriptTurn[];
  has_more: boolean;
  tasks: unknown[];
  interactions: unknown[];
  attachments: unknown[];
  todos: unknown[];
  prompts: unknown[];
  meta: { activity: TranscriptActivity; [key: string]: unknown };
  agents: Array<{ agentId: string; type: 'main' | 'subagent' | string }>;
  pending_interactions: string[];
  seq: number;
  plans?: unknown[];
}

/** Convert provider history into the turn-shaped transcript consumed by Kimi Web. */
export function buildLocalTranscriptPage(
  messages: readonly Message[],
  query: LocalTranscriptQuery,
  activity: TranscriptActivity,
  seq: number,
  liveItems: readonly TranscriptTurn[] = [],
  interactions: readonly TranscriptInteraction[] = [],
  prompts: readonly TranscriptPrompt[] = [],
  extras?: {
    tasks?: readonly TranscriptTask[];
    meta?: Record<string, unknown>;
    plans?: readonly unknown[];
  },
): LocalTranscriptPage {
  const { turns: persisted, attachments, subagentIds, plans: historyPlans } = historyTurns(messages);
  const persistedIds = new Set(persisted.map((turn) => turn.turnId));
  const turns = [...persisted, ...cloneTurns(liveItems).filter((turn) => !persistedIds.has(turn.turnId))]
    .sort((a, b) => a.ordinal - b.ordinal);
  const pageSize = clampPageSize(query.pageSize);
  const beforeOrdinal = turnOrdinal(query.beforeTurn);
  const afterOrdinal = turnOrdinal(query.afterTurn);

  let candidates = turns;
  let direction: 'older' | 'newer' = 'older';
  if (afterOrdinal !== undefined) {
    candidates = turns.filter((turn) => turn.ordinal > afterOrdinal);
    direction = 'newer';
  } else if (beforeOrdinal !== undefined) {
    candidates = turns.filter((turn) => turn.ordinal < beforeOrdinal);
  }

  const items = direction === 'newer'
    ? candidates.slice(0, pageSize)
    : candidates.slice(-pageSize);

  const discoveredAgents = new Set<string>(subagentIds);
  for (const turn of liveItems) {
    if (turn.agentId && turn.agentId !== 'main') discoveredAgents.add(turn.agentId);
    for (const step of turn.steps) {
      if (step.agentId && step.agentId !== 'main') discoveredAgents.add(step.agentId);
      for (const frame of step.frames) {
        if (typeof frame.agentId === 'string' && frame.agentId && frame.agentId !== 'main') {
          discoveredAgents.add(frame.agentId);
        }
      }
    }
  }
  const tasks = extras?.tasks ? structuredClone([...extras.tasks]) as TranscriptTask[] : [];
  for (const task of tasks) {
    if (task.agentId && task.agentId !== 'main') discoveredAgents.add(task.agentId);
  }
  const agents: Array<{ agentId: string; type: 'main' | 'subagent' | string }> = [
    { agentId: 'main', type: 'main' },
    ...[...discoveredAgents].map((agentId) => ({ agentId, type: 'subagent' as const })),
  ];

  const meta: { activity: TranscriptActivity; [key: string]: unknown } = {
    ...(extras?.meta ? (structuredClone(extras.meta) as Record<string, unknown>) : {}),
    activity,
  };
  const allPlans = [...historyPlans, ...(extras?.plans ?? [])];

  return {
    agent_id: query.agentId,
    items,
    has_more: candidates.length > items.length && items.length > 0,
    tasks,
    interactions: structuredClone([...interactions]) as TranscriptInteraction[],
    attachments,
    todos: [],
    prompts: structuredClone([...prompts]) as TranscriptPrompt[],
    meta,
    agents,
    pending_interactions: interactions.filter((item) => item.state === 'pending').map((item) => item.interactionId),
    seq,
    ...(allPlans.length > 0 ? { plans: structuredClone(allPlans) as unknown[] } : {}),
  };
}

function historyTurns(messages: readonly Message[]): {
  turns: TranscriptTurn[];
  attachments: TranscriptAttachment[];
  subagentIds: string[];
  plans: unknown[];
} {
  const ordered = messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => timestamp(a.message.created_at) - timestamp(b.message.created_at) || a.index - b.index)
    .map(({ message }) => message);

  const turns: TranscriptTurn[] = [];
  const attachmentsById = new Map<string, TranscriptAttachment>();
  const subagentIds = new Set<string>();
  const plans: unknown[] = [];
  let current: TranscriptTurn | undefined;

  const collectAttachments = (message: Message): string[] => {
    const ids: string[] = [];
    message.content.forEach((part, index) => {
      const att = toTranscriptAttachment(message.id, index, part);
      if (att) {
        attachmentsById.set(att.attachmentId, att);
        ids.push(att.attachmentId);
      }
    });
    return ids;
  };

  for (const message of ordered) {
    const meta = messageMeta(message);
    if (meta.agentId && meta.agentId !== 'main') subagentIds.add(meta.agentId);
    if (message.metadata?.plan !== undefined) plans.push(message.metadata.plan);

    const isBashCard = Boolean(message.metadata?.bash_card);
    const prompt = messageText(message.content);
    const hasMedia = message.content.some((part) =>
      part.type === 'image' || part.type === 'file' || part.type === 'document' || part.type === 'audio');
    const isToolOnlyUser = message.role === 'user' && !prompt && !hasMedia && message.content.some((part) =>
      part.type === 'tool_result' || part.type === 'tool_use' || part.type === 'tool_call');
    if (message.role === 'user' && !isToolOnlyUser && !isBashCard) {
      const attachmentIds = collectAttachments(message);
      current = newTurn(turns.length + 1, 'user', message.created_at, prompt, attachmentIds, meta);
      turns.push(current);
      continue;
    }
    if (current === undefined) {
      current = newTurn(turns.length + 1, 'other', message.created_at, undefined, undefined, meta);
      turns.push(current);
    }

    collectAttachments(message);
    const frames = contentFrames(message);
    for (const frame of frames) {
      if (typeof frame.agentId === 'string' && frame.agentId && frame.agentId !== 'main') {
        subagentIds.add(frame.agentId);
      }
      if (Array.isArray(frame.agentRefs)) {
        for (const ref of frame.agentRefs as Array<{ agentId: string }>) {
          if (ref?.agentId && ref.agentId !== 'main') {
            subagentIds.add(ref.agentId);
          }
        }
      }
      if (frame.kind === 'tool' && frame.toolCallId && Array.isArray(frame.agentRefs) && frame.agentRefs.length > 0) {
        for (const step of current.steps) {
          for (const priorFrame of step.frames) {
            if (priorFrame.kind === 'tool' && priorFrame.toolCallId === frame.toolCallId) {
              const priorRefs = (priorFrame.agentRefs as Array<{ agentId: string; role?: 'child' | 'member' }>) ?? [];
              for (const ref of frame.agentRefs as Array<{ agentId: string; role?: 'child' | 'member' }>) {
                if (!priorRefs.some((r) => r.agentId === ref.agentId)) {
                  priorRefs.push(ref);
                }
              }
              if (priorRefs.length > 0) priorFrame.agentRefs = priorRefs;
            }
          }
        }
      }
    }
    if (meta.parentToolUseId && meta.agentId && meta.agentId !== 'main') {
      for (const turn of turns) {
        for (const step of turn.steps) {
          for (const f of step.frames) {
            if (f.kind === 'tool' && f.toolCallId === meta.parentToolUseId) {
              const refs = (f.agentRefs as Array<{ agentId: string; role?: 'child' | 'member' }>) ?? [];
              if (!refs.some((r) => r.agentId === meta.agentId)) {
                f.agentRefs = [...refs, { agentId: meta.agentId, role: 'child' }];
              }
            }
          }
        }
      }
    }
    const isError = message.metadata?.is_error === true;
    if (frames.length > 0) {
      const ordinal = current.steps.length + 1;
      current.steps.push({
        kind: 'step',
        stepId: `${current.turnId}.${ordinal}`,
        turnId: current.turnId,
        ordinal,
        state: isError ? 'failed' : 'completed',
        frames,
        startedAt: message.created_at,
        endedAt: message.created_at,
        ...(meta.phase ? { phase: meta.phase } : {}),
        ...(meta.parentToolUseId ? { parentToolUseId: meta.parentToolUseId } : {}),
        ...(meta.agentId ? { agentId: meta.agentId } : {}),
      });
    }
    if (isError) current.state = 'failed';
    current.endedAt = message.created_at;
    current.durationMs = durationMs(current.startedAt, current.endedAt);
  }

  return {
    turns,
    attachments: [...attachmentsById.values()],
    subagentIds: [...subagentIds],
    plans,
  };
}

function newTurn(
  ordinal: number,
  origin: 'user' | 'other',
  startedAt: string,
  prompt?: string,
  attachmentIds?: string[],
  meta?: FrameMeta,
): TranscriptTurn {
  return {
    kind: 'turn',
    turnId: `t${ordinal}`,
    ordinal,
    state: 'completed',
    origin: { kind: origin },
    ...(prompt === undefined ? {} : { prompt }),
    ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
    ...(meta?.phase ? { phase: meta.phase } : {}),
    ...(meta?.parentToolUseId ? { parentToolUseId: meta.parentToolUseId } : {}),
    ...(meta?.agentId ? { agentId: meta.agentId } : {}),
    steps: [],
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
  };
}

export function contentFrames(message: Message): TranscriptFrame[] {
  const frames: TranscriptFrame[] = [];
  const msgMeta = messageMeta(message);

  if (message.metadata?.bash_card) {
    const card = typeof message.metadata.bash_card === 'object' && message.metadata.bash_card !== null
      ? (message.metadata.bash_card as Record<string, unknown>)
      : {};
    const rawText = messageText(message.content);
    let command = typeof card.command === 'string'
      ? card.command
      : typeof card.cmd === 'string'
        ? card.cmd
        : '';
    let output = card.output ?? card.stdout;
    let isError = card.is_error === true
      || card.isError === true
      || (typeof card.exit_code === 'number' && card.exit_code !== 0)
      || (typeof card.exitCode === 'number' && card.exitCode !== 0)
      || message.metadata?.is_error === true;

    if (!command) {
      const bashIn = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(rawText);
      const bashOut = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(rawText);
      const bashErr = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/.exec(rawText);
      if (bashIn) {
        command = bashIn[1].trim();
        const stdoutText = bashOut?.[1]?.trim() ?? '';
        const stderrText = bashErr?.[1]?.trim() ?? '';
        const combined = [stdoutText, stderrText].filter(Boolean).join('\n');
        if (output === undefined) output = combined;
        if (!isError && stderrText && !card.exit_code && !card.exitCode) {
          isError = true;
        }
      } else if (rawText.startsWith('$ ')) {
        const firstNl = rawText.indexOf('\n');
        if (firstNl !== -1) {
          command = rawText.slice(2, firstNl).trim();
          if (output === undefined) output = rawText.slice(firstNl + 1);
        } else {
          command = rawText.slice(2).trim();
          if (output === undefined) output = '';
        }
      } else if (rawText.startsWith('! ')) {
        command = rawText.slice(2).trim();
        if (output === undefined) output = '';
      } else {
        command = rawText.trim();
        if (output === undefined) output = '';
      }
    }
    if (output === undefined) output = '';

    const toolCallId = (typeof card.tool_call_id === 'string' && card.tool_call_id)
      || (typeof card.toolCallId === 'string' && card.toolCallId)
      || (typeof card.id === 'string' && card.id)
      || `${message.id}.bash`;

    const normalized = normalizeKimiWebTool('Bash', {
      command,
      ...(card.cwd ? { cwd: card.cwd } : {}),
      ...(card.workdir ? { workdir: card.workdir } : {}),
    });

    const agentRefs = msgMeta.agentRefs
      ?? (msgMeta.agentId && msgMeta.agentId !== 'main' ? [{ agentId: msgMeta.agentId, role: 'child' as const }] : undefined);

    frames.push({
      kind: 'tool',
      frameId: `${message.id}.bash.0`,
      toolCallId,
      name: normalized.name,
      state: isError ? 'error' : 'done',
      input: normalized.input,
      output,
      ...(isError ? { error: toolErrorText(output) } : {}),
      ...compactFrameMeta(msgMeta),
      ...(agentRefs && agentRefs.length > 0 ? { agentRefs } : {}),
    });
    return frames;
  }

  const isNoticeMsg = message.role === 'system'
    || message.metadata?.notice === true
    || typeof message.metadata?.notice_level === 'string';
  const noticeLevel = resolveNoticeLevel(message);
  const noticeSource = typeof message.metadata?.notice_source === 'string'
    ? message.metadata.notice_source
    : typeof message.metadata?.source === 'string'
      ? message.metadata.source
      : undefined;
  const noticeDetail = message.metadata?.detail ?? message.metadata?.plan;

  message.content.forEach((part, index) => {
    const frameId = `${message.id}.${part.type}.${index}`;
    const partMeta = mergeFrameMeta(msgMeta, part);

    if (part.type === 'text') {
      if (isNoticeMsg) {
        frames.push({
          kind: 'notice',
          frameId,
          level: noticeLevel,
          ...(noticeSource ? { source: noticeSource } : {}),
          message: part.text,
          ...(noticeDetail !== undefined ? { detail: noticeDetail } : {}),
          ...compactFrameMeta(partMeta),
        });
      } else {
        frames.push({
          kind: 'text',
          frameId,
          role: message.role === 'user' ? 'user' : 'assistant',
          text: part.text,
          ...compactFrameMeta(partMeta),
        });
      }
    } else if (part.type === 'thinking') {
      frames.push({
        kind: 'thinking',
        frameId,
        text: part.thinking ?? part.text ?? '',
        ...compactFrameMeta(partMeta),
      });
    } else if (part.type === 'tool_call' || part.type === 'tool_use') {
      const toolCallId = part.type === 'tool_use' ? part.tool_call_id : part.id;
      const rawName = part.type === 'tool_use' ? part.tool_name : part.name;
      const normalized = normalizeKimiWebTool(rawName ?? 'tool', part.input);
      let agentRefs = partMeta.agentRefs ? [...partMeta.agentRefs] : [];
      if (normalized.name === 'Agent') {
        const inputSubagentId = extractSubagentIdFromOutput(normalized.input);
        if (inputSubagentId && !agentRefs.some((r) => r.agentId === inputSubagentId)) {
          agentRefs.push({ agentId: inputSubagentId, role: 'child' });
        }
      }
      frames.push({
        kind: 'tool',
        frameId,
        toolCallId,
        name: normalized.name,
        state: 'running',
        input: normalized.input,
        ...compactFrameMeta(partMeta),
        ...(agentRefs.length > 0 ? { agentRefs } : {}),
      });
    } else if (part.type === 'tool_result') {
      const output = resolveToolResultOutput(part);
      const structured = part.structured_output ?? part.structuredOutput;
      let agentRefs = partMeta.agentRefs ? [...partMeta.agentRefs] : [];
      const extractedId = extractSubagentIdFromOutput(output)
        ?? extractSubagentIdFromOutput(structured);
      if (extractedId && !agentRefs.some((r) => r.agentId === extractedId)) {
        agentRefs.push({ agentId: extractedId, role: 'child' });
      }
      frames.push({
        kind: 'tool',
        frameId,
        toolCallId: part.tool_call_id,
        name: 'tool',
        state: part.is_error ? 'error' : 'done',
        output,
        ...(structured !== undefined && structured !== output ? { structuredOutput: structured } : {}),
        ...(part.is_error ? { error: toolErrorText(output) } : {}),
        ...compactFrameMeta(partMeta),
        ...(agentRefs.length > 0 ? { agentRefs } : {}),
      });
    } else if (part.type === 'image' || part.type === 'file' || part.type === 'document' || part.type === 'audio') {
      const info = safeMediaInfo(message.id, index, part);
      if (isNoticeMsg) {
        frames.push({
          kind: 'notice',
          frameId,
          level: noticeLevel,
          source: part.type,
          message: info.label,
          detail: info.detail,
          ...compactFrameMeta(partMeta),
        });
      } else {
        frames.push({
          kind: 'text',
          frameId,
          role: message.role === 'user' ? 'user' : 'assistant',
          text: info.label,
          mediaType: info.mediaType,
          ...(info.attachmentId ? { attachmentIds: [info.attachmentId] } : {}),
          ...(info.safeUrl ? { url: info.safeUrl } : {}),
          ...(info.ref ? { ref: info.ref } : {}),
          ...(info.name ? { name: info.name } : {}),
          ...(info.path ? { path: info.path } : {}),
          ...(info.inlineOmitted ? { inlineOmitted: true } : {}),
          ...compactFrameMeta(partMeta),
        });
      }
    }
  });
  return frames;
}

function resolveToolResultOutput(part: {
  output?: unknown;
  content?: unknown;
  structured_output?: unknown;
  structuredOutput?: unknown;
}): unknown {
  const candidates = [part.output, part.content, part.structured_output, part.structuredOutput];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && candidate !== '') {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) {
      return candidate;
    }
  }
  return '';
}

function toolErrorText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return 'Tool execution failed';
  if (typeof output === 'object' && !Array.isArray(output)) {
    const rec = output as Record<string, unknown>;
    if (typeof rec.error === 'string' && rec.error) return rec.error;
    if (typeof rec.message === 'string' && rec.message) return rec.message;
  }
  if (Array.isArray(output)) {
    const texts = output
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string') {
          return (item as Record<string, unknown>).text as string;
        }
        return '';
      })
      .filter(Boolean);
    if (texts.length > 0) return texts.join('\n');
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

const ALLOWED_MEDIA_PROTOCOLS = new Set(['http:', 'https:', 'blob:']);

function safeMediaUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // Reject ASCII control chars (including \t, \n, \r, \0, DEL) before parsing,
  // because WHATWG URL() strips ASCII tabs/newlines inside schemes.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\') || trimmed.startsWith('\\')) {
    return undefined;
  }
  if (trimmed.startsWith('/')) {
    try {
      const parsed = new URL(trimmed, 'https://gateway.local');
      return parsed.origin === 'https://gateway.local' ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }
  const hasSchemeLikePrefix = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  if (!hasSchemeLikePrefix) {
    if (trimmed.includes('\\')) return undefined;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) {
      const firstDelim = trimmed.search(/[/?#]/);
      if (firstDelim === -1 || colonIdx < firstDelim) return undefined;
    }
    try {
      const parsed = new URL(trimmed, 'https://gateway.local');
      return parsed.origin === 'https://gateway.local' ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const parsed = new URL(trimmed);
    if (!ALLOWED_MEDIA_PROTOCOLS.has(parsed.protocol)) return undefined;
    if (parsed.protocol === 'blob:') {
      const inner = trimmed.slice(5);
      const innerScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(inner)?.[1]?.toLowerCase();
      if (innerScheme && innerScheme !== 'http' && innerScheme !== 'https') {
        return undefined;
      }
    }
    return trimmed;
  } catch {
    return undefined;
  }
}

function safeMediaInfo(
  messageId: string,
  index: number,
  part: Extract<MessageContentPart, { type: 'image' | 'file' | 'document' | 'audio' }>,
): {
  mediaType: string;
  name?: string;
  path?: string;
  ref?: string;
  safeUrl?: string;
  attachmentId?: string;
  label: string;
  inlineOmitted: boolean;
  detail: Record<string, unknown>;
} {
  const mediaType = part.mime_type
    ?? part.mimeType
    ?? (part.type === 'image' ? 'image/png' : 'application/octet-stream');
  const rawPath = typeof part.path === 'string' && part.path ? part.path : undefined;
  const name = typeof part.name === 'string' && part.name
    ? part.name
    : rawPath
      ? path.posix.basename(rawPath.replace(/\\/g, '/'))
      : undefined;
  const ref = typeof part.ref === 'string' && part.ref ? part.ref : undefined;
  const rawUrl = 'image_url' in part ? (part.url ?? part.image_url) : part.url;
  const safeUrl = safeMediaUrl(rawUrl);
  const hasUnsafeUrl = typeof rawUrl === 'string' && rawUrl.trim().length > 0 && safeUrl === undefined;
  const inlineOmitted = Boolean(part.data) || hasUnsafeUrl;
  const attachmentId = safeUrl || ref ? `${messageId}.att.${index}` : undefined;
  const label = name ? `[${part.type}: ${name}]` : `[${part.type}: ${mediaType}]`;
  const detail: Record<string, unknown> = {
    kind: part.type,
    mediaType,
    ...(name ? { name } : {}),
    ...(rawPath ? { path: rawPath } : {}),
    ...(ref ? { ref } : {}),
    ...(safeUrl ? { url: safeUrl } : {}),
    ...(inlineOmitted ? { inlineOmitted: true } : {}),
  };
  return { mediaType, name, path: rawPath, ref, safeUrl, attachmentId, label, inlineOmitted, detail };
}

function toTranscriptAttachment(
  messageId: string,
  index: number,
  part: MessageContentPart,
): TranscriptAttachment | null {
  if (part.type !== 'image' && part.type !== 'file' && part.type !== 'document' && part.type !== 'audio') {
    return null;
  }
  const info = safeMediaInfo(messageId, index, part);
  if (!info.attachmentId) return null;
  const source: TranscriptAttachment['source'] = info.safeUrl
    ? { kind: 'url', url: info.safeUrl }
    : info.ref
      ? { kind: 'session_media', fileId: info.ref }
      : undefined;
  return {
    attachmentId: info.attachmentId,
    mediaType: info.mediaType,
    ...(info.name ? { name: info.name } : {}),
    ...(source ? { source } : {}),
    placeholder: info.label,
  };
}

function messageMeta(message: Message): FrameMeta {
  const m = message.metadata ?? {};
  const phase = typeof m.phase === 'string' && m.phase ? m.phase : undefined;
  const parentToolUseId = typeof m.parent_tool_use_id === 'string' && m.parent_tool_use_id
    ? m.parent_tool_use_id
    : typeof m.parentToolUseId === 'string' && m.parentToolUseId
      ? m.parentToolUseId
      : undefined;
  const agentId = typeof m.agent_id === 'string' && m.agent_id
    ? m.agent_id
    : typeof m.agentId === 'string' && m.agentId
      ? m.agentId
      : typeof m.subagent_id === 'string' && m.subagent_id
        ? m.subagent_id
        : typeof m.subagentId === 'string' && m.subagentId
          ? m.subagentId
          : undefined;
  const taskId = typeof m.task_id === 'string' && m.task_id
    ? m.task_id
    : typeof m.taskId === 'string' && m.taskId
      ? m.taskId
      : undefined;
  const agentRefs = Array.isArray(m.agentRefs)
    ? (m.agentRefs as Array<{ agentId: string; role?: 'child' | 'member' }>)
    : Array.isArray(m.agent_refs)
      ? (m.agent_refs as Array<{ agentId: string; role?: 'child' | 'member' }>)
      : agentId && agentId !== 'main'
        ? [{ agentId, role: 'child' as const }]
        : undefined;
  return { phase, parentToolUseId, agentId, taskId, agentRefs };
}

function mergeFrameMeta(base: FrameMeta, part: MessageContentPart): FrameMeta {
  const rec = part as unknown as Record<string, unknown>;
  const phase = typeof rec.phase === 'string' && rec.phase ? rec.phase : base.phase;
  const parentToolUseId = typeof rec.parent_tool_use_id === 'string' && rec.parent_tool_use_id
    ? rec.parent_tool_use_id
    : typeof rec.parentToolUseId === 'string' && rec.parentToolUseId
      ? rec.parentToolUseId
      : base.parentToolUseId;
  const agentId = typeof rec.agent_id === 'string' && rec.agent_id
    ? rec.agent_id
    : typeof rec.agentId === 'string' && rec.agentId
      ? rec.agentId
      : typeof rec.subagent_id === 'string' && rec.subagent_id
        ? rec.subagent_id
        : typeof rec.subagentId === 'string' && rec.subagentId
          ? rec.subagentId
          : base.agentId;
  const taskId = typeof rec.task_id === 'string' && rec.task_id
    ? rec.task_id
    : typeof rec.taskId === 'string' && rec.taskId
      ? rec.taskId
      : base.taskId;
  const agentRefs = Array.isArray(rec.agentRefs)
    ? (rec.agentRefs as Array<{ agentId: string; role?: 'child' | 'member' }>)
    : Array.isArray(rec.agent_refs)
      ? (rec.agent_refs as Array<{ agentId: string; role?: 'child' | 'member' }>)
      : rec.agent_id || rec.subagent_id
        ? [{ agentId: (rec.agent_id ?? rec.subagent_id) as string, role: 'child' as const }]
        : base.agentRefs;
  return { phase, parentToolUseId, agentId, taskId, agentRefs };
}

function compactFrameMeta(meta?: FrameMeta): Record<string, unknown> {
  if (!meta) return {};
  return {
    ...(meta.phase ? { phase: meta.phase } : {}),
    ...(meta.parentToolUseId ? { parentToolUseId: meta.parentToolUseId } : {}),
    ...(meta.agentId ? { agentId: meta.agentId } : {}),
    ...(meta.taskId ? { taskId: meta.taskId } : {}),
    ...(meta.agentRefs && meta.agentRefs.length > 0 ? { agentRefs: meta.agentRefs } : {}),
  };
}

function streamKeySuffix(meta?: FrameMeta): string {
  if (!meta) return '';
  const parts: string[] = [];
  if (meta.agentId && meta.agentId !== 'main') parts.push(meta.agentId);
  if (meta.parentToolUseId) parts.push(meta.parentToolUseId);
  if (meta.phase) parts.push(meta.phase);
  return parts.join('.');
}

function resolveNoticeLevel(message: Message): 'info' | 'warning' | 'error' {
  const raw = message.metadata?.notice_level;
  if (raw === 'error' || raw === 'warning' || raw === 'info') return raw;
  return message.metadata?.is_error === true ? 'error' : 'info';
}

function mergeMetaInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (
      v !== null
      && typeof v === 'object'
      && !Array.isArray(v)
      && target[k] !== null
      && typeof target[k] === 'object'
      && !Array.isArray(target[k])
    ) {
      mergeMetaInto(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = structuredClone(v);
    }
  }
}

function messageText(content: readonly MessageContentPart[]): string {
  return content
    .filter((part): part is Extract<MessageContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function clampPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 20;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

function turnOrdinal(id: string | undefined): number | undefined {
  if (id === undefined) return undefined;
  const ordinal = Number(id.startsWith('t') ? id.slice(1) : id);
  return Number.isFinite(ordinal) ? ordinal : 0;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationMs(start: string | undefined, end: string | undefined): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  return Math.max(0, timestamp(end) - timestamp(start));
}

function turnHeader(turn: TranscriptTurn): Omit<TranscriptTurn, 'steps'> {
  const { steps: _steps, ...header } = turn;
  return { ...header };
}

function stepHeader(step: TranscriptStep): Omit<TranscriptStep, 'frames'> {
  const { frames: _frames, ...header } = step;
  return { ...header };
}

function cloneTurns(turns: readonly TranscriptTurn[]): TranscriptTurn[] {
  return structuredClone(turns) as TranscriptTurn[];
}

function snapshotFromState(
  items: readonly TranscriptTurn[],
  interactions: readonly TranscriptInteraction[],
  prompts: readonly TranscriptPrompt[],
  tasks: readonly TranscriptTask[],
  meta: Record<string, unknown>,
  activity: TranscriptActivity,
): Record<string, unknown> {
  return {
    items: cloneTurns(items),
    tasks: structuredClone([...tasks]),
    interactions: structuredClone(interactions),
    attachments: [],
    todos: [],
    prompts: structuredClone([...prompts]),
    meta: { ...(structuredClone(meta) as Record<string, unknown>), activity },
  };
}

function opsEmission(batch: TranscriptBatch): TranscriptEmission {
  return {
    type: 'transcript.ops',
    payload: {
      type: 'transcript.ops',
      agent_id: 'main',
      ops: batch.ops,
      seq: batch.seq,
    },
  };
}

// ---------------------------------------------------------------------------
// codex rollout 文件定位(回收保护/本地历史读取共用)
// ---------------------------------------------------------------------------

/**
 * 按 threadId 找 rollout 文件:`~/.codex/sessions/YYYY/MM/DD/rollout-*<id>.jsonl`
 * 及 archived_sessions/(归档会话会被移过去)。找不到返回 null(未落盘的新线程)。
 */
export async function findCodexRollout(threadId: string, codexHome?: string): Promise<string | null> {
  if (!threadId || !/^[a-zA-Z0-9._-]+$/.test(threadId) || threadId === '.' || threadId === '..') {
    return null;
  }
  const home = codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const suffix = `-${threadId}.jsonl`;
  const exact = `${threadId}.jsonl`;
  const matchIn = async (dir: string, depth: number): Promise<string | null> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) {
        const hit = await matchIn(full, depth - 1);
        if (hit) return hit;
      } else if (e.isFile() && (e.name === exact || e.name.endsWith(suffix))) {
        return full;
      }
    }
    return null;
  };
  return (await matchIn(path.join(home, 'sessions'), 3)) ?? (await matchIn(path.join(home, 'archived_sessions'), 3));
}
