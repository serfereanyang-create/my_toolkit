/**
 * Harness for scripts/memory-panel-smoke.cjs: renders MemoryPanel against a
 * recording stand-in for the desktop bridge.
 *
 * `desktop` in src/lib/ipc.ts is captured from window.zcodeDesktop at module
 * evaluation time, so the stub is installed first and the component imported
 * dynamically afterwards. Load with #empty to render the "nothing recorded
 * yet" state instead of a populated history.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import '../src/workspace-shell.css';

// Query, not hash: a hash-only navigation would not re-run this module.
const mode = new URLSearchParams(window.location.search).get('mode') || 'full';

const SNAPSHOT = {
  ok: true,
  root: 'C:/Users/tester/.zcode/cli/memories/global',
  indexPath: 'C:/Users/tester/.zcode/cli/memories/global/MEMORY.md',
  markdown: '# 全局记忆\n\n## zcode\n- ide-desktop/electron/git.cjs\n- cli/src/tools/git-write.ts\n',
  updatedAt: Date.now(),
  totalEdits: 8,
  totalFiles: 42,
  projects: [
    {
      project: 'zcode',
      workspace: 'C:/work/zcode',
      edits: 6,
      lastAt: '2026-10-22T11:00:00.000Z',
      fileTotal: 41,
      files: [
        { path: 'ide-desktop/electron/git.cjs', at: '2026-10-22T11:00:00.000Z', count: 3, created: false },
        { path: 'cli/src/tools/git-write.ts', at: '2026-10-22T10:00:00.000Z', count: 1, created: false, renamed: true },
        { path: 'docs/plan.md', at: '2026-10-22T09:00:00.000Z', count: 1, created: true },
        { path: 'docs/old-notes.md', at: '2026-10-22T08:00:00.000Z', count: 1, created: false, deleted: true },
      ],
    },
    {
      project: 'cidai',
      workspace: 'C:/work/cidai',
      edits: 2,
      lastAt: '2026-10-21T20:00:00.000Z',
      fileTotal: 1,
      files: [{ path: 'app/src/main/java/Glass.kt', at: '2026-10-21T20:00:00.000Z', count: 2, created: false }],
    },
  ],
  // Oldest first, like the real append-only ledger.
  records: [
    { at: '2026-10-21T20:00:00.000Z', project: 'cidai', workspace: 'C:/work/cidai', action: 'write', path: 'app/src/main/java/Glass.kt', created: false },
    { at: '2026-10-22T08:00:00.000Z', project: 'zcode', workspace: 'C:/work/zcode', action: 'delete', path: 'docs/old-notes.md', created: false },
    { at: '2026-10-22T10:00:00.000Z', project: 'zcode', workspace: 'C:/work/zcode', action: 'rename', path: 'cli/src/tools/git-write.ts', from: 'cli/src/git-write.ts', created: false },
    { at: '2026-10-22T11:00:00.000Z', project: 'zcode', workspace: 'C:/work/zcode', action: 'write', path: 'ide-desktop/electron/git.cjs', created: false },
  ],
};

const EMPTY = {
  ok: true,
  root: SNAPSHOT.root,
  indexPath: SNAPSHOT.indexPath,
  markdown: '',
  updatedAt: 0,
  totalEdits: 0,
  projects: [],
  records: [],
};

const PROJECT_NOTES = [
  {
    id: 'zcode-b2c88be133bfd876',
    label: 'zcode',
    updatedAt: Date.now(),
    files: [
      { name: 'MEMORY.md', path: 'C:/mem/MEMORY.md', kind: 'index', size: 2848, updatedAt: Date.now() },
      { name: 'pcb-project-led-cct-lamp.md', path: 'C:/mem/pcb.md', kind: 'item', size: 812, updatedAt: Date.now() },
    ],
  },
];

const calls: string[] = [];
window.__memoryCalls = calls;
window.__opened = [];

const desktopStub = {
  memory: {
    global: async () => {
      calls.push('global');
      return mode === 'empty' ? EMPTY : SNAPSHOT;
    },
    listProjects: async () => {
      calls.push('listProjects');
      return { ok: true, projects: mode === 'empty' ? [] : PROJECT_NOTES };
    },
    read: async (workspaceId: string, fileName: string) => {
      calls.push(`read:${workspaceId}/${fileName}`);
      return { ok: true, content: `# ${fileName}\n`, updatedAt: Date.now() };
    },
  },
};

(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = desktopStub;

const container = document.getElementById('root')!;
const root = createRoot(container);

async function boot() {
  const { MemoryPanel } = await import('../src/components/MemoryPanel');
  root.render(
    <MemoryPanel
      onOpenFile={(path) => {
        (window.__opened as string[]).push(path);
      }}
    />,
  );
}

void boot();
