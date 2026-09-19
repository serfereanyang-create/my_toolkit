/**
 * workflowResume.test.ts — 工作流执行恢复语义
 *
 * 覆盖：restore 后已完成节点不重跑、失败节点重试、execution.context 保留、
 * 终态 completed 且进度持久化；terminal 状态拒绝恢复。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowEngine } from '../src/workflow/engine.js';
import { WorkflowStore } from '../src/workflow/store.js';
import { WorkflowBuilder } from '../src/workflow/builder.js';
import type { WorkflowDefinition, WorkflowExecution } from '../src/workflow/types.js';

function twoStepWorkflow(): WorkflowDefinition {
  return new WorkflowBuilder('resume-demo', '')
    .addTask('step one')
    .addTask('step two', { dependsOn: ['task_1'] })
    .build();
}

function crashedExecution(workflow: WorkflowDefinition): WorkflowExecution {
  return {
    id: 'exec_test_1',
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    status: 'running',
    currentNodes: [],
    completedNodes: ['task_1'],
    failedNodes: ['task_2'],
    blockedNodes: [],
    skippedNodes: [],
    checkpoints: [],
    rollbacks: [],
    startedAt: new Date().toISOString(),
    context: { task_1: { summary: 'step one output' } },
  };
}

test('restore switches a running execution to paused and clears failed retries', () => {
  const workflow = twoStepWorkflow();
  const engine = WorkflowEngine.restore(workflow, crashedExecution(workflow), {});
  const execution = engine.getExecution();
  assert.equal(execution.status, 'paused');
  assert.equal(execution.failedNodes.length, 0);
  assert.equal(execution.completedNodes.includes('task_1'), true);
  // 已完成节点的输出上下文保留
  assert.equal((execution.context['task_1'] as { summary: string }).summary, 'step one output');
});

test('resume only executes unfinished nodes and completes the workflow', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'wf-resume-test-'));
  try {
    const store = new WorkflowStore(join(ws, '.aicode', 'workflows'));
    const workflow = twoStepWorkflow();
    store.saveWorkflow(workflow);

    const executed: string[] = [];
    let engine: WorkflowEngine | null = WorkflowEngine.restore(workflow, crashedExecution(workflow), {
      executeNode: async (node) => {
        executed.push(node.id);
        return { success: true, summary: `ran ${node.title}`, output: { summary: `ran ${node.title}` } };
      },
    });
    const execution = await engine!.resume();
    store.saveExecution(execution);

    // 已完成的 task_1 不能重跑
    assert.deepEqual(executed, ['task_2']);
    assert.equal(execution.status, 'completed');
    assert.equal(execution.completedNodes.length, 2);

    // 进度持久化可回读
    const persisted = store.loadExecution(execution.id);
    assert.ok(persisted, 'execution must persist');
    assert.equal(persisted.status, 'completed');
    assert.equal(persisted.completedNodes.length, 2);
    engine = null;
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('restore refuses terminal executions and foreign workflows', () => {
  const workflow = twoStepWorkflow();
  const crashed = crashedExecution(workflow);
  assert.throws(
    () => WorkflowEngine.restore(workflow, { ...crashed, status: 'completed' }, {}),
    /cannot be resumed/,
  );
  assert.throws(
    () => WorkflowEngine.restore({ ...workflow, id: 'wf_other' }, crashed, {}),
    /belongs to workflow/,
  );
});

test('a failed node still fails honestly when no executeNode handler exists', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'wf-resume-test-'));
  try {
    const workflow = twoStepWorkflow();
    const engine = WorkflowEngine.restore(workflow, crashedExecution(workflow), {});
    const execution = await engine.resume().then(
      () => engine.getExecution(),
      () => engine.getExecution(),
    );
    // 没有 executeNode：task_2 必须失败，而不是静默成功
    assert.equal(execution.status, 'failed');
    assert.equal(execution.completedNodes.includes('task_1'), true);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
