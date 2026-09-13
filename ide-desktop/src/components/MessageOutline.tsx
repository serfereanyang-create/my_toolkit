import { useMemo, useState } from 'react';
import { ListTree, ChevronDown, ChevronRight } from 'lucide-react';
import { extractOutline, filterOutline, walkOutline } from '../lib/markdownOutline';

/**
 * Iteration 12 — floating table-of-contents for long assistant replies.
 *
 * Only mounts when the document actually has headings (≥ MIN entries), so
 * short answers keep their clean Codex look. Clicking an entry scrolls the
 * matching anchor (ids assigned by Markdown's headingAnchors) into view
 * inside the transcript scroller. A tiny search box prunes the list via
 * filterOutline — matching the search affordances elsewhere in the app.
 */

const MIN_ENTRIES = 3;

export function MessageOutline({ text, anchorPrefix }: { text: string; anchorPrefix?: string }) {
  const [open, setOpen] = useState(false);
  const [needle, setNeedle] = useState('');

  const outline = useMemo(() => extractOutline(text), [text]);
  const visible = useMemo(() => filterOutline(outline, needle), [outline, needle]);
  const rows = useMemo(() => walkOutline(visible), [visible]);

  if (outline.total < MIN_ENTRIES) return null;

  function jump(id: string) {
    const el = document.getElementById(anchorPrefix ? `${anchorPrefix}--${id}` : id);
    if (!el) return;
    // Prefer scrolling the nearest scrollable ancestor smoothly.
    const scroller = el.closest('.stream') ?? el.parentElement;
    if (scroller && 'scrollTo' in scroller) {
      const top = el.getBoundingClientRect().top - (scroller.getBoundingClientRect().top) + scroller.scrollTop - 8;
      scroller.scrollTo({ top, behavior: 'smooth' });
    } else {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  return (
    <div className={`msg-outline${open ? ' open' : ''}`}>
      <button
        type="button"
        className="msg-outline-toggle"
        title="目录"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ListTree size={13} />
        <span>{outline.total}</span>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </button>
      {open && (
        <div className="msg-outline-pop">
          <input
            className="msg-outline-filter"
            placeholder="筛选标题…"
            value={needle}
            onChange={(e) => setNeedle(e.target.value)}
          />
          <div className="msg-outline-list">
            {rows.length === 0 && <div className="msg-outline-empty">无匹配标题</div>}
            {rows.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="msg-outline-item"
                style={{ paddingLeft: 8 + entry.depth * 12 }}
                title={entry.text}
                onClick={() => { jump(entry.id); }}
              >
                <span className={`msg-outline-dot lv${Math.min(entry.level, 4)}`} />
                <span className="msg-outline-text">{entry.text}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
