/**
 * provider-store: third-party providers the gateway hands to each CLI at launch.
 *
 * Two sources feed one catalog per CLI:
 *   gateway  providers added in the Web UI, stored under the gateway settings dir (0600);
 *   kimi     providers Kimi Code already has, read through `kimi provider list --json`
 *            (read-only; keys stay in memory and reach a CLI only through its launch surface).
 * A provider joins a CLI's catalog only when that CLI can speak its protocol.
 *
 * Zero-intrusion: nothing here writes a CLI's own config or credentials. Each CLI gets the
 * catalog through its documented launch surface when the gateway starts its process:
 *   codex  `-c model_providers.<id>.*` + env_key for every provider; the CLI default (its own
 *          login) stays the default and a thread picks a provider via `modelProvider`
 *   claude one provider per process: `--settings <gateway file>` with env.ANTHROPIC_* (the
 *          flag layer outranks ~/.claude/settings.json; a process env var does not); every
 *          model alias and the subagent model are pinned too (see claudeModelPins)
 *   grok   one provider per process: `GROK_MODELS_BASE_URL` + `XAI_API_KEY`, and a `GROK_CONFIG`
 *          overlay pinning Grok's side-request models to one the relay serves
 *   pi     `--extension <gateway file>` calling `pi.registerProvider()` per provider, `$ENV` keys
 *   dsh    `--patch <gateway file>` declaring every provider under llm-pi-ai, `apiKeyEnv` keys;
 *          dsh-acp merges it into the user's own llm-pi-ai config first (see dsh-patch.ts)
 * A model outside the CLI's own catalog is addressed as `@<provider key>:<model>`.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export type InjectableCli = 'codex' | 'claude' | 'grok' | 'pi' | 'dsh';

const CLIS: readonly InjectableCli[] = ['codex', 'claude', 'grok', 'pi', 'dsh'];

/** Wire protocol names the Kimi Web provider form offers (Z4e in the bundle). */
export type WireProviderType = 'kimi' | 'openai' | 'openai_responses' | 'anthropic' | 'google-genai' | 'vertexai';

/**
 * Which protocols each CLI can actually speak through its injection surface (verified per CLI).
 * Grok's `responses`/`messages` backends exist, but only as `[model.*]` tables, which the
 * `GROK_CONFIG` overlay drops (user-guide/05-configuration.md allowlist); without editing
 * ~/.grok/config.toml the reachable surface is `GROK_MODELS_BASE_URL`, i.e. chat completions.
 */
export const SUPPORTED_TYPES: Record<InjectableCli, readonly WireProviderType[]> = {
  codex: ['openai_responses'],
  claude: ['anthropic'],
  grok: ['openai'],
  pi: ['openai', 'openai_responses', 'anthropic', 'google-genai'],
  dsh: ['openai', 'openai_responses', 'anthropic'],
};

/** CLIs whose provider is fixed per process: a model from another provider needs another process. */
export const PROCESS_SCOPED: ReadonlySet<InjectableCli> = new Set(['claude', 'grok']);

const PI_API: Partial<Record<WireProviderType, string>> = {
  openai: 'openai-completions',
  openai_responses: 'openai-responses',
  anthropic: 'anthropic-messages',
  'google-genai': 'google-generative-ai',
};

const DSH_API: Partial<Record<WireProviderType, string>> = {
  openai: 'openai-completions',
  openai_responses: 'openai-responses',
  anthropic: 'anthropic-messages',
};

/** Pi and DSH share these thinking level names (pi docs/rpc-commands.md, dsh-llm-pi-ai THINKING_LEVELS). */
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Codex ships these provider ids; a gateway provider must not silently replace one. */
const CODEX_RESERVED = new Set(['openai', 'oss', 'ollama', 'lmstudio', 'amazon-bedrock']);

/** Same id rule as the Kimi Web form (kR), so an id the form accepts is accepted here. */
const ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$/u;

const ModelSchema = z.object({
  model: z.string().trim().min(1).max(200),
  display_name: z.string().max(200).optional(),
  max_context_size: z.number().int().nonnegative().optional(),
  max_output_size: z.number().int().nonnegative().optional(),
  capabilities: z.array(z.string().max(64)).max(32).optional(),
  support_efforts: z.array(z.string().max(32)).max(16).optional(),
  default_effort: z.string().max(32).optional(),
});

const ProviderSchema = z.object({
  id: z.string().regex(ID_RE).max(64),
  type: z.enum(['kimi', 'openai', 'openai_responses', 'anthropic', 'google-genai', 'vertexai']),
  base_url: z.string().url().max(2000),
  default_model: z.string().max(200).optional(),
  models: z.array(ModelSchema).min(1).max(200),
});

const FileSchema = z.object({
  version: z.literal(1),
  providers: z.record(z.string(), z.array(ProviderSchema)),
  active: z.record(z.string(), z.string()),
});

export type InjectedModel = z.infer<typeof ModelSchema>;
export type InjectedProvider = z.infer<typeof ProviderSchema>;
export type ProviderSource = 'gateway' | 'kimi';

/** One provider in a CLI's catalog. Never carries the key: safe to hand to adapters and DTOs. */
export interface CatalogProvider {
  /** Catalog key, unique per CLI: the gateway id, or `kimi.<id>` for a Kimi provider. */
  key: string;
  source: ProviderSource;
  /** The id in its own source. */
  id: string;
  /** Grouping label for the model picker. */
  label: string;
  type: WireProviderType;
  base_url: string;
  models: InjectedModel[];
  default_model?: string;
  /** Protocols verified to respond on this endpoint (Kimi source probing). */
  detected_types?: WireProviderType[];
  /** Non-fatal diagnostic from endpoint probing (e.g. Cloudflare 403 or 401). */
  probe_warning?: string;
}

interface ResolvedProvider extends CatalogProvider {
  apiKey: string;
  protocols?: Partial<Record<WireProviderType, string>>;
}

export interface ProviderInput {
  id?: unknown;
  new_id?: unknown;
  type?: unknown;
  base_url?: unknown;
  api_key?: unknown;
  default_model?: unknown;
  models?: unknown;
}

export class ProviderStoreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface Injection {
  args: string[];
  env: Record<string, string>;
}

const EMPTY: Injection = { args: [], env: {} };

/** `@<provider key>:<model>` — how a catalog model is addressed in the gateway. */
export function encodeModelRef(key: string, model: string): string {
  return `@${key}:${model}`;
}

export function parseModelRef(id: string | undefined | null): { key: string; model: string } | null {
  if (typeof id !== 'string') return null;
  const m = /^@([^:]+):(.+)$/s.exec(id.trim());
  return m ? { key: m[1]!, model: m[2]! } : null;
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
    try { chmodSync(path, 0o600); } catch { /* ignore */ }
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function slug(value: string, allowed: RegExp): string {
  return value.replace(allowed, '_');
}

function stripV1(url: string): string {
  return url.replace(/\/v1\/?$/, '');
}

/** Normalize a provider's base_url for a concrete wire protocol (`/v1` for OpenAI/Responses, stripped for Anthropic). */
export function baseUrlForWireType(baseUrl: string, wireType: WireProviderType): string {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  if (wireType === 'anthropic') return stripV1(clean);
  if (wireType === 'openai' || wireType === 'openai_responses') {
    try {
      const u = new URL(clean);
      const pathname = u.pathname.replace(/\/+$/, '');
      if (!pathname) return `${clean}/v1`;
      return clean;
    } catch {
      return clean;
    }
  }
  return clean;
}

/**
 * Claude Code resolves its aliases (opus/sonnet/haiku/fable), background work and subagents
 * through these variables (code.claude.com/docs/en/model-config). Pinning all of them keeps every
 * request on a model the relay serves, even when ~/.claude/settings.json sets them for another
 * endpoint (the `--settings` layer wins over the user file).
 */
export function claudeModelPins(model: string): Record<string, string> {
  return {
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
  };
}

/**
 * Grok's side requests (session titles/summaries, image description, prompt suggestions,
 * web_search) default to xAI model ids, which a relay does not serve. `GROK_CONFIG` is Grok's
 * documented overlay for ACP launchers (user-guide/05-configuration.md, `models` is allowlisted).
 */
function grokModelPins(model: string): string {
  return JSON.stringify({
    models: { session_summary: model, image_description: model, prompt_suggestion: model, web_search: model },
  });
}

function thinkingLevels(m: InjectedModel): string[] {
  const offered = new Set(m.support_efforts ?? []);
  return THINKING_LEVELS.filter((level) => offered.has(level));
}

function hasThinking(m: InjectedModel): boolean {
  return (m.capabilities ?? []).includes('thinking') || (m.support_efforts?.length ?? 0) > 0;
}

function inputModes(m: InjectedModel): string[] {
  return (m.capabilities ?? []).includes('image_in') ? ['text', 'image'] : ['text'];
}

// ---------------------------------------------------------------------------
// Kimi source: `kimi provider list --json`, read-only, refreshed when config.toml changes.
// ---------------------------------------------------------------------------

export interface KimiProtocolSupport {
  type: WireProviderType;
  base_url: string;
}

export interface KimiProbeReport {
  supported: KimiProtocolSupport[];
  blocked_reason?: string;
  checked_at: number;
}

export type KimiProbeFn = (target: {
  id: string;
  declaredType: WireProviderType;
  baseUrl: string;
  apiKey: string;
}) => Promise<KimiProbeReport>;

export interface KimiProviderSourceOptions {
  bin?: string;
  home?: string;
  /** Replace the CLI call (tests). Must resolve to the command's stdout. */
  run?: () => Promise<string>;
  timeoutMs?: number;
  /** Replace or disable (`false`) protocol endpoint probing; defaults to live HTTP probing when `run` is not mocked. */
  probe?: KimiProbeFn | false;
  probeTimeoutMs?: number;
  cacheFile?: string;
}

const PROBE_OK_TTL_MS = 6 * 60 * 60_000;
const PROBE_WARN_TTL_MS = 10 * 60_000;
/** Bumped when the probe logic changes, so cached verdicts from older logic are not reused. */
const PROBE_VERSION = 'v2';
type HttpProbeType = 'openai' | 'openai_responses' | 'anthropic';
const HTTP_PROBE_TYPES: readonly HttpProbeType[] = ['openai', 'openai_responses', 'anthropic'];
const PROBE_SUFFIX: Record<HttpProbeType, string> = {
  openai: '/chat/completions',
  openai_responses: '/responses',
  anthropic: '/v1/messages',
};
const BALANCE_RE = /insufficient|balance|quota|credit|余额|欠费/i;
const CLOUDFLARE_RE = /cloudflare|attention required|just a moment|error code: 10\d\d/i;

type ProbeOutcome = 'supported' | 'unsupported' | 'blocked';

/**
 * The CLIs reach providers through the user's HTTP(S)_PROXY, so the probe must too: relays
 * behind Cloudflare often block the direct egress IP and admit the proxy one. Global `fetch`
 * ignores those variables unless NODE_USE_ENV_PROXY is set; an agent with `proxyEnv`
 * (Node ≥ 22.21 / 24.5) honours HTTP(S)_PROXY and NO_PROXY per request. Older Node ignores
 * the option and connects directly.
 */
let probeAgents: { http: HttpAgent; https: HttpsAgent } | undefined;

function probeAgentFor(protocol: string): HttpAgent | HttpsAgent {
  probeAgents ??= {
    http: new HttpAgent({ proxyEnv: process.env }),
    https: new HttpsAgent({ proxyEnv: process.env }),
  };
  return protocol === 'https:' ? probeAgents.https : probeAgents.http;
}

function probePost(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(target, {
      method: 'POST',
      headers: { ...headers, 'content-length': '2' },
      agent: probeAgentFor(target.protocol),
      signal: AbortSignal.timeout(timeoutMs),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (body.length < 4096) body += chunk;
      });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        contentType: String(res.headers['content-type'] ?? ''),
        body: body.slice(0, 4096),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end('{}');
  });
}

function looksLikeJson(contentType: string, body: string): boolean {
  if (/json/i.test(contentType)) return true;
  const t = body.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try { JSON.parse(body); return true; } catch { return false; }
}

/**
 * POST `{}` and read the verdict from the reply. Only a JSON reply proves an API answered:
 * reverse proxies and web front-ends answer unknown paths with HTML 401/404/200 pages, which
 * say nothing about the protocol.
 */
async function probeSingleWireEndpoint(
  url: string,
  protocol: HttpProbeType,
  apiKey: string,
  timeoutMs: number,
): Promise<{ outcome: ProbeOutcome; warning?: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
  if (protocol === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }
  let status: number;
  let contentType: string;
  let body: string;
  try {
    ({ status, contentType, body } = await probePost(url, headers, timeoutMs));
  } catch {
    return { outcome: 'blocked', warning: '探测超时或网络不可达' };
  }
  if (status === 404 || status === 405 || status === 501) return { outcome: 'unsupported' };
  const json = looksLikeJson(contentType, body);
  if (!json) {
    if (status === 403 && CLOUDFLARE_RE.test(body)) {
      return {
        outcome: 'blocked',
        warning: '站点防火墙拦截了网关的探测请求 (HTTP 403，常见原因是出口 IP 或 User-Agent)，协议未验证；CLI 走自己的网络和代理，可能不受影响',
      };
    }
    if (status >= 500) return { outcome: 'blocked', warning: `上游暂时不可用 (HTTP ${status})` };
    return { outcome: 'unsupported' };
  }
  if (status >= 200 && status < 300) return { outcome: 'supported' };
  if (status === 400 || status === 422) return { outcome: 'supported' };
  if (status === 402 || ((status === 403 || status === 429) && BALANCE_RE.test(body))) {
    return { outcome: 'supported', warning: `账户余额不足 (HTTP ${status})` };
  }
  if (status === 429) return { outcome: 'supported', warning: '被限流 (HTTP 429)' };
  if (status === 401) return { outcome: 'blocked', warning: 'API Key 未授权 (HTTP 401)' };
  if (status === 403) return { outcome: 'blocked', warning: 'HTTP 403 访问被拒' };
  return { outcome: 'blocked', warning: `HTTP ${status}` };
}

/**
 * Base URLs to try for one protocol, most likely first. OpenAI-style endpoints live at the
 * configured path (or under `/v1`). Anthropic-compatible endpoints are often mounted beside the
 * OpenAI one under an `anthropic` segment, so every ancestor of the configured path is tried
 * both bare and with `/anthropic` appended. No vendor names: any relay following the
 * convention is found.
 */
function probeBases(clean: string, protocol: HttpProbeType): string[] {
  const out: string[] = [];
  const add = (u: string) => { if (!out.includes(u)) out.push(u); };
  if (protocol !== 'anthropic') {
    const primary = baseUrlForWireType(clean, protocol);
    add(primary);
    if (!/\/v\d+$/.test(primary)) add(`${stripV1(primary)}/v1`);
    return out;
  }
  let url: URL;
  try { url = new URL(clean); } catch { return [stripV1(clean)]; }
  const segments = url.pathname.replace(/\/+$/, '').replace(/\/v\d+$/i, '').split('/').filter(Boolean);
  for (let depth = segments.length; depth >= 0; depth--) {
    const prefix = `${url.origin}${segments.slice(0, depth).map((s) => `/${s}`).join('')}`;
    add(prefix);
    if (segments[depth - 1]?.toLowerCase() !== 'anthropic') add(`${prefix}/anthropic`);
  }
  return out.slice(0, 6);
}

export async function defaultProbeKimiProvider(
  target: { baseUrl: string; apiKey: string },
  timeoutMs = 3_500,
): Promise<KimiProbeReport> {
  const clean = target.baseUrl.trim().replace(/\/+$/, '');
  // Control request: a server that answers a made-up path with a "supported" verdict would make
  // every real probe meaningless, so its 4xx replies cannot be trusted.
  const control = await probeSingleWireEndpoint(
    `${baseUrlForWireType(clean, 'openai')}/__mag_probe_${randomBytes(4).toString('hex')}`,
    'openai',
    target.apiKey,
    timeoutMs,
  );
  if (control.outcome === 'supported') {
    const reason = control.warning?.includes('余额')
      ? control.warning
      : '该地址对任意路径都返回相同响应，无法判定协议，按声明类型使用';
    return { supported: [], blocked_reason: reason, checked_at: Date.now() };
  }
  const tasks = HTTP_PROBE_TYPES.map(async (protocol) => {
    const bases = probeBases(clean, protocol);
    const results = await Promise.all(bases.map((base) =>
      probeSingleWireEndpoint(`${base}${PROBE_SUFFIX[protocol]}`, protocol, target.apiKey, timeoutMs)));
    const hit = results.findIndex((r) => r.outcome === 'supported');
    if (hit >= 0) return { protocol, base: bases[hit]!, ...results[hit]! };
    return { protocol, base: bases[0]!, ...(results.find((r) => r.outcome === 'blocked') ?? results[0]!) };
  });

  const results = await Promise.all(tasks);
  const supported: KimiProtocolSupport[] = [];
  const warnings: string[] = [];
  for (const r of results) {
    if (r.outcome === 'supported') supported.push({ type: r.protocol, base_url: r.base });
    if (r.warning && !warnings.includes(r.warning)) warnings.push(r.warning);
  }
  const blocked_reason = supported.length === 0
    ? (warnings[0] ?? '未探测到可用的协议接口，按声明类型使用')
    : warnings.find((w) => w.includes('余额') || w.includes('限流'));
  return {
    supported,
    ...(blocked_reason ? { blocked_reason } : {}),
    checked_at: Date.now(),
  };
}

/** Turn the `kimi provider list --json` payload into providers; drops ones without a usable key. */
export function parseKimiProviderList(raw: unknown): Array<Omit<ResolvedProvider, 'key' | 'label' | 'source'> & { id: string }> {
  if (!raw || typeof raw !== 'object') return [];
  const root = raw as { providers?: unknown; models?: unknown };
  const providers = root.providers && typeof root.providers === 'object' ? root.providers as Record<string, unknown> : {};
  const models = root.models && typeof root.models === 'object' ? root.models as Record<string, unknown> : {};
  const byProvider = new Map<string, InjectedModel[]>();
  for (const value of Object.values(models)) {
    if (!value || typeof value !== 'object') continue;
    const m = value as Record<string, unknown>;
    const provider = typeof m.provider === 'string' ? m.provider : '';
    const model = typeof m.model === 'string' ? m.model.trim() : '';
    if (!provider || !model) continue;
    const overrides = m.overrides && typeof m.overrides === 'object' ? m.overrides as Record<string, unknown> : {};
    const defaultEffort = typeof overrides.defaultEffort === 'string'
      ? overrides.defaultEffort
      : typeof m.defaultEffort === 'string' ? m.defaultEffort : undefined;
    const parsed = ModelSchema.safeParse({
      model,
      ...(typeof m.displayName === 'string' && m.displayName ? { display_name: m.displayName } : {}),
      ...(typeof m.maxContextSize === 'number' && m.maxContextSize > 0 ? { max_context_size: Math.floor(m.maxContextSize) } : {}),
      ...(typeof m.maxOutputSize === 'number' && m.maxOutputSize > 0 ? { max_output_size: Math.floor(m.maxOutputSize) } : {}),
      ...(Array.isArray(m.capabilities) ? { capabilities: m.capabilities.filter((c): c is string => typeof c === 'string') } : {}),
      ...(Array.isArray(m.supportEfforts) ? { support_efforts: m.supportEfforts.filter((c): c is string => typeof c === 'string') } : {}),
      ...(defaultEffort ? { default_effort: defaultEffort } : {}),
    });
    if (!parsed.success) continue;
    const list = byProvider.get(provider) ?? [];
    if (!list.some((x) => x.model === parsed.data.model)) list.push(parsed.data);
    byProvider.set(provider, list);
  }
  const out: Array<Omit<ResolvedProvider, 'key' | 'label' | 'source'> & { id: string }> = [];
  for (const [id, value] of Object.entries(providers)) {
    if (!value || typeof value !== 'object') continue;
    const p = value as Record<string, unknown>;
    const type = p.type;
    const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '';
    const apiKey = typeof p.apiKey === 'string' ? p.apiKey.trim() : '';
    const list = byProvider.get(id) ?? [];
    if (!ID_RE.test(id) || !baseUrl || !apiKey || /[\r\n\0]/.test(apiKey) || list.length === 0) continue;
    if (typeof type !== 'string' || !(ProviderSchema.shape.type.options as readonly string[]).includes(type)) continue;
    try { new URL(baseUrl); } catch { continue; }
    out.push({ id, type: type as WireProviderType, base_url: baseUrl, models: list, apiKey });
  }
  return out;
}

export class KimiProviderSource {
  private readonly bin: string;
  private readonly configFile: string;
  private readonly run: () => Promise<string>;
  private readonly probeFn: KimiProbeFn | null;
  private cacheFile: string | undefined;
  private cacheLoaded = false;
  private readonly probeCache = new Map<string, KimiProbeReport>();
  private providers: ResolvedProvider[] = [];
  private seenMtime: number | null = null;
  private inflight: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  /** Last load failure, shown in diagnostics; the previous snapshot stays in use. */
  error: string | undefined;

  constructor(options: KimiProviderSourceOptions = {}) {
    const home = options.home ?? process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code');
    const defaultBin = join(homedir(), '.kimi-code', 'bin', 'kimi');
    this.bin = options.bin ?? process.env.KIMI_BIN ?? (existsSync(defaultBin) ? defaultBin : 'kimi');
    this.configFile = join(home, 'config.toml');
    const timeout = options.timeoutMs ?? 15_000;
    this.run = options.run ?? (() => new Promise<string>((resolve, reject) => {
      execFile(this.bin, ['provider', 'list', '--json'], { timeout, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    }));
    const probeTimeout = options.probeTimeoutMs ?? 3_500;
    if (options.probe === false) {
      this.probeFn = null;
    } else if (typeof options.probe === 'function') {
      this.probeFn = options.probe;
    } else if (options.run) {
      this.probeFn = null;
    } else {
      this.probeFn = (target) => defaultProbeKimiProvider(target, probeTimeout);
    }
    this.cacheFile = options.cacheFile;
  }

  /** Attach a gateway-owned cache file for probe results (never writes inside ~/.kimi-code). */
  setCacheFile(file: string): void {
    if (this.cacheFile === file) return;
    this.cacheFile = file;
    this.cacheLoaded = false;
  }

  private ensureCacheLoaded(): void {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    if (!this.cacheFile) return;
    try {
      const raw = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      for (const [k, v] of Object.entries(raw)) {
        if (!v || typeof v !== 'object') continue;
        const entry = v as Partial<KimiProbeReport>;
        if (!Array.isArray(entry.supported) || typeof entry.checked_at !== 'number') continue;
        this.probeCache.set(k, {
          supported: entry.supported.filter((s): s is KimiProtocolSupport =>
            Boolean(s && typeof s.type === 'string' && typeof s.base_url === 'string')),
          ...(typeof entry.blocked_reason === 'string' ? { blocked_reason: entry.blocked_reason } : {}),
          checked_at: entry.checked_at,
        });
      }
    } catch { /* missing or corrupt cache: re-probe cleanly */ }
  }

  private saveCache(): void {
    if (!this.cacheFile) return;
    try {
      const obj = Object.fromEntries(this.probeCache.entries());
      mkdirSync(join(this.cacheFile, '..'), { recursive: true, mode: 0o700 });
      atomicWrite(this.cacheFile, JSON.stringify(obj, null, 2));
    } catch { /* best-effort cache */ }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): readonly ResolvedProvider[] {
    this.refreshIfStale();
    return this.providers;
  }

  /** Reload when Kimi's config.toml changed since the last load (cheap stat, async reload). */
  refreshIfStale(): void {
    let mtime: number;
    try { mtime = statSync(this.configFile).mtimeMs; } catch { mtime = 0; }
    if (mtime === this.seenMtime || this.inflight) return;
    void this.refresh().catch(() => undefined);
  }

  refresh(forceProbe = false): Promise<void> {
    if (this.inflight) {
      if (!forceProbe) return this.inflight;
      return this.inflight.catch(() => undefined).then(() => this.refresh(true));
    }
    let mtime: number;
    try { mtime = statSync(this.configFile).mtimeMs; } catch { mtime = 0; }
    this.inflight = this.run()
      .then(async (stdout) => {
        const before = fingerprint(this.providers);
        const parsed = parseKimiProviderList(JSON.parse(stdout));
        const probeFn = this.probeFn;
        let cacheDirty = false;
        const liveKeys = new Set<string>();
        if (probeFn) this.ensureCacheLoaded();

        const nextProviders = await Promise.all(parsed.map(async (p) => {
          const baseProto: Partial<Record<WireProviderType, string>> = {
            [p.type]: baseUrlForWireType(p.base_url, p.type),
          };
          if (!probeFn) {
            return {
              ...p,
              key: `kimi.${p.id}`,
              label: `kimi.${p.id}`,
              source: 'kimi' as const,
              protocols: baseProto,
            };
          }
          const cacheKey = createHash('sha256')
            .update(`${PROBE_VERSION}\0${p.id}\0${p.type}\0${p.base_url}\0${p.apiKey}`)
            .digest('hex');
          liveKeys.add(cacheKey);
          const cached = !forceProbe ? this.probeCache.get(cacheKey) : undefined;
          const now = Date.now();
          const ttl = cached && (cached.blocked_reason || cached.supported.length === 0) ? PROBE_WARN_TTL_MS : PROBE_OK_TTL_MS;
          let report: KimiProbeReport;
          if (cached && now - cached.checked_at < ttl) {
            report = cached;
          } else {
            report = await probeFn({
              id: p.id,
              declaredType: p.type,
              baseUrl: p.base_url,
              apiKey: p.apiKey,
            }).catch(() => ({ supported: [], checked_at: now }));
            this.probeCache.set(cacheKey, report);
            cacheDirty = true;
          }

          const protocols: Partial<Record<WireProviderType, string>> = {};
          for (const item of report.supported) {
            protocols[item.type] = item.base_url;
          }
          if (p.type === 'google-genai' || p.type === 'vertexai') {
            protocols[p.type] = baseUrlForWireType(p.base_url, p.type);
          }
          if (Object.keys(protocols).length === 0) {
            protocols[p.type] = baseUrlForWireType(p.base_url, p.type);
          }
          const detectedTypes = report.supported.length > 0
            ? report.supported.map((s) => s.type)
            : undefined;
          return {
            ...p,
            key: `kimi.${p.id}`,
            label: `kimi.${p.id}`,
            source: 'kimi' as const,
            protocols,
            ...(detectedTypes ? { detected_types: detectedTypes } : {}),
            ...(report.blocked_reason ? { probe_warning: report.blocked_reason } : {}),
          };
        }));

        if (probeFn) {
          for (const key of [...this.probeCache.keys()]) {
            if (!liveKeys.has(key)) {
              this.probeCache.delete(key);
              cacheDirty = true;
            }
          }
        }
        if (cacheDirty) this.saveCache();
        this.providers = nextProviders;
        this.error = undefined;
        this.seenMtime = mtime;
        if (fingerprint(this.providers) !== before) for (const fn of this.listeners) fn();
      })
      .catch((err: unknown) => {
        this.error = err instanceof Error ? err.message : String(err);
        this.seenMtime = mtime;
        throw err;
      })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }
}

function fingerprint(list: readonly ResolvedProvider[]): string {
  const h = createHash('sha256');
  for (const p of list) {
    h.update(JSON.stringify([p.key, p.type, p.base_url, p.models, p.default_model ?? '', p.detected_types ?? [], p.probe_warning ?? '']));
    h.update(createHash('sha256').update(p.apiKey).digest('hex'));
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// ProviderStore
// ---------------------------------------------------------------------------

export interface ProviderStoreOptions {
  /** Kimi Code providers to reuse; `null` turns the Kimi source off. */
  kimi?: KimiProviderSource | null;
}

export class ProviderStore {
  private readonly file: string;
  private readonly keysFile: string;
  private readonly dir: string;
  private readonly kimi: KimiProviderSource | null;
  private data: z.infer<typeof FileSchema> = { version: 1, providers: {}, active: {} };
  private keys: Record<string, string> = {};
  private readonly listeners = new Set<(cli: InjectableCli) => void>();
  private readonly lastPrint = new Map<InjectableCli, string>();

  constructor(dir: string, options: ProviderStoreOptions = {}) {
    this.dir = join(dir, 'providers');
    this.file = join(this.dir, 'providers.json');
    this.keysFile = join(this.dir, 'provider-keys.json');
    this.kimi = options.kimi ?? null;
    this.kimi?.setCacheFile(join(this.dir, 'kimi-probe-cache.json'));
    try {
      const parsed = FileSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (parsed.success) this.data = parsed.data;
      else console.warn(`[providers] ${this.file} is not a valid provider list; starting empty`);
    } catch { /* missing: empty */ }
    try {
      const raw = JSON.parse(readFileSync(this.keysFile, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') this.keys[k] = v;
      }
    } catch { /* missing: empty */ }
    for (const cli of CLIS) this.lastPrint.set(cli, fingerprint(this.resolved(cli)));
    this.kimi?.onChange(() => this.emitChanges());
  }

  /** Wait for the first Kimi load (bounded); the catalog works without it. */
  async ready(timeoutMs = 20_000): Promise<void> {
    if (!this.kimi) return;
    const load = this.kimi.refresh().catch(() => undefined);
    await Promise.race([load, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.())]);
    for (const cli of CLIS) this.lastPrint.set(cli, fingerprint(this.resolved(cli)));
  }

  async refreshKimi(forceProbe = false): Promise<void> {
    if (!this.kimi) return;
    await this.kimi.refresh(forceProbe).catch(() => undefined);
    this.emitChanges();
  }

  kimiError(): string | undefined {
    return this.kimi?.error;
  }

  /** Called with the CLI whose catalog changed (gateway edit or Kimi config change). */
  onChange(listener: (cli: InjectableCli) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChanges(): void {
    for (const cli of CLIS) {
      const print = fingerprint(this.resolved(cli));
      if (this.lastPrint.get(cli) === print) continue;
      this.lastPrint.set(cli, print);
      this.writeLaunchFiles(cli);
      for (const fn of this.listeners) fn(cli);
    }
  }

  // -- gateway-managed providers (Web UI CRUD) --------------------------------

  list(cli: InjectableCli): InjectedProvider[] {
    return [...(this.data.providers[cli] ?? [])];
  }

  get(cli: InjectableCli, id: string): InjectedProvider | undefined {
    return this.data.providers[cli]?.find((p) => p.id === id);
  }

  hasKey(cli: InjectableCli, id: string): boolean {
    return Boolean(this.keys[`${cli}/${id}`]);
  }

  /** Provider whose default model new sessions use; undefined = the CLI's own default. */
  activeId(cli: InjectableCli): string | undefined {
    const id = this.data.active[cli];
    return id && this.provider(cli, id) ? id : undefined;
  }

  setActive(cli: InjectableCli, key: string | null): void {
    if (key === null) delete this.data.active[cli];
    else {
      if (!this.provider(cli, key)) throw new ProviderStoreError(404, `provider ${key} not found`);
      this.data.active[cli] = key;
    }
    this.persist();
  }

  /** Default model ref for new sessions, from the active provider; undefined = CLI default. */
  defaultModelRef(cli: InjectableCli): string | undefined {
    const key = this.activeId(cli);
    const p = key ? this.provider(cli, key) : undefined;
    if (!p) return undefined;
    return encodeModelRef(p.key, p.default_model ?? p.models[0]!.model);
  }

  /** Create (no `existingId`) or update a gateway provider. */
  upsert(cli: InjectableCli, input: ProviderInput, existingId?: string): InjectedProvider {
    const current = existingId !== undefined ? this.get(cli, existingId) : undefined;
    if (existingId !== undefined && !current) throw new ProviderStoreError(404, `provider ${existingId} not found`);
    const id = String(
      (existingId !== undefined ? (input.new_id ?? existingId) : input.id) ?? '',
    ).trim();
    const type = input.type ?? current?.type;
    if (typeof type === 'string' && !(SUPPORTED_TYPES[cli] as readonly string[]).includes(type)) {
      throw new ProviderStoreError(
        400,
        `${cli} cannot use a "${type}" provider; supported: ${SUPPORTED_TYPES[cli].join(', ')}`,
      );
    }
    const models = Array.isArray(input.models)
      ? input.models.map((m) => {
          const row = (m ?? {}) as Record<string, unknown>;
          return {
            model: row.model,
            ...(typeof row.display_name === 'string' && row.display_name ? { display_name: row.display_name } : {}),
            ...(row.max_context_size !== undefined ? { max_context_size: Number(row.max_context_size) } : {}),
            ...(row.max_output_size !== undefined ? { max_output_size: Number(row.max_output_size) } : {}),
            ...(Array.isArray(row.capabilities) ? { capabilities: row.capabilities } : {}),
            ...(Array.isArray(row.support_efforts) ? { support_efforts: row.support_efforts } : {}),
            ...(typeof row.default_effort === 'string' && row.default_effort ? { default_effort: row.default_effort } : {}),
          };
        })
      : current?.models;
    const candidate = {
      id,
      type,
      base_url: typeof input.base_url === 'string' ? input.base_url.trim() : current?.base_url,
      ...(typeof input.default_model === 'string' && input.default_model.trim()
        ? { default_model: input.default_model.trim() }
        : current?.default_model ? { default_model: current.default_model } : {}),
      models,
    };
    const parsed = ProviderSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ProviderStoreError(400, `invalid provider: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const provider = parsed.data;
    if (provider.default_model && !provider.models.some((m) => m.model === provider.default_model)) {
      throw new ProviderStoreError(400, `default_model ${provider.default_model} is not in models`);
    }
    const list = this.data.providers[cli] ?? [];
    if (id !== existingId && list.some((p) => p.id === id)) {
      throw new ProviderStoreError(409, `provider ${id} already exists`);
    }
    const apiKey = typeof input.api_key === 'string' ? input.api_key.trim() : '';
    if (/[\r\n\0]/.test(apiKey)) throw new ProviderStoreError(400, 'invalid api_key');
    const oldKeyName = existingId !== undefined ? `${cli}/${existingId}` : undefined;
    const keyName = `${cli}/${id}`;
    const nextKey = apiKey || (oldKeyName ? this.keys[oldKeyName] : undefined);
    if (!nextKey) throw new ProviderStoreError(400, 'api_key is required');

    const nextList = list.filter((p) => p.id !== existingId);
    nextList.push(provider);
    this.data.providers[cli] = nextList;
    if (oldKeyName && oldKeyName !== keyName) delete this.keys[oldKeyName];
    this.keys[keyName] = nextKey;
    if (existingId !== undefined && this.data.active[cli] === existingId) this.data.active[cli] = id;
    this.persist();
    this.emitChanges();
    return provider;
  }

  remove(cli: InjectableCli, id: string): void {
    const list = this.data.providers[cli] ?? [];
    if (!list.some((p) => p.id === id)) throw new ProviderStoreError(404, `provider ${id} not found`);
    this.data.providers[cli] = list.filter((p) => p.id !== id);
    delete this.keys[`${cli}/${id}`];
    if (this.data.active[cli] === id) delete this.data.active[cli];
    this.persist();
    this.emitChanges();
  }

  // -- catalog ----------------------------------------------------------------

  private resolved(cli: InjectableCli): ResolvedProvider[] {
    const supported = SUPPORTED_TYPES[cli];
    const out: ResolvedProvider[] = [];
    for (const p of this.data.providers[cli] ?? []) {
      const apiKey = this.keys[`${cli}/${p.id}`];
      if (!apiKey || !(supported as readonly string[]).includes(p.type)) continue;
      out.push({
        ...p,
        base_url: baseUrlForWireType(p.base_url, p.type),
        key: p.id,
        label: p.id,
        source: 'gateway',
        apiKey,
      });
    }
    for (const p of this.kimi?.snapshot() ?? []) {
      const protocols = p.protocols ?? { [p.type]: baseUrlForWireType(p.base_url, p.type) };
      const chosenType = (supported as readonly string[]).includes(p.type) && protocols[p.type] !== undefined
        ? p.type
        : supported.find((t) => protocols[t] !== undefined);
      if (!chosenType) continue;
      out.push({
        ...p,
        type: chosenType,
        base_url: protocols[chosenType]!,
      });
    }
    return out;
  }

  /** Providers this CLI can use, gateway first. Contains no keys. */
  catalog(cli: InjectableCli): CatalogProvider[] {
    return this.resolved(cli).map(({ apiKey: _key, protocols: _protocols, ...rest }) => rest);
  }

  provider(cli: InjectableCli, key: string): CatalogProvider | undefined {
    return this.catalog(cli).find((p) => p.key === key);
  }

  /** Change marker for a CLI's catalog; adapters respawn processes when it moves. */
  catalogFingerprint(cli: InjectableCli): string {
    return fingerprint(this.resolved(cli));
  }

  /** The id this provider has inside the CLI (`modelProvider`, Pi provider, DSH route). */
  cliProviderId(cli: InjectableCli, key: string): string | undefined {
    return this.namesFor(cli).get(key)?.cliId;
  }

  private namesFor(cli: InjectableCli): Map<string, { cliId: string; envKey: string }> {
    const used = new Set<string>();
    const usedEnv = new Set<string>();
    const unique = (base: string, set: Set<string>): string => {
      let name = base;
      for (let i = 2; set.has(name); i++) name = `${base}_${i}`;
      set.add(name);
      return name;
    };
    const names = new Map<string, { cliId: string; envKey: string }>();
    for (const p of this.resolved(cli)) {
      const tag = p.source === 'kimi' ? 'KIMI' : 'KEY';
      const envKey = unique(`MAG_${cli.toUpperCase()}_${tag}_${slug(p.id, /[^A-Za-z0-9]/g).toUpperCase()}`, usedEnv);
      let cliId: string;
      if (cli === 'codex') {
        const base = slug(p.id, /[^A-Za-z0-9_-]/g);
        cliId = p.source === 'kimi' ? `kimi_${base}` : CODEX_RESERVED.has(base) ? `mag_${base}` : base;
      } else if (cli === 'pi') {
        const base = p.id.replace(/[^A-Za-z0-9_-]/g, '-');
        cliId = p.source === 'kimi' ? `mag-kimi-${base}` : `gw-${base}`;
      } else if (cli === 'dsh') {
        const base = slug(p.id, /[^A-Za-z0-9_-]/g);
        cliId = p.source === 'kimi' ? `mag_kimi_${base}` : `gw_${base}`;
      } else {
        cliId = p.key;
      }
      names.set(p.key, { cliId: unique(cliId, used), envKey });
    }
    return names;
  }

  /**
   * What to add to a CLI spawn. Codex, Pi and DSH get every provider at once (a session
   * picks one by id). Claude and Grok get exactly the provider `key` names, or nothing —
   * which leaves the CLI on its own login and config.
   */
  injectionFor(cli: InjectableCli, key?: string): Injection {
    const list = this.resolved(cli);
    const names = this.namesFor(cli);
    if (cli === 'claude' || cli === 'grok') {
      const p = key ? list.find((x) => x.key === key) : undefined;
      if (!p) return EMPTY;
      if (cli === 'grok') {
        return {
          args: [],
          env: {
            GROK_MODELS_BASE_URL: p.base_url,
            XAI_API_KEY: p.apiKey,
            GROK_CONFIG: grokModelPins(p.default_model ?? p.models[0]!.model),
          },
        };
      }
      return { args: ['--settings', this.writeClaudeSettings(p)], env: {} };
    }
    if (list.length === 0) return EMPTY;
    const env: Record<string, string> = {};
    for (const p of list) env[names.get(p.key)!.envKey] = p.apiKey;
    if (cli === 'codex') {
      const args: string[] = [];
      for (const p of list) {
        const { cliId, envKey } = names.get(p.key)!;
        args.push(
          '-c', `model_providers.${cliId}.name=${JSON.stringify(p.label)}`,
          '-c', `model_providers.${cliId}.base_url=${JSON.stringify(p.base_url)}`,
          '-c', `model_providers.${cliId}.wire_api="responses"`,
          '-c', `model_providers.${cliId}.env_key=${JSON.stringify(envKey)}`,
        );
      }
      return { args, env };
    }
    const file = this.writeLaunchFiles(cli);
    if (!file) return EMPTY;
    return { args: [cli === 'pi' ? '--extension' : '--patch', file], env };
  }

  private launchFile(cli: InjectableCli, ext: string): string {
    return join(this.dir, `inject.${cli}.${ext}`);
  }

  private persist(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    atomicWrite(this.file, JSON.stringify(this.data, null, 2));
    atomicWrite(this.keysFile, JSON.stringify(this.keys));
  }

  /** Claude's `--settings` file for one provider (the only launch surface that outranks ~/.claude). */
  private writeClaudeSettings(p: ResolvedProvider): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tag = createHash('sha256').update(p.key).digest('hex').slice(0, 12);
    const file = join(this.dir, `inject.claude.${tag}.json`);
    const model = p.default_model ?? p.models[0]!.model;
    atomicWrite(file, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: stripV1(p.base_url),
        ANTHROPIC_AUTH_TOKEN: p.apiKey,
        ANTHROPIC_API_KEY: '',
        ...claudeModelPins(model),
      },
      model,
    }));
    return file;
  }

  /** Rewrite (or delete) the Pi extension / DSH patch for a CLI. Returns the file, if any. */
  writeLaunchFiles(cli: InjectableCli): string | undefined {
    if (cli === 'claude') {
      this.pruneClaudeFiles();
      return undefined;
    }
    if (cli !== 'pi' && cli !== 'dsh') return undefined;
    const file = this.launchFile(cli, cli === 'pi' ? 'ts' : 'yml');
    const list = this.resolved(cli);
    if (list.length === 0) {
      try { unlinkSync(file); } catch { /* ignore */ }
      return undefined;
    }
    const names = this.namesFor(cli);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (cli === 'pi') {
      const calls = list.map((p) => {
        const { cliId, envKey } = names.get(p.key)!;
        const anthropic = p.type === 'anthropic';
        const spec = {
          name: p.label,
          baseUrl: anthropic ? stripV1(p.base_url) : p.base_url,
          apiKey: `$${envKey}`,
          api: PI_API[p.type],
          models: p.models.map((m) => {
            const reasoning = hasThinking(m);
            const levels = thinkingLevels(m);
            return {
              id: m.model,
              name: m.display_name ?? m.model,
              reasoning,
              input: inputModes(m),
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: m.max_context_size || 128000,
              maxTokens: m.max_output_size || 16384,
              ...(reasoning && levels.length > 0
                ? { thinkingLevelMap: Object.fromEntries(THINKING_LEVELS.map((l) => [l, levels.includes(l) ? l : null])) }
                : {}),
            };
          }),
        };
        return `  pi.registerProvider(${JSON.stringify(cliId)}, ${JSON.stringify(spec)});`;
      });
      atomicWrite(file, [
        '// Generated by multi-agent-gateway: registers gateway and Kimi providers for this Pi process only.',
        'export default function (pi: any) {',
        ...calls,
        '}',
        '',
      ].join('\n'));
      return file;
    }
    const providers: Record<string, unknown> = {};
    for (const p of list) {
      const { cliId, envKey } = names.get(p.key)!;
      providers[cliId] = {
        apiKeyEnv: envKey,
        displayName: p.label,
        api: DSH_API[p.type],
        baseURL: p.type === 'anthropic' ? stripV1(p.base_url) : p.base_url,
        models: p.models.map((m) => {
          const levels = thinkingLevels(m);
          return {
            id: m.model,
            name: m.display_name ?? m.model,
            input: inputModes(m),
            ...(m.max_context_size ? { contextWindow: m.max_context_size } : {}),
            ...(m.max_output_size ? { maxTokens: m.max_output_size } : {}),
            ...(!hasThinking(m)
              ? { reasoningEfforts: false }
              : levels.length > 0 ? { reasoningEfforts: Object.fromEntries(levels.map((l) => [l, l])) } : {}),
          };
        }),
      };
    }
    atomicWrite(file, JSON.stringify([{ id: 'llm-pi-ai', config: { providers } }], null, 2));
    return file;
  }

  /** Drop Claude settings files of providers that left the catalog (they hold keys). */
  private pruneClaudeFiles(): void {
    const keep = new Set(this.resolved('claude').map((p) => `inject.claude.${createHash('sha256').update(p.key).digest('hex').slice(0, 12)}.json`));
    let entries: string[] = [];
    try { entries = readdirSync(this.dir); } catch { return; }
    for (const name of entries) {
      if (/^inject\.claude\.(?:[0-9a-f]{12}\.)?json$/.test(name) && !keep.has(name)) {
        try { unlinkSync(join(this.dir, name)); } catch { /* ignore */ }
      }
    }
  }

  /** Regenerate every launch file (startup: keeps them in sync with the catalog). */
  syncLaunchFiles(): void {
    for (const cli of CLIS) {
      try { this.writeLaunchFiles(cli); } catch (err) {
        console.warn(`[providers] could not write ${cli} launch file: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * The model id a CLI itself uses for a catalog ref: Pi `<provider>/<model>`, DSH's ACP option
   * value `["<route>","<model>"]`, otherwise the bare model (Codex/Claude/Grok pick the provider
   * per thread or per process). Undefined when the ref is not in this CLI's catalog.
   */
  cliModelId(cli: InjectableCli, ref: string): string | undefined {
    const parsed = parseModelRef(ref);
    if (!parsed) return undefined;
    const p = this.provider(cli, parsed.key);
    if (!p) return undefined;
    const cliId = this.cliProviderId(cli, p.key)!;
    if (cli === 'pi') return `${cliId}/${parsed.model}`;
    if (cli === 'dsh') return JSON.stringify([cliId, parsed.model]);
    return parsed.model;
  }

  /** Reverse of {@link cliProviderId}: which catalog provider a CLI-side provider id belongs to. */
  keyForCliProvider(cli: InjectableCli, cliId: string): string | undefined {
    for (const [key, names] of this.namesFor(cli)) if (names.cliId === cliId) return key;
    return undefined;
  }

  /** A CLI-bound view handed to one adapter. */
  forCli(cli: InjectableCli): CliProviders {
    return {
      cli,
      catalog: () => this.catalog(cli),
      provider: (key) => this.provider(cli, key),
      injection: (key) => this.injectionFor(cli, key),
      cliProviderId: (key) => this.cliProviderId(cli, key),
      keyForCliProvider: (cliId) => this.keyForCliProvider(cli, cliId),
      cliModelId: (ref) => this.cliModelId(cli, ref),
      fingerprint: () => this.catalogFingerprint(cli),
      defaultModelRef: () => this.defaultModelRef(cli),
    };
  }
}

/**
 * What an adapter sees of the provider catalog. Model refs look like `@<key>:<model>`
 * (see {@link encodeModelRef}); a model id without that shape belongs to the CLI itself.
 */
export interface CliProviders {
  readonly cli: InjectableCli;
  /** Providers this CLI can use (gateway first, then Kimi). No keys. */
  catalog(): CatalogProvider[];
  provider(key: string): CatalogProvider | undefined;
  /**
   * Spawn additions. Codex/Pi/DSH: all providers, ignore `key`. Claude/Grok: only `key`'s
   * provider; no key (or unknown key) = empty = the CLI's own login and config.
   */
  injection(key?: string): Injection;
  /** Provider id inside the CLI: Codex `modelProvider`, Pi provider name, DSH route. */
  cliProviderId(key: string): string | undefined;
  keyForCliProvider(cliId: string): string | undefined;
  /** The CLI's own model id for a ref (Pi `p/m`, DSH option value, else bare model). */
  cliModelId(ref: string): string | undefined;
  /** Changes whenever the catalog or a key changes; respawn long-lived processes on change. */
  fingerprint(): string;
  /** Default model ref for new sessions (from the active provider); undefined = CLI default. */
  defaultModelRef(): string | undefined;
}
