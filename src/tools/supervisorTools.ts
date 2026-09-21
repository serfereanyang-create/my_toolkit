import type { AgentRuntime } from '../agent/agent.js';
import { supervisorFor } from '../agent/agent.js';
import { openBoardPr, prepareBoardPr } from '../git-safety/pullRequest.js';
import { TaskBoardStore } from '../tasks/store.js';
import type { ToolDefinition, ToolResult } from '../tools/index.js';

/**
 * `supervisor_status` — read the aggregate progress of every unit of work in
 * this session.
 *
 * The model cannot see the supervisor otherwise: it is an aggregation of events
 * the agent loop emits about itself, so without a tool the model has no way to
 * answer "what is still running" or to notice that a delegated run stalled.
 */
export function createSupervisorStatusTool(runtime: AgentRuntime): ToolDefinition {
  return {
    name: 'supervisor_status',
    description: [
      '查看当前会话里所有工作单元的进度：子智能体、任务板任务、本轮对话。',
      '',
      '返回每个单元的：类型、目标、状态（running/done/failed/cancelled）、',
      '已用步数、已运行时长、所属会话 id、失败原因。',
      '',
      '用途：派发子智能体后确认它们是否还在跑、是否卡住、有没有失败；',
      '长任务中途确认整体进展，而不是凭印象猜。',
      '注意：这个工具只报告状态，不会去干预任何正在运行的单元。',
    ].join('\n'),
    inputHint: '{}',
    risk: 'read',
    validate(input) {
      return (input ?? {}) as Record<string, unknown>;
    },
    async execute(): Promise<ToolResult> {
      const snapshot = supervisorFor(runtime).snapshot();
      if (snapshot.units.length === 0) {
        return { ok: true, output: '当前会话还没有任何受监控的工作单元。', data: snapshot };
      }

      const now = Date.now();
      const rows = snapshot.units.map((unit) => {
        const elapsed = Math.round(((unit.finishedAt ?? now) - unit.startedAt) / 1000);
        const segment = unit.segment && unit.segment > 1 ? ` 第${unit.segment}段` : '';
        const error = unit.error ? ` 错误：${unit.error.slice(0, 120)}` : '';
        return `- [${unit.kind}] ${unit.id}${segment} — ${unit.status}，${unit.steps} 步，${elapsed}s\n  ${unit.label.slice(0, 160)}${error}`;
      });

      const longest = snapshot.longestRunningMs
        ? `\n最久的运行中单元已跑 ${Math.round(snapshot.longestRunningMs / 1000)}s。`
        : '';
      return {
        ok: true,
        output: [
          `工作单元 ${snapshot.units.length} 个：运行中 ${snapshot.running}，完成 ${snapshot.done}，失败 ${snapshot.failed}，累计 ${snapshot.steps} 步。${longest}`,
          '',
          ...rows,
        ].join('\n'),
        data: snapshot,
      };
    },
  };
}

/**
 * `open_pull_request` — prepare and open a PR for the current task board.
 *
 * Preparation is entirely local; opening needs a remote and `gh`. Both halves
 * report a specific blocker rather than a generic failure, because the usual
 * causes (no remote, no `gh`, not logged in) each need a different fix from the
 * user.
 */
export function createOpenPullRequestTool(runtime: AgentRuntime): ToolDefinition {
  return {
    name: 'open_pull_request',
    description: [
      '为当前任务板的工作创建 Pull Request。',
      '',
      '先用 prepare（默认）检查能否创建：会读取当前分支、统计相对基线的提交数、',
      '并生成 PR 标题与正文。prepare 不产生任何副作用。',
      '',
      '确认可以创建后再用 action="create" 真正提交。',
      '常见阻塞会明确返回：仓库没有 remote、未安装 gh、gh 未登录、分支上没有新提交。',
      '这些都需要用户处理，不要反复重试。',
    ].join('\n'),
    inputHint: JSON.stringify({ action: 'prepare', base: 'main', draft: false }, null, 2),
    risk: 'network',
    validate(input) {
      const record = (input ?? {}) as Record<string, unknown>;
      const action = record.action === 'create' ? 'create' : 'prepare';
      return {
        action,
        base: typeof record.base === 'string' && record.base.trim() ? record.base.trim() : undefined,
        draft: record.draft === true,
      };
    },
    async execute(input: { action: 'prepare' | 'create'; base?: string; draft?: boolean }): Promise<ToolResult> {
      if (!runtime.gitProcess) {
        return { ok: false, output: '当前会话没有 git 能力，无法创建 PR。' };
      }
      const boardId = runtime.session.taskRuntime?.boardId;
      if (!boardId) {
        return { ok: false, output: '当前会话没有关联的任务板，无法创建 PR。先用 propose_plan 建立计划并执行。' };
      }

      const store = new TaskBoardStore(runtime.config.workspaceRoot);
      let board;
      try {
        board = await store.load(boardId);
      } catch {
        return { ok: false, output: `读取任务板失败：${boardId}` };
      }

      const snapshot = supervisorFor(runtime).snapshot();
      const prepared = await prepareBoardPr({
        git: runtime.gitProcess,
        board,
        base: input.base,
        snapshot,
      });

      if (!prepared.ok) {
        return {
          ok: false,
          output: [
            `暂时无法创建 PR：${prepared.detail ?? '未知原因'}`,
            prepared.branch ? `当前分支：${prepared.branch}` : undefined,
          ].filter(Boolean).join('\n'),
          data: prepared,
        };
      }

      if (input.action === 'prepare') {
        return {
          ok: true,
          output: [
            `可以创建 PR：分支 ${prepared.branch} → ${prepared.base}，共 ${prepared.commitCount} 个提交。`,
            '',
            `标题：${prepared.title}`,
            '',
            '正文预览：',
            prepared.body,
            '',
            '确认后用 action="create" 创建。',
          ].join('\n'),
          data: prepared,
        };
      }

      const opened = await openBoardPr({ git: runtime.gitProcess, prepared, draft: input.draft });
      if (!opened.ok) {
        return {
          ok: false,
          output: `创建 PR 失败：${opened.detail ?? '未知原因'}`,
          data: opened,
        };
      }
      return {
        ok: true,
        output: `PR 已创建：${opened.url ?? '(无 URL)'}`,
        data: opened,
      };
    },
  };
}
