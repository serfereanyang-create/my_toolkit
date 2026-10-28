import { useId, useRef, useState } from 'react';
import { Check, Tag, X } from 'lucide-react';
import { parseTagInput, tagColorIndex, MAX_PER_SESSION } from '../lib/sessionTags';
import { useModalFocus } from '../lib/useModalFocus';

/**
 * Modal editor for one session's tags (iteration 18). Existing tags show as
 * removable chips; the input accepts Enter or comma to commit, and paste-style
 * bulk input ("a, b, c") is parsed with the same rules as the store.
 *
 * Focus: this is an aria-modal overlay, so it uses the shared useModalFocus
 * trap like the other dialogs. Before that it had none of it — Tab and
 * Shift+Tab walked straight out into the rail behind the dialog, Escape only
 * worked while the caret sat in the text input (so once focus was on a chip or
 * on 保存 there was no keyboard exit at all), and closing dropped focus on
 * <body>. Escape keeps its old two-step meaning, now from anywhere inside:
 * clear a pending draft first, otherwise cancel.
 */
export function TagEditorDialog({ sessionTitle, initialTags, allTags, onConfirm, onCancel }: {
  sessionTitle: string;
  initialTags: string[];
  /** Every tag in the workspace, for click-to-add suggestions. */
  allTags: string[];
  onConfirm: (tags: string[]) => void;
  onCancel: () => void;
}) {
  const [tags, setTags] = useState<string[]>(initialTags);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogId = useId();

  // useModalFocus types its ref as HTMLElement (its other consumers are
  // <section> dialogs); this one is a <div>, so narrow it here.
  const dialogRef = useModalFocus(true, inputRef, {
    onEscape: () => { if (draft) setDraft(''); else onCancel(); },
  }) as React.RefObject<HTMLDivElement>;

  /** Merge `incoming` tags into the current set; returns the new list. */
  function merge(incoming: string[], current: string[]): string[] {
    const next = [...current];
    for (const tag of incoming) {
      if (next.includes(tag)) continue;
      if (next.length >= MAX_PER_SESSION) { setError(`单个会话最多 ${MAX_PER_SESSION} 个标签`); break; }
      next.push(tag);
    }
    return next;
  }

  function commitDraft() {
    if (!draft.trim()) return true;
    const parsed = parseTagInput(draft);
    if (parsed.length === 0) { setDraft(''); return true; }
    setTags((prev) => merge(parsed, prev));
    setDraft('');
    return true;
  }

  function removeTag(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag));
    setError(null);
  }

  function save() {
    // Fold any pending draft text into the result synchronously so Enter+Save
    // in one gesture can't drop what the user just typed.
    const parsed = draft.trim() ? parseTagInput(draft) : [];
    const finalTags = merge(parsed, tags);
    setError(null);
    onConfirm(finalTags);
  }

  const suggestions = allTags.filter((t) => !tags.includes(t)).slice(0, 10);

  return (
    <div className="tag-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="tag-dialog" role="dialog" aria-modal="true" ref={dialogRef} tabIndex={-1} aria-labelledby={`${dialogId}-title`}>
        <div className="tag-dialog-head">
          <span id={`${dialogId}-title`}><Tag size={13} /> 编辑标签</span>
          <button className="rename-close" onClick={onCancel} aria-label="关闭"><X size={15} /></button>
        </div>
        <div className="tag-dialog-sub">{sessionTitle}</div>
        <div className="tag-dialog-body">
          {tags.length === 0 && <div className="tag-none">还没有标签。输入后按回车添加，例如 bug、wip、实验。</div>}
          {tags.map((tag) => (
            <span key={tag} className={`tag-chip c${tagColorIndex(tag)}`}>
              {tag}
              <button type="button" onClick={() => removeTag(tag)} aria-label={`移除 ${tag}`}><X size={11} /></button>
            </span>
          ))}
          <input
            ref={inputRef}
            className="tag-input"
            aria-label="添加标签"
            placeholder={tags.length ? '添加标签，回车确认…' : '添加第一个标签…'}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitDraft(); }
              // Escape is owned by useModalFocus now: it fires on document in the
              // capture phase and stops propagation, so a handler here never runs.
            }}
          />
        </div>
        {suggestions.length > 0 && (
          <div className="tag-suggest">
            <span className="tag-suggest-label">常用</span>
            {suggestions.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`tag-chip small c${tagColorIndex(tag)}`}
                onClick={() => { setTags((prev) => merge([tag], prev)); }}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
        {error && <div className="tag-error">{error}</div>}
        <div className="tag-dialog-foot">
          <button className="rename-btn-cancel" onClick={onCancel}>取消</button>
          <button className="rename-btn-confirm" onClick={save}><Check size={13} /> 保存</button>
        </div>
      </div>
    </div>
  );
}
