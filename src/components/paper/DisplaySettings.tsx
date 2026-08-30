import { Divider, Segmented, Select } from 'antd';
import type { ReactNode } from 'react';
import type { AppTheme } from '../../lib/uiState';

export type ContrastLevel = 'soft' | 'normal' | 'high';
export type AppFont = 'system' | 'sans' | 'serif' | 'kai' | 'fangsong' | 'mono';

export type DisplaySettingsProps = {
  theme: AppTheme;
  textContrast: ContrastLevel;
  uiContrast: ContrastLevel;
  font: AppFont;
  onThemeChange: (theme: AppTheme) => void;
  onTextContrastChange: (value: ContrastLevel) => void;
  onUiContrastChange: (value: ContrastLevel) => void;
  onFontChange: (value: AppFont) => void;
  aiSettings?: ReactNode;
};

const themeOptions: Array<{ label: string; value: AppTheme }> = [
  { label: '冰川蓝', value: 'cool' },
  { label: '暖纸白', value: 'paper' },
  { label: '午夜黑', value: 'dark' },
];

const contrastOptions: Array<{ label: string; value: ContrastLevel }> = [
  { label: '柔和', value: 'soft' },
  { label: '标准', value: 'normal' },
  { label: '高对比', value: 'high' },
];

const fontOptions: Array<{ label: string; value: AppFont }> = [
  { label: '系统默认', value: 'system' },
  { label: '黑体', value: 'sans' },
  { label: '宋体', value: 'serif' },
  { label: '楷体', value: 'kai' },
  { label: '仿宋', value: 'fangsong' },
  { label: '等宽', value: 'mono' },
];

export function DisplaySettings({
  theme,
  textContrast,
  uiContrast,
  font,
  onThemeChange,
  onTextContrastChange,
  onUiContrastChange,
  onFontChange,
  aiSettings,
}: DisplaySettingsProps) {
  return (
    <div className="settings-panel">
      <div className="settings-panel-title">显示设置</div>
      <div className="settings-row">
        <span className="pref-label">主题</span>
        <Segmented
          size="small"
          block
          value={theme}
          onChange={(value) => onThemeChange(value as AppTheme)}
          options={themeOptions}
        />
      </div>

      <div className="settings-panel-title">高级显示设置</div>
      <div className="settings-row">
        <span className="pref-label">文字对比度</span>
        <Segmented
          size="small"
          block
          value={textContrast}
          onChange={(value) => onTextContrastChange(value as ContrastLevel)}
          options={contrastOptions}
        />
      </div>
      <div className="settings-row">
        <span className="pref-label">界面对比度</span>
        <Segmented
          size="small"
          block
          value={uiContrast}
          onChange={(value) => onUiContrastChange(value as ContrastLevel)}
          options={contrastOptions}
        />
      </div>
      <div className="settings-row">
        <span className="pref-label">字体</span>
        <Select
          size="small"
          className="font-select"
          value={font}
          onChange={(value) => onFontChange(value)}
          options={fontOptions}
          style={{ width: '100%' }}
        />
      </div>

      {aiSettings ? (
        <>
          <Divider />
          <div className="settings-panel-title">AI 服务</div>
          {aiSettings}
        </>
      ) : null}
    </div>
  );
}
