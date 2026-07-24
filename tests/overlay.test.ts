import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultMessageActions, renderOverlayFrame } from '../src/ui/overlay.js';

test('renderOverlayFrame looks like OpenCode message actions panel', () => {
  const frame = renderOverlayFrame({
    title: 'Message Actions',
    query: '',
    items: defaultMessageActions(),
    selected: 0,
    color: false,
  });
  assert.match(frame, /Message Actions/);
  assert.match(frame, /esc/);
  assert.match(frame, /Search/);
  assert.match(frame, /Revert/);
  assert.match(frame, /Copy/);
  assert.match(frame, /Fork/);
  // selected row marked in no-color mode
  assert.match(frame, /> Revert/);
});

test('renderOverlayFrame filters by search query', () => {
  const filtered = defaultMessageActions().filter((item) =>
    `${item.keyword} ${item.detail}`.toLowerCase().includes('copy'),
  );
  const frame = renderOverlayFrame({
    title: 'Message Actions',
    query: 'copy',
    items: filtered,
    selected: 0,
    color: false,
  });
  assert.match(frame, /Copy/);
  assert.doesNotMatch(frame, /Fork create/);
  assert.doesNotMatch(frame, /Revert undo/);
});

test('defaultMessageActions has revert copy fork', () => {
  const ids = defaultMessageActions().map((item) => item.id);
  assert.deepEqual(ids, ['revert', 'copy', 'fork']);
});
