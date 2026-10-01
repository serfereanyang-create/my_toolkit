import type { GuardConfirmationChannel, GuardConfirmationRequest, GuardConfirmationResult } from '../guard/types.js';

/**
 * Desktop popup transport for the lazy-dev guard.
 *
 * Mirrors DesktopApprovalBroker: emits a `guard_confirmation_needed` event and
 * resolves when the renderer sends `guard_confirmation_response` back. A
 * timeout resolves null, which makes the guard fall back to its numbered
 * terminal menu instead of hanging the turn.
 */
export type GuardConfirmationBrokerOptions = {
  /** Session the guard belongs to; echoed on every event for the renderer. */
  sessionId?: string;
  emit: (event: Record<string, unknown>) => void;
  /** Unanswered popups fall back to the terminal after this long. */
  timeoutMs?: number;
};

type Pending = {
  resolve: (result: GuardConfirmationResult | null) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export function createGuardConfirmationBroker(options: GuardConfirmationBrokerOptions): GuardConfirmationChannel & {
  resolveFromDesktop: (requestId: string, selectedLabel: string) => boolean;
  lastRequestId: () => string | null;
} {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pending = new Map<string, Pending>();
  let counter = 0;
  let lastId: string | null = null;

  return {
    async confirm(request: GuardConfirmationRequest): Promise<GuardConfirmationResult | null> {
      counter += 1;
      const requestId = `guard-${counter}-${Date.now().toString(36)}`;
      lastId = requestId;
      const answer = await new Promise<GuardConfirmationResult | null>((resolve) => {
        const timer = timeoutMs > 0
          ? setTimeout(() => {
            if (!pending.has(requestId)) return;
            pending.delete(requestId);
            options.emit({ type: 'info', message: '守门确认超时，已回落到终端菜单。' });
            resolve(null);
          }, timeoutMs)
          : undefined;
        pending.set(requestId, { resolve, timer });
        options.emit({
          type: 'guard_confirmation_needed',
          sessionId: options.sessionId,
          requestId,
          title: request.title,
          question: request.question,
          options: request.options,
        });
      });
      // A null answer means "nobody answered in the popup" — the caller then
      // falls back to its own terminal menu instead of silently picking an
      // option on the user's behalf.
      return answer;
    },

    resolveFromDesktop(requestId: string, selectedLabel: string): boolean {
      const entry = pending.get(requestId);
      if (!entry) return false;
      pending.delete(requestId);
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve({ selectedLabel, source: 'popup' });
      return true;
    },

    lastRequestId(): string | null {
      return lastId;
    },
  };
}
