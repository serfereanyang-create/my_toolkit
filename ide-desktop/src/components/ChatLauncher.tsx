import { useEffect, useState } from 'react';
import { FolderOpen, MessageSquarePlus, Globe, TerminalSquare, PanelRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { desktop } from '../lib/ipc';

/*
 * Empty-chat home page, styled after the codex TUI first-run screen
 * (codex-rs/tui/src/history_cell/session.rs): a `>_ name (version)` header
 * box, the "To get started" command list, then the quick-action launcher.
 * Command rows insert into the composer via onPickCommand (App prefills).
 */

type LauncherItem = {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
};

// UX-6 fix: Ctrl+T opens the terminal (not the browser). All five items route
// to real implementations in App.handleLaunch.
const ITEMS: LauncherItem[] = [
  { id: 'files', label: '文件', icon: <FolderOpen size={17} />, shortcut: 'Ctrl+P' },
  { id: 'side-chat', label: '侧边聊天', icon: <MessageSquarePlus size={17} />, shortcut: 'Ctrl+Alt+S' },
  { id: 'browser', label: '浏览器', icon: <Globe size={17} /> },
  { id: 'terminal', label: '终端', icon: <TerminalSquare size={17} />, shortcut: 'Ctrl+T' },
  { id: 'workspace-tools', label: '工作区工具', icon: <PanelRight size={17} />, shortcut: 'Ctrl+Alt+W' },
];

const STARTER_COMMANDS: Array<[string, string]> = [
  ['/init', 'create AGENTS.md workspace instructions'],
  ['/model', 'show or switch the active model'],
  ['/plan', 'task board (confirm|pause|continue)'],
  ['/review', 'review the current changes'],
  ['/help', 'floating command palette'],
];

export function ChatLauncher({ onPick, onPickCommand }: {
  onPick: (id: string) => void;
  onPickCommand?: (command: string) => void;
}) {
  const [version, setVersion] = useState<string>('');
  useEffect(() => {
    let cancelled = false;
    desktop.app?.getVersion?.().then((value: { version: string }) => {
      if (!cancelled && value?.version) setVersion(value.version);
    }).catch(() => { /* version is cosmetic */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="launcher">
      <div className="launcher-left">
        <div className="codex-header-box" aria-label="会话信息">
          <div className="codex-header-title">&gt;_ YOYcode{version ? ` (v${version})` : ''}</div>
          <div className="codex-header-row"><span className="codex-header-label">model:</span> agent</div>
          <div className="codex-header-row"><span className="codex-header-label">workspace:</span> local project</div>
        </div>
        <div className="codex-welcome">
          <p className="codex-welcome-intro">To get started, describe a task or try one of these commands:</p>
          <ul className="codex-command-list">
            {STARTER_COMMANDS.map(([command, description]) => (
              <li key={command}>
                <button
                  className="codex-command-row"
                  title={`插入 ${command}`}
                  onClick={() => onPickCommand?.(command)}
                >
                  <span className="codex-command-name">{command}</span>
                  <span className="codex-command-desc"> - {description}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
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
