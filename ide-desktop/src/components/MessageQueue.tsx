import { useState } from 'react';
import { ArrowUp, GripVertical, Pencil, Trash2, X, Check } from 'lucide-react';
import type { QueuedMessage } from '../types';
import { canPromote } from '../lib/messageQueueSelect';

/*
 * MessageQueue — messages submitted while the agent was busy.
 *
 * A running turn used to make a new submission fail outright ("Agent turn
 * already running"), which lost whatever the user had typed. Queued messages
 * wait here and go out one per finished turn, in the order they were submitted.
 *
 * Each row can be sent immediately (jumping the line — it does not interrupt the
 * running turn), edited, or removed, because a queue the user cannot correct is
 * worse than no queue: they would have to wait for a message they no longer want.
 *
 * 立即 is DISABLED on the first row rather than being a live button that does
 * nothing. Promoting the entry that is already next is a no-op by definition,
 * and a button that swallows a click without feedback is indistinguishable from
 * a broken one — which is how this was reported. A disabled control with a
 * reason is honest; an enabled one that never responds is not.
 */
export function MessageQueue({ items, paused, onResume, onSendNow, onEdit, onRemove }: {
  items: QueuedMessage[];
  paused?: boolean;
  onResume?: () => void;
  onSendNow: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (items.length === 0) return null;

  return (
    <div className="msg-queue-wrap">
      {paused && <div className="msg-queue-paused" role="status"><span>队列已暂停，消息和附件仍保留。</span><button type="button" className="msg-queue-btn msg-queue-now" onClick={onResume}>继续队列</button></div>}
    <div className="msg-queue" role="list" aria-label="排队中的消息">
      {items.map((item, index) => {
        const isEditing = editing === item.id;
        // The first row is already next, so there is nothing to jump ahead of.
        const promotable = canPromote(items, item.id);
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
                      cancel the running turn. Disabled on the first row, where
                      it would have nothing to do. */}
                  <button
                    className="msg-queue-btn msg-queue-now"
                    disabled={!promotable}
                    title={promotable ? '立即发送（插到队首）' : '已经在队首，无需插队'}
                    onClick={() => onSendNow(item.id)}
                  >
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
    </div>
  );
}
