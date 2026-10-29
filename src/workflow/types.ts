/**
 * Enhanced workflow engine types - supports branching, parallel execution, and rollback
 */

export type WorkflowNodeType = 'task' | 'condition' | 'parallel' | 'checkpoint' | 'gate';

export type WorkflowCondition = {
  type: 'test_passed' | 'coverage_met' | 'no_errors' | 'custom';
  threshold?: number;
  customCheck?: string; // Expression or tool name to evaluate
};

export type WorkflowBranch = {
  condition: WorkflowCondition;
  nextNodes: string[]; // Node IDs to execute if condition is true
};

export type QualityGate = {
  name: string;
  type: 'coverage' | 'complexity' | 'performance' | 'security' | 'lint';
  threshold: number;
  blocking: boolean; // If true, workflow stops on failure
  autoFix?: boolean; // Attempt automatic fix before failing
};

export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  title: string;
  description?: string;
  
  // Task execution
  prompt?: string;
  acceptance?: string;
  estimatedMinutes?: number;
  
  // Branching
  branches?: WorkflowBranch[];
  defaultNext?: string[]; // Fallback if no condition matches
  
  // Parallel execution
  parallelNodes?: string[]; // Execute these nodes concurrently
  waitForAll?: boolean; // Wait for all parallel nodes to complete
  
  // Checkpoint & rollback
  checkpoint?: {
    createCommit: boolean;
    message: string;
  };
  
  // Quality gates
  gates?: QualityGate[];
  
  // Dependencies
  dependsOn: string[];
  
  // Execution state
  status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped' | 'failed';
  result?: WorkflowNodeResult;
  startedAt?: string;
  finishedAt?: string;
  retryCount?: number;
  maxRetries?: number;
};

export type WorkflowNodeResult = {
  success: boolean;
  summary: string;
  output?: any;
  errors?: string[];
  
  // Quality metrics
  metrics?: {
    coverage?: number;
    complexity?: number;
    duration?: number;
    lintIssues?: number;
  };
  
  // Checkpoint info
  checkpointSha?: string;
  checkpointBranch?: string;
};

export type WorkflowDefinition = {
  id: string;
  name: string;
  description: string;
  version: string;
  
  nodes: WorkflowNode[];
  entryNode: string; // Starting node ID
  
  // Global settings
  maxParallelTasks?: number;
  globalTimeout?: number; // Minutes
  autoCheckpoint?: boolean; // Create checkpoint after each node
  rollbackOnFailure?: boolean;
  
  // Metadata
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  tags?: string[];
};

export type WorkflowExecution = {
  id: string;
  workflowId: string;
  workflowVersion: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  
  currentNodes: string[]; // Currently executing nodes
  completedNodes: string[];
  failedNodes: string[];
  /** Nodes that could not run because a dependency failed, was skipped, or was invalid. */
  blockedNodes?: string[];
  /** Nodes deliberately excluded by a condition branch. */
  skippedNodes?: string[];
  
  checkpoints: WorkflowCheckpoint[];
  rollbacks: WorkflowRollback[];
  
  startedAt: string;
  finishedAt?: string;
  pausedAt?: string;
  
  // Context passed between nodes
  context: Record<string, any>;
  
  // Git state
  initialBranch?: string;
  initialCommit?: string;
  workingBranch?: string;
};

export type WorkflowCheckpoint = {
  id: string;
  nodeId: string;
  commitSha: string;
  branch: string;
  createdAt: string;
  metrics?: Record<string, number>;
};

export type WorkflowRollback = {
  id: string;
  fromNodeId: string;
  toCheckpointId: string;
  reason: string;
  performedAt: string;
  filesRestored: string[];
};

export type WorkflowTemplate = {
  name: string;
  description: string;
  category: 'feature' | 'bugfix' | 'refactor' | 'test' | 'deploy' | 'custom';
  nodes: Omit<WorkflowNode, 'id' | 'status' | 'result' | 'startedAt' | 'finishedAt'>[];
};

// Predefined workflow templates
export const WORKFLOW_TEMPLATES: Record<string, WorkflowTemplate> = {
  feature_development: {
    name: 'Feature Development',
    description: 'Complete feature development workflow with testing and quality gates',
    category: 'feature',
    nodes: [
      {
        type: 'task',
        title: 'Analyze requirements and existing code',
        dependsOn: [],
        acceptance: 'Requirements understood and relevant code identified',
      },
      {
        type: 'checkpoint',
        title: 'Pre-implementation checkpoint',
        dependsOn: ['task_1'],
        checkpoint: {
          createCommit: true,
          message: 'chore: checkpoint before feature implementation',
        },
      },
      {
        type: 'task',
        title: 'Implement core feature logic',
        dependsOn: ['checkpoint_2'],
        acceptance: 'Feature implemented with proper error handling',
      },
      {
        type: 'task',
        title: 'Write comprehensive tests',
        dependsOn: ['task_3'],
        acceptance: 'Unit and integration tests cover main paths',
        gates: [
          {
            name: 'Coverage gate',
            type: 'coverage',
            threshold: 80,
            blocking: true,
          },
        ],
      },
    ],
  },
  
  bugfix: {
    name: 'Bug Fix',
    description: 'Systematic bug fix with root cause analysis',
    category: 'bugfix',
    nodes: [
      {
        type: 'task',
        title: 'Reproduce and isolate bug',
        dependsOn: [],
        acceptance: 'Bug reliably reproducible with minimal test case',
      },
      {
        type: 'task',
        title: 'Root cause analysis',
        dependsOn: ['task_1'],
        acceptance: 'Root cause identified and fix strategy determined',
      },
      {
        type: 'checkpoint',
        title: 'Pre-fix checkpoint',
        dependsOn: ['task_2'],
        checkpoint: {
          createCommit: true,
          message: 'chore: checkpoint before bug fix',
        },
      },
      {
        type: 'task',
        title: 'Implement fix',
        dependsOn: ['checkpoint_3'],
        acceptance: 'Fix applied and bug no longer reproduces',
        maxRetries: 2,
      },
      {
        type: 'task',
        title: 'Add regression test',
        dependsOn: ['task_4'],
        acceptance: 'Test fails on old code, passes on fixed code',
      },
      {
        type: 'task' as WorkflowNodeType,
        title: 'Verify no new regressions',
        dependsOn: ['task_5'],
        gates: [
          {
            name: 'Full test suite',
            type: 'coverage',
            threshold: 0,
            blocking: true,
          },
        ],
      },
    ],
  },
  
  refactor: {
    name: 'Code Refactoring',
    description: 'Safe refactoring with behavior preservation',
    category: 'refactor',
    nodes: [
      {
        type: 'task',
        title: 'Analyze code smells and metrics',
        dependsOn: [],
        acceptance: 'Target code identified with complexity/smell metrics',
      },
      {
        type: 'checkpoint',
        title: 'Baseline checkpoint',
        dependsOn: ['task_1'],
        checkpoint: {
          createCommit: true,
          message: 'chore: baseline before refactor',
        },
      },
      {
        type: 'task',
        title: 'Add characterization tests if missing',
        dependsOn: ['checkpoint_2'],
        acceptance: 'Current behavior covered by tests',
      },
      {
        type: 'task',
        title: 'Refactor implementation',
        dependsOn: ['task_3'],
        acceptance: 'Code refactored with improved structure',
        gates: [
          {
            name: 'Complexity reduction',
            type: 'complexity',
            threshold: 15,
            blocking: false,
          },
        ],
      },
      {
        type: 'condition',
        title: 'Check test status',
        dependsOn: ['task_4'],
        branches: [
          {
            condition: { type: 'test_passed' },
            // Tests pass → verify metrics (task_7); they fail → roll back (task_6).
            nextNodes: ['task_7'],
          },
        ],
        defaultNext: ['task_6'],
      },
      {
        type: 'task',
        title: 'Rollback and retry',
        dependsOn: ['condition_5'],
        acceptance: 'Rolled back to baseline',
        maxRetries: 1,
      },
      {
        type: 'task',
        title: 'Verify improved metrics',
        dependsOn: ['condition_5'],
        acceptance: 'Complexity reduced, no performance regression',
      },
    ],
  },
};
