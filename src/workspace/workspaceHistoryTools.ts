/**
 * workspaceHistoryTools.ts - workspace_run 历史查询与逐次 diff
 */

import type { ToolDefinition } from '../tools/types.js';
import { readHistory, diffRuns } from './runHistory.js';

export const workspaceRunHistoryTool: ToolDefinition<{
  limit: number;
  script?: string;
}> = {
  name: 'workspace_run_history',
  description: '列出最近的 workspace_run 执行历史（按 script 过滤）',
  inputHint: '{ "limit": 10, "script": "test" }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    return {
      limit: typeof r.limit === 'number' && r.limit > 0 ? Math.floor(r.limit) : 10,
      script: typeof r.script === 'string' && r.script.trim() ? r.script.trim() : undefined,
    };
  },

  async execute(input, context) {
    const all = await readHistory(context.workspaceRoot);
    let filtered = all;
    if (input.script) filtered = all.filter((r) => r.request.script === input.script);
    const latest = filtered.slice(-input.limit).reverse();

    if (latest.length === 0) {
      return { ok: true, output: '尚无 workspace_run 历史。' };
    }

    const lines: string[] = [
      `## 最近 ${latest.length} 次 workspace_run`,
      '',
    ];
    for (const r of latest) {
      const when = r.recordedAt.slice(0, 19).replace('T', ' ');
      const summary = `ok=${r.summary.ok} fail=${r.summary.failed} skip=${r.summary.skipped} (${(r.summary.totalDurationMs / 1000).toFixed(1)}s)`;
      const cmd = `${r.request.script}${r.request.filter ? ` [${r.request.filter}]` : ''}`;
      lines.push(`- [${when}] \`${cmd}\` — ${summary}`);
    }
    return { ok: true, output: lines.join('\n'), data: { count: latest.length } };
  },
};

export const workspaceRunDiffTool: ToolDefinition<{
  script: string;
}> = {
  name: 'workspace_run_diff',
  description: '对比同一 script 最近两次 workspace_run 的结果（regression/recovered/fluctuation）',
  inputHint: '{ "script": "test" }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    if (typeof r.script !== 'string' || !r.script.trim()) throw new Error('missing string: script');
    return { script: r.script.trim() };
  },

  async execute(input, context) {
    const all = await readHistory(context.workspaceRoot);
    const sameScript = all.filter((r) => r.request.script === input.script);
    if (sameScript.length === 0) {
      return { ok: true, output: `没有 script=${input.script} 的运行历史。` };
    }
    const latest = sameScript[sameScript.length - 1]!;
    const prev = sameScript.length >= 2 ? sameScript[sameScript.length - 2]! : null;
    const diff = diffRuns(latest, prev);

    const lines: string[] = [`## workspace_run 对比 — \`${input.script}\``, ''];
    if (!diff.prev) {
      lines.push('首次运行，无可比对象。');
    } else {
      lines.push(
        `- 前次: ok=${diff.prevSummary!.ok} fail=${diff.prevSummary!.failed} skip=${diff.prevSummary!.skipped}  ${(diff.prevSummary!.durationMs / 1000).toFixed(1)}s`,
        `- 本次: ok=${diff.latestSummary!.ok} fail=${diff.latestSummary!.failed} skip=${diff.latestSummary!.skipped}  ${(diff.latestSummary!.durationMs / 1000).toFixed(1)}s`,
        `- duration 变化: ${(diff.durationDeltaMs / 1000).toFixed(1)}s`,
      );
      if (diff.regression.length > 0) {
        lines.push('', `### 新失败（${diff.regression.length}）`);
        for (const name of diff.regression) lines.push(`- ${name}`);
      }
      if (diff.recovered.length > 0) {
        lines.push('', `### 修复（${diff.recovered.length}）`);
        for (const name of diff.recovered) lines.push(`- ${name}`);
      }
      if (diff.fluctuations.length > 0) {
        lines.push('', `### 状态不稳（${diff.fluctuations.length}）`);
        for (const name of diff.fluctuations) lines.push(`- ${name}`);
      }
    }
    return { ok: true, output: lines.join('\n'), data: diff };
  },
};

export const workspaceHistoryTools = [workspaceRunHistoryTool, workspaceRunDiffTool];
