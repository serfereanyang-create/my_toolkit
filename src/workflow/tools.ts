/**
 * workflow/tools.ts — 工作流引擎工具注册（CLI 工具）
 *
 * workflow_create / workflow_list_templates / workflow_analyze_impact /
 * workflow_performance_report 为定义与观测工具；workflow_execute /
 * workflow_resume / workflow_list 是真实的执行、恢复与列表入口：
 * 节点通过 agent 注入的 subAgentRunner 跑真实 agent turn，执行进度
 * 持久化到 .aicode/workflows/executions，崩溃/暂停后可恢复续跑。
 */

import { join } from 'node:path';
import { defineTool } from '../tools/define.js';
import type { ToolResult } from '../tools/types.js';
import { WorkflowBuilder } from './builder.js';
import { WorkflowEngine } from './engine.js';
import { WorkflowStore } from './store.js';
import { WORKFLOW_TEMPLATES } from './types.js';
import type { WorkflowDefinition, WorkflowExecution } from './types.js';
import { analyzeProjectImpact } from './incremental.js';
import { WorkflowPerformanceAnalyzer } from './performance.js';
import { measureGate } from './gates.js';

function storeFor(workspaceRoot: string): WorkflowStore {
  return new WorkflowStore(join(workspaceRoot, '.aicode', 'workflows'));
}

/** 工作流执行需要 checkpoint/git 能力时的诚实拒绝（工具上下文没有 git 安全栈）。 */
function checkpointUnsupported(workflow: WorkflowDefinition): string | null {
  const hasCheckpointNode = workflow.nodes.some((node) => node.type === 'checkpoint');
  if (workflow.autoCheckpoint || hasCheckpointNode) {
    return 'This workflow requires git checkpoints (autoCheckpoint or checkpoint nodes), ' +
      'which are only available through the interactive runtime integration. ' +
      'Create the workflow without autoCheckpoint/checkpoint nodes to execute it from a tool.';
  }
  return null;
}

function buildEngineOptions(
  workspaceRoot: string,
  store: WorkflowStore,
  raw: import('../tools/types.js').ToolContext,
  getEngine: () => WorkflowEngine | null,
): import('./engine.js').WorkflowEngineOptions {
  const saveProgress = () => {
    const current = getEngine();
    if (current) store.saveExecution(current.getExecution());
  };
  return {
    onNodeStart: () => saveProgress(),
    onNodeComplete: () => saveProgress(),
    onNodeFailed: () => saveProgress(),
    executeNode: async (node) => {
      if (!raw.subAgentRunner) {
        return {
          success: false,
          summary: `Task ${node.title} cannot execute: no sub-agent runner in this context`,
          errors: ['workflow_execute requires the interactive agent runtime'],
        };
      }
      const parts: string[] = [`Task: ${node.title}`];
      if (node.description) parts.push(`Description: ${node.description}`);
      if (node.prompt) parts.push(`Instructions: ${node.prompt}`);
      if (node.acceptance) parts.push(`Acceptance criteria: ${node.acceptance}`);
      const current = getEngine();
      if (current) {
        const priorOutputs = Object.entries(current.getExecution().context)
          .filter(([, value]) => value && typeof value === 'object' && 'summary' in (value as Record<string, unknown>))
          .map(([key, value]) => `- ${key}: ${(value as { summary: string }).summary}`);
        if (priorOutputs.length > 0) {
          parts.push('Context from previous steps:', ...priorOutputs);
        }
      }
      parts.push('When complete, provide a brief summary of what was done.');
      const answer = await raw.subAgentRunner!(parts.join('\n'));
      return {
        success: true,
        summary: answer.replace(/\s+/g, ' ').slice(0, 500),
        output: { finalAnswer: answer },
      };
    },
    evaluateGate: (gate) => measureGate(gate, workspaceRoot),
  };
}

/**
 * 创建工作流定义（可基于模板或自定义任务列表）
 */
export const createWorkflowTool = defineTool({
  name: 'workflow_create',
  description: '创建工作流定义：支持 feature_development / bugfix / refactor 模板，或自定义任务列表。返回完整的工作流 JSON。',
  risk: 'read',
  input: {
    name: { type: 'string', description: '工作流名称' },
    description: { type: 'string', description: '工作流描述', optional: true },
    template: { type: 'string', description: '模板名：feature_development / bugfix / refactor', optional: true },
    tasks: {
      type: 'array',
      description: '自定义任务列表，每项 {"title": "...", "acceptance": "...", "dependsOn": ["task_1"]}',
      optional: true,
    },
    enableAutoCheckpoint: { type: 'boolean', description: '每个任务成功后自动建检查点', optional: true },
    enableRollbackOnFailure: { type: 'boolean', description: '失败时回滚到最近检查点', optional: true },
    maxParallelTasks: { type: 'number', description: '最大并行任务数', optional: true },
  },
  examples: [
    { input: { name: '登录功能', template: 'feature_development' }, output: '基于特性开发模板创建工作流' },
    {
      input: {
        name: '自定义流程',
        tasks: [
          { title: '分析现有代码', acceptance: '找到相关模块' },
          { title: '实现修改', acceptance: '修改完成', dependsOn: ['task_1'] },
        ],
      },
      output: '创建两步自定义工作流',
    },
  ],

  async execute(input, context): Promise<ToolResult> {
    try {
      let workflow: WorkflowDefinition;

      if (input.template) {
        const templateKey = input.template as keyof typeof WORKFLOW_TEMPLATES;
        if (!WORKFLOW_TEMPLATES[templateKey]) {
          return {
            ok: false,
            output: '未知模板: ' + input.template + '。可用模板: ' + Object.keys(WORKFLOW_TEMPLATES).join(', '),
          };
        }
        const builder = WorkflowBuilder.fromTemplate(templateKey);
        if (input.enableAutoCheckpoint) builder.enableAutoCheckpoint();
        if (input.enableRollbackOnFailure) builder.enableRollbackOnFailure();
        if (typeof input.maxParallelTasks === 'number') builder.setMaxParallelTasks(input.maxParallelTasks);
        workflow = builder.build();
      } else {
        const builder = new WorkflowBuilder(input.name, input.description ?? '');
        const tasks = Array.isArray(input.tasks) ? input.tasks : [];
        if (tasks.length > 0) {
          tasks.forEach((task, index) => {
            builder.addTask(task.title, {
              acceptance: task.acceptance,
              dependsOn: index === 0 ? [] : (task.dependsOn ?? ['task_' + index]),
              maxRetries: task.maxRetries,
            });
          });
        } else {
          builder
            .addTask('分析并规划', { acceptance: '需求与现状明确' })
            .addTask('实现变更', { acceptance: '变更完成并通过验证' })
            .addTask('测试与总结', { acceptance: '测试通过，输出总结' });
        }
        if (input.enableAutoCheckpoint) builder.enableAutoCheckpoint();
        if (input.enableRollbackOnFailure) builder.enableRollbackOnFailure();
        if (typeof input.maxParallelTasks === 'number') builder.setMaxParallelTasks(input.maxParallelTasks);
        workflow = builder.build();
      }

      // 持久化定义，供 workflow_execute / workflow_resume 引用。
      const store = storeFor(context.cwd);
      store.saveWorkflow(workflow);

      const summary = [
        '工作流已创建并保存: ' + workflow.name + ' (' + workflow.id + ')',
        '节点数: ' + workflow.nodes.length,
        '入口: ' + workflow.entryNode,
        '用 workflow_execute 执行: { "workflowId": "' + workflow.id + '" }',
        '',
        ...workflow.nodes.map((n) => '- [' + n.type + '] ' + n.id + ' ' + n.title),
      ].join('\n');

      return { ok: true, output: summary, data: { workflow } };
    } catch (error) {
      return { ok: false, output: '创建工作流失败: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
});

/**
 * 列出可用的工作流模板
 */
export const listWorkflowTemplatesTool = defineTool({
  name: 'workflow_list_templates',
  description: '列出所有预置工作流模板（feature_development / bugfix / refactor）及其节点结构',
  risk: 'read',
  input: {},
  examples: [{ input: {}, output: '返回 3 个模板及各模板节点列表' }],

  async execute(): Promise<ToolResult> {
    const lines: string[] = [];
    for (const [key, template] of Object.entries(WORKFLOW_TEMPLATES)) {
      lines.push('## ' + key + ' — ' + template.name);
      lines.push(template.description);
      for (const node of template.nodes) {
        lines.push('  - [' + node.type + '] ' + node.title);
      }
      lines.push('');
    }
    return { ok: true, output: lines.join('\n'), data: { templates: Object.keys(WORKFLOW_TEMPLATES) } };
  },
});

/**
 * 增量变更影响分析：识别未提交变更的波及范围
 */
export const analyzeImpactTool = defineTool({
  name: 'workflow_analyze_impact',
  description: '增量构建分析：用 git diff 找出未提交变更，基于依赖图计算受影响文件、受影响测试和影响范围建议。大型项目先跑这个再决定测试策略。',
  risk: 'read',
  input: {},
  examples: [{ input: {}, output: '返回受影响文件列表、影响范围（minimal/moderate/extensive/comprehensive）和建议' }],

  async execute(_input, context): Promise<ToolResult> {
    try {
      const result = await analyzeProjectImpact(context.cwd);
      if (!result) {
        return { ok: true, output: '没有未提交的变更，无需增量分析。' };
      }

      const lines = [
        '影响范围: ' + result.impactScope + ' (' + result.estimatedImpact + '/100)',
        '变更文件: ' + result.changedFiles.length,
        '受影响文件: ' + result.affectedFiles.length,
        '受影响测试: ' + result.affectedTests.length,
        '',
        '变更:',
        ...result.changedFiles.map((c) => '  ' + c.type + ' ' + c.path + ' (+' + c.linesAdded + '/-' + c.linesDeleted + ')'),
        '',
        '建议:',
        ...result.recommendations.map((r) => '  - ' + r),
      ];

      return { ok: true, output: lines.join('\n'), data: { result } };
    } catch (error) {
      return { ok: false, output: '影响分析失败: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
});

/**
 * 工作流执行性能报告（基于内存中的执行历史）
 */
export const workflowPerformanceTool = defineTool({
  name: 'workflow_performance_report',
  description: '分析工作流执行历史：找出瓶颈节点、可并行化任务组和优化建议。需先通过 workflow_execute 记录执行数据。',
  risk: 'read',
  input: {},
  examples: [{ input: {}, output: '返回瓶颈、关键路径与优化建议，或"暂无执行历史"' }],

  async execute(): Promise<ToolResult> {
    const analyzer = new WorkflowPerformanceAnalyzer();
    const metrics = analyzer.analyze();

    if (metrics.nodeMetrics.size === 0) {
      return { ok: true, output: '暂无工作流执行历史。执行工作流后再次调用可获取性能报告。' };
    }

    const lines: string[] = ['总耗时: ' + Math.round(metrics.totalDuration / 1000) + 's'];
    if (metrics.bottlenecks.length > 0) {
      lines.push('', '瓶颈:');
      for (const b of metrics.bottlenecks) {
        lines.push('  [' + b.severity + '] ' + b.nodeId + ': ' + b.description);
      }
    }
    if (metrics.recommendations.length > 0) {
      lines.push('', '优化建议:');
      for (const r of metrics.recommendations) {
        lines.push('  [' + r.priority + '] ' + r.description + ' (' + r.estimatedImprovement + ')');
      }
    }

    return { ok: true, output: lines.join('\n'), data: analyzer.exportMetrics() };
  },
});

/**
 * 执行工作流：任务节点通过 sub-agent 真实执行，进度持久化，可恢复。
 */
export const executeWorkflowTool = defineTool({
  name: 'workflow_execute',
  description: '执行一个已保存（或内联传入）的工作流：任务节点由子智能体真实完成，进度写入 .aicode/workflows/executions。',
  risk: 'write',
  input: {
    workflowId: { type: 'string', description: '已保存的工作流 ID（workflow_create 返回）', optional: true },
    name: { type: 'string', description: '内联创建工作流时的名称（与 tasks 搭配，无需预先 workflow_create）', optional: true },
    tasks: { type: 'array', description: '内联任务列表 [{"title":"...","acceptance":"...","dependsOn":["task_1"]}]', optional: true },
  },
  examples: [
    { input: { workflowId: 'wf_1725540000000_ab12cd34' }, output: '执行已保存的工作流并输出每个节点的完成摘要' },
  ],

  async execute(input, context): Promise<ToolResult> {
    try {
      const store = storeFor(context.cwd);
      let workflow: WorkflowDefinition | null = null;

      if (input.workflowId) {
        workflow = store.loadWorkflow(input.workflowId);
        if (!workflow) {
          return { ok: false, output: '未找到工作流: ' + input.workflowId + '。用 workflow_create 创建，或 workflow_list 查看已有工作流。' };
        }
      } else if (input.name && Array.isArray(input.tasks) && input.tasks.length > 0) {
        const builder = new WorkflowBuilder(input.name, '');
        input.tasks.forEach((task, index) => {
          builder.addTask(String(task.title ?? 'Task ' + (index + 1)), {
            acceptance: task.acceptance,
            dependsOn: index === 0 ? [] : (task.dependsOn ?? ['task_' + index]),
          });
        });
        workflow = builder.build();
        store.saveWorkflow(workflow);
      } else {
        return { ok: false, output: '需要 workflowId，或 name + tasks 内联定义。' };
      }

      const unsupported = checkpointUnsupported(workflow);
      if (unsupported) return { ok: false, output: unsupported };
      if (!context.raw.subAgentRunner) {
        return {
          ok: false,
          output: 'workflow_execute requires the interactive agent runtime (no sub-agent runner available in this context).',
        };
      }

      let engine: WorkflowEngine | null = null;
      const options = buildEngineOptions(context.cwd, store, context.raw, () => engine);
      engine = new WorkflowEngine(workflow, options);

      const execution = await engine.run();
      store.saveExecution(execution);

      const lines = [
        '工作流执行结束: ' + execution.status,
        '节点进度: ' + execution.completedNodes.length + '/' + workflow.nodes.length + ' 完成' +
          (execution.skippedNodes?.length ? '，' + execution.skippedNodes.length + ' 跳过' : '') +
          (execution.failedNodes.length ? '，' + execution.failedNodes.length + ' 失败' : ''),
      ];
      for (const node of workflow.nodes) {
        const state = execution.completedNodes.includes(node.id) ? 'done'
          : execution.skippedNodes?.includes(node.id) ? 'skipped'
          : execution.failedNodes.includes(node.id) ? 'failed' : 'not run';
        const summary = node.result?.summary ? ': ' + node.result.summary.slice(0, 160) : '';
        lines.push('  [' + state + '] ' + node.title + summary);
      }
      lines.push('', 'executionId: ' + execution.id + '（失败/中断后可用 workflow_resume 续跑）');
      return { ok: execution.status === 'completed', output: lines.join('\n'), data: { execution } };
    } catch (error) {
      return { ok: false, output: '工作流执行失败: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
});

/**
 * 恢复执行：从持久化状态续跑（崩溃/暂停后的未完成节点）。
 */
export const resumeWorkflowTool = defineTool({
  name: 'workflow_resume',
  description: '恢复一次未完成的工作流执行：已完成节点不重跑，失败与中断节点重试。进度继续持久化。',
  risk: 'write',
  input: {
    executionId: { type: 'string', description: '要恢复的执行 ID（workflow_execute 输出中的 executionId）' },
  },
  examples: [{ input: { executionId: 'exec_1725540000000_ab12cd34' }, output: '从上次进度继续执行' }],

  async execute(input, context): Promise<ToolResult> {
    try {
      if (!context.raw.subAgentRunner) {
        return {
          ok: false,
          output: 'workflow_resume requires the interactive agent runtime (no sub-agent runner available in this context).',
        };
      }
      const store = storeFor(context.cwd);
      const saved = store.loadExecution(input.executionId);
      if (!saved) {
        return { ok: false, output: '未找到执行记录: ' + input.executionId + '。用 workflow_list 查看可恢复的执行。' };
      }
      const workflow = store.loadWorkflow(saved.workflowId);
      if (!workflow) {
        return { ok: false, output: '执行对应的工作流定义缺失: ' + saved.workflowId };
      }
      const unsupported = checkpointUnsupported(workflow);
      if (unsupported) return { ok: false, output: unsupported };

      let engine: WorkflowEngine | null = null;
      const options = buildEngineOptions(context.cwd, store, context.raw, () => engine);
      engine = WorkflowEngine.restore(workflow, saved, options);

      const execution = await engine.resume();
      store.saveExecution(execution);

      const lines = [
        '工作流恢复执行结束: ' + execution.status,
        '节点进度: ' + execution.completedNodes.length + '/' + workflow.nodes.length + ' 完成' +
          (execution.failedNodes.length ? '，' + execution.failedNodes.length + ' 失败' : ''),
        '',
        'executionId: ' + execution.id,
      ];
      return { ok: execution.status === 'completed', output: lines.join('\n'), data: { execution } };
    } catch (error) {
      return { ok: false, output: '工作流恢复失败: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
});

/**
 * 列出工作流与执行状态（含可恢复的执行）。
 */
export const listWorkflowsTool = defineTool({
  name: 'workflow_list',
  description: '列出已保存的工作流、最近执行与可恢复（running/paused）的执行。',
  risk: 'read',
  input: {},
  examples: [{ input: {}, output: '返回工作流列表、执行统计与可恢复执行' }],

  async execute(_input, context): Promise<ToolResult> {
    try {
      const store = storeFor(context.cwd);
      const workflows = store.listWorkflows();
      const active = store.getActiveExecutions();
      const recent = store.getRecentExecutions(5);

      if (workflows.length === 0 && recent.length === 0) {
        return { ok: true, output: '暂无工作流。用 workflow_create 创建。' };
      }

      const lines: string[] = [];
      if (workflows.length > 0) {
        lines.push('工作流 (' + workflows.length + '):');
        for (const workflow of workflows) {
          lines.push('  - ' + workflow.id + ' ' + workflow.name + ' (' + workflow.nodes.length + ' 节点)');
        }
      }
      if (active.length > 0) {
        lines.push('', '可恢复的执行 (' + active.length + '):');
        for (const execution of active) {
          lines.push('  - ' + execution.id + ' [' + execution.status + '] workflow=' + execution.workflowId +
            ' 进度 ' + execution.completedNodes.length + ' 节点');
        }
      }
      if (recent.length > 0) {
        lines.push('', '最近执行:');
        for (const execution of recent) {
          lines.push('  - ' + execution.id + ' [' + execution.status + '] ' + execution.startedAt);
        }
      }
      return { ok: true, output: lines.join('\n'), data: { workflows, active, recent } };
    } catch (error) {
      return { ok: false, output: '列出工作流失败: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
});

export const workflowTools = [
  createWorkflowTool,
  executeWorkflowTool,
  resumeWorkflowTool,
  listWorkflowsTool,
  listWorkflowTemplatesTool,
  analyzeImpactTool,
  workflowPerformanceTool,
];
