/**
 * Workflow storage and persistence
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowDefinition, WorkflowExecution } from './types.js';

export class WorkflowStore {
  private workflowsDir: string;
  private executionsDir: string;
  
  constructor(baseDir: string) {
    this.workflowsDir = join(baseDir, 'workflows');
    this.executionsDir = join(baseDir, 'executions');
    
    this.ensureDirectories();
  }
  
  private ensureDirectories(): void {
    if (!existsSync(this.workflowsDir)) {
      mkdirSync(this.workflowsDir, { recursive: true });
    }
    if (!existsSync(this.executionsDir)) {
      mkdirSync(this.executionsDir, { recursive: true });
    }
  }
  
  // Workflow operations
  
  saveWorkflow(workflow: WorkflowDefinition): void {
    const filePath = join(this.workflowsDir, `${workflow.id}.json`);
    writeFileSync(filePath, JSON.stringify(workflow, null, 2), 'utf-8');
  }
  
  loadWorkflow(workflowId: string): WorkflowDefinition | null {
    const filePath = join(this.workflowsDir, `${workflowId}.json`);
    
    if (!existsSync(filePath)) {
      return null;
    }
    
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as WorkflowDefinition;
  }
  
  listWorkflows(): WorkflowDefinition[] {
    if (!existsSync(this.workflowsDir)) {
      return [];
    }
    
    const files = readdirSync(this.workflowsDir).filter(f => f.endsWith('.json'));
    
    return files
      .map(file => {
        try {
          const content = readFileSync(join(this.workflowsDir, file), 'utf-8');
          return JSON.parse(content) as WorkflowDefinition;
        } catch {
          return null;
        }
      })
      .filter((w): w is WorkflowDefinition => w !== null);
  }
  
  deleteWorkflow(workflowId: string): boolean {
    const filePath = join(this.workflowsDir, `${workflowId}.json`);
    
    if (!existsSync(filePath)) {
      return false;
    }
    
    try {
      const fs = require('node:fs');
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }
  
  // Execution operations
  
  saveExecution(execution: WorkflowExecution): void {
    const filePath = join(this.executionsDir, `${execution.id}.json`);
    writeFileSync(filePath, JSON.stringify(execution, null, 2), 'utf-8');
  }
  
  loadExecution(executionId: string): WorkflowExecution | null {
    const filePath = join(this.executionsDir, `${executionId}.json`);
    
    if (!existsSync(filePath)) {
      return null;
    }
    
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as WorkflowExecution;
  }
  
  listExecutions(workflowId?: string): WorkflowExecution[] {
    if (!existsSync(this.executionsDir)) {
      return [];
    }
    
    const files = readdirSync(this.executionsDir).filter(f => f.endsWith('.json'));
    
    let executions = files
      .map(file => {
        try {
          const content = readFileSync(join(this.executionsDir, file), 'utf-8');
          return JSON.parse(content) as WorkflowExecution;
        } catch {
          return null;
        }
      })
      .filter((e): e is WorkflowExecution => e !== null);
    
    if (workflowId) {
      executions = executions.filter(e => e.workflowId === workflowId);
    }
    
    // Sort by start time, newest first
    executions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    
    return executions;
  }
  
  deleteExecution(executionId: string): boolean {
    const filePath = join(this.executionsDir, `${executionId}.json`);
    
    if (!existsSync(filePath)) {
      return false;
    }
    
    try {
      const fs = require('node:fs');
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }
  
  // Query operations
  
  findWorkflowsByTag(tag: string): WorkflowDefinition[] {
    return this.listWorkflows().filter(w => w.tags?.includes(tag));
  }
  
  findWorkflowsByCategory(category: string): WorkflowDefinition[] {
    return this.listWorkflows().filter(w => {
      // Check if workflow name or tags contain category
      const nameMatch = w.name.toLowerCase().includes(category.toLowerCase());
      const tagMatch = w.tags?.some(t => t.toLowerCase().includes(category.toLowerCase()));
      return nameMatch || tagMatch;
    });
  }
  
  getExecutionStats(workflowId: string): {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    avgDurationMinutes: number;
  } {
    const executions = this.listExecutions(workflowId);
    
    const completed = executions.filter(e => e.status === 'completed').length;
    const failed = executions.filter(e => e.status === 'failed').length;
    const cancelled = executions.filter(e => e.status === 'cancelled').length;
    
    const durations = executions
      .filter(e => e.finishedAt)
      .map(e => {
        const start = new Date(e.startedAt).getTime();
        const end = new Date(e.finishedAt!).getTime();
        return (end - start) / 1000 / 60; // minutes
      });
    
    const avgDurationMinutes = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;
    
    return {
      total: executions.length,
      completed,
      failed,
      cancelled,
      avgDurationMinutes: Math.round(avgDurationMinutes * 10) / 10,
    };
  }
  
  getRecentExecutions(limit: number = 10): WorkflowExecution[] {
    return this.listExecutions().slice(0, limit);
  }
  
  getActiveExecutions(): WorkflowExecution[] {
    return this.listExecutions().filter(e => 
      e.status === 'running' || e.status === 'paused'
    );
  }
}
