import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { formatSandboxResult, runSandboxedCommand } from '../safety/sandbox.js';
import { resolveReadablePath } from '../safety/policy.js';
import type { ToolDefinition } from './types.js';

/*
 * Project operations / code-quality tools. These wrap the real project
 * toolchain (npm scripts, package managers, formatters) through the same
 * sandbox used by run_command, so they inherit its timeout, output cap, and
 * secret-env scrubbing. They carry risk 'shell' and are gated by the approval
 * policy exactly like run_command — nothing here bypasses that.
 *
 * Design choice: rather than shelling arbitrary strings, each tool builds a
 * fixed, well-known command (npm run <script>, npm ci, etc.). The model picks a
 * tool + a constrained argument, not a raw command line, which keeps behavior
 * predictable and auditable for enterprise use.
 */

const DEFAULT_TIMEOUT = 120_000;

async function runOps(command: string, cwd: string, timeoutMs = DEFAULT_TIMEOUT) {
  const result = await runSandboxedCommand({ command, cwd, timeoutMs, maxBuffer: 2 * 1024 * 1024 });
  return formatSandboxResult(result, command);
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
  return input as Record<string, unknown>;
}

// Guard against a caller sneaking shell metacharacters into a "name" slot that
// gets interpolated into a command. Script/package names are conservative.
function safeToken(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (!/^[a-zA-Z0-9._@/:-]+$/.test(trimmed)) throw new Error(`${label} contains unsupported characters`);
  return trimmed;
}

/** Read and parse the workspace package.json once, or return undefined. */
async function readPackageJson(workspaceRoot: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(resolve(workspaceRoot, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export const listScriptsTool: ToolDefinition<Record<string, never>> = {
  name: 'list_scripts',
  description: 'List the npm scripts defined in the workspace package.json (name → command). Read-only; use before run_script to see what is runnable.',
  inputHint: '{}',
  risk: 'read',
  validate() {
    return {};
  },
  async execute(_input, context) {
    const pkg = await readPackageJson(context.workspaceRoot);
    if (!pkg) return { ok: false, output: 'No readable package.json in the workspace.', data: {} };
    const scripts = (pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, string>;
    const names = Object.keys(scripts);
    if (names.length === 0) return { ok: true, output: '(no scripts defined)', data: { scripts: {} } };
    const lines = names.map((name) => `${name}: ${scripts[name]}`);
    return { ok: true, output: lines.join('\n'), data: { scripts, count: names.length } };
  },
};

export const runScriptTool: ToolDefinition<{ name: string; timeoutMs: number }> = {
  name: 'run_script',
  description: 'Run a named npm script (npm run <name>) from the workspace package.json under the sandbox. Use list_scripts first to see valid names.',
  inputHint: '{ "name": "test", "timeoutMs": 120000 }',
  risk: 'shell',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.name !== 'string') throw new Error('name is required');
    const name = safeToken(record.name, 'name');
    const timeoutMs = typeof record.timeoutMs === 'number' && record.timeoutMs > 0 ? Math.min(Math.floor(record.timeoutMs), 600_000) : DEFAULT_TIMEOUT;
    return { name, timeoutMs };
  },
  async execute(input, context) {
    return runOps(`npm run ${input.name}`, context.workspaceRoot, input.timeoutMs);
  },
};

export const installDepsTool: ToolDefinition<{ clean: boolean; timeoutMs: number }> = {
  name: 'install_deps',
  description: 'Install Node dependencies with npm. clean=true uses `npm ci` (lockfile-exact, for CI); otherwise `npm install`. Runs under the sandbox.',
  inputHint: '{ "clean": false, "timeoutMs": 300000 }',
  risk: 'shell',
  validate(input) {
    const record = input === undefined || input === null ? {} : asRecord(input);
    const clean = record.clean === true;
    const timeoutMs = typeof record.timeoutMs === 'number' && record.timeoutMs > 0 ? Math.min(Math.floor(record.timeoutMs), 600_000) : 300_000;
    return { clean, timeoutMs };
  },
  async execute(input, context) {
    return runOps(input.clean ? 'npm ci' : 'npm install', context.workspaceRoot, input.timeoutMs);
  },
};

export const typecheckTool: ToolDefinition<{ timeoutMs: number }> = {
  name: 'typecheck',
  description: 'Run the TypeScript type checker. Prefers the `typecheck` npm script if present, otherwise runs `npx tsc --noEmit`. Runs under the sandbox.',
  inputHint: '{ "timeoutMs": 180000 }',
  risk: 'shell',
  validate(input) {
    const record = input === undefined || input === null ? {} : asRecord(input);
    const timeoutMs = typeof record.timeoutMs === 'number' && record.timeoutMs > 0 ? Math.min(Math.floor(record.timeoutMs), 600_000) : 180_000;
    return { timeoutMs };
  },
  async execute(input, context) {
    const pkg = await readPackageJson(context.workspaceRoot);
    const scripts = (pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, string>;
    const command = scripts.typecheck ? 'npm run typecheck' : 'npx tsc --noEmit';
    return runOps(command, context.workspaceRoot, input.timeoutMs);
  },
};

export const runTestsTool: ToolDefinition<{ timeoutMs: number }> = {
  name: 'run_tests',
  description: 'Run the project test suite via the `test` npm script (npm test) under the sandbox. Use for verifying changes.',
  inputHint: '{ "timeoutMs": 300000 }',
  risk: 'shell',
  validate(input) {
    const record = input === undefined || input === null ? {} : asRecord(input);
    const timeoutMs = typeof record.timeoutMs === 'number' && record.timeoutMs > 0 ? Math.min(Math.floor(record.timeoutMs), 600_000) : 300_000;
    return { timeoutMs };
  },
  async execute(input, context) {
    return runOps('npm test', context.workspaceRoot, input.timeoutMs);
  },
};

export const lintTool: ToolDefinition<{ fix: boolean; timeoutMs: number }> = {
  name: 'lint',
  description: 'Run the project linter via the `lint` npm script under the sandbox. fix=true runs `npm run lint -- --fix` to auto-fix where supported.',
  inputHint: '{ "fix": false, "timeoutMs": 120000 }',
  risk: 'shell',
  validate(input) {
    const record = input === undefined || input === null ? {} : asRecord(input);
    const fix = record.fix === true;
    const timeoutMs = typeof record.timeoutMs === 'number' && record.timeoutMs > 0 ? Math.min(Math.floor(record.timeoutMs), 600_000) : 120_000;
    return { fix, timeoutMs };
  },
  async execute(input, context) {
    return runOps(input.fix ? 'npm run lint -- --fix' : 'npm run lint', context.workspaceRoot, input.timeoutMs);
  },
};

export const dependencyTreeTool: ToolDefinition<{ depth: number }> = {
  name: 'dependency_tree',
  description: 'Show the installed npm dependency tree (npm ls) to given depth. Read-only inspection of what is installed.',
  inputHint: '{ "depth": 1 }',
  risk: 'read',
  validate(input) {
    const record = input === undefined || input === null ? {} : asRecord(input);
    const depth = typeof record.depth === 'number' && record.depth >= 0 ? Math.min(Math.floor(record.depth), 10) : 1;
    return { depth };
  },
  async execute(input, context) {
    // npm ls exits non-zero on peer-dep warnings; treat output as informative
    // regardless of exit code by falling back to whatever it printed.
    const result = await runSandboxedCommand({ command: `npm ls --depth=${input.depth}`, cwd: context.workspaceRoot, timeoutMs: 60_000, maxBuffer: 2 * 1024 * 1024 });
    const text = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join('\n');
    return { ok: true, output: text || '(no dependency output)', data: { depth: input.depth, code: result.code } };
  },
};

export const outdatedDepsTool: ToolDefinition<Record<string, never>> = {
  name: 'outdated_deps',
  description: 'List outdated npm dependencies (npm outdated): current vs wanted vs latest. Read-only; useful for maintenance and upgrade planning.',
  inputHint: '{}',
  risk: 'read',
  validate() {
    return {};
  },
  async execute(_input, context) {
    // npm outdated exits 1 when anything is outdated — that is normal, so we
    // surface the table regardless of exit code.
    const result = await runSandboxedCommand({ command: 'npm outdated', cwd: context.workspaceRoot, timeoutMs: 60_000, maxBuffer: 1024 * 1024 });
    const text = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join('\n');
    return { ok: true, output: text || '(all dependencies up to date)', data: { code: result.code } };
  },
};

// read a file's first bytes for callers that only need existence/basics; kept
// here so the ops module has no cross-tool import beyond the shared helpers.
export async function peekFile(workspaceRoot: string, path: string, bytes = 256): Promise<string> {
  const target = resolveReadablePath(workspaceRoot, path);
  const raw = await readFile(target, 'utf8');
  return raw.slice(0, bytes);
}
