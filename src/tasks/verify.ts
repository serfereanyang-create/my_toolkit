import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { TaskItem } from './types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 12_000;

export type VerifyCommandName = 'typecheck' | 'test' | 'build';

export type VerifyCommandResult = {
  name: VerifyCommandName;
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  exitCode?: number | null;
  durationMs: number;
  output: string;
  reason?: string;
};

export type VerifySuiteResult = {
  ok: boolean;
  results: VerifyCommandResult[];
  summary: string;
  failedAt?: VerifyCommandName;
};

export type VerifyCommandSpec = {
  name: VerifyCommandName;
  command: string;
  args: string[];
};

export type VerifyRunner = (spec: VerifyCommandSpec, cwd: string, timeoutMs: number) => Promise<{
  exitCode: number | null;
  output: string;
  timedOut?: boolean;
}>;

export function isVerifyTasksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.AICODE_VERIFY_TASKS ?? '').trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no';
}

export async function discoverVerifyCommands(workspaceRoot: string): Promise<VerifyCommandSpec[]> {
  const packageJsonPath = resolve(workspaceRoot, 'package.json');
  let scripts: Record<string, string> = {};
  try {
    const raw = await readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    scripts = parsed.scripts ?? {};
  } catch {
    return [];
  }

  const discovered: VerifyCommandSpec[] = [];
  if (scripts.typecheck) {
    discovered.push({ name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] });
  }
  if (scripts.test) {
    discovered.push({ name: 'test', command: 'npm', args: ['test'] });
  }
  if (scripts.build) {
    discovered.push({ name: 'build', command: 'npm', args: ['run', 'build'] });
  }
  return discovered;
}

export async function runVerifySuite(options: {
  workspaceRoot: string;
  runner?: VerifyRunner;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<VerifySuiteResult> {
  if (!isVerifyTasksEnabled(options.env)) {
    return {
      ok: true,
      results: [],
      summary: 'Verification skipped (AICODE_VERIFY_TASKS disabled).',
    };
  }

  const commands = await discoverVerifyCommands(options.workspaceRoot);
  if (commands.length === 0) {
    return {
      ok: true,
      results: [
        skipped('typecheck', 'npm run typecheck', 'typecheck script not found'),
        skipped('test', 'npm test', 'test script not found'),
        skipped('build', 'npm run build', 'build script not found'),
      ],
      summary: 'Verification skipped (no typecheck/test/build scripts).',
    };
  }

  const runner = options.runner ?? defaultRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const present = new Set(commands.map((command) => command.name));
  const ordered: VerifyCommandName[] = ['typecheck', 'test', 'build'];
  const results: VerifyCommandResult[] = [];

  for (const name of ordered) {
    const spec = commands.find((command) => command.name === name);
    if (!spec) {
      if (!present.has(name)) {
        results.push(skipped(name, commandLabel(name), `${name} script not found`));
      }
      continue;
    }

    const started = Date.now();
    try {
      const ran = await runner(spec, options.workspaceRoot, timeoutMs);
      const durationMs = Date.now() - started;
      if (ran.timedOut) {
        results.push({
          name,
          command: formatSpec(spec),
          status: 'failed',
          exitCode: ran.exitCode,
          durationMs,
          output: truncateOutput(ran.output),
          reason: `timed out after ${timeoutMs}ms`,
        });
        return suiteFromResults(results, name);
      }
      if ((ran.exitCode ?? 1) !== 0) {
        results.push({
          name,
          command: formatSpec(spec),
          status: 'failed',
          exitCode: ran.exitCode,
          durationMs,
          output: truncateOutput(ran.output),
          reason: `exit code ${ran.exitCode ?? 'unknown'}`,
        });
        return suiteFromResults(results, name);
      }
      results.push({
        name,
        command: formatSpec(spec),
        status: 'passed',
        exitCode: ran.exitCode ?? 0,
        durationMs,
        output: truncateOutput(ran.output),
      });
    } catch (error) {
      results.push({
        name,
        command: formatSpec(spec),
        status: 'failed',
        exitCode: null,
        durationMs: Date.now() - started,
        output: truncateOutput(error instanceof Error ? error.message : String(error)),
        reason: 'runner error',
      });
      return suiteFromResults(results, name);
    }
  }

  return suiteFromResults(results);
}

export function buildRepairPrompt(task: TaskItem, verify: VerifySuiteResult): string {
  const failed = verify.results.filter((result) => result.status === 'failed');
  const details = failed.map((result) => [
    `Command: ${result.command}`,
    `Status: failed (${result.reason ?? 'unknown'})`,
    `Output:\n${result.output || '(empty)'}`,
  ].join('\n')).join('\n\n');

  return [
    `You are repairing a task after verification failed.`,
    `Task: ${task.id} ${task.title}`,
    task.detail ? `Detail: ${task.detail}` : undefined,
    `Verification summary: ${verify.summary}`,
    details ? `Failure details:\n${details}` : undefined,
    `Fix the minimum code/config required to make verification pass.`,
    `Do not expand scope. Do not claim success without addressing the failures above.`,
    `When finished successfully, end with: TASK_DONE: <short summary>`,
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

export function formatVerifySummary(verify: VerifySuiteResult): string {
  return verify.summary;
}

function suiteFromResults(results: VerifyCommandResult[], failedAt?: VerifyCommandName): VerifySuiteResult {
  const failed = results.find((result) => result.status === 'failed');
  if (failed) {
    return {
      ok: false,
      results,
      failedAt: failedAt ?? failed.name,
      summary: `Verification failed at ${failed.name}: ${failed.reason ?? 'command failed'}`,
    };
  }
  const passed = results.filter((result) => result.status === 'passed').map((result) => result.name);
  return {
    ok: true,
    results,
    summary: passed.length > 0
      ? `Verification passed (${passed.join(', ')}).`
      : 'Verification skipped (no commands run).',
  };
}

function skipped(name: VerifyCommandName, command: string, reason: string): VerifyCommandResult {
  return {
    name,
    command,
    status: 'skipped',
    durationMs: 0,
    output: '',
    reason,
  };
}

function commandLabel(name: VerifyCommandName): string {
  if (name === 'test') return 'npm test';
  return `npm run ${name}`;
}

function formatSpec(spec: VerifyCommandSpec): string {
  return [spec.command, ...spec.args].join(' ');
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated ${output.length - MAX_OUTPUT_CHARS} chars]`;
}

async function defaultRunner(spec: VerifyCommandSpec, cwd: string, timeoutMs: number) {
  try {
    const result = await execFileAsync(spec.command, spec.args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: process.env,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    return { exitCode: 0, output };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: string | number;
      killed?: boolean;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      status?: number | null;
    };
    const output = `${bufferToString(failure.stdout)}${bufferToString(failure.stderr)}${failure.message ?? ''}`;
    if (failure.killed) {
      return { exitCode: failure.status ?? null, output, timedOut: true };
    }
    const exitCode = typeof failure.status === 'number'
      ? failure.status
      : typeof failure.code === 'number'
        ? failure.code
        : 1;
    return { exitCode, output };
  }
}

function bufferToString(value: string | Buffer | undefined) {
  if (!value) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}
