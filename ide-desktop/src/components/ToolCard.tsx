import { useEffect, useState } from 'react';
import { Wrench, ShieldAlert, CheckCircle2, XCircle, Loader, FileEdit, Terminal, Globe, Lock } from 'lucide-react';
import type { ChatItem, PendingDiff } from '../types';
import { JsonViewer } from './JsonViewer';
import { tryParseJson } from '../lib/jsonTree';

// Risk level → color + icon + label
const RISK_META: Record<string, { color: string; Icon: React.ElementType; label: string }> = {
  write:   { color: '#f59e0b', Icon: FileEdit,  label: '写文件' },
  shell:   { color: '#ef4444', Icon: Terminal,  label: '命令执行' },
  network: { color: '#3b82f6', Icon: Globe,     label: '网络请求' },
  read:    { color: '#6b7280', Icon: Wrench,    label: '读取' },
};

// Format tool input for display — show the most relevant field(s)
function formatInput(tool: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;

  // write_file / create_file
  if (typeof obj.content === 'string') {
    const path = typeof obj.path === 'string' ? obj.path : '';
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
  if (typeof obj.path === 'string') return `路径: ${obj.path}`;
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

  // approval_overlay.rs single-key shortcuts: y = approve, a = allow session,
  // n/esc = deny. Only while this card is the live pending approval.
  useEffect(() => {
    if (!isPendingApproval) return;
    function onKey(event: KeyboardEvent) {
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
    // approval_overlay.rs headlines per request kind.
    const headline = risk === 'shell' || risk === 'network'
      ? 'Would you like to run the following command?'
      : 'Would you like to make the following edits?';

    return (
      <section className={`tool-card approval-card ${decided ? 'decided' : ''}`}
        style={{ '--approval-risk-color': meta.color } as React.CSSProperties}>
        <div className="approval-header">
          <span className="approval-risk-badge" style={{ color: meta.color, borderColor: meta.color }}>
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
              Yes, proceed <kbd>y</kbd>
            </button>
            <button className="approval-btn allow-session"
              title="快捷键 a"
              onClick={() => onApprove(item.requestId, 'allow_session')}>
              Yes, and don't ask again this session <kbd>a</kbd>
            </button>
            <button className="approval-btn deny"
              title="快捷键 n / Esc — 拒绝后可直接输入新的指示"
              onClick={() => onApprove(item.requestId, 'deny')}>
              No, and tell Codex what to do differently <kbd>n</kbd>
            </button>
          </div>
        )}
      </section>
    );
  }

  const icon = item.status === 'running'
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
    <section className={`tool-card tool-detail ${item.status}`}>
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
