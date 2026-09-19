/**
 * quality/quality.test.ts — 质量门禁测试
 * 夹具项目放在 OS 临时目录，不触碰工作区文件。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateQualityGate, runQualityGates, formatGateReport, makeGate } from './gates.js';
import { GATE_PRESETS, type QualityGateReport } from './types.js';

let cleanRoot: string;
let dirtyRoot: string;

const CLEAN_FILE = `export function add(a: number, b: number): number {
  return a + b;
}
`;

// 高复杂度 + 多分支 + 模拟硬编码密钥的"脏"文件。
// 密钥字面量运行时拼装，避免静态扫描把测试夹具当真实凭据。
const FAKE_KEY_PREFIX = ['sk', 'live'].join('-');
const FAKE_KEY = FAKE_KEY_PREFIX + '-abcdefgh12345678';
const DIRTY_FILE = `const API_KEY = '${FAKE_KEY}';

export function messy(input: number): string {
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
  cleanRoot = mkdtempSync(join(tmpdir(), 'quality-clean-'));
  mkdirSync(join(cleanRoot, 'src'), { recursive: true });
  writeFileSync(join(cleanRoot, 'src', 'clean.ts'), CLEAN_FILE);
  writeFileSync(join(cleanRoot, 'src', 'clean.test.ts'), 'import { add } from "./clean";\n');

  dirtyRoot = mkdtempSync(join(tmpdir(), 'quality-dirty-'));
  mkdirSync(join(dirtyRoot, 'src'), { recursive: true });
  writeFileSync(join(dirtyRoot, 'src', 'messy.ts'), DIRTY_FILE);
});

afterAll(() => {
  rmSync(cleanRoot, { recursive: true, force: true });
  rmSync(dirtyRoot, { recursive: true, force: true });
});

describe('evaluateQualityGate', () => {
  it('declared 门禁按外部声明值直接判定（下限类）', async () => {
    const gate = makeGate('declared', 80, { declaredValue: 85, name: '覆盖率' });
    const result = await evaluateQualityGate(gate, cleanRoot);

    expect(result.passed).toBe(true);
    expect(result.value).toBe(85);
    expect(result.direction).toBe('min');

    const failing = await evaluateQualityGate(makeGate('declared', 90, { declaredValue: 85 }), cleanRoot);
    expect(failing.passed).toBe(false);
  });

  it('declared 门禁缺 declaredValue 时视为 0 并失败', async () => {
    const result = await evaluateQualityGate(makeGate('declared', 50), cleanRoot);
    expect(result.passed).toBe(false);
    expect(result.value).toBe(0);
  });

  it('clean 夹具通过圈复杂度门禁', async () => {
    const result = await evaluateQualityGate(makeGate('complexity', 0), cleanRoot);
    expect(result.passed).toBe(true);
    expect(result.value).toBe(0);
  });

  it('dirty 夹具的圈复杂度门禁给出高值与证据', async () => {
    const result = await evaluateQualityGate(makeGate('complexity', 0), dirtyRoot);
    expect(result.value).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
    expect(result.evidence).toBeDefined();
    expect(result.evidence!.length).toBeGreaterThan(0);
  });

  it('security 门禁在含密钥的夹具上失败并输出证据', async () => {
    const result = await evaluateQualityGate(makeGate('security', 0), dirtyRoot);
    expect(result.passed).toBe(false);
    expect(result.value).toBeGreaterThan(0);
    expect(result.evidence).toBeDefined();
  });

  it('security 门禁在 clean 夹具上通过', async () => {
    const result = await evaluateQualityGate(makeGate('security', 0), cleanRoot);
    expect(result.passed).toBe(true);
  });

  it('test_ratio 门禁按测试/源文件比例判定', async () => {
    // cleanRoot: 1 源文件 + 1 测试文件 = 100%
    const passing = await evaluateQualityGate(makeGate('test_ratio', 50), cleanRoot);
    expect(passing.passed).toBe(true);
    expect(passing.value).toBe(100);

    // dirtyRoot: 1 源文件 0 测试 = 0%
    const failing = await evaluateQualityGate(makeGate('test_ratio', 50), dirtyRoot);
    expect(failing.passed).toBe(false);
  });

  it('工作区根目录不存在时门禁按失败处理且不抛出', async () => {
    const gate = makeGate('complexity', 0);
    const result = await evaluateQualityGate(gate, join(tmpdir(), 'quality-no-such-root-xyz'));
    expect(result.passed).toBe(false);
    expect(result.value).toBe(-1);
    expect(result.message).toContain('门禁执行失败');
  });
});

describe('runQualityGates', () => {
  it('全部通过时报告 passed=true blocked=false', async () => {
    const report = await runQualityGates(
      [
        makeGate('declared', 60, { declaredValue: 70 }),
        makeGate('security', 5),
      ],
      cleanRoot
    );

    expect(report.passed).toBe(true);
    expect(report.blocked).toBe(false);
    expect(report.summary.total).toBe(2);
    expect(report.summary.passed).toBe(2);
    expect(report.summary.blockingFailures).toBe(0);
  });

  it('阻断门禁失败时 blocked=true', async () => {
    const report = await runQualityGates(
      [
        makeGate('security', 0, { blocking: true }),
        makeGate('declared', 90, { declaredValue: 10, blocking: false }),
      ],
      dirtyRoot
    );

    expect(report.passed).toBe(false);
    expect(report.blocked).toBe(true);
    expect(report.summary.blockingFailures).toBe(1);
    expect(report.summary.failed).toBe(2);
  });

  it('非阻断失败只告警不阻断', async () => {
    const report = await runQualityGates(
      [makeGate('declared', 90, { declaredValue: 10, blocking: false })],
      cleanRoot
    );

    expect(report.passed).toBe(false);
    expect(report.blocked).toBe(false);
    expect(report.summary.blockingFailures).toBe(0);
  });

  it('预置套件可直接运行（relaxed 在 clean 夹具不阻断）', async () => {
    const report = await runQualityGates(GATE_PRESETS.relaxed, cleanRoot);
    expect(report.results.length).toBe(5);
    expect(report.blocked).toBe(false);
  });
});

describe('formatGateReport', () => {
  it('渲染通过/失败/证据与摘要行', async () => {
    const report = await runQualityGates(
      [makeGate('security', 0), makeGate('declared', 50, { declaredValue: 60, blocking: false })],
      cleanRoot
    );
    const text = formatGateReport(report);

    expect(text).toContain('质量门禁');
    expect(text).toContain('通过');
    expect(text).toContain('2/2');
  });

  it('阻断报告含 ⛔ 标记与证据行', async () => {
    const report: QualityGateReport = await runQualityGates([makeGate('security', 0)], dirtyRoot);
    const text = formatGateReport(report);

    expect(text).toContain('⛔');
  });
});

describe('makeGate', () => {
  it('security/complexity 默认阻断，其余默认告警', () => {
    expect(makeGate('security', 0).blocking).toBe(true);
    expect(makeGate('complexity', 0).blocking).toBe(true);
    expect(makeGate('smells', 0).blocking).toBe(false);
    expect(makeGate('test_ratio', 30).blocking).toBe(false);
    expect(makeGate('quality', 60).blocking).toBe(false);
  });

  it('显式 blocking 覆盖默认值', () => {
    expect(makeGate('smells', 0, { blocking: true }).blocking).toBe(true);
    expect(makeGate('security', 0, { blocking: false }).blocking).toBe(false);
  });
});
