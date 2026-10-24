import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createOpenAIProvider } from '../src/providers/openai.js';
import { createOpenAIResponsesProvider } from '../src/providers/openai-responses.js';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import { createGeminiProvider } from '../src/providers/gemini.js';
import { withRequestControl, ProviderRequestTimeoutError } from '../src/providers/requestControl.js';
import { withModelRetry, isRetryableModelError } from '../src/providers/retry.js';
import { abortable } from '../src/utils/cancellation.js';
import type { Provider, ProviderRequest } from '../src/providers/types.js';

const baseRequest: ProviderRequest = { workspaceRoot: process.cwd(), tools: [], messages: [{ role: 'user', content: 'cancellation fixture', createdAt: '2026-10-22T00:00:00Z' }] };
const profiles: Array<{ name: string; create: (baseUrl: string) => Provider; delta: object }> = [
  { name: 'chat', create: baseUrl => createOpenAIProvider({ apiKey: 'test-only', baseUrl, model: 'fixture' }), delta: { choices: [{ delta: { content: 'first' } }] } },
  { name: 'responses', create: baseUrl => createOpenAIResponsesProvider({ apiKey: 'test-only', baseUrl, model: 'fixture' }), delta: { type: 'response.output_text.delta', delta: 'first' } },
  { name: 'anthropic', create: baseUrl => createAnthropicProvider({ apiKey: 'test-only', baseUrl, model: 'fixture' }), delta: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'first' } } },
  { name: 'gemini', create: baseUrl => createGeminiProvider({ apiKey: 'test-only', baseUrl, model: 'fixture' }), delta: { candidates: [{ content: { parts: [{ text: 'first' }] } }] } },
];

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function fixture(handler: (response: ServerResponse) => void) {
  let requests = 0;
  const server = createServer((_request, response) => { requests += 1; handler(response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, requests: () => requests, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), 3000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

for (const profile of profiles) {
  test(`${profile.name} cancellation before headers closes the request without fallback`, async () => {
    const seen = deferred(); const closed = deferred();
    const server = await fixture(response => { response.once('close', () => closed.resolve()); seen.resolve(); });
    const controller = new AbortController();
    const pending = profile.create(server.url).complete({ ...baseRequest, signal: controller.signal });
    const rejected = assert.rejects(pending, error => (error as Error).name === 'AbortError');
    try {
      await bounded(seen.promise, 'request never reached fixture');
      controller.abort();
      await bounded(rejected, 'cancel before headers did not settle');
      await bounded(closed.promise, 'cancel did not close the HTTP stream');
      assert.equal(server.requests(), 1);
    } finally { controller.abort(); await server.close(); }
  });

  test(`${profile.name} cancellation after a real SSE delta stops the reader and later callbacks`, async () => {
    const deltaSeen = deferred(); const closed = deferred();
    const server = await fixture(response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify(profile.delta)}\n\n`);
      const heartbeat = setInterval(() => response.write('data: {}\n\n'), 20);
      response.once('close', () => { clearInterval(heartbeat); closed.resolve(); });
    });
    const controller = new AbortController();
    const deltas: string[] = [];
    const pending = profile.create(server.url).complete({ ...baseRequest, signal: controller.signal, onTextDelta: delta => { deltas.push(delta); deltaSeen.resolve(); } });
    const rejected = assert.rejects(pending, error => (error as Error).name === 'AbortError');
    try {
      await bounded(deltaSeen.promise, 'initial stream delta was not delivered');
      controller.abort();
      await bounded(rejected, 'stream cancellation did not settle');
      await bounded(closed.promise, 'stream remained connected after cancellation');
      assert.deepEqual(deltas, ['first']);
      assert.equal(server.requests(), 1);
    } finally { controller.abort(); await server.close(); }
  });

  test(`${profile.name} total deadline is enforced while heartbeats continue`, async () => {
    const closed = deferred();
    let chunks = 0;
    const server = await fixture(response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let index = 0; index < 3; index += 1) { response.write('data: {}\n\n'); chunks += 1; }
      const heartbeat = setInterval(() => { chunks += 1; response.write('data: {}\n\n'); }, 20);
      response.once('close', () => { clearInterval(heartbeat); closed.resolve(); });
    });
    try {
      await assert.rejects(profile.create(server.url).complete({ ...baseRequest, timeoutMs: 1500 }), error => error instanceof ProviderRequestTimeoutError && !isRetryableModelError(error));
      await bounded(closed.promise, 'deadline left the HTTP connection alive');
      assert.ok(chunks >= 3);
      assert.equal(server.requests(), 1);
    } finally { await server.close(); }
  });
}

test('pre-cancelled work and cancellation during retry backoff never issue another attempt', async () => {
  const preCancelled = new AbortController(); preCancelled.abort();
  let calls = 0;
  await assert.rejects(withModelRetry(async () => { calls += 1; return 'unexpected'; }, { signal: preCancelled.signal }), error => (error as Error).name === 'AbortError');
  assert.equal(calls, 0);
  await assert.rejects(withRequestControl({ ...baseRequest, timeoutMs: 40 }, request => withModelRetry(async () => { calls += 1; throw new Error('ECONNRESET'); }, { signal: request.signal, baseDelayMs: 1000 })), ProviderRequestTimeoutError);
  assert.equal(calls, 1);
  assert.equal(isRetryableModelError(new DOMException('This operation was aborted', 'AbortError')), false);
  await assert.rejects(abortable(Promise.reject(new Error('late rejection')), preCancelled.signal), error => (error as Error).name === 'AbortError');
});

test('a completed or cancelled request drops late text and reasoning deltas', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let saved: ProviderRequest | undefined;
    const seen: string[] = [];
    const started = deferred();
    const work = withRequestControl({ ...baseRequest, signal: controller.signal, onTextDelta: delta => seen.push(delta), onThinkingDelta: delta => seen.push(delta) }, async request => { saved = request; started.resolve(); if (cancel) return new Promise<void>(() => {}); });
    const outcome = cancel ? assert.rejects(work, error => (error as Error).name === 'AbortError') : work;
    await started.promise;
    if (cancel) controller.abort();
    await outcome;
    saved!.onTextDelta?.('late'); saved!.onThinkingDelta?.('late thought');
    assert.deepEqual(seen, []);
  }
});

test('DONE finishes and cancels a stream even if the server does not close it', async () => {
  const closed = deferred();
  const server = await fixture(response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"complete"}}]}\n\ndata: [DONE]\n\n');
    response.once('close', () => closed.resolve());
  });
  try {
    const result = await createOpenAIProvider({ apiKey: 'test-only', baseUrl: server.url, model: 'fixture' }).complete({ ...baseRequest, timeoutMs: 2000 });
    assert.deepEqual(result.actions, [{ type: 'message', content: 'complete' }]);
    await bounded(closed.promise, 'DONE did not release the stream');
  } finally { await server.close(); }
});
