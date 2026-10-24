const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUsageStore, parseEntries, summarize, localDateKey, predictCacheHitRate } = require('../electron/usage-store.cjs');

function iso(daysAgo, hour = 12) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

test('parseEntries skips corrupt lines and empty-usage rows', () => {
  const text = [
    JSON.stringify({ ts: iso(0), model: 'a', provider: 'anthropic', inputTokens: 10, outputTokens: 5 }),
    'not json at all',
    JSON.stringify({ ts: iso(0), model: 'b', provider: 'openai', inputTokens: 0, outputTokens: 0 }),
    JSON.stringify({ ts: 'bad-date', model: 'c', inputTokens: 3, outputTokens: 3 }),
    JSON.stringify({ ts: iso(0), model: 'd', provider: 'openai', inputTokens: 1, outputTokens: 2 }),
  ].join('\n');
  const entries = parseEntries(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].model, 'a');
  assert.equal(entries[1].model, 'd');
});

test('summarize builds a dense per-day window and per-model daily breakdown', () => {
  const now = new Date();
  const entries = parseEntries([
    JSON.stringify({ ts: iso(0), model: 'claude-opus-4-8', provider: 'anthropic', inputTokens: 100, outputTokens: 50 }),
    JSON.stringify({ ts: iso(0), model: 'grok-4.5', provider: 'openai', inputTokens: 20, outputTokens: 10 }),
    JSON.stringify({ ts: iso(2), model: 'claude-opus-4-8', provider: 'anthropic', inputTokens: 5, outputTokens: 5 }),
  ].join('\n'));

  const summary = summarize(entries, 7, now);
  assert.equal(summary.days, 7);
  assert.equal(summary.daily.length, 7, 'dense 7-day window');
  assert.equal(summary.totals.tokens, 100 + 50 + 20 + 10 + 5 + 5);
  assert.equal(summary.totals.rounds, 3);

  // Today is the last column.
  const today = summary.daily[summary.daily.length - 1];
  assert.equal(today.date, localDateKey(now));
  assert.equal(today.total, 180);
  assert.equal(today.rounds, 2);
  assert.equal(today.byModel['claude-opus-4-8'], 150);
  assert.equal(today.byModel['grok-4.5'], 30);

  // Models sorted by total desc.
  assert.equal(summary.models[0].model, 'claude-opus-4-8');
  assert.equal(summary.models[0].total, 160);
  assert.equal(summary.models[1].model, 'grok-4.5');
});

test('summarize excludes entries older than the window', () => {
  const now = new Date();
  const entries = parseEntries([
    JSON.stringify({ ts: iso(10), model: 'old', provider: 'openai', inputTokens: 999, outputTokens: 999 }),
    JSON.stringify({ ts: iso(1), model: 'recent', provider: 'openai', inputTokens: 4, outputTokens: 4 }),
  ].join('\n'));
  const summary = summarize(entries, 7, now);
  assert.equal(summary.totals.tokens, 8);
  assert.equal(summary.models.length, 1);
  assert.equal(summary.models[0].model, 'recent');
});

test('30-day window keeps entries the 7-day window drops', () => {
  const now = new Date();
  const entries = parseEntries(
    JSON.stringify({ ts: iso(20), model: 'm', provider: 'openai', inputTokens: 7, outputTokens: 3 }),
  );
  assert.equal(summarize(entries, 7, now).totals.tokens, 0);
  assert.equal(summarize(entries, 30, now).totals.tokens, 10);
  assert.equal(summarize(entries, 30, now).daily.length, 30);
});

test('90-day window keeps entries the 30-day window drops', () => {
  const now = new Date();
  const entries = parseEntries(
    JSON.stringify({ ts: iso(60), model: 'm', provider: 'openai', inputTokens: 7, outputTokens: 3 }),
  );
  assert.equal(summarize(entries, 30, now).totals.tokens, 0);
  const summary90 = summarize(entries, 90, now);
  assert.equal(summary90.totals.tokens, 10);
  assert.equal(summary90.days, 90);
  assert.equal(summary90.daily.length, 90);
});

test('createUsageStore returns empty summary when ledger file is missing', () => {
  const missing = path.join(os.tmpdir(), `no-such-usage-${Date.now()}.jsonl`);
  const store = createUsageStore({ logPath: missing });
  const summary = store.summary(7);
  assert.equal(summary.totals.tokens, 0);
  assert.equal(summary.daily.length, 7);
  assert.deepEqual(summary.models, []);
});

test('createUsageStore reads and aggregates a real ledger file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-store-'));
  const logPath = path.join(dir, 'usage.jsonl');
  try {
    fs.writeFileSync(logPath, [
      JSON.stringify({ ts: iso(0), model: 'claude-opus-4-8', provider: 'anthropic', inputTokens: 42, outputTokens: 17 }),
      JSON.stringify({ ts: iso(1), model: 'gpt-5.5', provider: 'openai', inputTokens: 8, outputTokens: 4 }),
    ].join('\n') + '\n', 'utf8');
    const summary = createUsageStore({ logPath }).summary(7);
    assert.equal(summary.totals.tokens, 42 + 17 + 8 + 4);
    assert.equal(summary.totals.rounds, 2);
    assert.equal(summary.models.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('predictCacheHitRate prefers local agent estimates over provider-reported fields', () => {
  const entries = parseEntries([
    JSON.stringify({ ts: iso(0), model: 'claude-opus-4-8', provider: 'anthropic', inputTokens: 100, outputTokens: 10, localCachePredictedRate: 0.8 }),
    JSON.stringify({ ts: iso(1), model: 'claude-opus-4-8', provider: 'anthropic', inputTokens: 50, outputTokens: 5, localCachePredictedRate: 0.6 }),
    JSON.stringify({ ts: iso(2), model: 'claude-opus-4-8', provider: 'anthropic', inputTokens: 50, outputTokens: 5, localCachePredictedRate: 0.4, cacheReadTokens: 0 }),
  ].join('\n'));
  const result = predictCacheHitRate(entries, 'claude-opus-4-8');
  assert.equal(result.source, 'local-estimate');
  assert.ok(result.predicted !== null);
  assert.equal(Number(result.predicted.toFixed(3)), 0.65);
});

test('predictCacheHitRate falls back to provider-reported cache when local estimates are insufficient', () => {
  const entries = parseEntries([
    JSON.stringify({ ts: iso(0), model: 'gpt-5.5', provider: 'openai', inputTokens: 100, outputTokens: 10, cacheReadTokens: 70 }),
    JSON.stringify({ ts: iso(1), model: 'gpt-5.5', provider: 'openai', inputTokens: 50, outputTokens: 5, cacheReadTokens: 25 }),
    JSON.stringify({ ts: iso(2), model: 'gpt-5.5', provider: 'openai', inputTokens: 50, outputTokens: 5, cacheReadTokens: 5 }),
  ].join('\n'));
  const result = predictCacheHitRate(entries, 'gpt-5.5');
  assert.equal(result.source, 'provider-reported');
  assert.ok(result.predicted !== null);
  // `inputTokens` is stored net of the cached part, so the denominator is
  // input + cacheRead: 100 / (200 + 100). Dividing by input alone gave 50%,
  // which is the hit rate of a shape that never occurs.
  assert.equal(Number(result.predicted.toFixed(3)), 0.333);
});

test('predictCacheHitRate weights a turn by the whole prompt it read', () => {
  const entries = parseEntries([
    // A cached megaturn and a tiny uncached one. Weighting by net input would
    // let the 10-token turn pull the prediction.
    JSON.stringify({ ts: iso(0), model: 'm', provider: 'p', inputTokens: 20000, outputTokens: 10, cacheReadTokens: 980000, localCachePredictedRate: 0.98 }),
    JSON.stringify({ ts: iso(1), model: 'm', provider: 'p', inputTokens: 10, outputTokens: 10, localCachePredictedRate: 0.0 }),
    JSON.stringify({ ts: iso(2), model: 'm', provider: 'p', inputTokens: 10, outputTokens: 10, localCachePredictedRate: 0.0 }),
  ].join('\n'));
  const result = predictCacheHitRate(entries, 'm');
  assert.equal(result.samples, 3);
  assert.ok(result.predicted > 0.9, `expected the megaturn to dominate, got ${result.predicted}`);
});
