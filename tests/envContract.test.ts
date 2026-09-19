import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvKeys, extractCodeEnvKeys } from '../src/config/envContract.js';

test('parseEnvKeys extracts key names only, skipping comments', () => {
  const text = [
    '# 注释行',
    '',
    'API_URL=https://example.invalid',
    'export TIMEOUT_MS=5000',
    'BARE_ONLY',
    'FEATURE_FLAG=',
  ].join('\n');
  assert.deepEqual(parseEnvKeys(text), ['API_URL', 'TIMEOUT_MS', 'FEATURE_FLAG']);
});

test('extractCodeEnvKeys finds dot and bracket forms', () => {
  const source = `
const a = process.env.API_URL;
const b = process.env["FEATURE_FLAG"];
const c = process.env['PORT'];
const d = getEnv("MODE");
const e = requireEnv('REGION');
`;
  const keys = extractCodeEnvKeys(source).sort();
  assert.ok(keys.includes('API_URL'));
  assert.ok(keys.includes('FEATURE_FLAG'));
  assert.ok(keys.includes('PORT'));
  assert.ok(keys.includes('MODE'));
  assert.ok(keys.includes('REGION'));
});

test('extractCodeEnvKeys ignores non-key usages', () => {
  assert.deepEqual(extractCodeEnvKeys('const x = process.env;'), []);
  assert.deepEqual(extractCodeEnvKeys('no env usage here'), []);
});
