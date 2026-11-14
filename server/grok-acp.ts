/**
 * Grok ACP client — one long-lived `grok agent stdio` JSON-RPC process.
 *
 * Verified against @xai-official/grok@1.0.77 (and 1.0.87 alpha):
 *   grok agent stdio [--always-approve]
 *
 * Handshake: initialize (protocolVersion 1) → initialized notification.
 * Sessions: session/new, session/load, session/resume, session/prompt,
 *           session/cancel, session/set_mode, session/set_model,
 *           session/set_config_option.
 * Agent→client requests: session/request_permission, _x.ai/ask_user_question.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as readline from 'node:readline';
import type { GrokNativeCommandInput } from './native-commands.js';
import type { StructuredQuestion } from './types.js';

export type JsonRpcId = string | number;

export interface GrokAcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface GrokAcpModelEffort {
  id: string;
  value: string;
  label?: string;
  description?: string;
  default?: boolean;
}

export interface GrokAcpModelInfo {
  modelId: string;
  name?: string;
  description?: string;
  totalContextTokens?: number;
  supportsReasoningEffort?: boolean;
  reasoningEffort?: string;
  reasoningEfforts?: GrokAcpModelEffort[];
}

export interface GrokAcpModelState {
  currentModelId?: string;
  availableModels: GrokAcpModelInfo[];
}

export interface GrokAcpConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: unknown;
  options?: Array<{ value: string; name?: string; description?: string }>;
}

export type GrokAcpPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | Record<string, unknown>;

export type GrokAcpEvent =
  | { type: 'message_chunk'; sessionId: string; text: string }
  | { type: 'thought_chunk'; sessionId: string; text: string }
  | {
      type: 'tool_call';
      sessionId: string;
      toolCallId: string;
      title: string;
      kind?: string;
      status?: string;
      rawInput?: unknown;
    }
  | {
      type: 'tool_call_update';
      sessionId: string;
      toolCallId: string;
      title?: string;
      status?: string;
      rawOutput?: unknown;
    }
  | {
      type: 'permission_request';
      sessionId: string;
      requestId: JsonRpcId;
      toolCall?: Record<string, unknown>;
      options: GrokAcpPermissionOption[];
    }
  | {
      type: 'question_request';
      sessionId: string;
      questionId: string;
      requestId?: JsonRpcId;
      toolCallId?: string;
      prompt: string;
      options: string[];
      questions: StructuredQuestion[];
      rawQuestions: unknown[];
    }
  | { type: 'usage'; sessionId: string; usage: Record<string, unknown> }
  | { type: 'available_commands'; sessionId: string; commands: GrokNativeCommandInput[]; tools?: string[] }
  | { type: 'model_state'; modelState: GrokAcpModelState }
  | { type: 'mode_update'; sessionId: string; modeId: string }
  | { type: 'model_update'; sessionId: string; modelId: string; reasoningEffort?: string }
  | { type: 'config_option_update'; sessionId: string; configOptions: GrokAcpConfigOption[] }
  | { type: 'goal_update'; sessionId: string; goal: Record<string, unknown> }
  | { type: 'plan'; sessionId: string; plan: Record<string, unknown> }
  | { type: 'disconnected'; code: number | null; signal: string | null }
  | { type: 'error'; message: string; sessionId?: string };

export type GrokAcpEventHandler = (event: GrokAcpEvent) => void;

export interface GrokAcpOptions {
  grokBin: string;
  env?: Record<string, string>;
  /** Pass `--always-approve` (yolo / bypassPermissions only). */
  alwaysApprove?: boolean;
  /** Timeout for initialize / session/new / load. Default 15_000. */
  requestTimeoutMs?: number;
  /** Timeout for session/prompt. 0 = none. Default 0. */
  promptTimeoutMs?: number;
  onStderr?: (line: string) => void;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export interface PendingPermission {
  id: JsonRpcId;
  sessionId: string;
  options: GrokAcpPermissionOption[];
  toolCall?: Record<string, unknown>;
}

export interface PendingQuestion {
  id?: JsonRpcId;
  questionId: string;
  sessionId: string;
  toolCallId?: string;
  prompt: string;
  options: string[];
  questions: StructuredQuestion[];
  rawQuestions: unknown[];
}

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  clientInfo: { name: 'multi-agent-gateway', version: '0.1.0' },
  _meta: { clientIdentifier: 'multi-agent-gateway' },
};

export class GrokAcpClient {
  private readonly grokBin: string;
  private readonly env: Record<string, string>;
  private readonly alwaysApprove: boolean;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly onStderr?: (line: string) => void;

  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly listeners = new Set<GrokAcpEventHandler>();
  private readyPromise: Promise<void> | null = null;
  private connected = false;
  private closed = false;

  private currentModelState: GrokAcpModelState | null = null;
  private initAvailableCommands: GrokNativeCommandInput[] = [];
  private readonly sessionAvailableCommands = new Map<string, GrokNativeCommandInput[]>();
  private readonly sessionConfigOptions = new Map<string, GrokAcpConfigOption[]>();

  constructor(options: GrokAcpOptions) {
    this.grokBin = options.grokBin;
    this.env = options.env ?? {};
    this.alwaysApprove = options.alwaysApprove === true;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 0;
    this.onStderr = options.onStderr;
  }

  get ready(): boolean {
    return this.connected && this.child != null && this.child.exitCode === null;
  }

  get alwaysApproveEnabled(): boolean {
    return this.alwaysApprove;
  }

  get modelState(): GrokAcpModelState | null {
    return this.currentModelState;
  }

  get availableCommands(): GrokNativeCommandInput[] {
    return [...this.initAvailableCommands];
  }

  getAvailableCommands(sessionId?: string): GrokNativeCommandInput[] {
    if (sessionId && this.sessionAvailableCommands.has(sessionId)) {
      return [...(this.sessionAvailableCommands.get(sessionId) ?? [])];
    }
    for (const cmds of this.sessionAvailableCommands.values()) {
      if (cmds.length > 0) return [...cmds];
    }
    return [...this.initAvailableCommands];
  }

  getConfigOptions(sessionId: string): GrokAcpConfigOption[] | undefined {
    return this.sessionConfigOptions.get(sessionId);
  }

  onEvent(handler: GrokAcpEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  getPendingPermission(approvalId: string): PendingPermission | undefined {
    return this.permissions.get(approvalId);
  }

  getPendingQuestion(questionId: string): PendingQuestion | undefined {
    const direct = this.questions.get(questionId);
    if (direct) return direct;
    for (const q of this.questions.values()) {
      if (q.toolCallId === questionId || (q.id !== undefined && String(q.id) === questionId)) {
        return q;
      }
    }
    return undefined;
  }

  /** Spawn `grok agent stdio` and run the initialize handshake. Idempotent. */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('GrokAcpClient is closed'));
    if (this.ready) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.doConnect().catch((err) => {
      this.readyPromise = null;
      this.connected = false;
      throw err;
    });
    return this.readyPromise;
  }

  async sessionNew(params: {
    cwd: string;
    mcpServers?: unknown[];
    sessionId?: string;
    yoloMode?: boolean;
    autoMode?: boolean;
    planMode?: boolean;
    model?: string;
    effort?: string;
  }): Promise<{
    sessionId: string;
    models?: GrokAcpModelState;
    configOptions?: GrokAcpConfigOption[];
  }> {
    await this.connect();
    const meta: Record<string, unknown> = {};
    if (params.yoloMode) meta.yoloMode = true;
    if (params.autoMode) meta.autoMode = true;
    if (params.planMode) meta.planMode = true;
    if (params.model) meta.model = params.model;
    if (params.effort) meta.effort = params.effort;
    const result = await this.request('session/new', {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    });
    const rec = (result ?? {}) as Record<string, unknown>;
    const sessionId = pickSessionId(rec) ?? params.sessionId;
    if (!sessionId) throw new Error('ACP session/new did not return sessionId');
    const models = parseModelState(rec.models);
    if (models) {
      this.currentModelState = models;
      this.emit({ type: 'model_state', modelState: models });
    }
    const configOptions = parseConfigOptions(rec.configOptions);
    if (configOptions.length > 0) {
      this.sessionConfigOptions.set(sessionId, configOptions);
    }
    return {
      sessionId,
      ...(models ? { models } : {}),
      ...(configOptions.length > 0 ? { configOptions } : {}),
    };
  }

  async sessionLoad(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: unknown[];
  }): Promise<{
    models?: GrokAcpModelState;
    configOptions?: GrokAcpConfigOption[];
  }> {
    await this.connect();
    const result = await this.request('session/load', {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    });
    const rec = (result ?? {}) as Record<string, unknown>;
    const models = parseModelState(rec.models);
    if (models) {
      this.currentModelState = models;
      this.emit({ type: 'model_state', modelState: models });
    }
    const configOptions = parseConfigOptions(rec.configOptions);
    if (configOptions.length > 0) {
      this.sessionConfigOptions.set(params.sessionId, configOptions);
    }
    return {
      ...(models ? { models } : {}),
      ...(configOptions.length > 0 ? { configOptions } : {}),
    };
  }

  async sessionResume(params: { sessionId: string; cwd: string }): Promise<void> {
    await this.connect();
    await this.request('session/resume', {
      sessionId: params.sessionId,
      cwd: params.cwd,
    });
  }

  async sessionFork(params: {
    sourceSessionId: string;
    sourceCwd: string;
    newCwd: string;
  }): Promise<{ newSessionId: string }> {
    await this.connect();
    const result = await this.request('_x.ai/session/fork', params);
    const rec = isRecord(result) ? result : {};
    const newSessionId = pickSessionId(rec) ?? (typeof rec.newSessionId === 'string' ? rec.newSessionId : '');
    if (!newSessionId) throw new Error('ACP _x.ai/session/fork did not return newSessionId');
    return { newSessionId };
  }

  async sessionRename(sessionId: string, title: string): Promise<void> {
    await this.connect();
    await this.request('_x.ai/session/rename', { sessionId, title });
  }

  async sessionDelete(sessionId: string): Promise<void> {
    await this.connect();
    await this.request('_x.ai/session/delete', { sessionId });
  }

  async rewindExecute(params: {
    sessionId: string;
    targetPromptIndex: number;
    mode?: 'conversation_only' | 'code_and_conversation';
  }): Promise<{ success: boolean; error?: string }> {
    await this.connect();
    const result = await this.request('_x.ai/rewind/execute', {
      sessionId: params.sessionId,
      target_prompt_index: params.targetPromptIndex,
      mode: params.mode ?? 'conversation_only',
    });
    const rec = isRecord(result) ? result : {};
    return {
      success: rec.success === true,
      ...(typeof rec.error === 'string' ? { error: rec.error } : {}),
    };
  }

  async sessionSetMode(sessionId: string, modeId: string): Promise<void> {
    await this.connect();
    await this.request('session/set_mode', { sessionId, modeId });
  }

  async sessionSetModel(sessionId: string, modelId: string): Promise<void> {
    await this.connect();
    await this.request('session/set_model', { sessionId, modelId });
  }

  async sessionSetConfigOption(
    sessionId: string,
    configId: string,
    value: string | { value: string },
  ): Promise<GrokAcpConfigOption[]> {
    await this.connect();
    const wireValue =
      typeof value === 'object' && value !== null && typeof value.value === 'string'
        ? value.value
        : String(value);
    const result = await this.request('session/set_config_option', {
      sessionId,
      configId,
      value: wireValue,
    });
    const rec = (result ?? {}) as Record<string, unknown>;
    const configOptions = parseConfigOptions(rec.configOptions ?? result);
    if (configOptions.length > 0) {
      this.sessionConfigOptions.set(sessionId, configOptions);
    }
    return configOptions;
  }

  async sessionPrompt(params: {
    sessionId: string;
    prompt: string | Array<Record<string, unknown>>;
  }): Promise<{ stopReason?: string; _meta?: Record<string, unknown> }> {
    await this.connect();
    const promptBlocks = normalizePromptBlocks(params.prompt);
    const result = await this.request(
      'session/prompt',
      { sessionId: params.sessionId, prompt: promptBlocks },
      this.promptTimeoutMs,
    );
    const rec = (result ?? {}) as Record<string, unknown>;
    const stopReason = typeof rec.stopReason === 'string' ? rec.stopReason : undefined;
    const meta = isRecord(rec._meta) ? rec._meta : undefined;
    return { stopReason, ...(meta ? { _meta: meta } : {}) };
  }

  async sessionCancel(sessionId: string): Promise<void> {
    if (!this.ready) return;
    this.notify('session/cancel', { sessionId });
  }

  resolvePermission(requestId: JsonRpcId, optionId: string): void {
    const key = String(requestId);
    this.permissions.delete(key);
    this.respond(requestId, { outcome: { outcome: 'selected', optionId } });
  }

  cancelPermission(requestId: JsonRpcId): void {
    const key = String(requestId);
    this.permissions.delete(key);
    this.respond(requestId, { outcome: { outcome: 'cancelled' } });
  }

  resolveQuestion(questionId: string, answer: string | Record<string, string[]>): boolean {
    const parked = this.getPendingQuestion(questionId);
    if (!parked) return false;
    this.deletePendingQuestion(parked);
    const answers = buildQuestionAnswersMap(parked, answer);
    if (parked.id !== undefined) {
      this.respond(parked.id, { outcome: 'accepted', answers });
    }
    return true;
  }

  cancelQuestion(questionId: string): boolean {
    const parked = this.getPendingQuestion(questionId);
    if (!parked) return false;
    this.deletePendingQuestion(parked);
    if (parked.id !== undefined) {
      this.respond(parked.id, { outcome: 'cancelled' });
    }
    return true;
  }

  private deletePendingQuestion(parked: PendingQuestion): void {
    this.questions.delete(parked.questionId);
    if (parked.id !== undefined) this.questions.delete(String(parked.id));
    if (parked.toolCallId) this.questions.delete(parked.toolCallId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.readyPromise = null;
    this.rl?.close();
    this.rl = null;
    const child = this.child;
    this.child = null;
    this.rejectAll(new Error('Grok ACP client closed'));
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          try {
            if (child.exitCode === null) child.kill('SIGKILL');
          } catch {
            // ignore
          }
          res();
        }, 3_000);
        t.unref?.();
        child.once('exit', () => {
          clearTimeout(t);
          res();
        });
      });
    }
  }

  private async doConnect(): Promise<void> {
    const args = ['agent', 'stdio'];
    if (this.alwaysApprove) args.push('--always-approve');
    const child = spawn(this.grokBin, args, {
      cwd: os.homedir(),
      env: this.childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.on('error', (err) => this.handleExit(err));
    child.on('exit', (code, signal) => this.handleExit(null, code, signal));
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.onStderr?.(line);
      }
    });
    this.rl = readline.createInterface({ input: child.stdout! });
    this.rl.on('line', (line) => this.handleLine(line));

    try {
      const initResult = await this.request('initialize', INIT_PARAMS, this.requestTimeoutMs);
      this.applyInitResult(initResult);
      this.notify('initialized', {});
      this.connected = true;
    } catch (err) {
      this.connected = false;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.child = null;
      this.rl?.close();
      this.rl = null;
      throw err;
    }
  }

  private applyInitResult(initResult: unknown): void {
    if (!isRecord(initResult)) return;
    const meta = isRecord(initResult._meta) ? initResult._meta : initResult;
    const modelState = parseModelState(meta.modelState ?? initResult.models);
    if (modelState) {
      this.currentModelState = modelState;
      this.emit({ type: 'model_state', modelState });
    }
    const commands = parseAvailableCommands(meta.availableCommands ?? initResult.availableCommands);
    if (commands.length > 0) {
      this.initAvailableCommands = commands;
      this.emit({ type: 'available_commands', sessionId: '', commands });
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const id = msg.id as JsonRpcId | undefined;
    const method = msg.method as string | undefined;

    if (id !== undefined && method !== undefined) {
      this.handleServerRequest(id, method, msg.params);
    } else if (id !== undefined) {
      this.handleResponse(id, msg);
    } else if (method !== undefined) {
      this.handleNotification(method, msg.params);
    }
  }

  private handleResponse(id: JsonRpcId, msg: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    const err = msg.error as { code?: number; message?: string; data?: unknown } | undefined;
    if (err) {
      const detail = typeof err.data === 'string' && err.data ? `: ${err.data}` : '';
      pending.reject(
        new Error(`ACP '${pending.method}' failed (${err.code ?? '?'}): ${err.message ?? 'unknown error'}${detail}`),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (method === 'session/request_permission') {
      const p = (params ?? {}) as Record<string, unknown>;
      const sessionId = String(p.sessionId ?? '');
      const options = normalizePermissionOptions(p.options);
      const toolCall = isRecord(p.toolCall) ? p.toolCall : undefined;
      const parked: PendingPermission = { id, sessionId, options, toolCall };
      this.permissions.set(String(id), parked);
      this.emit({
        type: 'permission_request',
        sessionId,
        requestId: id,
        toolCall,
        options,
      });
      return;
    }
    if (
      method === '_x.ai/ask_user_question' ||
      method === 'x.ai/ask_user_question' ||
      method === 'ask_user_question' ||
      method === 'session/request_question'
    ) {
      const p = (params ?? {}) as Record<string, unknown>;
      const sessionId = String(p.sessionId ?? p.session_id ?? '');
      const toolCallId =
        typeof p.toolCallId === 'string'
          ? p.toolCallId
          : typeof p.tool_call_id === 'string'
            ? p.tool_call_id
            : undefined;
      const questionId = toolCallId || String(id);
      const normalized = normalizeQuestionPayload(p);
      const parked: PendingQuestion = {
        id,
        questionId,
        sessionId,
        toolCallId,
        prompt: normalized.prompt,
        options: normalized.options,
        questions: normalized.questions,
        rawQuestions: normalized.rawQuestions,
      };
      this.questions.set(questionId, parked);
      this.questions.set(String(id), parked);
      if (toolCallId) this.questions.set(toolCallId, parked);
      this.emit({
        type: 'question_request',
        sessionId,
        questionId,
        requestId: id,
        toolCallId,
        prompt: normalized.prompt,
        options: normalized.options,
        questions: normalized.questions,
        rawQuestions: normalized.rawQuestions,
      });
      return;
    }
    this.respondError(id, -32601, `Method not found: ${method}`);
  }

  private handleNotification(method: string, params: unknown): void {
    const normalizedMethod = method.startsWith('_') ? method.slice(1) : method;
    if (
      normalizedMethod !== 'session/update' &&
      normalizedMethod !== 'x.ai/session/update' &&
      normalizedMethod !== 'x.ai/session_notification'
    ) {
      return;
    }
    const p = (params ?? {}) as Record<string, unknown>;
    const sessionId = String(p.sessionId ?? p.session_id ?? '');
    const update = isRecord(p.update) ? p.update : p;
    const kind = String(update.sessionUpdate ?? update.type ?? '');
    switch (kind) {
      case 'agent_message_chunk': {
        const text = textOfContent(update.content);
        if (text) this.emit({ type: 'message_chunk', sessionId, text });
        break;
      }
      case 'agent_thought_chunk': {
        const text = textOfContent(update.content);
        if (text) this.emit({ type: 'thought_chunk', sessionId, text });
        break;
      }
      case 'tool_call': {
        const toolCallId = String(update.toolCallId ?? update.id ?? '');
        const title = String(update.title ?? update.toolName ?? update.name ?? update.kind ?? 'tool');
        const toolName = String(update.toolName ?? update.name ?? update.title ?? '');
        const rawInput = update.rawInput ?? update.input;
        this.emit({
          type: 'tool_call',
          sessionId,
          toolCallId,
          title,
          kind: typeof update.kind === 'string' ? update.kind : undefined,
          status: typeof update.status === 'string' ? update.status : undefined,
          rawInput,
        });
        if (
          (toolName === 'ask_user_question' || title === 'ask_user_question' || update.kind === 'ask_user_question') &&
          isRecord(rawInput) &&
          Array.isArray(rawInput.questions)
        ) {
          const qid = toolCallId || `q_${Date.now()}`;
          if (!this.getPendingQuestion(qid)) {
            const normalized = normalizeQuestionPayload(rawInput);
            const parked: PendingQuestion = {
              questionId: qid,
              sessionId,
              toolCallId: toolCallId || undefined,
              prompt: normalized.prompt,
              options: normalized.options,
              questions: normalized.questions,
              rawQuestions: normalized.rawQuestions,
            };
            this.questions.set(qid, parked);
            this.emit({
              type: 'question_request',
              sessionId,
              questionId: qid,
              toolCallId: toolCallId || undefined,
              prompt: normalized.prompt,
              options: normalized.options,
              questions: normalized.questions,
              rawQuestions: normalized.rawQuestions,
            });
          }
        }
        break;
      }
      case 'tool_call_update': {
        this.emit({
          type: 'tool_call_update',
          sessionId,
          toolCallId: String(update.toolCallId ?? update.id ?? ''),
          title: typeof update.title === 'string' ? update.title : undefined,
          status: typeof update.status === 'string' ? update.status : undefined,
          rawOutput: update.rawOutput ?? update.content,
        });
        break;
      }
      case 'ask_user_question':
      case 'pending_interaction': {
        if (kind === 'pending_interaction' && !Array.isArray(update.questions) && !isRecord(update.input)) {
          break;
        }
        const toolCallId =
          typeof update.toolCallId === 'string'
            ? update.toolCallId
            : typeof update.tool_call_id === 'string'
              ? update.tool_call_id
              : undefined;
        const qid = String(update.questionId ?? update.question_id ?? toolCallId ?? `q_${Date.now()}`);
        if (!this.getPendingQuestion(qid)) {
          const normalized = normalizeQuestionPayload(isRecord(update.input) ? update.input : update);
          const parked: PendingQuestion = {
            questionId: qid,
            sessionId,
            toolCallId,
            prompt: normalized.prompt,
            options: normalized.options,
            questions: normalized.questions,
            rawQuestions: normalized.rawQuestions,
          };
          this.questions.set(qid, parked);
          if (toolCallId) this.questions.set(toolCallId, parked);
          this.emit({
            type: 'question_request',
            sessionId,
            questionId: qid,
            toolCallId,
            prompt: normalized.prompt,
            options: normalized.options,
            questions: normalized.questions,
            rawQuestions: normalized.rawQuestions,
          });
        }
        break;
      }
      case 'available_commands_update': {
        const commands = parseAvailableCommands(update.availableCommands);
        if (sessionId) this.sessionAvailableCommands.set(sessionId, commands);
        if (commands.length > 0) this.initAvailableCommands = commands;
        const meta = isRecord(update._meta) ? update._meta : undefined;
        const tools = Array.isArray(meta?.tools)
          ? meta.tools.filter((t): t is string => typeof t === 'string')
          : undefined;
        this.emit({ type: 'available_commands', sessionId, commands, ...(tools ? { tools } : {}) });
        break;
      }
      case 'current_mode_update': {
        const modeId = String(update.currentModeId ?? update.modeId ?? '');
        if (modeId) this.emit({ type: 'mode_update', sessionId, modeId });
        break;
      }
      case 'config_option_update': {
        const configOptions = parseConfigOptions(update.configOptions);
        if (sessionId && configOptions.length > 0) {
          this.sessionConfigOptions.set(sessionId, configOptions);
        }
        this.emit({ type: 'config_option_update', sessionId, configOptions });
        break;
      }
      case 'model_changed':
      case 'model_auto_switched': {
        const modelId = String(update.model_id ?? update.modelId ?? '');
        const reasoningEffort =
          typeof update.reasoning_effort === 'string'
            ? update.reasoning_effort
            : typeof update.reasoningEffort === 'string'
              ? update.reasoningEffort
              : undefined;
        if (modelId) {
          if (this.currentModelState) this.currentModelState.currentModelId = modelId;
          this.emit({ type: 'model_update', sessionId, modelId, ...(reasoningEffort ? { reasoningEffort } : {}) });
        }
        break;
      }
      case 'goal_updated':
      case 'session/goal_updated':
      case 'session/goal_planner':
      case 'session/goal_tracker':
      case 'session/goal_stop_detector': {
        this.emit({ type: 'goal_update', sessionId, goal: update });
        break;
      }
      case 'plan': {
        this.emit({ type: 'plan', sessionId, plan: update });
        break;
      }
      case 'usage_update':
      case 'current_usage_update':
      case 'turn_usage': {
        this.emit({ type: 'usage', sessionId, usage: update });
        break;
      }
      default: {
        if (kind.startsWith('goal_') || kind.startsWith('session/goal_')) {
          this.emit({ type: 'goal_update', sessionId, goal: update });
        } else if (looksLikeUsage(update)) {
          this.emit({ type: 'usage', sessionId, usage: update });
        }
        break;
      }
    }
  }

  private request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const budget = timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      if (budget > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP '${method}' timed out after ${budget}ms`));
        }, budget);
        timer.unref?.();
      }
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params: params ?? {} });
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private write(msg: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new Error('Grok ACP process is not running');
    stdin.write(JSON.stringify(msg) + '\n');
  }

  private emit(event: GrokAcpEvent): void {
    for (const handler of [...this.listeners]) {
      try {
        handler(event);
      } catch {
        // listener errors must not break dispatch
      }
    }
  }

  private handleExit(err: Error | null, code?: number | null, signal?: NodeJS.Signals | null): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.readyPromise = null;
    this.child = null;
    this.rl?.close();
    this.rl = null;
    const message = err
      ? `Grok ACP spawn failed: ${err.message}`
      : `Grok ACP exited (code=${code ?? null}, signal=${signal ?? null})`;
    this.rejectAll(new Error(message));
    this.permissions.clear();
    this.questions.clear();
    if (wasConnected || err) {
      this.emit({ type: 'disconnected', code: code ?? null, signal: signal ?? null });
    }
  }

  private rejectAll(err: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.env, PYTHONUNBUFFERED: '1' };
    for (const key of Object.keys(env)) {
      if (key.startsWith('GATEWAY_')) delete env[key];
    }
    const extra = ['127.0.0.1', 'localhost', '::1'];
    const current = String(env.NO_PROXY ?? env.no_proxy ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    env.NO_PROXY = [...new Set([...current, ...extra])].join(',');
    env.no_proxy = env.NO_PROXY;
    return env;
  }
}

export function normalizePromptBlocks(
  prompt: string | Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (typeof prompt === 'string') {
    return [{ type: 'text', text: prompt }];
  }
  if (!Array.isArray(prompt) || prompt.length === 0) {
    return [{ type: 'text', text: '' }];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const item of prompt) {
    if (typeof item === 'string') {
      out.push({ type: 'text', text: item });
      continue;
    }
    if (!isRecord(item)) continue;
    if (item.type === 'text') {
      out.push({ type: 'text', text: String(item.text ?? '') });
    } else if (item.type === 'image' && isRecord(item.source)) {
      out.push({
        type: 'image',
        data: String(item.source.data ?? ''),
        mimeType: String(item.source.media_type ?? 'image/png'),
      });
    } else {
      out.push(item);
    }
  }
  return out.length > 0 ? out : [{ type: 'text', text: '' }];
}

export function pickPermissionOption(
  options: GrokAcpPermissionOption[],
  decision: 'approve' | 'approve_always' | 'reject',
): string | undefined {
  const hay = (o: GrokAcpPermissionOption): string =>
    `${o.kind ?? ''} ${o.name ?? ''} ${o.optionId ?? ''}`.toLowerCase();
  if (decision === 'approve_always') {
    return options.find((o) => /allow[_-]?always/.test(hay(o)))?.optionId
      ?? options.find((o) => hay(o).includes('allow'))?.optionId;
  }
  if (decision === 'approve') {
    return options.find((o) => /allow[_-]?once/.test(hay(o)))?.optionId
      ?? options.find((o) => hay(o).includes('allow'))?.optionId;
  }
  return options.find((o) => hay(o).includes('reject'))?.optionId;
}

function pickSessionId(rec: Record<string, unknown>): string | undefined {
  for (const key of ['sessionId', 'session_id', 'id']) {
    const value = rec[key];
    if (typeof value === 'string' && value) return value;
  }
  if (isRecord(rec.session)) return pickSessionId(rec.session);
  return undefined;
}

function parseModelState(raw: unknown): GrokAcpModelState | null {
  if (!isRecord(raw)) return null;
  const currentModelId = typeof raw.currentModelId === 'string' ? raw.currentModelId : undefined;
  const rawModels = Array.isArray(raw.availableModels) ? raw.availableModels : [];
  const availableModels: GrokAcpModelInfo[] = [];
  for (const item of rawModels) {
    if (!isRecord(item)) continue;
    const modelId = String(item.modelId ?? item.id ?? '');
    if (!modelId) continue;
    const meta = isRecord(item._meta) ? item._meta : {};
    const rawEfforts = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : [];
    const reasoningEfforts: GrokAcpModelEffort[] = [];
    for (const eff of rawEfforts) {
      if (!isRecord(eff)) continue;
      const value = String(eff.value ?? eff.id ?? '');
      if (!value) continue;
      reasoningEfforts.push({
        id: String(eff.id ?? value),
        value,
        ...(typeof eff.label === 'string' ? { label: eff.label } : {}),
        ...(typeof eff.description === 'string' ? { description: eff.description } : {}),
        ...(typeof eff.default === 'boolean' ? { default: eff.default } : {}),
      });
    }
    availableModels.push({
      modelId,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      ...(typeof meta.totalContextTokens === 'number' ? { totalContextTokens: meta.totalContextTokens } : {}),
      ...(typeof meta.supportsReasoningEffort === 'boolean'
        ? { supportsReasoningEffort: meta.supportsReasoningEffort }
        : {}),
      ...(typeof meta.reasoningEffort === 'string' ? { reasoningEffort: meta.reasoningEffort } : {}),
      ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
    });
  }
  if (!currentModelId && availableModels.length === 0) return null;
  return { ...(currentModelId ? { currentModelId } : {}), availableModels };
}

function parseAvailableCommands(raw: unknown): GrokNativeCommandInput[] {
  if (!Array.isArray(raw)) return [];
  const out: GrokNativeCommandInput[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === 'string' ? item.name.replace(/^\//, '').trim() : '';
    if (!name) continue;
    const input = isRecord(item.input)
      ? { hint: typeof item.input.hint === 'string' ? item.input.hint : null }
      : null;
    const aliases = Array.isArray(item.aliases)
      ? item.aliases.filter((a): a is string => typeof a === 'string' && a.length > 0)
      : undefined;
    out.push({
      name,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      input,
      ...(typeof item.argumentHint === 'string' ? { argumentHint: item.argumentHint } : {}),
      ...(aliases && aliases.length > 0 ? { aliases } : {}),
    });
  }
  return out;
}

function parseConfigOptions(raw: unknown): GrokAcpConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: GrokAcpConfigOption[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = String(item.id ?? item.configId ?? '');
    if (!id) continue;
    const options = Array.isArray(item.options)
      ? item.options
          .filter(isRecord)
          .map((o) => ({
            value: String(o.value ?? o.id ?? ''),
            ...(typeof o.name === 'string' ? { name: o.name } : {}),
            ...(typeof o.description === 'string' ? { description: o.description } : {}),
          }))
          .filter((o) => o.value.length > 0)
      : undefined;
    out.push({
      id,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.category === 'string' ? { category: item.category } : {}),
      ...(typeof item.type === 'string' ? { type: item.type } : {}),
      ...(item.currentValue !== undefined ? { currentValue: item.currentValue } : {}),
      ...(options ? { options } : {}),
    });
  }
  return out;
}

function normalizePermissionOptions(raw: unknown): GrokAcpPermissionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: GrokAcpPermissionOption[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const optionId = String(item.optionId ?? item.id ?? '');
    if (!optionId) continue;
    out.push({
      optionId,
      name: typeof item.name === 'string' ? item.name : undefined,
      kind: typeof item.kind === 'string' ? item.kind : undefined,
    });
  }
  return out;
}

function normalizeQuestionPayload(raw: Record<string, unknown>): {
  prompt: string;
  options: string[];
  questions: StructuredQuestion[];
  rawQuestions: unknown[];
} {
  const rawQuestions = Array.isArray(raw.questions) ? raw.questions : [];
  const questions: StructuredQuestion[] = [];
  const flatOptions: string[] = [];
  for (let i = 0; i < rawQuestions.length; i++) {
    const item = rawQuestions[i];
    if (!isRecord(item)) continue;
    const id = String(item.id ?? `q_${i}`);
    const question = String(item.question ?? item.prompt ?? item.header ?? '');
    const rawOpts = Array.isArray(item.options) ? item.options : [];
    const options = rawOpts
      .map((o, j) => {
        if (typeof o === 'string') {
          if (i === 0) flatOptions.push(o);
          return { id: o, label: o };
        }
        if (!isRecord(o)) return null;
        const label = String(o.label ?? o.id ?? o.value ?? `Option ${j + 1}`);
        const optId = String(o.id ?? o.label ?? o.value ?? `opt_${j}`);
        if (i === 0) flatOptions.push(label);
        return {
          id: optId,
          label,
          ...(typeof o.description === 'string' ? { description: o.description } : {}),
        };
      })
      .filter((o): o is NonNullable<typeof o> => o !== null);
    questions.push({
      id,
      question,
      ...(typeof item.header === 'string' ? { header: item.header } : {}),
      options,
      ...(item.multiSelect === true || item.multi_select === true ? { multiSelect: true } : {}),
      isOther: true,
    });
  }
  const prompt =
    questions[0]?.question ||
    (typeof raw.prompt === 'string' ? raw.prompt : '') ||
    (typeof raw.question === 'string' ? raw.question : 'Question');
  if (questions.length === 0) {
    const fallbackOpts = Array.isArray(raw.options)
      ? raw.options.map((o) => (typeof o === 'string' ? o : isRecord(o) ? String(o.label ?? o.id ?? '') : '')).filter(Boolean)
      : [];
    questions.push({
      id: 'q_0',
      question: prompt,
      options: fallbackOpts.map((label) => ({ id: label, label })),
      isOther: true,
    });
    flatOptions.push(...fallbackOpts);
  }
  return {
    prompt,
    options: flatOptions,
    questions,
    rawQuestions: rawQuestions.length > 0 ? rawQuestions : questions,
  };
}

function buildQuestionAnswersMap(
  parked: PendingQuestion,
  answer: string | Record<string, string[]>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (typeof answer === 'string') {
    const first = parked.questions[0];
    const key = first?.question || first?.id || 'q_0';
    out[key] = answer;
    if (first?.id && first.id !== key) out[first.id] = [answer];
    return out;
  }
  for (const [k, vals] of Object.entries(answer)) {
    const arr = Array.isArray(vals) ? vals.map(String) : [String(vals)];
    const matched = parked.questions.find((q, idx) => q.id === k || `q_${idx}` === k || q.question === k);
    if (matched) {
      const value: string | string[] = matched.multiSelect ? arr : (arr[0] ?? '');
      if (matched.question) out[matched.question] = value;
      out[matched.id] = arr;
    } else {
      out[k] = arr.length === 1 ? arr[0] : arr;
    }
  }
  return out;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  if (Array.isArray(content)) {
    return content.map((c) => textOfContent(c)).join('');
  }
  return '';
}

function looksLikeUsage(update: Record<string, unknown>): boolean {
  return 'used' in update
    || 'input_tokens' in update
    || 'inputTokens' in update
    || 'total_cost_usd' in update
    || 'cachedReadTokens' in update
    || 'reasoningTokens' in update;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
