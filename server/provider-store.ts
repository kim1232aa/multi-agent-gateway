/**
 * provider-store: gateway-owned third-party providers injected into each CLI at spawn time.
 *
 * Zero-intrusion: nothing here writes a CLI's own config or credentials. A provider and its
 * key live under the gateway settings dir (0600); each CLI receives it through its documented
 * launch surface when the gateway starts that CLI's process:
 *   codex  `codex app-server -c model_providers.<id>.* -c model_provider=<id>` + env_key
 *   claude `--settings <gateway file>` with `env.ANTHROPIC_BASE_URL/AUTH_TOKEN` (flag layer
 *          outranks ~/.claude/settings.json; a process env var does not)
 *   grok   `GROK_MODELS_BASE_URL` + `XAI_API_KEY` + `GROK_CONFIG` models.default
 *   pi     `--extension <gateway file>` calling `pi.registerProvider()` with `apiKey: "$ENV"`
 *   dsh    `--patch <gateway file>` (YAML ⊇ JSON) adding an llm-pi-ai provider + acp default
 * Only processes started after a change pick it up; running sessions keep their provider.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export type InjectableCli = 'codex' | 'claude' | 'grok' | 'pi' | 'dsh';

/** Wire protocol names the Kimi Web provider form offers (Z4e in the bundle). */
export type WireProviderType = 'kimi' | 'openai' | 'openai_responses' | 'anthropic' | 'google-genai' | 'vertexai';

/** Which form protocols each CLI can actually speak through its injection surface (verified per CLI). */
export const SUPPORTED_TYPES: Record<InjectableCli, readonly WireProviderType[]> = {
  codex: ['openai_responses'],
  claude: ['anthropic'],
  grok: ['openai'],
  pi: ['openai', 'openai_responses', 'anthropic', 'google-genai'],
  dsh: ['openai', 'openai_responses', 'anthropic'],
};

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

/** Same id rule as the Kimi Web form (kR), so an id the form accepts is accepted here. */
const ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$/u;

const ModelSchema = z.object({
  model: z.string().trim().min(1).max(200),
  display_name: z.string().max(200).optional(),
  max_context_size: z.number().int().nonnegative().optional(),
  max_output_size: z.number().int().nonnegative().optional(),
  capabilities: z.array(z.string().max(64)).max(32).optional(),
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

function envKeyName(cli: InjectableCli, id: string): string {
  return `MAG_${cli.toUpperCase()}_KEY_${id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

/** Codex `-c` keys and model_provider ids must be bare TOML keys. */
function codexProviderKey(id: string): string {
  return `mag_${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** TOML literal for a `-c key=value` override (codex parses the value as TOML). */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

export class ProviderStore {
  private readonly file: string;
  private readonly keysFile: string;
  private readonly dir: string;
  private data: z.infer<typeof FileSchema> = { version: 1, providers: {}, active: {} };
  private keys: Record<string, string> = {};

  constructor(dir: string) {
    this.dir = join(dir, 'providers');
    this.file = join(this.dir, 'providers.json');
    this.keysFile = join(this.dir, 'provider-keys.json');
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
  }

  list(cli: InjectableCli): InjectedProvider[] {
    return [...(this.data.providers[cli] ?? [])];
  }

  get(cli: InjectableCli, id: string): InjectedProvider | undefined {
    return this.data.providers[cli]?.find((p) => p.id === id);
  }

  hasKey(cli: InjectableCli, id: string): boolean {
    return Boolean(this.keys[`${cli}/${id}`]);
  }

  activeId(cli: InjectableCli): string | undefined {
    const id = this.data.active[cli];
    return id && this.get(cli, id) ? id : undefined;
  }

  active(cli: InjectableCli): InjectedProvider | undefined {
    const id = this.activeId(cli);
    return id ? this.get(cli, id) : undefined;
  }

  setActive(cli: InjectableCli, id: string | null): void {
    if (id === null) delete this.data.active[cli];
    else {
      if (!this.get(cli, id)) throw new ProviderStoreError(404, `provider ${id} not found`);
      this.data.active[cli] = id;
    }
    this.persist();
    this.writeLaunchFiles(cli);
  }

  /** Create (no `existingId`) or update a provider; the saved provider becomes the CLI's active one. */
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
    this.data.active[cli] = id;
    this.persist();
    this.writeLaunchFiles(cli);
    return provider;
  }

  remove(cli: InjectableCli, id: string): void {
    const list = this.data.providers[cli] ?? [];
    if (!list.some((p) => p.id === id)) throw new ProviderStoreError(404, `provider ${id} not found`);
    this.data.providers[cli] = list.filter((p) => p.id !== id);
    delete this.keys[`${cli}/${id}`];
    if (this.data.active[cli] === id) delete this.data.active[cli];
    this.persist();
    this.writeLaunchFiles(cli);
  }

  /** What to add to a CLI's spawn: extra argv and env. Empty when no gateway provider is active. */
  injectionFor(cli: InjectableCli): Injection {
    const provider = this.active(cli);
    const key = provider ? this.keys[`${cli}/${provider.id}`] : undefined;
    if (!provider || !key) return EMPTY;
    const model = provider.default_model ?? provider.models[0]!.model;
    const envKey = envKeyName(cli, provider.id);
    switch (cli) {
      case 'codex': {
        const pid = codexProviderKey(provider.id);
        return {
          args: [
            '-c', `model_providers.${pid}.name=${tomlString(provider.id)}`,
            '-c', `model_providers.${pid}.base_url=${tomlString(provider.base_url)}`,
            '-c', `model_providers.${pid}.wire_api="responses"`,
            '-c', `model_providers.${pid}.env_key=${tomlString(envKey)}`,
            '-c', `model_provider=${tomlString(pid)}`,
            '-c', `model=${tomlString(model)}`,
          ],
          env: { [envKey]: key },
        };
      }
      case 'claude':
        return { args: ['--settings', this.launchFile('claude', 'json')], env: {} };
      case 'grok':
        return {
          args: [],
          env: {
            GROK_MODELS_BASE_URL: provider.base_url,
            XAI_API_KEY: key,
            GROK_CONFIG: JSON.stringify({ models: { default: model } }),
          },
        };
      case 'pi':
        return { args: ['--extension', this.launchFile('pi', 'ts')], env: { [envKey]: key } };
      case 'dsh':
        return { args: ['--patch', this.launchFile('dsh', 'yml')], env: { [envKey]: key } };
    }
  }

  /** Model id the CLI will see for the active provider (Pi prefixes the provider). */
  activeModelId(cli: InjectableCli): string | undefined {
    const provider = this.active(cli);
    if (!provider) return undefined;
    const model = provider.default_model ?? provider.models[0]!.model;
    return cli === 'pi' ? `${piProviderName(provider.id)}/${model}` : model;
  }

  private launchFile(cli: InjectableCli, ext: string): string {
    return join(this.dir, `inject.${cli}.${ext}`);
  }

  private persist(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    atomicWrite(this.file, JSON.stringify(this.data, null, 2));
    atomicWrite(this.keysFile, JSON.stringify(this.keys));
  }

  /** Rewrite (or delete) the per-CLI file a launch flag points at. */
  writeLaunchFiles(cli: InjectableCli): void {
    const provider = this.active(cli);
    const key = provider ? this.keys[`${cli}/${provider.id}`] : undefined;
    const ext = cli === 'claude' ? 'json' : cli === 'pi' ? 'ts' : cli === 'dsh' ? 'yml' : null;
    if (!ext) return;
    const file = this.launchFile(cli, ext);
    if (!provider || !key) {
      try { unlinkSync(file); } catch { /* ignore */ }
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const model = provider.default_model ?? provider.models[0]!.model;
    const envKey = envKeyName(cli, provider.id);
    if (cli === 'claude') {
      atomicWrite(file, JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: provider.base_url.replace(/\/v1\/?$/, ''),
          ANTHROPIC_AUTH_TOKEN: key,
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_MODEL: model,
        },
        model,
      }));
    } else if (cli === 'pi') {
      const api = PI_API[provider.type];
      const spec = {
        name: provider.id,
        baseUrl: provider.base_url,
        apiKey: `$${envKey}`,
        api,
        models: provider.models.map((m) => ({
          id: m.model,
          name: m.display_name ?? m.model,
          reasoning: (m.capabilities ?? []).includes('thinking'),
          input: (m.capabilities ?? []).includes('image_in') ? ['text', 'image'] : ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.max_context_size || 128000,
          maxTokens: m.max_output_size || 16384,
        })),
      };
      atomicWrite(file, [
        '// Generated by multi-agent-gateway: registers the gateway-managed provider for this Pi process only.',
        `export default function (pi: any) { pi.registerProvider(${JSON.stringify(piProviderName(provider.id))}, ${JSON.stringify(spec)}); }`,
        '',
      ].join('\n'));
    } else {
      const name = `gw_${provider.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
      atomicWrite(file, JSON.stringify([
        {
          id: 'llm-pi-ai',
          config: {
            providers: {
              [name]: {
                apiKeyEnv: envKey,
                displayName: provider.id,
                api: DSH_API[provider.type],
                baseURL: provider.type === 'anthropic' ? provider.base_url.replace(/\/v1\/?$/, '') : provider.base_url,
                models: provider.models.map((m) => ({
                  id: m.model,
                  displayName: m.display_name ?? m.model,
                  input: (m.capabilities ?? []).includes('image_in') ? ['text', 'image'] : ['text'],
                })),
              },
            },
          },
        },
        { id: 'acp', config: { provider: name, model } },
      ], null, 2));
    }
  }

  /** Regenerate every launch file (startup: keeps them in sync with providers.json). */
  syncLaunchFiles(): void {
    for (const cli of Object.keys(SUPPORTED_TYPES) as InjectableCli[]) {
      try { this.writeLaunchFiles(cli); } catch (err) {
        console.warn(`[providers] could not write ${cli} launch file: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

export function piProviderName(id: string): string {
  return `gw-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}
