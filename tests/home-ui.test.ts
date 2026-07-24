import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatPromptLabel, renderHomeScreen } from '../src/ui/home.js';

const baseConfig = {
  provider: 'openai' as const,
  model: 'gpt-5.5',
  baseUrl: 'https://api.aisz.mom/v1',
  approval: 'ask' as const,
  workspaceRoot: 'C:\\Users\\x\\cli',
  sessionDir: 'C:\\Users\\x\\cli\\.aicode\\sessions',
  maxSteps: 24,
  noBanner: false,
};

const provider = {
  name: 'openai' as const,
  model: 'gpt-5.5',
  complete: async () => ({ actions: [] as Array<never> }),
};

test('renderHomeScreen logoOnly has brand chrome without stacking an Ask card', () => {
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  process.stdout.columns = 100;
  process.stdout.rows = 30;
  try {
    const screen = renderHomeScreen(baseConfig, provider, {
      noColor: true,
      version: '0.1.0',
      logoOnly: true,
    });
    // Interactive home is logo-only; the single Ask card is owned by askCard.
    assert.match(screen, /AICODE|█████/);
    assert.match(screen, /\/help commands/);
    assert.match(screen, /0\.1\.0/);
    assert.doesNotMatch(screen, /Ask anything/);
    assert.doesNotMatch(screen, /cli mvp/);
    // Exactly zero Ask boxes on home (card comes later).
    assert.equal((screen.match(/┌/g) ?? []).length, 0);
  } finally {
    process.stdout.columns = originalColumns;
    process.stdout.rows = originalRows;
  }
});

test('renderHomeScreen can still paint a static Ask card when logoOnly is false', () => {
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  process.stdout.columns = 100;
  process.stdout.rows = 30;
  try {
    const screen = renderHomeScreen(baseConfig, provider, {
      noColor: true,
      version: '0.1.0',
      logoOnly: false,
    });
    assert.match(screen, /Ask anything/);
    assert.match(screen, /Build/);
    assert.match(screen, /gpt-5\.5|5\.5/);
    assert.equal((screen.match(/┌/g) ?? []).length, 1);
  } finally {
    process.stdout.columns = originalColumns;
    process.stdout.rows = originalRows;
  }
});

test('chatPromptLabel uses left accent bar', () => {
  assert.match(chatPromptLabel({ noColor: true }), /│/);
});
