import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsageLines, computeSessionAnalytics } from '../src/usage/sessionAnalytics.js';
import type { SessionToolCall } from '../src/usage/sessionAnalytics.js';

const ledgerLine = (tokens: Partial<{ input: number; output: number; cache: number; dur: number; ts: string }>) =>
  JSON.stringify({
    ts: tokens.ts ?? '2026-09-01T10:00:00Z',
    inputTokens: tokens.input ?? 100,
    outputTokens: tokens.output ?? 50,
    cacheReadTokens: tokens.cache ?? 0,
    durationMs: tokens.dur ?? 1000,
  });

test('parseUsageLines skips broken and zero-token rows', () => {
  const text = [
    ledgerLine({}),
    '{ broken json',
    '{"inputTokens":0,"outputTokens":0}',
    ledgerLine({}),
  ].join('\n');
  const parsed = parseUsageLines(text);
  assert.equal(parsed.length, 2);
});

test('computeSessionAnalytics aggregates tokens, cache rate and tool stats', () => {
  const ledgerText = [
    ledgerLine({ input: 100, output: 10, cache: 900, dur: 1000, ts: '2026-09-01T10:00:00Z' }),
    ledgerLine({ input: 200, output: 20, cache: 100, dur: 3000, ts: '2026-09-02T10:00:00Z' }),
  ].join('\n');
  const toolCalls: SessionToolCall[] = [
    { tool: 'read_file', ok: true },
    { tool: 'run_command', ok: false, output: 'exit 1\nboom' },
    { tool: 'run_command', ok: true },
  ];
  const r = computeSessionAnalytics({ ledgerText, toolCalls });
  assert.equal(r.ok, true);
  assert.equal(r.turns, 2);
  assert.equal(r.totalInputTokens, 300);
  assert.equal(r.totalOutputTokens, 30);
  // 900+100 / (300+900+100) = 1000/1300 ≈ 0.769
  assert.ok(Math.abs((r.cacheHitRate ?? 0) - 1000 / 1300) < 0.001);
  assert.equal(r.avgTurnDurationMs, 2000);
  assert.equal(r.totalToolCalls, 3);
  assert.equal(r.failureRate, 1 / 3);
  const runCmd = r.toolStats.find((s) => s.tool === 'run_command')!;
  assert.equal(runCmd.calls, 2);
  assert.equal(runCmd.failures, 1);
  assert.equal(runCmd.recentFailures.length, 1);
});
