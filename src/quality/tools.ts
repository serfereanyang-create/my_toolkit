/**
 * quality/tools.ts — 质量门禁 CLI 工具注册
 */

import { defineTool } from '../tools/define.js';
import type { ToolResult } from '../tools/types.js';
import {
  evaluateQualityGate,
  runQualityGates,
  formatGateReport,
  makeGate,
} from './gates.js';
import { GATE_PRESETS, type GatePresetName, type QualityGate } from './types.js';

/** 运行一组门禁（预置套件或自定义列表）。 */
export const qualityGateRunTool = defineTool({
  name: 'quality_gate_run',
  description: '运行代码质量门禁：支持 strict/standard/relaxed 预置套件，或自定义门禁列表。返回每项门禁的通过情况与失败证据。',
  risk: 'read',
  input: {
    preset: { type: 'string', description: '预置套件名：strict / standard / relaxed', optional: true },
    gates: {
      type: 'array',
      description: '自定义门禁列表 [{"type":"complexity","threshold":3,"blocking":true}]，与 preset 二选一',
      optional: true,
    },
  },
  examples: [
    { input: { preset: 'standard' }, output: '运行标准质量门禁套件' },
    { input: { gates: [{ type: 'security', threshold: 0, blocking: true }] }, output: '只跑安全门禁' },
  ],

  async execute(input, context): Promise<ToolResult> {
    let gates: QualityGate[];

    if (Array.isArray(input.gates) && input.gates.length > 0) {
      gates = input.gates.map((g) => makeGate(g.type, g.threshold, g));
    } else {
      const presetName = (input.preset ?? 'standard') as GatePresetName;
      const preset = GATE_PRESETS[presetName];
      if (!preset) {
        return {
          ok: false,
          output: '未知预置套件: ' + input.preset + '。可用: ' + Object.keys(GATE_PRESETS).join(', '),
        };
      }
      gates = preset;
    }

    const report = await runQualityGates(gates, context.cwd);
    return { ok: !report.blocked, output: formatGateReport(report), data: { report } };
  },
});

/** 检查单项门禁。 */
export const qualityGateCheckTool = defineTool({
  name: 'quality_gate_check',
  description: '检查单项质量指标：complexity / smells / security / test_ratio / quality / declared（外部声明值，如真实覆盖率）',
  risk: 'read',
  input: {
    type: { type: 'string', description: '门禁类型' },
    threshold: { type: 'number', description: '阈值（max 类 ≤ 通过；min 类 ≥ 通过）' },
    declaredValue: { type: 'number', description: 'declared 类型必填：外部测得的指标值', optional: true },
    pattern: { type: 'string', description: '文件 glob，默认 **/*.{ts,tsx}', optional: true },
  },
  examples: [
    { input: { type: 'security', threshold: 0 }, output: '安全门禁检查结果' },
    { input: { type: 'declared', threshold: 80, declaredValue: 85 }, output: '覆盖率 85 ≥ 80，通过' },
  ],

  async execute(input, context): Promise<ToolResult> {
    const gate = makeGate(input.type, input.threshold, {
      pattern: input.pattern,
      declaredValue: input.declaredValue,
    });

    const result = await evaluateQualityGate(gate, context.cwd);
    const lines = [
      (result.passed ? '✅' : (gate.blocking ? '⛔' : '⚠️')) + ' ' + result.message,
      '指标值: ' + result.value + '，阈值: ' + result.threshold + '（' + (result.direction === 'max' ? '上限' : '下限') + '）',
      '耗时: ' + result.durationMs + 'ms',
    ];
    if (result.evidence) {
      lines.push('', '证据:');
      for (const line of result.evidence) {
        lines.push('  ' + line);
      }
    }

    return { ok: result.passed, output: lines.join('\n'), data: { result } };
  },
});

/** 列出可用门禁类型与预置套件。 */
export const qualityGateListTool = defineTool({
  name: 'quality_gate_list',
  description: '列出可用门禁类型、阈值方向和预置套件（strict/standard/relaxed）的配置',
  risk: 'read',
  input: {},
  examples: [{ input: {}, output: '返回 6 类门禁说明和 3 套预置配置' }],

  async execute(): Promise<ToolResult> {
    const lines = [
      '门禁类型:',
      '  complexity — 圈复杂度 critical/high 函数数（上限类）',
      '  smells     — critical+major 代码异味数（上限类）',
      '  security   — critical+high 安全问题数（上限类）',
      '  test_ratio — 测试文件占源文件百分比（下限类）',
      '  quality    — 综合质量分 0-100（下限类）',
      '  declared   — 外部声明指标（如真实覆盖率，下限类）',
      '',
    ];

    for (const [name, gates] of Object.entries(GATE_PRESETS)) {
      lines.push('预置套件 ' + name + ':');
      for (const gate of gates) {
        lines.push('  - ' + gate.name + ' (' + gate.type + ' ' + (gate.threshold >= 0 && gate.type !== 'test_ratio' && gate.type !== 'quality' ? '≤ ' : '≥ ') + gate.threshold + (gate.blocking ? '，阻断' : '，告警') + ')');
      }
      lines.push('');
    }

    return { ok: true, output: lines.join('\n') };
  },
});

export const qualityTools = [qualityGateRunTool, qualityGateCheckTool, qualityGateListTool];
