/**
 * 多 Agent 网关的统一 provider 抽象。
 *
 * gateway 对官方 kimi-web 前端讲 Kimi kap-server 协议(`/api/v1` REST + WS),
 * 内部按 provider 分流到 Kimi(无损代理)/ Codex(JSON-RPC)/ Claude(CLI stream-json)/ Grok(CLI/ACP)/ Pi(RPC)。
 * 本文件是 adapter 与 facade 共用的契约:类型形状贴近 Kimi wire 协议
 * (snake_case 字段、ISO 时间戳),让 Kimi 路径可以几乎零映射透传,
 * 同时保留 Codex / Claude / Grok / Pi 能映射进来的最小扩展点(`provider`、`extras`)。
 */

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type ProviderName = 'kimi' | 'claude' | 'codex' | 'grok' | 'pi' | 'dsh';

export const PROVIDER_NAMES: readonly ProviderName[] = ['kimi', 'claude', 'codex', 'grok', 'pi', 'dsh'];

export function isProviderName(value: unknown): value is ProviderName {
  return value === 'kimi' || value === 'claude' || value === 'codex' || value === 'grok' || value === 'pi' || value === 'dsh';
}

// ---------------------------------------------------------------------------
// Session —— 贴近 kap-server 的 wire Session
// ---------------------------------------------------------------------------

export interface SessionMetadata {
  /** 会话工作目录(三家都用 cwd 作为执行根)。 */
  cwd: string;
  [key: string]: unknown;
}

export interface Session {
  id: string;
  workspace_id: string;
  title: string;
  /** ISO-8601 时间戳,与 Kimi wire 一致。 */
  created_at: string;
  updated_at: string;
  /** 是否有进行中的 turn / 后台任务。 */
  busy: boolean;
  archived?: boolean;
  metadata: SessionMetadata;
  /** gateway 扩展:该会话归属的 provider(Kimi wire 无此字段,facade 注入)。 */
  provider: ProviderName;
  /** Kimi 透传字段(main_turn_active / pending_interaction / usage 等)原样放这里。 */
  extras?: Record<string, unknown>;
}

export interface SessionPage {
  items: Session[];
  /** 游标分页:还有更早数据时给出下一页游标。 */
  next_cursor?: string;
}

export interface ListSessionsQuery {
  workspace_id?: string;
  /** adapter 内部按真实工作目录过滤,不从 workspace id 反推路径。 */
  cwd?: string;
  /** 只列某个 provider;缺省由 facade 聚合全部。 */
  provider?: ProviderName;
  limit?: number;
  cursor?: string;
  archived?: boolean;
}

export interface CreateSessionInput {
  provider: ProviderName;
  /** 与 Kimi 协议一致:workspace_id 或 metadata.cwd 至少给一个。 */
  workspace_id?: string;
  cwd?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Message —— 历史消息(content 为分块数组,贴近 Kimi wire)
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text?: string; thinking?: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown; phase?: string; parent_tool_use_id?: string }
  | { type: 'tool_use'; tool_call_id: string; tool_name: string; input: unknown; phase?: string; parent_tool_use_id?: string }
  | {
      type: 'tool_result';
      tool_call_id: string;
      content?: unknown;
      output?: unknown;
      is_error?: boolean;
      structured_output?: unknown;
      structuredOutput?: unknown;
      parent_tool_use_id?: string;
    }
  | {
      type: 'image';
      mime_type?: string;
      mimeType?: string;
      data?: string;
      url?: string;
      image_url?: string;
      ref?: string;
      name?: string;
      path?: string;
    }
  | {
      type: 'file' | 'document' | 'audio';
      mime_type?: string;
      mimeType?: string;
      data?: string;
      url?: string;
      ref?: string;
      name?: string;
      path?: string;
      text?: string;
    };

export interface Message {
  id: string;
  session_id: string;
  role: MessageRole;
  content: MessageContentPart[];
  created_at: string;
  /** provider 特有信息(如 Codex 的 reasoning effort、Claude 的 model)。 */
  metadata?: Record<string, unknown>;
}

export interface HistoryQuery {
  limit?: number;
  /** 游标:只取此消息之前的更早历史。 */
  before_id?: string;
}

// ---------------------------------------------------------------------------
// 事件 —— startTurn 流式产出,facade 桥接到 WS
// ---------------------------------------------------------------------------

export type GatewayEventKind =
  | 'turn'
  | 'message'
  | 'thinking'
  | 'tool'
  | 'approval'
  | 'question'
  | 'plan'
  | 'diff'
  | 'notice'
  | 'usage'
  | 'subagent'
  | 'task'
  | 'interaction_resolved'
  | 'session'
  | 'passthrough'
  | 'raw';

export type EventStatus =
  | 'started'
  | 'delta'
  | 'updated'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface GatewayEvent<
  K extends GatewayEventKind = GatewayEventKind,
  P = unknown,
> {
  kind: K;
  status: EventStatus;
  sessionId: string;
  /** 归属的 turn;会话级事件(如会话元数据变化)可缺省。 */
  turnId?: string;
  payload: P;
  /** epoch ms。 */
  timestamp: number;
  /** 可选原生透传载荷(未映射或需要保留的原始通知/事件)。 */
  raw?: unknown;
  /** 可选子代理/阶段归属元数据。 */
  parentToolUseId?: string;
  agentId?: string;
  phase?: string;
}

export interface TurnPayload {
  reason?: 'completed' | 'cancelled' | 'failed';
  error?: string;
  usage?: SessionUsage;
  raw?: unknown;
}

export interface MessagePayload {
  message: Message;
  /** status='delta' 时的增量文本(assistant 输出流)。 */
  delta?: string;
  phase?: string;
  parentToolUseId?: string;
  agentId?: string;
  raw?: unknown;
}

export interface ThinkingPayload {
  text: string;
  /** status='delta' 时的增量思考文本。 */
  delta?: string;
  phase?: string;
  parentToolUseId?: string;
  agentId?: string;
  raw?: unknown;
}

export interface ToolPayload {
  toolCallId: string;
  name: string;
  input?: unknown;
  output?: string;
  /** 结构化/非字符串工具输出(如 MCP structuredContent、dynamic contentItems)。 */
  structuredOutput?: unknown;
  is_error?: boolean;
  /** 子代理工具归属的父工具调用 ID(如 Claude parent_tool_use_id)。 */
  parentToolUseId?: string;
  /** 工具或输出阶段标记(如 commentary / final_answer)。 */
  phase?: string;
  agentId?: string;
  raw?: unknown;
}

export type ApprovalKind =
  | 'commandExecution'
  | 'fileChange'
  | 'permissions'
  | 'mcpElicitation'
  | 'tool'
  | string;

export type GranularApprovalKind =
  | 'approve'
  | 'approve_always'
  | 'reject'
  | 'cancel'
  | 'accept_with_execpolicy_amendment'
  | 'apply_network_policy_amendment'
  | 'accept_with_permissions'
  | 'accept_elicitation'
  | 'decline_elicitation';

export interface ApprovalPayload {
  approvalId: string;
  /** 请求审批的工具/命令描述。 */
  tool: string;
  /** 审批类别(命令、改文件、权限升级、MCP elicitation 等)。 */
  kind?: ApprovalKind;
  input?: unknown;
  options?: string[];
  /** codex 审批挂在具体 item 上;前端据此把审批卡贴到对应工具卡。 */
  itemId?: string;
  /** 后端允许呈现的细粒度决策选项(如 Codex availableDecisions)。 */
  availableDecisions?: Array<GranularApprovalKind | string | Record<string, unknown>>;
  /** 权限持久化建议(如 Claude permission_suggestions / Codex proposed amendment)。 */
  suggestions?: unknown[];
  /** 被拒绝/拦截的目标路径(Claude blocked_path)。 */
  blockedPath?: string;
  /** 触发审批的原因说明(Claude decision_reason / Codex reason)。 */
  reason?: string;
  reasonType?: string;
  /** 禁止提供"总是允许"选项(Claude suppress_always_allow_rule)。 */
  suppressAlwaysAllow?: boolean;
  /** 默认聚焦拒绝、禁止单键误批(Claude default_to_no)。 */
  defaultToNo?: boolean;
  /** 需要显式人工交互,禁止一键静默放行(Claude requires_user_interaction)。 */
  requiresUserInteraction?: boolean;
  title?: string;
  displayName?: string;
  description?: string;
  cwd?: string;
  agentId?: string;
  commandActions?: unknown[];
  networkContext?: unknown;
  additionalPermissions?: unknown;
  proposedExecpolicyAmendment?: unknown;
  proposedNetworkPolicyAmendments?: unknown[];
  elicitation?: {
    serverName?: string;
    mode?: string;
    url?: string;
    requestedSchema?: unknown;
    message?: string;
    elicitationId?: string;
  };
  raw?: unknown;
}

export interface StructuredQuestionOption {
  id?: string;
  label: string;
  description?: string;
}

export interface StructuredQuestion {
  id: string;
  question: string;
  header?: string;
  options?: StructuredQuestionOption[];
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
}

export interface QuestionPayload {
  questionId: string;
  prompt: string;
  options?: string[];
  /** 是否阻塞当前 turn 继续执行(Codex ToolRequestUserInputParams.isBlocking)。 */
  isBlocking?: boolean;
  /** 归一化后的结构化提问列表。 */
  questions?: StructuredQuestion[];
  /** codex/claude 原始结构化问题数组(ToolRequestUserInput 的 questions)。 */
  rawQuestions?: unknown[];
  itemId?: string;
  agentId?: string;
  raw?: unknown;
}

export interface PlanStepItem {
  step: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
}

export interface PlanPayload {
  planId?: string;
  explanation?: string | null;
  steps?: PlanStepItem[];
  delta?: string;
  text?: string;
  raw?: unknown;
}

export interface DiffPayload {
  diff: string;
  files?: Array<{ path: string; diff?: string; kind?: string }>;
  raw?: unknown;
}

export interface NoticePayload {
  level?: 'info' | 'warning' | 'error';
  message: string;
  code?: string;
  title?: string;
  raw?: unknown;
}

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface SubagentInfo {
  agentId: string;
  parentToolUseId?: string;
  description?: string;
  subagentType?: string;
  status?: SubagentStatus;
  summary?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface SubagentPayload {
  agentId: string;
  parentToolUseId?: string;
  name?: string;
  status?: string;
  summary?: string;
  raw?: unknown;
}

export interface InteractionResolvedPayload {
  interactionId: string;
  interactionKind?: 'approval' | 'question' | 'elicitation' | 'permissions';
  resolution?: string;
  raw?: unknown;
}

export interface PassthroughPayload {
  method: string;
  data: unknown;
  source?: ProviderName | string;
}

export type GatewayEventPayload =
  | TurnPayload
  | MessagePayload
  | ThinkingPayload
  | ToolPayload
  | ApprovalPayload
  | QuestionPayload
  | PlanPayload
  | DiffPayload
  | NoticePayload
  | SubagentPayload
  | InteractionResolvedPayload
  | PassthroughPayload
  | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Turn 控制
// ---------------------------------------------------------------------------

/**
 * 一次 prompt 携带的附件(网关上传单解析后的形态)。
 * - localImage:   磁盘绝对路径,映射 codex turn/start 的 {type:'localImage'}。
 * - imageDataUrl: data:<mime>;base64,... 内联图,映射 {type:'image',url}。
 * - filePathText: 目标 provider 无对应输入项(文件/视频),按 kap-server
 *   话术物化成路径文本交给模型自行 Read。
 */
export interface TurnAttachment {
  kind: 'localImage' | 'imageDataUrl' | 'filePathText';
  path?: string;
  dataUrl?: string;
  name?: string;
  mediaType?: string;
  size?: number;
}

export interface StartTurnInput {
  sessionId: string;
  /** 用户输入:纯文本给 string,富内容给分块数组。 */
  input: string | MessageContentPart[];
  /** 随 prompt 的附件;adapter 按自家输入模型翻译(不认识的 kind 忽略)。 */
  attachments?: TurnAttachment[];
  /** 新建 turn 的显示标题(可选)。 */
  title?: string;
  metadata?: Record<string, unknown>;
}

/** 多模态插话输入(兼容纯文本 string 与富内容/附件)。 */
export interface SteerInput {
  input: string | MessageContentPart[];
  attachments?: TurnAttachment[];
}

export interface TurnHandle {
  turnId: string;
  /**
   * 该 turn 的事件流:thinking / message(delta)/ tool / approval / question,
   * 以 kind='turn' & status='completed'|'failed'|'cancelled' 收尾后结束。
   */
  events: AsyncIterable<GatewayEvent>;
}

export type ApprovalDecision = 'approve' | 'approve_always' | 'reject';

export interface GranularApprovalDetails {
  decision?: ApprovalDecision | 'cancel';
  execpolicyAmendment?: string[];
  networkPolicyAmendment?: { host: string; action: 'allow' | 'deny' | string };
  updatedPermissions?: unknown[];
  updatedInput?: unknown;
  message?: string;
  permissions?: Record<string, unknown>;
  scope?: 'once' | 'turn' | 'session' | 'always' | string;
  elicitation?: {
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
    _meta?: unknown;
  };
  nativeDecision?: unknown;
}

export type GranularApprovalDecision =
  | ApprovalDecision
  | 'cancel'
  | ({ decision: ApprovalDecision | 'cancel' } & Omit<GranularApprovalDetails, 'decision'>);

export function normalizeApprovalDecision(
  input: GranularApprovalDecision,
  extra?: GranularApprovalDetails,
): { decision: ApprovalDecision; details?: GranularApprovalDetails } {
  if (typeof input === 'string') {
    if (input === 'cancel') {
      return { decision: 'reject', details: { ...extra, decision: 'cancel' } };
    }
    return extra ? { decision: input, details: extra } : { decision: input };
  }
  const base: ApprovalDecision = input.decision === 'cancel' ? 'reject' : input.decision;
  return {
    decision: base,
    details: { ...extra, ...input },
  };
}

// ---------------------------------------------------------------------------
// 能力声明 —— 前端/facade 据此决定 UI 是否显示审批、打断等入口
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  streaming: boolean;
  thinking: boolean;
  tools: boolean;
  approvals: boolean;
  questions: boolean;
  interrupt: boolean;
  history: boolean;
  steer?: boolean;
  steerAttachments?: boolean;
  attachments?: boolean;
  compact?: boolean;
  fork?: boolean;
  clone?: boolean;
  rollback?: boolean;
  rename?: boolean;
  archive?: boolean;
  nativeArchive?: boolean;
  delete?: boolean;
  planMode?: boolean;
  permissionModes?: string[];
  manualApproval?: boolean;
  goals?: boolean;
  swarm?: boolean;
  tower?: boolean;
  btw?: boolean;
  subagents?: boolean;
  mcp?: boolean;
  terminals?: boolean;
  review?: boolean;
  models?: boolean;
  thinkingLevels?: boolean;
  commands?: boolean;
  skills?: boolean;
  usage?: boolean;
  elicitation?: boolean;
}

// ---------------------------------------------------------------------------
// 原生目录:模型 / 斜杠命令(对齐前端 WireModel 与命令描述)
// ---------------------------------------------------------------------------

export interface ModelServiceTierInfo {
  id: string;
  name: string;
  description?: string;
}

/** 对齐 kimi-web 的 WireModel(src/api/daemon/wire.ts),由 /models 透传。 */
export interface NativeModel {
  provider: string;
  model: string;
  display_name?: string;
  description?: string;
  max_context_size: number;
  max_output_tokens?: number;
  capabilities?: string[];
  support_efforts?: string[];
  default_effort?: string;
  aliases?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsThinkingOff?: boolean;
  fastMode?: boolean;
  supportsAutoMode?: boolean;
  serviceTiers?: Array<string | ModelServiceTierInfo>;
  defaultServiceTier?: string | null;
  isDefault?: boolean;
  hidden?: boolean;
  raw?: unknown;
}

/**
 * 原生斜杠命令描述。
 * - client:由 web UI 本地执行(new/clear/model 等,前端已有动作);
 * - prompt:作为用户 prompt 发送,adapter 层负责展开成实际内容
 *   (如 claude 插件命令的 .md 模板)。
 */
/**
 * 一条命令该由谁处理、怎么处理。参照 Ovis 的 "forms, not just names"：
 * 名字相同不代表行为相同，形态才决定前端和后端的分派。
 */
export type NativeCommandForm =
  /** 前端本地动作（/new /clear 等），无需后端。 */
  | 'client'
  /** 网关拦截，映射到 CLI 的 RPC/ACP 方法（compact/fork/undo/permissions…）。 */
  | 'gateway'
  /** 原样发给 CLI；CLI 自己展开执行（Claude 的多数命令、Pi 的扩展命令）。 */
  | 'cli'
  /** 只能在该 CLI 的交互终端里跑（picker/panel），Web 端无对应读法。 */
  | 'terminal'
  /** 目录里有，但本版本未核实行为。 */
  | 'unknown';

export interface NativeCommand {
  name: string;
  description: string;
  kind: 'client' | 'prompt';
  acceptsInput?: boolean;
  aliases?: string[];
  argumentHint?: string;
  source?: string;
  builtin?: boolean;
  path?: string;
  scope?: string;
  /** 仅交互 TUI / 终端风格命令（如 Claude `terminal_slash_commands`），Web 菜单隐藏。 */
  terminalOnly?: boolean;
  /** 见 NativeCommandForm；未标注时由 kind/terminalOnly 推导。 */
  form?: NativeCommandForm;
  /** 目录钉子：本行依据的 CLI 版本。版本不符时 verified=false。 */
  pinnedVersion?: string;
  /** 实际运行的 CLI 版本是否与 pinnedVersion 一致（无钉子则为 undefined）。 */
  verified?: boolean;
  /** Markdown frontmatter 解析出的允许工具列表。 */
  allowedTools?: string[];
  /** Markdown frontmatter 指定的模型覆盖。 */
  model?: string;
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type ProviderErrorCode =
  | 'not_found'
  | 'invalid_request'
  | 'unauthorized'
  | 'busy'
  | 'unsupported'
  | 'upstream_error';

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    /** 对应的 HTTP 状态码,facade 直接回给前端。 */
    readonly httpStatus: number = 500,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

// ---------------------------------------------------------------------------
// ProviderAdapter —— 各家 adapter 统一实现的接口
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  readonly name: ProviderName;

  /** 该 provider 的能力位。 */
  capabilities(): ProviderCapabilities;

  /** 列出会话(可按 workspace 过滤)。 */
  list(query?: ListSessionsQuery): Promise<SessionPage>;

  /** 新建会话。 */
  create(input: CreateSessionInput): Promise<Session>;

  /** 拉取会话历史消息(新→旧由 adapter 决定,facade 不重排)。 */
  getHistory(sessionId: string, query?: HistoryQuery): Promise<Message[]>;

  /**
   * 发起一个 turn;返回句柄后从 `events` 持续读事件,
   * 直到 kind='turn' 的终态事件且流结束。
   * 会话忙碌时应抛 ProviderError('busy', ..., 409)。
   */
  startTurn(input: StartTurnInput): Promise<TurnHandle>;

  /** 打断当前进行中的 turn(无进行中 turn 时为空操作)。 */
  interrupt(sessionId: string, turnId?: string): Promise<void>;

  /** 回应一次审批请求。capability approvals=false 时抛 'unsupported'。 */
  resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    details?: GranularApprovalDetails,
  ): Promise<void>;

  /** 回应一次提问。结构化提问传 {questionId: string[]};简单提问传字符串。 */
  resolveQuestion(
    sessionId: string,
    questionId: string,
    answer: string | Record<string, string[]>,
  ): Promise<void>;

  /**
   * 关闭/归档会话并释放资源(子进程、连接等)。
   * 幂等:重复调用不报错。
   */
  close(sessionId: string): Promise<void>;

  /** 网关关停时释放整个 provider 的资源(子进程组等)。可选;幂等。 */
  dispose?(): Promise<void>;

  /** 原生模型目录(可选)。kimi 由上游代理,不实现此方法。 */
  listModels?(): Promise<NativeModel[]>;

  /** 原生斜杠命令目录(可选)。sessionId 或 cwd 可用于项目级命令发现。 */
  listCommands?(sessionId?: string, cwd?: string): Promise<NativeCommand[]>;

  /** 原生 skills 目录(可选;codex skills/list)。claude 的 skill 即斜杠命令,不实现。 */
  listSkills?(sessionId?: string, cwd?: string): Promise<Array<{ name: string; description: string; path?: string; scope?: string; enabled?: boolean }>>;

  /** 记录会话级模型选择(内存态;影响后续 startTurn)。 */
  setModel?(sessionId: string, model: string): Promise<void>;

  /** 当前生效的会话级模型(未设置返回 undefined → DTO 回退默认)。 */
  getModel?(sessionId: string): string | undefined;

  /** 记录会话级 thinking 档位(内存态;影响后续 startTurn,如 codex 的 effort / pi 的 thinkingLevel)。
   * 'off' 语义取决于 provider(回落默认或显式关闭)。未实现 = 该 provider 不支持。
   */
  setThinking?(sessionId: string, thinking: string): Promise<void>;

  /** 当前生效的会话级 thinking 档位(未设置返回 undefined)。 */
  getThinking?(sessionId: string): string | undefined;

  /** 会话级快速模式(claude --fast 的等价物;优先同步到运行中的 turn)。 */
  setFastMode?(sessionId: string, on: boolean): Promise<void>;

  /** 当前快速模式状态(未设置返回 undefined)。 */
  getFastMode?(sessionId: string): boolean | undefined;

  /** 会话级提示栏颜色(claude /color;仅影响该 CLI 自己的视觉)。 */
  setColor?(sessionId: string, color: string): Promise<void>;

  /** 当前颜色(未设置返回 undefined)。 */
  getColor?(sessionId: string): string | undefined;

  /** 会话改名(内存态,应用到后续 list 的标题;进程重启后回落原生标题)。 */
  rename?(sessionId: string, title: string): Promise<void>;

  /**
   * 权限模式(kimi wire 值 manual/auto/yolo;adapter 内部映射到各家机制:
   * claude --permission-mode,codex approvalPolicy)。未实现 = 不支持。
   */
  setPermission?(sessionId: string, mode: string): Promise<void>;

  /** 当前权限模式(未设置返回 undefined → DTO 回 'default')。 */
  getPermission?(sessionId: string): string | undefined;

  /** plan 模式开关(claude 映射 --permission-mode plan;未实现 = 不支持)。 */
  setPlanMode?(sessionId: string, on: boolean): Promise<void>;

  /** 当前 plan 模式(未设置返回 undefined → DTO 回 false)。 */
  getPlanMode?(sessionId: string): boolean | undefined;

  /** 插话:向进行中的 turn 注入用户消息(兼容纯文本与多模态内容/附件)。 */
  steer?(
    sessionId: string,
    turnId: string,
    input: string | MessageContentPart[] | SteerInput,
    attachments?: TurnAttachment[],
  ): Promise<void>;

  /** 压缩会话上下文。 */
  compact?(sessionId: string, customInstructions?: string): Promise<void>;

  /** 归档/取消归档。 */
  setArchived?(sessionId: string, archived: boolean): Promise<void>;

  /** 删除会话(真删,不可恢复)。 */
  delete?(sessionId: string): Promise<void>;

  /** 分叉会话,返回新会话。 */
  fork?(sessionId: string, options?: { model?: string }): Promise<Session>;

  /** 克隆当前分支为新会话(如 Pi clone)。 */
  clone?(sessionId: string): Promise<Session>;

  /** 回滚最后 numTurns 轮。 */
  rollback?(sessionId: string, numTurns: number): Promise<void>;

  /** 设置/更新会话目标(codex thread/goal/set)。 */
  setGoal?(sessionId: string, objective: string): Promise<Record<string, unknown> | null>;

  /** 回读会话目标(无目标返回 null)。 */
  getGoal?(sessionId: string): Promise<Record<string, unknown> | null>;

  /** 目标控制(pause/resume/cancel)。 */
  controlGoal?(sessionId: string, control: 'pause' | 'resume' | 'cancel'): Promise<Record<string, unknown> | null>;

  /** 会话累计 token 用量(最近一次已知值;无来源返回 undefined)。 */
  getUsage?(sessionId: string): SessionUsage | undefined;

  /** 会话工作目录(新建/列表时记录;未知返回 undefined)。 */
  getCwd?(sessionId: string): string | undefined;

  /** MCP 服务器状态(渲染 /mcp 命令输出用)。 */
  listMcpServers?(sessionId?: string): Promise<Array<Record<string, unknown>>>;

  /** 后台终端列表(codex thread/backgroundTerminals)。 */
  listTerminals?(sessionId: string): Promise<Array<Record<string, unknown>>>;

  /** 清理已完成/残留的后台终端(codex thread/backgroundTerminals/clean)。 */
  cleanTerminals?(sessionId: string): Promise<void>;

  /** Git diff 摘要(codex gitDiffToRemote)。 */
  gitDiff?(sessionId: string): Promise<{ sha?: string; diff: string } | null>;

  /** 读取账号速率限制快照(account/rateLimits/read)。 */
  getRateLimits?(): Promise<Record<string, unknown> | null>;

  /** 触发 Codex 账号/会话用量读取(account/usage/read)。 */
  getAccountUsage?(sessionId?: string): Promise<Record<string, unknown> | null>;

  /** 切换自动压缩(pi set_auto_compaction)。 */
  setAutoCompaction?(sessionId: string, enabled: boolean): Promise<boolean>;

  /** 查询自动压缩开关状态(pi get_state.autoCompactionEnabled)。 */
  getAutoCompaction?(sessionId: string): Promise<boolean | undefined>;

  /** 取最后一条 assistant 回复文本(pi get_last_assistant_text)。 */
  getLastAssistantText?(sessionId: string): Promise<string | null>;

  /** 取会话树摘要(pi get_tree)。 */
  getSessionTree?(sessionId: string): Promise<Record<string, unknown> | null>;

  /**
   * 发起一次 inline review(codex review/start)。返回的 TurnHandle 事件流
   * 与 startTurn 同形(review 实际以一个新 turn 运行,通知经 app-server
   * 推送),网关复用正常 turn 的消费路径广播。
   */
  review?(
    sessionId: string,
    options?: {
      instructions?: string;
      target?:
        | { type: 'uncommittedChanges' }
        | { type: 'baseBranch'; branch: string }
        | { type: 'commit'; sha: string; title?: string | null }
        | { type: 'custom'; instructions: string };
    },
  ): Promise<TurnHandle>;

  /** 列出该会话的子代理列表(可选)。 */
  listSubagents?(
    sessionId: string,
  ): Promise<SubagentInfo[]>;
  onSubagentUpdate?(listener: (sessionId: string, subagent: SubagentInfo) => void): () => void;

  /** 获取子代理的历史消息(可选)。 */
  getSubagentMessages?(sessionId: string, agentId: string): Promise<Message[]>;
}

export interface ModelUsageEntry {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  reasoning_output_tokens?: number;
  total_cost_usd?: number;
  context_window?: number;
  max_output_tokens?: number;
  canonical_model?: string;
  provider?: string;
  cost_basis?: 'list' | 'managed' | 'unknown' | string;
  raw?: unknown;
}

/** 会话 token 用量(对齐 kimi wire usage 字段)。 */
export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  context_tokens: number;
  context_limit: number;
  turn_count: number;
  /** 推理输出 tokens(Codex reasoningOutputTokens / Claude thinkingTokens / Grok reasoningTokens)。 */
  reasoning_output_tokens?: number;
  /** 按模型维度的用量明细(对齐 Claude SDK modelUsage)。 */
  model_usage?: Record<string, ModelUsageEntry | Record<string, unknown>>;
  /** 上下文/用量是否来自 provider 权威接口(false/undefined 表示本地推算)。 */
  authoritative?: boolean;
  /** 上下文占用当前不可用(如 compact 后尚未有有效 usage),避免把未知误报为 0%。 */
  context_unavailable?: boolean;
}
