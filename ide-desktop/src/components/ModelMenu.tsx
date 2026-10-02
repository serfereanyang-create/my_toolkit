import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Check, SlidersHorizontal } from 'lucide-react';
import type { ProviderConfig } from '../types';

/*
 * Model picker popover shown above the composer. Lists providers; expanding one
 * reveals its selectable models. Picking a model sets it as active for chat.
 * A "管理模型" row at the bottom deep-links to the model settings page.
 */

/**
 * The three dispatch tiers, in capability order. Each renders as a toggle
 * badge on every model row; membership is per-tier, so one model can be the
 * 中档 primary and a 贵档 fallback at the same time.
 */
export const TIER_BADGES = [
  { id: 'expensive', glyph: '贵', title: '贵档', tone: 'expensive' },
  { id: 'standard', glyph: '中', title: '中档', tone: 'standard' },
  { id: 'cheap', glyph: '省', title: '便宜档', tone: 'cheap' },
] as const;

export type TierBadgeId = typeof TIER_BADGES[number]['id'];

export function ModelMenu({ providers, activeProviderId, activeModel, dispatchDefault, onPick, onToggleTier, onTogglePick, onManage, onClose }: {
  providers: ProviderConfig[];
  activeProviderId: string;
  activeModel: string;
  /** Per-tier model chains (省钱分级) shown as toggle badges on each row. */
  dispatchDefault?: Partial<Record<TierBadgeId, string[]>>;
  onPick: (providerId: string, model: string) => void;
  /**
   * Toggle a model's membership in a tier. `value` is the qualified
   * "provider/model"; an empty string removes it.
   */
  onToggleTier?: (tier: TierBadgeId, value: string) => void;
  /**
   * Add or remove one model in the dispatch set. The set is derived from the
   * tier chains themselves, so there is no second list to keep in sync: a
   * model is "picked" while it appears in any tier.
   */
  onTogglePick?: (value: string) => void;
  onManage: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // The dispatch set is the union of every tier chain, so the blue check and
  // the tier badges can never disagree about what is selected.
  const picked = useMemo(
    () => Array.from(new Set(
      Object.values(dispatchDefault ?? {}).flatMap((chain) => chain ?? []),
    )),
    [dispatchDefault],
  );
  const inChain = (chain?: string[], value?: string) => Boolean(value && chain?.includes(value));
  // Expand the active provider by default so the current model is visible.
  const [expanded, setExpanded] = useState<string | null>(activeProviderId);

  useEffect(() => {
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // A provider's selectable models: its explicit catalog, or its single default.
  function modelsOf(provider: ProviderConfig): string[] {
    if (provider.models && provider.models.length) return provider.models.map((m) => m.id);
    return provider.model ? [provider.model] : [];
  }

  return (
    <div className="model-menu" ref={ref} role="menu">
      <div className="model-menu-list">
        {providers.map((provider) => {
          const models = modelsOf(provider);
          const isOpen = expanded === provider.id;
          return (
            <div key={provider.id} className="model-menu-group">
              <button
                className="model-menu-provider"
                onClick={() => setExpanded(isOpen ? null : provider.id)}
              >
                <span className="model-menu-provider-name">{provider.label}</span>
                {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </button>
              {isOpen && models.map((model) => {
                const active = provider.id === activeProviderId && model === activeModel;
                // Tier membership: a model can belong to several tiers, so
                // Tier membership: matched on "providerId/model" ONLY.
                // The id is the handle, not the label: several providers share
                // the label "新供应商", so a label-qualified value matches
                // rows it does not belong to — every badge lit up at once and
                // the click looked like a no-op. Legacy label/bare-name
                // values are migrated on load (see normalizeChains).
                const qualified = `${provider.id}/${model}`;
                // Two independent states per row:
                //   checked = this model takes part in 省钱分级 at all
                //   tier badges = which chain it sits in (only meaningful once
                //     checked, and a model may sit in several tiers)
                // Keeping them separate is what lets the user tick several
                // models first and assign tiers afterwards.
                const checked = picked.includes(qualified);
                const onTier = (tierId: TierBadgeId) => inChain(dispatchDefault?.[tierId], qualified);
                return (
                  <button
                    key={model}
                    className={`model-menu-item ${active ? 'selected' : ''} ${checked ? 'picked' : ''}`}
                    onClick={() => { onPick(provider.id, model); onClose(); }}
                  >
                    <span className="model-menu-item-name">{model}</span>
                    {TIER_BADGES.map(({ id, glyph, title, tone }) => {
                      // Tier badges only appear for picked rows: assigning a
                      // tier to an unpicked model would silently pick it too.
                      if (!checked) return null;
                      const on = onTier(id);
                      return (
                        <span
                          key={id}
                          role="button"
                          tabIndex={-1}
                          className={`model-menu-tier tone-${tone} ${on ? 'on' : ''}`}
                          title={on ? `已在${title}（点击移出）` : `加入${title}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleTier?.(id, qualified);
                          }}
                        >{glyph}</span>
                      );
                    })}
                    {/* The blue check is the multi-select switch: it marks a
                        model as part of the dispatch set and stays on until
                        clicked again. It no longer means "the active model" —
                        that is the row's selected background. */}
                    <span
                      role="checkbox"
                      aria-checked={checked}
                      tabIndex={-1}
                      className={`model-menu-pick ${checked ? 'on' : ''}`}
                      title={checked ? '已加入省钱分级（点击移出）' : '加入省钱分级'}
                      onClick={(event) => {
                        event.stopPropagation();
                        onTogglePick?.(qualified);
                      }}
                    >
                      {checked ? <Check size={15} /> : null}
                    </span>
                  </button>
                );
              })}
              {isOpen && models.length === 0 && (
                <div className="model-menu-empty">该供应商暂无模型</div>
              )}
            </div>
          );
        })}
      </div>
      <div className="model-menu-divider" />
      <button className="model-menu-manage" onClick={() => { onManage(); onClose(); }}>
        <SlidersHorizontal size={15} />
        <span>管理模型</span>
      </button>
    </div>
  );
}
