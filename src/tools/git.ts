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
  parallelSafe: true,
  validate: validateGitInput,
  execute(input, context) {
    return runGit(['status', '--short', '--branch'], context.workspaceRoot, input.maxBytes);
  },
};

export const gitDiffTool: ToolDefinition<GitInput> = {
  name: 'git_diff',
  description: 'Show unstaged changes in the working tree (git diff). To see staged/cached changes use git_diff_staged.',
  inputHint: '{ "maxBytes": 40000 }',
  risk: 'read',
  parallelSafe: true,
  validate: validateGitInput,
  execute(input, context) {
    return runGit(['diff', '--', '.'], context.workspaceRoot, input.maxBytes);
  },
};

export const gitDiffStagedTool: ToolDefinition<GitInput> = {
  name: 'git_diff_staged',
  description: 'Show staged (cached) changes that are ready to commit (git diff --cached). Complements git_diff which only shows unstaged changes.',
  inputHint: '{ "maxBytes": 40000 }',
  risk: 'read',
  parallelSafe: true,
  validate: validateGitInput,
  execute(input, context) {
    return runGit(['diff', '--cached', '--', '.'], context.workspaceRoot, input.maxBytes);
  },
};

type GitLogInput = {
  maxBytes: number;
  n: number;
  path?: string;
  author?: string;
  since?: string;
};

export const gitLogTool: ToolDefinition<GitLogInput> = {
  name: 'git_log',
  description: 'Show recent git commits. Optionally filter by path, author, or date. n controls how many commits to return (default 10, max 100).',
  inputHint: '{ "n": 10 }  or  { "n": 20, "path": "src/app.ts", "author": "alice", "since": "2024-01-01" }',
  risk: 'read',
  parallelSafe: true,
  validate(input: unknown): GitLogInput {
    if (input === undefined || input === null) return { maxBytes: 20000, n: 10 };
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0
      ? Math.min(Math.floor(record.maxBytes), 100000) : 20000;
    const n = typeof record.n === 'number' && record.n > 0
      ? Math.min(Math.floor(record.n), 100) : 10;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    const author = typeof record.author === 'string' && record.author.trim() ? record.author.trim() : undefined;
    const since = typeof record.since === 'string' && record.since.trim() ? record.since.trim() : undefined;
    return { maxBytes, n, path, author, since };
  },
  execute(input, context) {
    const args = ['log', '--oneline', `-n`, String(input.n)];
    if (input.author) args.push(`--author=${input.author}`);
    if (input.since) args.push(`--since=${input.since}`);
    if (input.path) { args.push('--'); args.push(input.path); }
    return runGit(args, context.workspaceRoot, input.maxBytes);
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

export async function runGit(args: string[], cwd: string, maxBytes: number) {
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
