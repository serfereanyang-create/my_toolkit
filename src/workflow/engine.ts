/**
 * Workflow execution engine with branching, parallel execution, and rollback support
 */

import { randomUUID } from 'node:crypto';
import type {
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowNode,
  WorkflowNodeResult,
  WorkflowCheckpoint,
  WorkflowRollback,
  WorkflowCondition,
  QualityGate,
} from './types.js';

export type WorkflowEngineOptions = {
  onNodeStart?: (execution: WorkflowExecution, node: WorkflowNode) => void;
  onNodeComplete?: (execution: WorkflowExecution, node: WorkflowNode, result: WorkflowNodeResult) => void;
  onNodeFailed?: (execution: WorkflowExecution, node: WorkflowNode, error: string) => void;
  onCheckpoint?: (execution: WorkflowExecution, checkpoint: WorkflowCheckpoint) => void;
  onRollback?: (execution: WorkflowExecution, rollback: WorkflowRollback) => void;
  onPause?: (execution: WorkflowExecution) => void;
  onResume?: (execution: WorkflowExecution) => void;

  // External integrations
  executeNode?: (node: WorkflowNode, context: Record<string, any>, signal?: AbortSignal) => Promise<WorkflowNodeResult>;
  evaluateCondition?: (condition: WorkflowCondition, context: Record<string, any>) => Promise<boolean>;
  evaluateGate?: (gate: QualityGate, context: Record<string, any>) => Promise<{ passed: boolean; value: number; error?: string }>;
  createCheckpoint?: (message: string) => Promise<{ sha: string; branch: string }>;
  rollbackToCheckpoint?: (sha: string) => Promise<string[]>;
};

class WorkflowControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowControlError';
  }
}

class WorkflowFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowFailureError';
  }
}

export class WorkflowEngine {
  private workflow: WorkflowDefinition;
  private execution: WorkflowExecution;
  private options: WorkflowEngineOptions;
  private abortController?: AbortController;
  private runPromise?: Promise<WorkflowExecution>;

  constructor(workflow: WorkflowDefinition, options: WorkflowEngineOptions = {}) {
    this.workflow = workflow;
    this.options = options;

    this.execution = {
      id: `exec_${Date.now()}_${randomUUID().slice(0, 8)}`,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      status: 'running',
      currentNodes: [],
      completedNodes: [],
      failedNodes: [],
      blockedNodes: [],
      skippedNodes: [],
      checkpoints: [],
      rollbacks: [],
      startedAt: new Date().toISOString(),
      context: {},
    };
  }

  /**
   * 从持久化的执行状态恢复引擎（配合 resume() 续跑）。
   *
   * 语义：
   *  - completed/skipped 节点按持久化状态复位，不会重复执行；
   *  - failed 节点在恢复时重置为 pending 并移出 failedNodes —— 恢复即重试；
   *  - 中断时正在执行的节点（currentNodes）同样重置为 pending 重新执行；
   *  - execution.context（前序节点输出）随持久化状态一并恢复。
   */
  static restore(workflow: WorkflowDefinition, saved: WorkflowExecution, options: WorkflowEngineOptions = {}): WorkflowEngine {
    if (saved.workflowId !== workflow.id) {
      throw new Error(`Execution ${saved.id} belongs to workflow ${saved.workflowId}, not ${workflow.id}`);
    }
    if (saved.status === 'completed' || saved.status === 'cancelled' || saved.status === 'failed') {
      throw new Error(`Execution ${saved.id} is ${saved.status} and cannot be resumed`);
    }

    const engine = new WorkflowEngine(workflow, options);
    const completed = new Set(saved.completedNodes);
    const skipped = new Set(saved.skippedNodes ?? []);
    for (const node of workflow.nodes) {
      const wasCompleted = completed.has(node.id);
      node.status = wasCompleted ? 'done' : skipped.has(node.id) ? 'skipped' : 'pending';
      node.result = wasCompleted ? node.result : undefined;
      node.startedAt = undefined;
      node.finishedAt = wasCompleted ? node.finishedAt : undefined;
      node.retryCount = wasCompleted ? node.retryCount : undefined;
    }

    engine.execution = {
      ...saved,
      status: 'paused',
      currentNodes: [],
      failedNodes: [],
      blockedNodes: [],
    };
    return engine;
  }

  async run(): Promise<WorkflowExecution> {
    if (this.runPromise) return this.runPromise;
    if (this.execution.status === 'cancelled' || this.execution.status === 'completed') {
      return this.execution;
    }
    if (this.execution.status === 'failed') {
      throw new Error('Execution has already failed');
    }

    this.execution.status = 'running';
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const timeoutMs = this.workflow.globalTimeout === undefined
      ? undefined
      : this.workflow.globalTimeout * 60_000;

    this.runPromise = this.runWithTimeout(signal, timeoutMs);
    try {
      return await this.runPromise;
    } finally {
      this.runPromise = undefined;
      if (this.abortController?.signal === signal) this.abortController = undefined;
    }
  }

  private async runWithTimeout(signal: AbortSignal, timeoutMs?: number): Promise<WorkflowExecution> {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      this.execution.status = 'failed';
      this.execution.finishedAt = new Date().toISOString();
      throw new Error('globalTimeout must be a finite number of minutes greater than or equal to zero');
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const loopPromise = this.runLoop(signal);
    const timeoutPromise = timeoutMs === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.execution.status = 'failed';
          this.execution.finishedAt = new Date().toISOString();
          this.abortController?.abort();
          reject(new WorkflowControlError(`Workflow timed out after ${this.workflow.globalTimeout} minute(s)`));
        }, timeoutMs);
      });

    try {
      return await (timeoutPromise ? Promise.race([loopPromise, timeoutPromise]) : loopPromise);
    } catch (error) {
      if (error instanceof WorkflowControlError && (this.execution.status === 'paused' || this.execution.status === 'cancelled')) {
        this.resetInterruptedNodes();
        return this.execution;
      }

      if (this.execution.status !== 'failed') {
        this.execution.status = 'failed';
        this.execution.finishedAt = new Date().toISOString();
      }
      this.resetInterruptedNodes();

      if (this.workflow.rollbackOnFailure && this.execution.checkpoints.length > 0) {
        const lastCheckpoint = this.execution.checkpoints[this.execution.checkpoints.length - 1];
        try {
          await this.rollbackTo(lastCheckpoint.id, `Workflow failed: ${error instanceof Error ? error.message : String(error)}`);
        } catch {
          // Preserve the original failure. Rollback failures are represented by the
          // execution state and must not turn a real failure into a success.
        }
      }

      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async runLoop(signal: AbortSignal): Promise<WorkflowExecution> {
    const entryNode = this.workflow.nodes.find(n => n.id === this.workflow.entryNode);
    if (!entryNode) {
      throw new Error(`Entry node ${this.workflow.entryNode} not found`);
    }

    this.ensureCanContinue(signal);

    // Preserve the public entry-node contract, but only execute it when its
    // dependencies are actually satisfied. This also makes resume safe.
    if (!this.execution.completedNodes.includes(entryNode.id)
      && !this.execution.skippedNodes?.includes(entryNode.id)
      && this.isNodeRunnable(entryNode)) {
      await this.executeNode(entryNode, signal);
    }

    while (this.execution.status === 'running') {
      this.ensureCanContinue(signal);
      const runnableNodes = this.getRunnableNodes();
      if (runnableNodes.length === 0) {
        const blocked = this.markUnrunnableNodes();
        if (blocked.length > 0) {
          throw new WorkflowFailureError(`Workflow blocked: ${blocked.join(', ')}`);
        }
        break;
      }

      const maxParallel = Math.max(1, this.workflow.maxParallelTasks ?? 4);
      const nodesToRun = runnableNodes.slice(0, maxParallel);
      await Promise.all(nodesToRun.map(node => this.executeNode(node, signal)));
    }

    if (this.execution.status === 'paused' || this.execution.status === 'cancelled') {
      this.resetInterruptedNodes();
      return this.execution;
    }

    if (this.execution.failedNodes.length > 0 || (this.execution.blockedNodes?.length ?? 0) > 0) {
      throw new WorkflowFailureError('Workflow did not complete because one or more nodes failed or were blocked');
    }

    this.execution.status = 'completed';
    this.execution.finishedAt = new Date().toISOString();
    return this.execution;
  }

  async pause(): Promise<void> {
    if (this.execution.status !== 'running') return;
    this.execution.status = 'paused';
    this.execution.pausedAt = new Date().toISOString();
    this.abortController?.abort();
    this.options.onPause?.(this.execution);
  }

  async resume(): Promise<WorkflowExecution> {
    if (this.execution.status !== 'paused') {
      throw new Error('Execution is not paused');
    }

    // A pause may have been requested from an executing node callback. Wait for
    // that invocation to unwind before starting a new scheduler.
    const previousRun = this.runPromise;
    if (previousRun) await previousRun.catch(() => undefined);

    this.execution.status = 'running';
    this.execution.pausedAt = undefined;
    this.options.onResume?.(this.execution);
    return this.run();
  }

  async cancel(): Promise<void> {
    if (this.execution.status === 'completed' || this.execution.status === 'failed' || this.execution.status === 'cancelled') return;
    this.execution.status = 'cancelled';
    this.execution.finishedAt = new Date().toISOString();
    this.abortController?.abort();
    this.resetInterruptedNodes();
  }

  private async executeNode(node: WorkflowNode, signal: AbortSignal, allowReserved = false): Promise<void> {
    if (this.execution.completedNodes.includes(node.id)
      || this.execution.failedNodes.includes(node.id)
      || this.execution.skippedNodes?.includes(node.id)) return;

    if (!allowReserved && this.isReservedParallelChild(node.id)) return;
    if (!this.isNodeRunnable(node)) {
      throw new WorkflowFailureError(`Node ${node.id} dependencies are not satisfied`);
    }

    this.execution.currentNodes.push(node.id);
    node.status = 'in_progress';
    node.startedAt = new Date().toISOString();
    this.options.onNodeStart?.(this.execution, node);

    try {
      while (true) {
        this.ensureCanContinue(signal);
        const result = await this.executeNodeByType(node, signal);
        this.ensureCanContinue(signal);

        node.result = result;
        node.finishedAt = new Date().toISOString();
        if (result.success) {
          node.status = 'done';
          this.removeCurrentNode(node.id);
          if (!this.execution.completedNodes.includes(node.id)) this.execution.completedNodes.push(node.id);
          this.execution.failedNodes = this.execution.failedNodes.filter(id => id !== node.id);
          this.execution.context[node.id] = result.output;
          if (node.type === 'condition') this.applyConditionRouting(node, result);
          this.options.onNodeComplete?.(this.execution, node, result);
          return;
        }

        node.status = 'failed';
        this.removeCurrentNode(node.id);
        if (!this.execution.failedNodes.includes(node.id)) this.execution.failedNodes.push(node.id);
        this.options.onNodeFailed?.(this.execution, node, result.errors?.join('; ') ?? result.summary ?? 'Unknown error');

        if (node.maxRetries !== undefined && (node.retryCount ?? 0) < node.maxRetries) {
          node.retryCount = (node.retryCount ?? 0) + 1;
          node.status = 'pending';
          this.execution.failedNodes = this.execution.failedNodes.filter(id => id !== node.id);
          this.execution.currentNodes.push(node.id);
          node.status = 'in_progress';
          node.startedAt = new Date().toISOString();
          this.options.onNodeStart?.(this.execution, node);
          continue;
        }

        throw new WorkflowFailureError(`${node.title} failed: ${result.errors?.join('; ') ?? result.summary}`);
      }
    } catch (error) {
      if (error instanceof WorkflowControlError) {
        this.removeCurrentNode(node.id);
        if (this.execution.status === 'paused' || this.execution.status === 'cancelled') {
          node.status = 'pending';
        } else {
          node.status = 'failed';
          if (!this.execution.failedNodes.includes(node.id)) this.execution.failedNodes.push(node.id);
        }
        throw error;
      }

      this.removeCurrentNode(node.id);
      node.status = 'failed';
      node.finishedAt = new Date().toISOString();
      if (!this.execution.failedNodes.includes(node.id)) this.execution.failedNodes.push(node.id);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.options.onNodeFailed?.(this.execution, node, errorMessage);
      throw error;
    }
  }

  private async executeNodeByType(node: WorkflowNode, signal: AbortSignal): Promise<WorkflowNodeResult> {
    this.ensureCanContinue(signal);
    switch (node.type) {
      case 'task':
        return this.executeTaskNode(node, signal);
      case 'condition':
        return this.executeConditionNode(node);
      case 'parallel':
        return this.executeParallelNode(node, signal);
      case 'checkpoint':
        return this.executeCheckpointNode(node);
      case 'gate':
        return this.executeGateNode(node);
      default:
        throw new Error(`Unknown node type: ${node.type}`);
    }
  }

  private async executeTaskNode(node: WorkflowNode, signal: AbortSignal): Promise<WorkflowNodeResult> {
    if (!this.options.executeNode) {
      return {
        success: false,
        summary: `Task ${node.title} cannot execute: no executeNode handler was provided`,
        errors: ['No task execution handler configured'],
      };
    }

    const result = await this.options.executeNode(node, this.execution.context, signal);

    if (node.gates && node.gates.length > 0) {
      const gateResults = await this.evaluateGates(node.gates);
      result.metrics = { ...result.metrics, ...gateResults.metrics };
      if (!gateResults.allPassed) {
        result.success = false;
        result.errors = [...(result.errors ?? []), ...gateResults.failures];
      }
    }

    if (this.workflow.autoCheckpoint && result.success) {
      await this.createCheckpointForNode(node);
    }
    return result;
  }

  private async executeConditionNode(node: WorkflowNode): Promise<WorkflowNodeResult> {
    if (!node.branches || node.branches.length === 0) {
      return { success: false, summary: 'Condition node has no branches', errors: ['No branches defined'] };
    }

    for (const branch of node.branches) {
      if (await this.evaluateConditionInternal(branch.condition)) {
        return {
          success: true,
          summary: `Condition met, proceeding to ${branch.nextNodes.join(', ')}`,
          output: { branch, nextNodes: [...branch.nextNodes] },
        };
      }
    }

    if (node.defaultNext && node.defaultNext.length > 0) {
      return {
        success: true,
        summary: `No condition met, using default: ${node.defaultNext.join(', ')}`,
        output: { branch: 'default', nextNodes: [...node.defaultNext] },
      };
    }

    return { success: false, summary: 'No condition met and no default branch', errors: ['No matching condition'] };
  }

  private async executeParallelNode(node: WorkflowNode, signal: AbortSignal): Promise<WorkflowNodeResult> {
    if (!node.parallelNodes || node.parallelNodes.length === 0) {
      return { success: false, summary: 'Parallel node has no child nodes', errors: ['No parallel nodes defined'] };
    }

    const parallelNodes = node.parallelNodes.map(id => this.workflow.nodes.find(n => n.id === id));
    if (parallelNodes.some((child): child is undefined => child === undefined)) {
      return { success: false, summary: 'Parallel node references a missing child', errors: ['Missing parallel child node'] };
    }
    const children = parallelNodes as WorkflowNode[];
    const remaining = new Set(children.map(child => child.id));
    const failures: string[] = [];

    // Execute ready children in waves. A child is not considered ready merely
    // because it is listed in parallelNodes: dependencies between children must
    // still be honored.
    while (remaining.size > 0) {
      this.ensureCanContinue(signal);
      const ready = children.filter(child => remaining.has(child.id) && this.isNodeRunnable(child));
      if (ready.length === 0) {
        failures.push('Parallel child dependencies cannot be satisfied');
        break;
      }

      const results = await Promise.allSettled(
        ready.map(child => this.executeNode(child, signal, true)),
      );
      results.forEach((result, index) => {
        const child = ready[index];
        if (result.status === 'fulfilled' && child.status === 'done') {
          remaining.delete(child.id);
        } else {
          const reason = result.status === 'rejected' ? result.reason : child.result?.summary ?? 'child failed';
          failures.push(`${child.title}: ${reason instanceof Error ? reason.message : String(reason)}`);
          remaining.delete(child.id);
        }
      });
      if (failures.length > 0) break;
    }

    if (failures.length > 0) {
      return {
        success: false,
        summary: `Parallel execution failed: ${failures.length}/${children.length} nodes failed`,
        errors: failures,
      };
    }

    return {
      success: true,
      summary: `Parallel execution completed: ${children.length}/${children.length} succeeded`,
      output: { succeeded: children.length, total: children.length },
    };
  }

  private async executeCheckpointNode(node: WorkflowNode): Promise<WorkflowNodeResult> {
    if (!node.checkpoint) {
      return { success: false, summary: 'Checkpoint node has no checkpoint config', errors: ['No checkpoint configuration'] };
    }
    const checkpoint = await this.createCheckpointForNode(node);
    return {
      success: true,
      summary: `Checkpoint created: ${checkpoint.commitSha.slice(0, 8)}`,
      output: checkpoint,
      checkpointSha: checkpoint.commitSha,
      checkpointBranch: checkpoint.branch,
    };
  }

  private async executeGateNode(node: WorkflowNode): Promise<WorkflowNodeResult> {
    if (!node.gates || node.gates.length === 0) {
      return { success: false, summary: 'Gate node has no gates defined', errors: ['No gates configured'] };
    }
    const gateResults = await this.evaluateGates(node.gates);
    return {
      success: gateResults.allPassed,
      summary: gateResults.allPassed ? `All ${node.gates.length} gates passed` : `${gateResults.failures.length} gates failed`,
      errors: gateResults.failures.length > 0 ? gateResults.failures : undefined,
      metrics: gateResults.metrics,
    };
  }

  private async evaluateConditionInternal(condition: WorkflowCondition): Promise<boolean> {
    if (this.options.evaluateCondition) return this.options.evaluateCondition(condition, this.execution.context);
    switch (condition.type) {
      case 'test_passed': return this.execution.context.lastTestResult?.success === true;
      case 'coverage_met': return (this.execution.context.lastCoverage ?? 0) >= (condition.threshold ?? 80);
      case 'no_errors': return !this.execution.context.lastErrors || this.execution.context.lastErrors.length === 0;
      case 'custom': return false;
      default: return false;
    }
  }

  private async evaluateGates(gates: QualityGate[]): Promise<{ allPassed: boolean; failures: string[]; metrics: Record<string, number> }> {
    if (!this.options.evaluateGate) {
      return {
        allPassed: false,
        failures: ['No quality gate evaluator configured'],
        metrics: {},
      };
    }

    const results = await Promise.all(gates.map(async gate => ({ gate, ...(await this.options.evaluateGate!(gate, this.execution.context)) })));
    const failures = results
      .filter(result => result.gate.blocking && !result.passed)
      .map(result => result.error
        ? `${result.gate.name} failed: ${result.error}`
        : `${result.gate.name} failed: got ${result.value}, threshold ${result.gate.threshold}`);
    const metrics: Record<string, number> = {};
    results.forEach(result => { metrics[result.gate.name] = result.value; });
    return { allPassed: failures.length === 0, failures, metrics };
  }

  private async createCheckpointForNode(node: WorkflowNode): Promise<WorkflowCheckpoint> {
    if (!this.options.createCheckpoint) {
      throw new Error('Checkpoint not supported: no createCheckpoint handler provided');
    }
    const message = node.checkpoint?.message ?? `Checkpoint after ${node.title}`;
    const { sha, branch } = await this.options.createCheckpoint(message);
    const checkpoint: WorkflowCheckpoint = {
      id: `ckpt_${Date.now()}_${randomUUID().slice(0, 6)}`,
      nodeId: node.id,
      commitSha: sha,
      branch,
      createdAt: new Date().toISOString(),
      metrics: node.result?.metrics,
    };
    this.execution.checkpoints.push(checkpoint);
    this.options.onCheckpoint?.(this.execution, checkpoint);
    return checkpoint;
  }

  private async rollbackTo(checkpointId: string, reason: string): Promise<void> {
    const checkpoint = this.execution.checkpoints.find(c => c.id === checkpointId);
    if (!checkpoint) throw new Error(`Checkpoint ${checkpointId} not found`);
    if (!this.options.rollbackToCheckpoint) throw new Error('Rollback not supported: no rollbackToCheckpoint handler provided');

    const filesRestored = await this.options.rollbackToCheckpoint(checkpoint.commitSha);
    const rollback: WorkflowRollback = {
      id: `rb_${Date.now()}_${randomUUID().slice(0, 6)}`,
      fromNodeId: this.execution.currentNodes[0] ?? 'unknown',
      toCheckpointId: checkpointId,
      reason,
      performedAt: new Date().toISOString(),
      filesRestored,
    };
    this.execution.rollbacks.push(rollback);
    this.options.onRollback?.(this.execution, rollback);

    const checkpointNode = this.workflow.nodes.find(n => n.id === checkpoint.nodeId);
    if (checkpointNode) {
      this.execution.completedNodes = this.execution.completedNodes.filter(id => this.isNodeBeforeOrAt(id, checkpointNode.id));
      this.execution.failedNodes = [];
      this.execution.blockedNodes = [];
      this.execution.currentNodes = [];
    }
  }

  private applyConditionRouting(node: WorkflowNode, result: WorkflowNodeResult): void {
    const output = result.output as { nextNodes?: unknown } | undefined;
    const nextNodes = Array.isArray(output?.nextNodes)
      ? output.nextNodes.filter((id): id is string => typeof id === 'string')
      : [];
    const candidates = new Set<string>();
    for (const branch of node.branches ?? []) for (const id of branch.nextNodes) candidates.add(id);
    for (const id of node.defaultNext ?? []) candidates.add(id);

    // A condition is a routing decision, not just an informational result.
    // Nodes on routes that were not selected are explicitly skipped so the
    // scheduler cannot execute them merely because they have no dependencies.
    for (const id of candidates) {
      const target = this.workflow.nodes.find(candidate => candidate.id === id);
      if (!target || nextNodes.includes(id)) continue;
      target.status = 'skipped';
      target.finishedAt = new Date().toISOString();
      if (!this.execution.skippedNodes?.includes(id)) (this.execution.skippedNodes ??= []).push(id);
      this.removeCurrentNode(id);
    }
  }

  private hasRunnableNodes(): boolean {
    return this.getRunnableNodes().length > 0;
  }

  private getRunnableNodes(): WorkflowNode[] {
    if (this.execution.status !== 'running') return [];
    return this.workflow.nodes.filter(node => this.isNodeRunnable(node) && !this.isReservedParallelChild(node.id));
  }

  private isNodeRunnable(node: WorkflowNode): boolean {
    if (this.execution.completedNodes.includes(node.id)
      || this.execution.failedNodes.includes(node.id)
      || this.execution.blockedNodes?.includes(node.id)
      || this.execution.skippedNodes?.includes(node.id)
      || this.execution.currentNodes.includes(node.id)
      || node.status === 'in_progress') return false;
    return node.dependsOn.every(depId => this.execution.completedNodes.includes(depId));
  }

  private isReservedParallelChild(nodeId: string): boolean {
    return this.workflow.nodes.some(parent => parent.type === 'parallel'
      && parent.parallelNodes?.includes(nodeId)
      && !this.execution.completedNodes.includes(parent.id)
      && !this.execution.failedNodes.includes(parent.id)
      && !this.execution.skippedNodes?.includes(parent.id));
  }

  private markUnrunnableNodes(): string[] {
    const blocked: string[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of this.workflow.nodes) {
        if (node.status === 'done' || node.status === 'skipped' || this.execution.completedNodes.includes(node.id)) continue;
        if (this.execution.failedNodes.includes(node.id) || this.execution.blockedNodes?.includes(node.id)) continue;
        const hasTerminalDependency = node.dependsOn.some(depId =>
          this.execution.failedNodes.includes(depId)
          || this.execution.blockedNodes?.includes(depId)
          || this.execution.skippedNodes?.includes(depId),
        );
        if (hasTerminalDependency || (!this.isReservedParallelChild(node.id) && this.execution.status === 'running')) {
          node.status = 'blocked';
          node.finishedAt = new Date().toISOString();
          (this.execution.blockedNodes ??= []).push(node.id);
          blocked.push(node.id);
          changed = true;
        }
      }
    }
    return blocked;
  }

  private resetInterruptedNodes(): void {
    for (const id of [...this.execution.currentNodes]) {
      const node = this.workflow.nodes.find(candidate => candidate.id === id);
      if (node && node.status === 'in_progress') node.status = 'pending';
      this.removeCurrentNode(id);
    }
  }

  private removeCurrentNode(nodeId: string): void {
    this.execution.currentNodes = this.execution.currentNodes.filter(id => id !== nodeId);
  }

  private ensureCanContinue(signal: AbortSignal): void {
    if (signal.aborted || this.execution.status === 'paused') throw new WorkflowControlError('Workflow paused');
    if (this.execution.status === 'cancelled') throw new WorkflowControlError('Workflow cancelled');
    if (this.execution.status !== 'running') throw new WorkflowControlError(`Workflow is ${this.execution.status}`);
  }

  private isNodeBeforeOrAt(nodeId: string, targetNodeId: string, seen = new Set<string>()): boolean {
    if (seen.has(nodeId)) return false;
    seen.add(nodeId);
    const node = this.workflow.nodes.find(n => n.id === nodeId);
    if (!node) return false;
    if (nodeId === targetNodeId) return true;
    return node.dependsOn.some(depId => this.isNodeBeforeOrAt(depId, targetNodeId, seen));
  }

  getExecution(): WorkflowExecution {
    return { ...this.execution };
  }

  getProgress(): { completed: number; total: number; percentage: number } {
    const total = this.workflow.nodes.length;
    const completed = this.execution.completedNodes.length;
    return { completed, total, percentage: total > 0 ? Math.round((completed / total) * 100) : 0 };
  }
}
