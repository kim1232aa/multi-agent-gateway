import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClaudeProviderAdapter } from './facade.js';

const sessionId = '99999999-9999-4999-8999-999999999999';

async function withAdapter(
  run: (adapter: ClaudeProviderAdapter, calls: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-flags-'));
  const adapter = new ClaudeProviderAdapter({ settingsPath: join(dir, 'settings.json'), claudeBin: '/missing-cli' });
  const calls: Array<Record<string, unknown>> = [];
  (adapter as any).inner.applyFlagSettings = async (_sid: string, settings: Record<string, unknown>) => {
    calls.push(settings);
    return {};
  };
  try {
    await run(adapter, calls);
  } finally {
    await adapter.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

test('claude fast mode persists and syncs to the live turn', async () => {
  await withAdapter(async (adapter, calls) => {
    assert.equal(adapter.getFastMode(sessionId), undefined);
    await adapter.setFastMode(sessionId, true);
    assert.equal(adapter.getFastMode(sessionId), true);
    assert.deepEqual(calls.at(-1), { fastMode: true });
    await adapter.setFastMode(sessionId, false);
    assert.equal(adapter.getFastMode(sessionId), false);
    assert.deepEqual(calls.at(-1), { fastMode: false });
  });
});

test('claude fast mode stays persisted when the live sync fails', async () => {
  await withAdapter(async (adapter) => {
    (adapter as any).inner.applyFlagSettings = async () => { throw new Error('no running turn'); };
    await adapter.setFastMode(sessionId, true);
    assert.equal(adapter.getFastMode(sessionId), true);
  });
});

test('claude color persists and syncs to the live turn', async () => {
  await withAdapter(async (adapter, calls) => {
    await adapter.setColor(sessionId, 'blue');
    assert.equal(adapter.getColor(sessionId), 'blue');
    assert.deepEqual(calls.at(-1), { color: 'blue' });
  });
});

test('claude fast and color are injected into each turn via settings, not lost after one turn', async () => {
  await withAdapter(async (adapter) => {
    const started: Array<Record<string, unknown>> = [];
    (adapter as any).inner.hasSessionFile = () => true;
    (adapter as any).inner.startTurn = async (opts: any) => {
      started.push(opts);
      opts.onEvent({ type: 'result', sessionId, result: 'ok', isError: false, subtype: 'success', stopReason: 'end_turn' });
    };
    await adapter.setFastMode(sessionId, true);
    await adapter.setColor(sessionId, 'cyan');

    for (let i = 0; i < 2; i += 1) {
      const handle = await adapter.startTurn({ sessionId, input: `turn ${i}` });
      for await (const _ of handle.events) { /* drain */ }
    }

    assert.equal(started.length, 2);
    for (const opts of started) {
      assert.deepEqual(opts.settings, { fastMode: true, color: 'cyan' });
    }
  });
});

test('claude turns omit settings when neither fast nor color is set', async () => {
  await withAdapter(async (adapter) => {
    const started: Array<Record<string, unknown>> = [];
    (adapter as any).inner.hasSessionFile = () => true;
    (adapter as any).inner.startTurn = async (opts: any) => {
      started.push(opts);
      opts.onEvent({ type: 'result', sessionId, result: 'ok', isError: false, subtype: 'success', stopReason: 'end_turn' });
    };
    const handle = await adapter.startTurn({ sessionId, input: 'plain' });
    for await (const _ of handle.events) { /* drain */ }
    assert.equal(started.length, 1);
    assert.equal('settings' in started[0]!, false);
  });
});
