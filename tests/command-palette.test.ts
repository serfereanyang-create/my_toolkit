import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandPaletteItems, formatHelpText } from '../src/cli/commandPalette.js';

test('commandPaletteItems covers core slash commands', () => {
  const ids = commandPaletteItems().map((item) => item.id);
  for (const need of ['/status', '/cache', '/actions', '/undo', '/exit', '/tools', '/sessions']) {
    assert.ok(ids.includes(need), `missing ${need}`);
  }
  // No raw multi-line wall — each row is a selectable item with keyword + detail.
  for (const item of commandPaletteItems()) {
    assert.ok(item.keyword.startsWith('/'));
    assert.ok(item.detail.length > 0);
  }
});

test('formatHelpText is compact fallback for non-TTY', () => {
  const text = formatHelpText();
  assert.match(text, /\/status/);
  assert.match(text, /floating menu/);
  assert.doesNotMatch(text, /Show this help\n\/status {5}Show session/);
});
