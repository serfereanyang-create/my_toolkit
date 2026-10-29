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
import { flushBackgroundWrites } from '../agent/agent.js';
import type { AgentRuntime } from '../agent/agent.js';

/**
 * Config-supplied tool scope, validated at the trust boundary.
 *
 * `normalizeToolScope` cannot be used here: it maps anything outside the three
 * *resolved* scopes — `'auto'` included — to `'compact'`, which would silently
 * turn every default runtime into a compact one. Config is hand-editable JSON
 * and a stale desktop preference file can carry anything, so an unknown value
 * falls back to the documented default rather than travelling on a cast.
 */
export function scopeOrAuto(value: unknown): ToolScope {
  return value === 'auto' || value === 'compact' || value === 'standard' || value === 'full'
    ? value
    : 'auto';
}

export async function createAgentRuntime(config: AppConfig) {
  const provider = createProvider(config);
  const allTools = createDefaultToolRegistry({ excelAutomation: config.excelAutomation === true });
  for (const tool of await loadPluginTools(config.workspaceRoot)) allTools.register(tool);
  const existingNames = new Set(allTools.list().map((tool) => tool.name));
  // This spawns MCP server processes before anything else can fail. `close()`
  // only knows about resources that made it into the returned object, so a
  // throw between here and the `return` used to leave those child processes
  // running until the whole process exited (and, in tests, all the way into
  // the next case).
  const mcp = await loadMcpManager({ workspaceRoot: config.workspaceRoot, existingNames });
  try {
    return await buildRuntime(config, provider, allTools, mcp);
  } catch (error) {
    await mcp.close().catch(() => undefined);
    throw error;
  }
}

async function buildRuntime(
  config: AppConfig,
  provider: ReturnType<typeof createProvider>,
  allTools: ReturnType<typeof createDefaultToolRegistry>,
  initialMcp: Awaited<ReturnType<typeof loadMcpManager>>,
) {
  let mcp = initialMcp;
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
    // persist: false — a fresh process has no conversation yet. Writing the
    // record here put an empty session in the sidebar for every launch (app
    // starts, spawned children, test harnesses); the first turn creates the file.
    : await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: config.workspaceRoot, persist: false });
  if (config.resumeSessionId && session.lastTurn?.status === 'running') session.providerContinuation = undefined;
  // Only the Responses API accepts a `previous_response_id`. A record written
  // while the session ran on that provider, resumed on any other one (the
  // model/provider flags are not persisted), would send a continuation the new
  // provider silently ignores — or rejects. The saved message history is the
  // only resume state every provider understands, so drop the chain here.
  if (session.providerContinuation && provider.name !== 'openai-responses') session.providerContinuation = undefined;
  // A resume builds the provider from THIS process's flags, never from the
  // record, so the record's provider/model described a runtime that no longer
  // exists. `/list`, `recent_activity` and the audit ledger all present those
  // fields as "what this conversation runs on"; stamp the live identity so a
  // session resumed under a different provider/model does not keep claiming the
  // old one. The per-turn usage ledger still holds the historical provider.
  if (config.resumeSessionId) {
    session.provider = provider.name;
    session.model = provider.model;
  }

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
    // The `as ToolScope` this used to carry was a lie when config came from a
    // hand-edited file or a stale desktop preference: the value reached the
    // resolver unvalidated. This is the last entrance, so it gets the same
    // four-value whitelist args/env/config/bridge already apply — and unlike
    // `normalizeToolScope`, `'auto'` stays `'auto'`, because that is a legal
    // user choice the per-turn resolver is supposed to interpret.
    toolScope: scopeOrAuto(config.toolScope),
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
      // The last turn's memory entry and reflexion lesson are written after the
      // answer is delivered. Let them land before the process (or the caller's
      // temp workspace) goes away, instead of racing the exit.
      try { await flushBackgroundWrites(); } catch (error) {
        closeErrors.push(`background writes: ${error instanceof Error ? error.message : String(error)}`);
      }
      try { await mcp.close(); } catch (error) {
        closeErrors.push(`mcp: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (closeErrors.length > 0) throw new Error(`Runtime close failures: ${closeErrors.join('; ')}`);
    },
  };
}
