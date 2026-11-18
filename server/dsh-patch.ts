/**
 * DSH patch layers replace an entry's whole `config` (dsh-app-boot README: "replace one entry's
 * whole config (restating the fields you keep)"), and a second `dsh-llm-pi-ai` instance cannot
 * be mounted (it re-registers pi-ai's catalog: "configurable provider ... is already declared").
 * So the gateway's providers have to be merged into the user's own `llm-pi-ai` config.
 *
 * The user's config is read through DSH's own read-only `--dump-config` (without the gateway
 * overlay) and parsed with the js-yaml copy and `!!js` type DSH itself uses, so expressions in
 * the user's layer survive verbatim. Nothing under the user's DSH home is written.
 */

import { execFile } from 'node:child_process';
import { realpathSync, renameSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const PI_AI_ENTRY = 'llm-pi-ai';

interface YamlLib {
  Type: new (tag: string, options: Record<string, unknown>) => unknown;
  JSON_SCHEMA: { extend(types: unknown): unknown };
  load(text: string, options: { schema: unknown }): unknown;
  dump(value: unknown, options: { schema: unknown; lineWidth?: number; noRefs?: boolean }): string;
}

function isJsExpr(value: unknown): boolean {
  return value instanceof Object && '__jsExpr' in value;
}

function dshYaml(dshBin: string): { yaml: YamlLib; schema: unknown } | null {
  try {
    const yaml = createRequire(realpathSync(dshBin))('js-yaml') as YamlLib;
    const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: (data: unknown) => typeof data === 'string',
      construct: (data: string) => ({ __jsExpr: data }),
      predicate: isJsExpr,
      represent: (data: { __jsExpr: string }) => data.__jsExpr,
    });
    return { yaml, schema: yaml.JSON_SCHEMA.extend(JsExpr) };
  } catch {
    return null;
  }
}

/**
 * The user's `llm-pi-ai` config plus the gateway providers. User routes win on a name clash and
 * every other field of the user's config is kept.
 */
export function mergePiAiConfig(
  userConfig: unknown,
  gatewayProviders: Record<string, unknown>,
): Record<string, unknown> {
  const base = userConfig && typeof userConfig === 'object' && !Array.isArray(userConfig) && !isJsExpr(userConfig)
    ? { ...(userConfig as Record<string, unknown>) }
    : {};
  const own = base.providers && typeof base.providers === 'object' && !Array.isArray(base.providers) && !isJsExpr(base.providers)
    ? base.providers as Record<string, unknown>
    : undefined;
  if (base.providers !== undefined && !own) {
    throw new Error('llm-pi-ai.providers is not a plain mapping');
  }
  return { ...base, providers: { ...gatewayProviders, ...(own ?? {}) } };
}

/** Find the `llm-pi-ai` row in a dumped entry list (rows may be nested in groups). */
function findEntry(list: unknown, id: string): Record<string, unknown> | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;
    if (entry.id === id) return entry;
    const nested = findEntry(entry.config, id);
    if (nested) return nested;
  }
  return undefined;
}

function dumpConfig(dshBin: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(dshBin, ['--profile', 'acp', '--dump-config'], {
      env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/**
 * Write `<gatewayPatch>.merged.yml`: the gateway's `llm-pi-ai` providers merged into the user's.
 * Returns the merged patch path, or throws when the user's config cannot be read — the caller
 * must then skip the gateway providers rather than replace the user's.
 */
export async function composeDshProviderPatch(
  dshBin: string,
  gatewayPatch: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 10_000,
): Promise<string> {
  const lib = dshYaml(dshBin);
  if (!lib) throw new Error(`cannot load js-yaml from the dsh installation at ${dshBin}`);
  const gateway = JSON.parse(readFileSync(gatewayPatch, 'utf8')) as Array<{ id?: string; config?: { providers?: Record<string, unknown> } }>;
  const providers = gateway.find((row) => row.id === PI_AI_ENTRY)?.config?.providers ?? {};
  const composed = lib.yaml.load(await dumpConfig(dshBin, env, timeoutMs), { schema: lib.schema });
  const entry = findEntry(composed, PI_AI_ENTRY);
  if (!entry) throw new Error(`the acp profile has no ${PI_AI_ENTRY} entry`);
  const merged = mergePiAiConfig(entry.config, providers);
  const out = gatewayPatch.replace(/(\.ya?ml)?$/, '.merged.yml');
  const text = lib.yaml.dump([{ id: PI_AI_ENTRY, config: merged }], { schema: lib.schema, lineWidth: -1, noRefs: true });
  const tmp = `${out}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, out);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  return out;
}
