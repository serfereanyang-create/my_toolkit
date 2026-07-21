#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { completionScript } from './cli/completion.js';
import { formatDoctor, runDoctor } from './cli/doctor.js';
import { parseArgs } from './cli/args.js';
import { runPromptMode, runRepl } from './cli/repl.js';
import { loadConfig, requireProviderAuth } from './config/config.js';
import { GitAuditLog } from './git-safety/audit.js';
import { GitSnapshotDiff } from './git-safety/diff.js';
import { GitProcess } from './git-safety/git.js';
import { LocalGitPublisher } from './git-safety/publisher.js';
import { GitRepository } from './git-safety/repository.js';
import { GitRollbackService } from './git-safety/rollback.js';
import { GitSafetyService } from './git-safety/service.js';
import { GitSnapshotStore } from './git-safety/snapshot.js';
import { createNoopHooks } from './hooks/hooks.js';
import { loadPluginTools } from './plugins/loader.js';
import { createProvider } from './providers/index.js';
import { CheckpointStore } from './session/checkpoint.js';
import { SessionStore } from './session/store.js';
import { createDefaultToolRegistry } from './tools/index.js';
import { TerminalUI } from './ui/terminal.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args);

  if (config.version) {
    process.stdout.write(`${await packageVersion()}\n`);
    return;
  }

  if (config.completionShell) {
    process.stdout.write(completionScript(config.completionShell));
    return;
  }

  const provider = createProvider(config);
  const tools = createDefaultToolRegistry();
  for (const tool of await loadPluginTools(config.workspaceRoot)) tools.register(tool);
  const hooks = createNoopHooks();
  const ui = new TerminalUI({ quiet: config.quiet, json: config.json, noColor: config.noColor });

  if (config.doctor) {
    const checks = await runDoctor(config, provider, tools);
    if (config.json) {
      process.stdout.write(`${JSON.stringify({ type: 'doctor', ok: checks.every((check) => check.ok), checks })}\n`);
    } else {
      process.stdout.write(`${formatDoctor(checks)}\n`);
    }
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }

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

  ui.banner(config, provider);
  if (config.resumeSessionId) ui.info(`resumed session: ${session.id}`);

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
  };
  if (config.prompt !== undefined) {
    if (!config.prompt.startsWith('/')) requireProviderAuth(config);
    const result = await runPromptMode(runtime, config.prompt);
    ui.final(result.ok, { session: session.id, reason: result.reason });
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (config.noInput) {
    throw new Error('No prompt supplied and --no-input/--ci prevents interactive mode. Pass --prompt or remove --no-input.');
  }

  requireProviderAuth(config);
  await runRepl(runtime);
}

async function packageVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageJson = JSON.parse(await readFile(resolve(here, '../../package.json'), 'utf8')) as { version?: string };
  return packageJson.version ?? '0.0.0';
}

main().catch((error) => {
  const args = parseArgsSafely(process.argv.slice(2));
  const debug = args.debug ?? false;
  const message = error instanceof Error ? (debug ? error.stack ?? error.message : error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

function parseArgsSafely(argv: string[]) {
  try {
    return parseArgs(argv);
  } catch {
    return {};
  }
}
