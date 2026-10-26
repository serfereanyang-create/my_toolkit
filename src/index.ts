#!/usr/bin/env node
import { completionScript } from './cli/completion.js';
import { formatDoctor, runDoctor } from './cli/doctor.js';
import { parseArgs } from './cli/args.js';
import { runHeadlessTool } from './cli/headlessTool.js';
import { runDesktopBridge } from './cli/desktopBridge.js';
import { runPromptMode, runRepl } from './cli/repl.js';
import { confirmProviderStart } from './cli/startupConfirm.js';
import { loadConfig, requireProviderAuth } from './config/config.js';
import { formatMcpStatus } from './mcp/manager.js';
import { createAgentRuntime } from './runtime/createRuntime.js';
import { readPackageVersion } from './runtime/packageVersion.js';
import { configureNetworkProxy } from './utils/net.js';

async function main() {
  // Own the process/window title so hosts don't show system32\cmd.
  if (process.stdout.isTTY && !process.env.AICODE_KEEP_PROCESS_TITLE) {
    process.title = 'aicode';
  }

  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args);

  // Settings-level proxy (`network.proxy` in .aicode/config.json). It is only a
  // fallback — AICODE_PROXY / HTTPS_PROXY still win inside utils/proxy.ts — but
  // registering it here covers every web tool, sub-agent and shell the run
  // spawns, without each of them re-reading the config file.
  configureNetworkProxy(config.network?.proxy);

  if (config.version) {
    process.stdout.write(`${await readPackageVersion(import.meta.url)}\n`);
    return;
  }

  if (config.completionShell) {
    process.stdout.write(completionScript(config.completionShell));
    return;
  }

  // Headless GUI action for the desktop 电脑操控 panel. Handled before the
  // runtime is built: the panel drives one window operation at a time and has
  // no provider, no session and no MCP need — constructing the full runtime
  // would cost a second and a provider auth check for a click.
  if (config.guiTool) {
    const { runGuiTool } = await import('./cli/guiTool.js');
    const result = await runGuiTool(config.guiTool, config.guiInput, config.workspaceRoot);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const created = await createAgentRuntime(config);
  const { provider, tools, ui, runtime, mcpStatuses } = created;

  if (config.doctor) {
    const checks = await runDoctor(config, provider, tools, runtime.mcp);
    if (config.json) {
      process.stdout.write(`${JSON.stringify({ type: 'doctor', ok: checks.every((check) => check.ok), checks })}\n`);
    } else {
      process.stdout.write(`${formatDoctor(checks)}\n`);
    }
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    await created.close();
    return;
  }

  // Headless single-tool invocation for host integrations. Runs before the
  // banner so stdout carries exactly one JSON result line.
  if (config.invokeTool) {
    const result = await runHeadlessTool(config, tools);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    await created.close();
    return;
  }

  ui.banner(config, provider);
  // session.rs first-run copy: only for a fresh interactive session.
  if (!config.prompt && !config.desktopBridge && !config.ci && (runtime.session.messages?.length ?? 0) === 0) {
    ui.welcomeCommands();
  }
  if (config.resumeSessionId) ui.info(`resumed session: ${runtime.session.id}`);
  if (mcpStatuses.some((status) => status.enabled)) ui.info(formatMcpStatus(mcpStatuses));

  try {
    if (config.desktopBridge) {
      requireProviderAuth(config);
      await runDesktopBridge(runtime);
      return;
    }

    if (config.prompt !== undefined) {
      if (!config.prompt.startsWith('/')) requireProviderAuth(config);
      const result = await runPromptMode(runtime, config.prompt);
      ui.final(result.ok, { session: runtime.session.id, reason: result.reason });
      if (!result.ok) process.exitCode = 1;
      return;
    }

    if (config.noInput) {
      throw new Error('No prompt supplied and --no-input/--ci prevents interactive mode. Pass --prompt or remove --no-input.');
    }

    requireProviderAuth(config);
    if (!await confirmProviderStart(config, provider)) {
      process.stdout.write('已取消。\n');
      await created.close();
      return;
    }
    await runRepl(runtime);
  } finally {
    await created.close();
  }
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
