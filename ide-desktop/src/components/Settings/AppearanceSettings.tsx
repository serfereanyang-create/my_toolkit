import { Toggle, Segmented, SelectPill, SettingsCard, SettingRow, ColorSwatch, Slider, NumberField, TextField } from './controls';
import { prefBool, prefStr, type Prefs, type SavePref } from './prefs';

const CHINESE_FONT_OPTIONS = [
  { value: 'Microsoft YaHei UI, Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif', label: '微软雅黑 / 苹方 / Noto Sans CJK' },
  { value: 'PingFang SC, Microsoft YaHei UI, Microsoft YaHei, Noto Sans CJK SC, sans-serif', label: '苹方优先' },
  { value: 'Noto Sans CJK SC, Source Han Sans SC, Microsoft YaHei, sans-serif', label: 'Noto Sans CJK / 思源黑体' },
  { value: 'SimSun, NSimSun, Songti SC, Noto Serif CJK SC, serif', label: '宋体 / Songti' },
  { value: 'system-ui, sans-serif', label: '系统默认中文字体' },
];

const ENGLISH_FONT_OPTIONS = [
  { value: 'Inter, Segoe UI, system-ui, -apple-system, BlinkMacSystemFont, sans-serif', label: 'Inter / Segoe UI' },
  { value: 'Segoe UI, Inter, system-ui, sans-serif', label: 'Segoe UI' },
  { value: 'SF Pro Display, SF Pro Text, -apple-system, BlinkMacSystemFont, sans-serif', label: 'SF Pro / Apple 系统字体' },
  { value: 'Roboto, Arial, sans-serif', label: 'Roboto' },
  { value: 'system-ui, sans-serif', label: 'System UI' },
];

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

/* Full "外观" page. Theme, font sizes, and the editor preferences below are
   persisted and have real consumers (UI CSS variable, Monaco editor options). */
export function AppearanceSettings({ theme, onThemeChange, uiFontSize, codeFontSize, chineseFont, englishFont, onFontSizeChange, onFontChange, editorTabSize, editorMinimap, editorWordWrap, onEditorPrefChange, prefs, savePref }: {
  theme: ThemeMode;
  onThemeChange: (next: ThemeMode) => void;
  uiFontSize: number;
  codeFontSize: number;
  chineseFont: string;
  englishFont: string;
  onFontSizeChange: (next: { uiFontSize?: number; codeFontSize?: number }) => void;
  onFontChange: (next: { uiChineseFont?: string; uiEnglishFont?: string }) => void;
  editorTabSize: number;
  editorMinimap: boolean;
  editorWordWrap: boolean;
  onEditorPrefChange: (next: { editorTabSize?: number; editorMinimap?: boolean; editorWordWrap?: boolean }) => void;
  prefs: Prefs;
  savePref: SavePref;
}) {
  const setTheme = onThemeChange;

  // 偏好设置 — 全部持久化且有真实消费者：pointerCursor/reduceMotion 由 App.tsx
  // 写成 <html data-*> 属性并驱动 CSS；diffMarkers 移除（无渲染消费者）。
  const pointerCursor = prefBool(prefs, 'appearance.pointerCursor', false);
  const reduceMotion = prefStr(prefs, 'appearance.reduceMotion', 'system') as 'system' | 'on' | 'off';
  const setPointerCursor = (v: boolean) => savePref({ 'appearance.pointerCursor': v });
  const setReduceMotion = (v: 'system' | 'on' | 'off') => savePref({ 'appearance.reduceMotion': v });

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
          description="调整 YOYcode 界面使用的基准字号"
          control={<NumberField value={uiFontSize} onChange={(next) => onFontSizeChange({ uiFontSize: next })} suffix="px" min={10} max={24} />}
        />
        <SettingRow
          title="中文字体"
          description="简体中文界面优先使用的字体，系统未安装时自动回退"
          control={<SelectPill value={chineseFont} onChange={(next) => onFontChange({ uiChineseFont: next })} options={CHINESE_FONT_OPTIONS} />}
        />
        <SettingRow
          title="English font"
          description="Font stack used when the interface language is English"
          control={<SelectPill value={englishFont} onChange={(next) => onFontChange({ uiEnglishFont: next })} options={ENGLISH_FONT_OPTIONS} />}
        />
        <SettingRow
          title="代码字体大小"
          description="调整编辑器、聊天和差异视图中代码使用的基础字号"
          control={<NumberField value={codeFontSize} onChange={(next) => onFontSizeChange({ codeFontSize: next })} suffix="px" min={8} max={24} />}
        />
        <SettingRow
          title="缩进宽度"
          description="编辑器中 Tab 缩进使用的空格数（立即生效）"
          control={<NumberField value={editorTabSize} onChange={(next) => onEditorPrefChange({ editorTabSize: next })} suffix="格" min={2} max={8} />}
        />
        <SettingRow
          title="显示小地图"
          description="在编辑器右侧显示代码缩略导航图"
          control={<Toggle checked={editorMinimap} onChange={(next) => onEditorPrefChange({ editorMinimap: next })} label="显示小地图" />}
        />
        <SettingRow
          title="自动换行"
          description="长行在编辑器宽度处折行，而不是横向滚动"
          control={<Toggle checked={editorWordWrap} onChange={(next) => onEditorPrefChange({ editorWordWrap: next })} label="自动换行" />}
        />
      </SettingsCard>
    </div>
  );
}
