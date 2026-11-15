/**
 * Preview transcripts so the Kimi Web sidebar is not empty when local CLIs
 * are missing. Opt-in only: GATEWAY_DEMO=on. Product default is off — empty
 * sidebar / 500 on missing CLI is honest, not a fake catalog.
 */
import { randomUUID } from 'node:crypto';
import type {
  GatewayEvent,
  Message,
  NativeModel,
  ProviderName,
  Session,
  TurnHandle,
} from './types.js';

export const DEMO_CWD = '/workspace';

interface DemoRecord {
  session: Session;
  messages: Message[];
  model: string;
}

const records = new Map<string, DemoRecord>();

function key(provider: ProviderName, id: string): string {
  return `${provider}:${id}`;
}

function iso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString();
}

function msg(
  id: string,
  sessionId: string,
  role: Message['role'],
  created_at: string,
  content: Message['content'],
  metadata?: Message['metadata'],
): Message {
  return { id, session_id: sessionId, role, content, created_at, ...(metadata ? { metadata } : {}) };
}

function session(
  provider: ProviderName,
  id: string,
  title: string,
  lastPrompt: string,
  createdHours: number,
  updatedHours: number,
): Session {
  return {
    id,
    workspace_id: '',
    title,
    created_at: iso(createdHours),
    updated_at: iso(updatedHours),
    busy: false,
    metadata: { cwd: DEMO_CWD },
    provider,
    extras: { last_prompt: lastPrompt },
  };
}

function add(
  provider: ProviderName,
  id: string,
  title: string,
  lastPrompt: string,
  model: string,
  createdHours: number,
  updatedHours: number,
  messages: Message[],
): void {
  records.set(key(provider, id), {
    session: session(provider, id, title, lastPrompt, createdHours, updatedHours),
    messages,
    model,
  });
}

const KIMI_A = '7f1a9c2e-1111-4aaa-8bbb-000000000001';
const KIMI_B = '7f1a9c2e-1111-4aaa-8bbb-000000000002';
const KIMI_C = '7f1a9c2e-1111-4aaa-8bbb-000000000003';
const CLAUDE_A = '8a2b0d3f-2222-4bbb-9ccc-000000000011';
const CLAUDE_B = '8a2b0d3f-2222-4bbb-9ccc-000000000012';
const CLAUDE_C = '8a2b0d3f-2222-4bbb-9ccc-000000000013';
const CODEX_A = '9b3c1e40-3333-4ccc-addd-000000000021';
const CODEX_B = '9b3c1e40-3333-4ccc-addd-000000000022';
const CODEX_C = '9b3c1e40-3333-4ccc-addd-000000000023';
const GROK_A = 'ac4d2f51-4444-4ddd-beee-000000000031';
const GROK_B = 'ac4d2f51-4444-4ddd-beee-000000000032';
const GROK_C = 'ac4d2f51-4444-4ddd-beee-000000000033';
const PI_A = 'bd5e3062-5555-4eee-9fff-000000000041';

add(
  'kimi',
  KIMI_A,
  'Kimi · 网关注入层',
  '不要改 web-dist，选择器怎么挂上去？',
  'kimi-k2',
  30,
  2,
  [
    msg('kimi-a-u1', KIMI_A, 'user', iso(30), [
      { type: 'text', text: '不要改 web-dist，选择器怎么挂上去？' },
    ]),
    msg('kimi-a-a1', KIMI_A, 'assistant', iso(29.9), [
      {
        type: 'text',
        text: '官方 dist 只做 SHA 校验。启动时在内存里的 index.html 里、官方 `/boot.js` 标记后面插入 `__multi_agent/boot.js` 和 style.css。哈希对不上就回退成纯 Kimi Web，选择器不会出现。',
      },
    ]),
    msg('kimi-a-u2', KIMI_A, 'user', iso(2.1), [
      { type: 'text', text: '切 Agent 会不会把登录态弄丢？' },
    ]),
    msg('kimi-a-a2', KIMI_A, 'assistant', iso(2), [
      {
        type: 'text',
        text: '不会。`/api/v1/auth` 永远不带 provider，登录徽章只反映 Kimi。切换只改会话/模型/斜杠命令来源。',
      },
    ]),
  ],
);

add(
  'kimi',
  KIMI_B,
  'Kimi · 工作区扫描',
  '列出 mag/server 里的 adapter 文件',
  'kimi-k2',
  20,
  5,
  [
    msg('kimi-b-u1', KIMI_B, 'user', iso(20), [
      { type: 'text', text: '列出 mag/server 里的 adapter 文件' },
    ]),
    msg('kimi-b-t1', KIMI_B, 'assistant', iso(19.95), [
      { type: 'tool_use', tool_call_id: 'kimi-ls', tool_name: 'Bash', input: { command: 'ls mag/server/*adapter.ts' } },
    ]),
    msg('kimi-b-tr1', KIMI_B, 'tool', iso(19.94), [
      {
        type: 'tool_result',
        tool_call_id: 'kimi-ls',
        output: 'claude-adapter.ts\ncodex-adapter.ts\ngrok-adapter.ts',
      },
    ]),
    msg('kimi-b-a1', KIMI_B, 'assistant', iso(5), [
      {
        type: 'text',
        text: '三家都在：Claude 走 stream-json CLI，Codex 走 app-server JSON-RPC，Grok 主路径是 `grok agent stdio`。',
      },
    ]),
  ],
);

add(
  'kimi',
  KIMI_C,
  'Kimi · 斜杠命令分流',
  '切到 Grok 之后 /swarm 去哪了？',
  'kimi-k2',
  8,
  0.3,
  [
    msg('kimi-c-u1', KIMI_C, 'user', iso(8), [
      { type: 'text', text: '切到 Grok 之后 /swarm 去哪了？' },
    ]),
    msg('kimi-c-a1', KIMI_C, 'assistant', iso(7.9), [
      {
        type: 'text',
        text: 'boot.js 按当前 Agent 藏命令。Grok 没有 Swarm / Goal / BTW，菜单里不会出现；Claude 再藏 /undo，Codex 藏 /swarm 和 /btw。Kimi 自己的命令集不动。',
      },
    ]),
    msg('kimi-c-u2', KIMI_C, 'user', iso(0.4), [
      { type: 'text', text: '那 /compact 呢？' },
    ]),
    msg('kimi-c-a2', KIMI_C, 'assistant', iso(0.3), [
      {
        type: 'text',
        text: '留下。网关拦截后映射到各家原生能力：Codex `thread/compact/start`，Grok `x.ai/compact_conversation`。',
      },
    ]),
  ],
);

add(
  'claude',
  CLAUDE_A,
  'Claude · fork 会话',
  'Claude 会话怎么分叉？',
  'claude-sonnet-4-5',
  18,
  3,
  [
    msg('claude-a-u1', CLAUDE_A, 'user', iso(18), [
      { type: 'text', text: 'Claude 会话怎么分叉？' },
    ]),
    msg('claude-a-th1', CLAUDE_A, 'assistant', iso(17.95), [
      { type: 'thinking', thinking: 'CLI 有 --resume + --fork-session。网关要自己拿新 session_id，不能假定和旧 id 相同。' },
    ]),
    msg('claude-a-a1', CLAUDE_A, 'assistant', iso(3), [
      {
        type: 'text',
        text: '短 turn：`--resume <id> --fork-session`，从 `system/init` 读新 session_id。同一 id 视为不支持。侧栏里会多出一条 `claude_` 前缀会话。',
      },
    ]),
  ],
);

add(
  'claude',
  CLAUDE_B,
  'Claude · 工具审批',
  'Bash 能不能弹出审批卡？',
  'claude-opus-4-6',
  12,
  1.5,
  [
    msg('claude-b-u1', CLAUDE_B, 'user', iso(12), [
      { type: 'text', text: 'Bash 能不能弹出审批卡？' },
    ]),
    msg('claude-b-a1', CLAUDE_B, 'assistant', iso(1.5), [
      {
        type: 'text',
        text: '可以。stdin 保持打开，CLI 的 `can_use_tool` control_request 会停在网关。你点允许就回 `control_response` allow；拒绝则 deny。没有 control_request 时行为与以前一样。',
      },
    ]),
  ],
);

add(
  'claude',
  CLAUDE_C,
  'Claude · 思考块',
  'thinking 块前端怎么画？',
  'claude-sonnet-4-5',
  6,
  0.2,
  [
    msg('claude-c-u1', CLAUDE_C, 'user', iso(6), [
      { type: 'text', text: 'thinking 块前端怎么画？' },
    ]),
    msg('claude-c-th1', CLAUDE_C, 'assistant', iso(5.95), [
      {
        type: 'thinking',
        thinking: 'Kimi wire 用 type:thinking。adapter 把 Claude 的 thinking delta 映射过去，不要改成 text，否则侧栏会把思考当正文。',
      },
    ]),
    msg('claude-c-a1', CLAUDE_C, 'assistant', iso(5.8), [
      {
        type: 'text',
        text: '历史 REST 走 `toKimiMessageContent`：`type:thinking` + `thinking` 字段。快照和 live WS 同一形状，折叠思考块才能展开。',
      },
    ]),
    msg('claude-c-u2', CLAUDE_C, 'user', iso(0.3), [
      { type: 'text', text: 'fork 之后思考还在吗？' },
    ]),
    msg('claude-c-a2', CLAUDE_C, 'assistant', iso(0.2), [
      {
        type: 'text',
        text: '在。`--resume --fork-session` 复制 transcript，思考块跟着走。新会话 id 带 `claude_` 前缀出现在侧栏。',
      },
    ]),
  ],
);

add(
  'codex',
  CODEX_A,
  'Codex · app-server',
  'Codex 为什么不用 exec？',
  'gpt-5.3-codex',
  16,
  4,
  [
    msg('codex-a-u1', CODEX_A, 'user', iso(16), [
      { type: 'text', text: 'Codex 为什么不用 exec？' },
    ]),
    msg('codex-a-a1', CODEX_A, 'assistant', iso(4), [
      {
        type: 'text',
        text: '`codex exec` 是只读/一次性。多轮会话、审批、steer、compact 都在 `codex app-server` 的 JSON-RPC 上：thread/start、turn/start、turn/steer、thread/compact/start。',
      },
    ]),
  ],
);

add(
  'codex',
  CODEX_B,
  'Codex · compact / undo',
  '斜杠命令哪些是网关代执行的？',
  'gpt-5.3-codex',
  9,
  0.8,
  [
    msg('codex-b-u1', CODEX_B, 'user', iso(9), [
      { type: 'text', text: '斜杠命令哪些是网关代执行的？' },
    ]),
    msg('codex-b-a1', CODEX_B, 'assistant', iso(0.8), [
      {
        type: 'text',
        text: '`/compact` `/fork` `/undo` `/review` `/status` `/usage` `/mcp`。app-server 没有 slash 概念，网关拦截后映射到 RPC。`/swarm` 和 `/btw` 会从菜单里藏掉。',
      },
    ]),
  ],
);

add(
  'codex',
  CODEX_C,
  'Codex · thread/steer',
  '进行中的 turn 怎么插话？',
  'gpt-5.3-codex',
  5,
  0.15,
  [
    msg('codex-c-u1', CODEX_C, 'user', iso(5), [
      { type: 'text', text: '进行中的 turn 怎么插话？' },
    ]),
    msg('codex-c-a1', CODEX_C, 'assistant', iso(4.9), [
      {
        type: 'text',
        text: 'busy 时前端走 prompts:steer。网关映射 `turn/steer`，带 expectedTurnId。对不上服务端会拒，不会另开一条 turn。',
      },
    ]),
    msg('codex-c-u2', CODEX_C, 'user', iso(0.25), [
      { type: 'text', text: '那排队的 prompt 呢？' },
    ]),
    msg('codex-c-a2', CODEX_C, 'assistant', iso(0.15), [
      {
        type: 'text',
        text: '当前 turn 结束后自动开下一条。`status:queued` 会先推一帧，前端月亮不会灭。',
      },
    ]),
  ],
);

add(
  'grok',
  GROK_A,
  'Grok · ACP stdio',
  'Grok 现在走哪条协议？',
  'grok-4.6',
  14,
  2.5,
  [
    msg('grok-a-u1', GROK_A, 'user', iso(14), [
      { type: 'text', text: 'Grok 现在走哪条协议？' },
    ]),
    msg('grok-a-th1', GROK_A, 'assistant', iso(13.9), [
      { type: 'thinking', thinking: 'headless grok -p 是只读回退。主路径必须是 grok agent stdio 的 ACP JSON-RPC。' },
    ]),
    msg('grok-a-a1', GROK_A, 'assistant', iso(2.5), [
      {
        type: 'text',
        text: '主路径 `grok agent stdio`：initialize 0.1 → session/new|load|prompt|cancel。扩展有 compact、fork、rewind。ACP 起不来才回退到 `grok -p`。',
      },
    ]),
  ],
);

add(
  'grok',
  GROK_B,
  'Grok · rewind 回滚',
  'Grok 怎么撤回上一轮？',
  'grok-4.6',
  7,
  0.4,
  [
    msg('grok-b-u1', GROK_B, 'user', iso(7), [
      { type: 'text', text: 'Grok 怎么撤回上一轮？' },
    ]),
    msg('grok-b-a1', GROK_B, 'assistant', iso(0.4), [
      {
        type: 'text',
        text: '`/undo` 走 `x.ai/rewind`（失败再试 `x.ai/rewind/to`）。不会退回 `grok -p /rewind`。侧栏这条就是示例回滚会话。',
      },
    ]),
  ],
);

add(
  'grok',
  GROK_C,
  'Grok · compact 压缩',
  '上下文满了怎么压？',
  'grok-4.6',
  4,
  0.1,
  [
    msg('grok-c-u1', GROK_C, 'user', iso(4), [
      { type: 'text', text: '上下文满了怎么压？' },
    ]),
    msg('grok-c-t1', GROK_C, 'assistant', iso(3.95), [
      { type: 'tool_use', tool_call_id: 'grok-compact', tool_name: 'compact_conversation', input: { keep: 'recent' } },
    ]),
    msg('grok-c-tr1', GROK_C, 'tool', iso(3.94), [
      {
        type: 'tool_result',
        tool_call_id: 'grok-compact',
        output: 'compacted 18 turns → 6 turns',
      },
    ]),
    msg('grok-c-a1', GROK_C, 'assistant', iso(3.8), [
      {
        type: 'text',
        text: '`/compact` → `x.ai/compact_conversation`。ACP 进程还在，session id 不变。侧栏标题也不换。',
      },
    ]),
    msg('grok-c-u2', GROK_C, 'user', iso(0.2), [
      { type: 'text', text: 'fork 呢？' },
    ]),
    msg('grok-c-a2', GROK_C, 'assistant', iso(0.1), [
      {
        type: 'text',
        text: '`x.ai/session/fork` 出新 id，前缀 `grok_`。失败不回退 `grok -p`。',
      },
    ]),
  ],
);

add(
  'pi',
  PI_A,
  'Pi · RPC 模式接入',
  'Pi 是怎么接入协议网关的？',
  'anthropic/claude-sonnet-4-5',
  3,
  0.05,
  [
    msg('pi-a-u1', PI_A, 'user', iso(3), [
      { type: 'text', text: 'Pi 是怎么接入协议网关的？' },
    ]),
    msg('pi-a-a1', PI_A, 'assistant', iso(0.05), [
      {
        type: 'text',
        text: '网关通过 `pi --mode rpc` 严格 LF JSONL 通信，支持流式输出、steer 插话、clone/fork、compact 与扩展 UI 提问。',
      },
    ]),
  ],
);

export function listDemoModels(provider: ProviderName): NativeModel[] {
  if (provider === 'pi') {
    return [
      {
        provider: 'pi',
        model: 'anthropic/claude-sonnet-4-5',
        display_name: 'Claude Sonnet 4.5 (anthropic)',
        max_context_size: 200_000,
        capabilities: ['thinking'],
        support_efforts: ['off', 'minimal', 'low', 'medium', 'high'],
      },
    ];
  }
  if (provider === 'claude') {
    return [
      {
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        display_name: 'Claude Sonnet 4.5',
        max_context_size: 200_000,
        capabilities: ['thinking'],
        support_efforts: ['low', 'medium', 'high'],
      },
      {
        provider: 'claude',
        model: 'claude-opus-4-6',
        display_name: 'Claude Opus 4.6',
        max_context_size: 200_000,
        capabilities: ['thinking'],
        support_efforts: ['low', 'medium', 'high', 'max'],
      },
    ];
  }
  if (provider === 'codex') {
    return [
      {
        provider: 'codex',
        model: 'gpt-5.3-codex',
        display_name: 'GPT-5.3 Codex',
        max_context_size: 256_000,
        capabilities: ['thinking'],
        support_efforts: ['low', 'medium', 'high'],
      },
    ];
  }
  if (provider === 'grok') {
    return [
      {
        provider: 'grok',
        model: 'grok-4.6',
        display_name: 'Grok 4.6',
        max_context_size: 500_000,
        capabilities: ['thinking'],
      },
    ];
  }
  return [
    {
      provider: 'kimi',
      model: 'kimi-k2',
      display_name: 'Kimi K2',
      max_context_size: 256_000,
      capabilities: ['thinking'],
    },
  ];
}

export function demoEnabled(_kimiOff: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GATEWAY_DEMO === '1' || env.GATEWAY_DEMO === 'on';
}

export function listDemoSessions(provider: ProviderName): Session[] {
  const out: Session[] = [];
  for (const rec of records.values()) {
    if (rec.session.provider === provider) out.push(rec.session);
  }
  out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return out;
}

export function getDemoSession(provider: ProviderName, id: string): Session | null {
  return records.get(key(provider, id))?.session ?? null;
}

export function getDemoHistory(provider: ProviderName, id: string): Message[] | null {
  const rec = records.get(key(provider, id));
  return rec ? rec.messages.map((m) => ({ ...m, content: [...m.content] })) : null;
}

export function getDemoModel(provider: ProviderName, id: string): string | undefined {
  return records.get(key(provider, id))?.model;
}

export function isDemoSession(provider: ProviderName, id: string): boolean {
  return records.has(key(provider, id));
}

export function demoStartTurn(
  provider: ProviderName,
  sessionId: string,
  text: string,
): TurnHandle {
  const turnId = randomUUID();
  const reply =
    `这是 ${label(provider)} 的预览会话，本机没有对应 CLI 时不会真的跑模型。\n\n你刚才说：${text.slice(0, 240) || '（空）'}\n\n切到侧栏其他 Agent，可以看各自已经写好的对话。`;
  async function* events(): AsyncIterable<GatewayEvent> {
    yield {
      kind: 'message',
      status: 'delta',
      sessionId,
      turnId,
      timestamp: Date.now(),
      payload: {
        delta: reply,
        message: {
          id: `demo_${turnId}`,
          session_id: sessionId,
          role: 'assistant',
          content: [{ type: 'text', text: reply }],
          created_at: new Date().toISOString(),
        },
      },
    };
    yield {
      kind: 'turn',
      status: 'completed',
      sessionId,
      turnId,
      timestamp: Date.now(),
      payload: { reason: 'completed' },
    };
  }
  return { turnId, events: events() };
}

function label(provider: ProviderName): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  if (provider === 'grok') return 'Grok';
  if (provider === 'pi') return 'Pi';
  return 'Kimi';
}
