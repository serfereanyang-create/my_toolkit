import { X } from 'lucide-react';

export interface EditorTab {
  path: string;
  dirty: boolean;
  stale?: boolean;
}

export interface EditorTabsProps {
  tabs: EditorTab[];
  activeTab: string | null;
  onTabClick: (path: string) => void;
  onTabClose: (path: string) => void;
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function EditorTabs({ tabs, activeTab, onTabClick, onTabClose }: EditorTabsProps) {
  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="editor-tabs" role="tablist" aria-label="打开的文件">
      {tabs.map((tab) => (
        <div
          key={tab.path}
          className={`editor-tab ${tab.path === activeTab ? 'active' : ''} ${tab.dirty ? 'dirty' : ''} ${tab.stale ? 'stale' : ''}`}
          role="tab"
          tabIndex={tab.path === activeTab ? 0 : -1}
          aria-selected={tab.path === activeTab}
          onClick={() => onTabClick(tab.path)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onTabClick(tab.path); }
          }}
          title={tab.stale ? `${tab.path}（磁盘内容已变化，保存前需确认）` : tab.path}
        >
          <span className="editor-tab-name">{getFileName(tab.path)}</span>
          {tab.dirty && <span className="editor-tab-dot">●</span>}
          {tab.stale && <span className="editor-tab-stale" title="磁盘内容已变化，保存前需确认">!</span>}
          <button
            type="button"
            className="editor-tab-close"
            onClick={(e) => {
              e.stopPropagation();
              onTabClose(tab.path);
            }}
            aria-label={`关闭 ${getFileName(tab.path)}`}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
