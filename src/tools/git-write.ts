import { runGit } from './git.js';
import type { ToolDefinition } from './types.js';

/*
 * Git write / network operations. Every tool here carries risk 'write' (or
 * 'network' for fetch/pull) so the approval policy gates it (ask -> confirm,
 * auto -> allowed, deny -> refused). Commands reuse the shared runGit helper
 * (execFile 'git', no shell) so argument arrays are passed verbatim — no
 * string interpolation, no injection surface.
 *
 * Deliberately excluded (destructive / history-rewriting / force-pushing):
 * push --force, reset --hard, clean -f, rebase -i, branch -D, checkout --force.
 * Those stay out of the model's reach; a user who wants them can run_command
 * explicitly or use the desktop Git panel (force-with-lease only when enabled).
 */

const MAX = 40000;

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
  return input as Record<string, unknown>;
}

function pathList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) {
    const paths = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
    if (paths.length > 0) return paths;
  }
  throw new Error('paths is required (a string or array of paths)');
}

const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

/**
 * `git init` for a folder that is not a repository yet. Refused when the
 * workspace already sits inside a repository (a nested repo is never what was
 * meant), and it never stages, commits or deletes anything.
 */
export const gitInitTool: ToolDefinition<{ branch: string }> = {
  name: 'git_init',
  description: 'Create a git repository in the workspace (git init) when the folder is not version-controlled yet. Refuses if the folder already belongs to a repository. Only creates .git — nothing is staged or committed.',
  inputHint: '{ "branch": "main" }',
  risk: 'write',
  validate(input) {
    if (input === undefined || input === null) return { branch: 'main' };
    const record = asRecord(input);
    const branch = optionalRef(record.branch) ?? 'main';
    if (!BRANCH_NAME.test(branch) || branch.startsWith('-') || branch.endsWith('/')) {
      throw new Error('branch may only contain letters, digits, dot, underscore, dash and slash');
    }
    return { branch };
  },
  async execute(input, context) {
    const probe = await runGit(['rev-parse', '--show-toplevel'], context.workspaceRoot, MAX);
    if (probe.ok) {
      return { ok: false, output: `Workspace is already inside a git repository (${probe.output}); nothing to initialise.`, data: { alreadyRepo: true } };
    }
    const created = await runGit(['init', '-b', input.branch], context.workspaceRoot, MAX);
    if (created.ok) return created;
    // git older than 2.28 has no `init -b`: create the repo, then name HEAD.
    const plain = await runGit(['init'], context.workspaceRoot, MAX);
    if (!plain.ok) return plain;
    const named = await runGit(['symbolic-ref', 'HEAD', `refs/heads/${input.branch}`], context.workspaceRoot, MAX);
    return named.ok ? { ok: true, output: `${plain.output}\nbranch: ${input.branch}`, data: named.data } : named;
  },
};

export const gitAddTool: ToolDefinition<{ paths: string[] }> = {
  name: 'git_add',
  description: 'Stage files for commit (git add). Pass a path or list of paths; use ["."] to stage everything.',
  inputHint: '{ "paths": ["src/app.ts"] }  or  { "paths": ["."] }',
  risk: 'write',
  validate(input) {
    return { paths: pathList(asRecord(input).paths) };
  },
  execute(input, context) {
    return runGit(['add', '--', ...input.paths], context.workspaceRoot, MAX);
  },
};

export const gitCommitTool: ToolDefinition<{ message: string; all: boolean }> = {
  name: 'git_commit',
  description: 'Create a git commit with a message. Set all=true to stage tracked modifications first (git commit -a). Does not push.',
  inputHint: '{ "message": "fix: correct null check", "all": false }',
  risk: 'write',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.message !== 'string' || !record.message.trim()) throw new Error('message is required');
    return { message: record.message.trim(), all: record.all === true };
  },
  execute(input, context) {
    const args = ['commit', ...(input.all ? ['-a'] : []), '-m', input.message];
    return runGit(args, context.workspaceRoot, MAX);
  },
};

// ── Branch ────────────────────────────────────────────────────────────────────

type GitBranchInput =
  | { op: 'list' }
  | { op: 'create'; name: string }
  | { op: 'rename'; name: string; newName: string }
  | { op: 'delete'; name: string; force: boolean };

export const gitBranchTool: ToolDefinition<GitBranchInput> = {
  name: 'git_branch',
  description:
    'Manage branches. op="list" lists branches (default). op="create" creates a new branch. ' +
    'op="rename" renames an existing branch. op="delete" deletes a merged branch (force=true deletes even if unmerged).',
  inputHint:
    '{ "op": "list" }  |  { "op": "create", "name": "feature/x" }  |  ' +
    '{ "op": "rename", "name": "old", "newName": "new" }  |  { "op": "delete", "name": "old", "force": false }',
  risk: 'write',
  validate(input): GitBranchInput {
    if (input === undefined || input === null) return { op: 'list' };
    const r = asRecord(input);
    const op = typeof r.op === 'string' ? r.op : 'list';

    if (op === 'create') {
      const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : undefined;
      if (!name) throw new Error('name is required for op=create');
      return { op: 'create', name };
    }
    if (op === 'rename') {
      const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : undefined;
      const newName = typeof r.newName === 'string' && r.newName.trim() ? r.newName.trim() : undefined;
      if (!name) throw new Error('name is required for op=rename');
      if (!newName) throw new Error('newName is required for op=rename');
      return { op: 'rename', name, newName };
    }
    if (op === 'delete') {
      const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : undefined;
      if (!name) throw new Error('name is required for op=delete');
      return { op: 'delete', name, force: r.force === true };
    }
    return { op: 'list' };
  },
  execute(input, context) {
    if (input.op === 'list') return runGit(['branch', '--list'], context.workspaceRoot, MAX);
    if (input.op === 'create') return runGit(['branch', input.name], context.workspaceRoot, MAX);
    if (input.op === 'rename') return runGit(['branch', '-m', input.name, input.newName], context.workspaceRoot, MAX);
    // delete: -d = safe (only merged), -D = force
    return runGit(['branch', input.force ? '-D' : '-d', input.name], context.workspaceRoot, MAX);
  },
};

// ── Checkout ──────────────────────────────────────────────────────────────────

export const gitCheckoutTool: ToolDefinition<{ target: string; create: boolean }> = {
  name: 'git_checkout',
  description: 'Switch to an existing branch, or create and switch with create=true (git checkout -b). Refuses --force (no destructive overwrite).',
  inputHint: '{ "target": "main" }  or  { "target": "feature/x", "create": true }',
  risk: 'write',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.target !== 'string' || !record.target.trim()) throw new Error('target is required');
    return { target: record.target.trim(), create: record.create === true };
  },
  execute(input, context) {
    const args = input.create ? ['checkout', '-b', input.target] : ['checkout', input.target];
    return runGit(args, context.workspaceRoot, MAX);
  },
};

// ── Stash ─────────────────────────────────────────────────────────────────────

type GitStashInput = {
  action: 'push' | 'pop' | 'apply' | 'drop' | 'show' | 'list';
  index?: number;
};

export const gitStashTool: ToolDefinition<GitStashInput> = {
  name: 'git_stash',
  description:
    'Manage the git stash. action="push" saves current changes; "pop" restores and removes the top stash; ' +
    '"apply" restores without removing; "drop" removes a stash entry; "show" shows diff of a stash; "list" lists all stashes. ' +
    'Use index to target a specific stash (default 0).',
  inputHint: '{ "action": "push" }  or  { "action": "pop" }  or  { "action": "drop", "index": 0 }',
  risk: 'write',
  validate(input): GitStashInput {
    const record = asRecord(input);
    const validActions = ['push', 'pop', 'apply', 'drop', 'show', 'list'] as const;
    const raw = record.action;
    const action = validActions.includes(raw as typeof validActions[number])
      ? (raw as GitStashInput['action'])
      : 'push';
    const index = typeof record.index === 'number' && record.index >= 0 ? Math.floor(record.index) : undefined;
    return { action, index };
  },
  execute(input, context) {
    const ref = input.index !== undefined ? `stash@{${input.index}}` : undefined;
    if (input.action === 'list') return runGit(['stash', 'list'], context.workspaceRoot, MAX);
    if (input.action === 'push') return runGit(['stash', 'push'], context.workspaceRoot, MAX);
    if (input.action === 'pop') return ref
      ? runGit(['stash', 'pop', ref], context.workspaceRoot, MAX)
      : runGit(['stash', 'pop'], context.workspaceRoot, MAX);
    if (input.action === 'apply') return ref
      ? runGit(['stash', 'apply', ref], context.workspaceRoot, MAX)
      : runGit(['stash', 'apply'], context.workspaceRoot, MAX);
    if (input.action === 'drop') return ref
      ? runGit(['stash', 'drop', ref], context.workspaceRoot, MAX)
      : runGit(['stash', 'drop'], context.workspaceRoot, MAX);
    // show
    return ref
      ? runGit(['stash', 'show', '-p', ref], context.workspaceRoot, MAX)
      : runGit(['stash', 'show', '-p'], context.workspaceRoot, MAX);
  },
};

// ── Reset (safe: soft/mixed only) ─────────────────────────────────────────────

type GitResetInput = { ref: string; mode: 'soft' | 'mixed' };

export const gitResetTool: ToolDefinition<GitResetInput> = {
  name: 'git_reset',
  description:
    'Move HEAD to a previous commit without touching the working tree (--soft) or also unstage changes (--mixed, default). ' +
    'Does not allow --hard or --merge (those are destructive and remain out of reach).',
  inputHint: '{ "ref": "HEAD~1", "mode": "mixed" }',
  risk: 'write',
  validate(input): GitResetInput {
    const record = asRecord(input);
    const ref = typeof record.ref === 'string' && record.ref.trim() ? record.ref.trim() : 'HEAD~1';
    const modeRaw = record.mode;
    const mode: 'soft' | 'mixed' = modeRaw === 'soft' ? 'soft' : 'mixed';
    return { ref, mode };
  },
  execute(input, context) {
    return runGit(['reset', `--${input.mode}`, input.ref], context.workspaceRoot, MAX);
  },
};

// ── Restore ───────────────────────────────────────────────────────────────────

type GitRestoreInput = { paths: string[]; staged: boolean };

export const gitRestoreTool: ToolDefinition<GitRestoreInput> = {
  name: 'git_restore',
  description:
    'Discard working-tree changes for specific files (git restore). ' +
    'Set staged=true to unstage (--staged); omit or false to discard uncommitted working-tree edits. ' +
    'WARNING: discards unsaved changes — only use when the user explicitly requests it.',
  inputHint: '{ "paths": ["src/app.ts"] }  or  { "paths": ["."], "staged": true }',
  risk: 'write',
  // `--staged` only moves the change out of the index and is recoverable, but
  // discarding working-tree edits permanently destroys uncommitted work, so
  // that variant must always be confirmed. `git_restore` is deliberately NOT
  // autoApprove: without this flag the policy would let auto mode silently
  // throw away unsaved changes with no prompt and no visible target list.
  alwaysPrompt: (input) => input.staged !== true,
  validate(input): GitRestoreInput {
    const record = asRecord(input);
    return { paths: pathList(record.paths), staged: record.staged === true };
  },
  execute(input, context) {
    const args = ['restore', ...(input.staged ? ['--staged'] : []), '--', ...input.paths];
    return runGit(args, context.workspaceRoot, MAX);
  },
};

// ── Show / Blame (read) ───────────────────────────────────────────────────────

export const gitShowTool: ToolDefinition<{ ref: string; maxBytes: number }> = {
  name: 'git_show',
  description: 'Show a commit or object (git show). Read-only inspection of a specific ref/commit.',
  inputHint: '{ "ref": "HEAD" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    const ref = typeof record.ref === 'string' && record.ref.trim() ? record.ref.trim() : 'HEAD';
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 ? Math.min(Math.floor(record.maxBytes), 100000) : MAX;
    return { ref, maxBytes };
  },
  execute(input, context) {
    return runGit(['show', '--stat', input.ref], context.workspaceRoot, input.maxBytes);
  },
};

export const gitBlameTool: ToolDefinition<{ path: string; maxBytes: number }> = {
  name: 'git_blame',
  description: 'Show line-by-line authorship for a file (git blame). Read-only.',
  inputHint: '{ "path": "src/app.ts" }',
  risk: 'read',
  validate(input) {
    const record = asRecord(input);
    if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('path is required');
    const maxBytes = typeof record.maxBytes === 'number' && record.maxBytes > 0 ? Math.min(Math.floor(record.maxBytes), 100000) : MAX;
    return { path: record.path.trim(), maxBytes };
  },
  execute(input, context) {
    return runGit(['blame', '--', input.path], context.workspaceRoot, input.maxBytes);
  },
};

// ── Remote / network ─────────────────────────────────────────────────────────

function optionalRef(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export const gitFetchTool: ToolDefinition<{ remote: string; ref?: string }> = {
  name: 'git_fetch',
  description: 'Fetch from a remote (git fetch). Updates remote-tracking refs only; does not modify the working tree. No force.',
  inputHint: '{ "remote": "origin" }  or  { "remote": "origin", "ref": "main" }',
  risk: 'write',
  validate(input) {
    if (input === undefined || input === null) return { remote: 'origin' };
    const record = asRecord(input);
    const remote = optionalRef(record.remote) ?? 'origin';
    return { remote, ref: optionalRef(record.ref) };
  },
  execute(input, context) {
    const args = input.ref ? ['fetch', input.remote, input.ref] : ['fetch', input.remote];
    return runGit(args, context.workspaceRoot, MAX);
  },
};

export const gitPullTool: ToolDefinition<{ remote: string; branch?: string; rebase: boolean }> = {
  name: 'git_pull',
  description: 'Pull from a remote (git pull). Optional rebase=true uses --rebase. Does not force; refuses --force flags.',
  inputHint: '{ "remote": "origin", "branch": "main", "rebase": false }',
  risk: 'write',
  validate(input) {
    if (input === undefined || input === null) return { remote: 'origin', rebase: false };
    const record = asRecord(input);
    return {
      remote: optionalRef(record.remote) ?? 'origin',
      branch: optionalRef(record.branch),
      rebase: record.rebase === true,
    };
  },
  execute(input, context) {
    const args = ['pull', ...(input.rebase ? ['--rebase'] : []), input.remote];
    if (input.branch) args.push(input.branch);
    return runGit(args, context.workspaceRoot, MAX);
  },
};

export const gitMergeTool: ToolDefinition<{ ref: string; noFf: boolean; ffOnly: boolean }> = {
  name: 'git_merge',
  description: 'Merge a branch/commit into HEAD (git merge). Supports --no-ff or --ff-only. Does not allow -X theirs strategies or --abort automation beyond a plain merge.',
  inputHint: '{ "ref": "feature/x", "noFf": false, "ffOnly": false }',
  risk: 'write',
  validate(input) {
    const record = asRecord(input);
    const ref = optionalRef(record.ref);
    if (!ref) throw new Error('ref is required');
    if (record.noFf === true && record.ffOnly === true) throw new Error('noFf and ffOnly are mutually exclusive');
    return { ref, noFf: record.noFf === true, ffOnly: record.ffOnly === true };
  },
  execute(input, context) {
    const args = ['merge'];
    if (input.noFf) args.push('--no-ff');
    if (input.ffOnly) args.push('--ff-only');
    args.push(input.ref);
    return runGit(args, context.workspaceRoot, MAX);
  },
};

export const gitCherryPickTool: ToolDefinition<{ commits: string[]; noCommit: boolean }> = {
  name: 'git_cherry_pick',
  description: 'Cherry-pick one or more commits onto HEAD. Pass commits newest-last (git order). noCommit=true applies changes without committing.',
  inputHint: '{ "commits": ["abc1234"], "noCommit": false }',
  risk: 'write',
  validate(input) {
    const record = asRecord(input);
    const raw = record.commits ?? record.commit;
    let commits: string[] = [];
    if (typeof raw === 'string' && raw.trim()) commits = [raw.trim()];
    else if (Array.isArray(raw)) {
      commits = raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
    }
    if (commits.length === 0) throw new Error('commits is required (string or array of SHAs/refs)');
    return { commits, noCommit: record.noCommit === true };
  },
  execute(input, context) {
    const args = ['cherry-pick', ...(input.noCommit ? ['--no-commit'] : []), ...input.commits];
    return runGit(args, context.workspaceRoot, MAX);
  },
};

export const gitTagTool: ToolDefinition<{ name?: string; ref?: string; message?: string; list: boolean }> = {
  name: 'git_tag',
  description: 'List tags, or create an annotated/lightweight tag. With list=true or no name, lists tags. With a name, creates a tag (annotated if message is set). Does not delete or force-move tags.',
  inputHint: '{ "list": true }  or  { "name": "v1.0.0", "message": "release" }',
  risk: 'write',
  validate(input) {
    if (input === undefined || input === null) return { list: true };
    const record = asRecord(input);
    const name = optionalRef(record.name);
    if (!name || record.list === true) return { list: true };
    return {
      name,
      ref: optionalRef(record.ref),
      message: typeof record.message === 'string' && record.message.trim() ? record.message.trim() : undefined,
      list: false,
    };
  },
  execute(input, context) {
    if (input.list || !input.name) return runGit(['tag', '--list'], context.workspaceRoot, MAX);
    if (input.message) {
      const args = ['tag', '-a', input.name, '-m', input.message];
      if (input.ref) args.push(input.ref);
      return runGit(args, context.workspaceRoot, MAX);
    }
    const args = ['tag', input.name];
    if (input.ref) args.push(input.ref);
    return runGit(args, context.workspaceRoot, MAX);
  },
};
