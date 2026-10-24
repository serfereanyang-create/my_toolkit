import { useId, useRef, type ReactNode } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useModalFocus } from '../lib/useModalFocus';
import { ModalPortal } from './ModalPortal';

export function ConfirmDialog({ open, title, message, confirmLabel = '确认', cancelLabel = '取消', danger = false, busy = false, secondaryAction, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  secondaryAction?: { label: string; onClick: () => void };
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const dialogId = useId();
  const dialogRef = useModalFocus(open, danger ? cancelRef : confirmRef, { onEscape: () => { if (!busy) onCancel(); } });

  if (!open) return null;
  return (
    <ModalPortal>
    <div className="confirm-dialog-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onCancel(); }}>
      <section className="confirm-dialog" ref={dialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-busy={busy || undefined} aria-labelledby={`${dialogId}-title`} aria-describedby={`${dialogId}-message`} onKeyDown={(event) => event.stopPropagation()}>
        <div className="confirm-dialog-head">
          <span className={`confirm-dialog-icon${danger ? ' danger' : ''}`}><AlertTriangle size={17} /></span>
          <h2 id={`${dialogId}-title`}>{title}</h2>
          <button type="button" disabled={busy} className="icon-button" aria-label="关闭" onClick={onCancel}><X size={15} /></button>
        </div>
        <p id={`${dialogId}-message`}>{message}</p>
        <div className="confirm-dialog-actions">
          <button type="button" disabled={busy} ref={cancelRef} className="confirm-dialog-cancel" onClick={onCancel}>{cancelLabel}</button>
          {secondaryAction && <button type="button" disabled={busy} className="confirm-dialog-cancel" onClick={secondaryAction.onClick}>{secondaryAction.label}</button>}
          <button type="button" disabled={busy} ref={confirmRef} className={`confirm-dialog-confirm${danger ? ' danger' : ''}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
    </ModalPortal>
  );
}
