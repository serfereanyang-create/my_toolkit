import { FolderOpen, MessageSquarePlus, Globe, TerminalSquare } from 'lucide-react';
import type { ReactNode } from 'react';

/*
 * Empty-chat home page. Shows a centered launcher menu of quick actions.
 * Rendered by ConversationStream when there is no conversation yet.
 */

type LauncherItem = {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
};

// UX-6 fix: Ctrl+T opens the terminal (not the browser). The browser item's
// shortcut label was wrong. Browser is not yet implemented so its shortcut
// is removed until the feature ships.
const ITEMS: LauncherItem[] = [
  { id: 'files', label: '文件', icon: <FolderOpen size={17} />, shortcut: 'Ctrl+P' },
  { id: 'side-chat', label: '侧边聊天', icon: <MessageSquarePlus size={17} />, shortcut: 'Ctrl+Alt+S' },
  { id: 'browser', label: '浏览器', icon: <Globe size={17} /> },
  { id: 'terminal', label: '终端', icon: <TerminalSquare size={17} />, shortcut: 'Ctrl+T' },
];

export function ChatLauncher({ onPick }: { onPick: (id: string) => void }) {
  return (
    <div className="launcher">
      <div className="launcher-menu">
        {ITEMS.map((item) => (
          <button key={item.id} className="launcher-item" onClick={() => onPick(item.id)}>
            <span className="launcher-item-icon">{item.icon}</span>
            <span className="launcher-item-label">{item.label}</span>
            {item.shortcut && <span className="launcher-item-shortcut">{item.shortcut}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
