import { useEffect, useRef, useState } from 'react';
import { FileText, FileType2, Sheet, Presentation, LayoutTemplate, Globe, Monitor, Sparkles } from 'lucide-react';

export type PluginItem = {
  id: string;
  name: string;
  desc: string;
  icon: JSX.Element;
  tint: string;
};

// Static catalog for now; wiring to real capabilities comes later.
const PLUGINS: PluginItem[] = [
  { id: 'documents', name: 'Documents', desc: 'Create and edit document artifacts', icon: <FileText size={18} />, tint: '#4b83f0' },
  { id: 'pdf', name: 'PDF', desc: 'Read, create, and verify PDF files', icon: <FileType2 size={18} />, tint: '#e05a4a' },
  { id: 'spreadsheets', name: 'Spreadsheets', desc: 'Create and edit spreadsheet files', icon: <Sheet size={18} />, tint: '#3aa675' },
  { id: 'presentations', name: 'Presentations', desc: 'Create and edit presentations', icon: <Presentation size={18} />, tint: '#e8a13a' },
  { id: 'template', name: 'Template Creator', desc: 'Create or update reusable templates from reference content', icon: <LayoutTemplate size={18} />, tint: '#9b8cf0' },
  { id: 'browser', name: '浏览器', desc: 'Control the in-app browser with YOYcode', icon: <Globe size={18} />, tint: '#4b9ff0' },
  { id: 'computer', name: '电脑', desc: 'Control Windows apps from YOYcode', icon: <Monitor size={18} />, tint: '#4bb0e0' },
  { id: 'visualize', name: 'Visualize', desc: 'Turn ideas and data into interactive visuals', icon: <Sparkles size={18} />, tint: '#4b83f0' },
];

export function PluginMenu({ onClose, onPick }: { onClose: () => void; onPick: (plugin: PluginItem) => void }) {
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const filtered = query.trim()
    ? PLUGINS.filter((p) => `${p.name} ${p.desc}`.toLowerCase().includes(query.trim().toLowerCase()))
    : PLUGINS;

  return (
    <div className="plugin-menu" ref={ref} role="menu">
      <div className="plugin-section">插件</div>
      <div className="plugin-list">
        {filtered.map((plugin) => (
          <button key={plugin.id} className="plugin-row" onClick={() => onPick(plugin)}>
            <span className="plugin-icon" style={{ color: plugin.tint }}>{plugin.icon}</span>
            <span className="plugin-name">{plugin.name}</span>
            <span className="plugin-desc">{plugin.desc}</span>
          </button>
        ))}
      </div>
      <div className="plugin-section">文件和聊天</div>
      <input
        className="plugin-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="输入内容以搜索文件或聊天"
      />
    </div>
  );
}
