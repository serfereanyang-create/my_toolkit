import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Tiered model dispatch — resolve "expensive" / "cheap" tiers to concrete
 * provider configurations.
 *
 * The /省钱分级 command used to be prompt-only: the model was told to "use a
 * cheap model for the mechanical work" but had no way to actually switch
 * models, so every tier ran on the same provider. This module makes the tiers
 * real by reading the same provider registry the CLI is configured from
 * (~/.zcode/v2/config.json) and returning a ready-to-use override.
 */

export type DispatchTier = 'expensive' | 'cheap';

/** One provider entry as stored in the v2 config file. */
type V2ProviderEntry = {
  name?: string;
  kind?: string;
  enabled?: boolean;
  options?: { apiKey?: string; baseURL?: string };
  models?: Record<string, unknown>;
};

export type ResolvedTier = {
  tier: DispatchTier;
  /** Provider display name (as shown in the settings UI). */
  providerName: string;
  /** Provider protocol the CLI should speak. */
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** Context window when the config knows it; used for cheap-tier prompts. */
  contextWindow?: number;
};

export type TierSelection = {
  expensive?: string;
  cheap?: string;
};

const V2_CONFIG_PATH = join(homedir(), '.zcode', 'v2', 'config.json');

/** Map a v2 `kind` onto the CLI's provider names. */
function providerNameForKind(kind: string | undefined): string {
  switch ((kind ?? '').toLowerCase()) {
    case 'anthropic':
      return 'anthropic';
    case 'gemini':
    case 'google':
      return 'gemini';
    case 'openai-responses':
      return 'openai-responses';
    default:
      return 'openai';
  }
}

function readV2Providers(configPath = V2_CONFIG_PATH): Record<string, V2ProviderEntry> {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      provider?: Record<string, V2ProviderEntry>;
    };
    return parsed.provider ?? {};
  } catch {
    return {};
  }
}

/**
 * Normalize a model id for matching: case-insensitive, `_`/`.`/`-` equivalent.
 * Users type "glm-5.3-flash" and the registry may hold "GLM-5.3-Flash".
 */
function normalizeModelId(value: string): string {
  return value.toLowerCase().replace(/[_.]/g, '-');
}

type Candidate = { providerName: string; entry: V2ProviderEntry; model: string };

function candidates(providers: Record<string, V2ProviderEntry>): Candidate[] {
  const out: Candidate[] = [];
  for (const [id, entry] of Object.entries(providers)) {
    if (entry.enabled === false) continue;
    const providerName = entry.name ?? id;
    const models = entry.models ? Object.keys(entry.models) : [];
    for (const model of models) out.push({ providerName, entry, model });
  }
  // A model name often exists under several providers and some of them have no
  // credentials (e.g. GLM-5.3 under both BigModel-Coding-Plan with an empty
  // apiKey and Z.ai with a real one). Dispatching to the keyless entry fails
  // authentication at request time, so credentialed providers must win the
  // match. Stable within each group, so an explicit `provider/model` selector
  // still resolves exactly as written.
  return out.sort((a, b) => {
    const aKey = a.entry.options?.apiKey ? 1 : 0;
    const bKey = b.entry.options?.apiKey ? 1 : 0;
    return bKey - aKey;
  });
}

/**
 * Resolve a user-written selector to a concrete tier.
 *
 * Accepted selector forms (all case-insensitive):
 *   `glm-5.3-flash`            model name, any provider
 *   `hc/glm-5.3-flash`         provider name + model
 *   `hc/*`                     first model of that provider
 */
export function resolveTierSelector(
  selector: string,
  tier: DispatchTier,
  configPath?: string,
): ResolvedTier | { error: string } {
  const raw = selector.trim();
  if (!raw) return { error: `缺少${tier === 'expensive' ? '贵' : '便宜'}档配置。` };
  const providers = readV2Providers(configPath);
  const all = candidates(providers);
  if (all.length === 0) return { error: '读不到 ~/.zcode/v2/config.json 里的提供商配置。' };

  const slash = raw.indexOf('/');
  const wantedProvider = slash > 0 ? raw.slice(0, slash).trim() : null;
  const wantedModel = slash > 0 ? raw.slice(slash + 1).trim() : raw;
  const modelKey = normalizeModelId(wantedModel);

  let pool = all;
  if (wantedProvider) {
    const pKey = normalizeModelId(wantedProvider);
    pool = pool.filter((c) => normalizeModelId(c.providerName) === pKey);
    if (pool.length === 0) return { error: `找不到提供商「${wantedProvider}」。` };
  }

  let match = pool.find((c) => normalizeModelId(c.model) === modelKey);
  if (!match && wantedModel === '*') match = pool[0];
  if (!match) {
    // Substring fallback keeps `glm-5.3` usable when the registry lists
    // `GLM-5.3-Flash` variants; exact matches above always win.
    const loose = pool.filter((c) => normalizeModelId(c.model).includes(modelKey));
    if (loose.length === 1) match = loose[0];
  }
  if (!match) return { error: `找不到模型「${wantedModel}」。` };

  const entry = match.entry;
  const modelMeta = (entry.models?.[match.model] ?? {}) as { limit?: { context?: number } };
  return {
    tier,
    providerName: match.providerName,
    provider: providerNameForKind(entry.kind),
    model: match.model,
    baseUrl: entry.options?.baseURL,
    apiKey: entry.options?.apiKey,
    contextWindow: modelMeta.limit?.context,
  };
}

export type ResolvedTiers = { expensive: ResolvedTier; cheap: ResolvedTier };

/**
 * Resolve both tiers, refusing combinations that defeat the point: the cheap
 * tier must not be the same model as the expensive one, otherwise the dispatch
 * only adds overhead without saving anything.
 */
export function resolveTiers(
  selection: TierSelection,
  configPath?: string,
): ResolvedTiers | { error: string } {
  if (!selection.expensive) return { error: '缺少贵档配置：请给 贵=<模型名> 或 贵=<提供商>/<模型名>。' };
  if (!selection.cheap) return { error: '缺少便宜档配置：请给 便宜=<模型名> 或 便宜=<提供商>/<模型名>。' };

  const expensive = resolveTierSelector(selection.expensive, 'expensive', configPath);
  if ('error' in expensive) return { error: `贵档：${expensive.error}` };
  const cheap = resolveTierSelector(selection.cheap, 'cheap', configPath);
  if ('error' in cheap) return { error: `便宜档：${cheap.error}` };

  if (normalizeModelId(expensive.model) === normalizeModelId(cheap.model)
    && expensive.providerName === cheap.providerName) {
    return { error: '贵档和便宜档指向同一个模型，分级调度没有意义。' };
  }
  return { expensive, cheap };
}

/** One line for the status row the command prints before dispatching. */
export function describeTier(tier: ResolvedTier): string {
  return `${tier.providerName}/${tier.model}`;
}

/**
 * Global default tier selection, as saved by the desktop settings page.
 *
 * Read from the desktop app's settings.json: it is the same machine and the
 * same user, and keeping one file means the two surfaces cannot disagree
 * about what "the default" is. A malformed or missing file simply means no
 * default — never an error the caller has to handle.
 */
export function readGlobalDispatchDefault(settingsPath?: string): TierSelection | null {
  const file = settingsPath ?? join(homedir(), 'AppData', 'Roaming', 'cc-desktop-ide', 'settings.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
      preferences?: { dispatchDefault?: TierSelection };
    };
    const selection = parsed.preferences?.dispatchDefault;
    if (!selection?.expensive || !selection?.cheap) return null;
    return { expensive: selection.expensive, cheap: selection.cheap };
  } catch {
    return null;
  }
}
