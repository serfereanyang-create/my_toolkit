import { Wrench, ShieldAlert, CheckCircle2, XCircle, Loader, FileEdit, Terminal, Globe, Lock } from 'lucide-react';
import type { ChatItem, PendingDiff } from '../types';

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

function ApprovalDiffPreview({ diff }: { diff: PendingDiff }) {
  const before = diff.originalContent.split(/\r?\n/);
  const after = diff.modifiedContent.split(/\r?\n/);
  const rows: Array<{ prefix: string; text: string; kind: 'removed' | 'added' | 'context' }> = [];
  const max = Math.max(before.length, after.length);
  for (let index = 0; index < max && rows.length < 14; index += 1) {
    const oldLine = before[index];
    const newLine = after[index];
    if (oldLine === newLine) {
      rows.push({ prefix: '  ', text: oldLine ?? '', kind: 'context' });
    } else {
      if (oldLine !== undefined) rows.push({ prefix: '- ', text: oldLine, kind: 'removed' });
      if (newLine !== undefined && rows.length < 14) rows.push({ prefix: '+ ', text: newLine, kind: 'added' });
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
          </div>
        ) : (
          <div className="approval-actions">
            <button className="approval-btn allow-once"
              onClick={() => onApprove(item.requestId, 'allow_once')}>
              允许一次
            </button>
            <button className="approval-btn allow-session"
              onClick={() => onApprove(item.requestId, 'allow_session')}>
              本次会话允许
            </button>
            <button className="approval-btn deny"
              onClick={() => onApprove(item.requestId, 'deny')}>
              拒绝
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

  return (
    <section className={`tool-card ${item.status}`}>
      <div className="tool-title">{icon} {item.tool}</div>
      {item.input !== undefined && <pre>{JSON.stringify(item.input, null, 2)}</pre>}
      {item.output && <pre>{item.output}</pre>}
    </section>
  );
}
