import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CodexAdapter,
  extractCodexReasoningSummary,
  normalizeCodexThreadItem,
  stripCodexMemoryCitations,
  stripCodexSystemTags,
  type CodexEvent,
} from './codex-adapter.js';
import { ProviderError } from './types.js';

function stubTransport(adapter: CodexAdapter): void {
  (adapter as any).connect = async () => undefined;
  (adapter as any).ensureLive = async () => undefined;
}

test('routes same-chunk turn events after startTurn registration, preserving order', async () => {
  // 回归:readline 同一 chunk 内"响应行之后"的通知行到达时 queue 还没注册
  // (注册在响应 Promise 的多个 continuation 之后),直接路由会静默丢掉;
  // turn/completed 丢失会挂死消费方。未注册期间的事件现在进缓冲,注册时 drain。
  const adapter = new CodexAdapter();
  stubTransport(adapter);
  (adapter as any).request = async (method: string) => {
    if (method !== 'turn/start') throw new Error(`unexpected ${method}`);
    // 真实时序:响应 resolve 把 continuation 排入微任务后,通知行才同步
    // 派发——它的路由微任务必然排在注册之后。
    queueMicrotask(() => {
      (adapter as any).handleNotification('item/agentMessage/delta', {
        threadId: 'th', turnId: 't1', itemId: 'i1', delta: 'A',
      });
    });
    return { turn: { id: 't1', status: 'inProgress' } };
  };

  const handle = await adapter.startTurn('th', 'hi');
  const kinds: string[] = [];
  const it = handle.events[Symbol.asyncIterator]();
  kinds.push((await it.next()).value.type);
  kinds.push((await it.next()).value.type);
  assert.deepEqual(kinds, ['turn-started', 'text-delta']);
});

test('closes the turn queue on turn-completed routed after registration', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);
  (adapter as any).request = async (method: string) => {
    if (method !== 'turn/start') throw new Error(`unexpected ${method}`);
    return { turn: { id: 't1', status: 'inProgress' } };
  };

  const handle = await adapter.startTurn('th', 'hi');
  (adapter as any).handleNotification('turn/completed', {
    threadId: 'th', turn: { id: 't1', status: 'completed' },
  });

  const kinds: string[] = [];
  for await (const ev of handle.events) kinds.push((ev as CodexEvent).type);
  assert.deepEqual(kinds, ['turn-started', 'turn-completed']);
});

test('fails a review turn instead of hanging when the app-server exits mid-review', async () => {
  // 回归:review 的 queue 不在 turnQueues 里,进程在 turn-started 之后、
  // turn-completed 之前死亡时,此前监听器/队列永久泄漏、消费方永久挂起。
  const adapter = new CodexAdapter();
  stubTransport(adapter);
  (adapter as any).request = async (method: string) => {
    if (method === 'review/start') return {};
    throw new Error(`unexpected ${method}`);
  };

  const handlePromise = adapter.reviewTurn('th');
  // 等 reviewTurn 的 onEvent 注册完(connect/request 都是微任务)。
  await new Promise((resolve) => setTimeout(resolve, 0));
  (adapter as any).handleNotification('turn/started', {
    threadId: 'th', turn: { id: 'A', status: 'inProgress' },
  });
  const handle = await handlePromise;

  (adapter as any).configModelCache = 'cached-model';
  (adapter as any).readyPromise = Promise.resolve();
  (adapter as any).handleProcessExit(null, 1, null);

  const it = handle.events[Symbol.asyncIterator]();
  // 缓冲里还有 turn-started,fail 的拒绝在 drain 之后出现(与真实消费方一致)。
  assert.equal((await it.next()).value.type, 'turn-started');
  await assert.rejects(it.next(), /disconnected/);
  // 进程退出同时清掉 config 模型缓存,重连后必须重读。
  assert.equal((adapter as any).configModelCache, null);
});

test('rejects an in-flight waiter when the app-server exits, instead of closing as success', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);
  (adapter as any).request = async (method: string) => {
    if (method !== 'turn/start') throw new Error(`unexpected ${method}`);
    return { turn: { id: 't1', status: 'inProgress' } };
  };
  const handle = await adapter.startTurn('th', 'hi');
  const it = handle.events[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.type, 'turn-started');
  const pending = it.next();
  (adapter as any).handleProcessExit(null, 1, null);
  await assert.rejects(pending, /exited|closed|disconnected/);
});

test('translates "already has an active writer" into an actionable message', async () => {
  // 另一个客户端(常见是 codex CLI resume 同一 thread)持有写入者时,
  // app-server 回 -32600;适配器应对齐 kap-server 的 busy 模型(409+busy
  // 子码),给可操作提示而不是原始 RPC 错误/500。
  const adapter = new CodexAdapter();
  (adapter as any).connect = async () => undefined;
  (adapter as any).request = async (method: string) => {
    if (method === 'thread/resume') {
      throw new Error("codex 'thread/resume' failed (-32600): thread th already has an active writer");
    }
    throw new Error(`unexpected ${method}`);
  };
  await assert.rejects(adapter.resume('th'), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, 'busy');
    assert.equal(err.httpStatus, 409);
    assert.match(err.message, /只允许一个写入者/);
    return true;
  });
  // 非占用类错误不得被误翻译。
  (adapter as any).request = async () => { throw new Error('thread not found'); };
  await assert.rejects(adapter.resume('th'), /thread not found/);
});

test('recycles the app-server after idle grace to release the writer lock', async () => {
  // thread/resume 会拿下 codex 单写者锁,只有进程退出才释放;web 端看过会话
  // 后空闲 grace 期满应回收进程,否则 CLI 的 codex resume 被锁到网关重启。
  const adapter = new CodexAdapter({ recycleGraceMs: 10 });
  let killed = false;
  (adapter as any).child = { exitCode: null, kill: () => { killed = true; } };
  // 模拟 thread/resume 响应落定(真实占锁路径,不经 turn)。
  (adapter as any).pendingClient.set(1, { method: 'thread/resume', resolve() {}, reject() {}, timer: undefined });
  (adapter as any).handleResponse(1, { id: 1, result: {} });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(killed);
});

test('recycles after a consumed turn completes, but not while busy', async () => {
  const adapter = new CodexAdapter({ recycleGraceMs: 10 });
  stubTransport(adapter);
  let killed = false;
  (adapter as any).child = { exitCode: null, kill: () => { killed = true; } };
  (adapter as any).request = async (method: string) => {
    if (method !== 'turn/start') throw new Error(`unexpected ${method}`);
    return { turn: { id: 't1', status: 'inProgress' } };
  };

  const handle = await adapter.startTurn('th', 'hi');
  // 活跃 turn 流未收口时,grace 到期也不杀(re-check 后 re-arm)。
  (adapter as any).scheduleRecycleWhenIdle();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(killed, false);

  (adapter as any).handleNotification('turn/completed', {
    threadId: 'th', turn: { id: 't1', status: 'completed' },
  });
  for await (const _ of handle.events) { /* drain */ }
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(killed);
});

test('translates "already in progress" into 409 busy across thread RPCs', async () => {
  // 慢操作(rollback/compact 可能跑几分钟)进行中重试,app-server 回 -32600
  // "X already in progress";应对齐 kap-server 的 busy 形态而不是 500。
  const adapter = new CodexAdapter();
  stubTransport(adapter);
  (adapter as any).request = async (method: string) => {
    throw new Error(`codex '${method}' failed (-32600): rollback already in progress for this thread`);
  };
  await assert.rejects(adapter.rollback('th'), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, 'busy');
    assert.equal(err.httpStatus, 409);
    assert.match(err.message, /仍在执行/);
    return true;
  });
  // 非冲突错误原样透出(不被误翻译)。
  (adapter as any).request = async () => { throw new Error('some other failure'); };
  await assert.rejects(adapter.rollback('th'), /some other failure/);
});

test('does not recycle while a created thread is still unpersisted', async () => {
  // 回归:thread/start 的线程要等首个 turn 才写 rollout;此时回收会蒸发它
  // ("no rollout found",且从会话列表消失)。未落盘保护期内禁止回收。
  const adapter = new CodexAdapter({ recycleGraceMs: 10 });
  let killed = false;
  (adapter as any).child = { exitCode: null, kill: () => { killed = true; } };
  (adapter as any).unpersistedThreads.set('ghost-never-persisted', Date.now());
  (adapter as any).scheduleRecycleWhenIdle();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(killed, false);
});

test('recycles once the created thread has a rollout on disk', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
  const id = '019ffd4a-fake-persisted';
  const dir = join(home, 'sessions', '2026', '08', '14');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-08-14T00-00-00-${id}.jsonl`), '');
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const adapter = new CodexAdapter({ recycleGraceMs: 10 });
    let killed = false;
    (adapter as any).child = { exitCode: null, kill: () => { killed = true; } };
    (adapter as any).unpersistedThreads.set(id, Date.now());
    (adapter as any).scheduleRecycleWhenIdle();
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(killed);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});

test('abandons protection for ghost threads older than the grace window', async () => {
  // 建了就走超过保护期的草稿线程不该把回收永久钉死(否则 CLI 锁回不来)。
  const adapter = new CodexAdapter({ recycleGraceMs: 10 });
  let killed = false;
  (adapter as any).child = { exitCode: null, kill: () => { killed = true; } };
  (adapter as any).unpersistedThreads.set('ghost-stale', Date.now() - 16 * 60_000);
  (adapter as any).scheduleRecycleWhenIdle();
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(killed);
});

test('stall watchdog synthesizes turn-completed when the server already finished the turn', async () => {
  // 回归:wedged turn(rollout 已 task_complete 但 turn/completed 通知没上线)
  // 会让前端永远转圈、busy 不清、CLI resume 被写者锁挡死。看门狗探测到
  // 服务端已终态时补发 turn-completed 收口。
  const adapter = new CodexAdapter({ recycleGraceMs: 10 });
  stubTransport(adapter);
  (adapter as any).child = { exitCode: null, kill: () => { throw new Error('must not kill a live turn'); } };
  (adapter as any).request = async (method: string) => {
    if (method === 'turn/start') return { turn: { id: 't1', status: 'inProgress' } };
    if (method === 'thread/read') return { thread: { id: 'th', turns: [{ id: 't1', status: 'failed', error: { message: 'upstream' } }] } };
    throw new Error(`unexpected ${method}`);
  };
  const handle = await adapter.startTurn('th', 'hi');
  (adapter as any).lastTurnActivityAt = Date.now() - 6 * 60_000; // 模拟静默 6 分钟
  (adapter as any).recycleIfIdle();
  const kinds: string[] = [];
  for await (const ev of handle.events) kinds.push((ev as CodexEvent).type);
  assert.deepEqual(kinds, ['turn-started', 'turn-completed']);
});

test('stall watchdog kills the wedged app-server when the probe cannot read', async () => {
  const adapter = new CodexAdapter({ recycleGraceMs: 10 });
  stubTransport(adapter);
  let killed = false;
  (adapter as any).child = { exitCode: null, kill: () => { killed = true; } };
  (adapter as any).request = async (method: string) => {
    if (method === 'turn/start') return { turn: { id: 't1', status: 'inProgress' } };
    throw new Error('pipe wedged');
  };
  const handle = await adapter.startTurn('th', 'hi');
  (adapter as any).lastTurnActivityAt = Date.now() - 6 * 60_000;
  (adapter as any).recycleIfIdle();
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(killed);
  // 消费方不挂死:进程死亡路径会以 disconnected 收尾(此处 fake child 不触发
  // exit,手动补一下验证队列能被 fail)。
  (adapter as any).handleProcessExit(null, 1, null);
  const it = handle.events[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.type, 'turn-started');
  await assert.rejects(it.next(), /exited/);
});

test('stall watchdog leaves a slow-but-alive turn alone', async () => {
  const adapter = new CodexAdapter({ recycleGraceMs: 10 });
  stubTransport(adapter);
  let killed = false;
  (adapter as any).child = { exitCode: null, kill: () => { killed = true; } };
  (adapter as any).request = async (method: string) => {
    if (method === 'turn/start') return { turn: { id: 't1', status: 'inProgress' } };
    if (method === 'thread/read') return { thread: { id: 'th', turns: [{ id: 't1', status: 'inProgress' }] } };
    throw new Error(`unexpected ${method}`);
  };
  const handle = await adapter.startTurn('th', 'hi');
  (adapter as any).lastTurnActivityAt = Date.now() - 6 * 60_000;
  (adapter as any).recycleIfIdle();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(killed, false);
  // 服务端确认活着:活动时间被刷新(下一轮不会立刻再探)。
  assert.ok((adapter as any).lastTurnActivityAt > Date.now() - 5000);
  (adapter as any).handleProcessExit(null, 1, null); // 收尾,防 queue 泄漏
  try {
    for await (const _ of handle.events) { /* drain */ }
  } catch { /* 进程退出 → queue fail 是预期 */ }
});

test('doConnect strips GATEWAY_* env vars while preserving explicit options.env overrides', async () => {
  const prevToken = process.env.GATEWAY_TOKEN;
  const prevKimi = process.env.GATEWAY_KIMI;
  process.env.GATEWAY_TOKEN = 'secret-gateway-token';
  process.env.GATEWAY_KIMI = '1';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-env-test-'));
  const fakeBin = path.join(tmpDir, 'fake-codex.js');
  fs.writeFileSync(
    fakeBin,
    `#!/usr/bin/env node
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stderr.write('ENV_CHECK:' + JSON.stringify({
      hasToken: Boolean(process.env.GATEWAY_TOKEN),
      hasKimi: Boolean(process.env.GATEWAY_KIMI),
      customVal: process.env.CUSTOM_FLAG || null,
      explicitGateway: process.env.GATEWAY_EXPLICIT || null,
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: { userAgent: 'fake/0.169.0' },
    }) + '\\n');
  }
});
`,
    { mode: 0o755 },
  );
  try {
    let observedEnv: Record<string, unknown> | null = null;
    const adapter = new CodexAdapter({
      codexPath: fakeBin,
      env: { CUSTOM_FLAG: 'yes', GATEWAY_EXPLICIT: 'allowed' },
      onStderr: (line) => {
        if (line.startsWith('ENV_CHECK:')) {
          observedEnv = JSON.parse(line.slice('ENV_CHECK:'.length));
        }
      },
    });
    await adapter.connect();
    for (let i = 0; i < 20 && !observedEnv; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(observedEnv);
    assert.equal((observedEnv as any).hasToken, false);
    assert.equal((observedEnv as any).hasKimi, false);
    assert.equal((observedEnv as any).customVal, 'yes');
    assert.equal((observedEnv as any).explicitGateway, 'allowed');
    await adapter.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevToken === undefined) delete process.env.GATEWAY_TOKEN;
    else process.env.GATEWAY_TOKEN = prevToken;
    if (prevKimi === undefined) delete process.env.GATEWAY_KIMI;
    else process.env.GATEWAY_KIMI = prevKimi;
  }
});

test('rollback resolves beforeTurnId via paginated thread/turns/list and calls thread/revert', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);
  const calls: Array<{ method: string; params: any }> = [];
  (adapter as any).request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/turns/list') {
      if (!params.cursor) {
        return {
          data: [
            { id: 't4', status: 'completed', startedAt: 400 },
            { id: 't3', status: 'completed', startedAt: 300 },
          ],
          nextCursor: 'cur-2',
        };
      }
      return {
        data: [
          { id: 't2', status: 'completed', startedAt: 200 },
          { id: 't1', status: 'completed', startedAt: 100 },
        ],
        nextCursor: null,
      };
    }
    if (method === 'thread/revert') {
      return {};
    }
    throw new Error(`unexpected ${method}`);
  };

  await adapter.rollback('th-1', 3);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.method, 'thread/turns/list');
  assert.equal(calls[0]!.params.threadId, 'th-1');
  assert.equal(calls[0]!.params.sortDirection, 'desc');
  assert.equal(calls[1]!.method, 'thread/turns/list');
  assert.equal(calls[1]!.params.cursor, 'cur-2');
  assert.deepEqual(calls[2], {
    method: 'thread/revert',
    params: { threadId: 'th-1', beforeTurnId: 't2' },
  });
});

test('rollback rejects active inProgress turn, legacy unpaginated thread, and insufficient turns', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);

  // 1) Active turn inProgress -> 409 busy
  (adapter as any).request = async (method: string) => {
    if (method === 'thread/turns/list') {
      return { data: [{ id: 't2', status: 'inProgress', startedAt: 200 }], nextCursor: null };
    }
    throw new Error(`unexpected ${method}`);
  };
  await assert.rejects(
    () => adapter.rollback('th-1', 1),
    (err: unknown) => err instanceof ProviderError && err.code === 'busy' && err.httpStatus === 409,
  );

  // 2) Legacy unpaginated thread -> 400 unsupported (never calls removed thread/rollback)
  (adapter as any).request = async (method: string) => {
    if (method === 'thread/turns/list') {
      throw new Error("codex 'thread/turns/list' failed (-32600): thread th-legacy does not use paginated history");
    }
    throw new Error(`unexpected ${method}`);
  };
  await assert.rejects(
    () => adapter.rollback('th-legacy', 1),
    (err: unknown) => err instanceof ProviderError && err.code === 'unsupported' && err.httpStatus === 400,
  );

  // 3) Insufficient turns -> 400 invalid_request
  (adapter as any).request = async (method: string) => {
    if (method === 'thread/turns/list') {
      return { data: [{ id: 't1', status: 'completed', startedAt: 100 }], nextCursor: null };
    }
    throw new Error(`unexpected ${method}`);
  };
  await assert.rejects(
    () => adapter.rollback('th-1', 2),
    (err: unknown) => err instanceof ProviderError && err.code === 'invalid_request' && err.httpStatus === 400,
  );
});

test('stripCodexSystemTags and stripCodexMemoryCitations preserve code fences and inline backticks', () => {
  const input = [
    '<INSTRUCTIONS>system prompt</INSTRUCTIONS>',
    '<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>',
    'Hello world <oai-mem-citation><citation_entries>mem-1</citation_entries></oai-mem-citation>!',
    'Inline `<INSTRUCTIONS>keep me</INSTRUCTIONS>` and `<oai-mem-citation>keep</oai-mem-citation>` stay.',
    '```xml\n<environment_context>keep fenced</environment_context>\n<oai-mem-citation>keep fenced</oai-mem-citation>\n```',
    '<turn_aborted>cancelled</turn_aborted>',
  ].join('\n');

  const stripped = stripCodexMemoryCitations(stripCodexSystemTags(input));
  assert.ok(!stripped.includes('system prompt'));
  assert.ok(!stripped.includes('<cwd>/tmp</cwd>'));
  assert.ok(!stripped.includes('mem-1'));
  assert.ok(!stripped.includes('cancelled'));
  assert.ok(stripped.includes('Hello world !'));
  assert.ok(stripped.includes('`<INSTRUCTIONS>keep me</INSTRUCTIONS>`'));
  assert.ok(stripped.includes('<environment_context>keep fenced</environment_context>'));
});

test('getHistory paginates thread/turns/list and thread/items/list, filters system items, and normalizes 0.169 items', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);
  (adapter as any).request = async (method: string, params: any) => {
    if (method === 'thread/turns/list') {
      if (!params.cursor) {
        return {
          data: [{ id: 't1', status: 'completed', startedAt: 100 }],
          nextCursor: 'turn-cur-2',
        };
      }
      return {
        data: [{ id: 't2', status: 'completed', startedAt: 200 }],
        nextCursor: null,
      };
    }
    if (method === 'thread/items/list') {
      if (!params.cursor) {
        return {
          data: [
            {
              turnId: 't1',
              item: {
                id: 'u-sys',
                type: 'userMessage',
                content: [{ type: 'text', text: '<INSTRUCTIONS>hidden</INSTRUCTIONS>\n<environment_context>env</environment_context>' }],
              },
            },
            {
              turnId: 't1',
              item: {
                id: 'u-1',
                type: 'userMessage',
                content: [{ type: 'text', text: '<environment_context>env</environment_context>\nReal user question' }],
              },
            },
            {
              turnId: 't1',
              item: {
                id: 'r-1',
                type: 'reasoning',
                summary: ['First thought', 'Second thought'],
                content: [],
              },
            },
          ],
          nextCursor: 'items-page-2',
        };
      }
      return {
        data: [
          {
            turnId: 't2',
            item: {
              id: 'a-1',
              type: 'agentMessage',
              text: 'Answer here<oai-mem-citation>secret</oai-mem-citation>',
            },
          },
          {
            turnId: 't2',
            item: {
              id: 'c-1',
              type: 'collabAgentToolCall',
              tool: 'spawnAgent',
              status: 'completed',
              senderThreadId: 'th-1',
              receiverThreadIds: ['th-sub-1'],
              prompt: 'check files',
              model: 'gpt-5.4',
              reasoningEffort: 'high',
              agentsStates: { 'th-sub-1': { status: 'completed', message: 'all good' } },
            },
          },
          {
            turnId: 't2',
            item: {
              id: 'sa-1',
              type: 'subAgentActivity',
              threadId: 'th-sub-1',
              agentLabel: 'explorer',
              activityType: 'completed',
              summary: 'finished exploration',
            },
          },
          {
            turnId: 't2',
            item: {
              id: 'pl-1',
              type: 'plan',
              text: '1. Step one\n2. Step two',
            },
          },
          {
            turnId: 't2',
            item: {
              id: 'rv-1',
              type: 'enteredReviewMode',
              review: 'uncommitted changes',
            },
          },
          {
            turnId: 't2',
            item: {
              id: 'cc-1',
              type: 'contextCompaction',
            },
          },
        ],
        nextCursor: null,
      };
    }
    throw new Error(`unexpected ${method}`);
  };

  const turns = await adapter.getHistory('th-1');
  assert.equal(turns.length, 2);
  const t1 = turns[0]!;
  const t2 = turns[1]!;
  assert.equal(t1.id, 't1');
  const t1Items = t1.items as any[];
  // u-sys was purely system-injected and stripped out
  assert.equal(t1Items.length, 2);
  assert.equal(t1Items[0].id, 'u-1');
  assert.equal(t1Items[0].content[0].text, 'Real user question');
  assert.equal(t1Items[1].id, 'r-1');
  assert.equal(t1Items[1].summaryText, 'First thought\nSecond thought');
  assert.equal(extractCodexReasoningSummary(t1Items[1]), 'First thought\nSecond thought');

  assert.equal(t2.id, 't2');
  const t2Items = t2.items as any[];
  assert.equal(t2Items[0].text, 'Answer here');
  assert.equal(t2Items[1].tool, 'spawnAgent');
  assert.equal(t2Items[1].name, 'spawnAgent');
  assert.deepEqual(t2Items[1].receiverThreadIds, ['th-sub-1']);
  assert.equal(t2Items[2].type, 'subAgentActivity');
  assert.equal(t2Items[2].agentLabel, 'explorer');
  assert.equal(t2Items[3].type, 'plan');
  assert.equal(t2Items[4].type, 'enteredReviewMode');
  assert.equal(t2Items[5].type, 'contextCompaction');
});

test('getHistory falls back to thread/read on legacy threads and returns [] for unmaterialized threads', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);

  // Legacy thread fallback
  (adapter as any).request = async (method: string) => {
    if (method === 'thread/turns/list') {
      throw new Error('thread th-old does not use paginated history');
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: 'th-old',
          turns: [
            {
              id: 't-old',
              status: 'completed',
              items: [{ id: 'm1', type: 'agentMessage', text: 'Hi <oai-mem-citation>x</oai-mem-citation>' }],
            },
          ],
        },
      };
    }
    throw new Error(`unexpected ${method}`);
  };
  const legacyTurns = await adapter.getHistory('th-old');
  assert.equal(legacyTurns.length, 1);
  assert.equal((legacyTurns[0]!.items as any[])[0].text, 'Hi ');

  // Unmaterialized thread returns []
  (adapter as any).request = async (method: string) => {
    if (method === 'thread/turns/list' || method === 'thread/read') {
      throw new Error('thread th-new is not materialized yet; includeTurns is unavailable before first user message');
    }
    throw new Error(`unexpected ${method}`);
  };
  const emptyTurns = await adapter.getHistory('th-new');
  assert.deepEqual(emptyTurns, []);

  // Codex 0.169.0 draft paginated thread: listTurns + thread/read(includeTurns=true) throw -32601,
  // while thread/read(includeTurns=false) returns empty preview & turns.
  (adapter as any).request = async (method: string, params: Record<string, unknown>) => {
    if (method === 'thread/turns/list') {
      throw new Error("codex 'thread/turns/list' failed (-32601): paginated_threads is not supported yet");
    }
    if (method === 'thread/read' && params.includeTurns === true) {
      throw new Error("codex 'thread/read' failed (-32601): list_turns is not supported yet");
    }
    if (method === 'thread/read' && params.includeTurns === false) {
      return { thread: { id: 'th-draft', preview: '', turns: [] } };
    }
    throw new Error(`unexpected ${method}`);
  };
  assert.deepEqual(await adapter.getHistory('th-draft'), []);
});

test('handleServerRequest supports 0.169 granular commandExecution, fileChange, and serverRequest/resolved', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);
  const sentMessages: any[] = [];
  (adapter as any).write = (msg: any) => sentMessages.push(msg);

  const events: CodexEvent[] = [];
  adapter.onEvent((ev: CodexEvent) => events.push(ev));

  // 1) commandExecution with granular fields + acceptWithExecpolicyAmendment
  (adapter as any).handleServerRequest(101, 'item/commandExecution/requestApproval', {
    threadId: 'th-1',
    turnId: 't-1',
    itemId: 'cmd-1',
    approvalId: 'subcmd-1',
    command: 'cargo test',
    cwd: '/workspace',
    reason: 'Need test run',
    availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['cargo', 'test'] } }, 'decline'],
    proposedExecpolicyAmendment: ['cargo', 'test'],
    proposedNetworkPolicyAmendments: [{ host: 'crates.io', action: 'allow' }],
    networkApprovalContext: { host: 'crates.io', protocol: 'https' },
  });

  assert.equal(events.length, 1);
  const cmdEv = events[0] as Extract<CodexEvent, { type: 'approval-request' }>;
  assert.equal(cmdEv.type, 'approval-request');
  assert.equal(cmdEv.kind, 'commandExecution');
  assert.equal(cmdEv.requestId, 101);
  assert.equal(cmdEv.approvalId, 'subcmd-1');
  assert.deepEqual(cmdEv.proposedExecpolicyAmendment, ['cargo', 'test']);
  assert.deepEqual(cmdEv.networkApprovalContext, { host: 'crates.io', protocol: 'https' });

  adapter.resolveApproval(
    '101',
    CodexAdapter.acceptWithExecpolicyAmendment(['cargo', 'test']),
  );
  assert.deepEqual(sentMessages.pop(), {
    id: 101,
    result: {
      decision: {
        acceptWithExecpolicyAmendment: { execpolicy_amendment: ['cargo', 'test'] },
      },
    },
  });

  // 2) network policy amendment helper
  (adapter as any).handleServerRequest(102, 'item/commandExecution/requestApproval', {
    threadId: 'th-1',
    turnId: 't-1',
    itemId: 'cmd-2',
    command: 'curl https://crates.io',
  });
  adapter.resolveApproval(
    '102',
    CodexAdapter.applyNetworkPolicyAmendment({ host: 'crates.io', action: 'allow' }),
  );
  assert.deepEqual(sentMessages.pop(), {
    id: 102,
    result: {
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: { host: 'crates.io', action: 'allow' },
        },
      },
    },
  });

  // 3) fileChange approval + serverRequest/resolved cleanup
  (adapter as any).handleServerRequest(103, 'item/fileChange/requestApproval', {
    threadId: 'th-1',
    turnId: 't-1',
    itemId: 'fc-1',
    reason: 'Write Outside Root',
    grantRoot: '/etc',
  });
  assert.equal((adapter as any).pendingServer.has('103'), true);
  (adapter as any).handleNotification('serverRequest/resolved', {
    threadId: 'th-1',
    requestId: 103,
  });
  assert.equal((adapter as any).pendingServer.has('103'), false);
  const resolvedEv = events.find((e) => e.type === 'server-request-resolved');
  assert.ok(resolvedEv && resolvedEv.type === 'server-request-resolved');
  assert.equal(resolvedEv.requestId, 103);
});

test('handleServerRequest supports item/permissions/requestApproval and mcpServer/elicitation/request (with null turnId and 0.171 environmentId)', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);
  const sentMessages: any[] = [];
  (adapter as any).write = (msg: any) => sentMessages.push(msg);

  (adapter as any).request = async (method: string) => {
    if (method === 'turn/start') return { turn: { id: 't-active', status: 'inProgress' } };
    throw new Error(`unexpected ${method}`);
  };

  const handle = await adapter.startTurn('th-1', 'run mcp tool');
  const it = handle.events[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.type, 'turn-started');

  // 1) item/permissions/requestApproval
  (adapter as any).handleServerRequest(201, 'item/permissions/requestApproval', {
    threadId: 'th-1',
    turnId: 't-active',
    itemId: 'perm-item-1',
    reason: 'Need filesystem write',
    permissions: { fileSystem: { write: ['/tmp/out'] } },
  });
  const permEv = (await it.next()).value as Extract<CodexEvent, { type: 'approval-request' }>;
  assert.equal(permEv.type, 'approval-request');
  assert.equal(permEv.kind, 'permissions');
  assert.deepEqual(permEv.permissions, { fileSystem: { write: ['/tmp/out'] } });

  adapter.resolvePermissionsApproval('201', { fileSystem: { write: ['/tmp/out'] } }, 'session', true);
  assert.deepEqual(sentMessages.pop(), {
    id: 201,
    result: {
      permissions: { fileSystem: { write: ['/tmp/out'] } },
      scope: 'session',
      strictAutoReview: true,
    },
  });

  // 2) mcpServer/elicitation/request with turnId: null and 0.171 environmentId
  // Should correlate to active turn 't-active' on 'th-1'!
  (adapter as any).handleServerRequest('elic-req-1', 'mcpServer/elicitation/request', {
    threadId: 'th-1',
    turnId: null,
    serverName: 'github-mcp',
    mode: 'form',
    environmentId: 'env-alpha-5',
    message: 'Provide token scope',
    requestedSchema: { type: 'object', properties: { scope: { type: 'string' } } },
  });
  const elicEv = (await it.next()).value as Extract<CodexEvent, { type: 'approval-request' }>;
  assert.equal(elicEv.type, 'approval-request');
  assert.equal(elicEv.kind, 'mcpElicitation');
  assert.equal(elicEv.turnId, 't-active');
  assert.equal(elicEv.elicitation?.serverName, 'github-mcp');
  assert.equal(elicEv.elicitation?.environmentId, 'env-alpha-5');

  adapter.resolveElicitation('elic-req-1', 'accept', { scope: 'repo' }, { trace: '1' });
  assert.deepEqual(sentMessages.pop(), {
    id: 'elic-req-1',
    result: {
      action: 'accept',
      content: { scope: 'repo' },
      _meta: { trace: '1' },
    },
  });

  (adapter as any).handleNotification('turn/completed', {
    threadId: 'th-1',
    turn: { id: 't-active', status: 'completed' },
  });
  assert.equal((await it.next()).value.type, 'turn-completed');
});

test('handleServerRequest maps legacy applyPatchApproval/execCommandApproval and maps requestUserInput question ids', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);
  const sentMessages: any[] = [];
  (adapter as any).write = (msg: any) => sentMessages.push(msg);

  // Legacy applyPatchApproval
  (adapter as any).handleServerRequest(301, 'applyPatchApproval', {
    conversationId: 'th-legacy',
    callId: 'patch-call-1',
    fileChanges: { 'a.txt': { type: 'add', content: 'hi' } },
    reason: 'patch file',
    grantRoot: '/workspace',
  });
  adapter.resolveApproval('301', 'acceptForSession');
  assert.deepEqual(sentMessages.pop(), {
    id: 301,
    result: { decision: 'approved_for_session' },
  });

  // Legacy execCommandApproval declined
  (adapter as any).handleServerRequest(302, 'execCommandApproval', {
    conversationId: 'th-legacy',
    callId: 'exec-call-1',
    command: ['rm', '-rf', '/tmp/x'],
    cwd: '/tmp',
    reason: 'cleanup',
    parsedCmd: [],
  });
  adapter.resolveApproval('302', 'decline');
  assert.deepEqual(sentMessages.pop(), {
    id: 302,
    result: { decision: { denied: { rejection: 'Rejected by user' } } },
  });

  // item/tool/requestUserInput with synthetic q_0 key mapping to actual question.id
  (adapter as any).handleServerRequest(303, 'item/tool/requestUserInput', {
    threadId: 'th-1',
    turnId: 't-1',
    itemId: 'ask-1',
    isBlocking: true,
    autoResolutionMs: 15000,
    questions: [
      { id: 'real_question_id', header: 'Env', question: 'Which env?', options: [{ label: 'prod', description: 'Production' }] },
    ],
  });
  adapter.resolveQuestion('303', { q_0: ['prod'] });
  assert.deepEqual(sentMessages.pop(), {
    id: 303,
    result: {
      answers: {
        real_question_id: { answers: ['prod'] },
      },
    },
  });
});

test('handleServerRequest immediately rejects unhandled host requests (-32601) without hanging pendingServer', () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);
  const sentMessages: any[] = [];
  (adapter as any).write = (msg: any) => sentMessages.push(msg);

  const events: CodexEvent[] = [];
  adapter.onEvent((ev: CodexEvent) => events.push(ev));

  (adapter as any).handleServerRequest(401, 'item/tool/call', {
    threadId: 'th-1',
    turnId: 't-1',
    callId: 'call-1',
    tool: 'customTool',
    arguments: { a: 1 },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'server-request');
  assert.equal((adapter as any).pendingServer.has('401'), false);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].id, 401);
  assert.equal(sentMessages[0].error.code, -32601);
});

test('compact registers event listener before thread/compact/start to prevent race condition and rejects on failure', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);

  // 1) Same-chunk contextCompaction emitted BEFORE thread/compact/start RPC resolves
  (adapter as any).request = async (method: string) => {
    if (method === 'thread/compact/start') {
      (adapter as any).handleNotification('item/completed', {
        threadId: 'th-1',
        turnId: 't-compact',
        item: { id: 'cc-1', type: 'contextCompaction' },
      });
      return {};
    }
    throw new Error(`unexpected ${method}`);
  };
  await adapter.compact('th-1', 1000);

  // 2) thread/compacted notification also resolves compact()
  (adapter as any).request = async (method: string) => {
    if (method === 'thread/compact/start') {
      queueMicrotask(() => {
        (adapter as any).handleNotification('thread/compacted', {
          threadId: 'th-1',
          turnId: 't-compact-2',
        });
      });
      return {};
    }
    throw new Error(`unexpected ${method}`);
  };
  await adapter.compact('th-1', 1000);

  // 3) terminal error during compaction rejects compact() immediately
  (adapter as any).request = async (method: string) => {
    if (method === 'thread/compact/start') {
      queueMicrotask(() => {
        (adapter as any).handleNotification('error', {
          threadId: 'th-1',
          turnId: 't-compact-3',
          willRetry: false,
          error: { message: 'context window overflow during compaction' },
        });
      });
      return {};
    }
    throw new Error(`unexpected ${method}`);
  };
  await assert.rejects(() => adapter.compact('th-1', 1000), /context window overflow/);
});

test('reviewTurn correlates 0.169 { turn, reviewThreadId } response and streams events from reviewThreadId', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);
  (adapter as any).request = async (method: string, params: any) => {
    if (method === 'review/start') {
      assert.deepEqual(params.target, { type: 'baseBranch', branch: 'main' });
      assert.equal(params.delivery, 'inline');
      // Emit same-chunk event on the returned reviewThreadId before continuation runs
      queueMicrotask(() => {
        (adapter as any).handleNotification('item/agentMessage/delta', {
          threadId: 'th-review-detached',
          turnId: 'rev-turn-1',
          itemId: 'msg-1',
          delta: 'Review finding 1',
        });
        (adapter as any).handleNotification('turn/completed', {
          threadId: 'th-review-detached',
          turn: { id: 'rev-turn-1', status: 'completed' },
        });
      });
      return {
        turn: { id: 'rev-turn-1', status: 'inProgress', items: [] },
        reviewThreadId: 'th-review-detached',
      };
    }
    throw new Error(`unexpected ${method}`);
  };

  const handle = await adapter.reviewTurn('th-main', {
    target: { type: 'baseBranch', branch: 'main' },
    delivery: 'inline',
  });
  assert.equal(handle.turnId, 'rev-turn-1');
  assert.equal(handle.reviewThreadId, 'th-review-detached');

  const collected: CodexEvent[] = [];
  for await (const ev of handle.events) collected.push(ev);
  assert.deepEqual(
    collected.map((e) => e.type),
    ['turn-started', 'text-delta', 'turn-completed'],
  );
});

test('listModels and mcpStatus paginate via nextCursor, and listSkills passes cwd and auto-reloads after skills/changed', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);
  const calls: Array<{ method: string; params: any }> = [];

  (adapter as any).request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'model/list') {
      if (!params.cursor) {
        return { data: [{ id: 'gpt-5.4' }], nextCursor: 'm-page-2' };
      }
      return { data: [{ id: 'gpt-5.4-mini' }], nextCursor: null };
    }
    if (method === 'mcpServerStatus/list') {
      if (!params.cursor) {
        return { data: [{ name: 'srv-1' }], nextCursor: 's-page-2' };
      }
      return { data: [{ name: 'srv-2' }], nextCursor: null };
    }
    if (method === 'skills/list') {
      return { data: [{ cwd: params.cwds?.[0] ?? '/default/cwd', skills: [{ name: 'skill-a', description: 'desc', path: '/p', scope: 'repo', enabled: true }], errors: [] }] };
    }
    throw new Error(`unexpected ${method}`);
  };

  const models = await adapter.listModels();
  assert.deepEqual(models.map((m) => m.id), ['gpt-5.4', 'gpt-5.4-mini']);

  const servers = await adapter.mcpStatus();
  assert.deepEqual(servers.map((s) => s.name), ['srv-1', 'srv-2']);

  await adapter.listSkills({ cwd: '/custom/project' });
  assert.deepEqual(calls.pop(), {
    method: 'skills/list',
    params: { cwds: ['/custom/project'] },
  });

  // Trigger skills/changed notification -> next listSkills should automatically set forceReload: true
  (adapter as any).handleNotification('skills/changed', {});
  assert.equal(adapter.getSkillsVersion(), 1);
  assert.equal(adapter.isSkillsDirty(), true);
  await adapter.listSkills({ cwd: '/custom/project' });
  assert.deepEqual(calls.pop(), {
    method: 'skills/list',
    params: { cwds: ['/custom/project'], forceReload: true },
  });
  assert.equal(adapter.isSkillsDirty(), false);
});

test('handleNotification maps plan, diff, goal/cleared, thread/reverted, summaryIndex, turn.error, reasoningOutputTokens, and effort/serviceTier', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);
  const events: CodexEvent[] = [];
  adapter.onEvent((ev: CodexEvent) => events.push(ev));

  (adapter as any).handleNotification('turn/plan/updated', {
    threadId: 'th-1',
    turnId: 't-1',
    explanation: 'Updating plan',
    plan: [{ step: 'Write tests', status: 'inProgress' }],
  });
  (adapter as any).handleNotification('item/plan/delta', {
    threadId: 'th-1',
    turnId: 't-1',
    itemId: 'pl-1',
    delta: '+ step 2',
  });
  (adapter as any).handleNotification('turn/diff/updated', {
    threadId: 'th-1',
    turnId: 't-1',
    diff: '--- a/file\n+++ b/file',
  });
  (adapter as any).handleNotification('thread/goal/cleared', {
    threadId: 'th-1',
  });
  (adapter as any).handleNotification('thread/reverted', {
    threadId: 'th-1',
  });
  (adapter as any).handleNotification('item/reasoning/summaryTextDelta', {
    threadId: 'th-1',
    turnId: 't-1',
    itemId: 'r-1',
    delta: 'thinking...',
    summaryIndex: 2,
  });
  (adapter as any).handleNotification('thread/tokenUsage/updated', {
    threadId: 'th-1',
    turnId: 't-1',
    tokenUsage: {
      last: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 20, reasoningOutputTokens: 30 },
      total: { inputTokens: 200, outputTokens: 90, cachedInputTokens: 40, reasoningOutputTokens: 50 },
      modelContextWindow: 200000,
    },
  });
  (adapter as any).handleNotification('turn/completed', {
    threadId: 'th-1',
    turn: {
      id: 't-1',
      status: 'failed',
      error: { message: 'rate limit reached', codexErrorInfo: 'UsageLimitExceeded', additionalDetails: 'retry in 10s' },
    },
  });

  assert.equal(events[0]!.type, 'plan-updated');
  assert.equal(events[1]!.type, 'plan-delta');
  assert.equal(events[2]!.type, 'diff-updated');
  assert.deepEqual(events[3], { type: 'goal-updated', threadId: 'th-1', goal: null, cleared: true });
  assert.deepEqual(events[4], { type: 'thread-reverted', threadId: 'th-1' });
  assert.deepEqual(events[5], {
    type: 'reasoning-delta',
    threadId: 'th-1',
    turnId: 't-1',
    itemId: 'r-1',
    contentIndex: 2,
    summaryIndex: 2,
    delta: 'thinking...',
  });
  assert.equal(events[6]!.type, 'token-usage');
  const tokenEv = events[6] as Extract<CodexEvent, { type: 'token-usage' }>;
  assert.equal(tokenEv.usage.last.reasoningOutputTokens, 30);
  assert.equal(tokenEv.usage.reasoningOutputTokens, 50);
  const completedEv = events[7] as Extract<CodexEvent, { type: 'turn-completed' }>;
  assert.equal(completedEv.type, 'turn-completed');
  assert.equal(completedEv.error, 'rate limit reached: retry in 10s');
  assert.equal(completedEv.turnError?.codexErrorInfo, 'UsageLimitExceeded');

  // Verify startTurn forwards effort: 'ultra' and serviceTier: 'fast'
  let capturedTurnStartParams: any = null;
  (adapter as any).request = async (method: string, params: any) => {
    if (method === 'turn/start') {
      capturedTurnStartParams = params;
      return { turn: { id: 't-ultra', status: 'inProgress' } };
    }
    throw new Error(`unexpected ${method}`);
  };
  const h = await adapter.startTurn('th-1', 'go', { effort: 'ultra', serviceTier: 'fast' });
  assert.equal(capturedTurnStartParams.effort, 'ultra');
  assert.equal(capturedTurnStartParams.serviceTier, 'fast');
  (adapter as any).handleNotification('turn/completed', {
    threadId: 'th-1',
    turn: { id: 't-ultra', status: 'completed' },
  });
  for await (const _ of h.events) { /* drain */ }
});

test('live smoke test against installed @openai/codex 0.169.0 binary when present', async (t) => {
  const candidates = [
    process.env.CODEX_LIVE_BIN,
    '/tmp/codex-survey.LoV5Nh/stable/package/vendor/x86_64-unknown-linux-musl/bin/codex',
    path.join(os.homedir(), '.local', 'bin', 'codex'),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'codex')),
  ].filter((p): p is string => Boolean(p));
  const codex0169Bin = candidates.find((p) => fs.existsSync(p));
  if (!codex0169Bin) {
    t.skip('0.169.0 codex binary not found');
    return;
  }

  const tmpCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-m10-smoke-'));
  const adapter = new CodexAdapter({
    codexPath: codex0169Bin,
    env: { CODEX_HOME: tmpCodexHome },
  });

  try {
    await adapter.connect();

    const thread = await adapter.create({ cwd: tmpCodexHome });
    assert.ok(thread.id.length > 0);
    assert.equal(thread.historyMode, 'paginated');

    // Unmaterialized new 0.169 thread should cleanly return empty history even on repeated reads
    const history = await adapter.getHistory(thread.id);
    assert.deepEqual(history, []);
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(await adapter.getHistory(thread.id), []);

    // Skills list should succeed against 0.169 app-server
    const skills = await adapter.listSkills({ cwd: tmpCodexHome });
    assert.ok(Array.isArray(skills));
  } finally {
    await adapter.close();
    fs.rmSync(tmpCodexHome, { recursive: true, force: true });
  }
});

test('revert and rollback map real 0.169.0 legacy/ephemeral thread/revert errors to 400 unsupported', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);

  // Real 0.169.0 legacy thread: thread/turns/list succeeds, then thread/revert rejects
  (adapter as any).request = async (method: string) => {
    if (method === 'thread/turns/list') {
      return { data: [{ id: 't1', status: 'completed', startedAt: 100 }], nextCursor: null };
    }
    if (method === 'thread/revert') {
      throw new Error("codex 'thread/revert' failed (-32600): thread/revert only supports paginated threads");
    }
    throw new Error(`unexpected ${method}`);
  };
  await assert.rejects(
    () => adapter.rollback('th-legacy', 1),
    (err: unknown) => err instanceof ProviderError && err.code === 'unsupported' && err.httpStatus === 400,
  );
  await assert.rejects(
    () => adapter.revert('th-legacy', 't1'),
    (err: unknown) => err instanceof ProviderError && err.code === 'unsupported' && err.httpStatus === 400,
  );

  // Ephemeral thread rejection on thread/revert
  (adapter as any).request = async (method: string) => {
    if (method === 'thread/revert') {
      throw new Error("codex 'thread/revert' failed (-32600): ephemeral threads do not support thread/revert");
    }
    throw new Error(`unexpected ${method}`);
  };
  await assert.rejects(
    () => adapter.revert('th-ephemeral', 't1'),
    (err: unknown) => err instanceof ProviderError && err.code === 'unsupported' && err.httpStatus === 400,
  );
});

test('stripCodexSystemTags and stripCodexMemoryCitations strip tags containing backticks and fences', () => {
  const withBackticks = '<INSTRUCTIONS>Run `npm test` before commit</INSTRUCTIONS>';
  assert.equal(stripCodexSystemTags(withBackticks), '');
  assert.equal(
    normalizeCodexThreadItem({
      id: 'u-bt',
      type: 'userMessage',
      content: [{ type: 'text', text: withBackticks }],
    }),
    null,
  );

  const withFences = '<INSTRUCTIONS>Follow `AGENTS.md` and run ```bash\necho hi\n```</INSTRUCTIONS>\nActual question';
  assert.equal(stripCodexSystemTags(withFences).trim(), 'Actual question');

  const citeWithBackticks = 'Answer<oai-mem-citation><citation_entries>used `foo.ts`</citation_entries></oai-mem-citation> done';
  assert.equal(stripCodexMemoryCitations(citeWithBackticks), 'Answer done');
});

test('compact and reviewTurn handle timeout before withThreadRetry settles without unhandledRejection and emit reviewTurn turn-started to listeners', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);
  const rejections: unknown[] = [];
  const onUnhandled = (err: unknown): void => { rejections.push(err); };
  process.on('unhandledRejection', onUnhandled);
  try {
    (adapter as any).request = async () => new Promise((resolve) => setTimeout(() => resolve({}), 60));
    await assert.rejects(() => adapter.compact('th-1', 15), /timed out after 15ms/);
    await assert.rejects(() => adapter.reviewTurn('th-1', { timeoutMs: 15 }), /did not start within 15ms/);
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  // Verify reviewTurn notifies global listeners when synthesizing turn-started
  const listenerAdapter = new CodexAdapter();
  stubTransport(listenerAdapter);
  const seenEvents: CodexEvent[] = [];
  listenerAdapter.onEvent((ev) => seenEvents.push(ev));
  (listenerAdapter as any).request = async (method: string) => {
    if (method === 'review/start') {
      queueMicrotask(() => {
        (listenerAdapter as any).handleNotification('turn/completed', {
          threadId: 'th-rev',
          turn: { id: 'rt-1', status: 'completed' },
        });
      });
      return { turn: { id: 'rt-1', status: 'inProgress' }, reviewThreadId: 'th-rev' };
    }
    throw new Error(`unexpected ${method}`);
  };
  const h = await listenerAdapter.reviewTurn('th-main');
  for await (const _ of h.events) { /* drain */ }
  assert.ok(seenEvents.some((e) => e.type === 'turn-started' && e.turnId === 'rt-1'));
});

test('probeStalledTurn uses thread/turns/list without killing responsive child, skills/list preserves mid-flight skills/changed, and server-request honors handled=true', async () => {
  const adapter = new CodexAdapter();
  stubTransport(adapter);

  // 1) probeStalledTurn receives RPC -32601 -> must NOT terminate child
  let killed = false;
  (adapter as any).child = { exitCode: null };
  (adapter as any).terminateChild = () => { killed = true; };
  (adapter as any).turnQueues.set('th-1:t-1', { push() {}, close() {}, fail() {} });
  (adapter as any).request = async (method: string) => {
    if (method === 'thread/turns/list') {
      throw new Error("codex 'thread/turns/list' failed (-32601): list_turns unsupported");
    }
    throw new Error(`unexpected ${method}`);
  };
  await (adapter as any).probeStalledTurn();
  assert.equal(killed, false);
  (adapter as any).turnQueues.clear();
  (adapter as any).child = null;

  // 2) skills/changed arriving during in-flight skills/list preserves skillsDirty=true
  (adapter as any).handleNotification('skills/changed', {});
  assert.equal(adapter.isSkillsDirty(), true);
  (adapter as any).request = async (method: string) => {
    if (method === 'skills/list') {
      (adapter as any).handleNotification('skills/changed', {});
      return { data: [] };
    }
    throw new Error(`unexpected ${method}`);
  };
  await adapter.listSkills();
  assert.equal(adapter.isSkillsDirty(), true);

  // 3) server-request listener setting ev.handled = true keeps request parked for async respondServerRequest
  const sent: any[] = [];
  (adapter as any).write = (msg: any) => sent.push(msg);
  const off = adapter.onEvent((ev) => {
    if (ev.type === 'server-request' && ev.method === 'item/tool/call') {
      ev.handled = true;
    }
  });
  (adapter as any).handleLine(JSON.stringify({
    id: 77,
    method: 'item/tool/call',
    params: { threadId: 'th-1', turnId: 't-1', callId: 'c1', tool: 'my_tool' },
  }));
  assert.equal(sent.length, 0);
  adapter.respondServerRequest(77, { contentItems: [{ type: 'inputText', text: 'ok' }], success: true });
  assert.deepEqual(sent[0], {
    id: 77,
    result: { contentItems: [{ type: 'inputText', text: 'ok' }], success: true },
  });
  off();
});

test('normalizeCodexThreadItem normalizes collabAgentToolCall and subAgentActivity', () => {
  const collabItem = normalizeCodexThreadItem({
    type: 'collabAgentToolCall',
    id: 'call-collab-1',
    tool: 'spawn_agent',
    receiverThreadIds: ['thread-sub-1'],
    senderThreadId: 'thread-main',
  } as any);
  assert.equal(collabItem?.type, 'collabAgentToolCall');
  assert.equal(collabItem?.name, 'spawn_agent');
  assert.deepEqual((collabItem as any)?.receiverThreadIds, ['thread-sub-1']);

  const subActivityItem = normalizeCodexThreadItem({
    type: 'subAgentActivity',
    id: 'act-1',
    agentThreadId: 'thread-sub-1',
  } as any);
  assert.equal(subActivityItem?.type, 'subAgentActivity');
  assert.equal((subActivityItem as any)?.agentId, 'thread-sub-1');
});
