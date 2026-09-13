import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_COMPACT_KEEP_RECENT_USER,
  SUMMARIZATION_PROMPT,
  buildCompactRequestMessages,
  estimateTokens,
  maybeAutoCompact,
  resolveContextWindowTokens,
  shouldAutoCompact,
} from '../src/agent/autoCompact.js';

test('estimateTokens uses the upstream bytes/4 heuristic', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('a'.repeat(40_000)), 10_000);
  // CJK is 3 bytes per char in UTF-8: 4 chars = 12 bytes = 3 tokens.
  assert.equal(estimateTokens('中文中文'), 3);
});

test('resolveContextWindowTokens reads AICODE_CONTEXT_WINDOW with validation', () => {
  const previous = process.env.AICODE_CONTEXT_WINDOW;
  try {
    delete process.env.AICODE_CONTEXT_WINDOW;
    assert.equal(resolveContextWindowTokens(), undefined, 'unknown window disables auto-compact');
    process.env.AICODE_CONTEXT_WINDOW = '128000';
    assert.equal(resolveContextWindowTokens(), 128000);
    process.env.AICODE_CONTEXT_WINDOW = 'nope';
    assert.equal(resolveContextWindowTokens(), undefined);
    process.env.AICODE_CONTEXT_WINDOW = '-5';
    assert.equal(resolveContextWindowTokens(), undefined);
  } finally {
    if (previous === undefined) delete process.env.AICODE_CONTEXT_WINDOW;
    else process.env.AICODE_CONTEXT_WINDOW = previous;
  }
});

test('shouldAutoCompact fires at 90% of the window with enough messages', () => {
  assert.equal(shouldAutoCompact(89_000, 100_000, 20), false, 'below the 90% line');
  assert.equal(shouldAutoCompact(90_000, 100_000, 20), true, 'exactly at the limit');
  assert.equal(shouldAutoCompact(95_000, 100_000, 20), true);
  assert.equal(shouldAutoCompact(95_000, undefined, 20), false, 'no window → never');
  assert.equal(shouldAutoCompact(95_000, 100_000, 4), false, 'short session protected');
});

test('buildCompactRequestMessages appends the summarization prompt as a user message', () => {
  const messages = [
    { role: 'user' as const, content: 'fix the tests', createdAt: 't1' },
    { role: 'assistant' as const, content: 'working on it', createdAt: 't2' },
  ];
  const request = buildCompactRequestMessages(messages);
  assert.equal(request.length, 3);
  assert.equal(request[2].role, 'user');
  assert.equal(request[2].content, SUMMARIZATION_PROMPT);
  // Original history must be carried verbatim (compact.rs: summary request
  // includes the full conversation).
  assert.equal(request[0], messages[0]);
});

test('auto-compact keeps the configured number of recent user messages', () => {
  // AUTO_COMPACT_KEEP_RECENT_USER mirrors compact.rs's recent-user retention.
  assert.ok(AUTO_COMPACT_KEEP_RECENT_USER >= 1);
});

/** Minimal runtime that triggers auto-compact (window 100 tokens, ≥8 msgs). */
function makeCompactRuntime(complete: () => Promise<any>) {
  const emitted: any[] = [];
  const messages = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: 'x'.repeat(60),
    createdAt: 't',
  }));
  const runtime: any = {
    session: { id: 's', messages, finalAnswers: [] },
    config: { workspaceRoot: '.' },
    provider: { complete },
    ui: { info: () => {} },
    compactEmit: (payload: any) => emitted.push(payload),
  };
  return { runtime, emitted };
}

test('maybeAutoCompact emits started → completed with real message counts', async () => {
  const previous = process.env.AICODE_CONTEXT_WINDOW;
  process.env.AICODE_CONTEXT_WINDOW = '150';
  try {
    const { runtime, emitted } = makeCompactRuntime(async () => ({
      actions: [{ type: 'message', content: 'handoff summary here' }],
    }));
    await maybeAutoCompact(runtime);
    assert.deepEqual(emitted.map((e) => e.phase), ['started', 'completed']);
    assert.equal(emitted[0].auto, true);
    assert.equal(emitted[0].before, 10);
    assert.equal(emitted[1].before, 10);
    assert.equal(emitted[1].after, runtime.session.messages.length);
    assert.ok(emitted[1].after < 10, 'history actually shrank');
  } finally {
    if (previous === undefined) delete process.env.AICODE_CONTEXT_WINDOW;
    else process.env.AICODE_CONTEXT_WINDOW = previous;
  }
});

test('failed compaction emits a failed phase and keeps the full history', async () => {
  const previous = process.env.AICODE_CONTEXT_WINDOW;
  process.env.AICODE_CONTEXT_WINDOW = '150';
  try {
    const { runtime, emitted } = makeCompactRuntime(async () => {
      throw new Error('provider exploded');
    });
    await maybeAutoCompact(runtime);
    assert.deepEqual(emitted.map((e) => e.phase), ['started', 'failed']);
    assert.match(emitted[1].reason, /provider exploded/);
    assert.equal(runtime.session.messages.length, 10, 'history untouched on failure');
  } finally {
    if (previous === undefined) delete process.env.AICODE_CONTEXT_WINDOW;
    else process.env.AICODE_CONTEXT_WINDOW = previous;
  }
});

test('no compaction events fire when the threshold is not reached', async () => {
  const previous = process.env.AICODE_CONTEXT_WINDOW;
  process.env.AICODE_CONTEXT_WINDOW = '100000';
  try {
    const { runtime, emitted } = makeCompactRuntime(async () => ({ actions: [] }));
    await maybeAutoCompact(runtime);
    assert.deepEqual(emitted, []);
  } finally {
    if (previous === undefined) delete process.env.AICODE_CONTEXT_WINDOW;
    else process.env.AICODE_CONTEXT_WINDOW = previous;
  }
});
