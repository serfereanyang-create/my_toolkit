/**
 * Shared helpers for the 省钱分级 model chains.
 *
 * The stored shape is one ordered list per tier, where the first entry is the
 * primary and the rest are fallbacks. Older settings stored a single string,
 * so everything read from disk goes through normalizeChains() first.
 */
export type DispatchTierId = 'expensive' | 'standard' | 'cheap';

export type DispatchChains = Partial<Record<DispatchTierId, string[]>>;

export const DISPATCH_TIERS: Array<{ id: DispatchTierId; label: string }> = [
  { id: 'expensive', label: '贵档' },
  { id: 'standard', label: '中档' },
  { id: 'cheap', label: '便宜档' },
];

type Stored = Partial<Record<DispatchTierId, string | string[]>> | undefined;

export function normalizeChains(raw: Stored): DispatchChains {
  const out: DispatchChains = {};
  for (const { id } of DISPATCH_TIERS) {
    const value = raw?.[id];
    if (Array.isArray(value)) {
      const clean = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
      if (clean.length) out[id] = clean;
    } else if (typeof value === 'string' && value) {
      out[id] = [value];
    }
  }
  return out;
}

/**
 * Add or remove one model in a tier's chain.
 *
 * Adding appends, so the chain's order stays the order the user clicked:
 * first pick is the primary, later picks are fallbacks. An empty `value`
 * means "remove this model" (the menus pass '' for an active badge).
 */
export function toggleChain(
  chains: DispatchChains,
  tier: DispatchTierId,
  value: string,
): DispatchChains {
  const chain = chains[tier] ?? [];
  if (!value) return chains;
  const next = chain.includes(value)
    ? chain.filter((entry) => entry !== value)
    : [...chain, value];
  return { ...chains, [tier]: next };
}
