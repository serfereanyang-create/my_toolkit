import { useEffect, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Check, SlidersHorizontal } from 'lucide-react';
import type { ProviderConfig } from '../types';

/*
 * Model picker popover shown above the composer. Lists providers; expanding one
 * reveals its selectable models. Picking a model sets it as active for chat.
 * A "管理模型" row at the bottom deep-links to the model settings page.
 */

export function ModelMenu({ providers, activeProviderId, activeModel, dispatchDefault, onPick, onAssignTier, onManage, onClose }: {
  providers: ProviderConfig[];
  activeProviderId: string;
  activeModel: string;
  /** Global default pair (省钱分级) shown as badges on each model row. */
  dispatchDefault?: { expensive?: string; cheap?: string };
  onPick: (providerId: string, model: string) => void;
  /** Assign this model to a dispatch tier (global default). */
  onAssignTier?: (tier: 'expensive' | 'cheap', model: string) => void;
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
                // Match on the fully-qualified "provider/model" so a model
                // that exists under several providers only gets the badge on
                // the provider actually assigned to that tier.
                const qualified = `${provider.label}/${model}`;
                const isExpensive = dispatchDefault?.expensive === qualified
                  || dispatchDefault?.expensive === model;
                const isCheap = dispatchDefault?.cheap === qualified
                  || dispatchDefault?.cheap === model;
                return (
                  <button
                    key={model}
                    className={`model-menu-item ${selected ? 'selected' : ''}`}
                    onClick={() => { onPick(provider.id, model); onClose(); }}
                  >
                    <span className="model-menu-item-name">{model}</span>
                    {/* Tier assignment: clicking a badge sets the global
                        default for that tier without switching the active
                        model, so one pass over the menu can fill both.
                        These are spans, not buttons: nesting a button inside
                        the row button is invalid HTML and React warns about it. */}
                    <span
                      role="button"
                      tabIndex={-1}
                      className={`model-menu-tier ${isExpensive ? 'tier-expensive on' : ''}`}
                      title={isExpensive ? '已是贵档（点击取消）' : '设为贵档：只出方案与终审'}
                      onClick={(event) => { event.stopPropagation(); onAssignTier?.('expensive', isExpensive ? '' : qualified); }}
                    >贵</span>
                    <span
                      role="button"
                      tabIndex={-1}
                      className={`model-menu-tier ${isCheap ? 'tier-cheap on' : ''}`}
                      title={isCheap ? '已是便宜档（点击取消）' : '设为便宜档：承担实现与排查'}
                      onClick={(event) => { event.stopPropagation(); onAssignTier?.('cheap', isCheap ? '' : qualified); }}
                    >省</span>
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
