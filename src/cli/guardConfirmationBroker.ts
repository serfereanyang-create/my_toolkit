import type { GuardConfirmationChannel, GuardConfirmationRequest, GuardConfirmationResult } from '../guard/types.js';

/** Popup timeout keeps the old text fallback; explicit cancellation never does. */
export type GuardConfirmationBrokerOptions = {
  sessionId?: string;
  emit: (event: Record<string, unknown>) => void;
  timeoutMs?: number;
};

type Pending = {
  labels: Set<string>;
  resolve: (result: GuardConfirmationResult | null) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  deadline: number | undefined;
};

export type GuardConfirmationBroker = GuardConfirmationChannel & {
  resolveFromDesktop: (requestId: string, selectedLabel: string) => boolean;
  lastRequestId: () => string | null;
  denyAll: (reason?: string) => void;
  cancelAll: (reason?: string) => void;
  resume: () => void;
  close: (reason?: string) => void;
  readonly pendingCount: number;
};

/**
 * Desktop popup transport for the lazy-dev guard. Cancelling/closing returns a
 * non-affirmative label instead of null: null would fall back to parsing the
 * user message, which may itself contain an affirmative answer after cancel.
 */
export function createGuardConfirmationBroker(options: GuardConfirmationBrokerOptions): GuardConfirmationBroker {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pending = new Map<string, Pending>();
  let counter = 0;
  let lastId: string | null = null;
  let cancelled = false;
  let closed = false;
  const denied: GuardConfirmationResult = { selectedLabel: '取消', source: 'auto' };

  function settle(requestId: string, result: GuardConfirmationResult | null): boolean {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(result);
    options.emit({ type: 'guard_confirmation_resolved', sessionId: options.sessionId, requestId });
    return true;
  }

  function timeout(requestId: string) {
    if (!settle(requestId, null)) return;
    options.emit({ type: 'info', sessionId: options.sessionId, message: '守门确认超时，已回落到终端菜单。' });
  }

  function cancelAll(reason = '守门确认已取消') {
    cancelled = true;
    const requestIds = [...pending.keys()];
    for (const requestId of requestIds) settle(requestId, { ...denied });
    if (requestIds.length > 0) {
      options.emit({ type: 'info', sessionId: options.sessionId, message: `${reason}：${requestIds.length} 个待守门确认请求已按取消处理` });
    }
  }

  return {
    async confirm(request: GuardConfirmationRequest): Promise<GuardConfirmationResult | null> {
      if (cancelled) return { ...denied };
      counter += 1;
      const requestId = `guard-${counter}-${Date.now().toString(36)}`;
      lastId = requestId;
      return new Promise<GuardConfirmationResult | null>((resolve, reject) => {
        const timer = timeoutMs > 0 ? setTimeout(() => timeout(requestId), timeoutMs) : undefined;
        pending.set(requestId, {
          resolve,
          timer,
          deadline: timeoutMs > 0 ? Date.now() + timeoutMs : undefined,
          labels: new Set(request.options.map((option) => option.label)),
        });
        try {
          options.emit({
            type: 'guard_confirmation_needed',
            sessionId: options.sessionId,
            requestId,
            title: request.title,
            question: request.question,
            options: request.options,
          });
        } catch (error) {
          pending.delete(requestId);
          if (timer) clearTimeout(timer);
          reject(error);
        }
      });
    },

    resolveFromDesktop(requestId: string, selectedLabel: string): boolean {
      const entry = pending.get(requestId);
      if (!entry) return false;
      if (entry.deadline !== undefined && Date.now() >= entry.deadline) {
        timeout(requestId);
        return false;
      }
      if (!entry.labels.has(selectedLabel)) return false;
      return settle(requestId, { selectedLabel, source: 'popup' });
    },

    lastRequestId: () => lastId,
    denyAll: cancelAll,
    cancelAll,
    resume() { if (!closed) cancelled = false; },
    close(reason) { closed = true; cancelAll(reason); },
    get pendingCount() { return pending.size; },
  };
}
