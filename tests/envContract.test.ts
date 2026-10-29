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

import { blankOutCommentsAndStrings, extractCodeEnvKeysDetailed } from '../src/config/envContract.js';

test('extractCodeEnvKeys does not scan its own source text inside string literals', () => {
  // The old scanner found `text.includes(` and treated `getEnv(` inside that
  // string literal as a call, then read hundreds of source characters as a
  // "key". These lines reproduce the shape.
  const source = [
    "if (!text.includes('process.env') && !text.includes('getEnv(')) continue;",
    'const found = source.indexOf("requireEnv(");',
    'void found;',
    // A documentation string that names a key-shaped read must not be counted.
    "const doc = \"process.env['FAKE_KEY']\";",
  ].join('\n');
  const keys = extractCodeEnvKeys(source);
  assert.ok(!keys.includes('FAKE_KEY'), `a key named inside a string literal must not be reported: ${JSON.stringify(keys)}`);
  assert.ok(!keys.some((key) => key.includes('\n')), `no key may be source text: ${JSON.stringify(keys)}`);
});

test('extractCodeEnvKeys covers optional chaining, template keys and helper arguments', () => {
  const source = [
    'const a = process.env?.OPTIONAL_CHAIN;',
    'const b = process.env[`TEMPLATE_KEY`];',
    'const c = env[`${provider}_MODEL`];',
    'const d = readIntEnv(env, "BUDGET_CHARS", 10, 1);',
    'const e = envPositiveInt("BREAKER_THRESHOLD", 3);',
    'const env = process.env;',
    'const f = env.AICODE_PROVIDER;',
    'const g = keys.map((k) => process.env[k]);',
  ].join('\n');
  const reads = extractCodeEnvKeysDetailed(source);
  for (const key of ['OPTIONAL_CHAIN', 'TEMPLATE_KEY', 'BUDGET_CHARS', 'BREAKER_THRESHOLD', 'AICODE_PROVIDER']) {
    assert.ok(reads.keys.includes(key), `missing ${key} in ${JSON.stringify(reads.keys)}`);
  }
  assert.ok(reads.dynamic.some((entry) => entry.includes('_MODEL')), 'template key family should be reported as dynamic');
  assert.ok(reads.dynamic.some((entry) => entry.includes('非字面量下标')), 'variable subscript should be reported as dynamic');
  assert.deepEqual(reads.keys.filter((key) => key.includes('\n')), [], 'no key may contain source text');
});

test('blankOutCommentsAndStrings preserves offsets and newlines', () => {
  const source = 'a // comment\nb "str"\n/* block */c';
  const blanked = blankOutCommentsAndStrings(source);
  assert.equal(blanked.length, source.length);
  assert.equal(blanked.split('\n').length, source.split('\n').length);
  assert.doesNotMatch(blanked, /comment|str|block/);
  assert.equal(blanked[0], 'a');
});

test('env contract reports read sites and never a secret value', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { checkEnvContract } = await import('../src/config/envContract.js');
  const root = await mkdtemp(join(tmpdir(), 'aicode-env-contract-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'src', 'app.ts'),
      'const token = process.env.SECRET_TOKEN;\nconst other = process.env["OTHER_KEY"];\n',
    );
    await writeFile(join(root, '.env'), 'SECRET_TOKEN=do-not-report-me\n');
    const report = await checkEnvContract(root);
    assert.ok(report.codeKeys.includes('SECRET_TOKEN'));
    assert.ok(report.codeKeys.includes('OTHER_KEY'));
    const undocumented = report.issues.find((issue) => issue.kind === 'undocumented' && issue.key === 'SECRET_TOKEN');
    assert.deepEqual(undocumented?.sources, ['src/app.ts']);
    assert.ok(!JSON.stringify(report).includes('do-not-report-me'), 'values from .env must never be reported');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
