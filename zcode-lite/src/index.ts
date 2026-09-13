#!/usr/bin/env node
import { parseArgs, helpText } from './cli/args.js';
import { runRepl } from './cli/repl.js';
import { createTerminalConfirm, printResult } from './cli/ui.js';
import { resolveConfig } from './config/config.js';
import { createProvider } from './providers/index.js';
import { Agent } from './agent/agent.js';
import { createDefaultRegistry } from './tools/index.js';
async function main(): Promise<void> { const args = parseArgs(process.argv.slice(2)); if (args.help) { printResult(helpText); return; } const config = await resolveConfig(args); const agent = new Agent(createProvider(config), createDefaultRegistry(), config, { cwd: config.workspaceRoot, env: process.env, config: { networkAllowlist: config.networkAllowlist }, sessionApproved: new Set(), confirm: args.prompt ? undefined : createTerminalConfirm() }); if (args.prompt) { const result = await agent.run(args.prompt); if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); else printResult(result.text); return; } await runRepl(agent); }
main().catch(error => { process.stderr.write(`zcode-lite: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
