import { recentActivityTool } from './activity.js';
import { diskInfoTool } from './disk.js';
import { createDocxTool } from './docx.js';
import { environmentInfoTool } from './environment.js';
import { gitDiffTool, gitLogTool, gitStatusTool } from './git.js';
import { diskGrowthTool } from './growth.js';
import { applyPatchTool } from './patch.js';
import { processMemoryTool } from './process.js';
import { projectIndexTool } from './projectIndex.js';
import { renameFileTool } from './rename.js';
import { projectStatusTool, listFilesTool, readFileTool, writeFileTool } from './files.js';
import { ToolRegistry } from './registry.js';
import { searchTextTool } from './search.js';
import { runCommandTool } from './shell.js';

export function createDefaultToolRegistry() {
  const registry = new ToolRegistry();
  registry.register(projectStatusTool);
  registry.register(recentActivityTool);
  registry.register(environmentInfoTool);
  registry.register(projectIndexTool);
  registry.register(gitStatusTool);
  registry.register(gitDiffTool);
  registry.register(gitLogTool);
  registry.register(listFilesTool);
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(searchTextTool);
  registry.register(processMemoryTool);
  registry.register(diskInfoTool);
  registry.register(diskGrowthTool);
  registry.register(runCommandTool);
  registry.register(createDocxTool);
  registry.register(renameFileTool);
  registry.register(applyPatchTool);
  return registry;
}

export { ToolRegistry } from './registry.js';
export type { ToolDefinition, ToolResult, ToolContext } from './types.js';
