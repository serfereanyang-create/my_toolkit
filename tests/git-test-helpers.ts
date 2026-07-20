import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildGitEnvironment } from '../src/git-safety/git.js';

const execFileAsync = promisify(execFile);

export async function makeTempWorkspace(name: string) {
  const safeName = name.replace(/[^A-Za-z0-9._-]+/g, '-');
  const root = await mkdtemp(join(tmpdir(), `aicode-${safeName}-`));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function git(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
  return execFileAsync('git', [...args], {
    cwd,
    env: buildGitEnvironment(process.env, {
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'aicode-test',
      GIT_CONFIG_KEY_1: 'user.email',
      GIT_CONFIG_VALUE_1: 'aicode-test@example.invalid',
      GIT_CONFIG_KEY_2: 'init.defaultBranch',
      GIT_CONFIG_VALUE_2: 'main',
      ...(env ?? {}),
    }),
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

export async function makeGitRepository(name: string, options?: { unborn?: boolean; workspaceSubdir?: string }) {
  const fixture = await makeTempWorkspace(name);
  const root = fixture.root;
  await git(root, ['init']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await git(root, ['config', 'core.filemode', 'false']);

  if (!options?.unborn) {
    await writeText(root, 'README.md', 'initial\n');
    await git(root, ['add', 'README.md']);
    await git(root, ['commit', '-m', 'initial']);
  }

  const workspace = options?.workspaceSubdir ? resolve(root, options.workspaceSubdir) : root;
  if (options?.workspaceSubdir) await mkdir(workspace, { recursive: true });

  return {
    root,
    workspace,
    git: (args: readonly string[], env?: NodeJS.ProcessEnv) => git(root, args, env),
    readIndexBytes: async () => {
      try {
        return await readFile(resolve(root, '.git', 'index'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    cleanup: fixture.cleanup,
  };
}

export async function writeText(root: string, relativePath: string, content: string) {
  const absolute = resolve(root, relativePath);
  await mkdir(resolve(absolute, '..'), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(absolute, content, 'utf8');
  return absolute;
}
