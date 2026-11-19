import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  KimiProviderSource,
  ProviderStore,
  ProviderStoreError,
  encodeModelRef,
  parseKimiProviderList,
  parseModelRef,
} from './provider-store.js';

const models = [{ model: 'gemini-3.8-flash', max_context_size: 1048576 }];

async function withStore(
  fn: (store: ProviderStore, dir: string) => Promise<void> | void,
  kimi?: KimiProviderSource,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mag-provider-store-'));
  try {
    const store = new ProviderStore(dir, { kimi: kimi ?? null });
    await store.ready(2_000);
    await fn(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const KIMI_LIST = {
  providers: {
    a9: { baseUrl: 'https://a9.example', type: 'anthropic', apiKey: 'sk-kimi-a9' },
    sx: { baseUrl: 'https://sx.example/v1', type: 'openai', apiKey: 'sk-kimi-sx' },
    nokey: { baseUrl: 'https://n.example/v1', type: 'openai', apiKey: '' },
    vx: { baseUrl: 'https://vx.example', type: 'vertexai', apiKey: 'sk-v' },
  },
  models: {
    'a9/claude-opus-5-5': {
      provider: 'a9', model: 'claude-opus-5-5', maxContextSize: 1000000,
      capabilities: ['thinking', 'image_in'], supportEfforts: ['low', 'high', 'max'], defaultEffort: 'high',
      overrides: { defaultEffort: 'max' }, reasoningKey: 'secret-ish',
    },
    'sx/gemini-3.8-flash': {
      provider: 'sx', model: 'gemini-3.8-flash', maxContextSize: 1048576, capabilities: ['tool_use'], displayName: 'Gemini Flash',
    },
    'nokey/m': { provider: 'nokey', model: 'm', maxContextSize: 1000, capabilities: [] },
    'vx/m': { provider: 'vx', model: 'm', maxContextSize: 1000, capabilities: [] },
  },
};

function kimiSource(payload: unknown = KIMI_LIST): KimiProviderSource {
  return new KimiProviderSource({ home: '/nonexistent-kimi-home', run: async () => JSON.stringify(payload) });
}

test('model refs round-trip and reject bare ids', () => {
  assert.equal(encodeModelRef('kimi.a9', 'aistudio/gemini'), '@kimi.a9:aistudio/gemini');
  assert.deepEqual(parseModelRef('@kimi.a9:aistudio/gemini'), { key: 'kimi.a9', model: 'aistudio/gemini' });
  assert.equal(parseModelRef('gpt-6.2-sol'), null);
  assert.equal(parseModelRef('ccwu/gemini'), null);
});

test('parseKimiProviderList keeps keyed, well-formed providers and real metadata', () => {
  const parsed = parseKimiProviderList(KIMI_LIST);
  assert.deepEqual(parsed.map((p) => p.id).sort(), ['a9', 'sx', 'vx']);
  const a9 = parsed.find((p) => p.id === 'a9')!;
  assert.equal(a9.models[0]!.max_context_size, 1000000);
  assert.equal(a9.models[0]!.default_effort, 'max');
  assert.deepEqual(a9.models[0]!.support_efforts, ['low', 'high', 'max']);
  assert.ok(!JSON.stringify(a9.models).includes('secret-ish'));
});

test('no providers means no injection', () => withStore((store) => {
  for (const cli of ['codex', 'claude', 'grok', 'pi', 'dsh'] as const) {
    assert.deepEqual(store.injectionFor(cli), { args: [], env: {} });
    assert.deepEqual(store.catalog(cli), []);
  }
}));

test('codex gets every provider via -c, keeps its own default, key only in env', () => withStore((store) => {
  store.upsert('codex', { id: 'ccwu', type: 'openai_responses', base_url: 'https://relay.example/v1', api_key: 'sk-secret', models });
  store.upsert('codex', { id: 'openai', type: 'openai_responses', base_url: 'https://o.example/v1', api_key: 'sk-o', models });
  const inj = store.injectionFor('codex');
  const joined = inj.args.join(' ');
  assert.ok(!joined.includes('sk-secret'));
  assert.ok(!inj.args.some((a) => a.startsWith('model_provider=')), 'must not override the CLI default provider');
  assert.ok(!inj.args.some((a) => a.startsWith('model=')));
  assert.ok(inj.args.includes('model_providers.ccwu.base_url="https://relay.example/v1"'), 'gateway id kept so old rollouts resume');
  assert.ok(inj.args.includes('model_providers.ccwu.wire_api="responses"'));
  assert.ok(inj.args.includes('model_providers.mag_openai.base_url="https://o.example/v1"'), 'built-in ids are not shadowed');
  assert.equal(inj.env.MAG_CODEX_KEY_CCWU, 'sk-secret');
  assert.equal(store.cliProviderId('codex', 'ccwu'), 'ccwu');
  assert.equal(store.cliModelId('codex', '@ccwu:gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(store.cliModelId('codex', '@nope:x'), undefined);
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

test('claude injects only the requested provider via a 0600 --settings file outside ~/.claude', () => withStore(async (store, dir) => {
  store.upsert('claude', { id: 'relay', type: 'anthropic', base_url: 'https://relay.example/v1', api_key: 'sk-a', models });
  assert.deepEqual(store.injectionFor('claude'), { args: [], env: {} }, 'no key = own login');
  const inj = store.injectionFor('claude', 'relay');
  assert.equal(inj.args[0], '--settings');
  const file = inj.args[1]!;
  assert.ok(file.startsWith(dir));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const settings = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://relay.example');
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-a');
  assert.equal(settings.model, 'gemini-3.8-flash');
  for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
    assert.equal(settings.env[name], 'gemini-3.8-flash', `${name} must stay on the relay's model`);
  }
  store.remove('claude', 'relay');
  assert.ok(!(await readdir(join(dir, 'providers'))).some((n) => n.startsWith('inject.claude')), 'key file pruned');
}));

test('grok injection is env-only and per provider', () => withStore((store) => {
  store.upsert('grok', { id: 'relay', type: 'openai', base_url: 'https://relay.example/v1', api_key: 'sk-g', models });
  assert.deepEqual(store.injectionFor('grok'), { args: [], env: {} });
  const inj = store.injectionFor('grok', 'relay');
  assert.deepEqual(inj.args, []);
  assert.equal(inj.env.GROK_MODELS_BASE_URL, 'https://relay.example/v1');
  assert.equal(inj.env.XAI_API_KEY, 'sk-g');
  assert.deepEqual(JSON.parse(inj.env.GROK_CONFIG!), {
    models: { session_summary: 'gemini-3.8-flash', image_description: 'gemini-3.8-flash', prompt_suggestion: 'gemini-3.8-flash', web_search: 'gemini-3.8-flash' },
  });
}));

test('pi extension registers every provider, keys by $ENV, thinking map from efforts', () => withStore(async (store) => {
  store.upsert('pi', { id: 'relay', type: 'openai', base_url: 'https://relay.example/v1', api_key: 'sk-p', models });
  const inj = store.injectionFor('pi');
  assert.equal(inj.args[0], '--extension');
  const src = await readFile(inj.args[1]!, 'utf8');
  assert.ok(!src.includes('sk-p') && !src.includes('sk-kimi'));
  assert.ok(src.includes('"$MAG_PI_KEY_RELAY"'));
  assert.ok(src.includes('pi.registerProvider("gw-relay"'));
  assert.ok(src.includes('pi.registerProvider("mag-kimi-a9"'));
  assert.ok(src.includes('"baseUrl":"https://a9.example"'));
  assert.ok(src.includes('"api":"anthropic-messages"'));
  assert.ok(src.includes('"thinkingLevelMap":{"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"}'));
  assert.equal(inj.env.MAG_PI_KEY_RELAY, 'sk-p');
  assert.equal(inj.env.MAG_PI_KIMI_A9, 'sk-kimi-a9');
  assert.equal(store.cliModelId('pi', '@kimi.a9:claude-opus-5-5'), 'mag-kimi-a9/claude-opus-5-5');
  assert.equal(store.keyForCliProvider('pi', 'gw-relay'), 'relay');
}, kimiSource()));

test('dsh patch declares every provider under llm-pi-ai with model `name`', () => withStore(async (store) => {
  store.upsert('dsh', { id: 'relay', type: 'anthropic', base_url: 'https://relay.example/v1', api_key: 'sk-d', models });
  const inj = store.injectionFor('dsh');
  assert.equal(inj.args[0], '--patch');
  const patch = JSON.parse(await readFile(inj.args[1]!, 'utf8'));
  assert.equal(patch.length, 1, 'no acp default: the CLI keeps its own default model');
  const providers = patch[0].config.providers;
  assert.equal(providers.gw_relay.apiKeyEnv, 'MAG_DSH_KEY_RELAY');
  assert.equal(providers.gw_relay.baseURL, 'https://relay.example');
  assert.equal(providers.gw_relay.models[0].name, 'gemini-3.8-flash');
  assert.equal(providers.gw_relay.models[0].reasoningEfforts, false);
  assert.deepEqual(providers.mag_kimi_a9.models[0].reasoningEfforts, { low: 'low', high: 'high', max: 'max' });
  assert.equal(providers.mag_kimi_sx.api, 'openai-completions');
  assert.ok(!JSON.stringify(patch).includes('sk-'));
  assert.equal(store.cliModelId('dsh', '@kimi.sx:gemini-3.8-flash'), '["mag_kimi_sx","gemini-3.8-flash"]');
}, kimiSource()));

test('kimi providers are filtered by protocol per CLI', () => withStore((store) => {
  assert.deepEqual(store.catalog('claude').map((p) => p.key), ['kimi.a9']);
  assert.deepEqual(store.catalog('grok').map((p) => p.key), ['kimi.sx']);
  assert.deepEqual(store.catalog('codex').map((p) => p.key), []);
  assert.deepEqual(store.catalog('pi').map((p) => p.key).sort(), ['kimi.a9', 'kimi.sx']);
  assert.ok(!JSON.stringify(store.catalog('pi')).includes('sk-kimi'));
  assert.equal(store.injectionFor('claude', 'kimi.a9').args[0], '--settings');
}, kimiSource()));

test('kimi load failure leaves the gateway catalog usable', async () => {
  const failing = new KimiProviderSource({ home: '/nonexistent', run: async () => { throw new Error('kimi missing'); } });
  await withStore((store) => {
    store.upsert('grok', { id: 'a', type: 'openai', base_url: 'https://a.example/v1', api_key: 'k', models });
    assert.deepEqual(store.catalog('grok').map((p) => p.key), ['a']);
    assert.match(store.kimiError() ?? '', /kimi missing/);
  }, failing);
});

test('catalog changes notify per CLI and move the fingerprint', () => withStore((store) => {
  const seen: string[] = [];
  store.onChange((cli) => seen.push(cli));
  const before = store.catalogFingerprint('grok');
  store.upsert('grok', { id: 'a', type: 'openai', base_url: 'https://a.example/v1', api_key: 'k', models });
  assert.deepEqual(seen, ['grok']);
  assert.notEqual(store.catalogFingerprint('grok'), before);
  const mid = store.catalogFingerprint('grok');
  store.upsert('grok', { api_key: 'k2' }, 'a');
  assert.notEqual(store.catalogFingerprint('grok'), mid, 'key rotation counts as a change');
}));

test('update keeps the old key when api_key is omitted, renames move the key and active', () => withStore((store) => {
  store.upsert('grok', { id: 'a', type: 'openai', base_url: 'https://a.example/v1', api_key: 'k1', models });
  store.setActive('grok', 'a');
  store.upsert('grok', { new_id: 'b', base_url: 'https://b.example/v1' }, 'a');
  assert.equal(store.get('grok', 'a'), undefined);
  assert.equal(store.get('grok', 'b')?.base_url, 'https://b.example/v1');
  assert.equal(store.injectionFor('grok', 'b').env.XAI_API_KEY, 'k1');
  assert.equal(store.hasKey('grok', 'a'), false);
  assert.equal(store.activeId('grok'), 'b');
}));

test('create requires a key; duplicates conflict; delete clears active and launch file', () => withStore(async (store) => {
  assert.throws(() => store.upsert('pi', { id: 'a', type: 'openai', base_url: 'https://a.example/v1', models }), /api_key is required/);
  store.upsert('pi', { id: 'a', type: 'openai', base_url: 'https://a.example/v1', api_key: 'k', models });
  assert.throws(() => store.upsert('pi', { id: 'a', type: 'openai', base_url: 'https://a.example/v1', api_key: 'k', models }), /already exists/);
  store.setActive('pi', 'a');
  const file = store.injectionFor('pi').args[1]!;
  store.remove('pi', 'a');
  assert.equal(store.activeId('pi'), undefined);
  assert.deepEqual(store.injectionFor('pi'), { args: [], env: {} });
  await assert.rejects(stat(file));
}));

test('persists across instances with 0600 files', () => withStore(async (store, dir) => {
  store.upsert('codex', { id: 'r', type: 'openai_responses', base_url: 'https://r.example/v1', api_key: 'sk-r', models });
  const again = new ProviderStore(dir);
  assert.equal(again.injectionFor('codex').env.MAG_CODEX_KEY_R, 'sk-r');
  assert.equal((await stat(join(dir, 'providers', 'provider-keys.json'))).mode & 0o777, 0o600);
  const listed = await readFile(join(dir, 'providers', 'providers.json'), 'utf8');
  assert.ok(!listed.includes('sk-r'));
}));

test('active provider sets the default model ref; null falls back to the CLI default', () => withStore((store) => {
  store.upsert('grok', { id: 'a', type: 'openai', base_url: 'https://a.example/v1', api_key: 'k', models });
  assert.equal(store.defaultModelRef('grok'), undefined, 'adding a provider does not change the default');
  store.setActive('grok', 'a');
  assert.equal(store.defaultModelRef('grok'), '@a:gemini-3.8-flash');
  store.setActive('grok', null);
  assert.equal(store.defaultModelRef('grok'), undefined);
  assert.throws(() => store.setActive('grok', 'missing'), /not found/);
}));

test('forCli binds every helper to one CLI', () => withStore((store) => {
  store.upsert('pi', { id: 'relay', type: 'openai', base_url: 'https://relay.example/v1', api_key: 'sk-p', models });
  const view = store.forCli('pi');
  assert.equal(view.cli, 'pi');
  assert.deepEqual(view.catalog().map((p) => p.key), ['relay']);
  assert.equal(view.cliModelId('@relay:gemini-3.8-flash'), 'gw-relay/gemini-3.8-flash');
  assert.equal(view.cliProviderId('relay'), 'gw-relay');
  assert.equal(view.fingerprint(), store.catalogFingerprint('pi'));
}));

test('kimi providers auto-probe actual endpoints, normalize /v1 per protocol, cache results, and expose diagnostics', async () => {
  const { createServer } = await import('node:http');
  let probeHits = 0;
  const server = createServer((req, res) => {
    probeHits += 1;
    const url = req.url ?? '/';
    if (url.startsWith('/multi/v1/') && !url.includes('__mag_probe_')) {
      // Simulates relays like a9/avt supporting all 3 protocols.
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Missing model' } }));
      return;
    }
    if (url === '/ds/anthropic/v1/messages') {
      // Anthropic-compatible API mounted beside the OpenAI one (DeepSeek-style layout).
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error' } }));
      return;
    }
    if (url.startsWith('/ds/v1/')) {
      if (url.endsWith('/messages') || url.includes('__mag_probe_')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('Not Found');
        return;
      }
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'model required' }));
      return;
    }
    if (url.startsWith('/html/')) {
      // Front proxy that answers every path with an HTML auth page: proves nothing.
      res.writeHead(401, { 'content-type': 'text/html' });
      res.end('<html><head><title>401 Authorization Required</title></head></html>');
      return;
    }
    if (url.startsWith('/broke/v1/')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'INSUFFICIENT_BALANCE', message: 'Insufficient account balance' }));
      return;
    }
    if (url.startsWith('/any/')) {
      // Answers every path, made-up ones included, with the same JSON 400.
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
      return;
    }
    if (url.startsWith('/flaky/')) {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<html><head><title>502 Bad Gateway</title></head></html>');
      return;
    }
    if (url.startsWith('/cf/')) {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html><title>Attention Required! | Cloudflare</title></html>');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const payload = {
    providers: {
      a9: { baseUrl: `http://127.0.0.1:${port}/multi`, type: 'anthropic', apiKey: 'sk-a9' },
      ds: { baseUrl: `http://127.0.0.1:${port}/ds`, type: 'openai', apiKey: 'sk-ds' },
      cf: { baseUrl: `http://127.0.0.1:${port}/cf/v1`, type: 'openai', apiKey: 'sk-cf' },
      html: { baseUrl: `http://127.0.0.1:${port}/html`, type: 'anthropic', apiKey: 'sk-html' },
      broke: { baseUrl: `http://127.0.0.1:${port}/broke/v1`, type: 'openai', apiKey: 'sk-broke' },
      any: { baseUrl: `http://127.0.0.1:${port}/any/v1`, type: 'openai', apiKey: 'sk-any' },
      flaky: { baseUrl: `http://127.0.0.1:${port}/flaky/v1`, type: 'openai', apiKey: 'sk-flaky' },
    },
    models: {
      'a9/gemini-3.8-flash': { provider: 'a9', model: 'gemini-3.8-flash', maxContextSize: 1000000 },
      'ds/deepseek-chat': { provider: 'ds', model: 'deepseek-chat', maxContextSize: 64000 },
      'cf/gpt-5': { provider: 'cf', model: 'gpt-5', maxContextSize: 128000 },
      'html/m': { provider: 'html', model: 'm' },
      'broke/m': { provider: 'broke', model: 'm' },
      'any/m': { provider: 'any', model: 'm' },
      'flaky/m': { provider: 'flaky', model: 'm' },
    },
  };

  try {
    const dir = await mkdtemp(join(tmpdir(), 'mag-probe-cache-'));
    try {
      const source1 = new KimiProviderSource({
        home: '/nonexistent-kimi-home',
        run: async () => JSON.stringify(payload),
        probe: undefined,
      });
      // Constructor skipped default live probe when `run` is passed; test live HTTP probe via defaultProbeKimiProvider.
      const { defaultProbeKimiProvider } = await import('./provider-store.js');
      const liveProbed = new KimiProviderSource({
        home: '/nonexistent-kimi-home',
        run: async () => JSON.stringify(payload),
        probe: (t) => defaultProbeKimiProvider(t, 2_000),
      });
      const store = new ProviderStore(dir, { kimi: liveProbed });
      await store.ready(5_000);

      // a9 (declared anthropic) probed all 3 -> available in codex, claude, grok, pi, dsh!
      // ds (declared openai) also serves Anthropic under /anthropic -> joins claude too.
      // html/any/broke prove nothing, so they keep their declared type with a warning.
      assert.deepEqual(store.catalog('claude').map((p) => p.key).sort(), ['kimi.a9', 'kimi.ds', 'kimi.html']);
      assert.deepEqual(store.catalog('codex').map((p) => p.key).sort(), ['kimi.a9', 'kimi.ds']);
      assert.deepEqual(store.catalog('grok').map((p) => p.key).sort(), ['kimi.a9', 'kimi.any', 'kimi.broke', 'kimi.cf', 'kimi.ds', 'kimi.flaky']);
      assert.match(store.catalog('grok').find((p) => p.key === 'kimi.flaky')!.probe_warning ?? '', /502/, 'a 5xx page is a transient failure, not "unsupported"');

      const claudeDs = store.catalog('claude').find((p) => p.key === 'kimi.ds')!;
      assert.equal(claudeDs.base_url, `http://127.0.0.1:${port}/ds/anthropic`);
      assert.deepEqual(claudeDs.detected_types, ['openai', 'openai_responses', 'anthropic']);
      assert.equal(store.catalog('grok').find((p) => p.key === 'kimi.ds')!.base_url, `http://127.0.0.1:${port}/ds/v1`);

      const html = store.catalog('claude').find((p) => p.key === 'kimi.html')!;
      assert.equal(html.detected_types, undefined, 'HTML auth pages are not protocol evidence');
      assert.match(html.probe_warning ?? '', /未探测/);
      assert.match(store.catalog('grok').find((p) => p.key === 'kimi.broke')!.probe_warning ?? '', /余额/);
      assert.match(store.catalog('grok').find((p) => p.key === 'kimi.any')!.probe_warning ?? '', /任意路径/);

      // Check per-protocol URL resolution (multi without /v1 -> /v1 for OpenAI/Responses, stripped for Anthropic).
      const codexA9 = store.catalog('codex').find((p) => p.key === 'kimi.a9')!;
      assert.equal(codexA9.type, 'openai_responses');
      assert.equal(codexA9.base_url, `http://127.0.0.1:${port}/multi/v1`);
      const grokA9 = store.catalog('grok').find((p) => p.key === 'kimi.a9')!;
      assert.equal(grokA9.type, 'openai');
      assert.equal(grokA9.base_url, `http://127.0.0.1:${port}/multi/v1`);
      const claudeA9 = store.catalog('claude').find((p) => p.key === 'kimi.a9')!;
      assert.equal(claudeA9.type, 'anthropic');
      assert.equal(claudeA9.base_url, `http://127.0.0.1:${port}/multi`);

      // Cloudflare-blocked provider keeps declared type fallback + diagnostic warning.
      const cf = store.catalog('grok').find((p) => p.key === 'kimi.cf')!;
      assert.match(cf.probe_warning ?? '', /Cloudflare/i);

      // Cache file exists with 0600 permissions and contains no raw API keys; second store reuses cache with 0 probe hits.
      const cachePath = join(dir, 'providers', 'kimi-probe-cache.json');
      assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
      assert.ok(!(await readFile(cachePath, 'utf8')).includes('sk-a9'));

      const hitsBeforeReload = probeHits;
      const sourceCached = new KimiProviderSource({
        home: '/nonexistent-kimi-home',
        run: async () => JSON.stringify(payload),
        probe: (t) => defaultProbeKimiProvider(t, 2_000),
      });
      const store2 = new ProviderStore(dir, { kimi: sourceCached });
      await store2.ready(5_000);
      assert.equal(probeHits, hitsBeforeReload, 'second load reuses persisted probe cache');
      assert.deepEqual(store2.catalog('codex').map((p) => p.key).sort(), ['kimi.a9', 'kimi.ds']);

      void source1;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
