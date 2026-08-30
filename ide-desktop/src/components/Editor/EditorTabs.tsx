import { X } from 'lucide-react';

export interface EditorTab {
  path: string;
  dirty: boolean;
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
    <div className="editor-tabs">
      {tabs.map((tab) => (
        <div
          key={tab.path}
          className={`editor-tab ${tab.path === activeTab ? 'active' : ''} ${tab.dirty ? 'dirty' : ''}`}
          onClick={() => onTabClick(tab.path)}
          title={tab.path}
        >
          <span className="editor-tab-name">{getFileName(tab.path)}</span>
          {tab.dirty && <span className="editor-tab-dot">●</span>}
          <button
            className="editor-tab-close"
            onClick={(e) => {
              e.stopPropagation();
              onTabClose(tab.path);
            }}
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
