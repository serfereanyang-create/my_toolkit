import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenLock, compareSemver, semverBump, diffLockfiles } from '../src/prreview/lockfileDiff.js';

const LOCK_V3_BEFORE = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'app' },
    'node_modules/alpha': { version: '1.0.0' },
    'node_modules/beta': { version: '2.1.0' },
    'node_modules/gamma': { version: '0.9.0' },
    'node_modules/alpha/node_modules/shared': { version: '1.0.0' },
  },
});

const LOCK_V3_AFTER = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'app' },
    'node_modules/alpha': { version: '2.0.0' },
    'node_modules/beta': { version: '2.1.0' },
    'node_modules/delta': { version: '0.1.0' },
    'node_modules/other/node_modules/shared': { version: '1.2.0' },
  },
});

test('flattenLock reads v2/v3 packages map and dedupes nested names', () => {
  const flat = flattenLock(LOCK_V3_BEFORE);
  assert.ok(!(flat instanceof Map) === false);
  assert.equal((flat as Map<string, string>).get('alpha'), '1.0.0');
  assert.equal((flat as Map<string, string>).get('shared'), '1.0.0');
  assert.equal((flat as Map<string, string>).has(''), false);
});

test('flattenLock reads v1 recursive dependencies', () => {
  const v1 = JSON.stringify({
    lockfileVersion: 1,
    dependencies: {
      top: { version: '1.0.0', dependencies: { inner: { version: '0.5.0' } } },
      solo: { version: '3.0.0' },
    },
  });
  const flat = flattenLock(v1);
  assert.ok(flat instanceof Map);
  assert.equal((flat as Map<string, string>).get('top'), '1.0.0');
  assert.equal((flat as Map<string, string>).get('inner'), '0.5.0');
});

test('flattenLock reports errors honestly', () => {
  assert.ok('error' in flattenLock('not json'));
  assert.ok('error' in flattenLock('{"lockfileVersion": 9}'));
});

test('compareSemver and semverBump', () => {
  assert.ok(compareSemver('2.0.0', '1.9.9') > 0);
  assert.ok(compareSemver('1.0.1', '1.0.2') < 0);
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(semverBump('1.2.3', '2.0.0'), 'major');
  assert.equal(semverBump('1.2.3', '1.3.0'), 'minor');
  assert.equal(semverBump('1.2.3', '1.2.4'), 'patch');
});

test('diffLockfiles classifies added/removed/changed with direction', () => {
  const report = diffLockfiles(LOCK_V3_BEFORE, LOCK_V3_AFTER);
  assert.equal(report.ok, true);
  assert.deepEqual(report.added.map((c) => c.name), ['delta']);
  assert.deepEqual(report.removed.map((c) => c.name), ['gamma']);
  const alpha = report.changed.find((c) => c.name === 'alpha')!;
  assert.equal(alpha.from, '1.0.0');
  assert.equal(alpha.to, '2.0.0');
  assert.equal(alpha.direction, 'upgrade');
  const hint = report.semverHints.find((h) => h.name === 'alpha')!;
  assert.equal(hint.bump, 'major');
  // shared 1.0.0 → 1.2.0 是 minor
  const shared = report.semverHints.find((h) => h.name === 'shared')!;
  assert.equal(shared.bump, 'minor');
  // beta 未变
  assert.equal(report.changed.find((c) => c.name === 'beta'), undefined);
  assert.equal(report.total, 4);
});

test('diffLockfiles surfaces parse errors', () => {
  const bad = diffLockfiles('garbage', LOCK_V3_AFTER);
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /before/);
});
