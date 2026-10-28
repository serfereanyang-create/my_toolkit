/*
 * focus-preview.tsx — fixture for scripts/focus-probe.cjs (keyboard-focus audit).
 *
 * What this is: the REAL components from src/components, mounted by Vite, with
 * the REAL stylesheets imported in the production order (main.tsx). Nothing
 * here re-implements a component or a focus rule; the point of the fixture is
 * that the probe measures the shipped CSS cascade (six files, later file wins
 * at equal specificity) rather than a hand-written approximation of it.
 *
 * Surfaces are opened one at a time through window.focusPreview so the probe
 * can, for each one: Tab to the opener, open the surface with a real key/mouse
 * event, walk Tab/Shift+Tab, read the painted ring, and check that Escape
 * closes it and hands focus back to the thing that opened it.
 *
 * The Composer is mounted permanently as the "app behind the overlay": it is
 * the real input surface whose focus must come back after a dialog closes, and
 * typing '@' or '/' into it opens the real MentionPicker / SlashCommandMenu,
 * which is how the probe reaches those two without poking at internals.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '../src/styles.css';
import '../src/conversation-shell.css';
import '../src/settings-shell.css';
import '../src/workspace-shell.css';
import '../src/background-browser.css';
import '../src/gui-control.css';

type Surface =
  | 'none' | 'confirm' | 'approval' | 'guard' | 'tag' | 'help'
  | 'cmd' | 'qopen';

const TREE = [
  { name: 'src', path: 'src', type: 'directory' as const, children: [
    { name: 'auth.ts', path: 'src/auth.ts', type: 'file' as const },
    { name: 'session.ts', path: 'src/session.ts', type: 'file' as const },
  ] },
  { name: 'README.md', path: 'README.md', type: 'file' as const },
];

/* Only the three endpoints the mounted components actually await. A blanket
   proxy would be dishonest: these stubs are the exact call surface, so a
   component that starts calling something new fails loudly here instead of
   silently getting undefined. */
(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = {
  nav: { fileSearch: async () => TREE.flatMap((node) => node.type === 'file' ? [node] : (node.children ?? [])).map((file) => ({ name: file.name, path: file.path, type: file.type })) },
  quickopen: { index: async () => ({ files: [
    { path: 'src/auth.ts', mtime: Date.now() }, { path: 'src/session.ts', mtime: Date.now() },
    { path: 'README.md', mtime: Date.now() },
  ], truncated: false }) },
  app: { getVersion: async () => ({ version: '1.0.0' }) },
};

const [{ Composer }, { ConfirmDialog }, { ApprovalModal }, { GuardConfirmationModal },
  { TagEditorDialog }, { HelpOverlay }, { CommandPalette }, { QuickOpen }, { initialState }] =
  await Promise.all([
    import('../src/components/Composer'),
    import('../src/components/ConfirmDialog'),
    import('../src/components/ApprovalModal'),
    import('../src/components/GuardConfirmationModal'),
    import('../src/components/TagEditorDialog'),
    import('../src/components/HelpOverlay'),
    import('../src/components/CommandPalette'),
    import('../src/components/QuickOpen'),
    import('../src/lib/state'),
  ]);

const settings = {
  activeProviderId: 'p', approval: 'ask' as const, recentWorkspaces: [],
  providers: [{ id: 'p', type: 'custom' as const, label: '工作模型', baseUrl: 'https://preview.invalid', model: 'gpt-5.4', models: [{ id: 'gpt-5.4', contextWindow: 128000 }] }],
  preferences: {},
};

type Cmd = { id: string; title: string; group: 'view' | 'chat' | 'editor' | 'panels' | 'settings' | 'workspace'; enabled?: boolean; run: () => void };
const COMMANDS: Cmd[] = [
  { id: 'a', title: '新建对话', group: 'chat', run: () => {} },
  { id: 'b', title: '打开终端', group: 'panels', run: () => {} },
  { id: 'c', title: '打开设置', group: 'settings', run: () => {} },
];

function Preview() {
  const [surface, setSurface] = useState<Surface>('none');
  const [approvalItem, setApprovalItem] = useState<null | Record<string, unknown>>(null);
  const state = useMemo(() => ({
    ...initialState,
    settings: { ...settings, preferences: { ...settings.preferences, 'gen.sendShortcut': 'enter' } },
    workspaceRoot: 'C:/workspace/focus',
    tree: TREE,
    chat: [],
  }), []);

  const close = useCallback(() => { setSurface('none'); setApprovalItem(null); }, []);

  useEffect(() => {
    (window as unknown as { focusPreview: unknown }).focusPreview = {
      open(name: Surface) {
        if (name === 'approval') {
          setApprovalItem({
            id: 'approval', kind: 'approval', requestId: 'req-1', tool: 'run_command', risk: 'shell',
            message: '允许执行 npm test 吗？', input: { command: 'npm test' },
          });
        }
        setSurface(name);
      },
      close,
      surface: () => surface,
    };
  }, [close, surface]);

  return (
    <div className="chat-shell">
      <div className="main">
        {/* The "app behind the overlay". The opener is a plain button so the
            probe can prove Escape returns focus to the exact element that
            opened the dialog rather than to <body>. */}
        <button type="button" id="opener" className="icon-button" aria-label="打开面板">打开</button>
        <button type="button" id="behind-1" className="icon-button" aria-label="背后按钮一">一</button>
        <button type="button" id="behind-2" className="icon-button" aria-label="背后按钮二">二</button>
        <div className="composer-wrap">
          <div className="composer">
            <Composer
              state={state as never}
              onSubmit={() => {}}
              onCancel={() => {}}
              onPickApproval={() => {}}
              onPickPlugin={() => {}}
              onPickModel={() => {}}
              onPickEffort={() => {}}
              onPickToolScope={() => {}}
              onManageModels={() => {}}
            />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={surface === 'confirm'} title="放弃未保存的修改？" danger
        message="这个文件有未保存的修改，关闭后会丢失。" confirmLabel="放弃修改"
        onConfirm={close} onCancel={close}
      />

      <ApprovalModal item={surface === 'approval' ? (approvalItem as never) : null} onApprove={close} />

      <GuardConfirmationModal
        request={surface === 'guard' ? {
          requestId: 'guard-1', sessionId: 's', title: '需要确认范围',
          question: '这次改动会触及工作区之外的文件，要怎么做？',
          options: [
            { label: '修改', description: '继续按当前计划修改' },
            { label: '取消本次需求', description: '停止这次请求' },
            { label: '检查', description: '只做只读检查' },
          ],
        } : null}
        onChoose={async () => { close(); }}
      />

      {surface === 'tag' && (
        <TagEditorDialog
          sessionTitle="认证流程与边界检查" initialTags={['bug', 'wip']} allTags={['bug', 'wip', '实验', 'ui']}
          onConfirm={close} onCancel={close}
        />
      )}

      {surface === 'help' && <HelpOverlay initialTab="help" onClose={close} />}

      {surface === 'cmd' && <CommandPalette commands={COMMANDS as never} onClose={close} />}

      <QuickOpen open={surface === 'qopen'} onClose={close} onPick={close} workspaceRoot="C:/workspace/focus" />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);

/* The probe waits on this instead of a fixed sleep, so a slow first paint
   shows up as a clear timeout rather than a table full of phantom misses. */
requestAnimationFrame(() => requestAnimationFrame(() => {
  document.documentElement.dataset.focusPreviewReady = 'true';
}));
