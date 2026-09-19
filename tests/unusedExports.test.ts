import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectExports, collectImportedNames } from '../src/prreview/unusedExports.js';

test('collectExports finds all export shapes', () => {
  const src = `
export function foo() {}
export class Bar {}
export interface Baz { x: number }
export type Qux = string;
export const ANSWER = 42;
export { foo as otherFoo };
export default function entry() {}
`;
  const list = collectExports('a.ts', src);
  const names = list.map((s) => s.exportedName).sort();
  assert.ok(names.includes('foo'));
  assert.ok(names.includes('Bar'));
  assert.ok(names.includes('Baz'));
  assert.ok(names.includes('Qux'));
  assert.ok(names.includes('ANSWER'));
  assert.ok(names.includes('otherFoo'));
  assert.ok(names.includes('entry'));
});

test('collectImportedNames finds named, default, and namespace imports', () => {
  const src = `
import def from './mod';
import { a, b as c } from './x';
import * as ns from './y';
`;
  const names = collectImportedNames(src);
  assert.ok(names.has('def'));
  assert.ok(names.has('a'));
  assert.ok(names.has('c'));
  assert.ok(names.has('ns'));
});
