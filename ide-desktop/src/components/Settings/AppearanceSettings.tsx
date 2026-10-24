import { useEffect, useState } from 'react';
import { Toggle, Segmented, SelectPill, SettingsCard, SettingRow, ColorSwatch, Slider, NumberField, TextField } from './controls';
import { prefBool, prefStr, type Prefs, type SavePref } from './prefs';
import { BACKGROUND_DEFAULTS, clearBackground, describeBackgroundControls, normalizeBlur, normalizeDim, normalizeScope, pickBackground, readBackground } from '../../lib/background';

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

  // 背景图片：图片本身由主进程存到 userData/backgrounds，偏好只保存开关与参数。
  // 每次换图都递增 backgroundVersion，App.tsx 据此重新读取。
  const backgroundEnabled = prefBool(prefs, 'backgroundImage', false);
  const backgroundDim = normalizeDim(prefs.backgroundDim);
  const backgroundBlur = normalizeBlur(prefs.backgroundBlur);
  const backgroundScope = normalizeScope(prefs.backgroundScope);
  const backgroundVersion = Number(prefs.backgroundVersion) || 0;
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const [backgroundError, setBackgroundError] = useState('');
  // Whether an image is actually stored. The switch and the file are two
  // separate things: the preference survives a cleared userData directory, a
  // failed copy, or a manual delete of backgrounds/, and it can also be on with
  // nothing ever chosen (turning the switch on does not pick a file). Keying the
  // button label off the switch alone then promised a 更换 that had nothing to
  // replace, and the enabled-but-empty case rendered a UI with no image and no
  // hint why.
  const [backgroundStored, setBackgroundStored] = useState<boolean | null>(null);
  const setBackgroundEnabled = (v: boolean) => savePref({ backgroundImage: v });
  const setBackgroundDim = (v: number) => savePref({ backgroundDim: v });
  const setBackgroundBlur = (v: number) => savePref({ backgroundBlur: v });
  const setBackgroundScope = (v: 'app' | 'chat') => savePref({ backgroundScope: v });

  // Ask the main process what is actually stored. Re-probed whenever the
  // version stamp changes, so a pick or a removal is reflected immediately.
  useEffect(() => {
    let cancelled = false;
    void readBackground().then((dataUrl) => {
      if (!cancelled) setBackgroundStored(dataUrl !== null);
    });
    return () => { cancelled = true; };
  }, [backgroundVersion]);

  const controls = describeBackgroundControls(backgroundStored, backgroundEnabled);

  async function chooseBackground() {
    setBackgroundError('');
    setBackgroundBusy(true);
    try {
      const result = await pickBackground();
      if (!result.ok) {
        if (!result.canceled) setBackgroundError(result.error ?? '选择图片失败');
        return;
      }
      // 选好图片即视为启用，避免「选了但没开」的困惑。
      savePref({ backgroundImage: true, backgroundVersion: result.version });
      setBackgroundStored(true);
    } finally {
      setBackgroundBusy(false);
    }
  }

  async function removeBackground() {
    setBackgroundError('');
    setBackgroundBusy(true);
    try {
      await clearBackground();
      savePref({ backgroundImage: false, backgroundVersion: backgroundVersion + 1 });
      setBackgroundStored(false);
    } finally {
      setBackgroundBusy(false);
    }
  }

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

      <SettingsCard heading="背景">
        <SettingRow
          title="使用背景图片"
          description="在界面背景显示自定义图片"
          control={<Toggle checked={backgroundEnabled} onChange={setBackgroundEnabled} label="使用背景图片" />}
        />
        <SettingRow
          title="背景图片"
          description="PNG / JPG / WebP，最大 16 MB"
          control={
            <div className="background-picker">
              <button type="button" className="settings-button" onClick={() => void chooseBackground()} disabled={backgroundBusy}>
                {backgroundBusy ? '处理中…' : controls.pickLabel}
              </button>
              {controls.showRemove && (
                <button type="button" className="settings-button ghost" onClick={() => void removeBackground()} disabled={backgroundBusy}>
                  移除
                </button>
              )}
            </div>
          }
        />
        {backgroundError && <p className="settings-error" role="alert">{backgroundError}</p>}
        {controls.showEmptyHint && (
          <p className="settings-error" role="status">已开启背景但还没有选择图片，点击「选择图片…」挑一张。</p>
        )}
        <SettingRow
          title="显示范围"
          description="背景显示的范围"
          control={<Segmented value={backgroundScope} onChange={setBackgroundScope} options={[
            { value: 'chat', label: '仅对话区' },
            { value: 'app', label: '整个界面' },
          ]} />}
        />
        <SettingRow
          title="压暗"
          description="压暗图片，保证文字可读"
          control={<Slider value={Math.round(backgroundDim * 100)} min={0} max={90} onChange={(next) => setBackgroundDim(next / 100)} />}
        />
        <SettingRow
          title="模糊"
          description="柔化背景细节"
          control={<Slider value={backgroundBlur} min={0} max={40} onChange={setBackgroundBlur} />}
        />
      </SettingsCard>

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
          description="中文界面使用的字体"
          control={<SelectPill value={chineseFont} onChange={(next) => onFontChange({ uiChineseFont: next })} options={CHINESE_FONT_OPTIONS} />}
        />
        <SettingRow
          title="English font"
          description="Font used for the English interface"
          control={<SelectPill value={englishFont} onChange={(next) => onFontChange({ uiEnglishFont: next })} options={ENGLISH_FONT_OPTIONS} />}
        />
        <SettingRow
          title="代码字体大小"
          description="代码的基础字号"
          control={<NumberField value={codeFontSize} onChange={(next) => onFontSizeChange({ codeFontSize: next })} suffix="px" min={8} max={24} />}
        />
        <SettingRow
          title="缩进宽度"
          description="Tab 缩进的空格数"
          control={<NumberField value={editorTabSize} onChange={(next) => onEditorPrefChange({ editorTabSize: next })} suffix="格" min={2} max={8} />}
        />
        <SettingRow
          title="显示小地图"
          description="在编辑器右侧显示缩略图"
          control={<Toggle checked={editorMinimap} onChange={(next) => onEditorPrefChange({ editorMinimap: next })} label="显示小地图" />}
        />
        <SettingRow
          title="自动换行"
          description="长行在编辑器宽度处折行"
          control={<Toggle checked={editorWordWrap} onChange={(next) => onEditorPrefChange({ editorWordWrap: next })} label="自动换行" />}
        />
      </SettingsCard>
    </div>
  );
}
