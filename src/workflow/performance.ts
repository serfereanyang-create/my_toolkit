/**
 * Workflow performance analyzer and optimizer.
 *
 * Operates on lightweight execution samples (per-node timing + workflow shape)
 * decoupled from the persisted WorkflowExecution type — the engine and any
 * caller can feed samples without changing storage formats.
 */

import type { WorkflowNode } from './types.js';

/** A node extension surface the optimizer may write to. */
export type OptimizableNode = WorkflowNode & {
  metadata?: Record<string, unknown>;
  retryDelay?: number;
};

/** One node run observed during a workflow execution. */
export type NodeRunSample = {
  nodeId: string;
  status: 'completed' | 'failed' | 'skipped';
  startTime: number;
  endTime: number;
  retries?: number;
};

/** One full workflow run: shape + node timings. */
export type WorkflowRunSample = {
  workflowId: string;
  nodes: Array<{ id: string; dependsOn?: string[] }>;
  startedAt: number;
  finishedAt: number;
  nodeRuns: NodeRunSample[];
};

export type NodeMetrics = {
  nodeId: string;
  executionCount: number;
  totalDuration: number;
  averageDuration: number;
  minDuration: number;
  maxDuration: number;
  successRate: number;
  retryCount: number;
};

export type Bottleneck = {
  nodeId: string;
  type: 'duration' | 'failure' | 'retry';
  severity: 'low' | 'medium' | 'high' | 'critical';
  impact: number;
  description: string;
};

export type Recommendation = {
  type: 'parallelization' | 'caching' | 'timeout' | 'retry' | 'dependency';
  priority: 'low' | 'medium' | 'high';
  nodeIds: string[];
  description: string;
  estimatedImprovement: string;
};

export type PerformanceMetrics = {
  totalDuration: number;
  runCount: number;
  nodeMetrics: Map<string, NodeMetrics>;
  criticalPath: string[];
  parallelizableNodes: string[][];
  bottlenecks: Bottleneck[];
  recommendations: Recommendation[];
};

export class WorkflowPerformanceAnalyzer {
  private runHistory: WorkflowRunSample[] = [];

  addRun(run: WorkflowRunSample): void {
    this.runHistory.push(run);
  }

  /** Backwards-compatible alias. */
  addExecution(run: WorkflowRunSample): void {
    this.addRun(run);
  }

  analyze(): PerformanceMetrics {
    if (this.runHistory.length === 0) {
      return {
        totalDuration: 0,
        runCount: 0,
        nodeMetrics: new Map(),
        criticalPath: [],
        parallelizableNodes: [],
        bottlenecks: [],
        recommendations: [],
      };
    }

    const nodeMetrics = this.computeNodeMetrics();
    const criticalPath = this.findCriticalPath();
    const parallelizableNodes = this.findParallelizableNodes();
    const bottlenecks = this.identifyBottlenecks(nodeMetrics);
    const recommendations = this.generateRecommendations(nodeMetrics, bottlenecks, parallelizableNodes);

    const totalDuration = this.runHistory.reduce((sum, run) => sum + (run.finishedAt - run.startedAt), 0);

    return {
      totalDuration,
      runCount: this.runHistory.length,
      nodeMetrics,
      criticalPath,
      parallelizableNodes,
      bottlenecks,
      recommendations,
    };
  }

  private computeNodeMetrics(): Map<string, NodeMetrics> {
    const metrics = new Map<string, NodeMetrics>();

    for (const run of this.runHistory) {
      for (const nodeRun of run.nodeRuns) {
        let existing = metrics.get(nodeRun.nodeId);
        if (!existing) {
          existing = {
            nodeId: nodeRun.nodeId,
            executionCount: 0,
            totalDuration: 0,
            averageDuration: 0,
            minDuration: Infinity,
            maxDuration: 0,
            successRate: 0,
            retryCount: 0,
          };
          metrics.set(nodeRun.nodeId, existing);
        }

        const duration = nodeRun.endTime - nodeRun.startTime;
        existing.executionCount++;
        existing.totalDuration += duration;
        existing.minDuration = Math.min(existing.minDuration, duration);
        existing.maxDuration = Math.max(existing.maxDuration, duration);
        if (nodeRun.retries && nodeRun.retries > 0) {
          existing.retryCount += nodeRun.retries;
        }
      }
    }

    for (const metric of metrics.values()) {
      metric.averageDuration = metric.totalDuration / metric.executionCount;

      const successes = this.runHistory.reduce((count, run) => {
        const nodeRun = run.nodeRuns.find((ne) => ne.nodeId === metric.nodeId);
        return count + (nodeRun?.status === 'completed' ? 1 : 0);
      }, 0);
      metric.successRate = metric.executionCount > 0 ? successes / metric.executionCount : 0;
    }

    return metrics;
  }

  private findCriticalPath(): string[] {
    if (this.runHistory.length === 0) return [];

    const lastRun = this.runHistory[this.runHistory.length - 1];
    const sorted = [...lastRun.nodeRuns].sort(
      (a, b) => (b.endTime - b.startTime) - (a.endTime - a.startTime)
    );

    return sorted.slice(0, 5).map((ne) => ne.nodeId);
  }

  private findParallelizableNodes(): string[][] {
    if (this.runHistory.length === 0) return [];

    const lastRun = this.runHistory[this.runHistory.length - 1];
    const parallelGroups: string[][] = [];
    const processed = new Set<string>();

    for (const node of lastRun.nodes) {
      if (processed.has(node.id)) continue;

      const nodeDeps = new Set(node.dependsOn ?? []);
      const sameDeps = lastRun.nodes.filter((n) => {
        if (n.id === node.id || processed.has(n.id)) return false;
        const nDeps = new Set(n.dependsOn ?? []);
        if (nodeDeps.size !== nDeps.size) return false;
        for (const dep of nodeDeps) {
          if (!nDeps.has(dep)) return false;
        }
        return true;
      });

      if (sameDeps.length > 0) {
        const group = [node.id, ...sameDeps.map((n) => n.id)];
        parallelGroups.push(group);
        for (const id of group) processed.add(id);
      }
    }

    return parallelGroups;
  }

  private identifyBottlenecks(nodeMetrics: Map<string, NodeMetrics>): Bottleneck[] {
    const bottlenecks: Bottleneck[] = [];

    for (const [nodeId, metrics] of nodeMetrics) {
      if (metrics.averageDuration > 5000) {
        bottlenecks.push({
          nodeId,
          type: 'duration',
          severity: metrics.averageDuration > 30000 ? 'critical' : 'high',
          impact: metrics.averageDuration,
          description: 'Node takes ' + Math.round(metrics.averageDuration / 1000) + 's on average',
        });
      }

      if (metrics.successRate < 0.9) {
        bottlenecks.push({
          nodeId,
          type: 'failure',
          severity: metrics.successRate < 0.5 ? 'critical' : 'high',
          impact: (1 - metrics.successRate) * 100,
          description: 'Node fails ' + Math.round((1 - metrics.successRate) * 100) + '% of the time',
        });
      }

      if (metrics.retryCount > metrics.executionCount) {
        bottlenecks.push({
          nodeId,
          type: 'retry',
          severity: 'medium',
          impact: metrics.retryCount,
          description: 'Node requires ' + Math.round(metrics.retryCount / metrics.executionCount) + ' retries on average',
        });
      }
    }

    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    return bottlenecks.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  }

  private generateRecommendations(
    nodeMetrics: Map<string, NodeMetrics>,
    bottlenecks: Bottleneck[],
    parallelizableNodes: string[][]
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];

    for (const group of parallelizableNodes) {
      if (group.length > 1) {
        recommendations.push({
          type: 'parallelization',
          priority: 'high',
          nodeIds: group,
          description: 'These ' + group.length + ' nodes can run in parallel',
          estimatedImprovement: '30-50% faster execution',
        });
      }
    }

    for (const metrics of nodeMetrics.values()) {
      if (metrics.executionCount > 3 && metrics.averageDuration > 2000) {
        recommendations.push({
          type: 'caching',
          priority: 'medium',
          nodeIds: [metrics.nodeId],
          description: 'Cache results to skip repeated executions',
          estimatedImprovement: 'Save ' + Math.round(metrics.averageDuration / 1000) + 's per run',
        });
      }
    }

    for (const bottleneck of bottlenecks) {
      if (bottleneck.type === 'duration' && bottleneck.severity === 'critical') {
        recommendations.push({
          type: 'timeout',
          priority: 'high',
          nodeIds: [bottleneck.nodeId],
          description: 'Add timeout to prevent hanging (currently ' + Math.round(bottleneck.impact / 1000) + 's)',
          estimatedImprovement: 'Prevent workflow stalls',
        });
      }
      if (bottleneck.type === 'failure' && bottleneck.severity === 'high') {
        recommendations.push({
          type: 'retry',
          priority: 'high',
          nodeIds: [bottleneck.nodeId],
          description: 'Increase retry attempts or add exponential backoff',
          estimatedImprovement: 'Improve ' + Math.round(bottleneck.impact) + '% failure rate',
        });
      }
    }

    const priorityOrder = { high: 0, medium: 1, low: 2 } as const;
    return recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  }

  getRunHistory(): WorkflowRunSample[] {
    return [...this.runHistory];
  }

  clearHistory(): void {
    this.runHistory = [];
  }

  exportMetrics(): string {
    const metrics = this.analyze();
    return JSON.stringify(
      {
        summary: {
          totalRuns: metrics.runCount,
          totalDuration: metrics.totalDuration,
          averageDuration: metrics.runCount > 0 ? metrics.totalDuration / metrics.runCount : 0,
        },
        nodeMetrics: [...metrics.nodeMetrics.values()],
        criticalPath: metrics.criticalPath,
        parallelizableNodes: metrics.parallelizableNodes,
        bottlenecks: metrics.bottlenecks,
        recommendations: metrics.recommendations,
      },
      null,
      2
    );
  }
}

export class WorkflowOptimizer {
  constructor(private analyzer: WorkflowPerformanceAnalyzer) {}

  /** Produce an optimized deep copy of the node list (never mutates inputs). */
  generateOptimizedWorkflow(originalNodes: OptimizableNode[]): OptimizableNode[] {
    const metrics = this.analyzer.analyze();
    const optimized: OptimizableNode[] = originalNodes.map((n) => ({
      ...n,
      dependsOn: [...(n.dependsOn ?? [])],
      metadata: { ...(n.metadata ?? {}) },
    }));

    // Parallelization: remove intra-group dependencies
    for (const group of metrics.parallelizableNodes) {
      if (group.length <= 1) continue;
      for (const nodeId of group) {
        const node = optimized.find((n) => n.id === nodeId);
        if (!node?.dependsOn) continue;
        node.dependsOn = node.dependsOn.filter((dep) => !group.includes(dep));
      }
    }

    // Caching hints
    for (const rec of metrics.recommendations) {
      if (rec.type !== 'caching') continue;
      for (const nodeId of rec.nodeIds) {
        const node = optimized.find((n) => n.id === nodeId);
        if (node) node.metadata = { ...(node.metadata ?? {}), cacheable: true };
      }
    }

    // Retry tuning
    for (const rec of metrics.recommendations) {
      if (rec.type !== 'retry') continue;
      for (const nodeId of rec.nodeIds) {
        const node = optimized.find((n) => n.id === nodeId);
        if (node) {
          node.maxRetries = Math.max(node.maxRetries ?? 0, 3);
          node.retryDelay = 2000;
        }
      }
    }

    return optimized;
  }

  estimateImpact(
    originalNodes: OptimizableNode[],
    optimizedNodes: OptimizableNode[]
  ): { estimatedSpeedup: number; riskLevel: 'low' | 'medium' | 'high'; changes: string[] } {
    const changes: string[] = [];
    let estimatedSpeedup = 1.0;

    const parallelChanges = optimizedNodes.filter((n) => {
      const original = originalNodes.find((o) => o.id === n.id);
      return original !== undefined && (original.dependsOn?.length ?? 0) !== (n.dependsOn?.length ?? 0);
    }).length;

    if (parallelChanges > 0) {
      changes.push(parallelChanges + ' nodes can now run in parallel');
      estimatedSpeedup *= 1.3;
    }

    const cachingChanges = optimizedNodes.filter((n) => n.metadata?.cacheable === true).length;
    if (cachingChanges > 0) {
      changes.push(cachingChanges + ' nodes will use caching');
      estimatedSpeedup *= 1.2;
    }

    const retryChanges = optimizedNodes.filter((n) => {
      const original = originalNodes.find((o) => o.id === n.id);
      return original !== undefined && (n.maxRetries ?? 0) > (original.maxRetries ?? 0);
    }).length;

    if (retryChanges > 0) {
      changes.push(retryChanges + ' nodes have improved retry logic');
    }

    const riskLevel = parallelChanges > 3 ? 'high' : parallelChanges > 0 ? 'medium' : 'low';

    return {
      estimatedSpeedup: Math.round((estimatedSpeedup - 1) * 100),
      riskLevel,
      changes,
    };
  }
}
