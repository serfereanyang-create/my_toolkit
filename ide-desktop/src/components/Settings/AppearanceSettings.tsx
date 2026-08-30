import { useState } from 'react';
import { Toggle, Segmented, SelectPill, SettingsCard, SettingRow, ColorSwatch, Slider, NumberField, TextField } from './controls';

type ThemeMode = 'system' | 'light' | 'dark';

/* A single theme preview tile (系统 / 浅色 / 深色). The graphic is a small
   mock of a window with a sidebar + content lines, tinted per mode. */
function ThemeTile({ mode, label, active, onSelect }: {
  mode: ThemeMode;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={`theme-tile ${active ? 'active' : ''}`} onClick={onSelect}>
      <span className={`theme-preview theme-preview-${mode}`}>
        <span className="theme-preview-window">
          <span className="theme-preview-line theme-preview-line-title" />
          <span className="theme-preview-line" />
          <span className="theme-preview-line" />
          <span className="theme-preview-line short" />
        </span>
      </span>
      <span className="theme-tile-label">{label}</span>
    </button>
  );
}

/* Diff-style code preview shown under the theme tiles. Two columns, one
   "before" (red) and one "after" (green), purely illustrative. */
function ThemeDiffPreview() {
  const before = [
    { n: 1, text: 'const themePreview: ThemeConfig = {', tone: '' },
    { n: 2, text: '  surface: "sidebar",', tone: 'del' },
    { n: 3, text: '  accent: "#2563eb",', tone: 'del' },
    { n: 4, text: '  contrast: 42,', tone: 'del' },
    { n: 5, text: '};', tone: '' },
  ];
  const after = [
    { n: 1, text: 'const themePreview: ThemeConfig = {', tone: '' },
    { n: 2, text: '  surface: "sidebar-elevated",', tone: 'add' },
    { n: 3, text: '  accent: "#0ea5e9",', tone: 'add' },
    { n: 4, text: '  contrast: 68,', tone: 'add' },
    { n: 5, text: '};', tone: '' },
  ];
  return (
    <div className="theme-diff">
      {[before, after].map((side, idx) => (
        <div key={idx} className="theme-diff-col">
          {side.map((line) => (
            <div key={line.n} className={`theme-diff-line ${line.tone}`}>
              <span className="theme-diff-gutter">{line.n}</span>
              <code>{line.text}</code>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* One theme's editable color/font block (used for both light and dark). */
function ThemeColorCard({ heading, accent, background, foreground, translucent, contrast }: {
  heading: string;
  accent: string;
  background: string;
  foreground: string;
  translucent: boolean;
  contrast?: number;
}) {
  const [acc, setAcc] = useState(accent);
  const [bg, setBg] = useState(background);
  const [fg, setFg] = useState(foreground);
  const [uiFont, setUiFont] = useState('-apple-system, BlinkMacSystemFont');
  const [codeFont, setCodeFont] = useState('ui-monospace, "SFMono-Regular"');
  const [trans, setTrans] = useState(translucent);
  const [ctr, setCtr] = useState(contrast ?? 60);

  return (
    <section className="settings-group">
      <div className="settings-card">
        <div className="theme-card-head">
          <span className="theme-card-title">{heading}</span>
          <div className="theme-card-actions">
            <button type="button" className="settings-link-btn" disabled>导入</button>
            <button type="button" className="settings-link-btn" disabled>复制主题</button>
            <SelectPill
              value="codex"
              onChange={() => {}}
              icon={<span className="theme-font-badge">Aa</span>}
              options={[{ value: 'codex', label: 'Codex' }]}
            />
          </div>
        </div>
        <SettingRow title="强调色" control={<ColorSwatch value={acc} onChange={setAcc} />} />
        <SettingRow title="背景" control={<ColorSwatch value={bg} onChange={setBg} />} />
        <SettingRow title="前景" control={<ColorSwatch value={fg} onChange={setFg} />} />
        <SettingRow title="UI 字体" control={<TextField value={uiFont} onChange={setUiFont} />} />
        <SettingRow title="代码字体" control={<TextField value={codeFont} onChange={setCodeFont} />} />
        <SettingRow title="半透明侧边栏" control={<Toggle checked={trans} onChange={setTrans} label="半透明侧边栏" />} />
        {contrast !== undefined && (
          <SettingRow title="对比度" control={<Slider value={ctr} min={0} max={100} onChange={setCtr} />} />
        )}
      </div>
    </section>
  );
}

/* Full "外观" page. The theme selector is real and persisted; the remaining
   preference controls are still local UI state pending backing fields. */
export function AppearanceSettings({ theme, onThemeChange, uiFontSize, codeFontSize, onFontSizeChange }: {
  theme: ThemeMode;
  onThemeChange: (next: ThemeMode) => void;
  uiFontSize: number;
  codeFontSize: number;
  onFontSizeChange: (next: { uiFontSize?: number; codeFontSize?: number }) => void;
}) {
  const setTheme = onThemeChange;

  // 偏好设置 — theme + font sizes are persisted; the rest are still local UI state.
  const [pointerCursor, setPointerCursor] = useState(false);
  const [reduceMotion, setReduceMotion] = useState<'system' | 'on' | 'off'>('system');
  const [diffMarkers, setDiffMarkers] = useState<'color' | 'symbol'>('color');

  return (
    <div className="settings-page">
      <h1 className="settings-page-title">外观</h1>

      <section className="settings-group">
        <h3 className="settings-group-heading">主题</h3>
        <div className="theme-tiles">
          <ThemeTile mode="system" label="系统" active={theme === 'system'} onSelect={() => setTheme('system')} />
          <ThemeTile mode="light" label="浅色" active={theme === 'light'} onSelect={() => setTheme('light')} />
          <ThemeTile mode="dark" label="深色" active={theme === 'dark'} onSelect={() => setTheme('dark')} />
        </div>
        <ThemeDiffPreview />
      </section>

      <ThemeColorCard heading="浅色主题" accent="#339CFF" background="#FFFFFF" foreground="#1A1C1F" translucent />
      <ThemeColorCard heading="深色主题" accent="#339CFF" background="#181818" foreground="#FFFFFF" translucent contrast={60} />

      <SettingsCard heading="偏好设置">
        <SettingRow
          title="使用指针光标"
          description="悬停交互元素时切换为指针光标"
          control={<Toggle checked={pointerCursor} onChange={setPointerCursor} label="使用指针光标" />}
        />
        <SettingRow
          title="减少动态效果"
          description="减少动画效果或匹配系统设置"
          control={<Segmented value={reduceMotion} onChange={setReduceMotion} options={[
            { value: 'system', label: '系统' },
            { value: 'on', label: '开启' },
            { value: 'off', label: '关闭' },
          ]} />}
        />
        <SettingRow
          title="UI 字号"
          description="调整 ChatGPT 界面使用的基准字号"
          control={<NumberField value={uiFontSize} onChange={(next) => onFontSizeChange({ uiFontSize: next })} suffix="px" min={10} max={24} />}
        />
        <SettingRow
          title="代码字体大小"
          description="调整聊天和差异视图中代码使用的基础字号"
          control={<NumberField value={codeFontSize} onChange={(next) => onFontSizeChange({ codeFontSize: next })} suffix="px" min={8} max={24} />}
        />
        <SettingRow
          title="差异标记"
          description="使用颜色或 +/− 标记显示更改"
          control={<Segmented value={diffMarkers} onChange={setDiffMarkers} options={[
            { value: 'color', label: '颜色' },
            { value: 'symbol', label: '+/-' },
          ]} />}
        />
      </SettingsCard>
    </div>
  );
}
