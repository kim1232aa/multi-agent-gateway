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

test('reuses one Codex warm page for homepage limit=50 after limit=100 preload', async () => {
  // 回归:缓存曾只认 limit===100,前端 page_size=50 每次都冷扫 thread/list(~4.7s)。
  const adapter = new CodexProviderAdapter();
  let calls = 0;
  const threads = Array.from({ length: 12 }, (_, index) => ({
    id: `main-${index}`,
    name: `t${index}`,
    cwd: '/tmp/project',
    updatedAt: 100 - index,
  }));
  (adapter as any).inner.list = async (query: any) => {
    calls += 1;
    assert.equal(query.limit, 100);
    assert.equal(query.cursor ?? null, null);
    return { threads, nextCursor: 'native-next', backwardsCursor: null };
  };

  const warm = await adapter.list({ limit: 100 });
  assert.equal(warm.items.length, 12);
  assert.equal(calls, 1);

  const home = await adapter.list({ limit: 50 });
  assert.equal(calls, 1, 'homepage limit=50 must hit the warm page, not rescans');
  assert.deepEqual(home.items.map((session) => session.id), threads.slice(0, 12).map((t) => t.id));
  // 暖页已吃完但仍有原生 next → 直接透出原生游标。
  assert.equal(home.next_cursor, 'native-next');

  const again = await adapter.list({ limit: 50 });
  assert.equal(calls, 1);
  assert.deepEqual(again.items.map((session) => session.id), home.items.map((session) => session.id));
});

test('Codex slice cursors carry generation and reject stale offsets after invalidate', async () => {
  const adapter = new CodexProviderAdapter();
  let calls = 0;
  const mk = (n: number, offset = 0) => Array.from({ length: n }, (_, index) => ({
    id: `main-${offset + index}`,
    name: `t${offset + index}`,
    cwd: '/tmp/project',
    updatedAt: 1000 - offset - index,
  }));
  (adapter as any).inner.list = async (query: any) => {
    calls += 1;
    if (query.cursor) {
      return { threads: mk(4, 100), nextCursor: null, backwardsCursor: null };
    }
    return { threads: mk(8), nextCursor: 'native-next', backwardsCursor: null };
  };

  const page1 = await adapter.list({ limit: 3 });
  assert.equal(calls, 1);
  assert.match(String(page1.next_cursor), /^__slice__:\d+:3$/);

  // 同代际切片继续吃暖页,不再打 RPC。
  const page2 = await adapter.list({ limit: 3, cursor: page1.next_cursor });
  assert.equal(calls, 1);
  assert.deepEqual(page2.items.map((s) => s.id), ['main-3', 'main-4', 'main-5']);

  // startTurn 会使缓存代际递增;旧切片游标必须失效并回退到原生首屏。
  (adapter as any).invalidateListCache();
  const stale = await adapter.list({ limit: 3, cursor: page1.next_cursor });
  assert.equal(calls, 2, 'stale slice cursor must not reuse rebuilt warm page offsets');
  assert.ok(stale.items.length >= 3);
  assert.equal(stale.items[0]?.id, 'main-0');
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

test('archives Claude sessions via sidecar settings and filters Done lists', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-facade-archive-'));
  const projectsDir = join(base, 'projects');
  const projectDir = join(projectsDir, 'project');
  const settingsPath = join(base, 'session-settings.claude.json');
  const openId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const doneId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  try {
    await mkdir(projectDir, { recursive: true });
    for (const [id, title] of [[openId, 'still open'], [doneId, 'mark done']] as const) {
      await writeFile(join(projectDir, `${id}.jsonl`), JSON.stringify({
        type: 'ai-title',
        aiTitle: title,
        cwd: '/tmp/project',
      }) + '\n');
    }

    const adapter = new ClaudeProviderAdapter({ projectsDir, settingsPath });
    assert.ok(adapter.setArchived);

    const before = await adapter.list({ limit: 10 });
    assert.deepEqual(before.items.map((session) => session.id).sort(), [openId, doneId].sort());
    assert.equal(before.items.every((session) => session.archived !== true), true);
    assert.equal(before.items.every((session) => typeof session.extras?.last_prompt === 'string' && session.extras.last_prompt.length > 0), true);

    await adapter.setArchived!(doneId, true);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const open = await adapter.list({ limit: 10 });
    assert.deepEqual(open.items.map((session) => session.id), [openId]);

    const done = await adapter.list({ limit: 10, archived: true });
    assert.deepEqual(done.items.map((session) => session.id), [doneId]);
    assert.equal(done.items[0].archived, true);
    assert.equal(done.items[0].extras?.last_prompt, 'mark done');

    // 持久化到 sidecar,新实例也能看到 Done。
    const restarted = new ClaudeProviderAdapter({ projectsDir, settingsPath });
    const doneAgain = await restarted.list({ limit: 10, archived: true });
    assert.deepEqual(doneAgain.items.map((session) => session.id), [doneId]);

    await restarted.setArchived!(doneId, false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const restored = await restarted.list({ limit: 10 });
    assert.deepEqual(restored.items.map((session) => session.id).sort(), [openId, doneId].sort());
    assert.deepEqual((await restarted.list({ limit: 10, archived: true })).items, []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('surfaces Codex archived flag and last_prompt for Done filtering', async () => {
  const adapter = new CodexProviderAdapter();
  (adapter as any).inner.list = async (query: any) => {
    assert.equal(query.archived, true);
    return {
      threads: [
        { id: 'archived-a', name: 'done title', preview: 'last user line', cwd: '/tmp/project', updatedAt: 2, archived: true },
        { id: 'child', name: 'done title', cwd: '/tmp/project', updatedAt: 1, parentThreadId: 'archived-a', archived: true },
      ],
      nextCursor: null,
      backwardsCursor: null,
    };
  };

  const page = await adapter.list({ limit: 10, archived: true });
  assert.deepEqual(page.items.map((session) => session.id), ['archived-a']);
  assert.equal(page.items[0].archived, true);
  assert.equal(page.items[0].extras?.last_prompt, 'last user line');
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
const commands = [{ name: 'compact', description: 'Compact', argumentHint: '', aliases: [] }];
process.stdin.on('data', (chunk) => {
  if (!chunk.toString().includes('control_request')) return;
  process.stdout.write(JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'gw_init', response: { models, commands } },
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

test('shares one Claude handshake spawn between models and commands', async () => {
  // 回归:切到 Claude 时 /models 与 /commands 曾各自 spawn 一次(~1s×2)。
  const saved = stashAnthropicModelVars();
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-shared-handshake-'));
  try {
    const { bin, marker } = await fakeClaudeBin(base);
    const adapter = new ClaudeProviderAdapter({ claudeBin: bin } as any);
    const models = await adapter.listModels();
    const commands = await adapter.listCommands();
    assert.ok(models.length >= 1);
    assert.ok(commands.some((command) => command.name === 'compact'));
    assert.equal((await readFile(marker, 'utf8')).length, 1);
  } finally {
    restoreAnthropicModelVars(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('keeps Claude tool and thinking blocks even when text is empty', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-tools-history-'));
  const projectsDir = join(base, 'projects');
  const projectDir = join(projectsDir, 'project');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-11T10:00:00.000Z',
        message: { role: 'user', content: 'run tool' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-11T10:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'claude-test',
          content: [
            { type: 'thinking', thinking: 'plan the call' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-11T10:00:02.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '/tmp/project' }],
        },
      }),
    ].join('\n') + '\n');

    const history = await new ClaudeProviderAdapter({ projectsDir }).getHistory(sessionId);
    assert.equal(history.length, 3);
    assert.deepEqual(
      history[1]?.content.map((part) => part.type),
      ['thinking', 'tool_call'],
    );
    assert.equal(history[2]?.content[0]?.type, 'tool_result');
  } finally {
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

test('decides Claude --session-id vs --resume from transcript file presence', async () => {
  // 回归:isNew 曾是一次性内存标记(created.delete)——首轮失败/网关重启后
  // 重试走 --resume 不存在的会话必败。现在只看 transcript 文件是否落盘。
  const adapter = new ClaudeProviderAdapter();
  const isNewSeen: boolean[] = [];
  let hasFile = false;
  (adapter as any).inner.hasSessionFile = () => hasFile;
  (adapter as any).inner.startTurn = async (opts: any) => {
    isNewSeen.push(opts.isNew);
    opts.onEvent({ type: 'done', usage: null, isError: false, result: '' });
  };
  const sessionId = '123e4567-e89b-12d3-a456-426614174002';
  const drain = async (input: string): Promise<void> => {
    const handle = await adapter.startTurn({ sessionId, input });
    for await (const _ of handle.events) { /* consume to stream end */ }
  };

  hasFile = false;
  await drain('one'); // 文件未落盘 → --session-id 建档
  hasFile = true;
  await drain('two'); // 文件在 → --resume
  hasFile = false;
  await drain('three'); // 首轮失败后重试(文件仍不在)→ 继续建档,不能 --resume 必败

  assert.deepEqual(isNewSeen, [true, false, true]);
});
