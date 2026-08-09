import { useState } from 'react';
import { FilePlus, Clock, FolderOpen, Files, Settings, PanelLeft, Search, HelpCircle } from 'lucide-react';
import type { AppState } from '../types';
import { HelpMenu, type HelpAction } from './HelpMenu';
import { ConversationContextMenu, type ConvoAction } from './ConversationContextMenu';

type MainView = 'chat' | 'files' | 'editor' | 'settings';

export function Rail({ state, sessions, mainView, onNewChat, onOpenWorkspace, onSelectView, onHelpAction, onConvoAction }: {
  state: AppState;
  sessions: string[];
  mainView: MainView;
  onNewChat: () => void;
  onOpenWorkspace: () => void;
  onSelectView: (view: MainView) => void;
  onHelpAction: (action: HelpAction) => void;
  onConvoAction: (action: ConvoAction, session: string) => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number; session: string } | null>(null);
  const workspaceName = state.workspaceRoot ? state.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() : 'No project';

  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="rail-brand">
          <PanelLeft size={18} />
          <span>ZCode</span>
        </div>
        <div className="rail-head-actions">
          <button className="icon-button" title="Search" onClick={() => onSelectView('files')}><Search size={17} /></button>
        </div>
      </div>

      <nav className="rail-nav">
        <button className="rail-item" onClick={onNewChat}><FilePlus size={17} /> 新对话</button>
        <button className={`rail-item ${mainView === 'files' ? 'active' : ''}`} onClick={() => onSelectView('files')}><Files size={17} /> 文件</button>
        <button className={`rail-item ${mainView === 'editor' ? 'active' : ''}`} onClick={() => onSelectView('editor')}><FolderOpen size={17} /> 编辑器</button>
        <button className={`rail-item ${mainView === 'settings' ? 'active' : ''}`} onClick={() => onSelectView('settings')}><Settings size={17} /> 设置</button>
      </nav>

      <div className="rail-section">项目</div>
      <div className="rail-scroll">
        <button className="rail-convo" onClick={onOpenWorkspace} title={state.workspaceRoot || 'Open a folder'}>
          <FolderOpen size={16} />
          <span>{workspaceName}</span>
        </button>

        <div className="rail-section">会话</div>
        {sessions.length === 0
          ? <div className="pane-title" style={{ textTransform: 'none', letterSpacing: 0 }}>暂无会话</div>
          : sessions.map((name) => (
            <button
              key={name}
              className={`rail-convo ${ctx?.session === name ? 'active' : ''}`}
              title={name}
              onContextMenu={(event) => {
                event.preventDefault();
                setCtx({ x: event.clientX, y: event.clientY, session: name });
              }}
            >
              <Clock size={15} />
              <span>{name.replace(/\.json$/, '')}</span>
            </button>
          ))}
      </div>

      {ctx && (
        <ConversationContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          onPick={(action) => { const session = ctx.session; setCtx(null); onConvoAction(action, session); }}
        />
      )}

      <div className="rail-foot">
        <div className="rail-foot-anchor">
          {helpOpen && (
            <HelpMenu
              onClose={() => setHelpOpen(false)}
              onPick={(action) => { setHelpOpen(false); onHelpAction(action); }}
            />
          )}
          <button
            className={`rail-item ${helpOpen ? 'active' : ''}`}
            onClick={() => setHelpOpen((open) => !open)}
          >
            <HelpCircle size={17} /> 帮助
          </button>
        </div>
      </div>
    </aside>
  );
}
