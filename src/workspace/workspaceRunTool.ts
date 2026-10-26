/**
 * workspaceRunTool.ts - `workspace_run` 命令工具：按拓扑顺序跨包执行 script。
 *
 * 支持 dry-run（只生成计划，不执行）与真实执行（默认 4 并发）。
 */

import type { ToolDefinition } from '../tools/types.js';
import { discoverWorkspace } from './discover.js';
import { applyFilter } from './applyFilter.js';
import { collectScriptsByDir } from './collectScripts.js';
import { planRun, runAcross, detectPackageManager } from './runner.js';

export const workspaceRunTool: ToolDefinition<{
  script: string;
  filter?: string;
  dryRun?: boolean;
  concurrency: number;
  continueOnError: boolean;
  timeoutSec: number;
  showPlan: boolean;
}> = {
  name: 'workspace_run',
  description: '按依赖拓扑在选中的 workspace 包里执行 npm/yarn/pnpm/bun run <script>（支持 pnpm 风格 filter）',
  inputHint: '{ "script": "test", "filter": "...@scope/core", "dryRun": true }',
  risk: 'write',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    if (typeof r.script !== 'string' || !r.script.trim()) {
      throw new Error('missing required string: script');
    }
    return {
      script: r.script.trim(),
      filter: typeof r.filter === 'string' ? r.filter : undefined,
      dryRun: r.dryRun === true,
      concurrency: typeof r.concurrency === 'number' && r.concurrency > 0 ? Math.floor(r.concurrency) : 4,
      continueOnError: r.continueOnError === true,
      timeoutSec: typeof r.timeoutSec === 'number' && r.timeoutSec > 0 ? Math.floor(r.timeoutSec) : 120,
      showPlan: r.showPlan !== false,
    };
  },

  async execute(input, context) {
    const discovery = await discoverWorkspace(context.workspaceRoot);
    if (discovery.packages.length === 0) {
      return { ok: false, output: '未发现 workspace 包，无法执行。' };
    }

    const selected = input.filter
      ? applyFilter(discovery.packages, input.filter).matched
      : discovery.packages;

    if (selected.length === 0) {
      return { ok: true, output: `filter 未命中任何包（input.filter=${input.filter ?? '(none)'}）` };
    }

    const { byDir: scriptsByDir, scriptCoverage } = await collectScriptsByDir(selected, context.workspaceRoot);
    const plan = planRun(selected, input.script, scriptsByDir);

    const lines: string[] = [
      `## Workspace Run（script=\`${input.script}\`）`,
      '',
      `- 包数：${selected.length}`,
      `- 拓扑顺序：${plan.queue.length} 步`,
      `- 有脚本可用：${plan.queue.filter((s) => s.scriptAvailable).length}/${selected.length}`,
      `- 跳过（缺 script）：${plan.queue.length - plan.queue.filter((s) => s.scriptAvailable).length}`,
      `- 循环包（skipping）：${plan.cycleSkipped.length}`,
    ];

    if (input.showPlan) {
      lines.push('', '### 执行计划');
      for (const step of plan.queue.slice(0, 20)) {
        lines.push(
          `${step.order + 1}. ${step.package.name} @ ${step.package.dir} — ${step.scriptAvailable ? '✓ runnable' : '✗ no script'}`,
        );
      }
      if (plan.queue.length > 20) {
        lines.push(`  ...（再省略 ${plan.queue.length - 20} 个）`);
      }
    }

    if (input.dryRun) {
      // 只列计划
      const coverage = [...scriptCoverage.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
      if (coverage.length > 0) {
        lines.push('', '### 本 workspace 中常见其他 script（按覆盖率）');
        for (const [name, count] of coverage) {
          lines.push(`- \`${name}\` — ${count} 个包声明`);
        }
      }
      return { ok: true, output: lines.join('\n'), data: { plan, mode: 'dry-run' } };
    }

    const pm = await detectPackageManager(context.workspaceRoot);
    lines.push('', `### 以 ${pm} 执行`);
    const summary = await runAcross(pm, plan, context.workspaceRoot, {
      concurrency: input.concurrency,
      continueOnError: input.continueOnError,
      timeoutMs: input.timeoutSec * 1000,
    });

    lines.push(
      `- 成功：${summary.ok}`,
      `- 失败：${summary.failed}`,
      `- 跳过：${summary.skipped}`,
      `- 总耗时：${(summary.totalDurationMs / 1000).toFixed(1)}s`,
    );

    const failures = summary.artifacts.filter((a) => a.exitCode !== 0 && !a.skipped);
    if (failures.length > 0) {
      lines.push('', '### 失败明细');
      for (const f of failures.slice(0, 10)) {
        lines.push(`- **${f.pkg}** exit=${f.exitCode}`);
        const tail = (f.stderr || f.stdout).split('\n').slice(-6).join('\n');
        lines.push('```');
        lines.push(tail);
        lines.push('```');
      }
    }

    return {
      ok: failures.length === 0,
      output: lines.join('\n'),
      data: { plan, summary },
    };
  },
};

export const workspaceRunTools = [workspaceRunTool];
