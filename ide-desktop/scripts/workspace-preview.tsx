import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initialState } from '../src/lib/state';
import type { AppState } from '../src/types';
import type { GitStatus, GitFileDiffResult, GitSyncInfo } from '../src/lib/ipc';
import '../src/styles.css';
import '../src/conversation-shell.css';
import '../src/workspace-shell.css';
document.documentElement.style.setProperty('--font-ui', 'var(--font-ui-zh)');

const originalStatus: GitStatus = {
  ok: true, branch: 'feat/auth-session-refresh', upstream: 'origin/feat/auth-session-refresh', ahead: 2, behind: 1,
  staged: [{ path: 'src/auth/session.ts', index: 'M', working: ' ' }],
  unstaged: [
    { path: 'src/auth/session.ts', index: 'M', working: 'M' },
    { path: 'src/auth/refresh-token-boundary.ts', index: ' ', working: 'M' },
    { path: 'src/components/SessionRecoveryPanel.tsx', index: ' ', working: 'M' },
  ], untracked: ['src/lib/sessionEvents.ts'],
};
let gitStatus = structuredClone(originalStatus);
let syncOverride: GitSyncInfo | null = null;
const branches = () => ({ ok: true, current: gitStatus.branch, local: ['feat/auth-session-refresh', 'main', 'fix/preview-layout'], remote: ['origin/main', 'origin/release'], sync: syncOverride ?? { remotes: ['origin'], tracking: { remote: 'origin', branch: gitStatus.branch! }, pushDefault: 'origin' } });
const calls: Array<{ action: string; args: unknown }> = [];
const failures = new Map<string, { message: string; throws: boolean }>();
const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
const detachedGates = new Map<string, () => void>();
let diffOverride: Partial<GitFileDiffResult> | null = null;
const polls = new Map<number, () => void>();
const nativeSetInterval = window.setInterval.bind(window);
const nativeClearInterval = window.clearInterval.bind(window);
window.setInterval = ((handler, timeout, ...args) => {
  const timer = nativeSetInterval(handler, timeout, ...args);
  if (timeout === 8000 && typeof handler === 'function') polls.set(timer, () => handler(...args));
  return timer;
}) as typeof window.setInterval;
window.clearInterval = (timer) => { polls.delete(Number(timer)); nativeClearInterval(timer); };
async function result(action: string, args: unknown, apply: () => Record<string, unknown> = () => ({ ok: true })) {
  const repository = gitStatus;
  calls.push({ action, args });
  const gate = gates.get(action);
  if (gate) { await gate.promise; if (gates.get(action) === gate) gates.delete(action); }
  const failure = failures.get(action);
  if (failure) {
    failures.delete(action);
    if (failure.throws) throw new Error(failure.message);
    return { ok: false, error: failure.message };
  }
  return gitStatus === repository ? apply() : { ok: true };
}
function reset(scenario: string) {
  gates.forEach((gate) => gate.release());
  detachedGates.forEach((release) => release());
  detachedGates.clear(); diffOverride = null; syncOverride = null;
  gates.clear(); failures.clear(); calls.length = 0;
  gitStatus = structuredClone(originalStatus);
  if (scenario === 'clean') { gitStatus.staged = []; gitStatus.unstaged = []; gitStatus.untracked = []; }
  if (scenario === 'unstaged') gitStatus.staged = [];
  if (scenario === 'unborn') gitStatus.unborn = true;
  if (scenario === 'detached') { gitStatus.detached = true; gitStatus.branch = 'HEAD'; }
  if (scenario === 'unavailable') gitStatus = { ok: false, error: '当前目录不是 Git 仓库' };
}
const complexity = { totalFiles: 42, totalFunctions: 388, averageCyclomatic: 3.8, averageCognitive: 4.2, distribution: { low: 300, moderate: 61, high: 20, critical: 7 }, hotspots: [{ name: 'refreshSession', kind: 'function', line: 88, metrics: { cyclomatic: 18, cognitive: 21, maxNesting: 4, parameters: 3, loc: 120 }, risk: 'critical' as const }], files: [] };
const smells = { totalSmells: 14, byType: { 'long-function': 5, 'deep-nesting': 4 }, bySeverity: { info: 1, minor: 6, major: 5, critical: 2 }, topSmells: [{ type: 'long-function', severity: 'critical', message: '函数包含多个独立职责，建议拆分会话刷新与错误恢复。', file: 'src/auth/session.ts', line: 88, symbol: 'refreshSession' }] };
const dependencies = { totalModules: 42, externalDependencies: 16, circularDependencies: [{ cycle: ['auth/session.ts', 'auth/token.ts', 'auth/session.ts'], severity: 'major' }], godModules: [{ module: 'src/App.tsx', dependentCount: 23 }], isolatedModules: [] };
// 空范围场景：一个没有任何可分析函数的目录，用来验证面板的空状态而不是空壳。
const emptyQuality = {
  complexity: { totalFiles: 0, totalFunctions: 0, averageCyclomatic: 0, averageCognitive: 0, distribution: { low: 0, moderate: 0, high: 0, critical: 0 }, hotspots: [], files: [] },
  smells: { totalSmells: 0, byType: {}, bySeverity: { info: 0, minor: 0, major: 0, critical: 0 }, topSmells: [] },
  dependencies: { totalModules: 0, externalDependencies: 0, circularDependencies: [], godModules: [], isolatedModules: [] },
};
let qualityScenario = 'normal';
const qualityData = (name: string) => {
  const source = qualityScenario === 'empty' ? emptyQuality : { complexity, smells, dependencies };
  return name.includes('complexity') ? source.complexity : name.includes('smells') ? source.smells : source.dependencies;
};

(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = {
  git: {
    status: async () => {
      calls.push({ action: 'status', args: null });
      const snapshot = structuredClone(gitStatus);
      const gate = gates.get('status');
      if (gate) { await gate.promise; gates.delete('status'); }
      const failure = failures.get('status');
      if (failure) { failures.delete('status'); if (failure.throws) throw new Error(failure.message); return { ok: false, error: failure.message }; }
      return snapshot;
    },
    branches: async () => branches(), diffStats: async () => ({ ok: true, added: 84, removed: 21, fileCount: 4 }),
    graph: async () => ({ ok: true, commits: [{ hash: 'abc1234', shortHash: 'abc1234', parents: [], author: 'YOYcode', date: '2026-10-21', message: 'Improve session recovery', refs: [] }] }),
    fileDiff: (path: string, staged = false) => {
      const untracked = gitStatus.untracked?.includes(path) && !staged;
      const value = { ok: true, file: path, staged, untracked: Boolean(untracked), diff: untracked
        ? `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,2 @@\n+export const event = 'created';\n+export const ready = true;`
        : `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,2 @@\n-const token = 'old';\n+const token = '${staged ? 'staged' : 'working'}';\n+export const fresh = true;`, ...diffOverride };
      return result('fileDiff', { path, staged }, () => value);
    },
    stage: (paths: string[]) => result('stage', paths, () => {
      const staged = new Map(gitStatus.staged?.map((file) => [file.path, file]) ?? []);
      paths.forEach((path) => staged.set(path, { path, index: 'M', working: ' ' }));
      gitStatus = { ...gitStatus, staged: [...staged.values()], unstaged: gitStatus.unstaged?.filter((file) => !paths.includes(file.path)), untracked: gitStatus.untracked?.filter((path) => !paths.includes(path)) };
      return { ok: true };
    }),
    unstage: (paths: string[]) => result('unstage', paths, () => {
      const unstaged = new Map(gitStatus.unstaged?.map((file) => [file.path, file]) ?? []);
      paths.forEach((path) => unstaged.set(path, { path, index: ' ', working: 'M' }));
      gitStatus = { ...gitStatus, staged: gitStatus.staged?.filter((file) => !paths.includes(file.path)), unstaged: [...unstaged.values()] };
      return { ok: true };
    }),
    discard: (paths: string[]) => result('discard', paths, () => { gitStatus.unstaged = gitStatus.unstaged?.filter((file) => !paths.includes(file.path)); return { ok: true }; }),
    checkout: (branch: string) => result('checkout', branch, () => { gitStatus.branch = branch; return { ok: true }; }),
    createBranch: (branch: string) => result('branch', branch, () => { gitStatus.branch = branch; return { ok: true }; }),
    commit: (message: string) => result('commit', message, () => { gitStatus.staged = []; return { ok: true, shortHash: 'abc1234', message }; }),
    push: (...args: unknown[]) => result('push', args, () => { gitStatus.ahead = 0; return { ok: true }; }),
    pull: (...args: unknown[]) => result('pull', args, () => { gitStatus.behind = 0; return { ok: true }; }),
    prReadiness: async () => ({ ok: true }),
    createPr: (args: unknown) => result('pr', args, () => ({ ok: true, url: 'https://example.invalid/pr/1' })),
  },
  quality: {
    latest: async (name: string) => {
      calls.push({ action: `quality-latest:${name}`, args: null });
      return { result: { data: qualityData(name) } };
    },
    invoke: async (name: string) => {
      calls.push({ action: `quality:${name}`, args: null });
      return { ok: true, data: qualityData(name), output: '' };
    },
  },
  preview: { openExternal: async () => ({ ok: true }) },
  agent: { taskBoardAction: (action: string, taskId?: string) => result('board', { action, taskId }) },
};
const [{ GitPanel }, { QualityDashboard }] = await Promise.all([
  import('../src/components/GitPanel'), import('../src/components/QualityDashboard'),
]);
const startedAt = Date.now() - 125000;
function Preview() {
  const [qualityOpen, setQualityOpen] = useState(false);
  const [qualityKey, setQualityKey] = useState(0);
  const [revision, setRevision] = useState(0);
  const [workspaceRoot, setWorkspaceRoot] = useState('C:/workspace/YOYcode');
  useEffect(() => {
    (window as unknown as { workspacePreview: unknown }).workspacePreview = {
      reset: (scenario = 'mixed') => { reset(scenario); qualityScenario = 'normal'; setWorkspaceRoot('C:/workspace/YOYcode'); setQualityOpen(false); setQualityKey((value) => value + 1); setRevision((value) => value + 1); },
      qualityScenario: (value = 'normal') => { qualityScenario = value === 'empty' ? 'empty' : 'normal'; setQualityOpen(false); setQualityKey((key) => key + 1); },
      fail: (action: string, message: string, throws = false) => failures.set(action, { message, throws }),
      defer: (action: string) => {
        let release = () => {};
        const promise = new Promise<void>((resolve) => { release = resolve; });
        gates.set(action, { promise, release });
      },
      finish: (action: string) => { gates.get(action)?.release(); detachedGates.get(action)?.(); detachedGates.delete(action); },
      detach: (action: string) => { const gate = gates.get(action); if (gate) { detachedGates.set(action, gate.release); gates.delete(action); } },
      diff: (value: Partial<GitFileDiffResult>) => { diffOverride = value; },
      sync: (value: GitSyncInfo) => { syncOverride = value; },
      poll: () => polls.forEach((callback) => callback()),
      calls: () => calls, snapshot: () => gitStatus,
      switchWorkspace: () => { gitStatus = structuredClone(originalStatus); setWorkspaceRoot('C:/workspace/other-project'); },
    };
    document.documentElement.dataset.workspacePreviewReady = 'true';
  }, []);
  const state: AppState = {
    ...initialState, workspaceRoot, agentStatus: 'ready',
    taskBoard: { id: 'board', title: '认证流程复审', goal: '检查会话恢复和令牌刷新边界', status: 'active', runtimeMode: 'executing', activeTaskId: 't2', startedAt, tasks: [
      { id: 't1', title: '检查会话恢复', status: 'done', dependsOn: [] },
      { id: 't2', title: '验证并发令牌刷新', status: 'in_progress', dependsOn: ['t1'] },
      { id: 't3', title: '补充回归测试', status: 'pending', dependsOn: ['t2'] },
    ] },
  };
  return <div className="workspace-preview-shell">
    <div className="workspace-preview-toolbar"><strong>工作区面板预览</strong><button className="workspace-preview-quality" onClick={() => setQualityOpen((value) => !value)}>{qualityOpen ? '关闭质量分析' : '打开质量分析'}</button></div>
    <div className="workspace-preview-grid"><GitPanel key={revision} state={state} onOpenFile={(path, line) => calls.push({ action: 'openFile', args: { path, line } })} /></div>
    <QualityDashboard key={qualityKey} visible={qualityOpen} onClose={() => setQualityOpen(false)} onOpenFile={() => {}} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Preview /></React.StrictMode>);
