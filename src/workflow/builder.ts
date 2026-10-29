/**
 * Fluent builder API for creating workflow definitions
 */

import { randomUUID } from 'node:crypto';
import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowCondition,
  QualityGate,
  WorkflowTemplate,
} from './types.js';
import { WORKFLOW_TEMPLATES } from './types.js';

export class WorkflowBuilder {
  private workflow: Partial<WorkflowDefinition>;
  private nodes: WorkflowNode[] = [];
  private nodeIdCounter = 0;
  
  constructor(name: string, description: string = '') {
    this.workflow = {
      id: `wf_${Date.now()}_${randomUUID().slice(0, 8)}`,
      name,
      description,
      version: '1.0.0',
      nodes: [],
      entryNode: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  
  static fromTemplate(templateName: keyof typeof WORKFLOW_TEMPLATES): WorkflowBuilder {
    const template = WORKFLOW_TEMPLATES[templateName];
    // `WORKFLOW_TEMPLATES` is a plain Record, so a name from JSON input reaches
    // here as a string cast; without this guard `template.nodes` is a TypeError.
    if (!template) throw new Error(`Unknown workflow template: ${String(templateName)}`);
    const builder = new WorkflowBuilder(template.name, template.description);

    // Node ids are `${type}_${index + 1}` (the node's position in the template),
    // and template `dependsOn` / branch references spell those ids directly.
    //
    // The old translation table mapped *per-type* ordinals ("task_1" = the
    // second task, "checkpoint_0" = the first checkpoint) onto generated ids.
    // That is ambiguous by construction: once a second node of a type existed,
    // "task_3" could mean either a generated id or an ordinal, and the same
    // dict mapped both `type_n` and `type_{n+1}` to one node. The result was
    // self-dependencies and skipped nodes (`task_3 → task_5` chains), which the
    // engine then reported as "blocked" at runtime. Direct ids make a template's
    // graph exactly what it reads like.
    template.nodes.forEach((nodeTemplate, index) => {
      const newId = `${nodeTemplate.type}_${index + 1}`;
      builder.addNode({
        ...nodeTemplate,
        id: newId,
        dependsOn: [...nodeTemplate.dependsOn],
        branches: nodeTemplate.branches?.map(branch => ({ ...branch, nextNodes: [...branch.nextNodes] })),
        defaultNext: nodeTemplate.defaultNext ? [...nodeTemplate.defaultNext] : undefined,
        parallelNodes: nodeTemplate.parallelNodes ? [...nodeTemplate.parallelNodes] : undefined,
        status: 'pending',
      } as WorkflowNode);
    });

    return builder;
  }
  
  addTask(title: string, config: {
    prompt?: string;
    acceptance?: string;
    dependsOn?: string[];
    gates?: QualityGate[];
    maxRetries?: number;
  } = {}): WorkflowBuilder {
    const id = `task_${++this.nodeIdCounter}`;
    
    this.nodes.push({
      id,
      type: 'task',
      title,
      prompt: config.prompt,
      acceptance: config.acceptance,
      dependsOn: config.dependsOn ?? [],
      gates: config.gates,
      maxRetries: config.maxRetries,
      status: 'pending',
    });
    
    return this;
  }
  
  addCondition(title: string, config: {
    condition: WorkflowCondition;
    onTrue: string[];
    onFalse?: string[];
    dependsOn?: string[];
  }): WorkflowBuilder {
    const id = `condition_${++this.nodeIdCounter}`;
    
    this.nodes.push({
      id,
      type: 'condition',
      title,
      branches: [
        {
          condition: config.condition,
          nextNodes: config.onTrue,
        },
      ],
      defaultNext: config.onFalse,
      dependsOn: config.dependsOn ?? [],
      status: 'pending',
    });
    
    return this;
  }
  
  addParallel(title: string, config: {
    nodes: string[];
    waitForAll?: boolean;
    dependsOn?: string[];
  }): WorkflowBuilder {
    const id = `parallel_${++this.nodeIdCounter}`;
    
    this.nodes.push({
      id,
      type: 'parallel',
      title,
      parallelNodes: config.nodes,
      waitForAll: config.waitForAll ?? true,
      dependsOn: config.dependsOn ?? [],
      status: 'pending',
    });
    
    return this;
  }
  
  addCheckpoint(title: string, config: {
    message: string;
    dependsOn?: string[];
  }): WorkflowBuilder {
    const id = `checkpoint_${++this.nodeIdCounter}`;
    
    this.nodes.push({
      id,
      type: 'checkpoint',
      title,
      checkpoint: {
        createCommit: true,
        message: config.message,
      },
      dependsOn: config.dependsOn ?? [],
      status: 'pending',
    });
    
    return this;
  }
  
  addGate(title: string, config: {
    gates: QualityGate[];
    dependsOn?: string[];
  }): WorkflowBuilder {
    const id = `gate_${++this.nodeIdCounter}`;
    
    this.nodes.push({
      id,
      type: 'gate',
      title,
      gates: config.gates,
      dependsOn: config.dependsOn ?? [],
      status: 'pending',
    });
    
    return this;
  }
  
  private addNode(node: WorkflowNode): WorkflowBuilder {
    this.nodes.push(node);
    // Only move the counter *past* the node's own ordinal; never bump it for
    // nodes that were not allocated from it. Bumping to `nodes.length + 1` on
    // every insert skipped ids ("task_1", "task_2", "task_4"), and a skipped
    // number is exactly what an author means by `dependsOn: ['task_3']`.
    if (node.id.startsWith('task_')) this.nodeIdCounter = Math.max(this.nodeIdCounter, Number(node.id.slice(5)) || 0);
    return this;
  }
  
  setEntryNode(nodeId: string): WorkflowBuilder {
    this.workflow.entryNode = nodeId;
    return this;
  }
  
  setMaxParallelTasks(max: number): WorkflowBuilder {
    this.workflow.maxParallelTasks = max;
    return this;
  }
  
  setGlobalTimeout(minutes: number): WorkflowBuilder {
    this.workflow.globalTimeout = minutes;
    return this;
  }
  
  enableAutoCheckpoint(): WorkflowBuilder {
    this.workflow.autoCheckpoint = true;
    return this;
  }
  
  enableRollbackOnFailure(): WorkflowBuilder {
    this.workflow.rollbackOnFailure = true;
    return this;
  }
  
  addTags(...tags: string[]): WorkflowBuilder {
    this.workflow.tags = [...(this.workflow.tags ?? []), ...tags];
    return this;
  }
  
  build(): WorkflowDefinition {
    if (this.nodes.length === 0) {
      throw new Error('Workflow must have at least one node');
    }
    
    // Auto-set entry node if not specified
    if (!this.workflow.entryNode) {
      const firstNode = this.nodes.find(n => n.dependsOn.length === 0);
      if (!firstNode) {
        throw new Error('Cannot determine entry node: no node without dependencies');
      }
      this.workflow.entryNode = firstNode.id;
    }
    
    // Validate entry node exists
    if (!this.nodes.find(n => n.id === this.workflow.entryNode)) {
      throw new Error(`Entry node ${this.workflow.entryNode} does not exist`);
    }
    
    // Validate dependencies
    for (const node of this.nodes) {
      for (const depId of node.dependsOn) {
        if (!this.nodes.find(n => n.id === depId)) {
          throw new Error(`Node ${node.id} depends on non-existent node ${depId}`);
        }
      }
    }
    
    this.workflow.nodes = this.nodes;
    this.workflow.updatedAt = new Date().toISOString();
    
    return this.workflow as WorkflowDefinition;
  }
}

// Helper functions for creating common quality gates
export const QualityGates = {
  coverage(threshold: number = 80, blocking: boolean = true): QualityGate {
    return {
      name: 'Code Coverage',
      type: 'coverage',
      threshold,
      blocking,
    };
  },
  
  complexity(threshold: number = 15, blocking: boolean = false): QualityGate {
    return {
      name: 'Cyclomatic Complexity',
      type: 'complexity',
      threshold,
      blocking,
    };
  },
  
  performance(thresholdMs: number = 1000, blocking: boolean = false): QualityGate {
    return {
      name: 'Performance',
      type: 'performance',
      threshold: thresholdMs,
      blocking,
    };
  },
  
  security(threshold: number = 0, blocking: boolean = true): QualityGate {
    return {
      name: 'Security Scan',
      type: 'security',
      threshold,
      blocking,
      autoFix: false,
    };
  },
  
  lint(maxIssues: number = 0, blocking: boolean = false, autoFix: boolean = true): QualityGate {
    return {
      name: 'Lint Check',
      type: 'lint',
      threshold: maxIssues,
      blocking,
      autoFix,
    };
  },
};

// Helper functions for creating common conditions
export const Conditions = {
  testPassed(): WorkflowCondition {
    return { type: 'test_passed' };
  },
  
  coverageMet(threshold: number = 80): WorkflowCondition {
    return { type: 'coverage_met', threshold };
  },
  
  noErrors(): WorkflowCondition {
    return { type: 'no_errors' };
  },
  
  custom(check: string): WorkflowCondition {
    return { type: 'custom', customCheck: check };
  },
};

// Example usage:
export function createFeatureWorkflow(featureName: string): WorkflowDefinition {
  return new WorkflowBuilder(
    `Feature: ${featureName}`,
    `End-to-end feature development workflow for ${featureName}`
  )
    .addTask('Analyze requirements', {
      acceptance: 'Requirements understood and design approved',
    })
    .addCheckpoint('Pre-implementation checkpoint', {
      message: `chore: checkpoint before ${featureName} implementation`,
      dependsOn: ['task_1'],
    })
    .addTask('Implement feature', {
      acceptance: 'Feature fully implemented with error handling',
      dependsOn: ['checkpoint_2'],
      gates: [QualityGates.complexity(15)],
    })
    .addTask('Write tests', {
      acceptance: 'Tests cover main and edge cases',
      dependsOn: ['task_3'],
      gates: [QualityGates.coverage(80, true)],
    })
    .addParallel('Quality checks', {
      nodes: ['task_6', 'task_7'],
      waitForAll: true,
      dependsOn: ['task_4'],
    })
    .addTask('Lint check', {
      acceptance: 'No lint errors',
      gates: [QualityGates.lint(0, false, true)],
    })
    .addTask('Security scan', {
      acceptance: 'No critical vulnerabilities',
      gates: [QualityGates.security(0, true)],
    })
    .addCondition('Quality gate decision', {
      condition: Conditions.testPassed(),
      // 测试通过 → 直接终验（task_10）；失败 → 先修复（task_9）。
      // 引擎的语义是"未选中的分支被 skip"，所以失败路径以修复收尾，不再回跳
      // 终验 —— 引擎没有 loop-back，写一个被 skip 依赖的终验只会 blocked。
      onTrue: ['task_10'],
      onFalse: ['task_9'],
      dependsOn: ['parallel_5'],
    })
    .addTask('Fix issues', {
      acceptance: 'All quality issues resolved',
      maxRetries: 2,
      dependsOn: ['condition_8'],
    })
    .addTask('Final verification', {
      acceptance: 'All checks pass, feature ready',
      dependsOn: ['condition_8'],
    })
    .enableAutoCheckpoint()
    .enableRollbackOnFailure()
    .setMaxParallelTasks(4)
    .addTags('feature', featureName)
    .build();
}

export function createBugfixWorkflow(bugDescription: string): WorkflowDefinition {
  return new WorkflowBuilder(
    `Bugfix: ${bugDescription}`,
    `Systematic bug fix workflow`
  )
    .addTask('Reproduce bug', {
      acceptance: 'Bug reliably reproducible',
    })
    .addTask('Root cause analysis', {
      acceptance: 'Root cause identified',
      dependsOn: ['task_1'],
    })
    .addCheckpoint('Pre-fix checkpoint', {
      message: 'chore: checkpoint before bug fix',
      dependsOn: ['task_2'],
    })
    .addTask('Implement fix', {
      acceptance: 'Bug no longer reproduces',
      dependsOn: ['checkpoint_3'],
      maxRetries: 2,
    })
    .addTask('Add regression test', {
      acceptance: 'Test fails on old code, passes on fixed code',
      dependsOn: ['task_4'],
    })
    .addGate('Verify no regressions', {
      gates: [
        QualityGates.coverage(0, true),
        QualityGates.lint(0, false, true),
      ],
      dependsOn: ['task_5'],
    })
    .enableRollbackOnFailure()
    .addTags('bugfix')
    .build();
}

export function createRefactorWorkflow(targetCode: string): WorkflowDefinition {
  return new WorkflowBuilder(
    `Refactor: ${targetCode}`,
    `Safe refactoring with behavior preservation`
  )
    .addTask('Analyze code metrics', {
      acceptance: 'Baseline metrics captured',
    })
    .addCheckpoint('Baseline checkpoint', {
      message: 'chore: baseline before refactor',
      dependsOn: ['task_1'],
    })
    .addTask('Add characterization tests', {
      acceptance: 'Current behavior covered by tests',
      dependsOn: ['checkpoint_2'],
    })
    .addTask('Refactor code', {
      acceptance: 'Code refactored with improved structure',
      dependsOn: ['task_3'],
      gates: [QualityGates.complexity(15, false)],
    })
    .addCondition('Test status check', {
      condition: Conditions.testPassed(),
      onTrue: ['task_6'],
      onFalse: ['task_7'],
      dependsOn: ['task_4'],
    })
    .addTask('Verify improved metrics', {
      acceptance: 'Metrics improved, no performance regression',
      dependsOn: ['condition_5'],
    })
    .addTask('Rollback and retry', {
      acceptance: 'Rolled back to baseline',
      maxRetries: 1,
      dependsOn: ['condition_5'],
    })
    .enableAutoCheckpoint()
    .enableRollbackOnFailure()
    .addTags('refactor')
    .build();
}
