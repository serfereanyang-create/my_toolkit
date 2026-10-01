import type {
  GuardConfirmationChannel,
  GuardConfirmationChannelOptions,
  GuardConfirmationOption,
  GuardConfirmationRequest,
  GuardConfirmationResult,
} from './types.js';

/**
 * Confirmation channel for guard decisions.
 *
 * The design asks for "popup first, terminal menu as the fallback": when a
 * desktop transport is available the question goes out as a popup event and
 * waits up to `timeoutMs`; if nothing comes back (or there is no desktop at
 * all) the numbered terminal menu takes over, and if that is unavailable too
 * the first option wins — the design treats entry #1 as "stay guarded", which
 * is always the safe answer.
 */

/** Render the numbered terminal menu shown when no popup is available. */
export function formatTerminalOptions(request: GuardConfirmationRequest): string {
  return [
    request.title,
    request.question,
    ...request.options.map((option, index) => `${index + 1}. ${option.label}：${option.description}`),
  ].join('\n');
}

/**
 * Map a raw terminal answer onto an option label.
 *
 * Accepts the menu index ("2") or the label itself ("准确，继续"), because
 * users type both. Returns null when the answer matches nothing, so callers
 * can re-ask instead of silently picking a wrong option.
 */
export function matchTerminalAnswer(
  request: GuardConfirmationRequest,
  answer: string | null | undefined,
): string | null {
  if (answer === null || answer === undefined) return null;
  const trimmed = answer.trim();
  if (!trimmed) return null;
  const index = Number.parseInt(trimmed, 10);
  if (Number.isInteger(index) && index >= 1 && index <= request.options.length) {
    return request.options[index - 1].label;
  }
  const byLabel = request.options.find((option) => option.label === trimmed);
  return byLabel ? byLabel.label : null;
}

export function createGuardConfirmationChannel(
  options: GuardConfirmationChannelOptions,
): GuardConfirmationChannel {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    async confirm(request: GuardConfirmationRequest): Promise<GuardConfirmationResult> {
      if (options.popup) {
        try {
          const popup = await Promise.race([
            options.popup(request),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
          ]);
          if (popup) return popup;
        } catch {
          // A broken popup transport must never block the terminal fallback.
        }
      }
      if (options.terminal) {
        const answer = await options.terminal(formatTerminalOptions(request));
        const label = matchTerminalAnswer(request, answer);
        if (label) return { selectedLabel: label, source: 'terminal' };
      }
      // Last resort: the first option is the safe default (the design treats
      // the first entry as "keep going with the guard").
      const fallback = request.options[0]?.label ?? '取消';
      return { selectedLabel: fallback, source: 'terminal' };
    },
  };
}

/**
 * Terminal-only fallback used by the plain REPL: prints the numbered menu and
 * resolves the picked label. Kept separate from the channel so tests can drive
 * it with a scripted answer function.
 */
export function createTerminalConfirmationFallback(
  reader: (text: string) => Promise<string | null>,
): (request: GuardConfirmationRequest) => Promise<GuardConfirmationResult> {
  return async (request: GuardConfirmationRequest) => {
    const answer = await reader(formatTerminalOptions(request));
    const label = matchTerminalAnswer(request, answer);
    return {
      selectedLabel: label ?? request.options[0]?.label ?? '取消',
      source: 'terminal' as const,
    };
  };
}

export type { GuardConfirmationChannel, GuardConfirmationOption, GuardConfirmationRequest, GuardConfirmationResult };
