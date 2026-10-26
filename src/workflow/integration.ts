/**
 * Integration layer between workflow engine and agent runtime
 */

import type { AgentRuntime } from '../agent/agent.js';
import { runAgentTurn } from '../agent/agent.js';
import type { ToolContext } from '../tools/types.js';
import { WorkflowEngine, type WorkflowEngineOptions } from './engine.js';
import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeResult,
  WorkflowCondition,
  QualityGate,
  WorkflowExecution,
} from './types.js';
import { WorkflowStore } from './store.js';
import { spawnSync } from 'node:child_process';
import { measureGate } from './gates.js';

export type WorkflowIntegrationOptions = {
  runtime: AgentRuntime;
  context: ToolContext;
  workspaceDir: string;
  onProgress?: (execution: WorkflowExecution) => void;
};

export class WorkflowIntegration {
  private runtime: AgentRuntime;
  private workspaceDir: string;
  private store: WorkflowStore;
  private onProgress?: (execution: WorkflowExecution) => void;
  
  constructor(options: WorkflowIntegrationOptions) {
    this.runtime = options.runtime;
    this.workspaceDir = options.workspaceDir;
    this.onProgress = options.onProgress;
    
    // Initialize store in workspace .aicode directory
    const storeDir = `${this.workspaceDir}/.aicode/workflows`;
    this.store = new WorkflowStore(storeDir);
  }
  
  async executeWorkflow(workflow: WorkflowDefinition): Promise<WorkflowExecution> {
    // Save workflow definition
    this.store.saveWorkflow(workflow);
    
    const engineOptions: WorkflowEngineOptions = {
      onNodeStart: (execution, node) => {
        console.log(`[Workflow] Starting node: ${node.title}`);
        this.store.saveExecution(execution);
        this.onProgress?.(execution);
      },
      
      onNodeComplete: (execution, node, result) => {
        console.log(`[Workflow] Completed node: ${node.title} - ${result.summary}`);
        this.store.saveExecution(execution);
        this.onProgress?.(execution);
      },
      
      onNodeFailed: (execution, node, error) => {
        console.error(`[Workflow] Failed node: ${node.title} - ${error}`);
        this.store.saveExecution(execution);
        this.onProgress?.(execution);
      },
      
      onCheckpoint: (execution, checkpoint) => {
        console.log(`[Workflow] Checkpoint created: ${checkpoint.commitSha.slice(0, 8)}`);
        this.store.saveExecution(execution);
        this.onProgress?.(execution);
      },
      
      onRollback: (execution, rollback) => {
        console.log(`[Workflow] Rolled back to ${rollback.toCheckpointId}: ${rollback.reason}`);
        this.store.saveExecution(execution);
        this.onProgress?.(execution);
      },
      
      executeNode: async (node, context) => this.executeNodeWithAgent(node, context),
      evaluateCondition: async (condition, context) => this.evaluateConditionInternal(condition, context),
      evaluateGate: async (gate, context) => this.evaluateGateInternal(gate, context),
      createCheckpoint: async (message) => this.createGitCheckpoint(message),
      rollbackToCheckpoint: async (sha) => this.rollbackToGitCommit(sha),
    };
    
    const engine = new WorkflowEngine(workflow, engineOptions);
    const execution = await engine.run();
    
    // Save final execution state
    this.store.saveExecution(execution);
    
    return execution;
  }
  
  private async executeNodeWithAgent(
    node: WorkflowNode,
    context: Record<string, any>
  ): Promise<WorkflowNodeResult> {
    if (node.type !== 'task') {
      return {
        success: false,
        summary: 'Only task nodes can be executed by agent',
        errors: ['Invalid node type for agent execution'],
      };
    }
    
    // Build prompt for the agent
    const prompt = this.buildTaskPrompt(node, context);
    
    try {
      // Execute using agent's turn mechanism
      const result = await this.executeAgentTurn(prompt);
      
      return {
        success: result.ok,
        summary: result.summary ?? 'Task completed',
        output: result.output,
        errors: result.ok ? undefined : [result.error ?? 'Task failed'],
      };
      
    } catch (error) {
      return {
        success: false,
        summary: 'Agent execution failed',
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }
  
  private buildTaskPrompt(node: WorkflowNode, context: Record<string, any>): string {
    const parts: string[] = [
      `Task: ${node.title}`,
    ];
    
    if (node.description) {
      parts.push(`Description: ${node.description}`);
    }
    
    if (node.prompt) {
      parts.push(`Instructions: ${node.prompt}`);
    }
    
    if (node.acceptance) {
      parts.push(`Acceptance criteria: ${node.acceptance}`);
    }
    
    // Add context from previous nodes
    const contextKeys = Object.keys(context).filter(k => k.startsWith('task_') || k.startsWith('checkpoint_'));
    if (contextKeys.length > 0) {
      parts.push('\nContext from previous steps:');
      contextKeys.forEach(key => {
        const value = context[key];
        if (value && typeof value === 'object' && 'summary' in value) {
          parts.push(`- ${key}: ${value.summary}`);
        }
      });
    }
    
    parts.push('\nWhen complete, provide a brief summary of what was done.');
    
    return parts.join('\n');
  }
  
  private async executeAgentTurn(prompt: string): Promise<{
    ok: boolean;
    summary?: string;
    output?: any;
    error?: string;
  }> {
    try {
      const result = await runAgentTurn(this.runtime, prompt);
      const summary = (result.finalAnswer ?? (result.ok ? 'Task completed' : result.reason ?? 'Task failed'))
        .replace(/\s+/g, ' ')
        .slice(0, 500);
      return {
        ok: result.ok,
        summary,
        output: { finalAnswer: result.finalAnswer },
        error: result.ok ? undefined : result.reason,
      };
    } catch (error) {
      return {
        ok: false,
        summary: 'Agent execution failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  
  private async evaluateConditionInternal(
    condition: WorkflowCondition,
    context: Record<string, any>
  ): Promise<boolean> {
    switch (condition.type) {
      case 'test_passed': {
        // Check if tests passed by looking at last test execution result
        const lastTest = context.lastTestResult;
        return lastTest?.success === true;
      }
      
      case 'coverage_met': {
        const coverage = context.lastCoverage ?? 0;
        const threshold = condition.threshold ?? 80;
        return coverage >= threshold;
      }
      
      case 'no_errors': {
        const errors = context.lastErrors ?? [];
        return errors.length === 0;
      }
      
      case 'custom': {
        if (!condition.customCheck) {
          return false;
        }
        
        // Evaluate custom expression
        // In production, this would use a safe expression evaluator
        try {
          // Simple property access for now
          const keys = condition.customCheck.split('.');
          let value: any = context;
          for (const key of keys) {
            value = value?.[key];
          }
          return Boolean(value);
        } catch {
          return false;
        }
      }
      
      default:
        return false;
    }
  }
  
  private async evaluateGateInternal(
    gate: QualityGate,
    _context: Record<string, any>
  ): Promise<{ passed: boolean; value: number; error?: string }> {
    // Real measurements live in gates.ts so workflow_execute tools share them.
    return measureGate(gate, this.workspaceDir);
  }
  
  
  private async createGitCheckpoint(message: string): Promise<{ sha: string; branch: string }> {
    try {
      // Get current branch - use argument array to prevent injection
      const branchResult = spawnSync('git', ['branch', '--show-current'], {
        cwd: this.workspaceDir,
        encoding: 'utf-8',
      });
      
      if (branchResult.status !== 0) {
        throw new Error(`Failed to get branch: ${branchResult.stderr}`);
      }
      
      const branch = branchResult.stdout.trim();
      
      // Stage all files
      const addResult = spawnSync('git', ['add', '-A'], {
        cwd: this.workspaceDir,
      });
      
      if (addResult.status !== 0) {
        throw new Error(`Failed to stage files: ${addResult.stderr}`);
      }
      
      // Create commit - message passed as separate argument (safe from injection)
      const commitResult = spawnSync('git', ['commit', '-m', message], {
        cwd: this.workspaceDir,
      });
      
      if (commitResult.status !== 0) {
        throw new Error(`Failed to commit: ${commitResult.stderr}`);
      }
      
      // Get commit SHA
      const shaResult = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.workspaceDir,
        encoding: 'utf-8',
      });
      
      if (shaResult.status !== 0) {
        throw new Error(`Failed to get commit SHA: ${shaResult.stderr}`);
      }
      
      const sha = shaResult.stdout.trim();
      
      return { sha, branch };
      
    } catch (error) {
      throw new Error(`Failed to create checkpoint: ${error}`);
    }
  }
  
  private async rollbackToGitCommit(sha: string): Promise<string[]> {
    try {
      // Get list of changed files before reset
      const diffResult = spawnSync('git', ['diff', '--name-only', 'HEAD'], {
        cwd: this.workspaceDir,
        encoding: 'utf-8',
      });
      
      const changedFiles = diffResult.status === 0
        ? diffResult.stdout.split('\n').filter(Boolean)
        : [];
      
      // Reset to checkpoint - sha passed as separate argument (safe from injection)
      const resetResult = spawnSync('git', ['reset', '--hard', sha], {
        cwd: this.workspaceDir,
      });
      
      if (resetResult.status !== 0) {
        throw new Error(`Git reset failed: ${resetResult.stderr}`);
      }
      
      return changedFiles;
      
    } catch (error) {
      throw new Error(`Failed to rollback to ${sha}: ${error}`);
    }
  }
  
  getStore(): WorkflowStore {
    return this.store;
  }
}
