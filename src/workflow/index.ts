/**
 * Workflow module exports
 */

export { WorkflowEngine } from './engine.js';
export { WorkflowBuilder, QualityGates, Conditions, createFeatureWorkflow, createBugfixWorkflow, createRefactorWorkflow } from './builder.js';
export { WorkflowStore } from './store.js';
export { WorkflowIntegration } from './integration.js';
export { workflowTools } from './tools.js';
export {
  ChangeDetector,
  DependencyGraphBuilder,
  ImpactAnalyzer,
  IncrementalCacheManager,
  analyzeProjectImpact,
  parseDiffOutput,
  stripExtension,
  slashJoin,
  resolveImportAgainstFileSet,
  extractImports,
  extractExports,
  hashContent,
  generateRecommendations,
} from './incremental.js';
export { WorkflowPerformanceAnalyzer, WorkflowOptimizer } from './performance.js';

export type {
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowNode,
  WorkflowNodeResult,
  WorkflowNodeType,
  WorkflowCondition,
  WorkflowBranch,
  QualityGate,
  WorkflowCheckpoint,
  WorkflowRollback,
  WorkflowTemplate,
} from './types.js';

export { WORKFLOW_TEMPLATES } from './types.js';

export type {
  FileChange,
  DependencyGraph,
  DependencyNode,
  ImpactAnalysisResult,
  ImpactScope,
  IncrementalCacheData,
  TestCacheEntry,
} from './incremental.js';

export type {
  PerformanceMetrics,
  NodeMetrics,
  Bottleneck,
  Recommendation,
} from './performance.js';
