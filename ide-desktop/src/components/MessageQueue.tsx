import { useState } from 'react';
import { ArrowUp, GripVertical, Pencil, Trash2, X, Check } from 'lucide-react';
import type { QueuedMessage } from '../types';

/*
 * MessageQueue — messages submitted while the agent was busy.
 *
 * A running turn used to make a new submission fail outright ("Agent turn
 * already running"), which lost whatever the user had typed. Queued messages
 * wait here and go out one per finished turn, in the order they were submitted.
 *
 * Each row can be sent immediately (interrupting nothing — it just jumps the
 * line), edited, or removed, because a queue the user cannot correct is worse
 * than no queue: they would have to wait for a message they no longer want.
 */
export function MessageQueue({ items, onSendNow, onEdit, onRemove }: {
  items: QueuedMessage[];
  onSendNow: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (items.length === 0) return null;

  return (
    <div className="msg-queue" role="list" aria-label="排队中的消息">
      {items.map((item, index) => {
        const isEditing = editing === item.id;
        return (
          <div className="msg-queue-item" role="listitem" key={item.id}>
            <GripVertical size={14} className="msg-queue-grip" aria-hidden="true" />
            {isEditing ? (
              <input
                className="msg-queue-input"
                value={draft}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { onEdit(item.id, draft); setEditing(null); }
                  // Escape abandons the edit and restores the original text.
                  if (event.key === 'Escape') setEditing(null);
                }}
              />
            ) : (
              <span className="msg-queue-text" title={item.text}>{item.text}</span>
            )}
            <span className="msg-queue-actions">
              {isEditing ? (
                <>
                  <button className="msg-queue-btn" title="保存" onClick={() => { onEdit(item.id, draft); setEditing(null); }}>
                    <Check size={14} />
                  </button>
                  <button className="msg-queue-btn" title="取消" onClick={() => setEditing(null)}>
                    <X size={14} />
                  </button>
                </>
              ) : (
                <>
                  {/* 立即 = send this one next, ahead of the others. It does not
                      cancel the running turn. */}
                  <button className="msg-queue-btn msg-queue-now" title="立即发送（插到队首）" onClick={() => onSendNow(item.id)}>
                    <ArrowUp size={13} />
                    <span>立即</span>
                  </button>
                  <button
                    className="msg-queue-btn"
                    title="编辑"
                    onClick={() => { setEditing(item.id); setDraft(item.text); }}
                  >
                    <Pencil size={14} />
                  </button>
                  <button className="msg-queue-btn" title="删除" onClick={() => onRemove(item.id)}>
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </span>
            <span className="msg-queue-index" aria-hidden="true">{index + 1}</span>
          </div>
        );
      })}
    </div>
  );
}
