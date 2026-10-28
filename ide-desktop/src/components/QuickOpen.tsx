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
  const closeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // The overlay owns Escape and Tab for as long as it is open. Escape used to
  // live on the query field only, so once focus left it the overlay had no
  // keyboard exit; Tab used to walk straight out to the composer behind the
  // overlay, leaving an open palette with focus somewhere else.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const stops: HTMLElement[] = [];
      if (inputRef.current) stops.push(inputRef.current);
      if (closeRef.current) stops.push(closeRef.current);
      if (stops.length === 0) return;
      event.preventDefault();
      const index = stops.indexOf(document.activeElement as HTMLElement);
      const next = index < 0
        ? (event.shiftKey ? stops.length - 1 : 0)
        : (index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length;
      stops[next].focus();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

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
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    inputRef.current?.focus();
    return () => {
      cancelled = true;
      // Hand focus back to whoever opened quick-open (usually the composer);
      // closing used to leave it on <body>. Skip it if another surface has
      // already claimed focus in the meantime.
      const current = document.activeElement;
      if (opener && opener.isConnected && (!current || current === document.body)) opener.focus();
    };
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
    <div className="qopen-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="qopen-box">
        <div className="qopen-bar">
          <Search size={14} className="qopen-bar-icon" />
          <input
            ref={inputRef}
            className="qopen-input"
            aria-label="按文件名查找文件"
            placeholder="按文件名查找文件…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((v) => Math.min(ranked.length - 1, v + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((v) => Math.max(0, v - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); commit(ranked[active]?.file.path); }
            }}
          />
          <button type="button" ref={closeRef} className="qopen-close" onClick={onClose} title="关闭 (Esc)"><X size={13} /></button>
        </div>
        <div className="qopen-list" ref={listRef} role="listbox" aria-label="文件结果">
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
                // One tab stop for the whole list (the query field, which owns
                // arrow/Enter navigation). As plain buttons every result row
                // became a stop, so Tab walked up to 50 rows of file names.
                tabIndex={-1}
                className={`qopen-row${i === active ? ' active' : ''}`}
                role="option"
                aria-selected={i === active}
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
