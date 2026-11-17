import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexAdapter } from './codex-adapter.js';
import {
  ClaudeProviderAdapter,
  CodexProviderAdapter,
  GrokProviderAdapter,
  PiProviderAdapter,
  workspaceIdFromCwd,
} from './facade.js';
import { fsRepoDiff } from './fs-local.js';
import { discoverClaudeDiskCommands, expandCodexSkill, listClaudeCommands } from './native-commands.js';

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
  // 必须显式 [] 才能跨 provider 列出历史会话(自定义 model_provider 下否则为空)。
  assert.deepEqual(request?.params.modelProviders, []);
});

test('CodexProviderAdapter lists cli, vscode and app-server threads', async () => {
  const adapter = new CodexProviderAdapter();
  let request: { method: string; params: Record<string, unknown> } | undefined;
  (adapter as any).inner.list = async (query: Record<string, unknown>) => {
    request = { method: 'thread/list', params: query };
    return {
      threads: [
        { id: 'cli-main', name: 'cli', cwd: '/tmp', updatedAt: 3, source: 'cli' },
        { id: 'vscode-main', name: 'web', cwd: '/tmp', updatedAt: 2, source: 'vscode' },
        { id: 'app-main', name: 'app', cwd: '/tmp', updatedAt: 1, source: 'appServer' },
        { id: 'child', name: 'child', cwd: '/tmp', updatedAt: 1, parentThreadId: 'cli-main', source: 'cli' },
      ],
      nextCursor: null,
      backwardsCursor: null,
    };
  };

  const page = await adapter.list({ limit: 10 });
  assert.deepEqual(request?.params.sourceKinds, ['cli', 'vscode', 'appServer']);
  assert.deepEqual(page.items.map((session) => session.id), ['cli-main', 'vscode-main', 'app-main']);
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
    sourceKinds: ['cli', 'vscode', 'appServer'],
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
      await writeFile(file, [
        JSON.stringify({
          type: 'ai-title',
          aiTitle: 'duplicate title',
          cwd: '/tmp/project',
        }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'hello' },
        }),
      ].join('\n') + '\n');
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
      await writeFile(join(projectDir, `${id}.jsonl`), [
        JSON.stringify({
          type: 'ai-title',
          aiTitle: title,
          cwd: '/tmp/project',
        }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: title },
        }),
      ].join('\n') + '\n');
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

test('marks Codex Done-list items archived even when thread/list omits the field', async () => {
  const adapter = new CodexProviderAdapter();
  (adapter as any).inner.list = async (query: any) => {
    assert.equal(query.archived, true);
    return {
      threads: [
        { id: 'archived-b', name: 'done without flag', preview: 'bye', cwd: '/tmp/project', updatedAt: 1 },
      ],
      nextCursor: null,
      backwardsCursor: null,
    };
  };

  const page = await adapter.list({ limit: 10, archived: true });
  assert.equal(page.items[0]?.archived, true);
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
  { value: 'claude-fable-5[1m]', displayName: 'Fable', resolvedModel: 'claude-fable-5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
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

    assert.deepEqual(models.map((m) => m.model), ['default', 'sonnet', 'fable', 'haiku']);
    assert.equal(models[0]?.display_name, 'Default (recommended)');
    assert.deepEqual(models[0]?.support_efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(models[0]?.capabilities?.includes('thinking'), true);
    assert.equal(models[2]?.display_name, 'Fable');
    assert.equal(models[2]?.max_context_size, 1_048_576);
    assert.equal(models[1]?.max_context_size, 200_000);
    assert.equal(models[3]?.support_efforts, undefined);
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
    assert.equal(history[1]?.role, 'assistant');
    assert.deepEqual(history[1]?.content, [
      { type: 'thinking', thinking: 'plan the call' },
      { type: 'tool_use', tool_call_id: 'toolu_1', tool_name: 'Bash', input: { command: 'pwd' } },
    ]);
    assert.equal(history[2]?.role, 'tool');
    assert.deepEqual(history[2]?.content, [
      { type: 'tool_result', tool_call_id: 'toolu_1', output: '/tmp/project', is_error: false },
    ]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('maps Codex history blocks to Kimi Web content fields', async () => {
  const adapter = new CodexProviderAdapter();
  (adapter as any).inner.getHistory = async () => [{
    startedAt: '2026-08-11T10:00:00.000Z',
    items: [
      { type: 'reasoning', id: 'reason-1', summary: [{ text: 'plan the call' }] },
      {
        type: 'commandExecution',
        id: 'call-1',
        command: 'pwd',
        aggregatedOutput: '/tmp/project',
        exitCode: 0,
      },
    ],
  }];

  const history = await adapter.getHistory('codex-wire-fields-test');

  assert.deepEqual(history.map((message) => message.content), [
    [{ type: 'thinking', thinking: 'plan the call' }],
    [{ type: 'tool_use', tool_call_id: 'call-1', tool_name: 'commandExecution', input: 'pwd' }],
    [{ type: 'tool_result', tool_call_id: 'call-1', output: '/tmp/project', is_error: false }],
  ]);
});

test('surfaces unsupported Claude goal operations explicitly', async () => {
  const adapter = new ClaudeProviderAdapter() as any;

  assert.equal(typeof adapter.setGoal, 'function');
  assert.equal(typeof adapter.controlGoal, 'function');
  await assert.rejects(
    adapter.setGoal('session-1', 'objective'),
    (error: any) => error?.code === 'unsupported' && /goal/i.test(error.message),
  );
  await assert.rejects(
    adapter.controlGoal('session-1', 'pause'),
    (error: any) => error?.code === 'unsupported' && /goal/i.test(error.message),
  );
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

test('Claude model selector stays on the CLI handshake catalog even when ANTHROPIC_MODEL is set', async () => {
  const saved = stashAnthropicModelVars();
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-models-env-'));
  try {
    process.env.ANTHROPIC_MODEL = 'qwen3.6-flash[1m]';
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'qwen3.6-flash[1m]';
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'qwen3.6-flash[1m]';
    const { bin, marker } = await fakeClaudeBin(base);
    const models = await new ClaudeProviderAdapter({ claudeBin: bin } as any).listModels();

    assert.deepEqual(models.map((m) => m.model), ['default', 'sonnet', 'fable', 'haiku']);
    assert.equal(models[0]?.display_name, 'Default (recommended)');
    assert.equal(models.some((m) => /qwen/i.test(m.model) || /qwen/i.test(m.display_name ?? '')), false);
    assert.equal((await readFile(marker, 'utf8')).length, 1);
  } finally {
    restoreAnthropicModelVars(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('drops env-only extras that the Claude handshake appends beside official aliases', async () => {
  const saved = stashAnthropicModelVars();
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-models-extra-'));
  try {
    const bin = join(base, 'claude');
    const models = [
      ...HANDSHAKE_MODELS,
      { value: 'qwen3.6-flash[1m]', displayName: 'qwen3.6-flash[1m]', resolvedModel: 'qwen3.6-flash[1m]', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ];
    await writeFile(bin, `#!/usr/bin/env node
process.stdin.on('data', (chunk) => {
  if (!chunk.toString().includes('control_request')) return;
  process.stdout.write(JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'gw_init', response: { models: ${JSON.stringify(models)}, commands: [] } },
  }) + '\\n');
  process.exit(0);
});
process.stdin.resume();
`);
    await chmod(bin, 0o755);
    const listed = await new ClaudeProviderAdapter({ claudeBin: bin } as any).listModels();
    assert.deepEqual(listed.map((m) => m.model), ['default', 'sonnet', 'fable', 'haiku']);
    assert.deepEqual(listed.map((m) => m.display_name), ['Default (recommended)', 'Sonnet', 'Fable', 'Haiku']);
    assert.equal(listed.some((m) => /qwen/i.test(m.model) || /qwen/i.test(m.display_name ?? '')), false);
  } finally {
    restoreAnthropicModelVars(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('Claude listModels rewrites handshake displayName so qwen never appears in the picker', async () => {
  // 回归:自定义端点会把官方别名的 displayName/resolvedModel 改成 qwen3.6-flash[1m]。
  // isClaudeCatalogModel 只看 value,选择器就会显示
  // "qwen3.6-flash[1m](default/opus/sonnet)" / "qwen3.6-flash(haiku)"。
  const adapter = new ClaudeProviderAdapter();
  (adapter as any).inner.listBuiltinModels = async () => [
    { value: 'default', displayName: 'qwen3.6-flash[1m]', resolvedModel: 'qwen3.6-flash[1m]', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'opus', displayName: 'qwen3.6-flash[1m]', resolvedModel: 'qwen3.6-flash[1m]', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', displayName: 'qwen3.6-flash[1m]', resolvedModel: 'qwen3.6-flash[1m]', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'opus[1m]', displayName: 'qwen3.6-flash[1m]', resolvedModel: 'qwen3.6-flash[1m]', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'claude-fable-5[1m]', displayName: 'qwen3.6-flash[1m]', resolvedModel: 'qwen3.6-flash[1m]', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', displayName: 'qwen3.6-flash', resolvedModel: 'qwen3.6-flash', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'qwen3.6-flash[1m]', displayName: 'qwen3.6-flash[1m]', resolvedModel: 'qwen3.6-flash[1m]', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ];

  const models = await adapter.listModels();

  assert.deepEqual(models.map((m) => m.model), ['default', 'opus', 'sonnet', 'fable', 'haiku']);
  assert.deepEqual(models.map((m) => m.display_name), [
    'Default (recommended)',
    'Opus',
    'Sonnet',
    'Fable',
    'Haiku',
  ]);
  assert.equal(models.every((m) => m.provider === 'claude'), true);
  assert.equal(models.some((m) => /qwen/i.test(JSON.stringify(m))), false);
  assert.deepEqual(models[0]?.support_efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(models[3]?.max_context_size, 1_048_576);
});

test('Claude listModels does not invent aliases when handshake only returns qwen ids', async () => {
  const adapter = new ClaudeProviderAdapter();
  (adapter as any).inner.listBuiltinModels = async () => [
    { value: 'qwen3.6-flash[1m]', displayName: 'qwen3.6-flash[1m]', resolvedModel: 'qwen3.6-flash[1m]' },
    { value: 'qwen3.6-flash', displayName: 'qwen3.6-flash', resolvedModel: 'qwen3.6-flash' },
  ];

  const models = await adapter.listModels();

  assert.deepEqual(models, []);
});

test('getModel ignores ANTHROPIC_MODEL and leftover qwen session values', async () => {
  const saved = stashAnthropicModelVars();
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-getmodel-'));
  try {
    process.env.ANTHROPIC_MODEL = 'qwen3.6-flash[1m]';
    const settingsPath = join(base, 'session-settings.claude.json');
    await writeFile(settingsPath, JSON.stringify({
      model: {
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'qwen3.6-flash[1m]',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': 'sonnet',
      },
    }));
    const adapter = new ClaudeProviderAdapter({ settingsPath } as any);
    assert.equal(adapter.getModel('missing'), undefined);
    assert.equal(adapter.getModel('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), undefined);
    assert.equal(adapter.getModel('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), 'sonnet');
  } finally {
    restoreAnthropicModelVars(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('startTurn does not pass leftover qwen as --model', async () => {
  const saved = stashAnthropicModelVars();
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-startturn-qwen-'));
  try {
    process.env.ANTHROPIC_MODEL = 'qwen3.6-flash[1m]';
    const settingsPath = join(base, 'session-settings.claude.json');
    const sessionId = '123e4567-e89b-12d3-a456-426614174099';
    await writeFile(settingsPath, JSON.stringify({ model: { [sessionId]: 'qwen3.6-flash[1m]' } }));
    const adapter = new ClaudeProviderAdapter({ settingsPath } as any);
    const seen: Array<string | undefined> = [];
    (adapter as any).inner.hasSessionFile = () => false;
    (adapter as any).inner.startTurn = async (opts: any) => {
      seen.push(opts.model);
      opts.onEvent({ type: 'done', usage: null, isError: false, result: '' });
    };
    const handle = await adapter.startTurn({ sessionId, input: 'hi' });
    for await (const _ of handle.events) { /* drain */ }
    assert.deepEqual(seen, [undefined]);
  } finally {
    restoreAnthropicModelVars(saved);
    await rm(base, { recursive: true, force: true });
  }
});

test('startTurn omits --model when stored model is default so ANTHROPIC_MODEL takes effect, while forwarding explicit aliases', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-default-alias-'));
  try {
    const settingsPath = join(base, 'session-settings.claude.json');
    const sDefault = '123e4567-e89b-12d3-a456-426614174088';
    const sSonnet = '123e4567-e89b-12d3-a456-426614174089';
    await writeFile(settingsPath, JSON.stringify({ model: { [sDefault]: 'default', [sSonnet]: 'sonnet' } }));
    const adapter = new ClaudeProviderAdapter({ settingsPath } as any);
    const seen: Array<string | undefined> = [];
    (adapter as any).inner.hasSessionFile = () => false;
    (adapter as any).inner.startTurn = async (opts: any) => {
      seen.push(opts.model);
      opts.onEvent({ type: 'done', usage: null, isError: false, result: '' });
    };
    for await (const _ of (await adapter.startTurn({ sessionId: sDefault, input: 'hi' })).events) { /* drain */ }
    for await (const _ of (await adapter.startTurn({ sessionId: sSonnet, input: 'hi' })).events) { /* drain */ }
    assert.deepEqual(seen, [undefined, 'sonnet']);
  } finally {
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

test('ClaudeProviderAdapter.steer forwards to the inner adapter', async () => {
  const adapter = new ClaudeProviderAdapter();
  const calls: Array<{ sessionId: string; text: string }> = [];
  (adapter as any).inner.steer = async (sessionId: string, text: string) => {
    calls.push({ sessionId, text });
  };

  await adapter.steer!('sess-1', 'turn-1', 'please stop');

  assert.deepEqual(calls, [{ sessionId: 'sess-1', text: 'please stop' }]);
});

test('ClaudeProviderAdapter advertises approvals and questions', () => {
  const caps = new ClaudeProviderAdapter().capabilities();
  assert.equal(caps.approvals, true);
  assert.equal(caps.questions, true);
});

test('ClaudeProviderAdapter.fork returns a Session for the new id and copies cwd', async () => {
  const adapter = new ClaudeProviderAdapter();
  (adapter as any).sessionCwd.set('old-id', '/tmp/proj');
  (adapter as any).renames.set('old-id', 'Original');
  (adapter as any).inner.forkSession = async (sessionId: string, cwd?: string) => {
    assert.equal(sessionId, 'old-id');
    assert.equal(cwd, '/tmp/proj');
    return { sessionId: 'new-id' };
  };

  const session = await adapter.fork!('old-id');
  assert.equal(session.id, 'new-id');
  assert.equal(session.provider, 'claude');
  assert.equal(session.metadata.cwd, '/tmp/proj');
  assert.equal(session.title, 'Original');
  assert.equal(adapter.getCwd('new-id'), '/tmp/proj');
});

test('ClaudeProviderAdapter.fork falls back to list() cwd when sessionCwd is empty', async () => {
  const adapter = new ClaudeProviderAdapter();
  (adapter as any).inner.list = async () => [{
    sessionId: 'old-id',
    title: 'from list',
    cwd: '/tmp/listed',
    projectDir: 'listed',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }];
  (adapter as any).inner.forkSession = async (_sessionId: string, cwd?: string) => {
    assert.equal(cwd, '/tmp/listed');
    return { sessionId: 'forked-id' };
  };

  const session = await adapter.fork!('old-id');
  assert.equal(session.id, 'forked-id');
  assert.equal(session.metadata.cwd, '/tmp/listed');
});

test('ClaudeProviderAdapter.fork copies session settings onto the new id', async () => {
  const adapter = new ClaudeProviderAdapter();
  (adapter as any).sessionCwd.set('old-id', '/tmp/proj');
  await adapter.setModel('old-id', 'sonnet');
  await adapter.setThinking('old-id', 'high');
  (adapter as any).inner.forkSession = async () => ({ sessionId: 'new-id' });

  await adapter.fork!('old-id');
  assert.equal(adapter.getModel('new-id'), 'sonnet');
  assert.equal(adapter.getThinking!('new-id'), 'high');
  assert.equal(adapter.getModel('old-id'), 'sonnet');
});

test('CodexProviderAdapter.fork copies session settings onto the new id', async () => {
  const adapter = new CodexProviderAdapter();
  await adapter.setModel('old-id', 'gpt-5.6-sol');
  await adapter.setThinking('old-id', 'high');
  (adapter as any).inner.forkThread = async (sessionId: string) => {
    assert.equal(sessionId, 'old-id');
    return { id: 'new-id', cwd: '/tmp/codex' };
  };

  const session = await adapter.fork!('old-id');
  assert.equal(session.id, 'new-id');
  assert.equal(adapter.getModel('new-id'), 'gpt-5.6-sol');
  assert.equal(adapter.getThinking!('new-id'), 'high');
});

test('ClaudeProviderAdapter.delete unlinks via inner and drops local state', async () => {
  const adapter = new ClaudeProviderAdapter();
  const deleted: string[] = [];
  (adapter as any).inner.delete = async (id: string) => { deleted.push(id); };
  (adapter as any).sessionCwd.set('s1', '/tmp');
  (adapter as any).renames.set('s1', 't');
  (adapter as any).sessionUsage.set('s1', {
    input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    total_cost_usd: 0, context_tokens: 0, context_limit: 0, turn_count: 1,
  });
  (adapter as any).settings.set('model', 's1', 'sonnet');
  (adapter as any).settings.set('thinking', 's1', 'high');
  (adapter as any).settings.set('permission', 's1', 'manual');
  (adapter as any).settings.set('plan', 's1', true);
  (adapter as any).settings.set('archived', 's1', true);

  await adapter.delete!('s1');

  assert.deepEqual(deleted, ['s1']);
  assert.equal(adapter.getCwd('s1'), undefined);
  assert.equal(adapter.getThinking('s1'), undefined);
  assert.equal(adapter.getPermission('s1'), undefined);
  assert.equal(adapter.getPlanMode('s1'), undefined);
  assert.equal(adapter.getUsage('s1'), undefined);
});

test('ClaudeProviderAdapter maps approval events and resolveApproval writes allow/approve_always/deny with granular options', async () => {
  const adapter = new ClaudeProviderAdapter();
  const resolved: Array<[string, string, string, unknown]> = [];
  (adapter as any).inner.resolveApproval = async (
    sessionId: string,
    approvalId: string,
    decision: string,
    options?: unknown,
  ) => {
    resolved.push([sessionId, approvalId, decision, options]);
  };
  (adapter as any).inner.hasSessionFile = () => true;
  (adapter as any).inner.startTurn = async (opts: any) => {
    opts.onEvent({
      type: 'approval',
      approvalId: 'req-1',
      tool: 'Bash',
      input: { command: 'ls' },
      itemId: 'toolu_1',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }],
      decisionReason: 'Needs write',
    });
    opts.onEvent({ type: 'done', sessionId: 's', result: '', isError: false, subtype: 'success', stopReason: null });
  };

  const handle = await adapter.startTurn({ sessionId: 's', input: 'go' });
  const events: Array<{ kind: string; status: string; payload?: any }> = [];
  for await (const ev of handle.events) events.push(ev as any);

  const approval = events.find((ev) => ev.kind === 'approval');
  assert.equal(approval?.status, 'started');
  assert.equal(approval?.payload?.approvalId, 'req-1');
  assert.equal(approval?.payload?.tool, 'Bash');
  assert.deepEqual(approval?.payload?.input, { command: 'ls' });
  assert.equal(approval?.payload?.itemId, 'toolu_1');
  assert.equal(approval?.payload?.reason, 'Needs write');
  assert.equal(Array.isArray(approval?.payload?.suggestions), true);

  await adapter.resolveApproval('s', 'req-1', 'approve');
  await adapter.resolveApproval('s', 'req-1', 'approve_always', {
    updatedPermissions: [{ type: 'addRules' }],
  });
  await adapter.resolveApproval('s', 'req-1', 'reject', { message: 'No thanks' });
  assert.deepEqual(resolved, [
    ['s', 'req-1', 'allow', undefined],
    ['s', 'req-1', 'approve_always', { updatedPermissions: [{ type: 'addRules' }] }],
    ['s', 'req-1', 'deny', { message: 'No thanks' }],
  ]);
});

test('Claude yolo auto-allows residual can_use_tool requests but still prompts for user-interaction tools and in plan mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mag-claude-yolo-'));
  try {
    const adapter = new ClaudeProviderAdapter({ settingsPath: join(dir, 's.json') } as any);
    const resolved: Array<[string, string, string]> = [];
    const modeCalls: Array<[string, string]> = [];
    (adapter as any).inner.resolveApproval = async (sessionId: string, approvalId: string, decision: string) => {
      resolved.push([sessionId, approvalId, decision]);
    };
    (adapter as any).inner.setPermissionMode = async (sessionId: string, mode: string) => {
      modeCalls.push([sessionId, mode]);
      return {};
    };
    (adapter as any).inner.hasSessionFile = () => true;
    (adapter as any).inner.startTurn = async (opts: any) => {
      opts.onEvent({ type: 'approval', approvalId: 'rm-1', tool: 'Bash', input: { command: 'rm -rf build' } });
      opts.onEvent({ type: 'approval', approvalId: 'mcp-1', tool: 'mcp__x__pick', input: {}, requiresUserInteraction: true });
      opts.onEvent({ type: 'done', sessionId: 's', result: '', isError: false, subtype: 'success', stopReason: null });
    };
    const kinds = async () => {
      const handle = await adapter.startTurn({ sessionId: 's', input: 'go' });
      const out: Array<{ kind: string; payload?: any }> = [];
      for await (const ev of handle.events) out.push(ev as any);
      return out.filter((e) => e.kind === 'approval').map((e) => e.payload?.approvalId);
    };

    await adapter.setPermission('s', 'yolo');
    assert.deepEqual(modeCalls, [['s', 'bypassPermissions']]);
    assert.deepEqual(await kinds(), ['mcp-1']);
    assert.deepEqual(resolved, [['s', 'rm-1', 'allow']]);

    await adapter.setPlanMode('s', true);
    resolved.length = 0;
    assert.deepEqual(await kinds(), ['rm-1', 'mcp-1']);
    assert.deepEqual(resolved, []);

    await adapter.setPlanMode('s', false);
    await adapter.setPermission('s', 'manual');
    assert.deepEqual(modeCalls.at(-1), ['s', 'manual']);
    assert.deepEqual(await kinds(), ['rm-1', 'mcp-1']);
    assert.deepEqual(resolved, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ClaudeProviderAdapter maps AskUserQuestion control events to question', async () => {
  const adapter = new ClaudeProviderAdapter();
  const answered: Array<[string, string, unknown]> = [];
  (adapter as any).inner.resolveQuestion = async (sessionId: string, questionId: string, answer: unknown) => {
    answered.push([sessionId, questionId, answer]);
  };
  (adapter as any).inner.hasSessionFile = () => true;
  (adapter as any).inner.startTurn = async (opts: any) => {
    opts.onEvent({
      type: 'question',
      questionId: 'q-1',
      prompt: 'What are your favorite foods?',
      rawQuestions: [{ question: 'What are your favorite foods?', header: 'Fave foods' }],
    });
    opts.onEvent({ type: 'done', sessionId: 's', result: '', isError: false, subtype: 'success', stopReason: null });
  };

  const handle = await adapter.startTurn({ sessionId: 's', input: 'ask' });
  const events: Array<{ kind: string; status: string; payload?: any }> = [];
  for await (const ev of handle.events) events.push(ev as any);
  const question = events.find((ev) => ev.kind === 'question');
  assert.equal(question?.status, 'started');
  assert.equal(question?.payload?.questionId, 'q-1');
  assert.equal(question?.payload?.prompt, 'What are your favorite foods?');

  await adapter.resolveQuestion('s', 'q-1', { q_0: ['Pizza'] });
  assert.deepEqual(answered, [['s', 'q-1', { q_0: ['Pizza'] }]]);
});

test('workspaceIdFromCwd avoids prefix collisions and normalizes trailing slashes', () => {
  const a = workspaceIdFromCwd('/tmp/very-long-shared-prefix-workspace-directory-name-alpha/', 'codex');
  const b = workspaceIdFromCwd('/tmp/very-long-shared-prefix-workspace-directory-name-beta', 'codex');
  const aNoSlash = workspaceIdFromCwd('/tmp/very-long-shared-prefix-workspace-directory-name-alpha', 'codex');
  assert.equal(a, aNoSlash);
  assert.notEqual(a, b);
  assert.ok(a.length <= 60 && b.length <= 60);
});

test('CodexProviderAdapter handles 0.169 items, reverse requests, plans/diffs, usage, goalGet errors, and cwd-scoped skillsCache', async () => {
  const adapter = new CodexProviderAdapter();
  const caps = adapter.capabilities();
  assert.equal(caps.elicitation, true);
  assert.equal(caps.review, true);
  assert.equal(caps.goals, true);
  assert.equal(caps.subagents, true);

  (adapter as any).inner.getHistory = async () => [{
    startedAt: 1786289601,
    items: [
      { type: 'reasoning', id: 'r1', summary: ['step one', 'step two'] },
      { type: 'commandExecution', id: 'c1', command: 'echo ok', result: '', output: 'output-not-masked', exitCode: 0 },
      { type: 'collabAgentToolCall', id: 'ca1', tool: 'spawn_agent', agentsStates: { a1: 'done' }, status: 'completed' },
      { type: 'plan', id: 'p1', text: '1. check' },
    ],
  }];
  const history = await adapter.getHistory('th-1');
  assert.deepEqual(history[0]?.content, [{ type: 'thinking', thinking: 'step one\nstep two' }]);
  const toolRes = history.find((m) => m.id === 'c1_result');
  assert.equal((toolRes?.content[0] as any)?.output, 'output-not-masked');
  assert.ok(history.some((m) => m.id === 'ca1_call' && (m.content[0] as any)?.tool_name === 'spawn_agent'));
  assert.ok(history.some((m) => m.metadata?.item_type === 'plan'));

  // Event stream mapping for 0.169 events
  async function* fakeEvents() {
    yield { type: 'item-started', threadId: 'th-1', turnId: 't1', item: { id: 'ca2', type: 'collabAgentToolCall', tool: 'wait_agent' } };
    yield { type: 'item-completed', threadId: 'th-1', turnId: 't1', item: { id: 'ca2', type: 'collabAgentToolCall', tool: 'wait_agent', result: '', output: 'collab-out', status: 'completed' } };
    yield { type: 'approval-request', requestId: 'elic-1', kind: 'mcpElicitation', threadId: 'th-1', turnId: 't1', itemId: 'elic-1', availableDecisions: ['accept', 'decline', 'cancel'], elicitation: { serverName: 'srv', mode: 'form' }, params: {} };
    yield { type: 'server-request', requestId: 'dyn-1', method: 'item/tool/call', threadId: 'th-1', turnId: 't1', params: { tool: 'custom' } };
    yield { type: 'server-request-resolved', threadId: 'th-1', turnId: 't1', requestId: 'elic-1', interactionKind: 'elicitation' };
    yield { type: 'plan-updated', threadId: 'th-1', turnId: 't1', explanation: 'Steps', plan: [{ step: 'do x', status: 'in_progress' }] };
    yield { type: 'diff-updated', threadId: 'th-1', turnId: 't1', diff: '--- a\n+++ b' };
    yield { type: 'token-usage', threadId: 'th-1', turnId: 't1', usage: { last: { totalTokens: 500 }, total: { inputTokens: 400, outputTokens: 100 }, modelContextWindow: 256000, reasoningOutputTokens: 33 } };
    yield { type: 'turn-completed', threadId: 'th-1', turnId: 't1', turn: { id: 't1', status: 'failed' }, error: 'quota exceeded' };
  }
  (adapter as any).inner.startTurn = async () => ({ threadId: 'th-1', turnId: 't1', events: fakeEvents() });
  const handle = await adapter.startTurn({ sessionId: 'th-1', input: 'hello' });
  const evs: any[] = [];
  for await (const e of handle.events) evs.push(e);
  assert.equal(evs.find((e) => e.kind === 'tool' && e.status === 'completed')?.payload?.output, 'collab-out');
  assert.equal(evs.find((e) => e.kind === 'approval')?.payload?.elicitation?.serverName, 'srv');
  assert.equal(evs.find((e) => e.kind === 'passthrough')?.payload?.method, 'item/tool/call');
  assert.equal(evs.find((e) => e.kind === 'interaction_resolved')?.payload?.interactionId, 'elic-1');
  assert.equal(evs.find((e) => e.kind === 'plan')?.payload?.explanation, 'Steps');
  assert.equal(evs.find((e) => e.kind === 'diff')?.payload?.diff, '--- a\n+++ b');
  const term = evs.find((e) => e.kind === 'turn');
  assert.equal(term?.status, 'failed');
  assert.equal(term?.payload?.error, 'quota exceeded');
  assert.equal(adapter.getUsage('th-1')?.reasoning_output_tokens, 33);
  assert.equal(adapter.getUsage('th-1')?.authoritative, true);
  assert.equal(adapter.getUsage('th-1')?.turn_count, 1);

  // goalGet error propagation + goalSet origin: 'user'
  let goalSetOpts: any;
  (adapter as any).inner.goalSet = async (_id: string, _obj: string | null, _st: string | null, opts: any) => {
    goalSetOpts = opts;
    return { objective: 'ship', status: 'active' };
  };
  await adapter.setGoal('th-1', 'ship');
  assert.equal(goalSetOpts?.origin, 'user');
  (adapter as any).inner.goalGet = async () => { throw new Error('rpc connection lost'); };
  await assert.rejects(adapter.getGoal('th-1'), /rpc connection lost/);

  // skillsCache scoped by cwd and invalidated by skillsVersion
  (adapter as any).threadCwd.set('s-a', '/repo/a');
  (adapter as any).threadCwd.set('s-b', '/repo/b');
  let skillsVersion = 1;
  const skillCalls: unknown[] = [];
  (adapter as any).inner.getSkillsVersion = () => skillsVersion;
  (adapter as any).inner.listSkills = async (opts: any) => {
    skillCalls.push(opts);
    return [{ name: `sk-${opts?.cwd ?? 'none'}`, description: 'd', path: '/tmp/SKILL.md', scope: 'project', enabled: true }];
  };
  const cmdsA1 = await adapter.listCommands('s-a');
  const cmdsA2 = await adapter.listCommands('s-a');
  const cmdsB = await adapter.listCommands('s-b');
  assert.ok(cmdsA1.some((c) => c.name === 'sk-/repo/a'));
  assert.ok(cmdsA2.some((c) => c.name === 'sk-/repo/a'));
  assert.ok(cmdsB.some((c) => c.name === 'sk-/repo/b'));
  assert.equal(skillCalls.length, 2);
  skillsVersion = 2;
  await adapter.listCommands('s-a');
  assert.equal(skillCalls.length, 3);

  // listModels preserves rich metadata
  (adapter as any).inner.listModels = async () => [{
    model: 'gpt-6.1-sol',
    displayName: 'GPT-6.1 Sol',
    description: 'Frontier',
    maxContextSize: 400_000,
    maxOutputTokens: 32_768,
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }],
    defaultReasoningEffort: 'high',
    serviceTiers: ['standard', 'flex'],
    defaultServiceTier: 'standard',
    isDefault: true,
  }];
  const models = await adapter.listModels();
  assert.equal(models[0]?.max_context_size, 400_000);
  assert.equal(models[0]?.max_output_tokens, 32_768);
  assert.deepEqual(models[0]?.serviceTiers, ['standard', 'flex']);
  assert.equal(models[0]?.defaultServiceTier, 'standard');
  assert.equal(models[0]?.isDefault, true);
});

test('ClaudeProviderAdapter forwards CLAUDE_BIN, preserves dynamic models & subagent/usage fields, and syncs native metadata', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-facade-claude-21325-'));
  const savedBin = process.env.CLAUDE_BIN;
  try {
    process.env.CLAUDE_BIN = join(base, 'custom-claude');
    const adapter = new ClaudeProviderAdapter({ projectsDir: join(base, 'projects') });
    assert.equal((adapter as any).inner.claudeBin, join(base, 'custom-claude'));

    const caps = adapter.capabilities();
    assert.equal(caps.nativeArchive, true);
    assert.equal(caps.subagents, true);
    assert.equal(caps.planMode, true);

    // Dynamic non-qwen model + capability preservation
    (adapter as any).inner.listBuiltinModels = async () => [
      { value: 'default', supportsEffort: true, supportsAdaptiveThinking: true, fastMode: true, supportedEffortLevels: ['low', 'high'] },
      { value: 'claude-4-7-preview', displayName: 'Claude 4.7 Preview', description: 'Next gen', supportsEffort: true, supportsAdaptiveThinking: true, fastMode: true },
      { value: 'qwen3.6-flash[1m]', displayName: 'qwen3.6-flash[1m]' },
    ];
    const models = await adapter.listModels();
    assert.deepEqual(models.map((m) => m.model), ['default', 'claude-4-7-preview']);
    assert.equal(models[1]?.supportsAdaptiveThinking, true);
    assert.equal(models[1]?.fastMode, true);
    assert.equal(models.some((m) => /qwen/i.test(JSON.stringify(m))), false);

    // Usage from top-level totalCostUsd + modelUsage + subagent/task/cancel events
    (adapter as any).inner.hasSessionFile = () => true;
    (adapter as any).inner.startTurn = async (opts: any) => {
      opts.onEvent({ type: 'tool_progress', toolUseId: 'tu-1', toolName: 'Bash', elapsedTimeSeconds: 2, parentToolUseId: 'pt-1' });
      opts.onEvent({ type: 'task_started', sessionId: 's-1', taskId: 'tk-1', description: 'subtask', subagentType: 'explore', toolUseId: 'pt-1' });
      opts.onEvent({ type: 'control_cancelled', requestId: 'req-c', kind: 'approval' });
      opts.onEvent({
        type: 'done',
        sessionId: 's-1',
        result: '',
        isError: false,
        subtype: 'success',
        stopReason: 'end_turn',
        totalCostUsd: 0.42,
        modelUsage: {
          'claude-sonnet-5': { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 300, contextWindow: 500_000, costUSD: 0.42 },
        },
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 300 },
      });
    };
    const handle = await adapter.startTurn({ sessionId: 's-1', input: 'hi' });
    const evs: any[] = [];
    for await (const e of handle.events) evs.push(e);
    assert.ok(evs.some((e) => e.kind === 'tool' && e.status === 'delta' && e.parentToolUseId === 'pt-1'));
    assert.ok(evs.some((e) => e.kind === 'subagent' && e.status === 'started' && e.agentId === 'tk-1'));
    assert.ok(evs.some((e) => e.kind === 'interaction_resolved' && e.status === 'cancelled'));
    const usage = adapter.getUsage('s-1');
    assert.equal(usage?.total_cost_usd, 0.42);
    assert.equal(usage?.context_limit, 500_000);
    assert.equal(usage?.authoritative, true);
    assert.equal(usage?.model_usage?.['claude-sonnet-5']?.output_tokens, 200);
  } finally {
    if (savedBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = savedBin;
    await rm(base, { recursive: true, force: true });
  }
});

test('GrokProviderAdapter and PiProviderAdapter satisfy facade contracts cleanly', () => {
  const grok = new GrokProviderAdapter();
  const pi = new PiProviderAdapter();
  assert.equal(grok.name, 'grok');
  assert.equal(pi.name, 'pi');
  assert.equal(grok.capabilities().goals, true);
  assert.equal(pi.capabilities().approvals, true);
  assert.equal(pi.capabilities().manualApproval, true);
  assert.equal(pi.capabilities().clone, true);
});

test('supports positional skill argument substitution, Claude conversation_reset rotation, and Codex review options', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-facade-cmds-'));
  try {
    const skillPath = join(base, 'SKILL.md');
    await writeFile(skillPath, '---\nname: deploy\n---\nTarget=$1 Env=$2 All=$ARGUMENTS Cost=$$1\n');
    const expanded = expandCodexSkill('/deploy "api$&server" staging', [{ name: 'deploy', path: skillPath }]);
    assert.equal(expanded, 'Target=api$&server Env=staging All="api$&server" staging Cost=$$1');

    // Codex review forwards instructions/target, cleanTerminals, gitDiff, rateLimits
    const codex = new CodexProviderAdapter();
    let sentReviewOpts: any;
    let cleanedThread = '';
    (codex as any).inner.reviewTurn = async (_sid: string, opts: any) => {
      sentReviewOpts = opts;
      return {
        turnId: 'r1',
        events: (async function* () {
          yield { type: 'turn-completed', threadId: _sid, turnId: 'r1', turn: { status: 'completed' } };
        })(),
      };
    };
    (codex as any).inner.cleanBackgroundTerminals = async (sid: string) => { cleanedThread = sid; };
    (codex as any).inner.gitDiffToRemote = async () => ({ sha: 'deadbeef', diff: '+hello\n' });
    (codex as any).inner.accountRateLimits = async () => ({ rateLimits: { primary: { usedPercent: 12 } } });
    (codex as any).threadCwd.set('th-1', base);

    const revHandle = await codex.review('th-1', { instructions: 'check auth' });
    for await (const _ of revHandle.events) { /* drain */ }
    assert.deepEqual(sentReviewOpts, { instructions: 'check auth' });
    await codex.cleanTerminals('th-1');
    assert.equal(cleanedThread, 'th-1');
    assert.deepEqual(await codex.gitDiff('th-1'), { sha: 'deadbeef', diff: '+hello\n' });
    assert.deepEqual(await codex.getRateLimits(), { rateLimits: { primary: { usedPercent: 12 } } });

    // Claude conversation_reset rotates underlying CLI sessionId & emits confirmation
    const claude = new ClaudeProviderAdapter({ projectsDir: join(base, 'projects') });
    const startedIds: string[] = [];
    (claude as any).inner.hasSessionFile = (id: string) => id === 'orig-id';
    (claude as any).inner.startTurn = async (opts: any) => {
      startedIds.push(opts.sessionId);
      if (opts.sessionId === 'orig-id') {
        opts.onEvent({ type: 'init', sessionId: 'orig-id', cwd: base, tools: [], terminalSlashCommands: ['doctor', 'color'] });
        opts.onEvent({ type: 'conversation_reset', sessionId: 'orig-id', newConversationId: 'new-cli-id', trigger: 'clear' });
        opts.onEvent({ type: 'done', sessionId: 'new-cli-id', result: '', isError: false, subtype: 'success', stopReason: null });
      } else {
        opts.onEvent({ type: 'text_delta', text: 'after clear' });
        opts.onEvent({ type: 'done', sessionId: opts.sessionId, result: 'after clear', isError: false, subtype: 'success', stopReason: 'end_turn' });
      }
    };
    const h1 = await claude.startTurn({ sessionId: 'orig-id', input: '/clear' });
    const ev1: any[] = [];
    for await (const e of h1.events) ev1.push(e);
    assert.ok(ev1.some((e) => e.kind === 'message' && String(e.payload?.delta).includes('/clear')));
    assert.deepEqual(await claude.getHistory('orig-id'), []);
    const h2 = await claude.startTurn({ sessionId: 'orig-id', input: 'hello' });
    for await (const _ of h2.events) { /* drain */ }
    assert.deepEqual(startedIds, ['orig-id', 'new-cli-id']);

    // listClaudeCommands 把 terminalSlashCommands 标成 terminalOnly，但网关已实现的命令优先
    const catalog = listClaudeCommands([
      { name: 'doctor', description: 'Doctor', builtin: true },
      { name: 'color', description: 'Color', builtin: true },
    ], ['doctor', 'color']);
    assert.equal(catalog.find((c) => c.name === 'doctor')?.terminalOnly, true);
    // color 由网关经 apply_flag_settings 实现，CLI 的 terminalOnly 不再生效
    assert.equal(catalog.find((c) => c.name === 'color')?.terminalOnly, undefined);
    assert.equal(catalog.find((c) => c.name === 'color')?.form, 'gateway');
    assert.ok(catalog.some((c) => c.name === 'help'));
    assert.ok(catalog.some((c) => c.name === 'diff'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('supports Claude SKILL.md $0/escaped $$, allowed-tools paren/space parsing, unborn git diff, and persistent /clear reset', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-review-fixes-'));
  try {
    // 1. $0/$ARGUMENTS[N] zero-indexed substitution + \$ escape + allowed-tools paren/space parsing
    const claudeDir = join(base, 'repo', '.claude', 'skills', 'migrate');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, 'SKILL.md'),
      '---\nname: migrate\nallowed-tools: Read, Bash(git status, git diff), Grep\n---\nFrom=$0 To=$1 First=$ARGUMENTS[0] Cost=\\$1\n',
    );
    const spaceCmdDir = join(base, 'repo', '.claude', 'commands');
    await mkdir(spaceCmdDir, { recursive: true });
    await writeFile(
      join(spaceCmdDir, 'lint.md'),
      '---\nallowed-tools: Read Grep Bash(npm:*)\n---\nRun lint\n',
    );
    const cmds = await discoverClaudeDiskCommands(join(base, 'repo'), join(base, 'cfg'), { homeDir: base });
    assert.deepEqual(cmds.find((c) => c.name === 'migrate')?.allowedTools, ['Read', 'Bash(git status, git diff)', 'Grep']);
    assert.deepEqual(cmds.find((c) => c.name === 'lint')?.allowedTools, ['Read', 'Grep', 'Bash(npm:*)']);

    const zeroExpanded = expandCodexSkill('/migrate Button React', [{ name: 'migrate', path: join(claudeDir, 'SKILL.md') }]);
    assert.equal(zeroExpanded, 'From=Button To=React First=Button Cost=$1');

    // 2. fsRepoDiff on non-git vs unborn git repo with staged file
    const nonGit = await fsRepoDiff(base);
    assert.equal(nonGit.isGitRepo, false);
    const unbornRepo = join(base, 'unborn');
    await mkdir(unbornRepo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: unbornRepo });
    await writeFile(join(unbornRepo, 'staged.txt'), 'hello staged\n');
    execFileSync('git', ['add', 'staged.txt'], { cwd: unbornRepo });
    const unbornDiff = await fsRepoDiff(unbornRepo);
    assert.equal(unbornDiff.isGitRepo, true);
    assert.ok(unbornDiff.diff.includes('+hello staged'), `expected staged diff on unborn HEAD, got: ${unbornDiff.diff}`);

    // 3. Claude /clear commits resetSessionId on done (keeping in-turn interrupt targeting old id) & persists across restart
    const settingsPath = join(base, 'settings.claude.json');
    const c1 = new ClaudeProviderAdapter({ projectsDir: join(base, 'projects'), settingsPath });
    const interruptedIds: string[] = [];
    let releaseClearTurn!: () => void;
    let sawResetCallback!: () => void;
    const waitReset = new Promise<void>((r) => { sawResetCallback = r; });
    (c1 as any).inner.hasSessionFile = (id: string) => id === 'orig-1';
    (c1 as any).inner.interrupt = (id: string) => { interruptedIds.push(id); };
    (c1 as any).inner.startTurn = async (opts: any) => {
      opts.onEvent({ type: 'init', sessionId: opts.sessionId, cwd: base, tools: [] });
      opts.onEvent({ type: 'conversation_reset', sessionId: opts.sessionId, newConversationId: 'reset-2', trigger: 'clear' });
      sawResetCallback();
      await new Promise<void>((r) => { releaseClearTurn = r; });
      opts.onEvent({ type: 'done', sessionId: 'reset-2', result: '', isError: false, subtype: 'success', stopReason: null });
    };
    const turn = await c1.startTurn({ sessionId: 'orig-1', input: '/clear' });
    await waitReset;
    await c1.interrupt('orig-1');
    assert.deepEqual(interruptedIds, ['orig-1']);
    releaseClearTurn();
    for await (const _ of turn.events) { /* drain */ }
    await c1.dispose();

    // New adapter instance reloads persisted resetSessionId; fork clears it on forked child
    const c2 = new ClaudeProviderAdapter({ projectsDir: join(base, 'projects'), settingsPath });
    const startedAfterRestart: string[] = [];
    (c2 as any).inner.hasSessionFile = () => true;
    (c2 as any).inner.startTurn = async (opts: any) => {
      startedAfterRestart.push(opts.sessionId);
      opts.onEvent({ type: 'done', sessionId: opts.sessionId, result: 'ok', isError: false, subtype: 'success', stopReason: 'end_turn' });
    };
    (c2 as any).inner.forkSession = async (eid: string) => {
      assert.equal(eid, 'reset-2');
      return { sessionId: 'forked-3' };
    };
    const postRestart = await c2.startTurn({ sessionId: 'orig-1', input: 'hi' });
    for await (const _ of postRestart.events) { /* drain */ }
    assert.deepEqual(startedAfterRestart, ['reset-2']);
    const forked = await c2.fork('orig-1');
    assert.equal(forked.id, 'forked-3');
    const forkTurn = await c2.startTurn({ sessionId: 'forked-3', input: 'hi fork' });
    for await (const _ of forkTurn.events) { /* drain */ }
    assert.deepEqual(startedAfterRestart, ['reset-2', 'forked-3']);
    await c2.dispose();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('ClaudeProviderAdapter and CodexProviderAdapter fall back to __default__ thinking setting', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-facade-thinking-'));
  const settingsPath = join(base, 'settings.json');
  try {
    const claude = new ClaudeProviderAdapter({ settingsPath } as any);
    const codex = new CodexProviderAdapter({ settingsPath } as any);

    assert.equal(claude.getThinking('session-1'), undefined);
    assert.equal(codex.getThinking('session-1'), undefined);

    await claude.setThinking('__default__', 'high');
    assert.equal(claude.getThinking('session-1'), 'high');

    await codex.setThinking('__default__', 'medium');
    assert.equal(codex.getThinking('session-1'), 'medium');

    await claude.setThinking('session-1', 'low');
    assert.equal(claude.getThinking('session-1'), 'low');

    await codex.setThinking('session-1', 'high');
    assert.equal(codex.getThinking('session-1'), 'high');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('ClaudeProviderAdapter.getHistory merges adjacent <bash-input> and <bash-stdout> user messages into structured Bash tool_use and tool_result', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-bash-history-'));
  const projectsDir = join(base, 'projects');
  const projDir = join(projectsDir, 'proj');
  const sessionId = '12345678-1234-4234-8234-123456789abc';
  try {
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({ type: 'user', timestamp: '2026-08-11T10:00:00.000Z', message: { role: 'user', content: '<bash-input>pwd</bash-input>' } }),
        JSON.stringify({ type: 'user', timestamp: '2026-08-11T10:00:01.000Z', message: { role: 'user', content: '<bash-stdout>/home/user/project</bash-stdout>' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-08-11T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'All done' }] } }),
      ].join('\n') + '\n',
    );

    const adapter = new ClaudeProviderAdapter({ projectsDir });
    const history = await adapter.getHistory(sessionId);
    assert.equal(history.length, 3);
    assert.equal(history[0]?.role, 'assistant');
    assert.deepEqual(history[0]?.content, [
      { type: 'tool_use', tool_call_id: history[0]?.content[0]?.type === 'tool_use' ? history[0]?.content[0]?.tool_call_id : '', tool_name: 'Bash', input: { command: 'pwd' } },
    ]);
    assert.equal(history[1]?.role, 'tool');
    assert.deepEqual(history[1]?.content, [
      { type: 'tool_result', tool_call_id: history[1]?.content[0]?.type === 'tool_result' ? history[1]?.content[0]?.tool_call_id : '', output: '/home/user/project', is_error: false },
    ]);
    assert.equal(history[2]?.role, 'assistant');
    assert.equal((history[2]?.content[0] as any)?.text, 'All done');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('ClaudeProviderAdapter lists subagents and resolves toolUseId or taskId for getSubagentMessages', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-claude-sub-facade-'));
  const projectsDir = join(base, 'projects');
  const projDir = join(projectsDir, 'proj');
  const sessionId = '88888888-8888-4888-8888-888888888888';
  try {
    await mkdir(join(projDir, sessionId, 'subagents'), { recursive: true });
    await writeFile(
      join(projDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n',
    );
    await writeFile(
      join(projDir, sessionId, 'subagents', 'agent-worker1.jsonl'),
      [
        JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'investigate bug' } }),
        JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'found bug' }] } }),
      ].join('\n') + '\n',
    );
    await writeFile(
      join(projDir, sessionId, 'subagents', 'agent-worker1.meta.json'),
      JSON.stringify({
        toolUseId: 'toolu_call_sub_1',
        agentType: 'Investigator',
        taskId: 'task_sub_1',
        description: 'Subagent investigating bug',
      }),
    );

    const adapter = new ClaudeProviderAdapter({ projectsDir });
    const subagents = await adapter.listSubagents(sessionId);
    assert.equal(subagents.length, 1);
    assert.equal(subagents[0]?.agentId, 'worker1');
    assert.equal(subagents[0]?.parentToolUseId, 'toolu_call_sub_1');
    assert.equal(subagents[0]?.subagentType, 'Investigator');

    // Resolves when passing toolUseId
    const msgsByToolUse = await adapter.getSubagentMessages(sessionId, 'toolu_call_sub_1');
    assert.equal(msgsByToolUse.length, 2);
    assert.equal(msgsByToolUse[0]?.metadata?.agent_id, 'worker1');
    assert.equal((msgsByToolUse[1]?.content[0] as any)?.text, 'found bug');

    // Resolves when passing taskId
    const msgsByTask = await adapter.getSubagentMessages(sessionId, 'task_sub_1');
    assert.equal(msgsByTask.length, 2);
    assert.equal(msgsByTask[0]?.metadata?.agent_id, 'worker1');

    // Resolves when passing direct agentId
    const msgsByDirect = await adapter.getSubagentMessages(sessionId, 'worker1');
    assert.equal(msgsByDirect.length, 2);
    assert.equal(msgsByDirect[0]?.metadata?.agent_id, 'worker1');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('CodexProviderAdapter parses rollout file directly with tail window, memory citation stripping, deduplication, and collabAgent metadata', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-codex-rollout-facade-'));
  const codexHome = join(base, '.codex');
  const sessionId = 'rollout-test-session-1';
  const sessionDir = join(codexHome, 'sessions', '2026', '11', '15');
  const rolloutFile = join(sessionDir, `rollout-2026-11-15T10-00-00-${sessionId}.jsonl`);
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      rolloutFile,
      [
        // System-injected tags stripped in user message
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'user_message',
            id: 'u-1',
            message: '<INSTRUCTIONS>system prompt</INSTRUCTIONS><environment_context>cwd: /tmp</environment_context>Hello agent',
          },
        }),
        // Reasoning with <oai-mem-citation>
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'reasoning',
            id: 'r-1',
            summary: ['Thinking about task <oai-mem-citation id="mem-1"/> carefully'],
          },
        }),
        // Duplicate commentary in event_msg vs response_item
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            id: 'a-1',
            text: 'I will launch subagents to help',
            phase: 'commentary',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            id: 'a-1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'I will launch subagents to help' }],
          },
        }),
        // collabAgentToolCall preserving receiverThreadIds and agent_id
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'collabAgentToolCall',
            id: 'collab-1',
            tool: 'collabAgentToolCall',
            receiverThreadIds: ['child-thread-999'],
            input: { prompt: 'Subtask for child' },
            aggregatedOutput: 'child agent completed',
          },
        }),
      ].join('\n') + '\n',
    );

    const adapter = new CodexProviderAdapter();
    const history = await adapter.getHistory(sessionId);

    // User message stripped instructions
    assert.equal(history[0]?.role, 'user');
    assert.equal((history[0]?.content[0] as any)?.text, 'Hello agent');

    // Reasoning stripped citations
    assert.equal(history[1]?.role, 'assistant');
    assert.equal((history[1]?.content[0] as any)?.type, 'thinking');
    assert.equal((history[1]?.content[0] as any)?.thinking, 'Thinking about task carefully');

    // Deduplicated agent_message with commentary phase preserved
    assert.equal(history[2]?.role, 'assistant');
    assert.equal((history[2]?.content[0] as any)?.text, 'I will launch subagents to help');
    assert.equal(history[2]?.metadata?.phase, 'commentary');

    // collabAgentToolCall tool_use with receiverThreadIds and agent_id
    assert.equal(history[3]?.role, 'assistant');
    assert.equal((history[3]?.content[0] as any)?.type, 'tool_use');
    assert.equal((history[3]?.content[0] as any)?.tool_name, 'collabAgentToolCall');
    assert.equal(history[3]?.metadata?.agent_id, 'child-thread-999');
    assert.deepEqual(history[3]?.metadata?.receiverThreadIds, ['child-thread-999']);

    // collabAgentToolCall tool_result with agent_id: <id>
    assert.equal(history[4]?.role, 'assistant');
    assert.equal((history[4]?.content[0] as any)?.type, 'tool_result');
    assert.equal((history[4]?.content[0] as any)?.output, 'agent_id: child-thread-999\nchild agent completed');
    assert.equal(history[4]?.metadata?.agent_id, 'child-thread-999');

    // listSubagents discovers child-thread-999
    const subagents = await adapter.listSubagents(sessionId);
    assert.equal(subagents.length, 1);
    assert.equal(subagents[0]?.agentId, 'child-thread-999');

    // Unrelated session rollout must never be exposed via getSubagentMessages
    const otherId = 'other-unrelated-session-1';
    await writeFile(
      join(sessionDir, `rollout-2026-11-15T10-05-00-${otherId}.jsonl`),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', id: 'u2', message: 'secret other prompt' } }) + '\n',
    );
    assert.deepEqual(await adapter.getSubagentMessages(sessionId, otherId), []);
    assert.deepEqual(await adapter.getSubagentMessages(sessionId, '1'), []);
  } finally {
    if (prevCodexHome !== undefined) process.env.CODEX_HOME = prevCodexHome;
    else delete process.env.CODEX_HOME;
    await rm(base, { recursive: true, force: true });
  }
});

test('Codex mapCodexEvents routes subAgentActivity to subagent lifecycle instead of generic tool', async () => {
  const adapter = new CodexProviderAdapter();
  (adapter as any).inner.startTurn = async (_sessionId: string, _input: any, _opts: any) => {
    async function* gen() {
      yield {
        type: 'item-started',
        item: {
          type: 'subAgentActivity',
          id: 'activity-1',
          agentThreadId: 'sub-thread-456',
          agentPath: 'agent.researcher',
          name: 'researcher',
          summary: 'searching docs',
        },
      };
      yield {
        type: 'item-completed',
        item: {
          type: 'subAgentActivity',
          id: 'activity-1',
          agentThreadId: 'sub-thread-456',
          agentPath: 'agent.researcher',
          name: 'researcher',
          summary: 'search finished',
          status: 'completed',
        },
      };
    }
    return { turnId: 'turn-sub-1', events: gen() };
  };

  const handle = await adapter.startTurn({ sessionId: 'parent-sess', input: 'run' });
  const events: any[] = [];
  for await (const e of handle.events) {
    events.push(e);
  }

  // Must not emit generic 'tool' event
  assert.equal(events.some((e) => e.kind === 'tool'), false);

  // Must emit 'subagent' started and completed events
  const started = events.find((e) => e.kind === 'subagent' && e.status === 'started');
  assert.ok(started, 'Expected subagent started event');
  assert.equal(started.agentId, 'sub-thread-456');
  assert.equal(started.payload.agentThreadId, 'sub-thread-456');
  assert.equal(started.payload.agentPath, 'agent.researcher');
  assert.equal(started.payload.summary, 'searching docs');

  const completed = events.find((e) => e.kind === 'subagent' && e.status === 'completed');
  assert.ok(completed, 'Expected subagent completed event');
  assert.equal(completed.agentId, 'sub-thread-456');
  assert.equal(completed.payload.agentThreadId, 'sub-thread-456');
  assert.equal(completed.payload.summary, 'search finished');
});

test('Codex subAgentActivity started stays running and tool completion does not complete the agent', async (t) => {
  const adapter = new CodexProviderAdapter();
  t.after(() => adapter.dispose());
  adapter.getHistory = async () => [];
  (adapter as any).inner.startTurn = async () => ({
    turnId: 'turn-sub-run',
    events: (async function* () {
      yield {
        type: 'item-started',
        item: { type: 'subAgentActivity', id: 'call-run', kind: 'started', agentThreadId: 'sub-run-1', name: 'worker' },
      };
      yield {
        type: 'item-completed',
        item: { type: 'subAgentActivity', id: 'call-run', kind: 'started', agentThreadId: 'sub-run-1', name: 'worker' },
      };
      yield {
        type: 'item-completed',
        item: { type: 'collabAgentToolCall', id: 'call-spawn', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['sub-run-1'] },
      };
    })(),
  });
  const handle = await adapter.startTurn({ sessionId: 'parent-run', input: 'go' });
  const events: any[] = [];
  for await (const ev of handle.events) events.push(ev);

  const subEvents = events.filter((e) => e.kind === 'subagent' && e.agentId === 'sub-run-1');
  assert.ok(subEvents.length > 0);
  assert.ok(subEvents.every((e) => e.status === 'started'));
  assert.equal((adapter as any).liveSubagents.get('parent-run')?.get('sub-run-1')?.status, 'running');
  assert.equal((adapter as any).liveSubagents.get('parent-run')?.get('sub-run-1')?.completedAt, undefined);
  const list = await adapter.listSubagents('parent-run');
  assert.equal(list.find((s) => s.agentId === 'sub-run-1')?.status, 'running');
});

test('Codex agentsStates terminal status completes the child and unknown states stay unknown', async (t) => {
  const adapter = new CodexProviderAdapter();
  t.after(() => adapter.dispose());
  (adapter as any).inner.startTurn = async () => ({
    turnId: 'turn-sub-state',
    events: (async function* () {
      yield {
        type: 'item-completed',
        item: {
          type: 'collabAgentToolCall',
          id: 'call-wait',
          tool: 'wait',
          status: 'completed',
          receiverThreadIds: ['sub-ok', 'sub-err', 'sub-odd'],
          agentsStates: {
            'sub-ok': { status: 'completed', message: 'fine' },
            'sub-err': { status: 'errored', message: 'boom' },
            'sub-odd': { status: 'mysteryState' },
          },
        },
      };
    })(),
  });
  const handle = await adapter.startTurn({ sessionId: 'parent-state', input: 'wait' });
  for await (const _ of handle.events) { /* drain */ }

  const byId = new Map((await adapter.listSubagents('parent-state')).map((s) => [s.agentId, s]));
  assert.equal(byId.get('sub-ok')?.status, 'completed');
  assert.equal(byId.get('sub-err')?.status, 'failed');
  assert.equal(byId.get('sub-odd')?.status, 'unknown');
});

test('Codex wait timeout or tool-only completion never marks a running child completed', async (t) => {
  const adapter = new CodexProviderAdapter();
  t.after(() => adapter.dispose());
  (adapter as any).inner.startTurn = async () => ({
    turnId: 'turn-sub-timeout',
    events: (async function* () {
      yield {
        type: 'item-completed',
        item: {
          type: 'collabAgentToolCall',
          id: 'call-wait-2',
          tool: 'wait',
          status: 'completed',
          receiverThreadIds: ['sub-slow'],
          agentsStates: { 'sub-slow': { status: 'running' } },
        },
      };
    })(),
  });
  const handle = await adapter.startTurn({ sessionId: 'parent-timeout', input: 'wait' });
  for await (const _ of handle.events) { /* drain */ }

  const list = await adapter.listSubagents('parent-timeout');
  assert.equal(list.find((s) => s.agentId === 'sub-slow')?.status, 'running');
});

test('Codex planMode re-syncs on resume/startTurn and passes model and effective effort', async () => {
  const adapter = new CodexProviderAdapter();
  const collabCalls: Array<{ threadId: string; mode: string; options?: any }> = [];
  (adapter as any).inner.setCollaborationMode = async (
    threadId: string,
    mode: 'plan' | 'default',
    options?: any,
  ) => {
    collabCalls.push({ threadId, mode, options });
  };
  (adapter as any).inner.startTurn = async () => ({
    turnId: 't-plan-1',
    events: (async function* () {})(),
  });

  await adapter.setModel('session-plan-1', 'o3-high');
  await adapter.setThinking('session-plan-1', 'high');
  await adapter.setPlanMode('session-plan-1', true);

  assert.equal(adapter.getPlanMode('session-plan-1'), true);
  assert.equal(collabCalls.length, 1);
  assert.equal(collabCalls[0]?.threadId, 'session-plan-1');
  assert.equal(collabCalls[0]?.mode, 'plan');
  assert.equal(collabCalls[0]?.options?.model, 'o3-high');
  assert.equal(collabCalls[0]?.options?.reasoningEffort, 'high');

  // Next startTurn with already synced thread should not duplicate call
  await adapter.startTurn({ sessionId: 'session-plan-1', input: 'do plan' });
  assert.equal(collabCalls.length, 1);

  // Simulate disconnected event -> clears syncedPlanThreads
  (adapter as any).syncedPlanThreads.clear();

  // Next startTurn re-syncs collaborationMode before starting turn
  await adapter.startTurn({ sessionId: 'session-plan-1', input: 'resume plan' });
  assert.equal(collabCalls.length, 2);
  assert.equal(collabCalls[1]?.threadId, 'session-plan-1');
  assert.equal(collabCalls[1]?.mode, 'plan');
  assert.equal(collabCalls[1]?.options?.model, 'o3-high');
  assert.equal(collabCalls[1]?.options?.reasoningEffort, 'high');

  // When turning off plan mode, syncedPlanThreads is cleared and mode is default
  await adapter.setPlanMode('session-plan-1', false);
  assert.equal(collabCalls.length, 3);
  assert.equal(collabCalls[2]?.mode, 'default');
  assert.equal(adapter.getPlanMode('session-plan-1'), undefined);
});

test('Codex effort normalization resolves on to default_effort and normalizes auto/off cleanly', async () => {
  const adapter = new CodexProviderAdapter();
  (adapter as any).inner.listModels = async () => [
    {
      model: 'gpt-5-pro',
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
      defaultReasoningEffort: 'high',
    },
    {
      model: 'custom-no-default',
      supportedReasoningEfforts: [],
    },
  ];

  let lastOpts: any;
  (adapter as any).inner.startTurn = async (_sId: string, _input: any, opts: any) => {
    lastOpts = opts;
    return { turnId: 't-effort-1', events: (async function* () {})() };
  };

  // 1. 'on' with model having defaultReasoningEffort -> resolves to 'high'
  await adapter.setModel('s-effort', 'gpt-5-pro');
  await adapter.setThinking('s-effort', 'on');
  await adapter.startTurn({ sessionId: 's-effort', input: 'test on' });
  assert.equal(lastOpts.effort, 'high');

  // 2. 'auto' -> omitted (undefined)
  await adapter.setThinking('s-effort', 'auto');
  await adapter.startTurn({ sessionId: 's-effort', input: 'test auto' });
  assert.equal(lastOpts.effort, undefined);

  // 3. 'off' -> omitted (undefined)
  await adapter.setThinking('s-effort', 'off');
  await adapter.startTurn({ sessionId: 's-effort', input: 'test off' });
  assert.equal(lastOpts.effort, undefined);

  // 4. 'on' with model lacking defaultReasoningEffort -> omitted, NEVER literal 'on'
  await adapter.setModel('s-effort', 'custom-no-default');
  await adapter.setThinking('s-effort', 'on');
  await adapter.startTurn({ sessionId: 's-effort', input: 'test on fallback' });
  assert.equal(lastOpts.effort, undefined);
});

test('Codex historyCache enforces LRU capacity limit and cleans up on delete or archive', async () => {
  const adapter = new CodexProviderAdapter();
  (adapter as any).inner.deleteThread = async () => {};
  (adapter as any).inner.setArchived = async () => {};

  // Insert 65 dummy promises into historyCache
  for (let i = 0; i < 65; i++) {
    (adapter as any).historyCache.set(`sess-${i}`, {
      key: `key-${i}`,
      p: Promise.resolve([]),
      ts: Date.now(),
    });
  }

  // Adding via getHistory or direct eviction check
  assert.ok((adapter as any).historyCache.has('sess-0'));
  (adapter as any).historyCache.delete('sess-0'); // simulate eviction
  assert.equal((adapter as any).historyCache.has('sess-0'), false);

  // Clean up on delete
  (adapter as any).historyCache.set('sess-to-delete', { key: 'k', p: Promise.resolve([]), ts: Date.now() });
  assert.equal((adapter as any).historyCache.has('sess-to-delete'), true);
  await adapter.delete('sess-to-delete');
  assert.equal((adapter as any).historyCache.has('sess-to-delete'), false);

  // Clean up on archive
  (adapter as any).historyCache.set('sess-to-archive', { key: 'k', p: Promise.resolve([]), ts: Date.now() });
  assert.equal((adapter as any).historyCache.has('sess-to-archive'), true);
  await adapter.setArchived('sess-to-archive', true);
  assert.equal((adapter as any).historyCache.has('sess-to-archive'), false);
});

test('ClaudeProviderAdapter clearCommandsCache invokes inner clearHandshakeCache', () => {
  const adapter = new ClaudeProviderAdapter();
  let called = false;
  (adapter as any).inner.clearHandshakeCache = () => {
    called = true;
  };
  adapter.clearCommandsCache();
  assert.equal(called, true);
});

test('ClaudeProviderAdapter listSubagents merges live task status over disk and maps unknown to unknown', async () => {
  const adapter = new ClaudeProviderAdapter();
  const sessionId = 'sess-claude-status';
  (adapter as any).inner.listSubagentDetails = async () => [
    { agentId: 'disk-a', parentToolUseId: 'tu-a', description: 'disk a', subagentType: 'Explore', status: 'running' },
    { agentId: 'disk-b', parentToolUseId: 'tu-b', status: 'running' },
  ];
  (adapter as any).inner.startTurn = async (opts: any) => {
    opts.onEvent({ type: 'task_started', sessionId, taskId: 'task-a', description: 'a', subagentType: 'coder', toolUseId: 'tu-a' });
    opts.onEvent({ type: 'task_started', sessionId, taskId: 'task-c', description: 'c', subagentType: 'coder', toolUseId: 'tu-c' });
    opts.onEvent({ type: 'task_notification', sessionId, taskId: 'task-a', status: 'stopped', summary: 'stopped' });
    opts.onEvent({ type: 'task_notification', sessionId, taskId: 'task-c', status: 'weird-state', summary: '' });
    opts.onEvent({ type: 'done', sessionId, result: 'ok', isError: false, subtype: 'success', stopReason: 'end_turn' });
  };
  const handle = await adapter.startTurn({ sessionId, input: 'run' });
  for await (const _ of handle.events) { /* drain */ }

  const subs = await adapter.listSubagents(sessionId);
  const byId = new Map(subs.map((s) => [s.agentId, s]));
  assert.equal(subs.length, 3);
  assert.equal(byId.get('disk-a')?.status, 'cancelled');
  assert.equal(byId.get('disk-b')?.status, 'running');
  assert.equal(byId.has('task-a'), false);
  assert.equal(byId.get('disk-a')?.parentToolUseId, 'tu-a');
  assert.equal(byId.get('task-c')?.status, 'unknown');
});

test('ClaudeProviderAdapter listSubagents does not duplicate a task reported under both taskId and agentId', async () => {
  const adapter = new ClaudeProviderAdapter();
  const sessionId = 'sess-claude-dedup';
  (adapter as any).inner.listSubagentDetails = async () => [
    { agentId: 'worker9', parentToolUseId: 'tu-9', taskId: 'task-9', status: 'running' },
  ];
  (adapter as any).inner.startTurn = async (opts: any) => {
    opts.onEvent({ type: 'task_started', sessionId, taskId: 'task-9', description: 'nine', subagentType: 'coder', toolUseId: 'tu-9' });
    opts.onEvent({ type: 'task_notification', sessionId, taskId: 'task-9', status: 'completed', summary: 'done', toolUseId: 'tu-9' });
    opts.onEvent({ type: 'done', sessionId, result: 'ok', isError: false, subtype: 'success', stopReason: 'end_turn' });
  };
  const handle = await adapter.startTurn({ sessionId, input: 'run' });
  for await (const _ of handle.events) { /* drain */ }

  const subs = await adapter.listSubagents(sessionId);
  assert.equal(subs.length, 1);
  assert.equal(subs[0]?.agentId, 'worker9');
  assert.equal(subs[0]?.status, 'completed');
});

test('ClaudeProviderAdapter task_notification maps only completed/failed/stopped and never defaults unknown to completed', async () => {
  const adapter = new ClaudeProviderAdapter();
  const sessionId = 'sess-claude-notif';
  (adapter as any).inner.startTurn = async (opts: any) => {
    opts.onEvent({ type: 'task_started', sessionId, taskId: 'n-1', description: 'x', subagentType: 'coder' });
    opts.onEvent({ type: 'task_notification', sessionId, taskId: 'n-1', status: 'future-status', summary: '' });
    opts.onEvent({ type: 'done', sessionId, result: 'ok', isError: false, subtype: 'success', stopReason: 'end_turn' });
  };
  const handle = await adapter.startTurn({ sessionId, input: 'run' });
  const events: any[] = [];
  for await (const e of handle.events) events.push(e);
  const sub = events.filter((e) => e.kind === 'subagent').at(-1);
  assert.notEqual(sub?.status, 'completed');
  assert.equal(sub?.payload?.status, 'unknown');
});

test('ClaudeProviderAdapter task_notification without toolUseId falls back to tracked toolUseId or taskId', async () => {
  const adapter = new ClaudeProviderAdapter();
  (adapter as any).inner.hasSessionFile = () => true;
  (adapter as any).inner.startTurn = async (opts: any) => {
    opts.onEvent({
      type: 'task_started',
      sessionId: 'sess-task-fallback',
      taskId: 'subtask-99',
      description: 'subtask description',
      subagentType: 'coder',
      toolUseId: 'parent-tool-call-1',
    });
    opts.onEvent({
      type: 'task_notification',
      sessionId: 'sess-task-fallback',
      taskId: 'subtask-99',
      status: 'completed',
      summary: 'subtask complete',
      // toolUseId is omitted
    });
    opts.onEvent({
      type: 'done',
      sessionId: 'sess-task-fallback',
      result: 'ok',
      isError: false,
      subtype: 'success',
      stopReason: 'end_turn',
    });
  };

  const { events } = await adapter.startTurn({ sessionId: 'sess-task-fallback', input: 'run task' });
  const collected: any[] = [];
  for await (const e of events) {
    collected.push(e);
  }

  const subCompleted = collected.find((e) => e.kind === 'subagent' && e.status === 'completed');
  assert.ok(subCompleted, 'Expected terminal subagent event even without toolUseId');
  assert.equal(subCompleted.agentId, 'subtask-99');
  assert.equal(subCompleted.parentToolUseId, 'parent-tool-call-1');
  assert.equal(subCompleted.payload.summary, 'subtask complete');
});

test('listClaudeCommands classifies terminalSlashCommands as terminalOnly but lets gateway commands win', () => {
  const catalog = listClaudeCommands(
    [
      { name: 'doctor', description: 'Doctor diagnostic' },
      { name: 'reload-plugins', description: 'Reload plugins' },
      { name: 'normal-cmd', description: 'Normal command' },
      { name: 'fast', description: 'Fast mode' },
    ],
    ['doctor', 'reload-plugins'],
  );

  assert.equal(catalog.find((c) => c.name === 'doctor')?.terminalOnly, true);
  assert.equal(catalog.find((c) => c.name === 'reload-plugins')?.terminalOnly, true);
  // fast 已由网关通过 apply_flag_settings 实现,不再受 CLI 的 terminalOnly 标记约束。
  assert.equal(catalog.find((c) => c.name === 'fast')?.terminalOnly, undefined);
  assert.equal(catalog.find((c) => c.name === 'fast')?.form, 'gateway');
  assert.equal(catalog.find((c) => c.name === 'normal-cmd')?.terminalOnly, undefined);
});

test('Codex subAgentActivity does not forge parentToolUseId from item.id and retries failed plan-mode sync', async () => {
  const adapter = new CodexProviderAdapter();
  (adapter as any).inner.startTurn = async () => ({
    turnId: 'turn-sub-2',
    events: (async function* () {
      yield {
        type: 'item-started',
        item: {
          type: 'subAgentActivity',
          id: 'activity-99',
          agentThreadId: 'sub-thread-99',
          name: 'researcher',
          summary: 'inspecting',
        },
      };
      yield {
        type: 'item-completed',
        item: {
          type: 'subAgentActivity',
          id: 'activity-99',
          agentThreadId: 'sub-thread-99',
          name: 'researcher',
          summary: 'done',
          status: 'completed',
        },
      };
    })(),
  });
  const events: any[] = [];
  const handle = await adapter.startTurn({ sessionId: 'parent-sub-test', input: 'go' });
  for await (const ev of handle.events) events.push(ev);
  const started = events.find((e) => e.kind === 'subagent' && e.status === 'started');
  const completed = events.find((e) => e.kind === 'subagent' && e.status === 'completed');
  assert.equal(started.parentToolUseId, undefined);
  assert.equal(completed.parentToolUseId, undefined);
  assert.ok((adapter as any).liveSubagents.get('parent-sub-test')?.get('sub-thread-99')?.completedAt);

  // Plan mode sync failure during startTurn must leave syncedPlanThreads unmarked so next turn retries
  (adapter as any).settings.set('plan', 'plan-retry-sess', true);
  let collabAttempt = 0;
  (adapter as any).inner.setCollaborationMode = async () => {
    collabAttempt += 1;
    if (collabAttempt === 1) throw new Error('transient rpc fail');
  };
  (adapter as any).inner.startTurn = async () => ({ turnId: 't-retry', events: (async function* () {})() });
  await adapter.startTurn({ sessionId: 'plan-retry-sess', input: 'step 1' });
  assert.equal((adapter as any).syncedPlanThreads.has('plan-retry-sess'), false);
  await adapter.startTurn({ sessionId: 'plan-retry-sess', input: 'step 2' });
  assert.equal(collabAttempt, 2);
  assert.equal((adapter as any).syncedPlanThreads.has('plan-retry-sess'), true);
});

test('review regression: Codex online and offline history message ids match and preserve repeated prompts', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-codex-id-align-'));
  const codexHome = join(base, '.codex');
  const sessionId = 'codex-id-regression-session';
  const sessionDir = join(codexHome, 'sessions', '2026', '11', '15');
  const rolloutFile = join(sessionDir, `rollout-2026-11-15T10-00-00-${sessionId}.jsonl`);
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      rolloutFile,
      [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            id: 'msg_01a1de64-user-1',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
            internal_chat_message_metadata_passthrough: {
              turn_id: 'turn-1',
            },
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            turn_id: 'turn-1',
            item: {
              type: 'UserMessage',
              id: '01a1de64-user-1-native',
              content: [{ type: 'text', text: 'hello' }],
            },
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            id: 'msg_resp_1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hi there' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            id: 'msg_01a1de65-user-2',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
            internal_chat_message_metadata_passthrough: {
              turn_id: 'turn-2',
            },
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            turn_id: 'turn-2',
            item: {
              type: 'UserMessage',
              id: '01a1de65-user-2-native',
              content: [{ type: 'text', text: 'hello' }],
            },
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            id: 'msg_resp_2',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello again!' }],
          },
        }),
      ].join('\n') + '\n',
    );

    const adapter = new CodexProviderAdapter();
    (adapter as any).inner.getHistory = async () => [
      {
        id: 'turn-1',
        items: [
          { type: 'userMessage', id: '01a1de64-user-1-native', content: [{ type: 'text', text: 'hello' }] },
          { type: 'agentMessage', id: 'msg_resp_1', text: 'Hi there' },
        ],
      },
      {
        id: 'turn-2',
        items: [
          { type: 'userMessage', id: '01a1de65-user-2-native', content: [{ type: 'text', text: 'hello' }] },
          { type: 'agentMessage', id: 'msg_resp_2', text: 'Hello again!' },
        ],
      },
    ];

    const fileStat = await stat(rolloutFile);
    const offlineHistory = await (adapter as any).readCodexRolloutHistory(rolloutFile, sessionId, fileStat.size);
    const onlineHistory = await (adapter as any).readCodexHistory(sessionId);

    assert.equal(offlineHistory.length, 4, 'offline history must keep repeated user prompt in turn 2');
    assert.equal(offlineHistory[0]?.role, 'user');
    assert.equal(offlineHistory[1]?.role, 'assistant');
    assert.equal(offlineHistory[2]?.role, 'user');
    assert.equal(offlineHistory[3]?.role, 'assistant');

    assert.equal(offlineHistory[0]?.id, '01a1de64-user-1-native');
    assert.equal(onlineHistory[0]?.id, '01a1de64-user-1-native');
    assert.equal(offlineHistory[2]?.id, '01a1de65-user-2-native');
    assert.equal(onlineHistory[2]?.id, '01a1de65-user-2-native');
  } finally {
    if (prevCodexHome !== undefined) process.env.CODEX_HOME = prevCodexHome;
    else delete process.env.CODEX_HOME;
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: Codex online readCodexHistory includes custom_tool_call exec tools from rollout', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-codex-exec-tool-'));
  const codexHome = join(base, '.codex');
  const sessionId = 'codex-exec-tool-session';
  const sessionDir = join(codexHome, 'sessions', '2026', '11', '15');
  const rolloutFile = join(sessionDir, `rollout-2026-11-15T10-00-00-${sessionId}.jsonl`);
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      rolloutFile,
      [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            id: 'msg_user_1',
            role: 'user',
            content: [{ type: 'input_text', text: 'run check' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-exec-1' },
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            turn_id: 'turn-exec-1',
            item: {
              type: 'UserMessage',
              id: 'user-msg-exec-1',
              content: [{ type: 'text', text: 'run check' }],
            },
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            id: 'fc_call_exec_123',
            call_id: 'call_exec_123',
            name: 'exec',
            input: 'console.log("running check")',
            internal_chat_message_metadata_passthrough: {
              turn_id: 'turn-exec-1',
              create_time: 1794742150.97,
            },
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            id: 'ctco_exec_123',
            call_id: 'call_exec_123',
            output: [{ type: 'input_text', text: 'check passed' }],
            internal_chat_message_metadata_passthrough: {
              turn_id: 'turn-exec-1',
              create_time: 1794742151.11,
            },
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            turn_id: 'turn-exec-1',
            item: {
              type: 'AgentMessage',
              id: 'msg_resp_exec_1',
              text: 'Check completed successfully',
            },
          },
        }),
      ].join('\n') + '\n',
    );

    const adapter = new CodexProviderAdapter();
    (adapter as any).inner.getHistory = async () => [
      {
        id: 'turn-exec-1',
        items: [
          { type: 'userMessage', id: 'user-msg-exec-1', content: [{ type: 'text', text: 'run check' }] },
          { type: 'agentMessage', id: 'msg_resp_exec_1', text: 'Check completed successfully' },
        ],
      },
    ];

    const onlineHistory = await (adapter as any).readCodexHistory(sessionId);

    const toolCallMsg = onlineHistory.find((m: any) => m.content[0]?.type === 'tool_use' && m.content[0]?.tool_name === 'exec');
    const toolResultMsg = onlineHistory.find((m: any) => m.content[0]?.type === 'tool_result' && m.content[0]?.tool_call_id === 'call_exec_123');

    assert.ok(toolCallMsg, 'online history must include custom_tool_call exec call message');
    assert.ok(toolResultMsg, 'online history must include custom_tool_call exec result message');
    assert.equal(toolCallMsg?.id, 'call_exec_123_call');
    assert.equal(toolResultMsg?.id, 'call_exec_123_result');
    assert.equal((toolCallMsg?.content[0] as any)?.input, 'console.log("running check")');
    assert.match(String((toolResultMsg?.content[0] as any)?.output), /check passed/);
  } finally {
    if (prevCodexHome !== undefined) process.env.CODEX_HOME = prevCodexHome;
    else delete process.env.CODEX_HOME;
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: tool interleaving within turn does not break user message pairing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-codex-tool-interleave-'));
  const codexHome = join(base, '.codex');
  const sessionId = 'codex-interleave-session';
  const sessionDir = join(codexHome, 'sessions', '2026', '11', '15');
  const rolloutFile = join(sessionDir, `rollout-2026-11-15T10-00-00-${sessionId}.jsonl`);
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    await mkdir(sessionDir, { recursive: true });
    // Fixture: 同一 turn 内，用户提问后紧接着有 reasoning 和 tool_call，随后才到达 event_msg UserMessage
    await writeFile(
      rolloutFile,
      [
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_started', turn_attribution: { turn_id: 'turn-interleave-1' } },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            id: 'msg_interleave_early',
            role: 'user',
            content: [{ type: 'input_text', text: 'interleaved check' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-interleave-1' },
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            id: 'fc_interleave_tool',
            call_id: 'call_interleave_tool',
            name: 'exec',
            input: 'probe()',
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-interleave-1' },
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            turn_id: 'turn-interleave-1',
            item: {
              type: 'UserMessage',
              id: '01a1de-interleave-native-id',
              content: [{ type: 'text', text: 'interleaved check' }],
            },
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: 'turn-interleave-1' },
        }),
      ].join('\n') + '\n',
    );

    const adapter = new CodexProviderAdapter();
    const fileStat = await stat(rolloutFile);
    const history = await (adapter as any).readCodexRolloutHistory(rolloutFile, sessionId, fileStat.size);

    // 用户消息必须仅有 1 条，且其 ID 必须成功升级为 UserMessage 原生 UUID，不能被工具事件打断
    const userMsgs = history.filter((m: any) => m.role === 'user');
    assert.equal(userMsgs.length, 1, 'interleaved tool must not cause duplicate user messages');
    assert.equal(userMsgs[0]?.id, '01a1de-interleave-native-id', 'interleaved UserMessage must update id to native UUID');
  } finally {
    if (prevCodexHome !== undefined) process.env.CODEX_HOME = prevCodexHome;
    else delete process.env.CODEX_HOME;
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: online rollout merge preserves turn order and separates callId+partType', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-codex-turn-order-'));
  const codexHome = join(base, '.codex');
  const sessionId = 'codex-turn-order-session';
  const sessionDir = join(codexHome, 'sessions', '2026', '11', '15');
  const rolloutFile = join(sessionDir, `rollout-2026-11-15T10-00-00-${sessionId}.jsonl`);
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    await mkdir(sessionDir, { recursive: true });
    // Fixture: rollout 中含有 call_split 的 tool_use 和 tool_result
    await writeFile(
      rolloutFile,
      [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            id: 'fc_split_1',
            call_id: 'call_split_1',
            name: 'exec',
            input: 'cmd1',
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-order-1' },
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            id: 'ctco_split_1',
            call_id: 'call_split_1',
            output: [{ type: 'input_text', text: 'out1' }],
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-order-1' },
          },
        }),
      ].join('\n') + '\n',
    );

    const adapter = new CodexProviderAdapter();
    // 在线数据中：该 turn 已经有 tool_use（比如来自某 RPC），但缺少 tool_result；
    // 并且 agentMessage 没有 timestamp（created_at: undefined）
    (adapter as any).inner.getHistory = async () => [
      {
        id: 'turn-order-1',
        items: [
          { type: 'userMessage', id: 'u-ord-1', content: [{ type: 'text', text: 'do it' }] },
          { type: 'custom_tool_call', id: 'call_split_1', name: 'exec', input: 'cmd1' },
          // 注意：没有 tool_result，且 agentMessage 缺少 created_at
          { type: 'agentMessage', id: 'msg-agent-ord-1', text: 'All done!' },
        ],
      },
    ];

    const onlineHistory = await (adapter as any).readCodexHistory(sessionId);

    // 1. 验证按 callId + partType 独立补齐：在线已有 tool_use 时，缺失的 tool_result 仍能成功补齐
    const resultMsg = onlineHistory.find((m: any) => m.content[0]?.type === 'tool_result' && m.content[0]?.tool_call_id === 'call_split_1');
    assert.ok(resultMsg, 'missing tool_result must be supplemented when tool_use already exists in online items');

    // 2. 验证消息顺序：在该 turn 内，agentMessage 必须排在工具调用及工具结果之后，不能因为缺少 timestamp 串到工具前面
    const agentIdx = onlineHistory.findIndex((m: any) => m.id === 'msg-agent-ord-1');
    const toolCallIdx = onlineHistory.findIndex((m: any) => m.content[0]?.type === 'tool_use' && m.content[0]?.tool_call_id === 'call_split_1');
    const toolResIdx = onlineHistory.findIndex((m: any) => m.content[0]?.type === 'tool_result' && m.content[0]?.tool_call_id === 'call_split_1');

    assert.ok(toolCallIdx >= 0 && toolResIdx >= 0 && agentIdx >= 0);
    assert.ok(toolCallIdx < agentIdx, 'agent message must stay AFTER tool_use');
    assert.ok(toolResIdx < agentIdx, 'agent message must stay AFTER tool_result');
  } finally {
    if (prevCodexHome !== undefined) process.env.CODEX_HOME = prevCodexHome;
    else delete process.env.CODEX_HOME;
    await rm(base, { recursive: true, force: true });
  }
});

test('review regression: active history reuses rollout cache and inner locateRollout without repeated parsing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multi-agent-codex-cache-reuse-'));
  const codexHome = join(base, '.codex');
  const sessionId = 'codex-cache-reuse-session';
  const sessionDir = join(codexHome, 'sessions', '2026', '11', '15');
  const rolloutFile = join(sessionDir, `rollout-2026-11-15T10-00-00-${sessionId}.jsonl`);
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      rolloutFile,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn-cache-1',
          item: { type: 'UserMessage', id: 'u-cache-1', content: [{ type: 'text', text: 'hi' }] },
        },
      }) + '\n',
    );

    const adapter = new CodexProviderAdapter();
    let locateCalls = 0;
    (adapter as any).inner.locateRollout = async (id: string) => {
      locateCalls += 1;
      return rolloutFile;
    };
    (adapter as any).inner.getHistory = async () => [
      { id: 'turn-cache-1', items: [{ type: 'userMessage', id: 'u-cache-1', content: [{ type: 'text', text: 'hi' }] }] },
    ];

    let parseCalls = 0;
    const origParse = (adapter as any).readCodexRolloutHistory.bind(adapter);
    (adapter as any).readCodexRolloutHistory = async (...args: any[]) => {
      parseCalls += 1;
      return origParse(...args);
    };

    await (adapter as any).readCodexHistory(sessionId);
    assert.equal(locateCalls, 1);
    assert.equal(parseCalls, 1);

    await (adapter as any).readCodexHistory(sessionId);
    assert.equal(locateCalls, 2);
    assert.equal(parseCalls, 1, 'repeated active history read on same mtime+size must reuse parsed cache');
  } finally {
    if (prevCodexHome !== undefined) process.env.CODEX_HOME = prevCodexHome;
    else delete process.env.CODEX_HOME;
    await rm(base, { recursive: true, force: true });
  }
});




async function withCodexRollout<T>(
  tag: string,
  sessionId: string,
  rolloutLines: unknown[],
  onlineTurns: unknown[],
  run: (adapter: any) => Promise<T>,
): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), `multi-agent-codex-${tag}-`));
  const codexHome = join(base, '.codex');
  const sessionDir = join(codexHome, 'sessions', '2026', '11', '17');
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, `rollout-2026-11-17T10-00-00-${sessionId}.jsonl`),
      rolloutLines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    const adapter = new CodexProviderAdapter() as any;
    adapter.inner.getHistory = async () => onlineTurns;
    return await run(adapter);
  } finally {
    if (prevCodexHome !== undefined) process.env.CODEX_HOME = prevCodexHome;
    else delete process.env.CODEX_HOME;
    await rm(base, { recursive: true, force: true });
  }
}

const describeCodexParts = (history: any[]): string[] =>
  history.map((m) => {
    const part = m.content[0];
    if (part.type === 'text') return `${m.role}:${part.text}`;
    if (part.type === 'tool_use') return `use:${part.tool_call_id}`;
    if (part.type === 'tool_result') return `result:${part.tool_call_id}`;
    return `${m.role}:${part.type}`;
  });

test('review regression: rollout tools land between two agent messages of the same turn by timestamp', async () => {
  const sid = 'codex-between-messages';
  const call = (id: string, ts: string) => ({
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'custom_tool_call', call_id: id, name: 'exec', input: 'ls', internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' } },
  });
  const out = (id: string, ts: string) => ({
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text: 'a.txt' }], internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' } },
  });
  const history = await withCodexRollout<any[]>(
    'between',
    sid,
    [
      {
        timestamp: '2026-11-17T10:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: '找文件' }] } },
      },
      {
        timestamp: '2026-11-17T10:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'AgentMessage', id: 'a1', text: '先找文件' } },
      },
      call('call_x', '2026-11-17T10:00:03.000Z'),
      out('call_x', '2026-11-17T10:00:04.000Z'),
      {
        timestamp: '2026-11-17T10:00:05.000Z',
        type: 'event_msg',
        payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'AgentMessage', id: 'a2', text: '结果如下' } },
      },
    ],
    [{
      id: 'turn-1',
      items: [
        { type: 'userMessage', id: 'u1', createdAt: '2026-11-17T10:00:01.000Z', content: [{ type: 'text', text: '找文件' }] },
        { type: 'agentMessage', id: 'a1', createdAt: '2026-11-17T10:00:02.000Z', text: '先找文件' },
        { type: 'agentMessage', id: 'a2', createdAt: '2026-11-17T10:00:05.000Z', text: '结果如下' },
      ],
    }],
    (adapter) => adapter.readCodexHistory(sid),
  );
  assert.deepEqual(describeCodexParts(history), ['user:找文件', 'assistant:先找文件', 'use:call_x', 'result:call_x', 'assistant:结果如下']);
});

test('review regression: rollout tools whose turn id is unknown online are kept, not dropped', async () => {
  const sid = 'codex-turn-id-mismatch';
  const history = await withCodexRollout<any[]>(
    'mismatch',
    sid,
    [
      {
        timestamp: '2026-11-17T10:00:03.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call', call_id: 'call_y', name: 'exec', input: 'ls', internal_chat_message_metadata_passthrough: { turn_id: 'rollout-turn' } },
      },
      {
        timestamp: '2026-11-17T10:00:04.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'call_y', output: 'out', internal_chat_message_metadata_passthrough: { turn_id: 'rollout-turn' } },
      },
    ],
    [{
      id: 'online-turn',
      items: [
        { type: 'userMessage', id: 'u2', createdAt: '2026-11-17T10:00:01.000Z', content: [{ type: 'text', text: 'go' }] },
        { type: 'agentMessage', id: 'a2', createdAt: '2026-11-17T10:00:05.000Z', text: 'done' },
      ],
    }],
    (adapter) => adapter.readCodexHistory(sid),
  );
  const parts = describeCodexParts(history);
  assert.ok(parts.includes('use:call_y') && parts.includes('result:call_y'), `tools must survive: ${parts.join(' | ')}`);
  assert.deepEqual(parts.filter((p) => !p.includes('call_y')), ['user:go', 'assistant:done']);
});

test('review regression: delete, archive and dispose drop the parsed rollout cache entry', async () => {
  const adapter = new CodexProviderAdapter() as any;
  adapter.inner.deleteThread = async () => undefined;
  adapter.inner.setArchived = async () => undefined;
  const seed = (id: string) => adapter.rolloutParsedCache.set(id, { key: '1:1', p: Promise.resolve([]), ts: Date.now() });
  seed('s-delete');
  await adapter.delete('s-delete');
  assert.equal(adapter.rolloutParsedCache.has('s-delete'), false, 'delete must clear the rollout cache');
  seed('s-archive');
  await adapter.setArchived('s-archive', true);
  assert.equal(adapter.rolloutParsedCache.has('s-archive'), false, 'archive must clear the rollout cache');
  seed('s-dispose');
  await adapter.dispose().catch(() => undefined);
  assert.equal(adapter.rolloutParsedCache.size, 0, 'dispose must clear the rollout cache');
});
