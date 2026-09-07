// Sub-agent system — public API
export { runSubAgent } from './runner.js';
export { runSubAgentBatch } from './orchestrator.js';
export { createSpawnSubagentTool } from './tool.js';
export type { SubAgentSpec, SubAgentResult, SubAgentBatchInput } from './types.js';
