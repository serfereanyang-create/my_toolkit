/**
 * conflictTools.ts - Conflict prediction tool registration.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '../tools/types.js';
import { analyzeTwoDiffs } from './conflictPredict.js';

const execFileAsync = promisify(execFile);

async function loadDiff(workspaceRoot: string, base: string, head: string): Promise<string> {
  const args = ['diff', `${base}...${head}`, '--'];
  const { stdout } = await execFileAsync('git', args, {
    cwd: workspaceRoot,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

export const predictConflictsTool: ToolDefinition<{
  baseA: string;
  headA: string;
  baseB: string;
  headB: string;
}> = {
  name: 'predict_merge_conflicts',
  description: '对比两个分支的 diff，预判合并冲突热点（both-modified / mod-vs-del / rename 冲突 / overlapping ranges）',
  inputHint: '{ "baseA": "main", "headA": "feature-x", "baseB": "main", "headB": "feature-y" }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    for (const k of ['baseA', 'headA', 'baseB', 'headB']) {
      if (typeof r[k] !== 'string' || !(r[k] as string).trim()) {
        throw new Error(`missing required string field: ${k}`);
      }
    }
    return {
      baseA: (r.baseA as string).trim(),
      headA: (r.headA as string).trim(),
      baseB: (r.baseB as string).trim(),
      headB: (r.headB as string).trim(),
    };
  },

  async execute(input, context) {
    let diffA = '';
    let diffB = '';
    try {
      diffA = await loadDiff(context.workspaceRoot, input.baseA, input.headA);
      diffB = await loadDiff(context.workspaceRoot, input.baseB, input.headB);
    } catch (err) {
      return {
        ok: false,
        output: `读取 git diff 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const report = analyzeTwoDiffs(diffA, diffB);

    const lines: string[] = [
      `## 合并冲突预判（风险评分 ${report.riskScore}/100）`,
      '',
      `- 分支 A 变更文件：${report.filesA}`,
      `- 分支 B 变更文件：${report.filesB}`,
      `- 同路径文件重叠：${report.sharedFiles}`,
      '',
    ];
    if (report.hotspots.length === 0) {
      lines.push('没有检测到冲突热点。');
    } else {
      lines.push('### 热点清单');
      for (const h of report.hotspots.slice(0, 30)) {
        const a = h.sideA ? ` [A:${h.sideA.start}-${h.sideA.end}]` : '';
        const b = h.sideB ? ` [B:${h.sideB.start}-${h.sideB.end}]` : '';
        lines.push(`- [${h.reason}] ${h.file}${a}${b}`);
      }
    }
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const conflictTools = [predictConflictsTool];
