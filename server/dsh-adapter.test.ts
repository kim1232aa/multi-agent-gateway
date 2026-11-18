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
import { ProviderStore } from './provider-store.js';

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
    const adapter = new DshProviderAdapter({ sessionsDir: tempDir, dshBin: join(tempDir, 'missing-dsh'), settingsPath: join(tempDir, 'settings.json') });
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
    assert.equal(models.some((m) => m.model === 'deepseek-v4-flash'), false, 'fake models like deepseek-v4-flash must never be returned');

    const cmds = await adapter.listCommands();
    assert.ok(cmds.length > 0);
    assert.ok(cmds.every((c) => !c.name.startsWith('/')));
    assert.ok(cmds.some((c) => c.name === 'new'));
    assert.ok(cmds.some((c) => c.name === 'clear'));
    assert.ok(cmds.some((c) => c.name === 'model'));

    const listRes = await adapter.list();
    assert.deepEqual(listRes.items, []);

    const usage = adapter.getUsage('test-sess-123');
    assert.ok(Number.isNaN(usage?.context_limit));

    await adapter.setThinking('__default__', 'high');
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

test('review regression: real DSH session disk format parses user content, filters runtime-context, maps tool calls and results, and uses event timestamps and stable ids', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-test-real-disk-'));
  try {
    const groupDir = join(tempDir, '--test-workspace--');
    const sessionId = 'real-sess-uuid-1';
    const sessionDir = join(groupDir, sessionId);
    await mkdir(sessionDir, { recursive: true });

    const lines = [
      JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: 1700000000000, cwd: '/workspace' }),
      JSON.stringify({
        type: 'user/message',
        seq: 8,
        time: 1794810800682,
        data: {
          content: [{ type: 'text', text: 'Analyze multi-agent-gateway design' }],
          source: { kind: 'user' },
          role: 'user',
          id: 'user-msg-uuid-1',
        },
      }),
      JSON.stringify({
        type: 'user/message',
        seq: 9,
        time: 1794810800684,
        data: {
          source: { kind: 'runtime-context', form: 'snapshot' },
          role: 'user',
          id: 'rc-msg-uuid-2',
          content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }],
        },
      }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 13,
        time: 1794810834906,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'tool-call', id: 'call_glob_1', name: 'glob', arguments: '{"pattern":"*.ts"}' }],
          },
        },
      }),
      JSON.stringify({
        type: 'tool/result',
        seq: 15,
        time: 1794810835251,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'tool',
            toolCallId: 'call_glob_1',
            content: [{ type: 'text', text: 'file1.ts\nfile2.ts' }],
            isError: false,
            id: 'tr-uuid-1',
          },
        },
      }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 18,
        time: 1794810850000,
        data: {
          turn: 1,
          step: 2,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Found 2 files.' }],
          },
        },
      }),
    ].join('\n');

    const compressed = zlib.zstdCompressSync(Buffer.from(lines, 'utf8'));
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), compressed);

    const adapter = new DshAdapter({ sessionsDir: tempDir });
    const sessions = adapter.listSessionsFromDisk();

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, sessionId);
    assert.equal(sessions[0]?.title, 'Analyze multi-agent-gateway design');
    assert.equal(sessions[0]?.messageCount, 1);

    const history = adapter.getHistoryMessages(sessionId);
    assert.equal(history.length, 4, 'must have user message, tool call assistant, tool result, and final text assistant (runtime-context skipped)');

    // 1. User message
    assert.equal(history[0]?.role, 'user');
    assert.equal(history[0]?.id, 'user-msg-uuid-1');
    assert.equal(history[0]?.created_at, new Date(1794810800682).toISOString());
    assert.equal(history[0]?.content[0]?.type, 'text');
    assert.equal((history[0]?.content[0] as any)?.text, 'Analyze multi-agent-gateway design');

    // 2. Assistant tool-call
    assert.equal(history[1]?.role, 'assistant');
    assert.equal(history[1]?.created_at, new Date(1794810834906).toISOString());
    assert.deepEqual(history[1]?.content, [
      {
        type: 'tool_call',
        id: 'call_glob_1',
        name: 'glob',
        input: { pattern: '*.ts' },
      },
    ]);

    // 3. Tool result
    assert.equal(history[2]?.role, 'tool');
    assert.equal(history[2]?.id, 'tr-uuid-1');
    assert.equal(history[2]?.created_at, new Date(1794810835251).toISOString());
    assert.equal(history[2]?.content[0]?.type, 'tool_result');
    assert.equal((history[2]?.content[0] as any)?.tool_call_id, 'call_glob_1');
    assert.equal((history[2]?.content[0] as any)?.output, 'file1.ts\nfile2.ts');
    assert.equal((history[2]?.content[0] as any)?.is_error, false);

    // 4. Final assistant text
    assert.equal(history[3]?.role, 'assistant');
    assert.equal(history[3]?.created_at, new Date(1794810850000).toISOString());
    assert.equal((history[3]?.content[0] as any)?.text, 'Found 2 files.');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('DSH turn/end error and abort reasons become turn outcome markers in history', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-test-turn-end-'));
  try {
    const sessionId = 'turn-end-sess-1';
    const sessionDir = join(tempDir, '--test-workspace--', sessionId);
    await mkdir(sessionDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: 1700000000000, cwd: '/workspace' }),
      JSON.stringify({ type: 'user/message', seq: 9, time: 1795003011533, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, role: 'user', id: 'u1' } }),
      JSON.stringify({ type: 'turn/end', seq: 16, time: 1795003012199, data: { turn: 1, reason: { kind: 'error', error: { message: '402: Insufficient Balance', code: 'QUOTA' } } } }),
      JSON.stringify({ type: 'turn/start', seq: 19, time: 1795003020000, data: { turn: 2 } }),
      JSON.stringify({ type: 'turn/end', seq: 21, time: 1795003020001, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } }),
      JSON.stringify({ type: 'user/message', seq: 23, time: 1795003021130, data: { content: [{ type: 'text', text: 'go on' }], source: { kind: 'user' }, role: 'user', id: 'u2' } }),
      JSON.stringify({ type: 'turn/end', seq: 29, time: 1795003023435, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } }),
      JSON.stringify({ type: 'user/message', seq: 40, time: 1795003030000, data: { content: [{ type: 'text', text: 'again' }], source: { kind: 'user' }, role: 'user', id: 'u3' } }),
      JSON.stringify({ type: 'assistant/message', seq: 41, time: 1795003031000, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } }),
      JSON.stringify({ type: 'turn/end', seq: 42, time: 1795003031001, data: { turn: 3, reason: { kind: 'completed' } } }),
    ].join('\n');
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines, 'utf8')));

    const adapter = new DshAdapter({ sessionsDir: tempDir });
    const history = adapter.getHistoryMessages(sessionId);
    assert.deepEqual(history.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    assert.deepEqual(history[1]?.content, []);
    assert.deepEqual(history[1]?.metadata, {
      is_error: true,
      turn_outcome: 'failed',
      turn_error: { message: '402: Insufficient Balance', code: 'QUOTA' },
    });
    assert.deepEqual(history[3]?.content, []);
    assert.deepEqual(history[3]?.metadata, { turn_outcome: 'interrupted' });
    assert.equal(history[5]?.metadata, undefined);
    assert.equal(adapter.listSessionsFromDisk()[0]?.messageCount, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('review regression: listModels removes hardcoded fake DeepSeek models and setModel rejects obsolete models', { timeout: 2000 }, async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-test-fake-models-'));
  try {
    await withMockDsh((message, child) => {
      if (message.method === 'initialize') child.send({ id: message.id, result: { protocolVersion: 1 } });
      if (message.method === 'session/new') child.send({ id: message.id, result: { sessionId: 'sess-fake-test', configOptions: reviewConfigOptions } });
      if (message.method === 'session/set_config_option') {
        const val = message.params?.value;
        if (val === 'deepseek-v4-flash') {
          child.send({ id: message.id, error: { code: -32602, message: 'Invalid params: unknown model option: deepseek-v4-flash' } });
        } else {
          child.send({ id: message.id, result: { configOptions: reviewConfigOptions } });
        }
      }
    }, async () => {
      const adapter = new DshProviderAdapter({ dshBin: 'mock', sessionsDir: tempDir, recycleGraceMs: 0 });
      try {
        const session = await adapter.create({ provider: 'dsh', cwd: tempDir });
        const models = await adapter.listModels();
        assert.ok(!models.some((m) => m.model === 'deepseek-v4-flash'), 'must not return fake deepseek-v4-flash');

        await assert.rejects(adapter.setModel(session.id, 'deepseek-v4-flash'), /unknown model option/);
        assert.notEqual(adapter.getModel(session.id), 'deepseek-v4-flash');
      } finally {
        await adapter.dispose();
      }
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('review regression: listSessionsFromDisk caches parsed files by mtime and size without re-decompressing', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-test-cache-'));
  try {
    const groupDir = join(tempDir, '--test-cache-ws--');
    const sessionId = 'cached-sess-1';
    const sessionDir = join(groupDir, sessionId);
    await mkdir(sessionDir, { recursive: true });

    const lines = [
      JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: 1700000000000, cwd: '/workspace' }),
      JSON.stringify({
        type: 'user/message',
        seq: 1,
        time: 1794810800000,
        data: {
          content: [{ type: 'text', text: 'Cached user message' }],
          source: { kind: 'user' },
          role: 'user',
          id: 'user-cached-1',
        },
      }),
    ].join('\n');

    const compressed = zlib.zstdCompressSync(Buffer.from(lines, 'utf8'));
    const sessionFile = join(sessionDir, 'session.v4.jsonl.zstd');
    await writeFile(sessionFile, compressed);

    const adapter = new DshAdapter({ sessionsDir: tempDir });
    const firstList = adapter.listSessionsFromDisk();
    assert.equal(firstList.length, 1);
    assert.equal(firstList[0]?.title, 'Cached user message');

    const cacheEntry = (adapter as any).sessionFileCache.get(sessionFile);
    assert.ok(cacheEntry, 'session file must be cached in sessionFileCache');
    assert.equal(cacheEntry.firstUserPrompt, 'Cached user message');

    // Second call: mtime and size did not change, must hit cache and return identical cache entry reference
    const secondList = adapter.listSessionsFromDisk();
    assert.equal(secondList.length, 1);
    assert.equal(secondList[0]?.title, 'Cached user message');
    assert.equal((adapter as any).sessionFileCache.get(sessionFile), cacheEntry, 'must reuse cached entry object');

    // getHistoryMessages should also hit cache and reuse messages array
    const history = adapter.getHistoryMessages(sessionId);
    assert.equal(history, cacheEntry.messages, 'getHistoryMessages must reuse cached messages array');

    // Updating file invalidates cache and triggers re-parse
    const updatedLines = lines + '\n' + JSON.stringify({
      type: 'user/message',
      seq: 2,
      time: 1794810810000,
      data: {
        content: [{ type: 'text', text: 'Second message' }],
        source: { kind: 'user' },
      },
    });
    await writeFile(sessionFile, zlib.zstdCompressSync(Buffer.from(updatedLines, 'utf8')));

    const thirdList = adapter.listSessionsFromDisk();
    assert.equal(thirdList[0]?.messageCount, 2);
    const updatedCacheEntry = (adapter as any).sessionFileCache.get(sessionFile);
    assert.notEqual(updatedCacheEntry, cacheEntry, 'cache entry must be updated after file modification');
    assert.equal(updatedCacheEntry.userMsgCount, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


async function dshCatalogFixture(base: string) {
  const store = new ProviderStore(base);
  for (const id of ['first', 'second']) store.upsert('dsh', {
    id, type: 'openai', base_url: 'https://example.invalid/v1', api_key: `test-secret-${id}`,
    models: [{ model: 'shared', display_name: `${id} model`, max_context_size: 98765,
      capabilities: ['thinking', 'image_in'], support_efforts: ['low', 'max', 'bogus'], default_effort: 'max' }],
  });
  store.setActive('dsh', 'second');
  return store;
}

const catalogConfig = [
  { id: 'model', currentValue: '["custom-a","same-model"]', options: [
    ...reviewConfigOptions[0].options,
    { group: 'gw_first', name: 'first', options: [{ value: '["gw_first","shared"]', name: 'Wrong runtime metadata' }] },
    { group: 'gw_second', name: 'second', options: [{ value: '["gw_second","shared"]', name: 'Wrong runtime metadata' }] },
  ] },
  { id: 'reasoning_effort', currentValue: '', options: [
    { value: '', name: 'Provider default' }, { value: 'off', name: 'Off' }, { value: 'high', name: 'High' },
  ] },
];

test('DSH catalog metadata, defaults, native values and reasoning-off follow official config options', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-catalog-'));
  const store = await dshCatalogFixture(base);
  const requests: MockRpcMessage[] = [];
  try {
    await withMockDsh((message, child) => {
      requests.push(message);
      if (message.method === 'initialize') child.send({ id: message.id, result: { protocolVersion: 1 } });
      if (message.method === 'session/new' || message.method === 'session/resume') child.send({ id: message.id, result: { sessionId: 'catalog-session', configOptions: catalogConfig } });
      if (message.method === 'session/set_config_option') {
        if (message.params?.value === '["gw_first","reject"]') child.send({ id: message.id, error: { message: 'unknown model option' } });
        else child.send({ id: message.id, result: { configOptions: catalogConfig } });
      }
      if (message.method === 'session/prompt') child.send({ id: message.id, result: { stopReason: 'end_turn' } });
    }, async () => {
      const adapter = new DshProviderAdapter({ dshBin: 'mock', sessionsDir: join(base, 'sessions'), settingsPath: join(base, 'settings.json'), providers: store.forCli('dsh'), recycleGraceMs: 0 });
      try {
        const before = await adapter.listModels();
        assert.ok(before.some((m) => m.model === '@first:shared'));
        const session = await adapter.create({ provider: 'dsh', cwd: base });
        assert.equal(adapter.getModel(session.id), '@second:shared');
        assert.ok(requests.some((r) => r.method === 'session/set_config_option' && r.params?.value === '["gw_second","shared"]'));
        const models = await adapter.listModels();
        const catalog = models.find((m) => m.model === '@first:shared')!;
        assert.equal(catalog.provider, 'first');
        assert.equal(catalog.max_context_size, 98765);
        assert.equal(catalog.display_name, 'first model');
        assert.deepEqual(catalog.capabilities, ['thinking', 'image_in']);
        assert.deepEqual(catalog.support_efforts, ['low', 'max']);
        assert.equal(catalog.default_effort, 'max');
        const native = models.find((m) => m.model === '["custom-b","same-model"]')!;
        assert.equal(JSON.parse(JSON.stringify(native)).max_context_size, null);
        assert.equal(native.support_efforts, undefined, 'current model reasoning must not be copied to all models');
        await adapter.setModel(session.id, '@first:shared');
        assert.equal(adapter.getModel(session.id), '@first:shared');
        assert.equal(adapter.getUsage(session.id)?.context_limit, 98765);
        await adapter.setThinking(session.id, 'off');
        assert.equal(requests.at(-1)?.params?.value, 'off');
        await assert.rejects(adapter.setModel(session.id, '@first:reject'), /unknown model option/);
        assert.equal(adapter.getModel(session.id), '@first:shared');
        for (const sid of [session.id, '__default__']) await assert.rejects(adapter.setModel(sid, '@missing:shared'),
          (err: any) => err.code === 'invalid_request' && err.httpStatus === 400);
        const client: DshAcpClient = (adapter as any).adapter.getAcpClient();
        client.closeProcess();
        const handle = await adapter.startTurn({ sessionId: session.id, input: 'hi', metadata: { cwd: base } });
        for await (const _event of handle.events) {}
        const resumedAt = requests.map((r) => r.method).lastIndexOf('session/resume');
        assert.ok(requests.slice(resumedAt).some((r) => r.method === 'session/set_config_option' && r.params?.value === '["gw_first","shared"]'));
      } finally { await adapter.dispose(); }
    });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('DSH off rejects provider-default-only config without persisting', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-off-'));
  try {
    await withMockDsh((message, child) => {
      if (message.method === 'initialize') child.send({ id: message.id, result: { protocolVersion: 1 } });
      if (message.method === 'session/new') child.send({ id: message.id, result: { sessionId: 'off-session', configOptions: reviewConfigOptions } });
      if (message.method === 'session/resume') child.send({ id: message.id, error: { message: `session is already active: ${message.params?.sessionId}` } });
      if (message.method === 'session/set_config_option') child.send({ id: message.id, result: { configOptions: reviewConfigOptions } });
      if (message.method === 'session/prompt') child.send({ id: message.id, result: { stopReason: 'end_turn' } });
    }, async () => {
      const settingsPath = join(base, 'settings.json');
      const seed = new SettingsStore(settingsPath);
      seed.set('thinking', '__default__', 'off');
      seed.flushNow();
      seed.close();
      const applied: unknown[] = [];
      const adapter = new DshProviderAdapter({ dshBin: 'mock', sessionsDir: base, settingsPath });
      try {
        const session = await adapter.create({ provider: 'dsh', cwd: base });
        assert.equal(adapter.getCwd(session.id), base, 'a fresh session must stay addressable before its first turn');
        await assert.rejects(adapter.setThinking(session.id, 'off'), (err: any) => err.code === 'invalid_request');
        const handle = await adapter.startTurn({ sessionId: session.id, input: 'hi', metadata: { cwd: base } });
        for await (const _event of handle.events) { /* drain */ }
        assert.deepEqual(applied, [], 'a stored provider-default thinking level must not block a turn');
        const store = new SettingsStore(settingsPath);
        try { assert.equal(store.getString('thinking', '__default__'), 'off'); } finally { store.close(); }
      } finally { await adapter.dispose(); }
    });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('DSH fingerprint rotation waits for pending prompt even with idle recycling disabled', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-rotation-'));
  const store = await dshCatalogFixture(base);
  let prompt: MockRpcMessage | undefined;
  let promptReceived!: () => void;
  const received = new Promise<void>((resolve) => { promptReceived = resolve; });
  try {
    await withMockDsh((message, child) => {
      if (message.method === 'initialize') child.send({ id: message.id, result: { protocolVersion: 1 } });
      if (message.method === 'session/new') child.send({ id: message.id, result: { sessionId: 'one', configOptions: catalogConfig } });
      if (message.method === 'session/prompt') { prompt = message; promptReceived(); }
    }, async (children) => {
      const client = new DshAcpClient({ dshBin: 'mock', providers: store.forCli('dsh'), recycleGraceMs: 0 });
      try {
        await client.newSession(base);
        const running = client.prompt('one', 'wait');
        await received;
        store.upsert('dsh', { api_key: 'rotated-secret' }, 'first');
        await client.ensureReady();
        assert.equal(children[0].killed, false);
        children[0].send({ id: prompt!.id, result: { stopReason: 'end_turn' } });
        await running;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(children[0].killed, true);
        await client.ensureReady();
        assert.equal(children.length, 2);
      } finally { client.close(); }
    });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('DSH ACP redacts injected credentials in errors and stderr', async () => {
  const lines: string[] = [];
  await withMockDsh((message, child) => {
    if (message.method === 'initialize') child.send({ id: message.id, result: { protocolVersion: 1 } });
    if (message.method === 'session/new') {
      child.stderr.write('sensitive-credential\n');
      child.send({ id: message.id, error: { message: 'upstream sensitive-credential' } });
    }
  }, async () => {
    const client = new DshAcpClient({ dshBin: 'mock', env: { MAG_DSH_KEY_TEST: 'sensitive-credential' }, onStderr: (line) => lines.push(line) });
    try {
      await assert.rejects(client.newSession('/tmp'), (err: Error) => !err.message.includes('sensitive-credential'));
      assert.ok(lines.every((line) => !line.includes('sensitive-credential')));
    } finally { client.close(); }
  });
});

test('DSH provider patch keeps the user llm-pi-ai routes and fields; user routes win on a clash', async () => {
  const { mergePiAiConfig } = await import('./dsh-patch.js');
  const user = {
    providers: { ccwu: { apiKeyEnv: 'CCWU_API_KEY', baseURL: 'https://relay.example' }, shared: { displayName: 'mine' } },
    retry: { __jsExpr: "ctx.get('x')" },
  };
  const merged = mergePiAiConfig(user, { gw_relay: { apiKeyEnv: 'MAG_DSH_KEY_RELAY' }, shared: { displayName: 'gateway' } });
  assert.deepEqual(Object.keys(merged.providers as object).sort(), ['ccwu', 'gw_relay', 'shared']);
  assert.deepEqual((merged.providers as any).shared, { displayName: 'mine' });
  assert.deepEqual(merged.retry, { __jsExpr: "ctx.get('x')" });
  assert.deepEqual(mergePiAiConfig(undefined, { gw_a: {} }), { providers: { gw_a: {} } });
  assert.throws(() => mergePiAiConfig({ providers: { __jsExpr: 'x' } }, { gw_a: {} }), /not a plain mapping/);
});

test('DSH cancelled empty turn does not write an empty assistant message into gateway_history', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cancel-hist-'));
  try {
    await withMockDsh((message, child) => {
      if (message.method === 'initialize') child.send({ id: message.id, result: { protocolVersion: 1 } });
      if (message.method === 'session/new') child.send({ id: message.id, result: { sessionId: 'cancel-s1', configOptions: reviewConfigOptions } });
      if (message.method === 'session/resume') child.send({ id: message.id, result: { configOptions: reviewConfigOptions } });
      if (message.method === 'session/set_config_option') child.send({ id: message.id, result: { configOptions: reviewConfigOptions } });
      if (message.method === 'session/prompt') child.send({ id: message.id, result: { stopReason: 'cancelled' } });
    }, async () => {
      const adapter = new DshProviderAdapter({ dshBin: 'mock', sessionsDir: join(base, 'sessions'), settingsPath: join(base, 'settings.json'), recycleGraceMs: 0 });
      try {
        const session = await adapter.create({ provider: 'dsh', cwd: base });
        const handle = await adapter.startTurn({ sessionId: session.id, input: '继续', metadata: { cwd: base } });
        const events = [];
        for await (const ev of handle.events) events.push(ev);
        assert.equal(events.at(-1)?.status, 'cancelled');
        const history = await adapter.getHistory(session.id);
        assert.deepEqual(history, []);
      } finally {
        await adapter.dispose();
      }
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
