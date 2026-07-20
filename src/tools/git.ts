import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from './types.js';

const execFileAsync = promisify(execFile);

type GitInput = {
  maxBytes: number;
};

export const gitStatusTool: ToolDefinition<GitInput> = {
  name: 'git_status',
  description: 'Show git working tree status without modifying the repository.',
  inputHint: '{ "maxBytes": 20000 }',
  risk: 'read',
  validate: validateGitInput,
  execute(input, context) {
    return runGit(['status', '--short', '--branch'], context.workspaceRoot, input.maxBytes);
  },
};

export const gitDiffTool: ToolDefinition<GitInput> = {
  name: 'git_diff',
  description: 'Show git diff without modifying the repository.',
  inputHint: '{ "maxBytes": 40000 }',
  risk: 'read',
  validate: validateGitInput,
  execute(input, context) {
    return runGit(['diff', '--', '.'], context.workspaceRoot, input.maxBytes);
  },
};

export const gitLogTool: ToolDefinition<GitInput> = {
  name: 'git_log',
  description: 'Show recent git commits without modifying the repository.',
  inputHint: '{ "maxBytes": 20000 }',
  risk: 'read',
  validate: validateGitInput,
  execute(input, context) {
    return runGit(['log', '--oneline', '-n', '10'], context.workspaceRoot, input.maxBytes);
  },
};

function validateGitInput(input: unknown): GitInput {
  if (input === undefined || input === null) return { maxBytes: 20000 };
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('expected an object');
  const record = input as Record<string, unknown>;
  return {
    maxBytes: typeof record.maxBytes === 'number' && record.maxBytes > 0 ? Math.min(Math.floor(record.maxBytes), 100000) : 20000,
  };
}

async function runGit(args: string[], cwd: string, maxBytes: number) {
  try {
    const result = await execFileAsync('git', args, { cwd, timeout: 30000, maxBuffer: maxBytes, windowsHide: true });
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    return { ok: true, output: output || '(no output)', data: { args } };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    const output = [failure.stdout?.trim(), failure.stderr?.trim(), failure.message].filter(Boolean).join('\n');
    return { ok: false, output: output || 'git command failed', data: { args } };
  }
}
