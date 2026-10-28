import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffDelayMs,
  isRetryableModelError,
  resolveRequestRetries,
  withModelRetry,
  ModelRequestError,
} from '../src/providers/retry.js';

test('backoffDelayMs follows base * 2^(n-1) with ±10% jitter', () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const delay = backoffDelayMs(attempt, 200);
    const expected = 200 * 2 ** Math.max(0, attempt - 1);
    assert.ok(delay >= expected * 0.9 && delay <= expected * 1.1, `attempt ${attempt}: ${delay} vs ${expected}`);
  }
  // Upstream shape: 200 → 400 → 800 → 1600.
  const first = backoffDelayMs(1, 200);
  assert.ok(first >= 180 && first <= 220);
});

test('isRetryableModelError classifies transport faults only', () => {
  assert.equal(isRetryableModelError(new ModelRequestError('boom', true)), true);
  assert.equal(isRetryableModelError(new ModelRequestError('boom', false)), false);
  assert.equal(isRetryableModelError(Object.assign(new Error('Internal Server Error'), { status: 500 })), true);
  assert.equal(isRetryableModelError(Object.assign(new Error('Bad Gateway'), { status: 502 })), true);
  // retry_429 = false at the transport layer (upstream default).
  assert.equal(isRetryableModelError(Object.assign(new Error('Too Many Requests'), { status: 429 })), false);
  assert.equal(isRetryableModelError(Object.assign(new Error('Bad Request'), { status: 400 })), false);
  assert.equal(isRetryableModelError(new Error('ECONNRESET')), true);
  assert.equal(isRetryableModelError(new Error('socket hang up')), true);
  assert.equal(isRetryableModelError(new Error('fetch failed')), true);
  // User cancellation never retries.
  assert.equal(isRetryableModelError(Object.assign(new Error('readline was closed'), { name: 'AbortError' })), false);
  assert.equal(isRetryableModelError(Object.assign(new Error('cancelled by user'), { name: 'AgentCancelledError' })), false);
});

test('withModelRetry retries retryable failures and succeeds', async () => {
  let calls = 0;
  const result = await withModelRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNRESET');
      return 'ok';
    },
    { baseDelayMs: 1 },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withModelRetry exhausts retries then throws (default cap from env or 4)', async () => {
  const previous = process.env.AICODE_REQUEST_RETRIES;
  process.env.AICODE_REQUEST_RETRIES = '2';
  try {
    let calls = 0;
    await assert.rejects(
      withModelRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error('Gateway Timeout'), { status: 504 });
        },
        { baseDelayMs: 1 },
      ),
    );
    assert.equal(calls, 3, 'initial attempt + 2 retries');
  } finally {
    if (previous === undefined) delete process.env.AICODE_REQUEST_RETRIES;
    else process.env.AICODE_REQUEST_RETRIES = previous;
  }
});

test('withModelRetry never retries non-retryable failures', async () => {
  let calls = 0;
  await assert.rejects(
    withModelRetry(
      async () => {
        calls += 1;
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      },
      { baseDelayMs: 1 },
    ),
  );
  assert.equal(calls, 1);
});

test('resolveRequestRetries reads AICODE_REQUEST_RETRIES with bounds', () => {
  const previous = process.env.AICODE_REQUEST_RETRIES;
  try {
    delete process.env.AICODE_REQUEST_RETRIES;
    assert.equal(resolveRequestRetries(), 4);
    process.env.AICODE_REQUEST_RETRIES = '7';
    assert.equal(resolveRequestRetries(), 7);
    process.env.AICODE_REQUEST_RETRIES = 'bogus';
    assert.equal(resolveRequestRetries(), 4);
    process.env.AICODE_REQUEST_RETRIES = '9999';
    assert.equal(resolveRequestRetries(), 100, 'upstream hard cap');
  } finally {
    if (previous === undefined) delete process.env.AICODE_REQUEST_RETRIES;
    else process.env.AICODE_REQUEST_RETRIES = previous;
  }
});

test('withModelRetry stops before replaying a request after streamed output', async () => {
  let calls = 0;
  let streamed = false;
  await assert.rejects(
    withModelRetry(
      async () => {
        calls += 1;
        streamed = true;
        throw new Error('ECONNRESET after delta');
      },
      { baseDelayMs: 1, canRetry: () => !streamed },
    ),
  );
  assert.equal(calls, 1);
});
