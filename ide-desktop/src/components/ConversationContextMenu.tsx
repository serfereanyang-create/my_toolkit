import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Pin, FolderInput, Trash2, Pencil, Archive, CheckCheck,
  FolderOpen, Copy, Hash, Link2, MessageSquarePlus, GitBranch, ExternalLink, ChevronRight,
} from 'lucide-react';

export type ConvoAction =
  | 'pin' | 'move' | 'remove' | 'rename' | 'archive' | 'mark-read'
  | 'reveal' | 'copy-cwd' | 'copy-id' | 'copy-deeplink'
  | 'continue-chat' | 'continue-worktree' | 'open-window';

type Item =
  | { kind: 'item'; id: ConvoAction; name: string; icon: JSX.Element; submenu?: boolean }
  | { kind: 'sep' };

const ITEMS: Item[] = [
  { kind: 'item', id: 'pin', name: '置顶聊天', icon: <Pin size={15} /> },
  { kind: 'item', id: 'move', name: '移至项目', icon: <FolderInput size={15} />, submenu: true },
  { kind: 'item', id: 'remove', name: '从 codex 中移除', icon: <Trash2 size={15} /> },
  { kind: 'item', id: 'rename', name: '重命名聊天', icon: <Pencil size={15} /> },
  { kind: 'item', id: 'archive', name: '归档聊天', icon: <Archive size={15} /> },
  { kind: 'item', id: 'mark-read', name: '标记为已读', icon: <CheckCheck size={15} /> },
  { kind: 'sep' },
  { kind: 'item', id: 'reveal', name: '在资源管理器中打开', icon: <FolderOpen size={15} /> },
  { kind: 'item', id: 'copy-cwd', name: '复制工作目录', icon: <Copy size={15} /> },
  { kind: 'item', id: 'copy-id', name: '复制会话 ID', icon: <Hash size={15} /> },
  { kind: 'item', id: 'copy-deeplink', name: '复制深度链接', icon: <Link2 size={15} /> },
  { kind: 'sep' },
  { kind: 'item', id: 'continue-chat', name: '在新聊天中继续', icon: <MessageSquarePlus size={15} /> },
  { kind: 'item', id: 'continue-worktree', name: '在新工作树中继续', icon: <GitBranch size={15} /> },
  { kind: 'sep' },
  { kind: 'item', id: 'open-window', name: '在新窗口中打开', icon: <ExternalLink size={15} /> },
];

export function ConversationContextMenu({ x, y, onClose, onPick }: {
  x: number;
  y: number;
  onClose: () => void;
  onPick: (action: ConvoAction) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

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

  return (
    <div className="ctx-menu" ref={ref} role="menu" style={{ left: pos.left, top: pos.top }}>
      {ITEMS.map((item, index) => item.kind === 'sep'
        ? <div key={`sep-${index}`} className="ctx-divider" />
        : (
          <button key={item.id} className="ctx-row" onClick={() => onPick(item.id)}>
            <span className="ctx-icon">{item.icon}</span>
            <span className="ctx-name">{item.name}</span>
            {item.submenu && <ChevronRight className="ctx-caret" size={14} />}
          </button>
        ))}
    </div>
  );
}
