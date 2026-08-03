import type { EditorTab } from '../types';

export function EditorTabs({ tabs, activePath, onActivate }: { tabs: EditorTab[]; activePath: string; onActivate: (path: string) => void }) {
  return (
    <div className="editor-tabs">
      {tabs.map((tab) => {
        const dirty = tab.content !== tab.savedContent;
        return (
          <button key={tab.path} className={tab.path === activePath ? 'active' : ''} onClick={() => onActivate(tab.path)} title={tab.path}>
            <span>{tab.path.split('/').pop()}</span>
            {dirty && <span className="dirty-dot" />}
          </button>
        );
      })}
    </div>
  );
}
