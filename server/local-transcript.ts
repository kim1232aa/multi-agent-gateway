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
}

export interface TranscriptTurn {
  kind: 'turn';
  turnId: string;
  ordinal: number;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  origin: { kind: 'user' | 'other' };
  prompt?: string;
  steps: TranscriptStep[];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
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
}

interface TranscriptSubscriber {
  closed: boolean;
  seeded: boolean;
  startSeq: number;
  baselineItems: TranscriptTurn[];
  baselineInteractions: TranscriptInteraction[];
  baselinePrompts: TranscriptPrompt[];
  pending: TranscriptBatch[];
  send: TranscriptListener;
}

export interface LocalTranscriptSubscription {
  seed(messages: readonly Message[], activity: TranscriptActivity, since?: number): void;
  close(): void;
}

/** In-memory transcript-v2 journal for local Claude/Codex sessions. */
export class LocalTranscriptHub {
  private readonly sessions = new Map<string, TranscriptSessionState>();
  private static readonly JOURNAL_CAP = 200;

  currentSeq(sessionId: string): number {
    return this.state(sessionId).seq;
  }

  hasObservedHistory(sessionId: string): boolean {
    return this.state(sessionId).historyObserved;
  }

  observeHistory(sessionId: string, messages: readonly Message[]): void {
    const state = this.state(sessionId);
    state.historyObserved = true;
    const persistedTurns = historyTurns(messages);
    state.nextOrdinal = Math.max(state.nextOrdinal, persistedTurns.length + 1);
    for (const [turnId, turn] of state.recentTurns) {
      // 未基准的 turn 不能按 ordinal 驱逐——它的 ordinal 是在历史未知时分配的,
      // 撞号不代表是同一个 turn;重编号后自然落到 persisted 之后。
      if (turn.ordinal <= persistedTurns.length && !state.unbasedTurns.has(turnId)) state.recentTurns.delete(turnId);
    }
    if (state.unbasedTurns.size > 0) this.rebaseUnbasedTurns(state);
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

  /** 重编号后把 journal 里旧 turnId/stepId 的 op 改写到新号,重放不产生幽灵。 */
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
    for (const batch of state.journal) {
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
        const turn = op.turn as TranscriptTurn | undefined;
        if (turn && typeof turn.turnId === 'string' && turnRemap.has(turn.turnId)) {
          turn.turnId = turnRemap.get(turn.turnId) as string;
          turn.ordinal = Number.parseInt(turn.turnId.slice(1), 10);
          for (const step of turn.steps ?? []) {
            if (stepRemap.has(step.stepId)) {
              step.turnId = turn.turnId;
              step.stepId = stepRemap.get(step.stepId) as string;
            }
          }
        }
        const step = op.step as TranscriptStep | undefined;
        if (step && typeof step.stepId === 'string' && stepRemap.has(step.stepId)) {
          if (typeof step.turnId === 'string' && turnRemap.has(step.turnId)) step.turnId = turnRemap.get(step.turnId) as string;
          step.stepId = stepRemap.get(step.stepId) as string;
        }
        const frame = op.frame as TranscriptFrame | undefined;
        if (frame && typeof frame.frameId === 'string') frame.frameId = mapFrameId(frame.frameId);
      }
    }
  }

  currentInteractions(sessionId: string): TranscriptInteraction[] {
    return structuredClone([...this.state(sessionId).interactions.values()]) as TranscriptInteraction[];
  }

  currentPrompts(sessionId: string): TranscriptPrompt[] {
    return structuredClone([...this.state(sessionId).prompts.values()]) as TranscriptPrompt[];
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
      baselineItems: cloneTurns([...state.recentTurns.values(), ...state.activeTurns.values()]),
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
          const hasOlder = historyTurns(messages).length > 0 || subscriber.baselineItems.length > 0;
          send({
            type: 'transcript.reset',
            payload: {
              type: 'transcript.reset',
              agent_id: 'main',
              snapshot: emptySnapshot([], subscriber.baselineInteractions, subscriber.baselinePrompts, activity),
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

  beginTurn(sessionId: string, prompt: string, startedAt = new Date().toISOString()): LocalTranscriptTurn {
    const state = this.state(sessionId);
    const ordinal = state.nextOrdinal++;
    const turn: TranscriptTurn = {
      kind: 'turn',
      turnId: `t${ordinal}`,
      ordinal,
      state: 'running',
      origin: { kind: 'user' },
      prompt,
      steps: [],
      startedAt,
    };
    // 历史还没观察到就分配 ordinal(首次拉取失败窗口):与持久化历史撞号
    // 的风险记入 unbasedTurns,首次成功观察时重编号。
    if (!state.historyObserved) state.unbasedTurns.add(turn.turnId);
    state.activeTurns.set(turn.turnId, turn);
    this.publish(sessionId, [{ op: 'meta.merge', meta: { activity: 'turn' } }]);
    this.publish(sessionId, [{ op: 'turn.upsert', turn: turnHeader(turn) }]);
    return new LocalTranscriptTurn(this, sessionId, turn);
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
  }

  drop(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const subscriber of state.subscribers) subscriber.closed = true;
    this.sessions.delete(sessionId);
  }

  private state(sessionId: string): TranscriptSessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        seq: 0,
        nextOrdinal: 1,
        historyObserved: false,
        journal: [],
        subscribers: new Set(),
        activeTurns: new Map(),
        recentTurns: new Map(),
        unbasedTurns: new Set(),
        interactions: new Map(),
        prompts: new Map(),
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
    if (!Number.isInteger(since) || since < 0 || since > through) {
      return { batches: [], latestSeq: through, complete: false };
    }
    const batches = state.journal.filter((batch) => batch.seq > since && batch.seq <= through);
    const complete = since === through || batches[0]?.seq === since + 1;
    return { batches, latestSeq: through, complete };
  }
}

export class LocalTranscriptTurn {
  private stepOrdinal = 0;
  private step: TranscriptStep | undefined;
  private assistantText = '';
  private thinkingText = '';
  private readonly tools = new Map<string, TranscriptFrame>();
  private ended = false;

  constructor(
    private readonly hub: LocalTranscriptHub,
    private readonly sessionId: string,
    private readonly turn: TranscriptTurn,
  ) {}

  append(kind: 'assistant' | 'thinking', text: string): void {
    if (!text || this.ended) return;
    const step = this.ensureStep();
    const frameId = `${step.stepId}.${kind}`;
    const current = kind === 'assistant' ? this.assistantText : this.thinkingText;
    if (current.length === 0) {
      const frame: TranscriptFrame = kind === 'assistant'
        ? { kind: 'text', frameId, role: 'assistant', text: '' }
        : { kind: 'thinking', frameId, text: '' };
      step.frames.push(frame);
      this.hub.publish(this.sessionId, [{ op: 'frame.upsert', turnId: this.turn.turnId, stepId: step.stepId, frame }]);
    }
    this.hub.publish(this.sessionId, [{
      op: 'append',
      target: { type: 'frame', turnId: this.turn.turnId, stepId: step.stepId, frameId },
      offset: current.length,
      text,
    }]);
    if (kind === 'assistant') this.assistantText += text;
    else this.thinkingText += text;
    const frame = step.frames.find((item) => item.frameId === frameId);
    if (frame) frame.text = kind === 'assistant' ? this.assistantText : this.thinkingText;
  }

  toolStarted(toolCallId: string, name: string, input: unknown): void {
    if (this.ended) return;
    const step = this.ensureStep();
    const frame: TranscriptFrame = {
      kind: 'tool',
      frameId: `${step.stepId}.${toolCallId}`,
      toolCallId,
      name,
      state: 'running',
      input,
    };
    this.tools.set(toolCallId, frame);
    step.frames.push(frame);
    this.hub.publish(this.sessionId, [{ op: 'frame.upsert', turnId: this.turn.turnId, stepId: step.stepId, frame }]);
  }

  toolResult(toolCallId: string, output: unknown, isError: boolean): void {
    if (this.ended) return;
    const step = this.ensureStep();
    const existing = this.tools.get(toolCallId);
    const frame: TranscriptFrame = {
      ...(existing ?? {
        kind: 'tool',
        frameId: `${step.stepId}.${toolCallId}`,
        toolCallId,
        name: 'tool',
      }),
      state: isError ? 'error' : 'done',
      output,
      ...(isError && typeof output === 'string' ? { error: output } : {}),
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
    this.assistantText = '';
    this.thinkingText = '';
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
    this.hub.publish(this.sessionId, [{ op: 'meta.merge', meta: { activity: 'idle' } }]);
    this.hub.finishTurn(this.sessionId, this.turn);
  }

  private ensureStep(): TranscriptStep {
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
  meta: { activity: TranscriptActivity };
  agents: Array<{ agentId: string; type: 'main' }>;
  pending_interactions: string[];
  seq: number;
}

/** Convert provider history into the turn-shaped transcript consumed by Kimi Web 0.33.0. */
export function buildLocalTranscriptPage(
  messages: readonly Message[],
  query: LocalTranscriptQuery,
  activity: TranscriptActivity,
  seq: number,
  liveItems: readonly TranscriptTurn[] = [],
  interactions: readonly TranscriptInteraction[] = [],
  prompts: readonly TranscriptPrompt[] = [],
): LocalTranscriptPage {
  const persisted = historyTurns(messages);
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

  return {
    agent_id: query.agentId,
    items,
    has_more: candidates.length > items.length && items.length > 0,
    tasks: [],
    interactions: structuredClone([...interactions]) as TranscriptInteraction[],
    attachments: [],
    todos: [],
    prompts: structuredClone([...prompts]) as TranscriptPrompt[],
    meta: { activity },
    agents: [{ agentId: 'main', type: 'main' }],
    pending_interactions: interactions.filter((item) => item.state === 'pending').map((item) => item.interactionId),
    seq,
  };
}

function historyTurns(messages: readonly Message[]): TranscriptTurn[] {
  const ordered = messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => timestamp(a.message.created_at) - timestamp(b.message.created_at) || a.index - b.index)
    .map(({ message }) => message);

  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | undefined;

  for (const message of ordered) {
    if (message.role === 'user') {
      current = newTurn(turns.length + 1, 'user', message.created_at, messageText(message.content));
      turns.push(current);
      continue;
    }
    if (current === undefined) {
      current = newTurn(turns.length + 1, 'other', message.created_at);
      turns.push(current);
    }

    const frames = contentFrames(message);
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
      });
    }
    if (isError) current.state = 'failed';
    current.endedAt = message.created_at;
    current.durationMs = durationMs(current.startedAt, current.endedAt);
  }

  return turns;
}

function newTurn(
  ordinal: number,
  origin: 'user' | 'other',
  startedAt: string,
  prompt?: string,
): TranscriptTurn {
  return {
    kind: 'turn',
    turnId: `t${ordinal}`,
    ordinal,
    state: 'completed',
    origin: { kind: origin },
    ...(prompt === undefined ? {} : { prompt }),
    steps: [],
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
  };
}

function contentFrames(message: Message): TranscriptFrame[] {
  const frames: TranscriptFrame[] = [];
  message.content.forEach((part, index) => {
    const frameId = `${message.id}.${part.type}.${index}`;
    if (part.type === 'text') {
      if (message.role === 'system') {
        frames.push({ kind: 'notice', frameId, level: 'info', message: part.text });
      } else {
        frames.push({ kind: 'text', frameId, role: message.role === 'user' ? 'user' : 'assistant', text: part.text });
      }
    } else if (part.type === 'thinking') {
      frames.push({ kind: 'thinking', frameId, text: part.text });
    } else if (part.type === 'tool_call') {
      frames.push({
        kind: 'tool', frameId, toolCallId: part.id, name: part.name,
        state: 'running', input: part.input,
      });
    } else if (part.type === 'tool_result') {
      frames.push({
        kind: 'tool', frameId, toolCallId: part.tool_call_id, name: 'tool',
        state: part.is_error ? 'error' : 'done', output: part.content,
        ...(part.is_error ? { error: part.content } : {}),
      });
    }
  });
  return frames;
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

function emptySnapshot(
  items: readonly TranscriptTurn[],
  interactions: readonly TranscriptInteraction[],
  prompts: readonly TranscriptPrompt[],
  activity: TranscriptActivity,
): Record<string, unknown> {
  return {
    items: cloneTurns(items),
    tasks: [],
    interactions: structuredClone(interactions),
    attachments: [],
    todos: [],
    prompts: structuredClone([...prompts]),
    meta: { activity },
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
  const home = codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
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
      } else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(threadId)) {
        return full;
      }
    }
    return null;
  };
  return (await matchIn(path.join(home, 'sessions'), 3)) ?? (await matchIn(path.join(home, 'archived_sessions'), 3));
}
