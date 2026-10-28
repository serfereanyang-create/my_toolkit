import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, BellRing, CheckCircle2, Info, WifiOff, X } from 'lucide-react';
import { desktop } from '../lib/ipc';

/*
 * In-app toast layer for key task states. Subscribes to the agent event bus
 * independently from the reducer so adding reminders needs no state-model
 * change. The OS-level counterpart (main.cjs notifyKeyState) covers the
 * background-window case; this layer covers the focused case.
 */

type ToastKind = 'approval' | 'success' | 'error' | 'offline' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  retryable?: boolean;
}

const TOAST_MS: Record<ToastKind, number> = {
  approval: 15000, // waiting for a human decision — stays noticeably longer
  success: 5000,
  error: 8000,
  offline: 6000,
  info: 5000,
};

const KIND_VIEW: Record<ToastKind, { icon: React.ElementType; label: string }> = {
  approval: { icon: BellRing, label: '需要确认' },
  success: { icon: CheckCircle2, label: '任务完成' },
  error: { icon: AlertTriangle, label: '执行出错' },
  offline: { icon: WifiOff, label: '连接断开' },
  info: { icon: Info, label: '本轮已回复' },
};

const KINDS: ReadonlySet<string> = new Set(['approval', 'success', 'error', 'offline', 'info']);
function isToastKind(value: string): value is ToastKind {
  return KINDS.has(value);
}

/** Event name for renderer-local notices (see appNotice). */
export const NOTICE_EVENT = 'zcode:notice';

/**
 * Show an in-app notice instead of window.alert().
 *
 * `alert()` blocks the entire renderer process — the transcript stops
 * streaming, animations freeze, and the modal is a native dialog that does not
 * match the app. Anything the user can read and act on belongs in a toast.
 */
export function appNotice(title: string, body?: string, kind: ToastKind = 'error') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NOTICE_EVENT, { detail: { kind, title, body } }));
}

export function ToastLayer({ onFocusChat, onRetry }: { onFocusChat: () => void; onRetry?: () => void }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seqRef = useRef(0);
  const timersRef = useRef<Map<number, number>>(new Map());

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) window.clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  const scheduleDismiss = (id: number, kind: ToastKind) => {
    const previous = timersRef.current.get(id);
    if (previous) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      timersRef.current.delete(id);
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, TOAST_MS[kind]) as unknown as number;
    timersRef.current.set(id, timer);
  };

  const show = (toast: Omit<ToastItem, 'id'>) => {
    const id = ++seqRef.current;
    setToasts((prev) => [...prev.slice(-4), { ...toast, id }]);
    scheduleDismiss(id, toast.kind);
  };

  // Renderer-owned notices (a failed file open, a refused save) arrive here.
  // They used to call window.alert(), which blocks the whole renderer process
  // until dismissed — during a streaming turn that freezes the transcript too,
  // and the platform dialog looks nothing like the rest of the app.
  useEffect(() => {
    const onNotice = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: ToastKind; title?: string; body?: string }>).detail;
      if (!detail?.title) return;
      show({ kind: detail.kind && isToastKind(detail.kind) ? detail.kind : 'info', title: detail.title, body: detail.body });
    };
    window.addEventListener(NOTICE_EVENT, onNotice);
    return () => window.removeEventListener(NOTICE_EVENT, onNotice);
  }, []);

  useEffect(() => {
    const off = desktop.agent.onEvent((event) => {
      let toast: Omit<ToastItem, 'id'> | null = null;
      if (event.type === 'approval_needed') {
        toast = { kind: 'approval', title: '需要确认执行', body: `工具 ${String(event.tool || '')} 等待你的批准` };
      } else if (event.type === 'turn_done') {
        // turn_done carries status 'ok' | 'error'; a failed turn must not be
        // announced as 任务完成 — the toast would contradict the transcript.
        // The CLI also sends WHY the turn failed, which is the difference
        // between "something went wrong" and something the user can act on.
        const reason = typeof event.reason === 'string' ? event.reason.trim() : '';
        // `ok` means "the turn ended without an error", NOT "the work got done":
        // a model that answers a question or declines a request ends with ok and
        // no tool calls. Announcing 任务完成 there is a lie — the user asked for
        // something and nothing happened. codex's own TUI has this bug ("Worked
        // for Ns · done" regardless of activity), so this is deliberately not
        // copied.
        const didWork = event.producedActivity !== false;
        toast = event.status === 'error'
          ? { kind: 'error', title: '本轮执行失败', body: reason ? reason.slice(0, 200) : 'CLI 没有返回失败原因', retryable: true }
          : didWork
            ? { kind: 'success', title: '任务完成', body: '智能体已完成本轮工作' }
            : { kind: 'info', title: '本轮已回复', body: '未执行任何操作（只做了回复）' };
      } else if (event.type === 'error') {
        const message = String(event.message || '').trim();
        toast = { kind: 'error', title: '执行出错', body: (message || 'CLI 没有返回错误详情').slice(0, 200) };
      } else if (event.type === 'agent_offline') {
        toast = { kind: 'offline', title: '连接断开', body: '智能体已离线' };
      }
      if (!toast) return;
      show(toast);
    });
    return off;
  }, []);

  const dismiss = (id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) window.clearTimeout(timer);
    timersRef.current.delete(id);
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  if (toasts.length === 0) return null;

  return (
    <div className="toast-layer" role="status" aria-live={toasts.some((toast) => toast.kind === 'error' || toast.kind === 'approval') ? 'assertive' : 'polite'} aria-atomic="false">
      {toasts.map((toast) => {
        const view = KIND_VIEW[toast.kind];
        const Icon = view.icon;
        return (
          <div key={toast.id} className={`toast toast-${toast.kind}`} onMouseEnter={() => { const timer = timersRef.current.get(toast.id); if (timer) window.clearTimeout(timer); }} onMouseLeave={() => scheduleDismiss(toast.id, toast.kind)}>
            <button
              type="button"
              className="toast-main"
              onClick={() => { onFocusChat(); dismiss(toast.id); }}
              title="点击查看对话"
            >
              <span className={`toast-icon toast-icon-${toast.kind}`}><Icon size={16} /></span>
              <span className="toast-text">
                <span className="toast-title">{toast.title}</span>
                {toast.body && <span className="toast-body">{toast.body}</span>}
              </span>
            </button>
            <button type="button" className="toast-close" onClick={() => dismiss(toast.id)} aria-label="关闭提醒">
              <X size={13} />
            </button>
            {toast.retryable && onRetry && (
              <button type="button" className="toast-retry" onClick={() => { onRetry(); dismiss(toast.id); }}>重试</button>
            )}
            {toast.kind === 'approval' && (
              <span className="toast-pulse" aria-hidden="true" />
            )}
          </div>
        );
      })}
    </div>
  );
}
