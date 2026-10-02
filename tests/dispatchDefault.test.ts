import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGlobalDispatchDefault } from '../src/dispatch/tierRouter.js';

function withSettings(prefs: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-settings-'));
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify(prefs), 'utf-8');
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('reads all three tiers, including standard', () => {
  const { file, cleanup } = withSettings({
    preferences: {
      dispatchDefault: {
        expensive: ['a/one'],
        standard: ['b/two', 'c/three'],
        cheap: 'd/four',
      },
    },
  });
  try {
    const read = readGlobalDispatchDefault(file);
    assert.ok(read);
    assert.deepEqual(read.expensive, ['a/one']);
    assert.deepEqual(read.standard, ['b/two', 'c/three'], 'standard must survive');
    assert.equal(read.cheap, 'd/four', 'a single string stays a string');
  } finally {
    cleanup();
  }
});

test('partial defaults are kept; empty tiers are dropped', () => {
  const { file, cleanup } = withSettings({
    preferences: { dispatchDefault: { cheap: [], expensive: ['a/one'] } },
  });
  try {
    const read = readGlobalDispatchDefault(file);
    assert.ok(read);
    assert.deepEqual(read.expensive, ['a/one']);
    assert.equal(read.cheap, undefined, 'an empty chain is not a selection');
  } finally {
    cleanup();
  }
});

test('no default at all reads as null rather than throwing', () => {
  const { file, cleanup } = withSettings({ preferences: {} });
  try {
    assert.equal(readGlobalDispatchDefault(file), null);
  } finally {
    cleanup();
  }
});
