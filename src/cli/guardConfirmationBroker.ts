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
 * Desktop popup transport for the lazy-dev guard.
 *
 * Timeout and cancellation are deliberately different verdicts:
 * - a timeout resolves `null`, which sends the guard back to its terminal menu
 *   (the user is still there, just not looking at the popup);
 * - a cancel/close resolves the non-affirmative `取消` label, because falling
 *   back to the terminal after a cancel would parse the next user message as
 *   the answer to a question the user already dismissed.
 *
 * Both must leave the broker usable. `timeout()` used to call `settle()`, which
 * emits `guard_confirmation_resolved`, and the desktop responds to that event
 * by cancelling — so one popup timeout cancelled every later guard prompt for
 * the rest of the session (the cancellation is only lifted by the next turn).
 * A timeout now settles without telling the renderer a user answered.
 *
 * Ordering inside `confirm()`: the pending entry is installed BEFORE the event
 * goes out (the host may answer synchronously), and it is removed BEFORE the
 * emit that reports the answer — a synchronous re-entrant answer from inside
 * that emit must see "no such request", never the entry it was resolving.
 */
export function createGuardConfirmationBroker(options: GuardConfirmationBrokerOptions): GuardConfirmationBroker {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pending = new Map<string, Pending>();
  let counter = 0;
  let lastId: string | null = null;
  let cancelled = false;
  let closed = false;
  const denied: GuardConfirmationResult = { selectedLabel: '取消', source: 'auto' };

  function settle(requestId: string, result: GuardConfirmationResult | null, notify: boolean): boolean {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(result);
    if (notify) options.emit({ type: 'guard_confirmation_resolved', sessionId: options.sessionId, requestId });
    return true;
  }

  function timeout(requestId: string) {
    // `notify: false` on purpose. The round trip that was here meant a timeout
    // reported a user ANSWER (`guard_confirmation_resolved`), and the desktop
    // treats that as a dismissal by cancelling — one silent popup killed every
    // later guard prompt for the session. A timeout is not an answer: resolve
    // the promise with null so the guard falls back to its terminal menu, and
    // emit only the informational line.
    if (!settle(requestId, null, false)) return;
    options.emit({ type: 'info', sessionId: options.sessionId, message: '守门确认超时，已回落到终端菜单。' });
  }

  function cancelAll(reason = '守门确认已取消') {
    cancelled = true;
    const requestIds = [...pending.keys()];
    for (const requestId of requestIds) settle(requestId, { ...denied }, true);
    if (requestIds.length > 0) {
      options.emit({ type: 'info', sessionId: options.sessionId, message: `${reason}：${requestIds.length} 个待守门确认请求已按取消处理` });
    }
  }

  return {
    async confirm(request: GuardConfirmationRequest): Promise<GuardConfirmationResult | null> {
      if (cancelled || closed) return { ...denied };
      counter += 1;
      const requestId = `guard-${counter}-${Date.now().toString(36)}`;
      return new Promise<GuardConfirmationResult | null>((resolve, reject) => {
        const timer = timeoutMs > 0 ? setTimeout(() => timeout(requestId), timeoutMs) : undefined;
        if (timer && typeof timer.unref === 'function') timer.unref();
        // Installed before the emit: a host that answers synchronously (an
        // embedding that resolves from within its own event handler) must find
        // the entry, not be told the request is unknown.
        pending.set(requestId, {
          resolve,
          timer,
          deadline: timeoutMs > 0 ? Date.now() + timeoutMs : undefined,
          labels: new Set(request.options.map((option) => option.label)),
        });
        lastId = requestId;
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
      return settle(requestId, { selectedLabel, source: 'popup' }, true);
    },

    lastRequestId: () => lastId,
    denyAll: cancelAll,
    cancelAll,
    resume() { if (!closed) cancelled = false; },
    close(reason) { closed = true; cancelAll(reason); },
    get pendingCount() { return pending.size; },
  };
}
