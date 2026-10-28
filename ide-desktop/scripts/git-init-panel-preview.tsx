/**
 * Harness for scripts/git-init-panel-smoke.cjs: renders the real GitPanel over
 * a folder that is not a repository yet, so the empty state can be clicked.
 *
 * The stub answers exactly what electron/git.cjs would: status fails with
 * notRepo until `git init` runs, then reports an unborn repository on main.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import '../src/workspace-shell.css';
import type { AppState } from '../src/types';

const calls: string[] = [];
let initialised = false;
window.__gitCalls = calls;

const desktopStub = {
  git: {
    status: async () => {
      calls.push('status');
      if (!initialised) return { ok: false, notRepo: true, error: '这个文件夹还不是 git 仓库' };
      return { ok: true, branch: 'main', upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], hasConflicts: false, unborn: true, detached: false };
    },
    init: async (options: unknown) => {
      calls.push(`init:${JSON.stringify(options ?? {})}`);
      initialised = true;
      return { ok: true, branch: 'main' };
    },
    branches: async () => {
      calls.push('branches');
      if (!initialised) return { ok: false, error: 'not a git repository' };
      return { ok: true, current: 'main', local: ['main'], remote: [] };
    },
    diffStats: async () => {
      calls.push('diffStats');
      return initialised ? { ok: true, added: 0, removed: 0, fileCount: 0 } : { ok: false, error: 'not a git repository' };
    },
    log: async () => ({ ok: true, commits: [] }),
    graph: async () => ({ ok: true, commits: [] }),
    diff: async () => ({ ok: true, diff: '' }),
    fileStats: async () => ({ ok: true, files: [] }),
    fileDiff: async () => ({ ok: true, diff: '' }),
    commitDetail: async () => ({ ok: true }),
    fileChangeRanges: async () => ({ ok: true, hunks: [] }),
    stage: async () => ({ ok: true }),
    unstage: async () => ({ ok: true }),
    discard: async () => ({ ok: true }),
    commit: async () => ({ ok: true }),
    push: async () => ({ ok: true }),
    pull: async () => ({ ok: true }),
    checkout: async () => ({ ok: true }),
    createBranch: async () => ({ ok: true }),
    deleteBranch: async () => ({ ok: true }),
    createPr: async () => ({ ok: true }),
  },
  agent: { taskBoardAction: async () => ({ ok: true }) },
  preview: { openExternal: async () => ({ ok: true }) },
};

(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = desktopStub;

const state = {
  workspaceRoot: 'C:/work/plain-folder',
  agentStatus: 'idle',
  taskBoard: null,
} as unknown as AppState;

const root = createRoot(document.getElementById('root')!);

async function boot() {
  const { GitPanel } = await import('../src/components/GitPanel');
  root.render(<GitPanel state={state} forcePush={false} branchPrefix="yoycode/" onOpenFile={() => {}} />);
}

void boot();
