import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAdapter, type CodexEvent } from './codex-adapter.js';
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
