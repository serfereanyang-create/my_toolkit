/**
 * Tests for workflow performance analyzer and optimizer.
 * Uses lightweight WorkflowRunSample fixtures decoupled from persisted types.
 */

import { describe, it, expect } from 'vitest';
import { WorkflowPerformanceAnalyzer, WorkflowOptimizer } from './performance.js';
import type { WorkflowRunSample, OptimizableNode } from './performance.js';

function makeRun(
  id: string,
  nodes: Array<{ id: string; dependsOn?: string[] }>,
  nodeRuns: WorkflowRunSample['nodeRuns'],
  duration = 4000
): WorkflowRunSample {
  return {
    workflowId: 'wf-1',
    nodes,
    startedAt: 1000,
    finishedAt: 1000 + duration,
    nodeRuns,
  };
}

describe('WorkflowPerformanceAnalyzer', () => {
  it('returns empty metrics when no runs recorded', () => {
    const analyzer = new WorkflowPerformanceAnalyzer();
    const metrics = analyzer.analyze();

    expect(metrics.totalDuration).toBe(0);
    expect(metrics.runCount).toBe(0);
    expect(metrics.nodeMetrics.size).toBe(0);
    expect(metrics.bottlenecks.length).toBe(0);
  });

  it('computes node metrics correctly', () => {
    const analyzer = new WorkflowPerformanceAnalyzer();

    analyzer.addRun(makeRun('exec-1', [{ id: 'node-1' }, { id: 'node-2' }], [
      { nodeId: 'node-1', status: 'completed', startTime: 1000, endTime: 3000 },
      { nodeId: 'node-2', status: 'completed', startTime: 3000, endTime: 5000 },
    ]));

    const metrics = analyzer.analyze();
    expect(metrics.runCount).toBe(1);
    expect(metrics.nodeMetrics.size).toBe(2);
    expect(metrics.nodeMetrics.get('node-1')?.averageDuration).toBe(2000);
    expect(metrics.nodeMetrics.get('node-1')?.successRate).toBe(1);
    expect(metrics.nodeMetrics.get('node-2')?.averageDuration).toBe(2000);
  });

  it('aggregates across multiple runs', () => {
    const analyzer = new WorkflowPerformanceAnalyzer();
    const nodes = [{ id: 'node-1' }];

    for (let i = 0; i < 3; i++) {
      analyzer.addRun(makeRun('exec-' + i, nodes, [
        { nodeId: 'node-1', status: i === 0 ? 'failed' : 'completed', startTime: 1000, endTime: 3000 },
      ]));
    }

    const metrics = analyzer.analyze();
    const nodeMetrics = metrics.nodeMetrics.get('node-1')!;
    expect(nodeMetrics.executionCount).toBe(3);
    expect(nodeMetrics.successRate).toBeCloseTo(2 / 3, 5);
  });

  it('identifies duration bottlenecks', () => {
    const analyzer = new WorkflowPerformanceAnalyzer();

    analyzer.addRun(makeRun('exec-1', [{ id: 'slow-node' }, { id: 'fast-node' }], [
      { nodeId: 'slow-node', status: 'completed', startTime: 1000, endTime: 36000 },
      { nodeId: 'fast-node', status: 'completed', startTime: 36000, endTime: 41000 },
    ], 40000));

    const metrics = analyzer.analyze();
    expect(metrics.bottlenecks.length).toBeGreaterThan(0);
    expect(metrics.bottlenecks[0].nodeId).toBe('slow-node');
    expect(metrics.bottlenecks[0].type).toBe('duration');
    expect(metrics.bottlenecks[0].severity).toBe('critical');
  });

  it('identifies failure bottlenecks', () => {
    const analyzer = new WorkflowPerformanceAnalyzer();
    const nodes = [{ id: 'flaky-node' }];

    for (let i = 0; i < 3; i++) {
      analyzer.addRun(makeRun('exec-' + i, nodes, [
        { nodeId: 'flaky-node', status: i < 2 ? 'failed' : 'completed', startTime: 1000, endTime: 3000 },
      ]));
    }

    const metrics = analyzer.analyze();
    const failureBottleneck = metrics.bottlenecks.find((b) => b.type === 'failure');
    expect(failureBottleneck).toBeDefined();
    expect(failureBottleneck?.nodeId).toBe('flaky-node');
  });

  it('finds parallelizable nodes with identical dependencies', () => {
    const analyzer = new WorkflowPerformanceAnalyzer();

    const nodes = [
      { id: 'node-1', dependsOn: [] as string[] },
      { id: 'node-2', dependsOn: ['node-1'] },
      { id: 'node-3', dependsOn: ['node-1'] },
    ];
    analyzer.addRun(makeRun('exec-1', nodes, nodes.map((n, i) => ({
      nodeId: n.id,
      status: 'completed' as const,
      startTime: 1000 + i * 1000,
      endTime: 2000 + i * 1000,
    }))));

    const metrics = analyzer.analyze();
    expect(metrics.parallelizableNodes.length).toBeGreaterThan(0);
    const group = metrics.parallelizableNodes.find((g) => g.includes('node-2'));
    expect(group).toContain('node-3');
  });

  it('generates caching recommendations for repeated slow tasks', () => {
    const analyzer = new WorkflowPerformanceAnalyzer();
    const nodes = [{ id: 'repeated-task' }];

    for (let i = 0; i < 5; i++) {
      analyzer.addRun(makeRun('exec-' + i, nodes, [
        { nodeId: 'repeated-task', status: 'completed', startTime: 1000, endTime: 5000 },
      ]));
    }

    const metrics = analyzer.analyze();
    const cachingRec = metrics.recommendations.find((r) => r.type === 'caching');
    expect(cachingRec).toBeDefined();
    expect(cachingRec?.nodeIds).toContain('repeated-task');
  });

  it('exports metrics as JSON', () => {
    const analyzer = new WorkflowPerformanceAnalyzer();
    const nodes = [{ id: 'node-1' }];
    analyzer.addRun(makeRun('exec-1', nodes, [
      { nodeId: 'node-1', status: 'completed', startTime: 1000, endTime: 3000 },
    ]));

    const parsed = JSON.parse(analyzer.exportMetrics()) as { summary: { totalRuns: number }; nodeMetrics: unknown[] };
    expect(parsed.summary.totalRuns).toBe(1);
    expect(parsed.nodeMetrics.length).toBe(1);
  });

  it('clearHistory resets analysis', () => {
    const analyzer = new WorkflowPerformanceAnalyzer();
    analyzer.addRun(makeRun('exec-1', [{ id: 'node-1' }], [
      { nodeId: 'node-1', status: 'completed', startTime: 1000, endTime: 2000 },
    ]));
    analyzer.clearHistory();
    expect(analyzer.analyze().runCount).toBe(0);
  });
});

describe('WorkflowOptimizer', () => {
  it('keeps originals untouched and preserves shared-dependency groups', () => {
    const analyzer = new WorkflowPerformanceAnalyzer();

    // node-2/node-3 share identical deps -> detected as a parallelizable group;
    // neither depends on the other, so dependsOn lists are preserved as-is.
    const nodes: OptimizableNode[] = [
      { id: 'node-1', type: 'task', title: 'Task 1', status: 'pending', dependsOn: [] },
      { id: 'node-2', type: 'task', title: 'Task 2', status: 'pending', dependsOn: ['node-1'] },
      { id: 'node-3', type: 'task', title: 'Task 3', status: 'pending', dependsOn: ['node-1'] },
    ];

    analyzer.addRun(makeRun('exec-1', nodes.map((n) => ({ id: n.id, dependsOn: n.dependsOn })), nodes.map((n, i) => ({
      nodeId: n.id,
      status: 'completed' as const,
      startTime: 1000 + i * 1000,
      endTime: 2000 + i * 1000,
    }))));

    const optimizer = new WorkflowOptimizer(analyzer);
    const optimized = optimizer.generateOptimizedWorkflow(nodes);

    const node2 = optimized.find((n) => n.id === 'node-2')!;
    const node3 = optimized.find((n) => n.id === 'node-3')!;
    expect(node2.dependsOn).toEqual(['node-1']);
    expect(node3.dependsOn).toEqual(['node-1']);

    // originals untouched (deep copy)
    expect(optimized[0]).not.toBe(nodes[0]);
    expect(nodes[1].metadata).toBeUndefined();
    expect(node2.metadata).toEqual({});
  });

  it('adds caching hints to frequently executed slow nodes', () => {
    const analyzer = new WorkflowPerformanceAnalyzer();
    const nodes = [{ id: 'repeated-task' }];

    for (let i = 0; i < 5; i++) {
      analyzer.addRun(makeRun('exec-' + i, nodes, [
        { nodeId: 'repeated-task', status: 'completed', startTime: 1000, endTime: 5000 },
      ]));
    }

    const original: OptimizableNode[] = [
      { id: 'repeated-task', type: 'task', title: 'Repeated Task', status: 'pending', dependsOn: [] },
    ];

    const optimizer = new WorkflowOptimizer(analyzer);
    const optimized = optimizer.generateOptimizedWorkflow(original);
    expect(optimized[0].metadata?.cacheable).toBe(true);
  });

  it('estimates optimization impact from caching changes', () => {
    const analyzer = new WorkflowPerformanceAnalyzer();
    const nodes = [{ id: 'slow-task' }];

    for (let i = 0; i < 5; i++) {
      analyzer.addRun(makeRun('exec-' + i, nodes, [
        { nodeId: 'slow-task', status: 'completed', startTime: 1000, endTime: 5000 },
      ]));
    }

    const original: OptimizableNode[] = [
      { id: 'slow-task', type: 'task', title: 'Slow Task', status: 'pending', dependsOn: [] },
    ];

    const optimizer = new WorkflowOptimizer(analyzer);
    const optimized = optimizer.generateOptimizedWorkflow(original);
    const impact = optimizer.estimateImpact(original, optimized);

    expect(impact.estimatedSpeedup).toBeGreaterThan(0);
    expect(impact.changes.length).toBeGreaterThan(0);
    expect(['low', 'medium', 'high']).toContain(impact.riskLevel);
  });

  it('reports zero impact when workflow is already optimal', () => {
    const analyzer = new WorkflowPerformanceAnalyzer();
    const nodes = [{ id: 'fast-task' }];

    for (let i = 0; i < 5; i++) {
      analyzer.addRun(makeRun('exec-' + i, nodes, [
        { nodeId: 'fast-task', status: 'completed', startTime: 1000, endTime: 1500 },
      ]));
    }

    const original: OptimizableNode[] = [
      { id: 'fast-task', type: 'task', title: 'Fast Task', status: 'pending', dependsOn: [] },
    ];

    const optimizer = new WorkflowOptimizer(analyzer);
    const optimized = optimizer.generateOptimizedWorkflow(original);
    const impact = optimizer.estimateImpact(original, optimized);

    expect(impact.estimatedSpeedup).toBe(0);
    expect(impact.changes.length).toBe(0);
    expect(impact.riskLevel).toBe('low');
  });
});
