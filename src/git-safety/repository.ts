import { realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { GitCommandError, type GitProcess, assertSafeWorkspacePathspec } from './git.js';
import type { GitRepositoryInfo } from './types.js';

export class GitRepository {
  constructor(
    private readonly workspaceRoot: string,
    private readonly git: GitProcess,
  ) {}

  async discover(): Promise<GitRepositoryInfo | undefined> {
    let rootText: string;
    try {
      rootText = (await this.git.text(['rev-parse', '--show-toplevel'])).trim();
    } catch (error) {
      if (isMissingRepositoryError(error)) return undefined;
      throw error;
    }

    const root = await realpath(resolve(rootText));
    const workspaceRoot = await realpath(resolve(this.workspaceRoot));
    if (!isPathInside(root, workspaceRoot) && root !== workspaceRoot) {
      throw new Error(`Workspace escapes repository root: ${this.workspaceRoot}`);
    }

    const workspacePathspec = assertSafeWorkspacePathspec(toWorkspacePathspec(root, workspaceRoot));
    const head = await this.readHead();
    const branch = await this.readBranch();
    return {
      root,
      workspaceRoot,
      workspacePathspec,
      head,
      branch,
    };
  }

  async ensure(
    confirm?: (message: string) => Promise<boolean>,
    options?: { locale?: 'zh' | 'en' },
  ): Promise<GitRepositoryInfo | undefined> {
    const existing = await this.discover();
    if (existing) return existing;
    if (!confirm) return undefined;
    const locale = options?.locale ?? 'en';
    const prompt = locale === 'zh'
      ? '当前工作区还不是 Git 仓库。是否初始化本地仓库以启用恢复快照？'
      : 'Workspace is not a Git repository. Initialize a local repository for recovery snapshots?';
    const accepted = await confirm(prompt);
    if (!accepted) return undefined;
    await this.git.text(['init', '--', this.workspaceRoot]);
    return this.discover();
  }

  private async readHead(): Promise<string | undefined> {
    try {
      return (await this.git.text(['rev-parse', '--verify', 'HEAD'])).trim() || undefined;
    } catch (error) {
      if (isUnbornHeadError(error)) return undefined;
      throw error;
    }
  }

  private async readBranch(): Promise<string | undefined> {
    try {
      const branch = (await this.git.text(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
      return branch || undefined;
    } catch (error) {
      if (isUnbornHeadError(error) || isDetachedHeadError(error)) return undefined;
      throw error;
    }
  }
}

function toWorkspacePathspec(repositoryRoot: string, workspaceRoot: string): string {
  if (pathsEqual(repositoryRoot, workspaceRoot)) return '.';
  return relative(repositoryRoot, workspaceRoot).split(sep).join('/');
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('..'));
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isMissingRepositoryError(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false;
  return /not a git repository/i.test(error.stderr) || /not a git repository/i.test(error.message);
}

function isUnbornHeadError(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false;
  return /unknown revision|bad revision|needed a single revision|ambiguous argument 'HEAD'|does not have any commits yet/i.test(error.stderr)
    || /unknown revision|bad revision|needed a single revision|ambiguous argument 'HEAD'|does not have any commits yet/i.test(error.message);
}

function isDetachedHeadError(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false;
  return /not a symbolic ref|ref HEAD is not a symbolic ref/i.test(error.stderr)
    || /not a symbolic ref|ref HEAD is not a symbolic ref/i.test(error.message);
}
