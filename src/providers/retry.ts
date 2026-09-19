/**
 * Model request retry, ported from openai/codex (codex-rs/codex-client/src/retry.rs
 * + model-provider-info defaults, Apache-2.0):
 * - default 4 attempts, 200ms base delay, exponential backoff with ±10% jitter
 * - retry only transport-class failures: HTTP 5xx, network errors, timeouts
 * - 429 and other 4xx are NOT retried at the transport layer (upstream
 *   `retry_429 = false`; rate limits surface to the turn instead)
 * - user cancellation (AbortError) is never retried
 *
 * The upstream turn-level stream retry (5 more attempts, no delay cap) lives
 * in the sampling loop; our providers expose one `complete()` entry point, so
 * both layers collapse into this single wrapper here.
 */

export const DEFAULT_REQUEST_RETRIES = 4;
export const REQUEST_RETRY_BASE_DELAY_MS = 200;
const MAX_REQUEST_RETRIES = 100; // model-provider-info/lib.rs upper bound

/** Classification error: wrap provider failures so retry policy is explicit. */
export class ModelRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ModelRequestError';
  }
}

/** Environment knob, mirroring upstream request_max_retries() config. */
export function resolveRequestRetries(): number {
  const raw = process.env.AICODE_REQUEST_RETRIES;
  if (!raw) return DEFAULT_REQUEST_RETRIES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_REQUEST_RETRIES;
  return Math.min(parsed, MAX_REQUEST_RETRIES);
}

const NETWORK_PATTERNS = [
  'econnreset',
  'econnrefused',
  'etimedout',
  'epipe',
  'eai_again',
  'enotfound',
  'socket hang up',
  'fetch failed',
  'network',
  'premature close',
  'aborted', // undici timeout wraps as AbortError with this message — still a transport fault
];

/**
 * Transport-class failures only (upstream retry.rs retry_5xx/retry_transport).
 * User cancellation (AbortError without a transport cause) is never retryable:
 * the REPL turn-cancel flow relies on it propagating immediately.
 */
export function isRetryableModelError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: string }).name ?? '';
  const message = String((error as { message?: string }).message ?? error ?? '').toLowerCase();
  // Explicit classification wins (ModelRequestError carries the verdict).
  const explicitRetryable = (error as { retryable?: boolean }).retryable;
  const status = (error as { status?: number; statusCode?: number }).status
    ?? (error as { statusCode?: number }).statusCode;
  // Genuine cancellation: AbortError raised by our turn-cancel, not a network abort.
  if (name === 'CancelledError' || name === 'AgentCancelledError') return false;
  if (name === 'AbortError' && !NETWORK_PATTERNS.some((pattern) => message.includes(pattern))) return false;
  if (typeof explicitRetryable === 'boolean') return explicitRetryable;
  if (typeof status === 'number') {
    return status >= 500 && status <= 599; // retry_5xx = true; retry_429 = false
  }
  return NETWORK_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * codex-client/src/retry.rs backoff: attempt 0 → base; then base * 2^(n-1)
 * with uniform ±10% jitter. Math.random is fine here: backoff jitter is a
 * latency-smoothing measure, not a security-sensitive random source.
 */
export function backoffDelayMs(attempt: number, baseMs = REQUEST_RETRY_BASE_DELAY_MS): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = baseMs * 2 ** exponent;
  const jitter = 0.9 + Math.random() * 0.2;
  return Math.round(raw * jitter);
}

export type ModelRetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  /** UI hook — upstream emits StreamError("Reconnecting... n/max") per retry. */
  onRetry?: (attempt: number, maxRetries: number, delayMs: number, error: unknown) => void;
};

export async function withModelRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: ModelRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? resolveRequestRetries();
  const baseDelayMs = options.baseDelayMs ?? REQUEST_RETRY_BASE_DELAY_MS;
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!isRetryableModelError(error) || attempt >= maxRetries) throw error;
      const delayMs = backoffDelayMs(attempt + 1, baseDelayMs);
      options.onRetry?.(attempt + 1, maxRetries, delayMs, error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }
}
