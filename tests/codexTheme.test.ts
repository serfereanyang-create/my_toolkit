import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextWindowLine,
  fmtElapsedCompact,
  formatTokensCompact,
  statusIndicatorLine,
  turnSeparatorLine,
} from '../src/ui/codexTheme.js';

test('formatTokensCompact matches upstream status/helpers.rs rules', () => {
  assert.equal(formatTokensCompact(0), '0');
  assert.equal(formatTokensCompact(999), '999');
  assert.equal(formatTokensCompact(1234), '1.23K', '<10 scaled keeps 2 decimals');
  assert.equal(formatTokensCompact(14200), '14.2K', '<100 scaled keeps 1 decimal');
  assert.equal(formatTokensCompact(1500000), '1.5M', 'trailing zeros trimmed');
  assert.equal(formatTokensCompact(2500000000), '2.5B');
});

test('fmtElapsedCompact matches status_indicator_widget rules', () => {
  assert.equal(fmtElapsedCompact(42_000), '42s');
  assert.equal(fmtElapsedCompact(185_000), '3m 05s', 'seconds are zero-padded');
  assert.equal(fmtElapsedCompact(3_723_000), '1h 02m 03s');
});

test('contextWindowLine prefers percentage, falls back to tokens, then 100%', () => {
  assert.equal(contextWindowLine(12_340, 88), '88% context left');
  assert.equal(contextWindowLine(12_340, null), '12.3K used', 'scaled in [10,100) keeps 1 decimal');
  assert.equal(contextWindowLine(1234, null), '1.23K used', 'scaled <10 keeps 2 decimals');
  assert.equal(contextWindowLine(0, null), '100% context left');
});

test('statusIndicatorLine renders the blink bullet and interrupt suffix', () => {
  const line = statusIndicatorLine({
    frame: 0,
    title: 'Working',
    elapsedMs: 12_000,
    interruptHint: 'esc',
    noColor: true,
  });
  assert.match(line, /• Working \(12s • esc to interrupt\)/);
  // motion.rs: the bullet blinks •/◦ on a 600ms half-period (700300ms lands in
  // an odd slot → '◦').
  const other = statusIndicatorLine({
    frame: 1,
    title: 'Working',
    elapsedMs: 700_300,
    interruptHint: 'esc',
    noColor: true,
  });
  assert.match(other, /◦ Working \(11m 40s • esc to interrupt\)/);
  const noHint = statusIndicatorLine({
    frame: 0,
    elapsedMs: 5_000,
    interruptHint: null,
    noColor: true,
  });
  assert.match(noHint, /• Working \(5s\)/);
  assert.doesNotMatch(noHint, /interrupt/);
});

test('turnSeparatorLine only appears for turns longer than a minute', () => {
  const end = new Date(2026, 8, 11, 22, 45);
  assert.equal(turnSeparatorLine(30_000, end, true), '');
  assert.equal(turnSeparatorLine(90_000, end, true), 'Worked for 1m 30s · done 10:45 PM');
});
