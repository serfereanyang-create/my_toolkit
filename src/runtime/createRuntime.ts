import type { AppConfig } from '../config/types.js';
import { readPackageVersion } from './packageVersion.js';
import { GitAuditLog } from '../git-safety/audit.js';
import { GitSnapshotDiff } from '../git-safety/diff.js';
import { GitProcess } from '../git-safety/git.js';
import { LocalGitPublisher } from '../git-safety/publisher.js';
import { GitRepository } from '../git-safety/repository.js';
import { GitRollbackService } from '../git-safety/rollback.js';
import { GitSafetyService } from '../git-safety/service.js';
import { GitSnapshotStore } from '../git-safety/snapshot.js';
import { createNoopHooks } from '../hooks/hooks.js';
import { loadMcpManager } from '../mcp/manager.js';
import { loadPluginTools } from '../plugins/loader.js';
import { createProvider } from '../providers/index.js';
import { CheckpointStore } from '../session/checkpoint.js';
import { ProjectMemoryStore } from '../memory/store.js';
import { ReflectionStore } from '../reflection/store.js';
import { SessionStore } from '../session/store.js';
import { TaskBoardStore } from '../tasks/store.js';
import { createDefaultToolRegistry } from '../tools/index.js';
import { type ToolScope } from '../tools/scope.js';
import { TerminalUI } from '../ui/terminal.js';
import { CommandJobManager } from '../safety/commandJobs.js';
import type { AgentRuntime } from '../agent/agent.js';

export async function createAgentRuntime(config: AppConfig) {
  const provider = createProvider(config);
  const allTools = createDefaultToolRegistry({ excelAutomation: config.excelAutomation === true });
  for (const tool of await loadPluginTools(config.workspaceRoot)) allTools.register(tool);
  const existingNames = new Set(allTools.list().map((tool) => tool.name));
  let mcp = await loadMcpManager({ workspaceRoot: config.workspaceRoot, existingNames });
  for (const tool of mcp.tools) {
    try {
      allTools.register(tool);
    } catch {
      // A plugin/MCP collision should not prevent the core agent from starting.
    }
  }

  const version = await readPackageVersion(import.meta.url);
  const ui = new TerminalUI({
    quiet: config.quiet,
    json: config.json,
    noColor: config.noColor,
    verbose: config.verbose,
    version,
  });

  const sessions = new SessionStore(config.sessionDir);
  const checkpoints = new CheckpointStore(config.workspaceRoot);
  const memory = new ProjectMemoryStore(config.workspaceRoot);
  const reflections = new ReflectionStore(config.workspaceRoot);
  const gitProcess = new GitProcess(config.workspaceRoot);
  const gitAudit = new GitAuditLog(config.workspaceRoot);
  const gitRepository = new GitRepository(config.workspaceRoot, gitProcess);
  const gitSnapshots = new GitSnapshotStore(gitProcess, config.workspaceRoot);
  const gitDiff = new GitSnapshotDiff(gitProcess);
  const gitSafety = new GitSafetyService(config.workspaceRoot, gitRepository, gitSnapshots, gitDiff, gitAudit);
  const gitRollback = new GitRollbackService(config.workspaceRoot, gitRepository, gitSnapshots, gitDiff, gitAudit);
  const gitPublisher = new LocalGitPublisher(config.workspaceRoot, gitProcess, gitAudit);
  const session = config.resumeSessionId
    ? await sessions.load(config.resumeSessionId)
    : await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: config.workspaceRoot });

  const hooks = createNoopHooks();
  const commandJobs = new CommandJobManager();

  // Crash recovery (D4): tasks left in_progress by a previous process are
  // marked blocked with the reason, so a fresh start never silently resumes
  // half-executed work. Best-effort — never blocks startup.
  try {
    const recoveredBoards = await new TaskBoardStore(config.workspaceRoot).recoverInterrupted();
    if (recoveredBoards.length > 0) {
      const taskWord = recoveredBoards.length === 1 ? 'task board' : 'task boards';
      ui.info(`Recovered ${recoveredBoards.length} interrupted ${taskWord}: in-progress tasks were marked blocked.`);
    }
  } catch { /* recovery is best-effort */ }

  const runtime: AgentRuntime = {
    config,
    provider,
    tools: allTools,
    allTools,
    sessions,
    checkpoints,
    memory,
    reflections,
    session,
    ui,
    hooks,
    commandJobs,
    toolScope: (config.toolScope ?? 'auto') as ToolScope,
    gitSafety,
    gitRollback,
    gitPublisher,
    gitProcess,
    gitRepository,
    get mcp() {
      return mcp;
    },
    async reloadMcp() {
      await mcp.close();
      // Remove exactly the MCP tools owned by the old manager. Keeping a broad
      // startsWith('mcp_') filter could delete plugin/core tools with a similar
      // name and still leave colliding old names in edge cases.
      for (const name of mcp.toolNames) allTools.unregister(name);
      const existingToolNames = new Set(allTools.list().map((tool) => tool.name));
      const next = await loadMcpManager({ workspaceRoot: config.workspaceRoot, existingNames: existingToolNames });
      for (const tool of next.tools) allTools.register(tool, { replace: true });
      mcp = next;
      return mcp;
    },
  };

  return {
    provider,
    allTools,
    tools: allTools,
    ui,
    runtime,
    mcpStatuses: mcp.statuses,
    async close() {
      const closeErrors: string[] = [];
      // The automation manager is created lazily by /automate commands; stop
      // its watchers/monitors/cron registrations if it was ever created.
      if (runtime.automationManager) {
        try { await runtime.automationManager.close(); } catch (error) {
          closeErrors.push(`automation: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try { await commandJobs.close(); } catch (error) {
        closeErrors.push(`commandJobs: ${error instanceof Error ? error.message : String(error)}`);
      }
      try { await mcp.close(); } catch (error) {
        closeErrors.push(`mcp: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (closeErrors.length > 0) throw new Error(`Runtime close failures: ${closeErrors.join('; ')}`);
    },
  };
}
