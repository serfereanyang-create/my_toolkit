import { useCallback, useEffect, useState } from 'react';
import { ArchiveRestore, Trash2 } from 'lucide-react';
import { EmptyState } from './controls';
import { desktop } from '../../lib/ipc';
import type { SessionMeta } from '../../types';

/* Archived chats page. Lists sessions the user archived from the conversation
   context menu (persisted via the session overlay sidecar). Each row can be
   restored (unarchive) or permanently deleted. */
export function ArchivedSettings() {
  const [items, setItems] = useState<SessionMeta[] | null>(null);

  const refresh = useCallback(() => {
    desktop.sessions.listArchived()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function restore(id: string) {
    await desktop.sessions.archive(id, false);
    refresh();
  }

  async function remove(id: string) {
    await desktop.sessions.delete(id);
    refresh();
  }

  return (
    <div className="settings-page">
      <h1 className="settings-page-title">已归档的聊天</h1>

      {items === null && <EmptyState title="正在加载已归档的聊天..." loading />}

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
                <button type="button" className="settings-action-btn" onClick={() => void restore(item.id)}>
                  <ArchiveRestore size={14} /><span>恢复</span>
                </button>
                <button type="button" className="settings-icon-btn" aria-label="永久删除" onClick={() => void remove(item.id)}>
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

function formatDate(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}
