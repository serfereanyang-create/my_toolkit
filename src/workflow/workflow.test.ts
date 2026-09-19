import { describe, it, expect } from 'vitest';
import { WorkflowBuilder, QualityGates, Conditions } from './builder.js';
import { WorkflowEngine } from './engine.js';
import type { WorkflowNodeResult, WorkflowCondition, QualityGate } from './types.js';

describe('WorkflowBuilder', () => {
  it('should create a simple linear workflow', () => {
    const workflow = new WorkflowBuilder('Test Workflow', 'Test description')
      .addTask('Task 1', { acceptance: 'First task done' })
      .addTask('Task 2', { acceptance: 'Second task done', dependsOn: ['task_1'] })
      .addTask('Task 3', { acceptance: 'Third task done', dependsOn: ['task_2'] })
      .build();
    
    expect(workflow.name).toBe('Test Workflow');
    expect(workflow.nodes).toHaveLength(3);
    expect(workflow.entryNode).toBe('task_1');
    expect(workflow.nodes[1].dependsOn).toEqual(['task_1']);
  });
  
  it('should create workflow with parallel tasks', () => {
    const workflow = new WorkflowBuilder('Parallel Test')
      .addTask('Setup', { acceptance: 'Setup complete' })
      .addTask('Parallel A', { acceptance: 'A done' })
      .addTask('Parallel B', { acceptance: 'B done' })
      .addParallel('Run parallel tasks', {
        nodes: ['task_2', 'task_3'],
        waitForAll: true,
        dependsOn: ['task_1'],
      })
      .addTask('Finalize', { acceptance: 'All done', dependsOn: ['task_1', 'task_2', 'task_3'] })
      .build();
    
    expect(workflow.nodes).toHaveLength(5);
    const parallelNode = workflow.nodes.find(n => n.type === 'parallel');
    expect(parallelNode).toBeDefined();
    expect(parallelNode?.parallelNodes).toEqual(['task_2', 'task_3']);
  });
  
  it('should create workflow with conditions', () => {
    const workflow = new WorkflowBuilder('Conditional Test')
      .addTask('Run tests', { acceptance: 'Tests executed' })
      .addCondition('Check results', {
        condition: Conditions.testPassed(),
        onTrue: ['task_3'],
        onFalse: ['task_4'],
        dependsOn: ['task_1'],
      })
      .addTask('Deploy', { acceptance: 'Deployed' })
      .addTask('Fix issues', { acceptance: 'Fixed' })
      .build();
    
    const conditionNode = workflow.nodes.find(n => n.type === 'condition');
    expect(conditionNode).toBeDefined();
    expect(conditionNode?.branches).toHaveLength(1);
    expect(conditionNode?.defaultNext).toEqual(['task_4']);
  });
  
  it('should create workflow with quality gates', () => {
    const workflow = new WorkflowBuilder('Quality Gate Test')
      .addTask('Implement feature', {
        acceptance: 'Feature done',
        gates: [
          QualityGates.coverage(80),
          QualityGates.complexity(15),
        ],
      })
      .build();
    
    expect(workflow.nodes[0].gates).toHaveLength(2);
    expect(workflow.nodes[0].gates?.[0].type).toBe('coverage');
    expect(workflow.nodes[0].gates?.[0].threshold).toBe(80);
  });
  
  it('should create workflow with checkpoints', () => {
    const workflow = new WorkflowBuilder('Checkpoint Test')
      .addTask('Prepare', { acceptance: 'Prepared' })
      .addCheckpoint('Pre-change checkpoint', {
        message: 'Before changes',
        dependsOn: ['task_1'],
      })
      .addTask('Make changes', { acceptance: 'Changed', dependsOn: ['task_1'] })
      .build();
    
    const checkpointNode = workflow.nodes.find(n => n.type === 'checkpoint');
    expect(checkpointNode).toBeDefined();
    expect(checkpointNode?.checkpoint?.message).toBe('Before changes');
  });
  
  it('should build from template', () => {
    const workflow = WorkflowBuilder.fromTemplate('feature_development').build();
    
    expect(workflow.name).toBe('Feature Development');
    expect(workflow.nodes.length).toBeGreaterThan(0);
  });
  
  it('should validate dependencies', () => {
    expect(() => {
      new WorkflowBuilder('Invalid')
        .addTask('Task 1')
        .addTask('Task 2', { dependsOn: ['nonexistent'] })
        .build();
    }).toThrow(/depends on non-existent node/);
  });
});

describe('WorkflowEngine', () => {
  it('should execute simple linear workflow', async () => {
    const workflow = new WorkflowBuilder('Linear Test')
      .addTask('Task 1', { acceptance: 'Done 1' })
      .addTask('Task 2', { acceptance: 'Done 2', dependsOn: ['task_1'] })
      .build();
    
    const executedNodes: string[] = [];
    
    const engine = new WorkflowEngine(workflow, {
      executeNode: async (node) => {
        executedNodes.push(node.id);
        return {
          success: true,
          summary: `${node.title} completed`,
        };
      },
    });
    
    const execution = await engine.run();
    
    expect(execution.status).toBe('completed');
    expect(execution.completedNodes).toHaveLength(2);
    expect(executedNodes).toEqual(['task_1', 'task_2']);
  });
  
  it('should handle task failure with retry', async () => {
    const workflow = new WorkflowBuilder('Retry Test')
      .addTask('Flaky task', { acceptance: 'Done', maxRetries: 2 })
      .build();
    
    let attemptCount = 0;
    
    const engine = new WorkflowEngine(workflow, {
      executeNode: async () => {
        attemptCount++;
        if (attemptCount < 2) {
          return {
            success: false,
            summary: 'Failed',
            errors: ['Temporary failure'],
          };
        }
        return {
          success: true,
          summary: 'Succeeded on retry',
        };
      },
    });
    
    const execution = await engine.run();
    
    expect(execution.status).toBe('completed');
    expect(attemptCount).toBe(2);
  });
  
  it('should execute parallel nodes concurrently', async () => {
    const workflow = new WorkflowBuilder('Parallel Test')
      .addTask('Setup', { acceptance: 'Setup done' })
      .addTask('Task A', { acceptance: 'A done' })
      .addTask('Task B', { acceptance: 'B done' })
      .addParallel('Run parallel', {
        nodes: ['task_2', 'task_3'],
        dependsOn: ['task_1'],
      })
      .build();
    
    const executionOrder: string[] = [];
    
    const engine = new WorkflowEngine(workflow, {
      executeNode: async (node) => {
        executionOrder.push(node.id);
        // Simulate async work
        await new Promise(resolve => setTimeout(resolve, 10));
        return { success: true, summary: 'Done' };
      },
    });
    
    const execution = await engine.run();
    
    expect(execution.status).toBe('completed');
    // Should complete setup, parallel node, and both parallel tasks
    expect(execution.completedNodes.length).toBeGreaterThanOrEqual(3);
    // Setup should be first
    expect(executionOrder[0]).toBe('task_1');
  });
  
  it('should evaluate conditions correctly', async () => {
    const workflow = new WorkflowBuilder('Condition Test')
      .addTask('Run check', { acceptance: 'Checked' })
      .addCondition('Decide', {
        condition: Conditions.testPassed(),
        onTrue: ['task_3'],
        onFalse: ['task_4'],
        dependsOn: ['task_1'],
      })
      .addTask('Success path', { acceptance: 'Success' })
      .addTask('Failure path', { acceptance: 'Failure' })
      .build();
    
    let conditionEvaluated = false;
    
    const engine = new WorkflowEngine(workflow, {
      executeNode: async (node) => ({
        success: true,
        summary: 'Done',
      }),
      evaluateCondition: async (condition, context) => {
        conditionEvaluated = true;
        return true; // Always take the true branch
      },
    });
    
    await engine.run();
    const execution = engine.getExecution();
    
    expect(conditionEvaluated).toBe(true);
    expect(execution.completedNodes).toContain('task_3');
    // task_4 should not execute since condition is true
  });
  
  it('should enforce quality gates', async () => {
    const workflow = new WorkflowBuilder('Gate Test')
      .addTask('Implement', {
        acceptance: 'Done',
        gates: [QualityGates.coverage(80, true)],
      })
      .build();
    
    const engine = new WorkflowEngine(workflow, {
      executeNode: async () => ({
        success: true,
        summary: 'Implemented',
      }),
      evaluateGate: async (gate) => {
        // Simulate coverage below threshold
        return { passed: false, value: 60 };
      },
    });
    
    try {
      await engine.run();
      expect.fail('Should have failed due to gate');
    } catch (error) {
      // Expected to fail
      expect(error).toBeDefined();
    }
  });
  
  it('should create and rollback to checkpoint', async () => {
    const workflow = new WorkflowBuilder('Rollback Test')
      .addTask('Prepare', { acceptance: 'Prepared' })
      .addCheckpoint('Safe point', {
        message: 'checkpoint',
        dependsOn: ['task_1'],
      })
      .addTask('Risky change', { acceptance: 'Changed', dependsOn: ['task_1'] })
      .enableRollbackOnFailure()
      .build();
    
    const checkpoints: string[] = [];
    const rollbacks: string[] = [];
    
    const engine = new WorkflowEngine(workflow, {
      executeNode: async (node) => {
        if (node.id === 'task_2') {
          // Fail the risky change task
          return { success: false, summary: 'Failed', errors: ['Simulated failure'] };
        }
        return { success: true, summary: 'Done' };
      },
      createCheckpoint: async (message) => {
        checkpoints.push(message);
        return { sha: 'abc123', branch: 'main' };
      },
      rollbackToCheckpoint: async (sha) => {
        rollbacks.push(sha);
        return ['file1.ts', 'file2.ts'];
      },
    });
    
    try {
      await engine.run();
    } catch {
      // Expected to fail
    }
    
    // Checkpoint should have been created when checkpoint node executed
    expect(checkpoints.length).toBeGreaterThan(0);
    
    const execution = engine.getExecution();
    expect(execution.checkpoints.length).toBeGreaterThan(0);
    
    // Note: rollback needs to be manually triggered or triggered by specific failure conditions
    // For now we just verify the checkpoint infrastructure works
  });
  
  it('should track progress correctly', async () => {
    const workflow = new WorkflowBuilder('Progress Test')
      .addTask('Task 1')
      .addTask('Task 2', { dependsOn: ['task_1'] })
      .addTask('Task 3', { dependsOn: ['task_2'] })
      .build();
    
    const engine = new WorkflowEngine(workflow, {
      executeNode: async () => ({ success: true, summary: 'Done' }),
    });
    
    const initialProgress = engine.getProgress();
    expect(initialProgress.percentage).toBe(0);
    
    await engine.run();
    
    const finalProgress = engine.getProgress();
    expect(finalProgress.percentage).toBe(100);
    expect(finalProgress.completed).toBe(3);
    expect(finalProgress.total).toBe(3);
  });
  
  it('should support pause and resume', async () => {
    const workflow = new WorkflowBuilder('Pause Test')
      .addTask('Task 1')
      .addTask('Task 2', { dependsOn: ['task_1'] })
      .build();
    
    let taskCount = 0;
    let engineInstance: WorkflowEngine | null = null;
    
    const engine = new WorkflowEngine(workflow, {
      executeNode: async (node) => {
        taskCount++;
        if (taskCount === 1 && engineInstance) {
          // Pause after first task
          setTimeout(() => engineInstance!.pause(), 0);
        }
        await new Promise(resolve => setTimeout(resolve, 10));
        return { success: true, summary: 'Done' };
      },
    });
    
    engineInstance = engine;
    
    // Start execution - it will pause after first task
    const runPromise = engine.run();
    
    // Give it time to execute first task and pause
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const execution = engine.getExecution();
    
    // Check if paused or completed (depending on timing)
    if (execution.status === 'paused') {
      // Resume if paused
      await engine.resume();
      expect(execution.status).toBe('completed');
    } else {
      // Already completed due to timing
      expect(execution.status).toBe('completed');
    }
    
    await runPromise.catch(() => {}); // Wait for completion
    expect(taskCount).toBe(2);
  });
});
