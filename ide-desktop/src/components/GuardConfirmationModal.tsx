import { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { GuardConfirmation } from '../types';
import { useModalFocus } from '../lib/useModalFocus';
import { ModalPortal } from './ModalPortal';

export function GuardConfirmationModal({ request, onChoose }: {
  request: GuardConfirmation | null;
  onChoose: (request: GuardConfirmation, label: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);
  const pendingRef = useRef(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    pendingRef.current = false;
    setBusy(false);
    setError('');
  }, [request?.requestId]);
  const dialogRef = useModalFocus(Boolean(request), firstOptionRef, { identity: request?.requestId, onEscape: () => { void choose('取消'); } });
  async function choose(label: string) {
    if (!request || pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    setError('');
    try { await onChoose(request, label); }
    catch (failure) { if (requestRef.current?.requestId === request.requestId) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally {
      if (requestRef.current?.requestId === request.requestId) {
        pendingRef.current = false;
        setBusy(false);
      }
    }
  }
  if (!request) return null;
  return (
    <ModalPortal>
    <div className="approval-modal-backdrop">
      <section className="approval-modal" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="guard-confirm-title" aria-describedby="guard-confirm-message" onKeyDown={(event) => event.stopPropagation()}>
        <div id="guard-confirm-title" className="approval-modal-head"><ShieldCheck size={18} />{request.title}</div>
        <p id="guard-confirm-message" className="approval-modal-message">{request.question}</p>
        <div className="guard-options">
          {request.options.map((option, index) => (
            <button key={option.label} ref={index === 0 ? firstOptionRef : undefined} type="button" className="settings-action-btn" disabled={busy} onClick={() => void choose(option.label)}>
              <strong>{option.label}</strong>
              {option.description && <span>{option.description}</span>}
            </button>
          ))}
        </div>
        {error && <p role="alert" className="text-error">{error}</p>}
        <button type="button" className="approval-btn deny" disabled={busy} onClick={() => void choose('取消')}>取消本次需求</button>
      </section>
    </div>
    </ModalPortal>
  );
}
