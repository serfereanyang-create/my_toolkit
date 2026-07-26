import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from '../src/cli/args.js';

test('parseArgs supports desktop bridge mode', () => {
  const args = parseArgs(['--desktop-bridge', '--provider', 'mock', '--workspace', '.']);

  assert.equal(args.desktopBridge, true);
  assert.equal(args.provider, 'mock');
  assert.ok(args.workspace);
});

test('--desktop-bridge implies json + noBanner + noInput', () => {
  const args = parseArgs(['--desktop-bridge']);

  assert.equal(args.desktopBridge, true);
  assert.equal(args.json, true);
  assert.equal(args.noBanner, true);
  assert.equal(args.noInput, true);
});
