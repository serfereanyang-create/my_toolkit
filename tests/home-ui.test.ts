import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatPromptLabel, renderHomeScreen } from '../src/ui/home.js';

test('renderHomeScreen includes OpenCode-like ask box and model line', () => {
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  process.stdout.columns = 100;
  process.stdout.rows = 30;
  try {
    const screen = renderHomeScreen(
      {
        provider: 'openai',
        model: 'gpt-5.5',
        baseUrl: 'https://api.aisz.mom/v1',
        approval: 'ask',
        workspaceRoot: 'C:\\Users\\x\\cli',
        sessionDir: 'C:\\Users\\x\\cli\\.aicode\\sessions',
        maxSteps: 24,
        noBanner: false,
      },
      { name: 'openai', model: 'gpt-5.5', complete: async () => ({ actions: [] }) },
      { noColor: true, version: '0.1.0' },
    );
    assert.match(screen, /Ask anything/);
    assert.match(screen, /Build/);
    assert.match(screen, /gpt-5\.5|5\.5/);
    assert.match(screen, /\/help commands/);
    assert.match(screen, /0\.1\.0/);
    assert.doesNotMatch(screen, /cli mvp/);
  } finally {
    process.stdout.columns = originalColumns;
    process.stdout.rows = originalRows;
  }
});

test('chatPromptLabel uses left accent bar', () => {
  assert.match(chatPromptLabel({ noColor: true }), /│/);
});
