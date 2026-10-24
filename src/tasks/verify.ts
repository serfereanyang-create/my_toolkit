import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TaskItem } from './types.js';
import { runSandboxedCommand } from '../safety/sandbox.js';
import { abortable, throwIfAborted } from '../utils/cancellation.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 12_000;

export type VerifyCommandName = 'typecheck' | 'test' | 'build';
export type VerifyCheckName = VerifyCommandName | 'configuration';

export type VerifyCommandResult = {
  name: VerifyCheckName;
  command: string;
  status: 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled';
  exitCode?: number | null;
  durationMs: number;
  output: string;
  reason?: string;
};

export type VerifySuiteResult = {
  ok: boolean;
  results: VerifyCommandResult[];
  summary: string;
  failedAt?: VerifyCheckName;
};

export type VerifyCommandSpec = {
  name: VerifyCommandName;
  command: string;
  args: string[];
};

export type VerifyRunner = (spec: VerifyCommandSpec, cwd: string, timeoutMs: number, signal?: AbortSignal) => Promise<{
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
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('package.json must contain an object');
    const value = (parsed as Record<string, unknown>).scripts;
    if (value !== undefined) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('package.json scripts must contain an object');
      for (const name of ['typecheck', 'test', 'build']) {
        const command = (value as Record<string, unknown>)[name];
        if (command !== undefined && (typeof command !== 'string' || !command.trim())) throw new Error(`package.json scripts.${name} must be a nonempty string`);
      }
      scripts = value as Record<string, string>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
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
  signal?: AbortSignal;
  workspaceRoot: string;
  runner?: VerifyRunner;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onProgress?: (results: VerifyCommandResult[]) => void | Promise<void>;
}): Promise<VerifySuiteResult> {
  throwIfAborted(options.signal);
  if (!isVerifyTasksEnabled(options.env)) {
    return {
      ok: true,
      results: [],
      summary: 'Verification skipped (AICODE_VERIFY_TASKS disabled).',
    };
  }

  let commands: VerifyCommandSpec[];
  const discoveryStarted = Date.now();
  try { commands = await discoverVerifyCommands(options.workspaceRoot); }
  catch (error) {
    throwIfAborted(options.signal);
    const results: VerifyCommandResult[] = [{ name: 'configuration', command: 'Read package.json', status: 'failed', durationMs: Date.now() - discoveryStarted, output: truncateOutput(error instanceof Error ? error.message : String(error)), reason: 'invalid or unreadable verification configuration' }];
    await options.onProgress?.(results);
    return suiteFromResults(results, 'configuration');
  }
  throwIfAborted(options.signal);
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
    throwIfAborted(options.signal);
    const spec = commands.find((command) => command.name === name);
    if (!spec) {
      if (!present.has(name)) {
        results.push(skipped(name, commandLabel(name), `${name} script not found`));
      }
      await options.onProgress?.([...results]);
      continue;
    }

    const started = Date.now();
    await options.onProgress?.([...results, { name, command: formatSpec(spec), status: 'running', durationMs: 0, output: '' }]);
    let received: Awaited<ReturnType<VerifyRunner>> | undefined;
    try {
      throwIfAborted(options.signal);
      const work = runner(spec, options.workspaceRoot, timeoutMs, options.signal);
      const ran = options.runner ? await abortable(work, options.signal) : await work;
      received = ran;
      throwIfAborted(options.signal);
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
        await options.onProgress?.([...results]);
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
        await options.onProgress?.([...results]);
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
      await options.onProgress?.([...results]);
    } catch (error) {
      if (options.signal?.aborted) {
        if (results.at(-1)?.name !== name || results.at(-1)?.status === 'skipped') results.push({ name, command: formatSpec(spec), status: 'cancelled', durationMs: Date.now() - started, output: truncateOutput(received?.output ?? ''), exitCode: received?.exitCode, reason: 'cancelled by user' });
        await options.onProgress?.([...results]);
        throwIfAborted(options.signal);
      }
      results.push({
        name,
        command: formatSpec(spec),
        status: 'failed',
        exitCode: null,
        durationMs: Date.now() - started,
        output: truncateOutput(error instanceof Error ? error.message : String(error)),
        reason: 'runner error',
      });
      await options.onProgress?.([...results]);
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

function suiteFromResults(results: VerifyCommandResult[], failedAt?: VerifyCheckName): VerifySuiteResult {
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

async function defaultRunner(spec: VerifyCommandSpec, cwd: string, timeoutMs: number, signal?: AbortSignal) {
  const expected = spec.name === 'test' ? ['test'] : ['run', spec.name];
  if (spec.command !== 'npm' || spec.args.length !== expected.length || spec.args.some((arg, index) => arg !== expected[index])) throw new Error('Unsupported verification command');
  const result = await runSandboxedCommand({ command: ['npm', ...expected].join(' '), cwd, timeoutMs, signal, maxBuffer: 8 * 1024 * 1024 });
  return { exitCode: result.code, output: `${result.stdout}${result.stderr}`, timedOut: result.timedOut };
}
