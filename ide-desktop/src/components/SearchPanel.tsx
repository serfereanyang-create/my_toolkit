import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, CaseSensitive, Regex, WholeWord, X, ChevronDown, ChevronRight, Loader2, MessagesSquare, FileText } from 'lucide-react';
import { desktop, type SearchHit, type SearchResult, type SessionSearchResult } from '../lib/ipc';

/**
 * Iteration 3 — workspace full-text search panel.
 * Iteration 16 — adds a second mode: cross-session transcript search, so old
 * conversations are findable by what was said in them, not just file text.
 *
 * Thin renderer over the main-process search engines (electron/
 * workspace-search.cjs and electron/session-search.cjs): the query is
 * debounced, results group by file / by session, and each hit can jump into
 * the editor or load the session. Case / regex / whole-word toggles mirror
 * the backend matcher flags one-to-one.
 */

type Props = {
  /** Open a hit in the editor at the given line. */
  onOpenHit: (path: string, line: number) => void;
  /** Load a transcript session (iteration 16 results). */
  onOpenSession: (sessionId: string) => void;
  workspaceRoot: string;
};

const HISTORY_KEY = 'zcode.search.history';

function loadHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, 12) : [];
  } catch {
    return [];
  }
}

function pushHistory(term: string) {
  if (!term.trim()) return;
  try {
    const prev = loadHistory().filter((t) => t !== term);
    localStorage.setItem(HISTORY_KEY, JSON.stringify([term, ...prev].slice(0, 12)));
  } catch {
    /* best-effort */
  }
}

/** Split `preview` into plain / marked parts around every occurrence of `needle`. */
function markPreview(preview: string, matched: string, caseSensitive: boolean): Array<{ text: string; hit: boolean }> {
  if (!matched) return [{ text: preview, hit: false }];
  const hay = caseSensitive ? preview : preview.toLowerCase();
  const needle = caseSensitive ? matched : matched.toLowerCase();
  const parts: Array<{ text: string; hit: boolean }> = [];
  let pos = 0;
  for (;;) {
    const at = hay.indexOf(needle, pos);
    if (at < 0) { parts.push({ text: preview.slice(pos), hit: false }); break; }
    if (at > pos) parts.push({ text: preview.slice(pos, at), hit: false });
    parts.push({ text: preview.slice(at, at + needle.length), hit: true });
    pos = at + needle.length;
  }
  return parts;
}

type FileGroup = { path: string; hits: SearchHit[] };

function groupByPath(hits: SearchHit[]): FileGroup[] {
  const map = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const bucket = map.get(hit.path);
    if (bucket) bucket.push(hit);
    else map.set(hit.path, [hit]);
  }
  return [...map.entries()].map(([path, hs]) => ({ path, hits: hs }));
}

export function SearchPanel({ onOpenHit, onOpenSession, workspaceRoot }: Props) {
  const [term, setTerm] = useState('');
  const [mode, setMode] = useState<'files' | 'sessions'>('files');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [sessionResult, setSessionResult] = useState<SessionSearchResult | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(0);

  const run = useCallback(async (query: string) => {
    if (!query.trim()) { setResult(null); setSessionResult(null); setError(null); return; }
    const mySeq = ++seqRef.current;
    setBusy(true);
    try {
      if (mode === 'files') {
        const out = await desktop.search.text(query, {
          caseSensitive, wholeWord, regex,
          include: include.trim() || undefined,
          exclude: exclude.trim() || undefined,
          maxResults: 400,
        });
        if (mySeq !== seqRef.current) return; // a newer search won the race
        if (out.error) { setError(out.error); setResult(null); }
        else { setError(null); setResult(out); pushHistory(query); }
      } else {
        const out = await desktop.search.sessions(query, { caseSensitive, wholeWord, regex, maxResults: 60 });
        if (mySeq !== seqRef.current) return;
        if (out.error) { setError(out.error); setSessionResult(null); }
        else { setError(null); setSessionResult(out); pushHistory(query); }
      }
    } catch (err) {
      if (mySeq !== seqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mySeq === seqRef.current) setBusy(false);
    }
  }, [mode, caseSensitive, wholeWord, regex, include, exclude]);

  // Debounce live re-runs while typing; Enter fires immediately.
  useEffect(() => {
    const t = window.setTimeout(() => { void run(term); }, 320);
    return () => window.clearTimeout(t);
  }, [term, mode, caseSensitive, wholeWord, regex, run]);

  const groups = useMemo(() => (result ? groupByPath(result.results) : []), [result]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function toggleGroup(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const totalHits = result?.results.length ?? 0;

  return (
    <div className="search-panel">
      <div className="search-modes">
        <button type="button" className={`search-mode${mode === 'files' ? ' active' : ''}`} onClick={() => setMode('files')}>
          <FileText size={12} /> 文件
        </button>
        <button type="button" className={`search-mode${mode === 'sessions' ? ' active' : ''}`} onClick={() => setMode('sessions')}>
          <MessagesSquare size={12} /> 历史会话
        </button>
      </div>
      <div className="search-bar">
        <Search size={14} className="search-bar-icon" />
        <input
          ref={inputRef}
          className="search-input"
          placeholder={mode === 'files' ? '在工作区中搜索…' : '在所有会话记录中搜索…'}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { void run(term); } }}
        />
        {term && <button className="search-clear" onClick={() => { setTerm(''); setResult(null); setSessionResult(null); }}><X size={13} /></button>}
        <div className="search-toggles">
          <button type="button" className={`search-toggle${caseSensitive ? ' on' : ''}`} title="区分大小写" onClick={() => setCaseSensitive((v) => !v)}><CaseSensitive size={15} /></button>
          <button type="button" className={`search-toggle${wholeWord ? ' on' : ''}`} title="全词匹配" onClick={() => setWholeWord((v) => !v)}><WholeWord size={15} /></button>
          <button type="button" className={`search-toggle${regex ? ' on' : ''}`} title="正则表达式" onClick={() => setRegex((v) => !v)}><Regex size={15} /></button>
          {mode === 'files' && (
            <button type="button" className={`search-toggle${showFilters ? ' on' : ''}`} title="包含 / 排除" onClick={() => setShowFilters((v) => !v)}>
              {showFilters ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </button>
          )}
        </div>
      </div>
      {showFilters && mode === 'files' && (
        <div className="search-filters">
          <input className="search-filter-input" placeholder="包含的文件（如 *.ts）" value={include} onChange={(e) => setInclude(e.target.value)} />
          <input className="search-filter-input" placeholder="排除的文件（如 dist/**）" value={exclude} onChange={(e) => setExclude(e.target.value)} />
        </div>
      )}
      <div className="search-status">
        {busy ? (
          <span className="search-busy"><Loader2 size={12} className="spin" /> 搜索中…</span>
        ) : error ? (
          <span className="search-error">{error}</span>
        ) : mode === 'files' && result ? (
          <span>{totalHits} 条结果 · {groups.length} 个文件 · 扫描 {result.filesScanned} 个 · {result.elapsedMs} ms{result.truncated ? ' · 已截断' : ''}</span>
        ) : mode === 'sessions' && sessionResult ? (
          <span>{sessionResult.results.length} 个会话命中 · 扫描 {sessionResult.sessionsScanned} 个 · {sessionResult.elapsedMs} ms{sessionResult.truncated ? ' · 已截断' : ''}</span>
        ) : (
          <span className="search-idle">输入关键词开始搜索（在 {workspaceRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '工作区'} 内）</span>
        )}
      </div>
      <div className="search-results">
        {mode === 'sessions'
          ? (sessionResult?.results ?? []).map((session) => {
            const isCollapsed = collapsed.has(session.sessionId);
            return (
              <div key={session.sessionId} className="search-file">
                <button type="button" className="search-file-head" onClick={() => toggleGroup(session.sessionId)}>
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  <span className="search-file-name">{session.sessionId.slice(0, 18)}</span>
                  <span className="search-file-dir">{session.model}</span>
                  <span className="search-file-count">{session.hitCount}</span>
                </button>
                {!isCollapsed && session.hits.map((hit, hi) => (
                  <button key={`${hit.messageIndex}-${hi}`} type="button" className="search-hit" onClick={() => onOpenSession(session.sessionId)}>
                    <span className="search-hit-line">{hit.role === 'user' ? '我' : 'AI'}</span>
                    <span className="search-hit-preview">
                      {hit.context.map((line, li) => (
                        <span key={li} className={line.matched ? 'search-context-hit' : undefined}>
                          {line.text}
                          {li < hit.context.length - 1 ? '\n' : ''}
                        </span>
                      ))}
                    </span>
                  </button>
                ))}
              </div>
            );
          })
          : groups.map((group) => {
          const isCollapsed = collapsed.has(group.path);
          const dir = group.path.includes('/') ? group.path.slice(0, group.path.lastIndexOf('/')) : '';
          const name = group.path.slice(group.path.lastIndexOf('/') + 1);
          return (
            <div key={group.path} className="search-file">
              <button type="button" className="search-file-head" onClick={() => toggleGroup(group.path)}>
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span className="search-file-name">{name}</span>
                {dir && <span className="search-file-dir">{dir}</span>}
                <span className="search-file-count">{group.hits.length}</span>
              </button>
              {!isCollapsed && group.hits.map((hit, hi) => (
                <button
                  key={hit.line + ':' + hi}
                  type="button"
                  className="search-hit"
                  onClick={() => onOpenHit(hit.path, hit.line)}
                >
                  <span className="search-hit-line">{hit.line}</span>
                  <span className="search-hit-preview">
                    {markPreview(hit.preview.trim(), hit.matched, caseSensitive).map((part, pi) => (
                      part.hit ? <mark key={pi} className="search-hit-mark">{part.text}</mark> : <span key={pi}>{part.text}</span>
                    ))}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
        {!busy && mode === 'files' && result && groups.length === 0 && <div className="search-empty">没有匹配项</div>}
        {!busy && mode === 'sessions' && sessionResult && sessionResult.results.length === 0 && <div className="search-empty">没有匹配的会话</div>}
      </div>
    </div>
  );
}
