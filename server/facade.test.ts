import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexAdapter } from './codex-adapter.js';
import { ClaudeProviderAdapter, CodexProviderAdapter } from './facade.js';

test('passes Codex source kinds to thread/list', async () => {
  const adapter = new CodexAdapter();
  let request: { method: string; params: Record<string, unknown> } | undefined;
  (adapter as any).connect = async () => {};
  (adapter as any).request = async (method: string, params: Record<string, unknown>) => {
    request = { method, params };
    return { data: [], nextCursor: null, backwardsCursor: null };
  };

  await adapter.list({ sourceKinds: ['cli'] });

  assert.equal(request?.method, 'thread/list');
  assert.deepEqual(request?.params.sourceKinds, ['cli']);
});

test('filters Codex child and ephemeral threads without merging duplicate main titles', async () => {
  const adapter = new CodexProviderAdapter();
  const calls: any[] = [];
  (adapter as any).inner.list = async (query: any) => {
    calls.push(query);
    return {
      threads: [
        { id: 'main-a', name: 'duplicate title', cwd: '/tmp/project', updatedAt: 3 },
        { id: 'child', name: 'duplicate title', cwd: '/tmp/project', updatedAt: 2, parentThreadId: 'main-a' },
        { id: 'ephemeral', name: 'duplicate title', cwd: '/tmp/project', updatedAt: 2, ephemeral: true },
        { id: 'main-b', name: 'duplicate title', cwd: '/tmp/project', updatedAt: 1 },
      ],
      nextCursor: 'native-next',
      backwardsCursor: null,
    };
  };

  const page = await adapter.list({ limit: 4, cursor: 'native-cursor', cwd: '/tmp/project' });

  assert.deepEqual(page.items.map((session) => session.id), ['main-a', 'main-b']);
  assert.deepEqual(page.items.map((session) => session.title), ['duplicate title', 'duplicate title']);
  assert.equal(page.next_cursor, 'native-next');
  assert.deepEqual(calls, [{
    cursor: 'native-cursor',
    limit: 4,
    cwd: '/tmp/project',
    archived: undefined,
    sourceKinds: ['cli'],
  }]);
});

test('forgets a Codex draft after deleting its thread', async () => {
  const adapter = new CodexProviderAdapter();
  (adapter as any).inner.create = async () => ({
    id: 'draft-to-delete',
    cwd: '/tmp/draft',
    createdAt: 1,
    updatedAt: 1,
  });
  (adapter as any).inner.deleteThread = async (id: string) => {
    assert.equal(id, 'draft-to-delete');
  };

  const created = await adapter.create({ provider: 'codex', cwd: '/tmp/draft' });
  assert.equal(adapter.getCwd(created.id), '/tmp/draft');

  await adapter.delete(created.id);

  assert.equal(adapter.getCwd(created.id), undefined);
});

test('lists only top-level Claude sessions and paginates without merging duplicate titles', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-facade-list-'));
  const projectsDir = join(base, 'projects');
  const projectDir = join(projectsDir, 'project');
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ];
  try {
    await mkdir(join(projectDir, ids[0], 'subagents'), { recursive: true });
    for (let index = 0; index < ids.length; index += 1) {
      const file = join(projectDir, `${ids[index]}.jsonl`);
      await writeFile(file, JSON.stringify({
        type: 'ai-title',
        aiTitle: 'duplicate title',
        cwd: '/tmp/project',
      }) + '\n');
      const stamp = new Date(`2026-01-01T00:00:0${index + 1}.000Z`);
      await utimes(file, stamp, stamp);
    }
    await writeFile(
      join(projectDir, ids[0], 'subagents', 'agent-child.jsonl'),
      JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'child' } }) + '\n',
    );

    const adapter = new ClaudeProviderAdapter({ projectsDir });
    const first = await adapter.list({ limit: 2 });
    const second = await adapter.list({ limit: 2, cursor: first.next_cursor });

    assert.deepEqual(first.items.map((session) => session.id), [ids[2], ids[1]]);
    assert.equal(first.next_cursor, ids[1]);
    assert.deepEqual(second.items.map((session) => session.id), [ids[0]]);
    assert.equal(second.next_cursor, undefined);
    assert.equal([...first.items, ...second.items].every((session) => session.title === 'duplicate title'), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('keeps Claude history message ids stable across repeated reads', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-facade-'));
  const projectsDir = join(base, 'projects');
  const projectDir = join(projectsDir, 'project');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-11T10:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-11T10:00:01.000Z',
        message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'world' }] },
      }),
    ].join('\n') + '\n');

    const adapter = new ClaudeProviderAdapter({ projectsDir });
    const first = await adapter.getHistory(sessionId);
    const second = await adapter.getHistory(sessionId);

    assert.equal(first.length, 2);
    assert.equal(new Set(first.map((message) => message.id)).size, 2);
    assert.deepEqual(second.map((message) => message.id), first.map((message) => message.id));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('preserves Claude API error markers in history', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-facade-error-'));
  const projectsDir = join(base, 'projects');
  const projectDir = join(projectsDir, 'project');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-11T10:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        isApiErrorMessage: true,
        timestamp: '2026-08-11T10:00:01.000Z',
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] },
      }),
    ].join('\n') + '\n');

    const history = await new ClaudeProviderAdapter({ projectsDir }).getHistory(sessionId);

    assert.equal(history[1]?.metadata?.is_error, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Claude 模型目录:未配置自定义端点时展示 CLI 握手的内置模型;失败如实报错。
// ---------------------------------------------------------------------------

const HANDSHAKE_MODELS = [
  { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5[1m]', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
  { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
];

const ANTHROPIC_MODEL_VARS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

function stashAnthropicModelVars(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const name of ANTHROPIC_MODEL_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  return saved;
}

function restoreAnthropicModelVars(saved: Record<string, string | undefined>): void {
  for (const name of ANTHROPIC_MODEL_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
}

async function fakeClaudeBin(base: string, opts: { fail?: boolean } = {}): Promise<{ bin: string; marker: string }> {
  const bin = join(base, 'claude');
  const marker = join(base, 'spawns.log');
  const body = opts.fail
    ? 'process.exit(1);'
    : `const models = ${JSON.stringify(HANDSHAKE_MODELS)};
process.stdin.on('data', (chunk) => {
  if (!chunk.toString().includes('control_request')) return;
  process.stdout.write(JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'gw_init', response: { models } },
  }) + '\\n');
  process.exit(0);
});`;
  await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(marker)}, 'x');
process.stdin.resume();
${body}
`);
  await chmod(bin, 0o755);
  return { bin, marker };
}

test('lists Claude built-in models from the CLI handshake when no custom endpoint is configured', async () => {
  const saved = stashAnthropicModelVars();
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-models-'));
  try {
    const { bin, marker } = await fakeClaudeBin(base);
    const models = await new ClaudeProviderAdapter({ claudeBin: bin } as any).listModels();

    assert.deepEqual(models.map((m) => m.model), ['default', 'sonnet', 'haiku']);
    assert.equal(models[0]?.display_name, 'Default (recommended)');
    assert.deepEqual(models[0]?.support_efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(models[0]?.capabilities?.includes('thinking'), true);
    assert.equal(models[2]?.support_efforts, undefined);
    assert.equal((await readFile(marker, 'utf8')).length, 1);
  } finally {
    restoreAnthropicModelVars(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('caches the Claude model handshake instead of spawning per call', async () => {
  const saved = stashAnthropicModelVars();
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-models-cache-'));
  try {
    const { bin, marker } = await fakeClaudeBin(base);
    const adapter = new ClaudeProviderAdapter({ claudeBin: bin } as any);
    await adapter.listModels();
    await adapter.listModels();

    assert.equal((await readFile(marker, 'utf8')).length, 1);
  } finally {
    restoreAnthropicModelVars(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('surfaces Claude model handshake failure and retries next call', async () => {
  const saved = stashAnthropicModelVars();
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-models-fail-'));
  try {
    const { bin, marker } = await fakeClaudeBin(base, { fail: true });
    const adapter = new ClaudeProviderAdapter({ claudeBin: bin } as any);

    await assert.rejects(adapter.listModels(), /models|handshake|exit/i);
    await assert.rejects(adapter.listModels());
    // 失败不进缓存:第二次是真实重试,不是吞掉后返回空目录。
    assert.equal((await readFile(marker, 'utf8')).length, 2);
  } finally {
    restoreAnthropicModelVars(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('keeps env-derived Claude models when a custom endpoint is configured', async () => {
  const saved = stashAnthropicModelVars();
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-models-env-'));
  try {
    process.env.ANTHROPIC_MODEL = 'custom-endpoint-model';
    const { bin, marker } = await fakeClaudeBin(base);
    const models = await new ClaudeProviderAdapter({ claudeBin: bin } as any).listModels();

    assert.deepEqual(models.map((m) => m.model), ['custom-endpoint-model']);
    assert.equal((await readFile(marker, 'utf8').catch(() => '')).length, 0);
  } finally {
    restoreAnthropicModelVars(saved);
    await rm(base, { recursive: true, force: true });
  }
});
