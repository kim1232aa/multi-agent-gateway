import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SettingsStore } from './settings-store.js';

test('settings persist across store instances (gateway restart)', async () => {
  // 回归:会话级设置原是内存 Map,网关重启丢"完全自主"等选择,codex
  // resume 回落 thread 存储的 untrusted 策略,审批弹窗回归。
  const dir = await mkdtemp(join(tmpdir(), 'settings-store-'));
  const path = join(dir, 'session-settings.codex.json');
  try {
    const first = new SettingsStore(path);
    first.set('permission', 's1', 'yolo');
    first.set('model', 's1', 'gpt-5.6-sol');
    first.set('thinking', 's1', 'high');
    first.set('plan', 's2', true);
    first.flushNow();

    // 模拟重启:新实例从磁盘恢复。
    const second = new SettingsStore(path);
    assert.equal(second.getString('permission', 's1'), 'yolo');
    assert.equal(second.getString('model', 's1'), 'gpt-5.6-sol');
    assert.equal(second.getString('thinking', 's1'), 'high');
    assert.equal(second.getBoolean('plan', 's2'), true);
    assert.equal(second.getString('permission', 'unknown'), undefined);

    // delete 同样落盘。
    second.delete('plan', 's2');
    second.flushNow();
    assert.equal(new SettingsStore(path).getBoolean('plan', 's2'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tolerates a corrupted settings file and stays writable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'settings-store-'));
  const path = join(dir, 'bad.json');
  try {
    await writeFile(path, '{not json');
    const store = new SettingsStore(path);
    assert.equal(store.getString('model', 's1'), undefined);
    store.set('model', 's1', 'm');
    store.flushNow();
    assert.equal(new SettingsStore(path).getString('model', 's1'), 'm');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('path-less store is memory-only and never touches disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'settings-store-'));
  try {
    const store = new SettingsStore();
    store.set('permission', 's1', 'yolo');
    assert.equal(store.getString('permission', 's1'), 'yolo');
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('copySession clones every scoped value onto the forked id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'settings-store-copy-'));
  const path = join(dir, 'session-settings.claude.json');
  try {
    const store = new SettingsStore(path);
    store.set('model', 'old', 'sonnet');
    store.set('thinking', 'old', 'high');
    store.set('permission', 'old', 'yolo');
    store.set('plan', 'old', true);
    store.set('model', 'other', 'haiku');
    store.copySession('old', 'new');
    store.copySession('old', 'old');
    store.copySession('', 'new');

    assert.equal(store.getString('model', 'new'), 'sonnet');
    assert.equal(store.getString('thinking', 'new'), 'high');
    assert.equal(store.getString('permission', 'new'), 'yolo');
    assert.equal(store.getBoolean('plan', 'new'), true);
    assert.equal(store.getString('model', 'old'), 'sonnet');
    assert.equal(store.getString('model', 'other'), 'haiku');

    store.flushNow();
    const restarted = new SettingsStore(path);
    assert.equal(restarted.getString('model', 'new'), 'sonnet');
    assert.equal(restarted.getBoolean('plan', 'new'), true);
    assert.equal(restarted.getString('model', 'other'), 'haiku');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('close() flushes pending writes synchronously and is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'settings-store-close-'));
  const path = join(dir, 'nested', 'session-settings.pi.json');
  try {
    const store = new SettingsStore(path);
    store.set('model', 's1', 'anthropic/claude-sonnet-4');
    assert.equal(store.isDirty(), true);
    store.close();
    store.close();
    assert.equal(store.isDirty(), false);
    assert.equal(store.getLastError(), undefined);

    const reloaded = new SettingsStore(path);
    assert.equal(reloaded.getString('model', 's1'), 'anthropic/claude-sonnet-4');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('uses collision-free atomic temp names and preserves fresh foreign temp files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'settings-store-tmp-'));
  const path = join(dir, 'settings.json');
  try {
    const ownStaleTmp = `${path}.${process.pid}.999.deadbeef.tmp`;
    const foreignActiveTmp = `${path}.${process.pid + 999999}.1.cafe.tmp`;
    await writeFile(ownStaleTmp, 'stale');
    await writeFile(foreignActiveTmp, 'active-other-process');

    const a = new SettingsStore(path);
    const b = new SettingsStore(path);
    a.set('model', 'sa', 'm1');
    b.set('model', 'sb', 'm2');
    a.flushNow();
    b.flushNow();

    const entries = await readdir(dir);
    assert.equal(entries.includes(`settings.json.${process.pid}.999.deadbeef.tmp`), false);
    assert.equal(entries.includes(`settings.json.${process.pid + 999999}.1.cafe.tmp`), true);
    assert.deepEqual(entries.filter((n) => n.startsWith(`settings.json.${process.pid}.`)), []);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).model.sb, 'm2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('records flush failures, leaves no temp files, and retries until writable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'settings-store-retry-'));
  const path = join(dir, 'blocked.json');
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    // Make target path an existing directory so renameSync fails reliably even as root.
    await mkdir(path);
    const errors: unknown[] = [];
    const store = new SettingsStore(path, {
      retryDelayMs: 15,
      maxRetries: 10,
      onError: (err) => errors.push(err),
    });
    store.set('permission', 's1', 'yolo');
    store.flushNow();

    assert.equal(store.isDirty(), true);
    assert.ok(store.getLastError() instanceof Error);
    assert.ok(errors.length >= 1);
    const duringFailureEntries = await readdir(dir);
    assert.deepEqual(duringFailureEntries.filter((n) => n.endsWith('.tmp')), []);

    // Remove the blocking directory so the scheduled retry succeeds without another set().
    await rm(path, { recursive: true, force: true });
    for (let i = 0; i < 40 && store.isDirty(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(store.isDirty(), false);
    assert.equal(store.getLastError(), undefined);
    assert.equal(new SettingsStore(path).getString('permission', 's1'), 'yolo');
    store.close();
  } finally {
    console.warn = originalWarn;
    await rm(dir, { recursive: true, force: true });
  }
});
