import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DesktopHostToolBroker,
  DEFAULT_HOST_TOOL_TIMEOUT_MS,
  validateHostToolResult,
} from '../src/cli/hostToolBroker.js';

/*
 * The host-tool broker is the CLI half of the hidden-browser RPC: it emits
 * `host_tool_request` and waits for the desktop's `host_tool_response`. Two
 * properties matter and neither is cosmetic:
 *
 *   - the request never resolves with something the model will read as success
 *     when the desktop actually failed, and
 *   - it always settles, so a turn cannot hang forever on a host that died.
 *
 * A malformed reply is deliberately NOT coerced: it leaves the request pending
 * so a corrected reply can still land inside the same deadline.
 */

function makeBroker(overrides: { timeoutMs?: number; allowedTools?: ReadonlySet<string> } = {}) {
  const emitted: Array<Record<string, unknown>> = [];
  const broker = new DesktopHostToolBroker('sess-1', {
    emit: (event) => emitted.push(event),
    timeoutMs: overrides.timeoutMs ?? 200,
    ...(overrides.allowedTools ? { allowedTools: overrides.allowedTools } : {}),
  });
  const requestId = (index = -1) => String(emitted.at(index)?.requestId ?? '');
  return { broker, emitted, requestId };
}

test('a request round-trips through the wire as a host_tool_request', async () => {
  const { broker, emitted, requestId } = makeBroker();
  const pending = broker.request('background_browser_open', { url: 'https://example.com/' });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'host_tool_request');
  assert.equal(emitted[0].sessionId, 'sess-1');
  assert.equal(emitted[0].tool, 'background_browser_open');
  assert.deepEqual(emitted[0].input, { url: 'https://example.com/' });

  broker.resolve(requestId(), { ok: true, output: 'opened', data: { browserId: 'b1' } });
  assert.deepEqual(await pending, { ok: true, output: 'opened', data: { browserId: 'b1' } });
});

test('a host failure resolves as ok:false, never as a rejection the model cannot read', async () => {
  const { broker, requestId } = makeBroker();
  const pending = broker.request('background_browser_inspect', { browserId: 'b1' });
  broker.resolve(requestId(), { ok: false, output: '页面已关闭' });
  assert.deepEqual(await pending, { ok: false, output: '页面已关闭' });
});

test('only the allowlisted capability can be requested', async () => {
  // The desktop host is the only place a hidden browser exists, so a tool the
  // enum does not cover must fail here rather than be forwarded and answered by
  // whatever happens to be listening.
  const { broker, emitted } = makeBroker({ allowedTools: new Set(['background_browser_open']) });
  await assert.rejects(() => broker.request('computer_click', {}), /not enabled/);
  await assert.rejects(() => broker.request('shell_exec', {}), /not enabled/);
  assert.equal(emitted.length, 0, 'a refused capability must not reach the wire');
});

test('a malformed tool name is refused before it reaches the wire', async () => {
  const { broker, emitted } = makeBroker();
  for (const name of ['', 'Background_Browser_Open', 'a b', '../etc/passwd', 'a'.repeat(200)]) {
    await assert.rejects(() => broker.request(name, {}), /Invalid host tool name/);
  }
  assert.equal(emitted.length, 0);
});

test('non-object input is refused', async () => {
  const { broker } = makeBroker();
  for (const input of [null, undefined, 'string', 42, ['a']]) {
    await assert.rejects(() => broker.request('background_browser_open', input as never), /must be an object/);
  }
});

test('a malformed reply stays pending so the host may correct it', async () => {
  // This is the design decision, not an oversight: coercing `{ok:'yes'}` into
  // success would tell the model a page was opened when it was not.
  const { broker, requestId } = makeBroker({ timeoutMs: 5000 });
  const pending = broker.request('background_browser_open', {});
  assert.throws(() => broker.resolve(requestId(), { ok: 'yes', output: 'x' }), /must be a boolean/);
  assert.equal(broker.pendingCount, 1, 'the request must still be waiting');

  // The same request id may now be answered correctly.
  broker.resolve(requestId(), { ok: true, output: 'opened' });
  assert.deepEqual(await pending, { ok: true, output: 'opened' });
  assert.equal(broker.pendingCount, 0);
});

test('unknown, duplicate and stale request ids cannot revive work', async () => {
  const { broker, requestId } = makeBroker();
  const pending = broker.request('background_browser_open', {});
  assert.equal(broker.resolve('host_not-a-request', { ok: true, output: 'x' }), false);
  broker.resolve(requestId(), { ok: true, output: 'first' });
  // A duplicate reply for an already-settled request must be ignored, not
  // resolve a second time or throw.
  assert.equal(broker.resolve(requestId(), { ok: true, output: 'second' }), false);
  assert.deepEqual(await pending, { ok: true, output: 'first' });
});

test('an unanswered request times out instead of hanging the turn', async () => {
  const { broker } = makeBroker({ timeoutMs: 60 });
  await assert.rejects(() => broker.request('background_browser_open', {}), /timed out/);
  assert.equal(broker.pendingCount, 0);
});

test('a reply arriving after the deadline is refused even if the timer has not run', async () => {
  // A stalled event loop must not let a late answer win: the deadline is
  // compared against the clock, not against whether the timeout callback fired.
  const { broker, requestId } = makeBroker({ timeoutMs: 40 });
  const pending = broker.request('background_browser_open', {}).catch((error: Error) => error.message);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(broker.resolve(requestId(), { ok: true, output: 'too late' }), false);
  assert.match(String(await pending), /timed out/);
});

test('cancelAll settles every pending request and suspends new ones', async () => {
  // Cancel is why denying approvals on a turn boundary cannot leave a turn
  // blocked on a host that will never answer.
  const { broker, emitted } = makeBroker({ timeoutMs: 5000 });
  const first = broker.request('background_browser_open', {});
  const second = broker.request('background_browser_inspect', {});
  broker.cancelAll('已取消当前执行');
  await assert.rejects(() => first, /已取消当前执行/);
  await assert.rejects(() => second, /已取消当前执行/);
  await assert.rejects(() => broker.request('background_browser_open', {}), /已取消当前执行/);
  assert.equal(broker.pendingCount, 0);

  // The next turn may use the capability again — a cancel suspends, it does not
  // disable the feature for the rest of the session.
  broker.resume();
  const third = broker.request('background_browser_open', { url: 'https://example.com/' });
  assert.equal(broker.pendingCount, 1);
  broker.resolve(String(emitted.at(-1)?.requestId), { ok: true, output: 'again' });
  assert.deepEqual(await third, { ok: true, output: 'again' });
});

test('close makes the suspension permanent', async () => {
  const { broker } = makeBroker({ timeoutMs: 5000 });
  const pending = broker.request('background_browser_open', {});
  broker.close('桥接正在关闭');
  await assert.rejects(() => pending, /桥接正在关闭/);
  // resume() must not reopen a closed broker: the child is going away.
  broker.resume();
  await assert.rejects(() => broker.request('background_browser_open', {}), /桥接正在关闭/);
});

test('the default deadline is a minute', () => {
  // Long enough for a page load in the hidden browser, short enough that a dead
  // host does not stall a turn for the whole approval budget.
  assert.equal(DEFAULT_HOST_TOOL_TIMEOUT_MS, 60_000);
});

test('an invalid timeout is refused at construction', () => {
  for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => new DesktopHostToolBroker('s', { emit: () => {}, timeoutMs }),
      /positive integer/,
      `${timeoutMs} must be refused`,
    );
  }
});

test('validateHostToolResult rejects unknown fields instead of passing them through', () => {
  // A field the CLI does not know about is a protocol mismatch, and silently
  // carrying it into a ToolResult hides that.
  assert.throws(() => validateHostToolResult({ ok: true, output: 'x', image: 'y' }), /Unknown/);
  assert.throws(() => validateHostToolResult(null), /must be an object/);
  assert.throws(() => validateHostToolResult('ok'), /must be an object/);
  assert.throws(() => validateHostToolResult({ ok: true }), /output must be a string/);
  assert.deepEqual(validateHostToolResult({ ok: true, output: 'x' }), { ok: true, output: 'x' });
  assert.deepEqual(
    validateHostToolResult({ ok: true, output: 'x', data: { a: 1 } }),
    { ok: true, output: 'x', data: { a: 1 } },
  );
});
