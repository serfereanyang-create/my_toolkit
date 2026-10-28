import { Chrome, AppWindow, Globe } from 'lucide-react';
import type { ReactNode } from 'react';
import { Toggle, Segmented, SettingsCard, SettingRow } from './controls';
import { prefBool, prefStr, type Prefs, type SavePref } from './prefs';

/* 浏览器 — manages the in-app browser and connected external browsers.
   UI-only: local state, nothing is persisted yet. Follows the same app-row
   layout as 电脑操控 for the connected-browser list. */

type BrowserRowProps = {
  icon: ReactNode;
  name: string;
  status: ReactNode;
  control: ReactNode;
};

function BrowserRow({ icon, name, status, control }: BrowserRowProps) {
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

export function BrowserSettings({ prefs, savePref }: { prefs: Prefs; savePref: SavePref }) {
  const builtIn = prefBool(prefs, 'browserBuiltIn', true);
  const blockPopups = prefBool(prefs, 'browserBlockPopups', true);
  const engine = prefStr(prefs, 'browserEngine', 'internal') as 'internal' | 'system';
  const setBuiltIn = (next: boolean) => savePref({ browserBuiltIn: next });
  const setBlockPopups = (next: boolean) => savePref({ browserBlockPopups: next });
  const setEngine = (next: 'internal' | 'system') => savePref({ browserEngine: next });

  return (
    <div className="settings-page">
      <h1 className="settings-page-title">浏览器</h1>
      <p className="settings-page-subtitle">管理 YOYcode 如何浏览网页并连接你的浏览器</p>

      <SettingsCard heading="内置浏览器">
        <SettingRow
          title="启用内置浏览器"
          description="允许 YOYcode 在应用内打开并浏览网页"
          control={<Toggle checked={builtIn} onChange={setBuiltIn} label="启用内置浏览器" />}
        />
        <SettingRow
          title="浏览引擎"
          description="选择用于渲染网页的引擎"
          control={
            <Segmented
              value={engine}
              onChange={setEngine}
              options={[
                { value: 'internal', label: '内置' },
                { value: 'system', label: '系统默认' },
              ]}
            />
          }
        />
        <SettingRow
          title="阻止弹出窗口"
          description="拦截网页自动打开的弹出窗口"
          control={<Toggle checked={blockPopups} onChange={setBlockPopups} label="阻止弹出窗口" />}
        />
      </SettingsCard>

      <section className="settings-group">
        <h3 className="settings-group-heading">已连接的浏览器</h3>
        <div className="settings-card">
          <BrowserRow
            icon={<span className="app-icon app-icon-chrome"><Chrome size={20} /></span>}
            name="Google Chrome"
            status={<><span className="status-dot status-dot-off" />未安装浏览器扩展程序</>}
            control={<button type="button" className="settings-action-btn" title="暂未接入：浏览器扩展安装还没有数据源" disabled>安装</button>}
          />
          <BrowserRow
            icon={<span className="app-icon app-icon-edge"><AppWindow size={20} /></span>}
            name="Microsoft Edge"
            status={<><span className="status-dot status-dot-off" />未安装浏览器扩展程序</>}
            control={<button type="button" className="settings-action-btn" title="暂未接入：浏览器扩展安装还没有数据源" disabled>安装</button>}
          />
        </div>
      </section>

      <section className="settings-group">
        <h3 className="settings-group-heading">主页</h3>
        <div className="settings-card">
          <div className="setting-row">
            <div className="setting-row-text">
              <span className="setting-row-title"><Globe size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />默认主页</span>
              <span className="setting-row-desc">新标签页打开时显示的地址</span>
            </div>
            <div className="setting-row-control">
              <button type="button" className="settings-inline-edit" title="暂未接入：主页设置还没有数据源" disabled><span>about:blank</span></button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
