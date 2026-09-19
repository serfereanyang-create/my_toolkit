import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectImportSpecifiers, specifierToPackageName } from '../src/workspace/packageDeps.js';

test('collectImportSpecifiers picks named/namespace/require/export-from', () => {
  const src = `
import x from 'alpha';
import { y } from '@scope/beta';
export * from './local';
const z = require('gamma');
`;
  const specs = collectImportSpecifiers(src);
  assert.ok(specs.includes('alpha'));
  assert.ok(specs.includes('@scope/beta'));
  assert.ok(specs.includes('./local'));
  assert.ok(specs.includes('gamma'));
});

test('specifierToPackageName', () => {
  assert.equal(specifierToPackageName('lodash'), 'lodash');
  assert.equal(specifierToPackageName('lodash/debounce'), 'lodash');
  assert.equal(specifierToPackageName('@scope/pkg/sub/path'), '@scope/pkg');
  assert.equal(specifierToPackageName('./relative'), null);
  assert.equal(specifierToPackageName('/abs/path'), null);
  assert.equal(specifierToPackageName(''), null);
});
