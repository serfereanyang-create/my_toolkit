import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalUI, formatBoardProgressLine, formatContextFooter } from '../src/ui/terminal.js';
import type { TaskBoard } from '../src/tasks/types.js';

function board(tasks: TaskBoard['tasks'], status: TaskBoard['status'] = 'active'): TaskBoard {
  return {
    id: 'b1', title: 't', goal: 'g', status,
    createdAt: '', updatedAt: '', tasks,
  };
}

test('formatContextFooter shows real tokens and cache rate when reported', () => {
  const line = formatContextFooter(
    { inputTokens: 14200, outputTokens: 800, cacheReadTokens: 13206, cacheReported: true },
    1300,
  );
  // Segments only — the caller joins with ` · ` per footer.rs convention.
  // `inputTokens` is net of the cached part, so "used" is 27406 and the cache
  // share is 13206/27406, not 13206/14200.
  assert.equal(line, '27.4K used · out 1.3K · cache 48%');
});

test('formatContextFooter keeps a heavily cached turn under 100%', () => {
  // A real DeepSeek turn: 1167549 prompt tokens of which 1149568 were cached.
  // Dividing by the net input (17981) used to clamp to a meaningless 100%.
  const line = formatContextFooter(
    { inputTokens: 17981, outputTokens: 300, cacheReadTokens: 1149568, cacheReported: true },
  );
  assert.ok(line.includes('1.17M used'), line);
  assert.ok(line.includes('cache 98%'), line);
  // Still renders when the provider billed nothing for new input.
  assert.ok(formatContextFooter(
    { inputTokens: 0, outputTokens: 10, cacheReadTokens: 5000, cacheReported: true },
  ).includes('cache 100%'));
});

test('formatContextFooter omits cache when the provider never reported it', () => {
  const line = formatContextFooter(
    { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheReported: false },
  );
  assert.ok(!line.includes('cache'), 'absent data must not render as 0%');
  assert.ok(line.includes('900 used'), 'upstream footer.rs token-count variant');
});

test('formatContextFooter is empty without measurements', () => {
  assert.equal(formatContextFooter({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheReported: false }), '');
});

test('formatBoardProgressLine summarizes counts, current task and states', () => {
  const line = formatBoardProgressLine(board([
    { id: '1', title: 'a', status: 'done', dependsOn: [] },
    { id: '2', title: 'b', status: 'done', dependsOn: [] },
    { id: '3', title: 'wire auth', status: 'in_progress', dependsOn: [] },
    { id: '4', title: 'd', status: 'pending', dependsOn: [] },
    { id: '5', title: 'e', status: 'blocked', dependsOn: [] },
  ]));
  assert.ok(line.includes('board 2/5'));
  assert.ok(line.includes('▶ wire auth'));
  assert.ok(line.includes('○1 pending'));
  assert.ok(line.includes('✗1 blocked'));
});

test('formatBoardProgressLine marks completed boards', () => {
  const line = formatBoardProgressLine(board(
    [{ id: '1', title: 'a', status: 'done', dependsOn: [] }],
    'completed',
  ));
  assert.ok(line.includes('✔ completed'));
});

test('formatBoardProgressLine is silent for empty boards', () => {
  assert.equal(formatBoardProgressLine(board([])), '');
});

test('TerminalUI supports runtime verbose toggle', () => {
  const ui = new TerminalUI({ quiet: true });
  assert.equal(ui.verbose, false);
  assert.equal(ui.toggleVerbose(), true);
  assert.equal(ui.verbose, true);
  ui.setVerbose(false);
  assert.equal(ui.verbose, false);
});

test('TerminalUI contextStats caching does not break json mode', () => {
  const ui = new TerminalUI({ json: true });
  assert.doesNotThrow(() => ui.contextStats({ inputTokens: 10, outputTokens: 2, providerCacheReported: true, cacheReadTokens: 5 }));
  assert.doesNotThrow(() => ui.turnEnd());
});
