import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Pin, Trash2, Pencil, Archive,
  FolderOpen, Copy, Hash, Link2, GitFork, FileDown, Tag, MessageSquare,
} from 'lucide-react';

export type ConvoAction =
  | 'pin' | 'remove' | 'rename' | 'archive'
  | 'reveal' | 'copy-cwd' | 'copy-id' | 'copy-deeplink'
  | 'open-chat' | 'fork-chat' | 'export-md' | 'edit-tags';

type Item =
  | { kind: 'item'; id: ConvoAction; name: string; icon: JSX.Element; danger?: boolean }
  | { kind: 'sep' };

const ITEMS: Item[] = [
  { kind: 'item', id: 'pin',     name: '置顶聊天',       icon: <Pin size={15} /> },
  { kind: 'item', id: 'rename',  name: '重命名聊天',     icon: <Pencil size={15} /> },
  { kind: 'item', id: 'edit-tags', name: '编辑标签…',    icon: <Tag size={15} /> },
  { kind: 'item', id: 'archive', name: '归档聊天',       icon: <Archive size={15} /> },
  // Was "从列表中移除", which reads as a hide-only action. It deletes the
  // session record from disk with no undo — 归档 is the reversible one and is
  // right above it, so the label has to say which is which.
  { kind: 'item', id: 'remove',  name: '永久删除聊天…',  icon: <Trash2 size={15} />, danger: true },
  { kind: 'sep' },
  { kind: 'item', id: 'reveal',       name: '在资源管理器中打开', icon: <FolderOpen size={15} /> },
  { kind: 'item', id: 'copy-cwd',     name: '复制工作目录',       icon: <Copy size={15} /> },
  { kind: 'item', id: 'copy-id',      name: '复制会话 ID',         icon: <Hash size={15} /> },
  { kind: 'item', id: 'copy-deeplink',name: '复制深度链接',        icon: <Link2 size={15} /> },
  { kind: 'item', id: 'export-md',    name: '导出为 Markdown',     icon: <FileDown size={15} /> },
  { kind: 'sep' },
  // Two different things that used to share one label. "在新聊天中继续" named
  // the second but did the first, so neither was actually reachable.
  { kind: 'item', id: 'open-chat', name: '打开此会话', icon: <MessageSquare size={15} /> },
  { kind: 'item', id: 'fork-chat', name: '分叉新会话', icon: <GitFork size={15} /> },
];

export function ConversationContextMenu({ x, y, onClose, onPick }: {
  x: number;
  y: number;
  onClose: (restoreFocus?: boolean) => void;
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
    ref.current?.querySelector<HTMLButtonElement>('.ctx-row')?.focus();
  }, []);

  useEffect(() => {
    function onDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      }
      if (!ref.current?.contains(event.target as Node)) return;
      const buttons = [...ref.current.querySelectorAll<HTMLButtonElement>('.ctx-row')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length
        : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
      if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
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
          <button type="button" role="menuitem" key={item.id} className={`ctx-row ${item.danger ? 'ctx-row-danger' : ''}`} onClick={() => onPick(item.id)}>
            <span className="ctx-icon">{item.icon}</span>
            <span className="ctx-name">{item.name}</span>
          </button>
        ))}
    </div>
  );
}
