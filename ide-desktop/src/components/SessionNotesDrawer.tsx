import { useCallback, useEffect, useState } from 'react';
import { Pin, Plus, StickyNote, Trash2, X } from 'lucide-react';
import { desktop, type SessionNote } from '../lib/ipc';

/**
 * Iteration 10 — per-session notes drawer.
 *
 * Sidecar notes for the current session: quick "remember this" entries the
 * user makes while the agent works. Stored in userData keyed by session id
 * (the CLI transcript is never touched). Pinned notes float to the top; the
 * draft note persists in localStorage while unsent so closing the drawer
 * doesn't lose a half-typed thought.
 */

const DRAFT_KEY = 'zcode.notes.draft';

export function SessionNotesDrawer({ sessionId, onClose }: {
  sessionId: string | null;
  onClose: () => void;
}) {
  // Notes attached to a brand-new (unsaved) chat live under a reserved id so
  // they at least survive within the app session.
  const key = sessionId ?? '__draft__';
  const [notes, setNotes] = useState<SessionNote[]>([]);
  const [text, setText] = useState(() => localStorage.getItem(DRAFT_KEY) ?? '');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setNotes(await desktop.notes.list(key));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Persist the half-typed draft across open/close.
  useEffect(() => {
    if (text) localStorage.setItem(DRAFT_KEY, text);
    else localStorage.removeItem(DRAFT_KEY);
  }, [text]);

  async function add() {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      await desktop.notes.add(key, { text: trimmed });
      setText('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function togglePin(note: SessionNote) {
    try {
      await desktop.notes.update(key, note.id, { pinned: !note.pinned });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveEdit(id: string, newText: string) {
    try {
      if (!newText.trim()) await desktop.notes.remove(key, id);
      else await desktop.notes.update(key, id, { text: newText });
      setEditingId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(note: SessionNote) {
    try {
      await desktop.notes.remove(key, note.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <aside className="notes-drawer">
      <div className="notes-head">
        <StickyNote size={14} />
        <span>会话笔记</span>
        <span className="notes-count">{notes.length}</span>
        <button className="icon-button" title="关闭" onClick={onClose}><X size={15} /></button>
      </div>
      {error && <div className="notes-error">{error}</div>}
      <div className="notes-list">
        {loading && <div className="notes-empty">载入中…</div>}
        {!loading && notes.length === 0 && (
          <div className="notes-empty">还没有笔记。记下这次任务的关键决定、坑、或下一步。</div>
        )}
        {notes.map((note) => (
          <div key={note.id} className={`notes-item${note.pinned ? ' pinned' : ''}`}>
            {editingId === note.id ? (
              <textarea
                className="notes-edit-area"
                defaultValue={note.text}
                autoFocus
                rows={3}
                onBlur={(e) => void saveEdit(note.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.preventDefault(); setEditingId(null); }
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void saveEdit(note.id, e.currentTarget.value); }
                }}
              />
            ) : (
              <p
                className="notes-text"
                onDoubleClick={() => setEditingId(note.id)}
                title="双击编辑"
              >{note.text}</p>
            )}
            <div className="notes-item-foot">
              <span>{new Date(note.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span className="notes-item-actions">
                <button
                  className={`icon-button${note.pinned ? ' active' : ''}`}
                  title={note.pinned ? '取消置顶' : '置顶'}
                  onClick={() => { void togglePin(note); }}
                ><Pin size={13} /></button>
                <button className="icon-button" title="删除" onClick={() => { void remove(note); }}><Trash2 size={13} /></button>
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="notes-compose">
        <textarea
          className="notes-input"
          placeholder="写一条笔记…（Ctrl+Enter 保存）"
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void add(); }
          }}
        />
        <button className="snip-btn snip-btn-primary" onClick={() => { void add(); }} disabled={!text.trim()}>
          <Plus size={13} /> 添加
        </button>
      </div>
    </aside>
  );
}
