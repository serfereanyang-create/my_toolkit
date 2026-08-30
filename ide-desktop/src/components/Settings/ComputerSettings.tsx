import { MousePointer2, Chrome, AppWindow, Sheet, Plus, Trash2, CheckCircle2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Toggle } from './controls';
import { prefBool, prefStrArray, type Prefs, type SavePref } from './prefs';
import { desktop } from '../../lib/ipc';

/*
 * 电脑操控 — Computer control settings.
 *
 * 这些设置通过 CLI 启动参数真实生效：
 *   computerAnyApp       → --computer-any-app：auto 模式放行所有非破坏性命令
 *   computerAllowedApps  → --allowed-apps：这些应用免确认执行（anyApp 关闭时仍生效）
 *   computerExcel        → --excel：注册 excel_automate 工具（Windows COM 自动化）
 * 破坏性命令（rm -rf、format 等）在任何设置下都被硬性拒绝。
 */

type ExtensionState = {
  installed: boolean;
  extensions: Array<{ browser: string; extensionId: string; name: string }>;
};

type AppRowProps = {
  icon: ReactNode;
  name: string;
  status: ReactNode;
  control: ReactNode;
};

function AppRow({ icon, name, status, control }: AppRowProps) {
  return (
    <div className="app-row">
      <span className="app-row-icon">{icon}</span>
      <div className="app-row-text">
        <span className="app-row-name">{name}</span>
        <span className="app-row-status">{status}</span>
      </div>
      <div className="app-row-control">{control}</div>
    </div>
  );
}

const CHROME_EXT_URL = 'https://chromewebstore.google.com/search/yoycode';
const EDGE_EXT_URL   = 'https://microsoftedge.microsoft.com/addons/search/yoycode';

export function ComputerSettings({ prefs, savePref }: { prefs: Prefs; savePref: SavePref }) {
  const anyApp  = prefBool(prefs, 'computerAnyApp', true);
  const excel   = prefBool(prefs, 'computerExcel', false);
  const allowed = prefStrArray(prefs, 'computerAllowedApps', []);

  const setAnyApp  = (next: boolean) => savePref({ computerAnyApp: next });
  const setExcel   = (next: boolean) => savePref({ computerExcel: next });
  const setAllowed = (list: string[]) => savePref({ computerAllowedApps: list });

  // "始终允许" 新增 input
  const [newApp, setNewApp] = useState('');
  // Real browser extension detection from Chrome/Edge profile directories.
  const [extensionState, setExtensionState] = useState<ExtensionState | null>(null);

  useEffect(() => {
    let live = true;
    desktop.computer?.detectBrowserExtension?.().then((state) => {
      if (live) setExtensionState(state);
    }).catch(() => { if (live) setExtensionState({ installed: false, extensions: [] }); });
    return () => { live = false; };
  }, []);

  function extStatus(browser: 'chrome' | 'edge'): ReactNode {
    if (extensionState === null) return <><span className="status-dot status-dot-off" />检测中…</>;
    const installed = extensionState.extensions.some((e) => e.browser === browser);
    return installed
      ? <><span className="status-dot status-dot-on" style={{ background: 'var(--ok)' }} />扩展已安装</>
      : <><span className="status-dot status-dot-off" />未安装浏览器扩展程序</>;
  }

  function addApp() {
    const v = newApp.trim();
    if (!v || allowed.includes(v)) return;
    setAllowed([...allowed, v]);
    setNewApp('');
  }

  function removeApp(app: string) {
    setAllowed(allowed.filter((a) => a !== app));
  }

  function openExt(url: string) {
    void desktop.preview.openExternal(url);
  }

  return (
    <div className="settings-page">
      <h1 className="settings-page-title">电脑操控</h1>
      <p className="settings-page-subtitle">管理 YOYcode 如何使用你电脑上的其他应用程序</p>

      <section className="settings-group">
        <h3 className="settings-group-heading">控制</h3>
        <div className="settings-card">
          <AppRow
            icon={<span className="app-icon app-icon-any"><MousePointer2 size={18} /></span>}
            name="任意应用"
            status={
              anyApp
                ? <><CheckCircle2 size={12} style={{ color: 'var(--ok)', verticalAlign: 'middle' }} /> auto 模式下放行所有非破坏性命令</>
                : '已限制 — 仅白名单内命令自动执行，其余按审批模式处理'
            }
            control={<Toggle checked={anyApp} onChange={setAnyApp} label="任意应用" />}
          />
          <AppRow
            icon={<span className="app-icon app-icon-chrome"><Chrome size={20} /></span>}
            name="Google Chrome"
            status={extStatus('chrome')}
            control={
              <button
                type="button"
                className="settings-action-btn"
                onClick={() => openExt(CHROME_EXT_URL)}
              >
                安装
              </button>
            }
          />
          <AppRow
            icon={<span className="app-icon app-icon-edge"><AppWindow size={20} /></span>}
            name="Microsoft Edge"
            status={extStatus('edge')}
            control={
              <button
                type="button"
                className="settings-action-btn"
                onClick={() => openExt(EDGE_EXT_URL)}
              >
                安装
              </button>
            }
          />
          <AppRow
            icon={<span className="app-icon app-icon-excel"><Sheet size={20} /></span>}
            name="Microsoft Excel"
            status={
              excel
                ? <><CheckCircle2 size={12} style={{ color: 'var(--ok)', verticalAlign: 'middle' }} /> 已启用 — excel_automate 工具可读写本地工作簿</>
                : '启用 Windows Excel COM 自动化（读写单元格/工作簿，需本机安装 Excel）'
            }
            control={<Toggle checked={excel} onChange={setExcel} label="Microsoft Excel" />}
          />
        </div>
      </section>

      <section className="settings-group">
        <h3 className="settings-group-heading">始终允许的应用</h3>
        <p style={{ fontSize: 12, color: 'var(--fg-dim)', marginBottom: 8 }}>
          即使「任意应用」关闭，这些应用名称或路径也无需用户确认（如 <code>node</code>、<code>python</code>）。
        </p>
        <div className="settings-card">
          {allowed.length === 0 ? (
            <div className="setting-row">
              <span className="setting-row-desc" style={{ color: 'var(--fg-dim)' }}>暂无</span>
            </div>
          ) : (
            allowed.map((app) => (
              <div key={app} className="setting-row" style={{ gap: 8 }}>
                <code style={{ flex: 1, fontSize: 12 }}>{app}</code>
                <button
                  className="icon-button"
                  title="移除"
                  onClick={() => removeApp(app)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
          {/* Add new app */}
          <div className="setting-row" style={{ gap: 8, borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 8 }}>
            <input
              className="settings-text-field"
              style={{ flex: 1 }}
              value={newApp}
              onChange={(e) => setNewApp(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addApp(); }}
              placeholder="输入应用名称或路径，如 node"
            />
            <button
              className="icon-button"
              title="添加"
              disabled={!newApp.trim()}
              onClick={addApp}
            >
              <Plus size={16} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
