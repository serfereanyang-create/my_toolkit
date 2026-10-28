import { useEffect, useState } from 'react';
import { Wrench, ShieldAlert, CheckCircle2, XCircle, Loader, FileEdit, Terminal, Globe, Check, Copy, Square } from 'lucide-react';
import type { ChatItem, PendingDiff } from '../types';
import { JsonViewer } from './JsonViewer';
import { tryParseJson } from '../lib/jsonTree';
import { displayPath } from '../lib/paths';
import { copyText } from '../lib/clipboard';

// Risk level → color + icon + label
// Colours here are drawn as *text* on the card surface, so they must be the
// ink tokens, not the accent ones: --warn as text is 2.82:1 on the app surface
// and 2.44-2.47:1 on the badge's own warm tint.
/** Three colours per risk, because they are read at different weights. `ink` is
 *  the badge text at 12px and has to clear 4.5:1 against the card, which the
 *  solid `--warn` does not — it is an accent. `edge` draws the badge border,
 *  which is UI graphics and answers to 3:1 instead; for the other three risks
 *  the accent already clears that, only the light orange does not (2.44-2.47 on
 *  the card tint) and gets a darkened twin. `accent` is what the card's gradient
 *  keys off, where the ink's brown would just look like a dirty edge. */
const RISK_META: Record<string, { ink: string; edge: string; accent: string; Icon: React.ElementType; label: string }> = {
  write:   { ink: 'var(--warn-ink)',   edge: 'var(--warn-edge)', accent: 'var(--warn)',     Icon: FileEdit,  label: '写文件' },
  shell:   { ink: 'var(--danger-ink)', edge: 'var(--danger)',    accent: 'var(--danger)',   Icon: Terminal,  label: '命令执行' },
  network: { ink: 'var(--blue-ink)',   edge: 'var(--blue)',      accent: 'var(--blue)',     Icon: Globe,     label: '网络请求' },
  read:    { ink: 'var(--fg-muted)',   edge: 'var(--fg-muted)',  accent: 'var(--fg-muted)', Icon: Wrench,    label: '读取' },
};

/** "." is the workspace root. Rendered after the 路径 label it reads as a
 *  punctuation glitch rather than a location, so name it. */
// Format tool input for display — show the most relevant field(s)
function formatInput(tool: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;

  // write_file / create_file
  if (typeof obj.content === 'string') {
    const path = typeof obj.path === 'string' ? displayPath(obj.path) : '';
    const preview = obj.content.slice(0, 400) + (obj.content.length > 400 ? '\n…（已截断）' : '');
    return path ? `文件路径: ${path}\n\n${preview}` : preview;
  }
  // apply_patch / patch
  if (typeof obj.patch === 'string') {
    const preview = obj.patch.slice(0, 400) + (obj.patch.length > 400 ? '\n…（已截断）' : '');
    return `补丁内容:\n${preview}`;
  }
  // shell command
  if (typeof obj.command === 'string') return `$ ${obj.command}`;
  // web search / fetch
  if (typeof obj.url === 'string') return `URL: ${obj.url}`;
  if (typeof obj.query === 'string') return `搜索: ${obj.query}`;
  // path-based tools
  if (typeof obj.path === 'string') return `路径: ${displayPath(obj.path)}`;
  // fallback: compact JSON, max 200 chars
  const json = JSON.stringify(obj, null, 2);
  return json.length > 200 ? json.slice(0, 200) + '\n…' : json;
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  // A file ending in "\n" splits into [..., ""] — drop that phantom line so
  // the diff never renders a bare "+" row.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function ApprovalDiffPreview({ diff }: { diff: PendingDiff }) {
  const before = splitLines(diff.originalContent);
  const after = splitLines(diff.modifiedContent);
  const rows: Array<{ prefix: string; text: string; kind: 'removed' | 'added' | 'context' }> = [];
  const max = Math.max(before.length, after.length);
  for (let index = 0; index < max && rows.length < 14; index += 1) {
    const oldLine = before[index];
    const newLine = after[index];
    if (oldLine === newLine) {
      rows.push({ prefix: '  ', text: oldLine ?? '', kind: 'context' });
    } else {
      // Skip empty changed lines — they'd render as a bare "+"/"−" marker.
      if (oldLine !== undefined && oldLine !== '') rows.push({ prefix: '- ', text: oldLine, kind: 'removed' });
      if (newLine !== undefined && newLine !== '' && rows.length < 14) rows.push({ prefix: '+ ', text: newLine, kind: 'added' });
    }
  }
  return (
    <div className="approval-diff-preview" aria-label={`文件变更预览 ${diff.path}`}>
      <div className="approval-diff-title">变更预览 · {diff.path}</div>
      <pre>{rows.map((row, index) => <span key={`${index}-${row.prefix}`} className={`approval-diff-line ${row.kind}`}>{row.prefix}{row.text}{'\n'}</span>)}</pre>
    </div>
  );
}

export function ToolCard({ item, onApprove }: {
  item: Extract<ChatItem, { kind: 'tool' | 'approval' }>;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
}) {
  const isPendingApproval = item.kind === 'approval' && !item.decided;
  const pendingRequestId = item.kind === 'approval' ? item.requestId : '';
  // Iteration 11: structured-vs-raw toggle state for tool output. Declared
  // before any conditional return so hook order stays stable across renders.
  const [rawMode, setRawMode] = useState(false);
  const [copied, setCopied] = useState(false);

  // approval_overlay.rs single-key shortcuts: y = approve, a = allow session,
  // n/esc = deny. Only while this card is the live pending approval.
  useEffect(() => {
    if (!isPendingApproval) return;
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('[aria-modal="true"]')) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      if (key === 'y') { event.preventDefault(); onApprove(pendingRequestId, 'allow_once'); }
      else if (key === 'a') { event.preventDefault(); onApprove(pendingRequestId, 'allow_session'); }
      else if (key === 'n' || key === 'escape') { event.preventDefault(); onApprove(pendingRequestId, 'deny'); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPendingApproval, pendingRequestId, onApprove]);

  if (item.kind === 'approval') {
    const decided = item.decided;
    const risk = item.risk ?? 'write';
    const meta = RISK_META[risk] ?? RISK_META.write;
    const RiskIcon = meta.Icon;

    const outcomeLabel = decided === 'allow_once'    ? '已允许一次'
                       : decided === 'allow_session' ? '本次会话已允许'
                       : decided === 'deny'          ? '已拒绝'
                       : null;

    const inputPreview = formatInput(item.tool, item.input);
    const headline = risk === 'shell' || risk === 'network'
      ? '要执行下面这条命令吗？'
      : '要对下面这些文件做修改吗？';

    return (
      <section className={`tool-card approval-card ${decided ? 'decided' : ''}`}
        style={{ '--approval-risk-color': meta.accent } as React.CSSProperties}>
        <div className="approval-header">
          <span className="approval-risk-badge" style={{ color: meta.ink, borderColor: meta.edge }}>
            <RiskIcon size={12} />
            {meta.label}
          </span>
          <span className="approval-tool-name">
            <ShieldAlert size={13} />
            {item.tool}
          </span>
        </div>

        <div className="approval-headline">{headline}</div>

        {inputPreview && (
          <pre className="approval-input-preview">{inputPreview}</pre>
        )}

        {item.diff && (
          <ApprovalDiffPreview diff={item.diff} />
        )}

        {decided ? (
          <div className={`approval-outcome ${decided === 'deny' ? 'denied' : 'allowed'}`}>
            {decided === 'deny' ? <XCircle size={13} /> : <CheckCircle2 size={13} />}
            {outcomeLabel}
            {item.autoReason && <span className="approval-auto-reason">· {item.autoReason}</span>}
          </div>
        ) : (
          <div className="approval-actions">
            <button className="approval-btn allow-once"
              title="快捷键 y"
              onClick={() => onApprove(item.requestId, 'allow_once')}>
              允许一次 <kbd>y</kbd>
            </button>
            <button className="approval-btn allow-session"
              title="快捷键 a"
              onClick={() => onApprove(item.requestId, 'allow_session')}>
              本次会话都允许 <kbd>a</kbd>
            </button>
            <button className="approval-btn deny"
              title="快捷键 n / Esc — 拒绝后可直接输入新的指示"
              onClick={() => onApprove(item.requestId, 'deny')}>
              拒绝并说明要怎么改 <kbd>n</kbd>
            </button>
          </div>
        )}
      </section>
    );
  }

  const icon = item.cancelled ? <Square size={15} /> : item.status === 'running'
    ? <Loader size={15} className="tool-spin" />
    : item.status === 'failed'
      ? <XCircle size={15} />
      : <CheckCircle2 size={15} />;

  const inputText = formatInput(item.tool, item.input)
    ?? (item.input !== undefined ? JSON.stringify(item.input) : null);
  const outputText = item.output && item.output.length > 4000
    ? item.output.slice(0, 4000) + '\n…（已截断）'
    : item.output;

  // Iteration 11: structured tool output (CLI returns JSON envelopes) gets
  // the collapsible tree; raw text keeps the plain <pre>.
  const outputIsJson = Boolean(outputText) && tryParseJson(outputText!).ok;
  const showRaw = rawMode || !outputIsJson;

  return (
    <section className={`tool-card tool-detail ${item.cancelled ? 'cancelled' : item.status}`}>
      <div className="tool-title">
        {icon} {item.tool}
        {outputIsJson && (
          <button
            type="button"
            className="tool-view-toggle"
            title={rawMode ? '切换为结构化视图' : '切换为原始文本'}
            onClick={() => setRawMode((v) => !v)}
          >{rawMode ? '树视图' : '原文'}</button>
        )}
        {outputText && (
          // The tree view has its own copy button; a plain-text result had
          // none, so copying a command's output meant selecting inside a
          // scrolling <pre>. Copy the full output, not the truncated preview.
          <button
            type="button"
            className="tool-copy"
            title={copied ? '已复制' : '复制输出'}
            aria-label={copied ? '已复制' : '复制输出'}
            onClick={() => {
              void copyText(item.output ?? '').then((ok) => {
                if (!ok) return;
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              });
            }}
          >{copied ? <Check size={12} /> : <Copy size={12} />}</button>
        )}
      </div>
      {inputText && <pre>{inputText}</pre>}
      {item.screenshot && (
        <img className="tool-screenshot" src={item.screenshot} alt={`${item.tool} 截图`} />
      )}
      {outputText && (showRaw
        ? <pre>{outputText}</pre>
        : <JsonViewer text={outputText!} height={280} />)}
    </section>
  );
}
