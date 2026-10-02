import { useState } from 'react';
import {
  ArrowLeft, Search, Settings as SettingsIcon, Sun,
  Sparkles, Keyboard, Puzzle, Globe, MousePointer2,
  Anchor, Network, GitBranch, TerminalSquare, GitFork, Archive, Boxes, BarChart3, Coins,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { DesktopSettings, DesktopPreferences } from '../../types';
import { GeneralSettings } from './GeneralSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { PersonalizeSettings } from './PersonalizeSettings';
import { ShortcutsSettings } from './ShortcutsSettings';
import { PluginsSettings } from './PluginsSettings';
import { BrowserSettings } from './BrowserSettings';
import { ComputerSettings } from './ComputerSettings';
import { HooksSettings } from './HooksSettings';
import { ConnectionsSettings } from './ConnectionsSettings';
import { GitSettings } from './GitSettings';
import { EnvironmentSettings } from './EnvironmentSettings';
import { WorktreesSettings } from './WorktreesSettings';
import { ArchivedSettings } from './ArchivedSettings';
import { ModelSettings } from './ModelSettings';
import { DispatchSettings } from './DispatchSettings';
import { normalizeChains } from '../../lib/dispatchChains';
import { UsageSettings } from './UsageSettings';
import { searchNavIds } from '../../lib/settingsSearch';

const CHINESE_FONT_DEFAULT = 'Microsoft YaHei UI, Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif';
const ENGLISH_FONT_DEFAULT = 'Inter, Segoe UI, system-ui, -apple-system, BlinkMacSystemFont, sans-serif';

export type SettingsNavId =
  | 'general' | 'appearance' | 'model' | 'dispatch' | 'usage' | 'personalize' | 'shortcuts'
  | 'plugins' | 'browser' | 'computer'
  | 'hooks' | 'connections' | 'git' | 'environment' | 'worktrees'
  | 'archived';

type NavId = SettingsNavId;

type NavItem = { id: NavId; label: string; icon: ReactNode };
type NavGroup = { heading: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    heading: '个人',
    items: [
      { id: 'general', label: '常规', icon: <SettingsIcon size={17} /> },
      { id: 'appearance', label: '外观', icon: <Sun size={17} /> },
      { id: 'model', label: '模型', icon: <Boxes size={17} /> },
      { id: 'dispatch', label: '省钱分级', icon: <Coins size={17} /> },
      { id: 'usage', label: '用量统计', icon: <BarChart3 size={17} /> },
      { id: 'personalize', label: '个性化', icon: <Sparkles size={17} /> },
      { id: 'shortcuts', label: '键盘快捷键', icon: <Keyboard size={17} /> },
    ],
  },
  {
    heading: '集成',
    items: [
      { id: 'plugins', label: '插件', icon: <Puzzle size={17} /> },
      { id: 'browser', label: '浏览器', icon: <Globe size={17} /> },
      { id: 'computer', label: '电脑操控', icon: <MousePointer2 size={17} /> },
    ],
  },
  {
    heading: '编码',
    items: [
      { id: 'hooks', label: '钩子', icon: <Anchor size={17} /> },
      { id: 'connections', label: '连接', icon: <Network size={17} /> },
      { id: 'git', label: 'Git', icon: <GitBranch size={17} /> },
      { id: 'environment', label: '环境', icon: <TerminalSquare size={17} /> },
      { id: 'worktrees', label: '工作树', icon: <GitFork size={17} /> },
    ],
  },
  {
    heading: '已归档',
    items: [
      { id: 'archived', label: '已归档的聊天', icon: <Archive size={17} /> },
    ],
  },
];

export function SettingsView({ settings, onBack, onSave, onSaveKey, initialPage, sessionId }: {
  settings: DesktopSettings;
  onBack: () => void;
  onSave: (settings: DesktopSettings) => void;
  onSaveKey: (providerId: string, apiKey: string) => Promise<void>;
  initialPage?: SettingsNavId;
  /** Active session, so session-scoped panels (省钱分级) read the right one. */
  sessionId?: string;
}) {
  const [active, setActive] = useState<NavId>(initialPage ?? 'general');
  const [query, setQuery] = useState('');

  // Every page persists through the open `preferences` record. savePref merges
  // a partial patch so pages only pass the keys they own.
  const prefs = settings.preferences ?? {};
  const savePref = (patch: DesktopPreferences) =>
    onSave({ ...settings, preferences: { ...settings.preferences, ...patch } });

  // Iteration 15: fuzzy + bilingual keyword nav search (lib/settingsSearch)
  // instead of the old label-substring-only filter. Matched ids keep the
  // group order; ranking determines membership only.
  const matchedIds = searchNavIds(query, NAV_GROUPS.flatMap((group) => group.items.map((item) => ({ id: item.id, label: item.label, keywords: '' }))));
  const filteredGroups = query.trim()
    ? NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => matchedIds.includes(item.id)),
      })).filter((group) => group.items.length > 0)
    : NAV_GROUPS;

  return (
    <div className="settings-view">
      <nav className="settings-nav">
        <button className="back-button" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>返回应用</span>
        </button>

        <div className="settings-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索设置..."
          />
        </div>

        <div className="settings-nav-scroll">
          {filteredGroups.map((group) => (
            <div key={group.heading} className="settings-nav-group">
              <div className="settings-nav-heading">{group.heading}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  className={`settings-nav-item ${active === item.id ? 'active' : ''}`}
                  onClick={() => setActive(item.id)}
                >
                  <span className="settings-nav-icon">{item.icon}</span>
                  <span className="settings-nav-label">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </nav>

      <div className="settings-content">
        {active === 'general' && (
          <GeneralSettings
            prefs={prefs}
            savePref={savePref}
            approval={settings.approval}
            onApprovalChange={(approval) => onSave({ ...settings, approval })}
          />
        )}
        {active === 'appearance' && (
          <AppearanceSettings
            theme={settings.preferences?.theme ?? 'system'}
            onThemeChange={(theme) => savePref({ theme })}
            uiFontSize={Number(settings.preferences?.uiFontSize) || 14}
            codeFontSize={Number(settings.preferences?.codeFontSize) || 12}
            chineseFont={String(settings.preferences?.uiChineseFont || CHINESE_FONT_DEFAULT)}
            englishFont={String(settings.preferences?.uiEnglishFont || ENGLISH_FONT_DEFAULT)}
            onFontSizeChange={(next) => savePref(next)}
            onFontChange={(next) => savePref(next)}
            editorTabSize={Number(settings.preferences?.editorTabSize) || 2}
            editorMinimap={settings.preferences?.editorMinimap !== false}
            editorWordWrap={settings.preferences?.editorWordWrap === true}
            onEditorPrefChange={(next) => savePref(next)}
            prefs={prefs}
            savePref={savePref}
          />
        )}
        {active === 'model' && <ModelSettings settings={settings} onSave={onSave} onSaveKey={onSaveKey} />}
        {active === 'dispatch' && (
          <DispatchSettings
            dispatchDefault={normalizeChains(settings.preferences?.dispatchDefault)}
            onSaveDefault={(next) => {
              onSave({
                ...settings,
                preferences: { ...settings.preferences, dispatchDefault: next },
              });
            }}
          />
        )}
        {active === 'usage' && <UsageSettings activeProviderId={settings.activeProviderId} />}
        {active === 'personalize' && <PersonalizeSettings prefs={prefs} savePref={savePref} />}
        {active === 'shortcuts' && <ShortcutsSettings />}
        {active === 'plugins' && <PluginsSettings prefs={prefs} savePref={savePref} />}
        {active === 'browser' && <BrowserSettings prefs={prefs} savePref={savePref} />}
        {active === 'computer' && <ComputerSettings prefs={prefs} savePref={savePref} />}
        {active === 'hooks' && <HooksSettings />}
        {active === 'connections' && <ConnectionsSettings />}
        {active === 'git' && <GitSettings prefs={prefs} savePref={savePref} />}
        {active === 'environment' && <EnvironmentSettings />}
        {active === 'worktrees' && <WorktreesSettings prefs={prefs} savePref={savePref} />}
        {active === 'archived' && <ArchivedSettings />}
      </div>
    </div>
  );
}
