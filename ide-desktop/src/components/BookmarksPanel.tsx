import { useCallback, useEffect, useState } from 'react';
import { BookmarkCheck, Trash2, X } from 'lucide-react';
import { desktop, type BookmarkGroup } from '../lib/ipc';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Iteration 6 — workspace-wide bookmark jump list.
 *
 * Reads the per-workspace sidecar store the editor's glyph-margin toggles
 * write to, groups by file, and lets the user jump to (or clear) any mark.
 * `onJump` hands a path+line back to App, which routes it through the same
 * "open file at line" pipeline the search panel and quality panels use.
 */
export function BookmarksPanel({ onJump }: { onJump: (path: string, line: number) => void }) {
  const [groups, setGroups] = useState<BookmarkGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearTarget, setClearTarget] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setGroups(await desktop.bookmarks.listAll());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function clearFile(path: string) {
    setClearTarget(path);
  }

  async function confirmClearFile() {
    const path = clearTarget;
    setClearTarget(null);
    if (!path) return;
    try {
      await desktop.bookmarks.clearFile(path);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeOne(path: string, line: number) {
    try {
      await desktop.bookmarks.remove(path, line);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const total = groups.reduce((sum, g) => sum + g.bookmarks.length, 0);

  return (
    <div className="bm-panel">
      <div className="bm-head">
        <strong>书签</strong> · {total} 个标记 · {groups.length} 个文件 — 在编辑器最左侧装订线单击可添加/取消
      </div>
      {error && <div className="snip-error" role="alert" style={{ margin: 'var(--sp-2)' }}><span>{error}</span><button type="button" className="panel-retry" onClick={() => { void refresh(); }} disabled={loading}>重试</button></div>}
      <div className="bm-list">
        {loading && <div className="bm-empty">载入中…</div>}
        {!loading && total === 0 && (
          <div className="bm-empty">还没有书签。在编辑器里点一下行号左边的装订线就能标记。</div>
        )}
        {!loading && groups.map((group) => (
          <div key={group.path} className="bm-file">
            <div className="bm-file-name">
              <BookmarkCheck size={13} />
              <span>{group.path}</span>
              <span>{group.bookmarks.length}</span>
              <button className="bm-clear" title="清除该文件全部书签" onClick={() => { void clearFile(group.path); }}><X size={12} /></button>
            </div>
            {group.bookmarks.map((bm) => (
              <div key={bm.line} style={{ display: 'flex', alignItems: 'center' }}>
                <button
                  type="button"
                  className="bm-item"
                  style={{ flex: 1, minWidth: 0 }}
                  onClick={() => onJump(group.path, bm.line)}
                  title={bm.note || undefined}
                >
                  <span className="bm-item-line">{bm.line}</span>
                  <span className="bm-item-text">{bm.anchor || '(空行)'}</span>
                  {bm.note && <span className="bm-item-note">{bm.note}</span>}
                </button>
                <button className="bm-clear" title="删除此书签" onClick={() => { void removeOne(group.path, bm.line); }}><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={clearTarget !== null}
        title="清除文件书签？"
        message={`“${clearTarget ?? ''}”中的全部书签都会被清除。`}
        confirmLabel="清除书签"
        danger
        onConfirm={() => void confirmClearFile()}
        onCancel={() => setClearTarget(null)}
      />
    </div>
  );
}
