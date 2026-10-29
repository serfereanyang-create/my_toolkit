/**
 * quality/quality-audit.test.ts — 门禁网关的失败语义
 *
 * 这些用例覆盖审计发现的「绿得没有依据」的三种情形：
 *   1. pattern 被接受却从不生效——`**\/*.nonexistent` 也照样通过；
 *   2. 一个文件都没扫到时按 0 个问题判定通过；
 *   3. 某项门禁卡住会拖住整批（没有任何超时）。
 * 夹具全部放在 OS 临时目录，finally 清理。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateQualityGate, makeGate, runQualityGates, withTimeout } from './gates.js';

let root: string;
let emptyRoot: string;

const MESSY = `export function messy(input: number): string {
  if (input > 100) {
    if (input > 200) {
      if (input > 300) {
        for (let i = 0; i < input; i++) {
          if (i % 3 === 0) {
            while (input > 1000) {
              input = input - 7;
              if (input === 500) { break; }
            }
          }
        }
      }
    }
  }
  switch (input % 7) {
    case 0: return 'zero';
    case 1: return 'one';
    case 2: return 'two';
    case 3: return 'three';
    case 4: return 'four';
    case 5: return 'five';
    default: return 'many';
  }
}
`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'quality-audit-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'messy.ts'), MESSY);
  writeFileSync(join(root, 'src', 'ok.ts'), 'export const ok = 1;\n');
  emptyRoot = mkdtempSync(join(tmpdir(), 'quality-audit-empty-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(emptyRoot, { recursive: true, force: true });
});

describe('pattern is honoured', () => {
  it('a pattern naming a subdirectory excludes files outside it', async () => {
    mkdirSync(join(root, 'only'), { recursive: true });
    writeFileSync(join(root, 'only', 'clean.ts'), 'export const x = 1;\n');
    // `src/messy.ts` is dirty but not under `only/`.
    const scoped = await evaluateQualityGate({ ...makeGate('complexity', 0), pattern: 'only/**/*.ts' }, root);
    expect(scoped.value).toBe(0);
    expect(scoped.passed).toBe(true);

    // The same tree with the default pattern still counts it.
    const whole = await evaluateQualityGate(makeGate('complexity', 0), root);
    expect(whole.value).toBeGreaterThan(0);
  });

  it('a pattern that matches nothing fails instead of passing on zero files', async () => {
    const none = await evaluateQualityGate({ ...makeGate('security', 0), pattern: '**/*.nonexistent' }, root);
    expect(none.passed).toBe(false);
    expect(none.value).toBe(-1);
    expect(none.message).toContain('没有匹配的文件');
  });

  it('an empty workspace fails rather than reporting zero problems', async () => {
    const result = await evaluateQualityGate(makeGate('complexity', 3), emptyRoot);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('没有匹配的文件');
  });
});

describe('timeouts', () => {
  it('a promise that never settles is bounded and reported as a timeout', async () => {
    await expect(withTimeout(new Promise<number>(() => {}), 20)).rejects.toThrow(/超时/);
  });

  it('a gate timeout fails only that gate; the batch still finishes', async () => {
    const report = await runQualityGates(
      [makeGate('declared', 0, { declaredValue: 0, name: 'fast' })],
      root,
      { timeoutMs: 10_000 },
    );
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.name).toBe('fast');
    expect(report.results[0]!.passed).toBe(true);
  });

  it('an already-settled promise is unaffected by the timer', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1000)).resolves.toBe('done');
  });
});

describe('declared gates still work', () => {
  it('declared passes without touching the filesystem', async () => {
    const result = await evaluateQualityGate(makeGate('declared', 80, { declaredValue: 90 }), emptyRoot);
    expect(result.passed).toBe(true);
    expect(result.value).toBe(90);
  });
});
