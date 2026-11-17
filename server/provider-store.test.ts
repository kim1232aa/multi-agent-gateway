import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ProviderStore, ProviderStoreError, piProviderName } from './provider-store.js';

const models = [{ model: 'gemini-3.8-flash', max_context_size: 1048576 }];

async function withStore(fn: (store: ProviderStore, dir: string) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mag-provider-store-'));
  try {
    await fn(new ProviderStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('no active provider means no injection', () => withStore((store) => {
  for (const cli of ['codex', 'claude', 'grok', 'pi', 'dsh'] as const) {
    assert.deepEqual(store.injectionFor(cli), { args: [], env: {} });
  }
}));

test('codex injection uses -c overrides and keeps the key in env only', () => withStore((store) => {
  store.upsert('codex', { id: 'ccwu', type: 'openai_responses', base_url: 'https://relay.example/v1', api_key: 'sk-secret', models });
  const inj = store.injectionFor('codex');
  assert.ok(!inj.args.join(' ').includes('sk-secret'));
  assert.ok(inj.args.includes('model_provider="mag_ccwu"'));
  assert.ok(inj.args.includes('model_providers.mag_ccwu.base_url="https://relay.example/v1"'));
  assert.ok(inj.args.includes('model_providers.mag_ccwu.wire_api="responses"'));
  assert.equal(inj.env.MAG_CODEX_KEY_CCWU, 'sk-secret');
}));

test('rejects a protocol the CLI cannot speak', () => withStore((store) => {
  assert.throws(
    () => store.upsert('codex', { id: 'x', type: 'openai', base_url: 'https://a.example/v1', api_key: 'k', models }),
    (err: unknown) => err instanceof ProviderStoreError && err.status === 400 && /supported: openai_responses/.test(err.message),
  );
  assert.throws(
    () => store.upsert('claude', { id: 'x', type: 'openai', base_url: 'https://a.example/v1', api_key: 'k', models }),
    ProviderStoreError,
  );
}));

test('claude injection writes a 0600 --settings file outside ~/.claude', () => withStore(async (store, dir) => {
  store.upsert('claude', { id: 'relay', type: 'anthropic', base_url: 'https://relay.example/v1', api_key: 'sk-a', models });
  const inj = store.injectionFor('claude');
  assert.equal(inj.args[0], '--settings');
  const file = inj.args[1]!;
  assert.ok(file.startsWith(dir));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const settings = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://relay.example');
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-a');
  assert.equal(settings.model, 'gemini-3.8-flash');
}));

test('grok injection is env-only', () => withStore((store) => {
  store.upsert('grok', { id: 'relay', type: 'openai', base_url: 'https://relay.example/v1', api_key: 'sk-g', models });
  const inj = store.injectionFor('grok');
  assert.deepEqual(inj.args, []);
  assert.equal(inj.env.GROK_MODELS_BASE_URL, 'https://relay.example/v1');
  assert.equal(inj.env.XAI_API_KEY, 'sk-g');
  assert.deepEqual(JSON.parse(inj.env.GROK_CONFIG!), { models: { default: 'gemini-3.8-flash' } });
}));

test('pi extension references the key by $ENV, never inline', () => withStore(async (store) => {
  store.upsert('pi', { id: 'relay', type: 'openai', base_url: 'https://relay.example/v1', api_key: 'sk-p', models });
  const inj = store.injectionFor('pi');
  assert.equal(inj.args[0], '--extension');
  const src = await readFile(inj.args[1]!, 'utf8');
  assert.ok(!src.includes('sk-p'));
  assert.ok(src.includes('"$MAG_PI_KEY_RELAY"'));
  assert.ok(src.includes('"openai-completions"'));
  assert.ok(src.includes(JSON.stringify(piProviderName('relay'))));
  assert.equal(inj.env.MAG_PI_KEY_RELAY, 'sk-p');
  assert.equal(store.activeModelId('pi'), 'gw-relay/gemini-3.8-flash');
}));

test('dsh patch is JSON (valid YAML) naming the key env', () => withStore(async (store) => {
  store.upsert('dsh', { id: 'relay', type: 'anthropic', base_url: 'https://relay.example/v1', api_key: 'sk-d', models });
  const inj = store.injectionFor('dsh');
  assert.equal(inj.args[0], '--patch');
  const patch = JSON.parse(await readFile(inj.args[1]!, 'utf8'));
  assert.equal(patch[0].config.providers.gw_relay.apiKeyEnv, 'MAG_DSH_KEY_RELAY');
  assert.equal(patch[0].config.providers.gw_relay.baseURL, 'https://relay.example');
  assert.deepEqual(patch[1], { id: 'acp', config: { provider: 'gw_relay', model: 'gemini-3.8-flash' } });
  assert.ok(!JSON.stringify(patch).includes('sk-d'));
}));

test('update keeps the old key when api_key is omitted, renames move the key', () => withStore((store) => {
  store.upsert('grok', { id: 'a', type: 'openai', base_url: 'https://a.example/v1', api_key: 'k1', models });
  store.upsert('grok', { new_id: 'b', base_url: 'https://b.example/v1' }, 'a');
  assert.equal(store.get('grok', 'a'), undefined);
  assert.equal(store.get('grok', 'b')?.base_url, 'https://b.example/v1');
  assert.equal(store.injectionFor('grok').env.XAI_API_KEY, 'k1');
  assert.equal(store.hasKey('grok', 'a'), false);
}));

test('create requires a key; duplicates conflict; delete clears active and launch file', () => withStore(async (store) => {
  assert.throws(() => store.upsert('pi', { id: 'a', type: 'openai', base_url: 'https://a.example/v1', models }), /api_key is required/);
  store.upsert('pi', { id: 'a', type: 'openai', base_url: 'https://a.example/v1', api_key: 'k', models });
  assert.throws(() => store.upsert('pi', { id: 'a', type: 'openai', base_url: 'https://a.example/v1', api_key: 'k', models }), /already exists/);
  const file = store.injectionFor('pi').args[1]!;
  store.remove('pi', 'a');
  assert.deepEqual(store.injectionFor('pi'), { args: [], env: {} });
  await assert.rejects(stat(file));
}));

test('persists across instances with 0600 files', () => withStore(async (store, dir) => {
  store.upsert('codex', { id: 'r', type: 'openai_responses', base_url: 'https://r.example/v1', api_key: 'sk-r', models });
  const again = new ProviderStore(dir);
  assert.equal(again.activeId('codex'), 'r');
  assert.equal(again.injectionFor('codex').env.MAG_CODEX_KEY_R, 'sk-r');
  assert.equal((await stat(join(dir, 'providers', 'provider-keys.json'))).mode & 0o777, 0o600);
  const listed = await readFile(join(dir, 'providers', 'providers.json'), 'utf8');
  assert.ok(!listed.includes('sk-r'));
}));

test('setActive(null) falls back to the CLI native config', () => withStore((store) => {
  store.upsert('grok', { id: 'a', type: 'openai', base_url: 'https://a.example/v1', api_key: 'k', models });
  store.setActive('grok', null);
  assert.deepEqual(store.injectionFor('grok'), { args: [], env: {} });
  store.setActive('grok', 'a');
  assert.equal(store.injectionFor('grok').env.XAI_API_KEY, 'k');
}));
