import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Loader2, Search, X } from 'lucide-react';
import { desktop, type QuickOpenFile } from '../lib/ipc';
import { highlightRanges } from '../lib/fuzzy';
import { rankQuickFiles, splitQuickPath, nameRanges } from '../lib/quickOpenRank';

/**
 * Ctrl+P quick-open overlay (Codex/VS Code "go to file" language): fuzzy
 * search over the whole workspace tree, Enter opens, Esc closes. Ranking
 * itself lives in lib/quickOpenRank so it is unit-testable without a DOM.
 */
export function QuickOpen({ open, onClose, onPick, workspaceRoot }: {
  open: boolean;
  onClose: () => void;
  onPick: (relPath: string) => void;
  workspaceRoot: string;
}) {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<QuickOpenFile[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // (Re)load the index each time the palette opens; cheap thanks to TTL cache.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setQuery('');
    setActive(0);
    setError(null);
    setBusy(true);
    desktop.quickopen.index(false).then((out) => {
      if (cancelled) return;
      if (out.error) setError(out.error);
      setFiles(out.files);
      setTruncated(out.truncated);
      setBusy(false);
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    });
    inputRef.current?.focus();
    return () => { cancelled = true; };
  }, [open, workspaceRoot]);

  const ranked = useMemo(() => rankQuickFiles(files, query, Date.now(), 50), [files, query]);

  useEffect(() => { setActive(0); }, [query]);

  // Keep the active row inside the viewport as the list re-filters.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[active] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
  }, [active, ranked]);

  if (!open) return null;

  function commit(path: string | undefined) {
    if (!path) return;
    onClose();
    onPick(path);
  }

  return (
    <div className="qopen-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="qopen-box">
        <div className="qopen-bar">
          <Search size={14} className="qopen-bar-icon" />
          <input
            ref={inputRef}
            className="qopen-input"
            placeholder="按文件名查找文件…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((v) => Math.min(ranked.length - 1, v + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((v) => Math.max(0, v - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); commit(ranked[active]?.file.path); }
              else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }}
          />
          <button type="button" className="qopen-close" onClick={onClose} title="关闭 (Esc)"><X size={13} /></button>
        </div>
        <div className="qopen-list" ref={listRef}>
          {busy && <div className="qopen-status"><Loader2 size={12} className="spin" /> 建立索引中…</div>}
          {!busy && error && <div className="qopen-status qopen-error">{error}</div>}
          {!busy && !error && ranked.length === 0 && <div className="qopen-status">没有匹配的文件</div>}
          {!busy && ranked.map((row, i) => {
            const { dir, name } = splitQuickPath(row.file.path);
            const inName = nameRanges(row.file.path, row.ranges);
            return (
              <button
                key={row.file.path}
                type="button"
                className={`qopen-row${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(row.file.path)}
              >
                <FileText size={13} className="qopen-row-icon" />
                <span className="qopen-row-name">
                  {highlightRanges(name, inName).map((part, pi) => (
                    part.hit ? <mark key={pi} className="qopen-mark">{part.text}</mark> : <span key={pi}>{part.text}</span>
                  ))}
                </span>
                {dir && <span className="qopen-row-dir">{dir}</span>}
              </button>
            );
          })}
        </div>
        <div className="qopen-foot">
          <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
          <span>{truncated ? '索引已截断（超过 20000 个文件）· ' : ''}{query.trim() ? `${ranked.length} / ${files.length}` : `${files.length} 个文件`}</span>
        </div>
      </div>
    </div>
  );
}
