import { FileText, FileType2, Sheet, Presentation, LayoutTemplate, Globe, Monitor, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { SectionHeader, Toggle } from './controls';
import { prefStrArray, type Prefs, type SavePref } from './prefs';

/* The enabled set persists through preferences (pluginsEnabled: string[]).
   Binding a plugin to a real agent capability comes later; today toggling
   records intent durably. */

type PluginDef = {
  id: string;
  name: string;
  desc: string;
  icon: ReactNode;
  tint: string;
  default: boolean;
};

const PLUGINS: PluginDef[] = [
  { id: 'documents', name: 'Documents', desc: '创建和编辑文档工件', icon: <FileText size={18} />, tint: '#4b83f0', default: true },
  { id: 'pdf', name: 'PDF', desc: '读取、创建和校验 PDF 文件', icon: <FileType2 size={18} />, tint: '#e05a4a', default: true },
  { id: 'spreadsheets', name: 'Spreadsheets', desc: '创建和编辑电子表格文件', icon: <Sheet size={18} />, tint: '#3aa675', default: true },
  { id: 'presentations', name: 'Presentations', desc: '创建和编辑演示文稿', icon: <Presentation size={18} />, tint: '#e8a13a', default: false },
  { id: 'template', name: 'Template Creator', desc: '从参考内容创建或更新可复用模板', icon: <LayoutTemplate size={18} />, tint: '#9b8cf0', default: false },
  { id: 'browser', name: '浏览器', desc: '通过 YOYcode 控制应用内浏览器', icon: <Globe size={18} />, tint: '#4b9ff0', default: true },
  { id: 'computer', name: '电脑', desc: '从 YOYcode 控制 Windows 应用', icon: <Monitor size={18} />, tint: '#4bb0e0', default: false },
  { id: 'visualize', name: 'Visualize', desc: '将想法和数据转化为交互式可视化内容', icon: <Sparkles size={18} />, tint: '#4b83f0', default: true },
];

const DEFAULT_ENABLED = PLUGINS.filter((p) => p.default).map((p) => p.id);

export function PluginsSettings({ prefs, savePref }: { prefs: Prefs; savePref: SavePref }) {
  const enabled = prefStrArray(prefs, 'pluginsEnabled', DEFAULT_ENABLED);

  function toggle(id: string, next: boolean) {
    const set = new Set(enabled);
    if (next) set.add(id); else set.delete(id);
    savePref({ pluginsEnabled: PLUGINS.filter((p) => set.has(p.id)).map((p) => p.id) });
  }

  return (
    <div className="settings-page">
      <h1 className="settings-page-title">插件</h1>

      <SectionHeader
        title="可用插件"
        description={<>启用插件以扩展 YOYcode 的能力。<a href="#" className="settings-link">了解更多</a></>}
      />

      <div className="settings-card">
        {PLUGINS.map((plugin) => (
          <div key={plugin.id} className="app-row">
            <span className="app-row-icon" style={{ color: plugin.tint }}>{plugin.icon}</span>
            <div className="app-row-text">
              <span className="app-row-title">{plugin.name}</span>
              <span className="app-row-desc">{plugin.desc}</span>
            </div>
            <div className="app-row-control">
              <Toggle checked={enabled.includes(plugin.id)} onChange={(next) => toggle(plugin.id, next)} label={plugin.name} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
