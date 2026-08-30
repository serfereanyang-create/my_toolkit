import { useEffect, useRef, useState } from 'react';
import { File, Link, Search, X } from 'lucide-react';
import { desktop } from '../lib/ipc';
import type { TreeNode } from '../types';

export type MentionItem = {
  id: string;
  label: string;
  type: 'file' | 'url';
  /** relative workspace path */
  path?: string;
};

type Tab = 'file' | 'url';

export function MentionPicker({
  query,
  tree,
  terminalOutput,
  onPick,
  onClose,
}: {
  query: string;
  tree: TreeNode[];
  terminalOutput?: string;
  onPick: (item: MentionItem) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('file');
  const [fileResults, setFileResults] = useState<{ name: string; path: string; type: string }[]>([]);
  const [urlInput, setUrlInput] = useState(query.startsWith('http') ? query : '');
  const [focused, setFocused] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Search files
  useEffect(() => {
    if (tab !== 'file') return;
    let cancelled = false;
    desktop.nav.fileSearch(query).then((r) => { if (!cancelled) setFileResults(r ?? []); });
    return () => { cancelled = true; };
  }, [query, tab]);

  const fileItems: MentionItem[] = fileResults.map((f) => ({
    id: `file:${f.path}`, label: f.name, type: 'file', path: f.path,
  }));

  const activeItems = tab === 'file' ? fileItems : [];

  useEffect(() => { setFocused(0); }, [tab, fileResults]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocused((n) => Math.min(n + 1, activeItems.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setFocused((n) => Math.max(n - 1, 0)); }
    if (e.key === 'Enter')     { e.preventDefault(); if (activeItems[focused]) onPick(activeItems[focused]); }
    if (e.key === 'Escape')    { e.preventDefault(); onClose(); }
    if (e.key === 'Tab')       { e.preventDefault(); setTab((t) => t === 'file' ? 'url' : 'file'); }
  }

  return (
    <div className="mention-picker" onKeyDown={handleKeyDown} tabIndex={-1} ref={(el) => el?.focus()}>
      <div className="mention-picker-header">
        <span className="mention-query">@{query}</span>
        <button className="mention-picker-close" onClick={onClose}><X size={13} /></button>
      </div>
      <div className="mention-picker-tabs">
        {([
          ['file', '文件', <File size={12} />],
          ['url', 'URL', <Link size={12} />],
        ] as [Tab, string, React.ReactNode][]).map(([id, label, icon]) => (
          <button
            key={id}
            className={`mention-tab ${tab === id ? 'active' : ''}`}
            onClick={() => setTab(id)}
          >
            {icon} {label}
          </button>
        ))}
      </div>

      <div className="mention-picker-list" ref={listRef}>
        {tab === 'url' ? (
          <div className="mention-url-input-wrap">
            <Search size={13} />
            <input
              autoFocus
              className="mention-url-input"
              placeholder="输入 URL..."
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && urlInput.trim()) {
                  e.stopPropagation();
                  onPick({ id: `url:${urlInput}`, label: urlInput, type: 'url', path: urlInput });
                }
                if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
              }}
            />
          </div>
        ) : activeItems.length === 0 ? (
          <div className="mention-empty">
            {query ? `未找到 "${query}"` : '开始输入以搜索…'}
          </div>
        ) : (
          activeItems.map((item, i) => (
            <button
              key={item.id}
              className={`mention-item ${i === focused ? 'focused' : ''}`}
              onClick={() => onPick(item)}
            >
              <span className="mention-item-icon"><File size={12} /></span>
              <span className="mention-item-label">{item.label}</span>
              {item.path && <span className="mention-item-path">{item.path}</span>}
            </button>
          ))
        )}
      </div>
      <div className="mention-picker-footer">
        ↑↓ 选择 · Enter 确认 · Tab 切换分类 · Esc 关闭
      </div>
    </div>
  );
}
