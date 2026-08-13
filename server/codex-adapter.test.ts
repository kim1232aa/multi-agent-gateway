import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAdapter, type CodexEvent } from './codex-adapter.js';

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
