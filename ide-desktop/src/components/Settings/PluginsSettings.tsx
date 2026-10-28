import { useEffect, useState } from 'react';
import { SectionHeader, Toggle } from './controls';
import { prefStrArray, type Prefs, type SavePref } from './prefs';
import { desktop } from '../../lib/ipc';
import {
  CATEGORY_LABEL, DEFAULT_ENABLED_IDS, groupByCategory, pluginMeta, statusMap,
  type PluginDef, type PluginStatus,
} from '../../lib/plugins';

/* Plugin settings (iteration 20): the catalog and per-plugin availability now
   come from the main-process registry (electron/plugin-registry.cjs), so the
   list can grow without touching this file. The enabled set persists through
   preferences (pluginsEnabled: string[]). Unavailable plugins (no workspace,
   no git, wrong OS) render dimmed with their reason and cannot be toggled on. */

export function PluginsSettings({ prefs, savePref }: { prefs: Prefs; savePref: SavePref }) {
  const [defs, setDefs] = useState<PluginDef[]>([]);
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError('');
    Promise.all([desktop.plugins.catalog(), desktop.plugins.status()])
      .then(([c, s]) => {
        if (cancelled) return;
        setDefs(c);
        setStatus(s);
        setLoadState('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Keep load failure distinct from "catalog loaded but has no entries":
        // the old catch left defs at [] and the page said 加载中 forever.
        setDefs([]);
        setStatus(null);
        setLoadState('error');
        setLoadError(error instanceof Error ? error.message : String(error ?? '未知错误'));
      });
    return () => { cancelled = true; };
  }, [reloadTick]);

  const enabled = prefStrArray(prefs, 'pluginsEnabled', DEFAULT_ENABLED_IDS);
  const availability = statusMap(status);

  function toggle(id: string, next: boolean) {
    const set = new Set(enabled);
    if (next) set.add(id); else set.delete(id);
    savePref({ pluginsEnabled: defs.filter((p) => set.has(p.id)).map((p) => p.id) });
  }

  const groups = groupByCategory(defs);

  return (
    <div className="settings-page">
      <h1 className="settings-page-title">插件</h1>

      <SectionHeader
        title="可用插件"
        description={<>启用插件以扩展 YOYcode 的能力。共 {defs.length} 个，{enabled.length} 个已启用。</>}
      />

      {groups.map((group) => (
        <section key={group.category} className="settings-group">
          <h3 className="settings-group-heading">{CATEGORY_LABEL[group.category]}</h3>
          <div className="settings-card">
            {group.plugins.map((plugin) => {
              const meta = pluginMeta(plugin.id);
              const entry = availability.get(plugin.id);
              const available = entry ? entry.available : true;
              return (
                <div key={plugin.id} className={`app-row${available ? '' : ' app-row-disabled'}`}>
                  <span className="app-row-icon" style={{ color: meta.tint }}>{meta.icon}</span>
                  <div className="app-row-text">
                    <span className="app-row-title">
                      {plugin.name}
                      {!available && <span className="plugin-unavailable-badge">{entry?.reason ?? '不可用'}</span>}
                    </span>
                    <span className="app-row-desc">{plugin.desc}</span>
                  </div>
                  <div className="app-row-control">
                    <Toggle
                      checked={available && enabled.includes(plugin.id)}
                      disabled={!available}
                      onChange={(next) => toggle(plugin.id, next)}
                      label={plugin.name}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {loadState === 'loading' && (
        <div className="settings-placeholder">插件目录加载中…</div>
      )}

      {loadState === 'error' && (
        <div className="settings-error-row" role="alert">
          <span>插件目录加载失败：{loadError}</span>
          <button type="button" onClick={() => setReloadTick((tick) => tick + 1)}>重试</button>
        </div>
      )}

      {loadState === 'ready' && defs.length === 0 && (
        <div className="settings-placeholder">插件目录为空</div>
      )}
    </div>
  );
}
