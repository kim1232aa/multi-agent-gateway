import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import {
  WS_MAX_MESSAGE_BYTES,
  WsFrameParser,
  wsAccept,
  wsSendFrame,
  wsSendMaskedFrame,
  wsSendMaskedText,
  wsSendText,
  type ParsedWsFrame,
} from './ws-framing.js';

export interface KimiV25Upstream {
  url: string;
  token: string;
}

interface FrameState {
  itemId: string;
  field: 'text' | 'output';
  turnId: string;
  stepIndex: number;
  terminal: boolean;
}

export function isKimiV25Version(version: string | undefined): boolean {
  if (!version) return false;
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major < 2 || (major === 2 && minor < 6);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function v25FrameToV262Item(
  frame: Record<string, unknown>,
  stepIndex: number,
  agentId: string,
  createdAt: string,
  stepRunning = false,
  pendingInteractionToolIds?: Map<string, string>,
): { item: Record<string, unknown>; field: 'text' | 'output'; terminal: boolean } | null {
  const kind = String(frame.kind ?? '');
  const frameId = String(frame.frameId ?? randomUUID());
  const ts = typeof frame.createdAt === 'string' ? frame.createdAt : createdAt;

  if (kind === 'text') {
    const status = stepRunning && frame.state !== 'done' ? 'running' : 'ended';
    return {
      field: 'text',
      terminal: status === 'ended',
      item: {
        item_id: frameId,
        type: 'assistant_message',
        status,
        text: typeof frame.text === 'string' ? frame.text : '',
        created_at: ts,
        step_index: stepIndex,
      },
    };
  }

  if (kind === 'thinking') {
    const status = stepRunning && frame.state !== 'done' ? 'running' : 'ended';
    return {
      field: 'text',
      terminal: status === 'ended',
      item: {
        item_id: frameId,
        type: 'reasoning',
        status,
        text: typeof frame.text === 'string' ? frame.text : '',
        started_at: ts,
        created_at: ts,
        step_index: stepIndex,
      },
    };
  }

  if (kind === 'tool') {
    const toolCallId = String(frame.toolCallId ?? frameId);
    const state = String(frame.state ?? (stepRunning ? 'running' : 'done'));
    const status = state === 'running' ? 'running' : 'ended';
    const outcome = state === 'error' ? 'failed' : state === 'done' ? 'completed' : undefined;
    const interactionId = pendingInteractionToolIds?.get(toolCallId);
    const agentRefs = Array.isArray(frame.agentRefs)
      ? frame.agentRefs
          .map((r) => {
            const rec = asRecord(r);
            const id = String(rec.agentId ?? rec.agent_id ?? '');
            return id ? { agent_id: id, role: rec.role === 'member' ? 'member' : 'child' } : null;
          })
          .filter(Boolean)
      : [];
    return {
      field: 'output',
      terminal: status === 'ended',
      item: {
        item_id: toolCallId,
        type: 'tool_call',
        name: String(frame.name ?? 'tool'),
        input: frame.input ?? {},
        status,
        ...(outcome ? { outcome } : {}),
        ...(frame.output !== undefined ? { output: frame.output } : {}),
        ...(frame.error !== undefined ? { error: frame.error } : {}),
        ...(interactionId ? { stage: 'awaiting_approval', interaction_id: interactionId } : {}),
        ...(agentRefs.length > 0 ? { agent_refs: agentRefs } : {}),
        started_at: ts,
        ...(status === 'ended' ? { ended_at: ts } : {}),
        step_index: stepIndex,
      },
    };
  }

  if (kind === 'notice') {
    const level = typeof frame.level === 'string' ? frame.level : 'info';
    const source = typeof frame.source === 'string' ? frame.source : 'kimi';
    return {
      field: 'text',
      terminal: true,
      item: {
        item_id: frameId,
        type: 'notification',
        notification_id: frameId,
        notification_type: level,
        source: { kind: 'system', id: source },
        agent_id: agentId,
        title: source,
        severity: level,
        body: typeof frame.message === 'string' ? frame.message : '',
        created_at: ts,
      },
    };
  }

  return null;
}

export function v25TurnToV262(
  turn: Record<string, unknown>,
  agentId = 'main',
  pendingInteractionToolIds?: Map<string, string>,
): Record<string, unknown> {
  const turnId = String(turn.turnId ?? turn.turn_id ?? randomUUID());
  const ordinal = typeof turn.ordinal === 'number' ? turn.ordinal : 0;
  const state = String(turn.state ?? 'completed');
  const status = state === 'running' || state === 'queued' ? 'running' : 'ended';
  const outcome =
    status === 'ended'
      ? state === 'failed'
        ? 'failed'
        : state === 'cancelled'
          ? 'interrupted'
          : 'completed'
      : undefined;
  const startedAt = typeof turn.startedAt === 'string' ? turn.startedAt : new Date().toISOString();
  const endedAt = typeof turn.endedAt === 'string' ? turn.endedAt : undefined;
  const originRec = asRecord(turn.origin);
  const originKind = typeof originRec.kind === 'string' ? originRec.kind : 'user';
  const prompt = typeof turn.prompt === 'string' ? turn.prompt : '';
  const triggerPromptId = typeof turn.triggerPromptId === 'string' ? turn.triggerPromptId : '';

  const items: Array<Record<string, unknown>> = [];
  if (prompt.length > 0 || originKind === 'user') {
    items.push({
      item_id: `${turnId}_opener`,
      type: 'user_message',
      placement: 'opener',
      origin: { kind: originKind },
      text: prompt,
      prompt_ids: triggerPromptId ? [triggerPromptId] : [turnId],
      attachments: [],
      skills: [],
      created_at: startedAt,
    });
  }

  const rawSteps = Array.isArray(turn.steps) ? turn.steps : [];
  const steps: Array<Record<string, unknown>> = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const s = asRecord(rawSteps[i]);
    const stepIndex = typeof s.ordinal === 'number' ? Math.max(0, s.ordinal - 1) : i;
    const stepRunning = s.state === 'running';
    const stepCreatedAt =
      (typeof s.startedAt === 'string' ? s.startedAt : undefined) ?? endedAt ?? startedAt;
    steps.push({
      index: stepIndex,
      ...(typeof s.startedAt === 'string' ? { started_at: s.startedAt } : {}),
      ...(typeof s.endedAt === 'string' ? { ended_at: s.endedAt } : {}),
    });
    const frames = Array.isArray(s.frames) ? s.frames : [];
    for (const rawFrame of frames) {
      const converted = v25FrameToV262Item(
        asRecord(rawFrame),
        stepIndex,
        agentId,
        stepCreatedAt,
        stepRunning,
        pendingInteractionToolIds,
      );
      if (converted) items.push(converted.item);
    }
  }
  if (steps.length === 0) steps.push({ index: 0 });

  return {
    turn_id: turnId,
    ordinal,
    turn_number: ordinal + 1,
    kind: 'agent',
    status,
    ...(outcome ? { outcome } : {}),
    started_at: startedAt,
    ...(endedAt ? { ended_at: endedAt } : {}),
    ...(typeof turn.durationMs === 'number' ? { duration_ms: turn.durationMs } : {}),
    steps,
    items,
  };
}

export async function fetchKimiV25Turns(
  upstream: KimiV25Upstream,
  sessionId: string,
  agentId: string,
  options: { beforeOrdinal?: number; pageSize?: number } = {},
): Promise<{ turns: Array<Record<string, unknown>>; has_more: boolean }> {
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
  const buildUrl = (params: Record<string, string>): string => {
    const u = new URL(`/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript`, upstream.url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };

  const query: Record<string, string> = {
    agent_id: agentId,
    page_size: String(pageSize),
  };
  if (options.beforeOrdinal !== undefined) {
    query.before_turn = `t${options.beforeOrdinal}`;
  }

  let res = await fetch(buildUrl(query), {
    headers: { authorization: `Bearer ${upstream.token}` },
  });
  let json = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: Record<string, unknown> } | null;
  if (!res.ok || !json || (json.code !== undefined && json.code !== 0)) {
    throw new Error(json?.msg || `HTTP ${res.status}`);
  }
  let data = asRecord(json.data);
  let rawItems = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
  let hasMore = Boolean(data.has_more ?? data.has_more_older);

  // Fallback if upstream turnIds do not follow `t${ordinal}` when paginating older turns
  if (
    options.beforeOrdinal !== undefined &&
    rawItems.every((t) => typeof t.ordinal === 'number' && t.ordinal >= options.beforeOrdinal!)
  ) {
    res = await fetch(buildUrl({ agent_id: agentId, page_size: '200' }), {
      headers: { authorization: `Bearer ${upstream.token}` },
    });
    if (res.ok) {
      json = (await res.json().catch(() => null)) as { code?: number; data?: Record<string, unknown> } | null;
      data = asRecord(json?.data);
      const all = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
      const older = all.filter((t) => typeof t.ordinal === 'number' && t.ordinal < options.beforeOrdinal!);
      const start = Math.max(0, older.length - pageSize);
      rawItems = older.slice(start);
      hasMore = start > 0 || Boolean(data.has_more ?? data.has_more_older);
    }
  }

  const pendingToolIds = new Map<string, string>();
  const pendingList = Array.isArray(data.pending_interactions)
    ? data.pending_interactions
    : Array.isArray(data.interactions)
      ? data.interactions
      : [];
  for (const rawInter of pendingList) {
    const inter = asRecord(rawInter);
    if (inter.state === 'pending' && typeof inter.toolCallId === 'string' && typeof inter.interactionId === 'string') {
      pendingToolIds.set(inter.toolCallId, inter.interactionId);
    }
  }

  return {
    turns: rawItems.map((t) => v25TurnToV262(asRecord(t), agentId, pendingToolIds)),
    has_more: hasMore,
  };
}

/**
 * Bridge Kimi Web 2.6.2 WebSocket frames (`subscribe` / `turns` / `turn.*` / `item.*`)
 * to an upstream Kimi 2.5.x server (`client_hello` / `subscribe_v2` / `transcript.*`).
 */
export function bridgeKimiV25Ws(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  upstream: KimiV25Upstream,
  gatewaySockets: Set<Duplex>,
  kimiSockets: Set<Duplex>,
): void {
  const protos = (req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const chosenProto = protos.find((p) => p.startsWith('kimi-code.'));
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    clientSocket.destroy();
    return;
  }

  const upstreamUrl = new URL(req.url ?? '/api/v1/ws', upstream.url);
  upstreamUrl.searchParams.delete('provider');
  upstreamUrl.searchParams.delete('token');
  const upstreamHost = upstreamUrl.hostname;
  const upstreamPort = Number(upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80));
  const upstreamSocket = net.connect(upstreamPort, upstreamHost);

  let clientHandshaked = false;
  let upstreamUpgraded = false;
  let upstreamHelloSeen = false;
  let closed = false;
  let lastUpstreamPingAt = Date.now();
  const upstreamOutQueue: string[] = [];

  const sendToClient = (obj: Record<string, unknown>): void => {
    if (closed || !clientHandshaked || clientSocket.destroyed) return;
    wsSendText(clientSocket, JSON.stringify(obj));
    if (clientSocket.writableLength > 8 * 1024 * 1024) cleanup();
  };

  const sendToUpstream = (obj: Record<string, unknown>): void => {
    if (closed || upstreamSocket.destroyed) return;
    const raw = JSON.stringify(obj);
    if (!upstreamUpgraded || !upstreamHelloSeen) {
      upstreamOutQueue.push(raw);
      return;
    }
    wsSendMaskedText(upstreamSocket, raw);
  };

  let pingTimer: ReturnType<typeof setInterval> | null = null;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    gatewaySockets.delete(clientSocket);
    kimiSockets.delete(clientSocket);
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  };

  // Track 2.5.3 state -> 2.6.2 transitions per subscribed session:agent
  const subscribed = new Set<string>();
  const initialLoaded = new Set<string>();
  const pendingSubscribes = new Map<
    string,
    {
      sessionId: string;
      agentIds: string[];
      fetchPromise: Promise<Array<{ agentId: string; turns: Array<Record<string, unknown>>; has_more: boolean }>>;
    }
  >();
  const pendingAcks = new Set<string>();
  const knownTurns = new Map<string, { status: string; steps: Map<string, number> }>();
  const knownFrames = new Map<string, FrameState & { lastItem?: Record<string, unknown> }>();

  const clientParser = new WsFrameParser();
  let clientFragments: Buffer[] | null = null;
  let clientFragmentBytes = 0;

  const consumeClientChunk = (chunk: Buffer): void => {
    let frames: ParsedWsFrame[];
    try {
      frames = clientParser.push(chunk);
    } catch {
      cleanup();
      return;
    }
    for (const f of frames) {
      if (f.opcode === 0x8) {
        if (clientHandshaked && !clientSocket.destroyed) wsSendFrame(clientSocket, 0x8, f.payload);
        cleanup();
        return;
      }
      if (f.opcode === 0x9) {
        if (clientHandshaked && !clientSocket.destroyed) wsSendFrame(clientSocket, 0xa, f.payload);
        continue;
      }
      if (f.opcode === 0xa) continue;
      if (f.opcode === 0x1) {
        clientFragments = [f.payload];
        clientFragmentBytes = f.payload.byteLength;
      } else if (f.opcode === 0x0 && clientFragments) {
        clientFragmentBytes += f.payload.byteLength;
        if (clientFragmentBytes > WS_MAX_MESSAGE_BYTES) {
          cleanup();
          return;
        }
        clientFragments.push(f.payload);
      } else {
        continue;
      }
      if (f.fin && clientFragments) {
        const text = Buffer.concat(clientFragments).toString('utf8');
        clientFragments = null;
        clientFragmentBytes = 0;
        try {
          handleClientJson(asRecord(JSON.parse(text)));
        } catch {
          // ignore malformed JSON
        }
      }
    }
  };

  const completeHandshakeWithClient = (): void => {
    if (clientHandshaked || clientSocket.destroyed) return;
    clientHandshaked = true;
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${wsAccept(key)}`,
    ];
    if (chosenProto) headers.push(`Sec-WebSocket-Protocol: ${chosenProto}`);
    clientSocket.write(headers.concat('\r\n').join('\r\n'));
    gatewaySockets.add(clientSocket);
    kimiSockets.add(clientSocket);
    pingTimer = setInterval(() => {
      if (closed || clientSocket.destroyed) {
        cleanup();
        return;
      }
      if (Date.now() - lastUpstreamPingAt >= 9_000) {
        try {
          wsSendFrame(clientSocket, 0x9, Buffer.alloc(0));
          sendToClient({ type: 'ping' });
        } catch {
          cleanup();
        }
      }
    }, 10_000);
    pingTimer.unref?.();
    if (head.length > 0) consumeClientChunk(head);
    clientSocket.resume();
  };

  const processTranscriptOp = (sessionId: string, agentId: string, op: Record<string, unknown>): void => {
    const subKey = `${sessionId}:${agentId}`;
    if (!initialLoaded.has(subKey)) return;
    const kind = String(op.op ?? '');
    if (kind === 'turn.upsert') {
      const turnRaw = asRecord(op.turn);
      const turnId = String(turnRaw.turnId ?? '');
      if (!turnId) return;
      const mapped = v25TurnToV262(turnRaw, agentId);
      const turnKey = `${subKey}:${turnId}`;
      const prev = knownTurns.get(turnKey);
      const nextStatus = String(mapped.status ?? 'running');
      if (!prev) {
        knownTurns.set(turnKey, { status: nextStatus, steps: new Map() });
        sendToClient({
          type: 'turn.started',
          session_id: sessionId,
          agent_id: agentId,
          turn: { ...mapped, items: [] },
        });
        const items = Array.isArray(mapped.items) ? (mapped.items as Array<Record<string, unknown>>) : [];
        for (const item of items) {
          sendToClient({ type: 'item.started', session_id: sessionId, agent_id: agentId, turn_id: turnId, item });
          if (item.status !== 'running') {
            sendToClient({ type: 'item.ended', session_id: sessionId, agent_id: agentId, turn_id: turnId, item });
          }
        }
        if (nextStatus === 'ended') {
          sendToClient({ type: 'turn.ended', session_id: sessionId, agent_id: agentId, turn: mapped });
        }
      } else {
        prev.status = nextStatus;
        if (nextStatus === 'ended') {
          for (const fState of knownFrames.values()) {
            if (fState.turnId === turnId && !fState.terminal) {
              fState.terminal = true;
              const endedItem = { ...(fState.lastItem ?? { item_id: fState.itemId }), status: 'ended' };
              sendToClient({ type: 'item.ended', session_id: sessionId, agent_id: agentId, turn_id: turnId, item: endedItem });
            }
          }
          sendToClient({ type: 'turn.ended', session_id: sessionId, agent_id: agentId, turn: mapped });
        } else {
          sendToClient({ type: 'turn.updated', session_id: sessionId, agent_id: agentId, turn_id: turnId });
        }
      }
      return;
    }

    if (kind === 'step.upsert') {
      const turnId = String(op.turnId ?? '');
      const step = asRecord(op.step);
      const stepId = String(step.stepId ?? '');
      const stepIndex = typeof step.ordinal === 'number' ? Math.max(0, step.ordinal - 1) : 0;
      const turnKey = `${subKey}:${turnId}`;
      const tState = knownTurns.get(turnKey);
      if (tState && stepId) tState.steps.set(stepId, stepIndex);
      if (turnId) {
        sendToClient({
          type: 'turn.updated',
          session_id: sessionId,
          agent_id: agentId,
          turn_id: turnId,
          step: {
            index: stepIndex,
            ...(typeof step.startedAt === 'string' ? { started_at: step.startedAt } : {}),
            ...(typeof step.endedAt === 'string' ? { ended_at: step.endedAt } : {}),
          },
        });
      }
      return;
    }

    if (kind === 'frame.upsert') {
      const turnId = String(op.turnId ?? '');
      const stepId = String(op.stepId ?? '');
      const frame = asRecord(op.frame);
      const frameId = String(frame.frameId ?? '');
      if (!turnId || !frameId) return;
      const tState = knownTurns.get(`${subKey}:${turnId}`);
      const stepIndex = tState?.steps.get(stepId) ?? 0;
      const stepRunning = String(frame.state ?? '') === 'running' || tState?.status === 'running';
      const converted = v25FrameToV262Item(frame, stepIndex, agentId, new Date().toISOString(), stepRunning);
      if (!converted) return;
      const fKey = `${subKey}:${frameId}`;
      const prev = knownFrames.get(fKey);
      const itemId = String(converted.item.item_id ?? frameId);
      if (!prev) {
        knownFrames.set(fKey, {
          itemId,
          field: converted.field,
          turnId,
          stepIndex,
          terminal: converted.terminal,
          lastItem: converted.item,
        });
        sendToClient({
          type: 'item.started',
          session_id: sessionId,
          agent_id: agentId,
          turn_id: turnId,
          item: converted.item,
        });
        if (converted.terminal) {
          sendToClient({
            type: 'item.ended',
            session_id: sessionId,
            agent_id: agentId,
            turn_id: turnId,
            item: converted.item,
          });
        }
      } else {
        prev.terminal = converted.terminal;
        prev.lastItem = converted.item;
        if (converted.terminal) {
          sendToClient({
            type: 'item.ended',
            session_id: sessionId,
            agent_id: agentId,
            turn_id: turnId,
            item: converted.item,
          });
        } else {
          sendToClient({
            type: 'item.updated',
            session_id: sessionId,
            agent_id: agentId,
            turn_id: turnId,
            item_id: prev.itemId,
            set: converted.item,
          });
        }
      }
      return;
    }

    if (kind === 'append') {
      const target = asRecord(op.target);
      if (target.type !== 'frame') return;
      const turnId = String(target.turnId ?? '');
      const frameId = String(target.frameId ?? '');
      const delta = typeof op.text === 'string' ? op.text : '';
      if (!turnId || !frameId || !delta) return;
      const state = knownFrames.get(`${subKey}:${frameId}`);
      if (!state) return;
      if (state.lastItem) {
        const cur = typeof state.lastItem[state.field] === 'string' ? String(state.lastItem[state.field]) : '';
        state.lastItem[state.field] = cur + delta;
      }
      sendToClient({
        type: 'item.delta',
        session_id: sessionId,
        agent_id: agentId,
        turn_id: turnId,
        item_id: state.itemId,
        field: state.field,
        delta,
      });
    }
  };

  const handleUpstreamJson = (msg: Record<string, unknown>): void => {
    const type = String(msg.type ?? '');

    if (type === 'server_hello') {
      upstreamHelloSeen = true;
      wsSendMaskedText(
        upstreamSocket,
        JSON.stringify({
          type: 'client_hello',
          id: 'gw_hello',
          payload: { client_id: `gw-${randomUUID().slice(0, 8)}` },
        }),
      );
      while (upstreamOutQueue.length > 0) {
        const queued = upstreamOutQueue.shift()!;
        wsSendMaskedText(upstreamSocket, queued);
      }
      sendToClient(msg);
      return;
    }

    if (type === 'ack') {
      const id = typeof msg.id === 'string' ? msg.id : '';
      if (id === 'gw_hello') return;
      const pendingSub = pendingSubscribes.get(id);
      if (pendingSub) {
        pendingSubscribes.delete(id);
        const code = typeof msg.code === 'number' ? msg.code : 0;
        const msgText = typeof msg.msg === 'string' ? msg.msg : 'success';
        if (code !== 0) {
          sendToClient({ type: 'response', request_id: id, code, msg: msgText });
          for (const agentId of pendingSub.agentIds) {
            sendToClient({
              type: 'turns.failed',
              session_id: pendingSub.sessionId,
              agent_id: agentId,
              code,
              msg: msgText,
            });
          }
          return;
        }
        void pendingSub.fetchPromise
          .then((pages) => {
            if (closed) return;
            sendToClient({ type: 'response', request_id: id, code: 0, msg: 'success' });
            for (const page of pages) {
              const subKey = `${pendingSub.sessionId}:${page.agentId}`;
              subscribed.add(subKey);
              initialLoaded.add(subKey);
              for (const t of page.turns) {
                const tId = String(t.turn_id ?? '');
                const tState = String(t.status ?? 'ended');
                if (tId) knownTurns.set(`${subKey}:${tId}`, { status: tState, steps: new Map() });
              }
              sendToClient({
                type: 'turns',
                session_id: pendingSub.sessionId,
                agent_id: page.agentId,
                turns: page.turns,
                has_more: page.has_more,
              });
            }
          })
          .catch((err) => {
            if (closed) return;
            const errMsg = err instanceof Error ? err.message : String(err);
            sendToClient({ type: 'response', request_id: id, code: 50001, msg: errMsg });
            for (const agentId of pendingSub.agentIds) {
              sendToClient({
                type: 'turns.failed',
                session_id: pendingSub.sessionId,
                agent_id: agentId,
                code: 50001,
                msg: errMsg,
              });
            }
          });
        return;
      }
      if (id && pendingAcks.delete(id)) {
        sendToClient({
          type: 'response',
          request_id: id,
          code: typeof msg.code === 'number' ? msg.code : 0,
          msg: typeof msg.msg === 'string' ? msg.msg : 'success',
          ...asRecord(msg.payload),
        });
      }
      return;
    }

    if (type === 'transcript.reset') {
      const sessionId = typeof msg.session_id === 'string' ? msg.session_id : '';
      const payload = asRecord(msg.payload);
      const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : 'main';
      const subKey = `${sessionId}:${agentId}`;
      // On initial subscribe, REST fetch already returns full recent turns; skip empty reset frame.
      if (!initialLoaded.has(subKey)) return;
      const snapshot = asRecord(payload.snapshot);
      const items = Array.isArray(snapshot.items) ? (snapshot.items as Array<Record<string, unknown>>) : [];
      if (items.length === 0) return;
      const turns = items.map((t) => v25TurnToV262(asRecord(t), agentId));
      sendToClient({
        type: 'turns',
        session_id: sessionId,
        agent_id: agentId,
        turns,
        has_more: Boolean(payload.has_more_older),
      });
      return;
    }

    if (type === 'transcript.ops') {
      const sessionId = typeof msg.session_id === 'string' ? msg.session_id : '';
      const payload = asRecord(msg.payload);
      const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : 'main';
      const batches = Array.isArray(payload.batches) ? payload.batches : [];
      for (const batch of batches) {
        const ops = Array.isArray(asRecord(batch).ops) ? (asRecord(batch).ops as Array<Record<string, unknown>>) : [];
        for (const op of ops) {
          processTranscriptOp(sessionId, agentId, asRecord(op));
        }
      }
      return;
    }

    if (type === 'ping') {
      lastUpstreamPingAt = Date.now();
    }

    // Compatible 2.5/2.6 frames (task.list, task, agent, usage, goal, todo, interaction, task.output, ping, event.*, response)
    sendToClient(msg);
  };

  const handleClientJson = (msg: Record<string, unknown>): void => {
    const type = String(msg.type ?? '');
    if (type === 'subscribe') {
      const requestId = typeof msg.request_id === 'string' ? msg.request_id : randomUUID();
      const sessionId = typeof msg.session_id === 'string' ? msg.session_id : '';
      const rawAgents = Array.isArray(msg.agent_ids) ? msg.agent_ids : ['main'];
      const agentIds = rawAgents.filter((a): a is string => typeof a === 'string' && a.length > 0);
      if (!sessionId || agentIds.length === 0) {
        sendToClient({ type: 'response', request_id: requestId, code: 40001, msg: 'invalid subscribe' });
        return;
      }
      const fetchPromise = Promise.all(
        agentIds.map(async (agentId) => {
          const page = await fetchKimiV25Turns(upstream, sessionId, agentId, { pageSize: 20 });
          return { agentId, ...page };
        }),
      );
      pendingSubscribes.set(requestId, { sessionId, agentIds, fetchPromise });
      const transcriptSpec: Record<string, string> = {};
      for (const a of agentIds) transcriptSpec[a] = 'delta';
      sendToUpstream({
        type: 'subscribe_v2',
        id: requestId,
        payload: { session_id: sessionId, transcript: transcriptSpec },
      });
      return;
    }

    if (type === 'unsubscribe') {
      const requestId = typeof msg.request_id === 'string' ? msg.request_id : '';
      const sessionId = typeof msg.session_id === 'string' ? msg.session_id : '';
      const rawAgents = Array.isArray(msg.agent_ids) ? msg.agent_ids : undefined;
      const agentIds = rawAgents?.filter((a): a is string => typeof a === 'string' && a.length > 0);
      if (sessionId) {
        if (!agentIds) {
          for (const keyItem of [...subscribed]) {
            if (keyItem.startsWith(`${sessionId}:`)) {
              subscribed.delete(keyItem);
              initialLoaded.delete(keyItem);
            }
          }
        } else {
          for (const a of agentIds) {
            subscribed.delete(`${sessionId}:${a}`);
            initialLoaded.delete(`${sessionId}:${a}`);
          }
        }
      }
      if (requestId) pendingAcks.add(requestId);
      sendToUpstream({
        type: 'unsubscribe_v2',
        id: requestId,
        payload: { session_id: sessionId, ...(agentIds ? { agent_ids: agentIds } : {}) },
      });
      return;
    }

    if (type === 'pong') return;
    sendToUpstream(msg);
  };

  const upstreamParser = new WsFrameParser();
  let upstreamHandshakeBuf = Buffer.alloc(0);
  let upstreamFragments: Buffer[] | null = null;
  let upstreamFragmentBytes = 0;

  const consumeUpstreamFrames = (frames: ParsedWsFrame[]): void => {
    for (const f of frames) {
      if (f.opcode === 0x8) {
        cleanup();
        return;
      }
      if (f.opcode === 0x9) {
        lastUpstreamPingAt = Date.now();
        wsSendMaskedFrame(upstreamSocket, 0xa, f.payload);
        continue;
      }
      if (f.opcode === 0xa) continue;
      if (f.opcode === 0x1) {
        upstreamFragments = [f.payload];
        upstreamFragmentBytes = f.payload.byteLength;
      } else if (f.opcode === 0x0 && upstreamFragments) {
        upstreamFragmentBytes += f.payload.byteLength;
        if (upstreamFragmentBytes > WS_MAX_MESSAGE_BYTES) {
          cleanup();
          return;
        }
        upstreamFragments.push(f.payload);
      } else {
        continue;
      }
      if (f.fin && upstreamFragments) {
        const text = Buffer.concat(upstreamFragments).toString('utf8');
        upstreamFragments = null;
        upstreamFragmentBytes = 0;
        try {
          handleUpstreamJson(asRecord(JSON.parse(text)));
        } catch {
          // ignore malformed JSON
        }
      }
    }
  };

  upstreamSocket.on('connect', () => {
    const wsKey = randomBytes(16).toString('base64');
    const reqLines = [
      `GET ${upstreamUrl.pathname}${upstreamUrl.search} HTTP/1.1`,
      `Host: ${upstreamUrl.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${wsKey}`,
      'Sec-WebSocket-Version: 13',
      `Authorization: Bearer ${upstream.token}`,
    ];
    upstreamSocket.write(`${reqLines.join('\r\n')}\r\n\r\n`);
  });

  upstreamSocket.on('data', (chunk: Buffer) => {
    if (!upstreamUpgraded) {
      upstreamHandshakeBuf = Buffer.concat([upstreamHandshakeBuf, chunk]);
      const hdrEnd = upstreamHandshakeBuf.indexOf('\r\n\r\n');
      if (hdrEnd === -1) {
        if (upstreamHandshakeBuf.byteLength > 16 * 1024) cleanup();
        return;
      }
      const hdrText = upstreamHandshakeBuf.subarray(0, hdrEnd).toString('utf8');
      if (!/^HTTP\/1\.[01] 101\b/i.test(hdrText)) {
        if (!clientHandshaked && !clientSocket.destroyed) {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }
        cleanup();
        return;
      }
      upstreamUpgraded = true;
      completeHandshakeWithClient();
      const rest = upstreamHandshakeBuf.subarray(hdrEnd + 4);
      upstreamHandshakeBuf = Buffer.alloc(0);
      if (rest.length > 0) {
        try {
          consumeUpstreamFrames(upstreamParser.push(rest));
        } catch {
          cleanup();
        }
      }
      return;
    }
    try {
      consumeUpstreamFrames(upstreamParser.push(chunk));
    } catch {
      cleanup();
    }
  });

  clientSocket.on('data', consumeClientChunk);

  upstreamSocket.on('error', (err) => {
    if (!clientHandshaked && !clientSocket.destroyed) {
      clientSocket.write(
        'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n' +
          `kimi upstream unreachable: ${err.message}`,
      );
    }
    cleanup();
  });
  upstreamSocket.on('close', cleanup);
  clientSocket.on('error', cleanup);
  clientSocket.on('close', cleanup);
}
