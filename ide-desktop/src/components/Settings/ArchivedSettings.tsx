import { useCallback, useEffect, useState } from 'react';
import { ArchiveRestore, Trash2 } from 'lucide-react';
import { EmptyState } from './controls';
import { desktop } from '../../lib/ipc';
import type { SessionCleanupAnalysis } from '../../lib/ipc';
import type { SessionMeta } from '../../types';

/* Archived chats page. Lists sessions the user archived from the conversation
   context menu (persisted via the session overlay sidecar). Each row can be
   restored (unarchive) or permanently deleted. */
export function ArchivedSettings() {
  const [items, setItems] = useState<SessionMeta[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState<{ kind: 'restore' | 'delete'; id: string; message: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError('');
    desktop.sessions.listArchived()
      .then((list) => { setItems(list); setLoadError(''); })
      // A failed read used to render as 没有已归档的聊天, which reads as
      // "you never archived anything" rather than "the read failed".
      .catch((error: unknown) => { setItems(null); setLoadError(messageOf(error)); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function restore(id: string) {
    setActionError(null);
    setBusyId(id);
    try {
      const result = await desktop.sessions.archive(id, false);
      if (!result?.ok) throw new Error('恢复没有成功');
      refresh();
    } catch (error) {
      setActionError({ kind: 'restore', id, message: messageOf(error) });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    setActionError(null);
    setBusyId(id);
    try {
      const result = await desktop.sessions.delete(id);
      if (!result?.ok) throw new Error('删除没有成功');
      refresh();
    } catch (error) {
      setActionError({ kind: 'delete', id, message: messageOf(error) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="settings-page">
      <h1 className="settings-page-title">已归档的聊天</h1>

      <EmptySessionCleanup />

      {items === null && loading && <EmptyState title="正在加载已归档的聊天..." loading />}

      {loadError && (
        <div className="settings-error-row" role="alert">
          <span>无法加载已归档的聊天：{loadError}</span>
          <button type="button" onClick={refresh}>重试</button>
        </div>
      )}

      {actionError && (
        <div className="settings-error-row" role="alert">
          <span>{actionError.kind === 'restore' ? '恢复失败' : '删除失败'}：{actionError.message}</span>
          <button
            type="button"
            onClick={() => {
              const failed = actionError;
              if (failed.kind === 'restore') void restore(failed.id);
              else void remove(failed.id);
            }}
          >
            重试
          </button>
        </div>
      )}

      {items !== null && items.length === 0 && (
        <EmptyState title="没有已归档的聊天" description="从会话右键菜单归档的聊天会显示在此处" />
      )}

      {items !== null && items.length > 0 && (
        <div className="settings-card">
          {items.map((item) => (
            <div key={item.id} className="app-row">
              <div className="app-row-text">
                <span className="app-row-title">{item.title}</span>
                <span className="app-row-desc">{item.messageCount} 条消息 · {formatDate(item.updatedAt)}</span>
              </div>
              <div className="app-row-control" style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="settings-action-btn" disabled={busyId === item.id} onClick={() => void restore(item.id)}>
                  <ArchiveRestore size={14} /><span>恢复</span>
                </button>
                <button type="button" className="settings-icon-btn" aria-label="永久删除" disabled={busyId === item.id} onClick={() => void remove(item.id)}>
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* Sessions that never got a user message are pure noise in the sidebar: a
   Ctrl+N that was abandoned, a fork marker, a failed start. The backend that
   analyses and deletes them existed with no way to reach it, so they piled up
   forever. The row appears only when there is something to clean, and deleting
   always takes a second click. */
function EmptySessionCleanup() {
  const [analysis, setAnalysis] = useState<SessionCleanupAnalysis | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    desktop.sessionCleanup.analyze()
      .then((result) => setAnalysis(result.analyses?.[0] ?? null))
      .catch(() => setAnalysis(null));
  }, []);

  useEffect(() => { load(); }, [load]);

  const count = analysis?.candidates.length ?? 0;
  // After a successful clean the candidate count drops to zero. Without the
  // note the whole row vanished on the click, so the user could not tell
  // whether anything had happened. Keep the row for the result, then let the
  // next visit drop it.
  if (!analysis || (count === 0 && !note && !error)) return null;

  const free = formatBytes(analysis.candidateBytes);

  async function clean() {
    if (!analysis || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await desktop.sessionCleanup.deleteFiles(analysis.dir, analysis.candidates.map((c) => c.id));
      const skipped = result.skipped.length;
      setNote(
        `已删除 ${result.deleted.length} 个空会话，释放 ${formatBytes(result.freedBytes)}`
        + (skipped ? `，${skipped} 个因已恢复内容而跳过` : ''),
      );
      setConfirming(false);
      // Re-read rather than assuming zero: deletion re-validates every id, and
      // anything skipped must still be listed with its real count.
      load();
    } catch (failure) {
      // Deleting is irreversible and goes through IPC: a rejected call used to
      // be an unhandled rejection, leaving the confirm buttons re-enabled and
      // no word about why nothing was removed.
      setError(messageOf(failure));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-card" style={{ marginBottom: 16 }}>
      <div className="app-row">
        <div className="app-row-text">
          <span className="app-row-title">{count > 0 ? `${count} 个空会话` : '空会话已清理'}</span>
          <span className="app-row-desc">
            {note ?? `没有用户消息的会话，占用 ${free}`}
          </span>
        </div>
        {count > 0 && (
          <div className="app-row-control" style={{ display: 'flex', gap: 8 }}>
            {confirming ? (
              <>
                <button type="button" className="settings-action-btn danger" disabled={busy} onClick={() => void clean()}>
                  {busy ? '清理中…' : '确认清理'}
                </button>
                <button type="button" className="settings-action-btn" disabled={busy} onClick={() => setConfirming(false)}>取消</button>
              </>
            ) : (
              <button type="button" className="settings-action-btn" onClick={() => { setNote(null); setConfirming(true); }}>
                <Trash2 size={14} /><span>清理</span>
              </button>
            )}
          </div>
        )}
      </div>
      {error && (
        <div className="settings-error-row" role="alert">
          <span>清理空会话失败：{error}</span>
          <button type="button" disabled={busy} onClick={() => void clean()}>重试</button>
        </div>
      )}
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '未知错误');
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}
