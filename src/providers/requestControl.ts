import type { Provider, ProviderRequest } from './types.js';
import { abortable, throwIfAborted } from '../utils/cancellation.js';

export const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 300_000;

export class ProviderRequestTimeoutError extends Error {
  readonly retryable = false;
  constructor(milliseconds: number) {
    super(`Provider request exceeded its total deadline of ${milliseconds}ms`);
    this.name = 'ProviderRequestTimeoutError';
  }
}

export function createRequestControl(inputSignal?: AbortSignal | null, timeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('Provider request timeout must be a positive supported integer');
  const deadline = new AbortController();
  const signal = inputSignal ? AbortSignal.any([inputSignal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(new ProviderRequestTimeoutError(timeoutMs)), timeoutMs);
  return { signal, dispose: () => clearTimeout(timer), close: () => { clearTimeout(timer); deadline.abort(new DOMException('Request scope closed', 'AbortError')); } };
}

export async function withRequestControl<T>(request: ProviderRequest, work: (request: ProviderRequest) => Promise<T>): Promise<T> {
  const control = createRequestControl(request.signal, request.timeoutMs);
  let accepting = true;
  try {
    throwIfAborted(control.signal);
    const controlled: ProviderRequest = {
      ...request,
      signal: control.signal,
      onTextDelta: request.onTextDelta ? delta => { if (accepting && !control.signal.aborted) request.onTextDelta!(delta); } : undefined,
      onThinkingDelta: request.onThinkingDelta ? delta => { if (accepting && !control.signal.aborted) request.onThinkingDelta!(delta); } : undefined,
    };
    const result = await abortable(Promise.resolve().then(() => { throwIfAborted(control.signal); return work(controlled); }), control.signal);
    throwIfAborted(control.signal);
    return result;
  } finally { accepting = false; control.close(); }
}

export function controlledProvider(provider: Provider): Provider {
  return { ...provider, complete: request => withRequestControl(request, controlled => provider.complete(controlled)) };
}
