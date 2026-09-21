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

export function ToastLayer({ onFocusChat }: { onFocusChat: () => void }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seqRef = useRef(0);

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
          ? { kind: 'error', title: '本轮执行失败', body: reason ? reason.slice(0, 200) : 'CLI 没有返回失败原因' }
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
      const id = ++seqRef.current;
      setToasts((prev) => [...prev.slice(-4), { ...toast, id }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, TOAST_MS[toast.kind]);
    });
    return off;
  }, []);

  const dismiss = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  if (toasts.length === 0) return null;

  return (
    <div className="toast-layer" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const view = KIND_VIEW[toast.kind];
        const Icon = view.icon;
        return (
          <div key={toast.id} className={`toast toast-${toast.kind}`}>
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
            {toast.kind === 'approval' && (
              <span className="toast-pulse" aria-hidden="true" />
            )}
          </div>
        );
      })}
    </div>
  );
}
