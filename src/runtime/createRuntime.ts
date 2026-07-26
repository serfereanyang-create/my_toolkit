import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../config/types.js';
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
import { SessionStore } from '../session/store.js';
import { createDefaultToolRegistry } from '../tools/index.js';
import { TerminalUI } from '../ui/terminal.js';

export async function createAgentRuntime(config: AppConfig) {
  const provider = createProvider(config);
  const tools = createDefaultToolRegistry();
  for (const tool of await loadPluginTools(config.workspaceRoot)) tools.register(tool);
  const existingNames = new Set(tools.list().map((tool) => tool.name));
  let mcp = await loadMcpManager({ workspaceRoot: config.workspaceRoot, existingNames });
  for (const tool of mcp.tools) {
    try {
      tools.register(tool);
    } catch {
      // A plugin/MCP collision should not prevent the core agent from starting.
    }
  }

  const version = await packageVersion();
  const ui = new TerminalUI({
    quiet: config.quiet,
    json: config.json,
    noColor: config.noColor,
    verbose: config.verbose,
    homeScreen: !config.prompt && !config.ci && !config.json && !config.desktopBridge,
    version,
  });

  const sessions = new SessionStore(config.sessionDir);
  const checkpoints = new CheckpointStore(config.workspaceRoot);
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
  const runtime = {
    config,
    provider,
    tools,
    sessions,
    checkpoints,
    session,
    ui,
    hooks,
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
      const existingToolNames = new Set(
        tools.list().filter((tool) => !tool.name.startsWith('mcp_')).map((tool) => tool.name),
      );
      const next = await loadMcpManager({ workspaceRoot: config.workspaceRoot, existingNames: existingToolNames });
      for (const tool of next.tools) tools.register(tool, { replace: true });
      mcp = next;
      return mcp;
    },
  };

  return {
    provider,
    tools,
    ui,
    runtime,
    mcpStatuses: mcp.statuses,
    async close() {
      await mcp.close();
    },
  };
}

async function packageVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageJson = JSON.parse(await readFile(resolve(here, '../../package.json'), 'utf8')) as { version?: string };
  return packageJson.version ?? '0.0.0';
}
