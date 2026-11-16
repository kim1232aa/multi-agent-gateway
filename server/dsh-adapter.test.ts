import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as zlib from 'node:zlib';
import { DshAdapter, DshProviderAdapter, resolveDshBin, resolveDshSessionsDir } from './dsh-adapter.js';
import { DshAcpClient } from './dsh-acp.js';
import { SettingsStore } from './settings-store.js';

test('resolveDshBin falls back gracefully', () => {
  const custom = resolveDshBin('/usr/custom/bin/dsh');
  assert.equal(custom, '/usr/custom/bin/dsh');

  process.env.DSH_BIN = '/env/bin/dsh';
  assert.equal(resolveDshBin(), '/env/bin/dsh');
  delete process.env.DSH_BIN;
});

test('resolveDshSessionsDir respects DSH_HOME', () => {
  const orig = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '/custom/dsh';
    assert.equal(resolveDshSessionsDir(), '/custom/dsh/sessions');
  } finally {
    if (orig !== undefined) process.env.DSH_HOME = orig;
    else delete process.env.DSH_HOME;
  }
});

test('DshAdapter: listSessionsFromDisk and getHistoryMessages from zstd files', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-test-sessions-'));
  try {
    const groupDir = join(tempDir, '--tmp--');
    const sessionDir = join(groupDir, 'test-sess-123');
    await mkdir(sessionDir, { recursive: true });

    // Create session.v4.jsonl.zstd
    const lines = [
      JSON.stringify({ type: 'session', version: 4, id: 'test-sess-123', createdAt: 1700000000000, cwd: '/tmp' }),
      JSON.stringify({ type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Hello DeepSeek!' }] } } }),
      JSON.stringify({
        type: 'assistant/message',
        data: {
          message: {
            content: [
              { type: 'reasoning', text: 'Thinking step...' },
              { type: 'text', text: 'Hello! How can I help?' },
            ],
          },
        },
      }),
    ].join('\n');

    const compressed = zlib.zstdCompressSync(Buffer.from(lines, 'utf8'));
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), compressed);

    // Also create an empty session to test filtering
    const emptySessionDir = join(groupDir, 'empty-sess-456');
    await mkdir(emptySessionDir, { recursive: true });
    const emptyLines = JSON.stringify({ type: 'session', version: 4, id: 'empty-sess-456', createdAt: 1700000000000, cwd: '/tmp' });
    await writeFile(join(emptySessionDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(emptyLines, 'utf8')));

    const adapter = new DshAdapter({ sessionsDir: tempDir });
    const sessions = adapter.listSessionsFromDisk();

    // Empty session should be filtered out
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, 'test-sess-123');
    assert.equal(sessions[0]?.title, 'Hello DeepSeek!');
    assert.equal(sessions[0]?.messageCount, 1);

    // Test getHistoryMessages
    const history = adapter.getHistoryMessages('test-sess-123');
    assert.equal(history.length, 2);
    assert.equal(history[0]?.role, 'user');
    assert.equal(history[1]?.role, 'assistant');
    assert.equal(history[1]?.content.length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('DshProviderAdapter: contract methods', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-provider-test-'));
  try {
    const adapter = new DshProviderAdapter({ sessionsDir: tempDir });
    const caps = adapter.capabilities();
    assert.equal(caps.streaming, true);
    assert.equal(caps.approvals, true);
    assert.equal(caps.commands, true);
    assert.equal(caps.planMode, false);
    assert.equal(caps.fork, false);
    assert.equal(caps.rollback, false);
    assert.equal(caps.goals, false);
    assert.equal(caps.compact, false);
    assert.equal(caps.thinking, true);

    const models = await adapter.listModels();
    assert.ok(models.length >= 3);
    assert.ok(models.some((m) => m.model === 'deepseek-v4-flash'));

    const cmds = await adapter.listCommands();
    assert.ok(cmds.length > 0);
    assert.ok(cmds.every((c) => !c.name.startsWith('/')));
    assert.ok(cmds.some((c) => c.name === 'new'));
    assert.ok(cmds.some((c) => c.name === 'clear'));
    assert.ok(cmds.some((c) => c.name === 'model'));

    const listRes = await adapter.list();
    assert.deepEqual(listRes.items, []);

    const usage = adapter.getUsage('test-sess-123');
    assert.equal(usage?.context_limit, 131_072);

    await adapter.setThinking('test-sess-123', 'high');
    assert.equal(adapter.getThinking('test-sess-123'), 'high');

    await assert.rejects(
      async () => adapter.get('../evil-id'),
      (err: any) => err.code === 'invalid_request' && err.httpStatus === 400
    );

    await adapter.close('test-sess-123');
    await adapter.dispose();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('DshAcpClient: mock process interaction & approvals', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-acp-test-'));
  try {
    const fakeDsh = join(tempDir, 'fake-dsh.sh');
    const script = `#!/usr/bin/env node
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { protocolVersion: 1, agentInfo: { name: 'mock' } }
    }) + '\\n');
  } else if (req.method === 'session/new') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { sessionId: 'mock-session-1' }
    }) + '\\n');
  } else if (req.method === 'session/prompt') {
    // Send thought chunk
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: req.params.sessionId,
        update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'pondering...' } }
      }
    }) + '\\n');
    // Send message chunk
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: req.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { text: 'done' } }
      }
    }) + '\\n');
    // Finish prompt
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { stopReason: 'end' }
    }) + '\\n');
  }
});
`;
    await writeFile(fakeDsh, script, 'utf8');
    await chmod(fakeDsh, 0o755);

    const client = new DshAcpClient({ dshBin: fakeDsh });
    const events: any[] = [];
    client.on((ev) => events.push(ev));

    const newRes = await client.newSession('/tmp');
    assert.equal(newRes.sessionId, 'mock-session-1');

    const promptRes = await client.prompt('mock-session-1', 'hi');
    assert.equal(promptRes.stopReason, 'end');

    assert.ok(events.some((e) => e.type === 'thought_chunk' && e.text === 'pondering...'));
    assert.ok(events.some((e) => e.type === 'message_chunk' && e.text === 'done'));

    // Test permission handling via simulated server request
    (client as any).handleServerRequest(42, 'session/request_permission', {
      sessionId: 'mock-session-1',
      toolCall: { toolCallId: 'tc-1' },
      options: [
        { optionId: 'opt-allow', kind: 'allow_once', name: 'Allow' },
        { optionId: 'opt-reject', kind: 'reject_once', name: 'Reject' },
      ],
    });
    assert.ok(events.some((e) => e.type === 'permission_request' && e.requestId === 42));

    const resolved = client.resolvePermission('42', 'approve');
    assert.equal(resolved, true);

    // Test cancel clears pending permissions with cancelled outcome
    (client as any).handleServerRequest(43, 'session/request_permission', {
      sessionId: 'mock-session-cancel',
      options: [{ optionId: 'opt-allow', kind: 'allow_once' }],
    });
    await client.cancel('mock-session-cancel');
    assert.equal(client.isBusy(), false);

    assert.equal(client.isClosed(), false);
    client.close();
    assert.equal(client.isClosed(), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


type MockRpcMessage = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

class MockDshChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  killed = false;

  constructor(onMessage: (message: MockRpcMessage, child: MockDshChild) => void) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const message = JSON.parse(chunk.toString()) as MockRpcMessage;
        queueMicrotask(() => onMessage(message, this));
        callback();
      },
    });
  }

  send(message: MockRpcMessage): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('close', null, 'SIGTERM'));
    return true;
  }
}

async function withMockDsh(
  onMessage: (message: MockRpcMessage, child: MockDshChild, index: number) => void,
  run: (children: MockDshChild[]) => Promise<void>,
): Promise<void> {
  const originalSpawn = childProcess.spawn;
  const children: MockDshChild[] = [];
  (childProcess as any).spawn = () => {
    const index = children.length;
    const child = new MockDshChild((message, current) => onMessage(message, current, index));
    children.push(child);
    return child;
  };
  syncBuiltinESMExports();
  try {
    await run(children);
  } finally {
    (childProcess as any).spawn = originalSpawn;
    syncBuiltinESMExports();
    for (const child of children) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
}

const reviewConfigOptions = [
  {
    id: 'model', name: 'Model', category: 'model', type: 'select',
    currentValue: JSON.stringify(['custom-a', 'same-model']),
    options: [
      { group: 'custom-a', name: 'Custom A', options: [{ value: JSON.stringify(['custom-a', 'same-model']), name: 'Model A' }] },
      { group: 'custom-b', name: 'Custom B', options: [{ value: JSON.stringify(['custom-b', 'same-model']), name: 'Model B' }] },
    ],
  },
  {
    id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
    currentValue: '', options: [{ value: '', name: 'Provider default' }, { value: 'high', name: 'High' }],
  },
];

const reviewPermissionOptions = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

test('review regression: failed initialize kills old child and stale close preserves new connection', { timeout: 2000 }, async () => {
  await withMockDsh((message, child, index) => {
    if (message.method === 'initialize') {
      child.send(index === 0
        ? { id: message.id, error: { code: -32603, message: 'initialize failed' } }
        : { id: message.id, result: { protocolVersion: 1 } });
    } else if (message.method === 'session/new') {
      child.send({ id: message.id, result: { sessionId: 'new-session', configOptions: reviewConfigOptions } });
    }
  }, async (children) => {
    const client = new DshAcpClient({ dshBin: 'mock', recycleGraceMs: 0 });
    try {
      await assert.rejects(client.ensureReady(), /initialize failed/);
      const oldKilled = children[0].killed;
      await client.ensureReady();
      children[0].emit('close', 1, null);
      const stillConnected = client.isConnected();
      assert.deepEqual(
        { oldKilled, stillConnected },
        { oldKilled: true, stillConnected: true },
        'failed initialization must terminate its child without allowing a stale close to disconnect its successor',
      );
      assert.equal((await client.newSession('/tmp')).sessionId, 'new-session');
      assert.equal(children.length, 2);
    } finally {
      client.close();
    }
  });
});

test('review regression: in-flight ordinary RPC blocks idle recycle', { timeout: 2000 }, async () => {
  let slowRequest: MockRpcMessage | undefined;
  let slowReceived!: () => void;
  const received = new Promise<void>((resolve) => { slowReceived = resolve; });
  await withMockDsh((message, child) => {
    if (message.method === 'initialize') child.send({ id: message.id, result: { protocolVersion: 1 } });
    if (message.method === 'session/new') child.send({ id: message.id, result: { sessionId: 'one', configOptions: reviewConfigOptions } });
    if (message.method === 'session/set_config_option') {
      slowRequest = message;
      slowReceived();
    }
  }, async (children) => {
    const client = new DshAcpClient({ dshBin: 'mock', recycleGraceMs: 20, requestTimeoutMs: 500 });
    try {
      await client.ensureReady();
      const slow = client.setConfigOption('one', 'model', JSON.stringify(['custom-b', 'same-model']));
      const settled = slow.then(() => null, (error: Error) => error);
      await received;
      await client.newSession('/tmp');
      await new Promise((resolve) => setTimeout(resolve, 80));
      const killedDuringRequest = children[0].killed;
      if (!killedDuringRequest) children[0].send({ id: slowRequest!.id, result: { configOptions: reviewConfigOptions } });
      const error = await settled;
      assert.equal(killedDuringRequest, false, 'pending configuration request must keep the process alive');
      assert.equal(error, null);
    } finally {
      client.close();
    }
  });
});

test('review regression: model discovery and selection use native provider/model option values', { timeout: 2000 }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-review-model-'));
  try {
    const configRequests: MockRpcMessage[] = [];
    await withMockDsh((message, child) => {
      if (message.method === 'initialize') child.send({ id: message.id, result: { protocolVersion: 1 } });
      if (message.method === 'session/new') child.send({ id: message.id, result: { sessionId: 'model-session', configOptions: reviewConfigOptions } });
      if (message.method === 'session/set_config_option') {
        configRequests.push(message);
        const value = message.params?.value;
        if (value === JSON.stringify(['custom-b', 'same-model'])) child.send({ id: message.id, result: { configOptions: reviewConfigOptions } });
        else child.send({ id: message.id, error: { code: -32602, message: `unknown model option: ${value}` } });
      }
    }, async () => {
      const adapter = new DshProviderAdapter({ dshBin: 'mock', sessionsDir: tempDir, recycleGraceMs: 0 });
      try {
        const session = await adapter.create({ provider: 'dsh', cwd: tempDir });
        const models = await adapter.listModels();
        const selected = models.find((model) => model.display_name === 'Model B');
        assert.ok(selected, 'catalog must include configured provider models');
        await adapter.setModel(session.id, selected.model);
        assert.equal(configRequests.length, 1);
        assert.equal(configRequests[0].params?.value, JSON.stringify(['custom-b', 'same-model']));
      } finally {
        await adapter.dispose();
      }
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('review regression: rejected configuration does not persist a successful selection', { timeout: 2000 }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-review-config-'));
  try {
    await withMockDsh((message, child) => {
      if (message.method === 'initialize') child.send({ id: message.id, result: { protocolVersion: 1 } });
      if (message.method === 'session/new') child.send({ id: message.id, result: { sessionId: 'config-session', configOptions: reviewConfigOptions } });
      if (message.method === 'session/set_config_option') child.send({ id: message.id, error: { code: -32602, message: 'configuration rejected' } });
    }, async () => {
      const settingsPath = join(tempDir, 'settings.json');
      const store = new SettingsStore(settingsPath);
      const adapter = new DshProviderAdapter({ dshBin: 'mock', sessionsDir: tempDir, settingsStore: store, recycleGraceMs: 0 });
      try {
        const session = await adapter.create({ provider: 'dsh', cwd: tempDir });
        const selectedModel = JSON.stringify(['custom-b', 'same-model']);
        const modelError = await adapter.setModel(session.id, selectedModel).then(() => '', (error: Error) => error.message);
        const thinkingError = await adapter.setThinking(session.id, 'high').then(() => '', (error: Error) => error.message);
        store.flushNow();
        const reloaded = new SettingsStore(settingsPath);
        try {
          assert.match(modelError, /configuration rejected/);
          assert.match(thinkingError, /configuration rejected/);
          assert.notEqual(adapter.getModel(session.id), selectedModel);
          assert.notEqual(adapter.getThinking(session.id), 'high');
          assert.notEqual(reloaded.getString('model', session.id), selectedModel);
          assert.notEqual(reloaded.getString('thinking', session.id), 'high');
        } finally {
          reloaded.close();
        }
      } finally {
        await adapter.dispose();
        store.close();
      }
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('review regression: permission mode is applied per session and follows updates', { timeout: 2000 }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-review-permission-'));
  try {
    const replies: MockRpcMessage[] = [];
    await withMockDsh((message, child) => {
      if (message.method === 'initialize') child.send({ id: message.id, result: { protocolVersion: 1 } });
      if (message.method === 'session/new') child.send({ id: message.id, result: { sessionId: 'unused', configOptions: reviewConfigOptions } });
      if (!message.method && message.id !== undefined) replies.push(message);
    }, async (children) => {
      const adapter = new DshProviderAdapter({ dshBin: 'mock', sessionsDir: tempDir, recycleGraceMs: 0 });
      try {
        await adapter.create({ provider: 'dsh', cwd: tempDir });
        await adapter.setPermission('session-a', 'auto');
        await adapter.setPermission('session-b', 'default');
        const client: DshAcpClient = (adapter as any).adapter.getAcpClient();
        const events: string[] = [];
        client.on((event) => { if (event.type === 'permission_request') events.push(event.sessionId); });
        const request = (id: number, sessionId: string) => children[0].send({
          id, method: 'session/request_permission',
          params: { sessionId, toolCall: { toolCallId: `call-${id}` }, options: reviewPermissionOptions },
        });
        request(101, 'session-a');
        request(102, 'session-b');
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(replies.find((reply) => reply.id === 101)?.result, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
        assert.ok(events.includes('session-b'));
        assert.ok(!events.includes('session-a'));
        await adapter.setPermission('session-a', 'default');
        request(103, 'session-a');
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.ok(events.includes('session-a'));
        assert.ok(!replies.some((reply) => reply.id === 103));
      } finally {
        await adapter.dispose();
      }
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('review regression: approval rejects wrong session and unknown request without resolving either', { timeout: 2000 }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-review-approval-'));
  try {
    const replies: MockRpcMessage[] = [];
    await withMockDsh((message, child) => {
      if (message.method === 'initialize') child.send({ id: message.id, result: { protocolVersion: 1 } });
      if (message.method === 'session/new') child.send({ id: message.id, result: { sessionId: 'unused', configOptions: reviewConfigOptions } });
      if (!message.method && message.id !== undefined) replies.push(message);
    }, async (children) => {
      const adapter = new DshProviderAdapter({ dshBin: 'mock', sessionsDir: tempDir, recycleGraceMs: 0 });
      try {
        await adapter.create({ provider: 'dsh', cwd: tempDir });
        children[0].send({ id: 201, method: 'session/request_permission', params: {
          sessionId: 'session-b', toolCall: { toolCallId: 'call-201' }, options: reviewPermissionOptions,
        } });
        await new Promise<void>((resolve) => setImmediate(resolve));
        await assert.rejects(adapter.resolveApproval('session-a', '201', 'approve'));
        await assert.rejects(adapter.resolveApproval('session-b', '999', 'approve'));
        assert.equal(replies.length, 0);
        await adapter.resolveApproval('session-b', '201', 'approve');
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(replies.find((reply) => reply.id === 201)?.result, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
      } finally {
        await adapter.dispose();
      }
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('review regression: failed resume never silently creates a new empty session', { timeout: 2000 }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-review-resume-'));
  try {
    const methods: string[] = [];
    await withMockDsh((message, child) => {
      if (message.method) methods.push(message.method);
      if (message.method === 'initialize') child.send({ id: message.id, result: { protocolVersion: 1 } });
      if (message.method === 'session/resume') child.send({ id: message.id, error: { code: -32602, message: 'unknown session' } });
      if (message.method === 'session/new') child.send({ id: message.id, result: { sessionId: 'new-empty', configOptions: reviewConfigOptions } });
      if (message.method === 'session/prompt') child.send({ id: message.id, result: { stopReason: 'end_turn' } });
    }, async () => {
      const adapter = new DshProviderAdapter({ dshBin: 'mock', sessionsDir: tempDir, recycleGraceMs: 0 });
      try {
        const outcome = await adapter.startTurn({ sessionId: 'old-session', input: 'continue', metadata: { cwd: tempDir } })
          .then((handle) => ({ handle, error: undefined }), (error: Error) => ({ handle: undefined, error }));
        if (outcome.handle) {
          for await (const _event of outcome.handle.events) { /* drain the completed mock turn */ }
        }
        assert.match(outcome.error?.message ?? '', /unknown session/);
        assert.ok(!methods.includes('session/new'));
        assert.ok(!methods.includes('session/prompt'));
      } finally {
        await adapter.dispose();
      }
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
