import { useEffect, useRef, useState } from 'react';
import { Check, X, ChevronsDown, ChevronsUp, GitCompare } from 'lucide-react';
import type { PendingDiff } from '../../types';
import type { AppAction } from '../../lib/state';

type Props = {
  diffs: PendingDiff[];
  dispatch: React.Dispatch<AppAction>;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
};

// A file ending in "\n" splits into [..., ""] — drop the phantom trailing
// empty line so line counts aren't inflated and the diff never renders a
// bare "+" row.
function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function DiffReview({ diffs, dispatch, onApprove }: Props) {
  const pending  = diffs.filter((d) => d.status === 'pending');
  const resolved = diffs.filter((d) => d.status !== 'pending');

  if (diffs.length === 0) return null;

  function applyDiff(diff: PendingDiff) {
    onApprove(diff.id, 'allow_once');
  }

  function rejectDiff(diff: PendingDiff) {
    onApprove(diff.id, 'deny');
  }

  async function acceptAll() {
    for (const d of pending) await applyDiff(d);
  }

  function rejectAll() {
    for (const d of pending) rejectDiff(d);
  }

  function clearResolved() {
    dispatch({ type: 'diff/clearAll' });
  }

  return (
    <div className="diff-review-panel" aria-label="待确认文件更改">
      <div className="diff-review-header">
        <GitCompare size={14} />
        <span className="diff-review-title">待确认更改 ({pending.length})</span>
        <span className="diff-review-spacer" />
        {pending.length > 0 && <>
          <button className="diff-btn diff-btn-accept" onClick={acceptAll} title="接受全部">
            <Check size={12} /> 全部接受
          </button>
          <button className="diff-btn diff-btn-reject" onClick={rejectAll} title="拒绝全部">
            <X size={12} /> 全部拒绝
          </button>
        </>}
        {resolved.length > 0 && (
          <button className="diff-btn diff-btn-clear" onClick={clearResolved} title="清空列表（不影响已执行的审批）">
            清除
          </button>
        )}
      </div>

      {diffs.map((diff) => (
        <DiffCard key={diff.id} diff={diff} onAccept={applyDiff} onReject={rejectDiff} />
      ))}
    </div>
  );
}

function DiffCard({ diff, onAccept, onReject }: {
  diff: PendingDiff;
  onAccept: (d: PendingDiff) => void;
  onReject: (d: PendingDiff) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const isPending  = diff.status === 'pending';
  const isAccepted = diff.status === 'accepted';

  // Compute simple line diff summary
  const oldLines = splitLines(diff.originalContent);
  const newLines  = splitLines(diff.modifiedContent);
  const added   = newLines.length - oldLines.length;
  const name = diff.path.split(/[\\/]/).pop() ?? diff.path;

  return (
    <div className={`diff-card diff-card--${diff.status}`}>
      <div className="diff-card-header">
        <button className="diff-card-toggle" onClick={() => setExpanded((e) => !e)} aria-label="展开/折叠">
          {expanded ? <ChevronsUp size={12} /> : <ChevronsDown size={12} />}
        </button>
        <span className="diff-card-name" title={diff.path}>{name}</span>
        <span className="diff-card-stats">
          {added > 0 && <span className="diff-stat-add">+{added}</span>}
          {added < 0 && <span className="diff-stat-del">{added}</span>}
        </span>
        <span className="diff-card-status-badge">{isAccepted ? '✓ 已接受' : diff.status === 'rejected' ? '✗ 已拒绝' : ''}</span>
        {isPending && <>
          <button className="diff-btn diff-btn-accept" onClick={() => onAccept(diff)}><Check size={12} /> 接受</button>
          <button className="diff-btn diff-btn-reject" onClick={() => onReject(diff)}><X size={12} /> 拒绝</button>
        </>}
      </div>

      {expanded && (
        <MonacoDiffView original={diff.originalContent} modified={diff.modifiedContent} />
      )}
    </div>
  );
}

// Bug-14 fix: replace the Monaco diff editor (which requires the ~15MB
// monaco-editor package that was left as dead weight after the editor was
// removed) with a lightweight plain-text diff view. This eliminates the
// only remaining reference to monaco-editor so the dependency can be dropped.
function MonacoDiffView({ original, modified }: { original: string; modified: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const origLines = splitLines(original);
    const modLines  = splitLines(modified);
    const maxLines  = Math.max(origLines.length, modLines.length);

    // Simple line-by-line diff: mark removed / added / unchanged rows.
    const rows: { text: string; type: 'del' | 'add' | 'ctx' }[] = [];
    for (let i = 0; i < maxLines; i++) {
      const o = origLines[i] ?? '';
      const m = modLines[i]  ?? '';
      if (i >= origLines.length) {
        rows.push({ text: m, type: 'add' });
      } else if (i >= modLines.length) {
        rows.push({ text: o, type: 'del' });
      } else if (o !== m) {
        if (o) rows.push({ text: o, type: 'del' });
        if (m) rows.push({ text: m, type: 'add' });
      } else {
        rows.push({ text: o, type: 'ctx' });
      }
    }

    el.innerHTML = '';
    const pre = document.createElement('pre');
    pre.className = 'diff-plain';
    pre.style.cssText = 'margin:0;padding:8px;font-size:var(--fs-3);line-height:1.5;overflow:auto;max-height:300px;font-family:var(--font-mono)';
    for (const row of rows) {
      const line = document.createElement('div');
      line.textContent = (row.type === 'del' ? '− ' : row.type === 'add' ? '+ ' : '  ') + row.text;
      // The row tint stays on the accent (it is a fill); the +/− text is 12px
      // body copy, so it takes the ink twins: the danger tint left red at
      // 4.23-4.27:1 and the ok tint at 3.89:1, both under the 4.5:1 floor.
      line.style.cssText = row.type === 'del'
        ? 'background:color-mix(in srgb, var(--danger) 8%, transparent);color:var(--danger-ink)'
        : row.type === 'add'
          ? 'background:color-mix(in srgb, var(--ok) 10%, transparent);color:var(--ok-ink)'
          : 'color:var(--fg-muted)';
      pre.appendChild(line);
    }
    el.appendChild(pre);
  }, [original, modified]);

  return <div className="diff-monaco" ref={containerRef} />;
}
