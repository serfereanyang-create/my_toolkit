import { useCallback, useEffect, useMemo, useState } from 'react';
import { History, RefreshCw, RotateCcw, Trash2, FileClock, ChevronDown, ChevronRight } from 'lucide-react';
import { desktop, type HistoryEntry, type TrackedFile } from '../lib/ipc';
import { diffLines } from '../lib/lineDiff';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Iteration 7 — save-history browser.
 *
 * Lists every file the local timeline tracks (recorded on each manual save,
 * newest first), expands into per-file snapshots, and offers restore (write
 * the snapshot back to disk via IPC — the current bytes are snapshotted
 * first, so a restore is itself undoable), per-snapshot delete, and clear.
 */

function formatTs(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const sameDay = new Date().toDateString() === d.toDateString();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `今天 ${time}`;
  const yesterday = now - 86_400_000;
  if (new Date(yesterday).toDateString() === d.toDateString()) return `昨天 ${time}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fileNameOf(p: string): string {
  const norm = p.replace(/\\/g, '/');
  return norm.slice(norm.lastIndexOf('/') + 1) || norm;
}

function dirNameOf(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const cut = norm.lastIndexOf('/');
  return cut > 0 ? norm.slice(0, cut) : '';
}

export function FileHistoryPanel({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const [files, setFiles] = useState<TrackedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // Iteration 8: preview renders as a line diff vs the file on disk, not raw.
  const [previewDiff, setPreviewDiff] = useState<ReturnType<typeof diffLines> | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ kind: 'restore' | 'clear'; path: string; id?: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setFiles(await desktop.history.tracked());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function toggleFile(p: string) {
    if (expanded === p) { setExpanded(null); return; }
    setExpanded(p);
    setPreviewId(null);
    setPreview(null);
    try {
      setEntries(await desktop.history.list(p));
    } catch {
      setEntries([]);
    }
  }

  async function showSnapshot(p: string, id: string) {
    if (previewId === id) { setPreviewId(null); setPreview(null); setPreviewDiff(null); return; }
    const [res, current] = await Promise.all([
      desktop.history.read(p, id),
      desktop.editor.readFile(p).catch(() => ({ ok: false as const })),
    ]);
    if (!res.ok) { setError(res.error ?? '读取快照失败'); return; }
    const snapshotText = res.content ?? '';
    setPreviewId(id);
    setPreview(snapshotText);
    if (current.ok && typeof current.content === 'string') {
      setPreviewDiff(diffLines(snapshotText, current.content, 2));
    } else {
      setPreviewDiff(null);
    }
  }

  async function restore(p: string, id: string) {
    setConfirmAction({ kind: 'restore', path: p, id });
  }

  async function confirmRestore(p: string, id: string) {
    setBusy(true);
    try {
      const res = await desktop.history.restore(p, id);
      if (!res.ok) { setError(res.error ?? '恢复失败'); return; }
      setEntries(await desktop.history.list(p));
      setPreviewId(null);
      setPreview(null);
      await refresh();
      onOpenFile(p); // reload the tab so the editor shows restored bytes
    } finally {
      setBusy(false);
    }
  }

  async function removeSnapshot(p: string, id: string) {
    await desktop.history.remove(p, id);
    setEntries(await desktop.history.list(p));
    if (previewId === id) { setPreviewId(null); setPreview(null); }
    await refresh();
  }

  async function clearFile(p: string) {
    setConfirmAction({ kind: 'clear', path: p });
  }

  async function confirmClearFile(p: string) {
    await desktop.history.clear(p);
    setExpanded(null);
    await refresh();
  }

  const totalBytes = useMemo(() => files.reduce((sum, f) => sum + f.totalBytes, 0), [files]);

  return (
    <div className="hist-panel">
      <div className="hist-head">
        <span><FileClock size={13} /> 保存历史</span>
        <span className="hist-meta">
          {files.length} 个文件 · {formatBytes(totalBytes)}
          <button className="icon-button" title="刷新" onClick={() => { void refresh(); }} disabled={loading}><RefreshCw size={13} className={loading ? 'spin' : undefined} /></button>
        </span>
      </div>
      {error && <div className="hist-error" role="alert"><span>{error}</span><button type="button" className="panel-retry" onClick={() => { void refresh(); }} disabled={loading}>重试</button></div>}
      <div className="hist-list">
        {loading && <div className="hist-empty">载入中…</div>}
        {!loading && files.length === 0 && (
          <div className="hist-empty">
            还没有历史记录。在编辑器里 Ctrl+S 保存文件后，之前的内容会自动快照到这里。
          </div>
        )}
        {files.map((file) => {
          const isOpen = expanded === file.path;
          return (
            <div key={file.path} className="hist-file">
              <div className="hist-file-row">
                <button type="button" className="hist-file-head" onClick={() => { void toggleFile(file.path); }}>
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span className="hist-file-name">{fileNameOf(file.path)}</span>
                  <span className="hist-file-dir">{dirNameOf(file.path)}</span>
                  <span className="hist-file-count">{file.count}</span>
                </button>
                <button className="icon-button" title="清除该文件历史" onClick={() => { void clearFile(file.path); }}><Trash2 size={13} /></button>
              </div>
              {isOpen && (
                <div className="hist-snaps">
                  {entries.length === 0 && <div className="hist-snap-empty">无快照</div>}
                  {entries.map((entry) => (
                    <div key={entry.id} className="hist-snap">
                      <button
                        type="button"
                        className={`hist-snap-row${previewId === entry.id ? ' open' : ''}`}
                        onClick={() => { void showSnapshot(file.path, entry.id); }}
                        title={previewId === entry.id ? '收起预览' : '预览快照内容'}
                      >
                        <History size={12} />
                        <span className="hist-snap-time">{formatTs(entry.ts)}</span>
                        <span className="hist-snap-size">{formatBytes(entry.size)}</span>
                      </button>
                      <button
                        className="icon-button"
                        title="恢复此快照"
                        disabled={busy}
                        onClick={() => { void restore(file.path, entry.id); }}
                      ><RotateCcw size={13} /></button>
                      <button
                        className="icon-button"
                        title="删除此快照"
                        onClick={() => { void removeSnapshot(file.path, entry.id); }}
                      ><Trash2 size={12} /></button>
                    </div>
                  ))}
                  {previewId && preview !== null && (
                    previewDiff ? (
                      <div className="hist-diff">
                        <div className="hist-diff-stats">
                          <span className="hist-diff-add">+{previewDiff.added}</span>
                          <span className="hist-diff-del">-{previewDiff.removed}</span>
                          <span>快照 → 当前磁盘</span>
                        </div>
                        {previewDiff.hunks.map((hunk, hi) => (
                          <div key={hi} className="hist-diff-hunk">
                            <div className="hist-diff-header">@@ {hunk.oldStart} → {hunk.newStart} @@</div>
                            {hunk.ops.map((op, oi) => (
                              <div key={oi} className={`hist-diff-row hist-diff-${op.kind}`}>
                                <span className="hist-diff-sign">{op.kind === 'insert' ? '+' : op.kind === 'delete' ? '-' : ' '}</span>
                                <span className="hist-diff-text">{op.text}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                        {previewDiff.hunks.length === 0 && <div className="hist-snap-empty">与当前内容一致</div>}
                      </div>
                    ) : (
                      <pre className="hist-preview">{preview}</pre>
                    )
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction?.kind === 'restore' ? '恢复历史快照？' : '清除保存历史？'}
        message={confirmAction?.kind === 'restore'
          ? `恢复 ${fileNameOf(confirmAction.path)} 的快照会覆盖当前文件；当前内容会先进入历史，之后仍可撤销。`
          : `“${fileNameOf(confirmAction?.path ?? '')}”的全部保存历史将被清除。`}
        confirmLabel={confirmAction?.kind === 'restore' ? '恢复快照' : '清除历史'}
        danger={confirmAction?.kind === 'clear'}
        onConfirm={() => {
          const action = confirmAction;
          setConfirmAction(null);
          if (!action) return;
          if (action.kind === 'restore' && action.id) void confirmRestore(action.path, action.id);
          else if (action.kind === 'clear') void confirmClearFile(action.path);
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
