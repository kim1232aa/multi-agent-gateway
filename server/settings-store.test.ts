import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

    // 模拟重启:新实例从磁盘恢复。
    const second = new SettingsStore(path);
    assert.equal(second.getString('permission', 's1'), 'yolo');
    assert.equal(second.getString('model', 's1'), 'gpt-5.6-sol');
    assert.equal(second.getString('thinking', 's1'), 'high');
    assert.equal(second.getBoolean('plan', 's2'), true);
    assert.equal(second.getString('permission', 'unknown'), undefined);

    // delete 同样落盘。
    second.delete('plan', 's2');
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
