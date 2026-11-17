/**
 * thinking-levels:各 CLI 的思考档位表,按 CLI 版本钉住。
 *
 * 为什么需要:同一家 CLI 的"档位"会随版本改变语义。最典型的是 Claude Code:
 * 2.1.284 起 `ultracode` 不再是 `--effort` 的一个档位,而是独立开关
 * (`--settings '{"ultracode":true}'`),保留当前档位不动。本机 2.1.325 的
 * `claude --help` 只列 `(low, medium, high, xhigh, max)`,可作佐证。
 * 把档位当成一组固定字符串去透传,会在版本变化后静默发错参数。
 *
 * 因此:档位表 + 最低版本一起声明;版本对不上时如实标为未核实,
 * 而不是假装同义。
 */

export type CliName = 'claude' | 'codex' | 'grok' | 'pi' | 'dsh';

export interface ThinkingProfile {
  /** 该 CLI 接受的档位,按从低到高排列。 */
  levels: readonly string[];
  /** 目录依据的版本。 */
  pinnedVersion: string;
  /** `off` 是否是一个真实档位(而非"不传参数")。 */
  hasOff: boolean;
  /** 是否存在一个独立于档位的 ultracode 开关(Claude 2.1.284+)。 */
  ultracode?: { since: string; settingsKey: string };
  /** 一句话说明这个表来自哪里。 */
  source: string;
}

export const THINKING_PROFILES: Readonly<Record<CliName, ThinkingProfile>> = {
  claude: {
    // `claude --help` 2.1.325: --effort (low, medium, high, xhigh, max)
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    pinnedVersion: '2.1.325',
    // off 不是档位:Web 端选 off 表示"不传 --effort",由 CLI 自己决定。
    hasOff: false,
    ultracode: { since: '2.1.284', settingsKey: 'ultracode' },
    source: 'claude --help 2.1.325; code.claude.com/docs model-config (ultracode 自 2.1.284 起为独立开关)',
  },
  codex: {
    // 实际可用档位随模型变化,由 model/list 的 supportedReasoningEfforts 给出;
    // 这里只保留兜底顺序。
    levels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    pinnedVersion: '0.169.0',
    hasOff: false,
    source: 'codex 0.169.0 app-server model/list supportedReasoningEfforts',
  },
  grok: {
    levels: ['low', 'medium', 'high', 'xhigh'],
    pinnedVersion: '1.0.77',
    hasOff: false,
    source: 'grok 1.0.77 --effort aliases',
  },
  pi: {
    // Pi 的档位来自模型自身的 thinking levels(RPC get_available_models),
    // 这里只是没有模型信息时的兜底。
    levels: ['off', 'minimal', 'low', 'medium', 'high'],
    pinnedVersion: '1.5.2',
    hasOff: true,
    source: 'pi 1.5.2 get_available_models thinking levels',
  },
  dsh: {
    levels: ['off', 'low', 'high', 'max'],
    pinnedVersion: '0.2.2-rc.1',
    hasOff: true,
    source: 'dsh 0.2.2-rc.1 llm-pi-ai reasoning_effort options',
  },
};

/** 版本是否满足 `since`(逐段数字比较,忽略预发布后缀)。 */
export function versionAtLeast(version: string | undefined, since: string): boolean {
  if (!version) return false;
  const parse = (v: string): number[] => v.split(/[-+]/)[0]!.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const a = parse(version);
  const b = parse(since);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * 该 CLI 此刻真正可用的档位。
 * `cliVersion` 缺失时返回 null:不猜,交给调用方按"未核实"处理。
 */
export function levelsFor(
  cli: CliName,
  cliVersion: string | undefined,
  modelLevels?: readonly string[],
): { levels: readonly string[]; verified: boolean } | null {
  const profile = THINKING_PROFILES[cli];
  const verified = Boolean(cliVersion && cliVersion.startsWith(profile.pinnedVersion));
  // 模型自报的档位永远优先:它比任何静态表都准。
  if (modelLevels && modelLevels.length > 0) return { levels: modelLevels, verified: true };
  if (!cliVersion) return null;
  return { levels: profile.levels, verified };
}

/** 该版本是否支持独立的 ultracode 开关。 */
export function supportsUltracode(cli: CliName, cliVersion: string | undefined): boolean {
  const toggle = THINKING_PROFILES[cli].ultracode;
  if (!toggle) return false;
  return versionAtLeast(cliVersion, toggle.since);
}

/**
 * `--effort` 的值:ultracode 不是档位,选它就是"当前档位 + 开关",
 * 绝不能把 `ultracode` 当 effort 传给 CLI(2.1.325 会拒绝)。
 */
export function effortArgument(cli: CliName, thinking: string | undefined): string | undefined {
  if (!thinking) return undefined;
  const profile = THINKING_PROFILES[cli];
  if (thinking === 'off' || thinking === 'on' || thinking === 'auto') return undefined;
  if (thinking === 'ultracode') return undefined;
  return profile.levels.includes(thinking) ? thinking : undefined;
}

/** `--settings` 里要合并的 ultracode 开关(仅 Claude,且仅 >= 2.1.284)。 */
export function ultracodeSettings(
  cli: CliName,
  thinking: string | undefined,
  cliVersion: string | undefined,
): Record<string, unknown> | undefined {
  if (thinking !== 'ultracode') return undefined;
  const toggle = THINKING_PROFILES[cli].ultracode;
  if (!toggle || !versionAtLeast(cliVersion, toggle.since)) return undefined;
  return { [toggle.settingsKey]: true };
}

/** 前端可见的档位 DTO:附带 verified 与 ultracode 是否可用。 */
export function thinkingProfileDto(
  cli: CliName,
  cliVersion: string | undefined,
  modelLevels?: readonly string[],
): Record<string, unknown> {
  const resolved = levelsFor(cli, cliVersion, modelLevels);
  const profile = THINKING_PROFILES[cli];
  return {
    levels: resolved?.levels ?? [],
    ...(resolved ? { verified: resolved.verified } : {}),
    pinned_version: profile.pinnedVersion,
    ...(profile.ultracode
      ? { ultracode: supportsUltracode(cli, cliVersion), ultracode_since: profile.ultracode.since }
      : {}),
  };
}
