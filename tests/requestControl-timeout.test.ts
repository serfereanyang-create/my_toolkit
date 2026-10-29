import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequestControl, withRequestControl, ProviderRequestTimeoutError, DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS } from '../src/providers/requestControl.js';
import { isRetryableModelError, withModelRetry } from '../src/providers/retry.js';
import type { ProviderRequest } from '../src/providers/types.js';

const baseRequest: ProviderRequest = { workspaceRoot: process.cwd(), tools: [], messages: [{ role: 'user', content: 'timeout fixture', createdAt: '2026-01-01T00:00:00Z' }] };

test('the deadline aborts the signal the work actually receives (not just a raced promise)', async () => {
  let seen: AbortSignal | undefined;
  const started = Date.now();
  await assert.rejects(
    withRequestControl({ ...baseRequest, timeoutMs: 30 }, async (request) => {
      seen = request.signal;
      // Stands in for a fetch: it only settles when its signal aborts.
      await new Promise((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
      });
      return 'unreachable';
    }),
    ProviderRequestTimeoutError,
  );
  assert.equal(seen?.aborted, true, 'the inner work saw its own signal abort');
  assert.ok(Date.now() - started < 2_000);
});

test('a timeout surfaces as a distinct, non-retryable error type', async () => {
  const error = new ProviderRequestTimeoutError(25);
  assert.equal(error.name, 'ProviderRequestTimeoutError');
  assert.equal(error.retryable, false);
  assert.equal(isRetryableModelError(error), false);
  assert.match(error.message, /25ms/);
});

test('withModelRetry does not retry a provider timeout even though it is an Error', async () => {
  let calls = 0;
  await assert.rejects(withModelRetry(async () => {
    calls += 1;
    throw new ProviderRequestTimeoutError(10);
  }, { baseDelayMs: 1, sleep: async () => undefined }), ProviderRequestTimeoutError);
  assert.equal(calls, 1);
});

test('createRequestControl rejects invalid deadlines and combines the caller signal', () => {
  for (const value of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
    assert.throws(() => createRequestControl(undefined, value), /positive supported integer/);
  }
  const plain = createRequestControl(undefined);
  assert.equal(plain.signal.aborted, false);
  plain.dispose(); // never leave the 5-minute deadline timer holding the process open
  const outer = new AbortController();
  const control = createRequestControl(outer.signal);
  assert.equal(control.signal.aborted, false);
  outer.abort();
  assert.equal(control.signal.aborted, true, 'the caller signal propagates');
  control.dispose();
});

test('close() aborts work that is still in flight after the caller gave up', async () => {
  const control = createRequestControl(undefined, DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS);
  let aborted = false;
  control.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
  control.close();
  assert.equal(aborted, true);
  assert.equal(control.signal.reason instanceof DOMException, true);
});
