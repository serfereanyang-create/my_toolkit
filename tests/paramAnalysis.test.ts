import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFunctionSignatures } from '../src/prreview/paramAnalysis.js';

test('analyzeFunctionSignatures picks params, async, export, return type', () => {
  const src = `
export async function fetchData(url: string, retries: number): Promise<void> {}
function localOne() { return 42; }
const arrow = (a: number, b: number, c: number, d: number, e: number) => a+b;
class Svc { run(x: string) { return x; } }
`;
  const list = analyzeFunctionSignatures('m.ts', src);
  assert.equal(list.length, 4);

  const fetchData = list.find((f) => f.name === 'fetchData')!;
  assert.equal(fetchData.paramCount, 2);
  assert.equal(fetchData.isAsync, true);
  assert.equal(fetchData.isExported, true);
  assert.equal(fetchData.hasReturnType, true);

  const localOne = list.find((f) => f.name === 'localOne')!;
  assert.equal(localOne.paramCount, 0);
  assert.equal(localOne.hasReturnType, false);
  assert.equal(localOne.isExported, false);

  const arrow = list.find((f) => f.name === 'arrow')!;
  assert.equal(arrow.paramCount, 5);
  assert.equal(arrow.isAsync, false);

  const run = list.find((f) => f.name === 'run')!;
  assert.equal(run.paramCount, 1);
});
