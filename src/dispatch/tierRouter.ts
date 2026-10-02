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

/**
 * Dispatch tiers, ordered from most to least capable.
 *
 * `standard` sits between them for work that is neither an architecture
 * decision (expensive) nor pure mechanical labour (cheap): ordinary feature
 * work that needs some judgement but not the top model.
 */
export type DispatchTier = 'expensive' | 'standard' | 'cheap';

/** Human-facing names, used in status lines and the settings UI. */
export const DISPATCH_TIER_LABELS: Record<DispatchTier, string> = {
  expensive: '贵档',
  standard: '中档',
  cheap: '便宜档',
};

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

/**
 * One tier's configured models, in preference order.
 *
 * The first entry is the primary; the rest are fallbacks used when the
 * primary fails (rate limit, quota exhausted, auth error). A single string is
 * accepted anywhere for backwards compatibility with the older one-model form.
 */
export type TierModelList = string | string[];

export type TierSelection = {
  expensive?: TierModelList;
  standard?: TierModelList;
  cheap?: TierModelList;
};

/** Normalize the accepted shapes into a plain ordered list. */
export function tierModelList(value: TierModelList | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => String(entry).trim()).filter(Boolean);
}

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

type Candidate = { providerId: string; providerName: string; entry: V2ProviderEntry; model: string };

function candidates(providers: Record<string, V2ProviderEntry>): Candidate[] {
  const out: Candidate[] = [];
  for (const [id, entry] of Object.entries(providers)) {
    if (entry.enabled === false) continue;
    const providerName = entry.name ?? id;
    const models = entry.models ? Object.keys(entry.models) : [];
    for (const model of models) out.push({ providerId: id, providerName, entry, model });
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
    // Match the display label OR the config id: several providers can share a
    // label (three "新供应商" entries is normal), so the id is the only
    // unambiguous handle. Both forms are accepted so a selector copied from
    // the UI keeps working.
    pool = pool.filter((c) => normalizeModelId(c.providerName) === pKey || normalizeModelId(c.providerId) === pKey);
    // A stale prefix must not sink the whole tier: earlier versions stored the
    // DESKTOP provider label ("新供应商"), which never matches a v2 entry. If
    // the model name alone resolves unambiguously, use it and let the caller
    // report the substitution rather than failing the dispatch.
    if (pool.length === 0) {
      const byModel = all.filter((c) => normalizeModelId(c.model) === modelKey);
      if (byModel.length === 0) return { error: `找不到提供商「${wantedProvider}」。` };
      pool = byModel;
    }
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

export type ResolvedTiers = Partial<Record<DispatchTier, ResolvedTier[]>>;

/** Tiers in capability order — used for validation and display. */
export const TIER_ORDER: DispatchTier[] = ['expensive', 'standard', 'cheap'];

/** Chinese short key accepted on the command line → tier id. */
export const TIER_KEY_TO_ID: Record<string, DispatchTier> = {
  贵: 'expensive',
  中: 'standard',
  便宜: 'cheap',
};

/**
 * Resolve every configured tier.
 *
 * Each tier accepts one model or an ordered list (primary first, then
 * fallbacks). A tier with no configuration is simply absent from the result —
 * callers fall back to the parent model rather than failing, because a user
 * may legitimately only fill in two of the three tiers.
 */
export function resolveTiers(
  selection: TierSelection,
  configPath?: string,
): ResolvedTiers | { error: string } {
  const resolved: Partial<Record<DispatchTier, ResolvedTier[]>> = {};

  for (const tier of TIER_ORDER) {
    const raw = selection[tier];
    if (!raw) continue;
    const selectors = Array.isArray(raw) ? raw.filter(Boolean) : [raw];
    if (selectors.length === 0) continue;

    const chain: ResolvedTier[] = [];
    for (const selector of selectors) {
      const one = resolveTierSelector(selector, tier, configPath);
      if ('error' in one) {
        // A broken fallback must not sink the whole tier: the primary may
        // still work, and silently dropping the tier would be worse.
        if (chain.length === 0) return { error: `${DISPATCH_TIER_LABELS[tier]}：${one.error}` };
        continue;
      }
      chain.push(one);
    }
    if (chain.length > 0) resolved[tier] = chain;
  }

  if (Object.keys(resolved).length === 0) {
    return { error: '至少配置一个档位：贵=<模型> / 中=<模型> / 便宜=<模型>。' };
  }
  return resolved as ResolvedTiers;
}

/** One line for the status row the command prints before dispatching. */
export function describeTier(tier: ResolvedTier): string {
  return `${tier.providerName}/${tier.model}`;
}

export type TierOption = {
  /** Value to store and pass back: "providerId/model". */
  value: string;
  /** Human label for the picker: "provider name · model". */
  label: string;
  providerId: string;
  providerName: string;
  model: string;
  contextWindow?: number;
  hasKey: boolean;
};

/**
 * Every model the tier router can actually dispatch to, for the UI pickers.
 *
 * Sourced from the same v2 config the resolver reads, so an option shown in
 * the UI is guaranteed to resolve. This is deliberately NOT the desktop
 * settings provider list: that is a separate registry whose labels
 * ("新供应商") do not correspond to anything the router can look up.
 */
export function listTierOptions(configPath?: string): TierOption[] {
  const providers = readV2Providers(configPath);
  return candidates(providers).map((c) => {
    const modelMeta = (c.entry.models?.[c.model] ?? {}) as { limit?: { context?: number } };
    return {
      value: `${c.providerId}/${c.model}`,
      label: `${c.providerName} · ${c.model}`,
      providerId: c.providerId,
      providerName: c.providerName,
      model: c.model,
      contextWindow: modelMeta.limit?.context,
      hasKey: Boolean(c.entry.options?.apiKey),
    };
  });
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
    if (!selection) return null;
    // Keep every tier that has at least one model. A partially filled default
    // is legitimate: the user may only have configured two of the three.
    const out: TierSelection = {};
    for (const tier of TIER_ORDER) {
      const chain = selection[tier];
      if (Array.isArray(chain) ? chain.length > 0 : Boolean(chain)) out[tier] = chain;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}
