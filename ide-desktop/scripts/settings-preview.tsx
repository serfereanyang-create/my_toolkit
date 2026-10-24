import React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsView } from '../src/components/Settings/SettingsView';
import type { DesktopSettings } from '../src/types';
import '../src/styles.css';
import '../src/conversation-shell.css';
import '../src/settings-shell.css';

const settings: DesktopSettings = {
  activeProviderId: 'preview',
  approval: 'ask',
  recentWorkspaces: [],
  providers: [
    { id: 'preview', type: 'custom', label: '工作模型', baseUrl: 'https://api.preview.invalid/v1', model: 'gpt-5.4', keyHint: 'saved', models: [{ id: 'gpt-5.4', contextWindow: 128000 }, { id: 'claude-4.5', contextWindow: 200000 }] },
    { id: 'backup', type: 'custom', label: '备用中转', baseUrl: 'https://backup.preview.invalid/v1', model: 'deepseek-v4.1', keyHint: 'missing', models: [{ id: 'deepseek-v4.1', contextWindow: 128000 }] },
  ],
  preferences: { theme: 'light', reasoningEffort: 'high', 'gen.language': 'zh-CN' },
};

(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = {
  dispatch: { options: async () => ({ ok: true, options: [] }) },
  connectivity: { test: async () => ({ ok: true, message: '测试连接成功', latencyMs: 42 }) },
  secrets: { save: async () => ({ ok: true }) },
  commands: { list: async () => ({ ok: true, commands: [] }) },
};

function Preview() {
  const save = (next: DesktopSettings) => { (window as unknown as { settingsPreviewState?: DesktopSettings }).settingsPreviewState = next; };
  return <SettingsView settings={settings} initialPage="general" onBack={() => {}} onSave={save} onSaveKey={async () => {}} />;
}

createRoot(document.getElementById('root')!).render(<Preview />);
