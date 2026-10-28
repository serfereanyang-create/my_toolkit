import { useEffect, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, SlidersHorizontal } from 'lucide-react';
import type { ProviderConfig } from '../types';
import { usePopoverFocus } from '../lib/usePopoverFocus';

/**
 * The model picker: one column of providers, each expanding to its models.
 *
 * This used to carry a second job — assigning models to the 贵/中/便宜 dispatch
 * tiers, with membership checkboxes, per-tier ordering and migration of stale
 * selectors. That whole surface is gone: tier dispatch is decided by the CLI
 * from the models that are configured and the kind of call being made, so there
 * is nothing here for a person to fill in. What is left is what the menu is
 * named after.
 */
export function ModelMenu({ providers, activeProviderId, activeModel, onPick, onManage, onClose }: {
  providers: ProviderConfig[];
  activeProviderId: string;
  activeModel: string;
  onPick: (providerId: string, model: string) => void;
  onManage: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  usePopoverFocus(ref);
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

  function modelsOf(provider: ProviderConfig): string[] {
    if (provider.models?.length) return provider.models.map((model) => model.id);
    return provider.model ? [provider.model] : [];
  }
  // Providers created from the settings pane all start as "新供应商", so a menu
  // listing two of them showed two identical rows with no way to tell which
  // endpoint each one called. Name the endpoint (or the model when no URL is
  // set) underneath — the same disambiguation the settings rail uses.
  function providerHint(provider: ProviderConfig): string {
    const host = (() => {
      const raw = provider.baseUrl?.trim();
      if (!raw) return '';
      try { return new URL(raw).host; }
      catch { return raw.replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
    })();
    if (host) return host;
    return modelsOf(provider)[0] ?? '';
  }

  return (
    <div className="model-menu" ref={ref} role="group" aria-label="选择模型">
      <div className="model-menu-list">
        {providers.map((provider) => {
          const models = modelsOf(provider);
          const isOpen = expanded === provider.id;
          return (
            <div key={provider.id} className="model-menu-group">
              <button type="button" className="model-menu-provider" aria-expanded={isOpen}
                onClick={() => setExpanded(isOpen ? null : provider.id)}
                title={provider.baseUrl || provider.label}>
                <span className="model-menu-provider-copy">
                  <span className="model-menu-provider-name">{provider.label}</span>
                  {(() => {
                    const hint = providerHint(provider);
                    return hint && hint !== provider.label
                      ? <span className="model-menu-provider-hint">{hint}</span>
                      : null;
                  })()}
                </span>
                {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </button>
              {isOpen && models.map((model) => {
                const active = provider.id === activeProviderId && model === activeModel;
                return (
                  <div key={model} role="group" aria-label={`${provider.label} ${model}`}
                    className={`model-menu-item ${active ? 'selected' : ''}`}>
                    <button type="button" className="model-menu-item-name" aria-pressed={active}
                      aria-label={`使用 ${provider.label} ${model}`}
                      style={{ flex: '1 1 auto', minWidth: 0, padding: 0, border: 0, textAlign: 'left', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
                      onClick={() => { onPick(provider.id, model); onClose(); }}>{model}</button>
                  </div>
                );
              })}
              {isOpen && models.length === 0 && <div className="model-menu-empty">该供应商暂无模型</div>}
            </div>
          );
        })}
      </div>
      <div className="model-menu-divider" />
      <button type="button" className="model-menu-manage" onClick={() => { onManage(); onClose(); }}>
        <SlidersHorizontal size={15} /><span>管理模型</span>
      </button>
    </div>
  );
}
