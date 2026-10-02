import { useEffect, useRef, useState } from 'react';
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

export function ModelMenu({ providers, activeProviderId, activeModel, dispatchDefault, onPick, onToggleTier, onManage, onClose }: {
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
  onManage: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
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
                const selected = provider.id === activeProviderId && model === activeModel;
                // Tier membership: a model can belong to several tiers, so
                // each badge is an independent toggle. Match on the qualified
                // "provider/model" first, then the bare name, so chains saved
                // by older versions still light up the right row.
                const qualified = `${provider.label}/${model}`;
                const inChain = (chain?: string[]) => Boolean(chain?.some(
                  (entry) => entry === qualified || entry === model,
                ));
                return (
                  <button
                    key={model}
                    className={`model-menu-item ${selected ? 'selected' : ''}`}
                    onClick={() => { onPick(provider.id, model); onClose(); }}
                  >
                    <span className="model-menu-item-name">{model}</span>
                    {/* Tier toggles: each badge flips this model's membership in
                        that tier without switching the active model, so one
                        pass over the menu can fill several tiers. Spans, not
                        buttons — nesting buttons inside the row is invalid
                        HTML and React warns about it. */}
                    {TIER_BADGES.map(({ id, glyph, title, tone }) => {
                      const on = inChain(dispatchDefault?.[id]);
                      return (
                        <span
                          key={id}
                          role="button"
                          tabIndex={-1}
                          className={`model-menu-tier tone-${tone} ${on ? 'on' : ''}`}
                          title={on ? `已在${title}（点击移出）` : `加入${title}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleTier?.(id, on ? '' : qualified);
                          }}
                        >{glyph}</span>
                      );
                    })}
                    {selected && <Check size={15} className="model-menu-check" />}
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
