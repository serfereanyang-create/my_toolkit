/**
 * workspace-shell-preview — 工作区外壳的 a11y 夹具（`--page=workspace`）。
 *
 * 审计缺的东西：会话壳、质量面板、设置页都有探针，工作区外壳一直没有——
 * 文件树、编辑器标签、Git 面板、底部终端、待确认差异这五块从来没被量过。
 *
 * 冻结口径（离线）：窗口壳用产品自己的 `.chat-shell` 五列网格（rail 与右栏压成
 * 0px），`.main` 里放一个真身视图，终端按真实位置落在第 2 行。数据全部来自
 * 对 `window.zcodeDesktop` 的录制替身：不连 CLI、不读磁盘、不建 PTY、不发网络。
 *
 * 状态用 `window.workspaceShellPreview.reset(view, variant)` 就地切换，探针
 * 在 `--page=workspace` 的 prepare 里调它。挂载完成后打 `previewReady`。
 *
 * Monaco：`editor/open` 会真挂 monaco-editor。它经 `src/lib/monacoRuntime.ts`
 * 的 `loader.config({ monaco })` 走本地包 + vite `?worker`，不碰 jsdelivr。
 */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initialState } from '../src/lib/state';
import type { AppState, PendingDiff, TreeNode } from '../src/types';
import type { GitStatus } from '../src/lib/ipc';
import '../src/styles.css';
import '../src/conversation-shell.css';
import '../src/workspace-shell.css';

type View = 'files' | 'git' | 'editor' | 'terminal' | 'diff';
type Variant = 'mixed' | 'empty' | 'open';
type Screen = { view: View; variant: Variant; nonce: number };

const ROOT = 'C:/workspace/YOYcode';

const TREE: TreeNode[] = [
  {
    name: 'src', path: 'src', type: 'directory', children: [
      {
        name: 'auth', path: 'src/auth', type: 'directory', children: [
          { name: 'session.ts', path: 'src/auth/session.ts', type: 'file' },
          { name: 'refresh-token-boundary.ts', path: 'src/auth/refresh-token-boundary.ts', type: 'file' },
        ],
      },
      { name: 'App.tsx', path: 'src/App.tsx', type: 'file' },
      { name: 'main.tsx', path: 'src/main.tsx', type: 'file' },
      { name: 'styles.css', path: 'src/styles.css', type: 'file' },
    ],
  },
  {
    name: 'scripts', path: 'scripts', type: 'directory', children: [
      { name: 'dev.cjs', path: 'scripts/dev.cjs', type: 'file' },
      { name: 'a11y-audit.cjs', path: 'scripts/a11y-audit.cjs', type: 'file' },
    ],
  },
  { name: 'package.json', path: 'package.json', type: 'file' },
  { name: 'Readme.md', path: 'Readme.md', type: 'file' },
  { name: 'tsconfig.json', path: 'tsconfig.json', type: 'file' },
];

function childrenOf(path: string): TreeNode[] {
  const walk = (nodes: TreeNode[]): TreeNode[] | undefined => {
    for (const node of nodes) {
      if (node.path === path) return node.children ?? [];
      const nested = node.children ? walk(node.children) : undefined;
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(TREE) ?? [];
}

const STATUS: GitStatus = {
  ok: true,
  branch: 'feat/auth-session-refresh',
  upstream: 'origin/feat/auth-session-refresh',
  ahead: 2,
  behind: 1,
  staged: [{ path: 'src/auth/session.ts', index: 'M', working: ' ' }],
  unstaged: [
    { path: 'src/auth/session.ts', index: 'M', working: 'M' },
    { path: 'src/auth/refresh-token-boundary.ts', index: ' ', working: 'M' },
    { path: 'src/components/SessionRecoveryPanel.tsx', index: ' ', working: 'M' },
  ],
  untracked: ['src/lib/sessionEvents.ts'],
};

const DIFF_CONTEXT = `export async function restoreSession(token: Token) {
  const stored = await readStoredToken();
  if (!stored) return null;
  return refresh(stored);
}`;
const DIFF_AFTER = `export async function restoreSession(token: Token) {
  const stored = await readStoredToken();
  if (!stored || Date.now() >= stored.expiresAt) return null;
  return refresh(stored);
}`;

const DIFFS: PendingDiff[] = [
  { id: 'd1', path: 'src/auth/session.ts', originalContent: DIFF_CONTEXT, modifiedContent: DIFF_AFTER, status: 'pending' },
  { id: 'd2', path: 'src/lib/sessionEvents.ts', originalContent: '', modifiedContent: "export const created = 'session';\nexport const ready = true;", status: 'pending' },
  { id: 'd3', path: 'src/auth/refresh-token-boundary.ts', originalContent: 'const ttl = 60;', modifiedContent: 'const ttl = 300;', status: 'accepted' },
];

const OPEN_FILES = [
  {
    path: 'src/auth/session.ts',
    language: 'typescript',
    dirty: true,
    content: `import { readStoredToken } from './token';\n\nexport async function restoreSession(token: Token) {\n  const stored = await readStoredToken();\n  if (!stored || Date.now() >= stored.expiresAt) return null;\n  return refresh(stored);\n}\n`,
  },
  {
    path: 'src/auth/refresh-token-boundary.ts',
    language: 'typescript',
    dirty: false,
    content: `export const ttl = 300;\nexport const skew = 30;\n`,
  },
];

const state: AppState = { ...initialState, workspaceRoot: ROOT, agentStatus: 'ready' };

(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = {
  workspace: {
    getTree: async (path: string) => (path === '.' ? TREE : childrenOf(path)),
    reveal: async () => ({ ok: true }),
  },
  git: {
    status: async () => STATUS,
    branches: async () => ({
      ok: true, current: STATUS.branch, local: [STATUS.branch, 'main', 'fix/preview-layout'],
      remote: ['origin/main', 'origin/release'],
      sync: { remotes: ['origin'], tracking: { remote: 'origin', branch: STATUS.branch }, pushDefault: 'origin' },
    }),
    diffStats: async () => ({ ok: true, added: 84, removed: 21, fileCount: 4 }),
    fileStats: async () => ({ ok: true, files: [{ path: 'src/auth/session.ts', added: 2, removed: 1, status: 'unstaged' }] }),
    graph: async () => ({
      ok: true,
      commits: [
        { hash: 'abc1234', shortHash: 'abc1234', parents: [], author: 'YOYcode', date: '2026-10-21', message: 'Improve session recovery', refs: [] },
        { hash: 'def5678', shortHash: 'def5678', parents: ['abc1234'], author: 'YOYcode', date: '2026-10-20', message: 'Refresh token boundary', refs: [] },
      ],
    }),
    fileDiff: async (path: string, staged = false) => ({
      ok: true, file: path, staged, untracked: false, diff: DIFF_CONTEXT,
    }),
    stage: async () => ({ ok: true }),
    unstage: async () => ({ ok: true }),
    discard: async () => ({ ok: true }),
    commit: async (message: string) => ({ ok: true, shortHash: 'abc1234', message }),
    push: async () => ({ ok: true }),
    pull: async () => ({ ok: true }),
    checkout: async () => ({ ok: true }),
    createBranch: async () => ({ ok: true }),
    init: async () => ({ ok: true }),
    prReadiness: async () => ({ ok: true }),
    createPr: async () => ({ ok: true, url: 'https://example.invalid/pr/1' }),
    fileChangeRanges: async () => ({ ok: true, ranges: [] }),
  },
  bookmarks: {
    listFor: async () => [],
    toggle: async () => ({ ok: true, bookmarks: [] }),
  },
  terminal: {
    create: async () => ({ id: 'term-preview', cwd: ROOT }),
    write: async () => ({ ok: true }),
    resize: async () => ({ ok: true }),
    kill: async () => ({ ok: true }),
    onEvent: () => () => {},
  },
  preview: { openExternal: async () => ({ ok: true }), reload: async () => ({ ok: true }) },
  agent: { taskBoardAction: async () => ({ ok: true }) },
};

const [{ FileTree }, { GitPanel }, { EditorView }, { Terminal }, { DiffReview }] = await Promise.all([
  import('../src/components/FileTree'),
  import('../src/components/GitPanel'),
  import('../src/components/Editor/EditorView'),
  import('../src/components/Terminal'),
  import('../src/components/DiffReview/DiffReview'),
]);

function Workspace({ screen }: { screen: Screen }) {
  const noop = () => {};
  const frameStyle = { ['--rail-w' as string]: '0px', ['--panel-w' as string]: '0px', ['--context-w' as string]: '0px', ['--preview-w' as string]: '0px' } as React.CSSProperties;
  // 终端是第 2 行（workspace-shell.css: `.terminal-panel { grid-row: 2 }`），
  // 其余四个视图是 `.main` 里的第 1 行内容，跟 App.tsx 的真实结构一致。
  const bottom = screen.view === 'terminal';
  return (
    <div className="chat-shell" style={frameStyle}>
      <div className="main">
        {screen.view === 'files' && (
          <div className="secondary"><FileTree tree={TREE} workspaceRoot={ROOT} onOpenFile={noop} /></div>
        )}
        {screen.view === 'git' && (
          <div className="secondary"><GitPanel state={state} onOpenFile={noop} /></div>
        )}
        {screen.view === 'editor' && (
          <EditorView
            openFiles={screen.variant === 'open' ? OPEN_FILES : []}
            activeFile={screen.variant === 'open' ? OPEN_FILES[0].path : null}
            onOpenFile={noop}
            onSaveFile={noop}
            onCloseFile={noop}
            onContentChange={noop}
            onReloadExternal={noop}
            onKeepExternal={noop}
            onSetActive={noop}
            editorOptions={{ fontSize: 13, tabSize: 2, minimap: false, wordWrap: false }}
          />
        )}
        {screen.view === 'diff' && (
          <DiffReview
            diffs={screen.variant === 'empty' ? DIFFS.filter((diff) => diff.status !== 'pending') : DIFFS}
            dispatch={noop}
            onApprove={noop}
          />
        )}
      </div>
      {bottom && <Terminal cwd={ROOT} onClose={noop} />}
    </div>
  );
}

function Preview() {
  const [screen, setScreen] = useState<Screen>({ view: 'files', variant: 'mixed', nonce: 0 });
  useEffect(() => {
    (window as unknown as { workspaceShellPreview: unknown }).workspaceShellPreview = {
      reset: (view: View, variant: Variant) => setScreen((current) => ({ view, variant, nonce: current.nonce + 1 })),
      current: () => screen,
    };
    document.documentElement.dataset.previewReady = 'true';
  }, [screen]);
  return <Workspace key={`${screen.view}:${screen.variant}:${screen.nonce}`} screen={screen} />;
}

createRoot(document.getElementById('root')!).render(<Preview />);
