/**
 * 多 Agent 网关的统一 provider 抽象。
 *
 * gateway 对官方 kimi-web 前端讲 Kimi kap-server 协议(`/api/v1` REST + WS),
 * 内部按 provider 分流到 Kimi(无损代理)/ Codex(JSON-RPC)/ Claude(CLI stream-json)。
 * 本文件是三个 adapter 与 facade 共用的契约:类型形状贴近 Kimi wire 协议
 * (snake_case 字段、ISO 时间戳),让 Kimi 路径可以几乎零映射透传,
 * 同时保留 Codex / Claude 能映射进来的最小扩展点(`provider`、`extras`)。
 */

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type ProviderName = 'kimi' | 'claude' | 'codex';

export const PROVIDER_NAMES: readonly ProviderName[] = ['kimi', 'claude', 'codex'];

export function isProviderName(value: unknown): value is ProviderName {
  return value === 'kimi' || value === 'claude' || value === 'codex';
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
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_call_id: string; content: string; is_error?: boolean }
  | { type: 'image'; mime_type: string; data: string };

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
  | 'question';

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
}

export interface TurnPayload {
  reason?: 'completed' | 'cancelled' | 'failed';
  error?: string;
}

export interface MessagePayload {
  message: Message;
  /** status='delta' 时的增量文本(assistant 输出流)。 */
  delta?: string;
}

export interface ThinkingPayload {
  text: string;
  /** status='delta' 时的增量思考文本。 */
  delta?: string;
}

export interface ToolPayload {
  toolCallId: string;
  name: string;
  input?: unknown;
  output?: string;
  is_error?: boolean;
}

export interface ApprovalPayload {
  approvalId: string;
  /** 请求审批的工具/命令描述。 */
  tool: string;
  input?: unknown;
  options?: string[];
  /** codex 审批挂在具体 item 上;前端据此把审批卡贴到对应工具卡。 */
  itemId?: string;
}

export interface QuestionPayload {
  questionId: string;
  prompt: string;
  options?: string[];
  /** codex 原始结构化问题数组(ToolRequestUserInput 的 questions)。 */
  rawQuestions?: unknown[];
}

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

export interface TurnHandle {
  turnId: string;
  /**
   * 该 turn 的事件流:thinking / message(delta)/ tool / approval / question,
   * 以 kind='turn' & status='completed'|'failed'|'cancelled' 收尾后结束。
   */
  events: AsyncIterable<GatewayEvent>;
}

export type ApprovalDecision = 'approve' | 'approve_always' | 'reject';

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
}

// ---------------------------------------------------------------------------
// 原生目录:模型 / 斜杠命令(对齐前端 WireModel 与命令描述)
// ---------------------------------------------------------------------------

/** 对齐 kimi-web 的 WireModel(src/api/daemon/wire.ts),由 /models 透传。 */
export interface NativeModel {
  provider: string;
  model: string;
  display_name?: string;
  max_context_size: number;
  capabilities?: string[];
  support_efforts?: string[];
  default_effort?: string;
}

/**
 * 原生斜杠命令描述。
 * - client:由 web UI 本地执行(new/clear/model 等,前端已有动作);
 * - prompt:作为用户 prompt 发送,adapter 层负责展开成实际内容
 *   (如 claude 插件命令的 .md 模板)。
 */
export interface NativeCommand {
  name: string;
  description: string;
  kind: 'client' | 'prompt';
  acceptsInput?: boolean;
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
// ProviderAdapter —— 三个 adapter 统一实现的接口
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

  /** 原生斜杠命令目录(可选)。sessionId 可用于项目级命令发现。 */
  listCommands?(sessionId?: string): Promise<NativeCommand[]>;

  /** 原生 skills 目录(可选;codex skills/list)。claude 的 skill 即斜杠命令,不实现。 */
  listSkills?(sessionId?: string): Promise<Array<{ name: string; description: string; path?: string; scope?: string; enabled?: boolean }>>;

  /** 记录会话级模型选择(内存态;影响后续 startTurn)。 */
  setModel?(sessionId: string, model: string): Promise<void>;

  /** 当前生效的会话级模型(未设置返回 undefined → DTO 回退默认)。 */
  getModel?(sessionId: string): string | undefined;

  /** 记录会话级 thinking 档位(内存态;影响后续 startTurn,如 codex 的 effort)。
   * 'off' 表示不显式指定(回落到 provider 默认)。未实现 = 该 provider 不支持。
   */
  setThinking?(sessionId: string, thinking: string): Promise<void>;

  /** 当前生效的会话级 thinking 档位(未设置返回 undefined)。 */
  getThinking?(sessionId: string): string | undefined;

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

  /** 插话:向进行中的 turn 注入用户消息(codex turn/steer)。 */
  steer?(sessionId: string, turnId: string, text: string): Promise<void>;

  /** 压缩会话上下文。 */
  compact?(sessionId: string): Promise<void>;

  /** 归档/取消归档。 */
  setArchived?(sessionId: string, archived: boolean): Promise<void>;

  /** 删除会话(真删,不可恢复)。 */
  delete?(sessionId: string): Promise<void>;

  /** 分叉会话,返回新会话。 */
  fork?(sessionId: string): Promise<Session>;

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

  /**
   * 发起一次 inline review(codex review/start)。返回的 TurnHandle 事件流
   * 与 startTurn 同形(review 实际以一个新 turn 运行,通知经 app-server
   * 推送),网关复用正常 turn 的消费路径广播。
   */
  review?(sessionId: string): Promise<TurnHandle>;
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
}
