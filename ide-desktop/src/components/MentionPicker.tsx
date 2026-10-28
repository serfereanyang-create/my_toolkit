import { useEffect, useRef, useState } from 'react';
import { File, Link, Search, TerminalSquare, X } from 'lucide-react';
import { desktop } from '../lib/ipc';
import type { TreeNode } from '../types';

export type MentionItem = {
  id: string;
  label: string;
  type: 'file' | 'url' | 'terminal';
  /** relative workspace path */
  path?: string;
  content?: string;
};

type Tab = 'file' | 'url' | 'terminal';

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
  const [tab, setTab] = useState<Tab>(() => query.toLowerCase().includes('terminal') && terminalOutput?.trim() ? 'terminal' : 'file');
  const [fileResults, setFileResults] = useState<{ name: string; path: string; type: string }[]>([]);
  const [urlInput, setUrlInput] = useState(query.startsWith('http') ? query : '');
  const [focused, setFocused] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  /* Focus the popup once, on mount, and remember who had it (the composer
     textarea) so closing can hand it back. Both halves used to be wrong:
     the container focused itself from an inline `ref={(el) => el?.focus()}`
     callback, which React re-invokes on every render — so each keystroke in
     the URL field pulled focus back out of it (the field accepted exactly one
     character), and closing the picker left focus on <body>. */
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    rootRef.current?.focus();
    return () => {
      const current = document.activeElement;
      const lost = !current || current === document.body || rootRef.current?.contains(current) === true;
      if (opener?.isConnected && lost) opener.focus();
    };
  }, []);

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

  const availableTabs: Tab[] = terminalOutput?.trim() ? ['file', 'terminal', 'url'] : ['file', 'url'];
  const activeItems: MentionItem[] = tab === 'file'
    ? fileItems
    : tab === 'terminal' && terminalOutput?.trim()
      ? [{ id: 'terminal:current', label: '终端输出', type: 'terminal', content: terminalOutput }]
      : [];

  useEffect(() => { setFocused(0); }, [tab, fileResults]);

  /* Every tab switch tears down the previous tab's content — and on the URL tab
     that content owns the focus (the field is autoFocus'd). React drops focus
     on <body> when the focused node is removed, which left the open picker with
     no focused element: Tab walked off into the document behind it and the
     container's Escape handler stopped receiving anything, so the popup could
     not be dismissed from the keyboard at all. Pull the caret back in. */
  useEffect(() => {
    const root = rootRef.current;
    if (root && !root.contains(document.activeElement)) root.focus();
  }, [tab]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocused((n) => Math.min(n + 1, activeItems.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setFocused((n) => Math.max(n - 1, 0)); }
    if (e.key === 'Enter')     { e.preventDefault(); if (activeItems[focused]) onPick(activeItems[focused]); }
    if (e.key === 'Escape')    { e.preventDefault(); onClose(); }
    if (e.key === 'Tab') {
      e.preventDefault();
      setTab((current) => availableTabs[(availableTabs.indexOf(current) + 1) % availableTabs.length] ?? 'file');
    }
  }

  return (
    <div className="mention-picker" onKeyDown={handleKeyDown} tabIndex={-1} ref={rootRef} role="dialog" aria-label="引用文件或符号">
      <div className="mention-picker-header">
        <span className="mention-query">@{query}</span>
        <button className="mention-picker-close" onClick={onClose} aria-label="关闭引用选择器"><X size={13} /></button>
      </div>
      <div className="mention-picker-tabs">
        {([ 
          ['file', '文件', <File size={12} />],
          ...(terminalOutput?.trim() ? [['terminal', '终端', <TerminalSquare size={12} />] as [Tab, string, React.ReactNode]] : []),
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
              data-mention-content={item.type === 'terminal' ? item.content?.slice(-6000) : undefined}
              onClick={() => onPick(item)}
            >
              <span className="mention-item-icon">{item.type === 'terminal' ? <TerminalSquare size={12} /> : <File size={12} />}</span>
              <span className="mention-item-label">{item.label}</span>
              {item.path && <span className="mention-item-path">{item.path}</span>}
              {item.type === 'terminal' && item.content && <span className="mention-item-path">{item.content.split(/\r?\n/).filter(Boolean).slice(-1)[0]}</span>}
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
