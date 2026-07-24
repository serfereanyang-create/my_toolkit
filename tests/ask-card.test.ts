import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAskCardFrame } from '../src/cli/askCard.js';

test('renderAskCardFrame puts placeholder and Build status inside the card', () => {
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;
  process.stdout.columns = 100;
  process.stdout.rows = 28;
  try {
    const empty = renderAskCardFrame({
      text: '',
      model: 'grok-4.5',
      baseUrl: 'https://yunqiaoai.dpdns.org/v1',
      providerName: 'openai',
      noColor: true,
      placeholder: 'Ask anything...  "Fix broken tests"',
      agentLabel: 'Build',
    });
    assert.match(empty, /Ask anything/);
    assert.match(empty, /Build/);
    assert.match(empty, /grok-4\.5/);
    assert.match(empty, /yunqiaoai\.dpdns\.org/);
    assert.match(empty, /┌/);
    assert.match(empty, /│/);

    const typed = renderAskCardFrame({
      text: '修一下测试',
      model: 'grok-4.5',
      baseUrl: 'https://yunqiaoai.dpdns.org/v1',
      providerName: 'openai',
      noColor: true,
      placeholder: 'Ask anything...  "Fix broken tests"',
      agentLabel: 'Build',
    });
    assert.match(typed, /修一下测试/);
    assert.doesNotMatch(typed, /Ask anything/);
  } finally {
    process.stdout.columns = originalColumns;
    process.stdout.rows = originalRows;
  }
});
