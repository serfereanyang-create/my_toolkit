import { useMemo, useRef } from 'react';
import { ShieldAlert, Terminal, Pencil, Globe, XCircle, CheckCircle2 } from 'lucide-react';
import type { ChatItem } from '../types';
import { useModalFocus } from '../lib/useModalFocus';
import { ModalPortal } from './ModalPortal';

/*
 * ApprovalModal — Codex-style blocking confirmation dialog.
 *
 * When the agent needs a human decision (and the sandbox didn't answer it),
 * the conversation dims behind a centered modal that restates the request and
 * offers the same three actions as the inline card. One approval at a time:
 * the oldest pending.
 *
 * The inline card stays in the stream as the audit trail; the modal is purely
 * an attention + decision surface, so it unmounts the moment the card gets
 * decided (user click, keyboard chord, or sandbox auto-answer).
 */

const RISK_META: Record<string, { Icon: typeof Terminal; label: string }> = {
  read: { Icon: ShieldAlert, label: '只读' },
  write: { Icon: Pencil, label: '写入' },
  shell: { Icon: Terminal, label: '命令' },
  network: { Icon: Globe, label: '网络' },
};

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'path', 'file', 'url', 'query']) {
    if (typeof obj[key] === 'string' && obj[key]) return String(obj[key]);
  }
  const json = JSON.stringify(obj);
  return json.length > 220 ? `${json.slice(0, 220)}…` : json;
}

export function ApprovalModal({
  item, onApprove,
}: {
  item: Extract<ChatItem, { kind: 'approval' }> | null;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
}) {
  const meta = useMemo(() => {
    if (!item) return null;
    return RISK_META[item.risk ?? 'write'] ?? RISK_META.write;
  }, [item]);
  const allowOnceRef = useRef<HTMLButtonElement | null>(null);
  const decide = (decision: 'allow_once' | 'allow_session' | 'deny') => { if (item) onApprove(item.requestId, decision); };
  const dialogRef = useModalFocus(Boolean(item), allowOnceRef, {
    identity: item?.requestId,
    onEscape: () => decide('deny'),
    shortcuts: { y: () => decide('allow_once'), a: () => decide('allow_session'), n: () => decide('deny') },
  });

  if (!item || !meta) return null;
  const Icon = meta.Icon;
  const preview = summarizeInput(item.input);
  const isShell = (item.risk ?? 'write') === 'shell' || (item.risk ?? 'write') === 'network';

  return (
    <ModalPortal>
    <div className="approval-modal-backdrop">
      <section className="approval-modal" ref={dialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby={`approval-title-${item.requestId}`} aria-describedby={`approval-message-${item.requestId}`} onKeyDown={(event) => event.stopPropagation()}>
        <div className="approval-modal-head">
          <span className="approval-modal-risk"><Icon size={15} />{meta.label}</span>
          <span className="approval-modal-tool"><ShieldAlert size={14} />{item.tool}</span>
        </div>
        <div id={`approval-title-${item.requestId}`} className="approval-modal-title">
          {item.tool.startsWith('background_browser_') ? '允许在后台网页中执行此操作吗？' : isShell ? '要执行以下命令吗？' : '要进行以下修改吗？'}
        </div>
        <div id={`approval-message-${item.requestId}`} className="approval-modal-message">{item.message}</div>
        {preview && <pre className="approval-modal-preview">{preview}</pre>}
        {item.diff && (
          <div className="approval-modal-diff">
            <span className="approval-modal-diff-path">{item.diff.path}</span>
          </div>
        )}
        <div className="approval-modal-actions">
          <button type="button" ref={allowOnceRef} className="approval-btn allow-once primary"
            onClick={() => onApprove(item.requestId, 'allow_once')}
            title="Enter 或 y">
            <CheckCircle2 size={14} /> 允许一次
          </button>
          <button type="button" className="approval-btn allow-session"
            onClick={() => onApprove(item.requestId, 'allow_session')}
            title="快捷键 a">
            本会话不再询问
          </button>
          <button type="button" className="approval-btn deny"
            onClick={() => onApprove(item.requestId, 'deny')}
            title="快捷键 n / Esc">
            <XCircle size={14} /> 拒绝
          </button>
        </div>
        <div className="approval-modal-hint">y 允许一次 · a 会话允许 · n / Esc 拒绝 · Enter 执行聚焦按钮</div>
      </section>
    </div>
    </ModalPortal>
  );
}
