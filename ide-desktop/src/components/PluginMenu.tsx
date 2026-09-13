import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { desktop } from '../lib/ipc';
import {
  CATEGORY_LABEL, DEFAULT_ENABLED_IDS, groupByCategory, pluginMeta, statusMap,
  filterPlugins, type PluginDef, type PluginStatus,
} from '../lib/plugins';
import { prefStrArray } from './Settings/prefs';
import type { Prefs } from './Settings/prefs';

/**
 * The composer "+" plugin menu (iteration 20). Now fed by the main-process
 * registry instead of a second hardcoded list: only plugins the user enabled
 * AND that are available in this environment show up, grouped by category,
 * searchable, with the route (if any) carried through to App for navigation.
 */
export type PluginItem = {
  id: string;
  name: string;
  desc: string;
  icon: ReactNode;
  tint: string;
  route: string | null;
};

function toMenuItem(def: PluginDef): PluginItem {
  const meta = pluginMeta(def.id);
  return { id: def.id, name: def.name, desc: def.desc, icon: meta.icon, tint: meta.tint, route: def.route };
}

export function PluginMenu({ prefs, onClose, onPick }: {
  prefs?: Prefs;
  onClose: () => void;
  onPick: (plugin: PluginItem) => void;
}) {
  const [query, setQuery] = useState('');
  const [defs, setDefs] = useState<PluginDef[]>([]);
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([desktop.plugins.catalog(), desktop.plugins.status()])
      .then(([c, s]) => { if (!cancelled) { setDefs(c); setStatus(s); } })
      .catch(() => { /* registry unreachable: empty menu */ });
    return () => { cancelled = true; };
  }, []);

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

  const visible = useMemo(() => {
    const enabledIds = prefs ? prefStrArray(prefs, 'pluginsEnabled', DEFAULT_ENABLED_IDS) : null;
    const availability = statusMap(status);
    const usable = defs.filter((d) => {
      const entry = availability.get(d.id);
      if (entry && !entry.available) return false;
      if (enabledIds && !enabledIds.includes(d.id)) return false;
      return true;
    });
    return groupByCategory(filterPlugins(usable, query));
  }, [defs, status, prefs, query]);

  const isEmpty = visible.every((g) => g.plugins.length === 0);

  return (
    <div className="plugin-menu" ref={ref} role="menu">
      <div className="plugin-section">插件</div>
      <input
        className="plugin-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索插件…"
        autoFocus
      />
      <div className="plugin-list">
        {isEmpty && <div className="plugin-empty">没有可用插件（在 设置 → 插件 中启用）</div>}
        {visible.map((group) => (
          <div key={group.category}>
            <div className="plugin-section">{CATEGORY_LABEL[group.category]}</div>
            {group.plugins.map((def) => {
              const item = toMenuItem(def);
              return (
                <button key={item.id} className="plugin-row" onClick={() => onPick(item)}>
                  <span className="plugin-icon" style={{ color: item.tint }}>{item.icon}</span>
                  <span className="plugin-name">{item.name}</span>
                  <span className="plugin-desc">{item.desc}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
