import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import '../src/conversation-shell.css';
import '../src/workspace-shell.css';
import { useEditorSave } from '../src/lib/useEditorSave';
import type { OpenFile } from '../src/components/Editor/EditorView';

const events: Array<{ kind: string; value: unknown }> = [];
(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = {};
const [{ ConfirmDialog }, { ApprovalModal }, { GuardConfirmationModal }, { ToolCard }, { SaveConflictDialog }] = await Promise.all([
  import('../src/components/ConfirmDialog'), import('../src/components/ApprovalModal'),
  import('../src/components/GuardConfirmationModal'), import('../src/components/ToolCard'), import('../src/components/SaveConflictDialog'),
]);
const request = { id: 'approval', kind: 'approval' as const, requestId: 'test-approval', tool: 'apply_patch', risk: 'write' as const, message: '修改项目中的认证模块', input: { path: 'src/auth/session.ts' } };
let finishGuard: (() => void) | undefined;

function EditorSavePreview() {
  const [workspaceRoot, setWorkspaceRoot] = useState('C:/project');
  const [files, setFiles] = useState<OpenFile[]>([{ path: 'src/auth.ts', content: '未保存的代码', dirty: true, stale: true, language: 'typescript' }]);
  const disk = useRef({ content: '磁盘新版本', mtime: 2, failRead: false, failSave: false, deferred: false, deferredSave: false });
  const reads = useRef(0);
  const writes = useRef(0);
  const release = useRef<(() => void) | null>(null);
  const releaseSave = useRef<(() => void) | null>(null);
  const mtimes = useRef(new Map([['src/auth.ts', 1]]));
  const save = useEditorSave({ workspaceRoot, getFiles: () => files, setFiles, mtimes: mtimes.current,
    editor: {
      stat: async () => ({ ok: true, mtimeMs: disk.current.mtime }),
      readFile: async () => {
        reads.current += 1;
        if (disk.current.deferred) await new Promise<void>((resolve) => { release.current = resolve; });
        return disk.current.failRead ? { ok: false, error: '模拟读取失败' } : { ok: true, content: disk.current.content };
      },
      saveFile: async (_, content) => {
        if (disk.current.failSave) return { ok: false, error: '模拟保存失败' };
        writes.current += 1;
        if (disk.current.deferredSave) await new Promise<void>((resolve) => { releaseSave.current = resolve; });
        disk.current = { ...disk.current, content, mtime: disk.current.mtime + 1 };
        return { ok: true };
      },
    }, onError: (message) => events.push({ kind: 'save-error', value: message }),
  });
  useEffect(() => {
    (window as unknown as { savePreview: unknown }).savePreview = {
      snapshot: () => ({ files, reads: reads.current, writes: writes.current, root: workspaceRoot, disk: disk.current }),
      changeDisk: () => { disk.current.mtime += 1; disk.current.content = '再次变化的磁盘版本'; },
      readFailure: () => { disk.current.failRead = true; },
      writeFailure: () => { disk.current.failSave = true; },
      deferRead: () => { disk.current.deferred = true; }, finishRead: () => release.current?.(),
      deferSave: () => { disk.current.deferredSave = true; }, finishSave: () => { disk.current.deferredSave = false; releaseSave.current?.(); },
      edit: () => setFiles((previous) => previous.map((file) => ({ ...file, content: '保存期间新增的编辑', dirty: true }))),
      switchWorkspace: (root = 'C:/other-project') => { setWorkspaceRoot(root); setFiles([{ path: 'src/auth.ts', content: '新项目内容', dirty: true, stale: true, language: 'typescript' }]); },
    };
  });
  return <><button id="save" type="button" onClick={() => { void save.saveFile('src/auth.ts', files[0].content); }}>保存本地编辑</button>
    <SaveConflictDialog conflict={save.conflict} busy={save.busy} onKeep={save.cancel} onReload={() => { void save.reload(); }} onOverwrite={() => { void save.overwrite(); }} /></>;
}

function Preview() {
  const [scenario, setScenario] = useState('closed');
  const [approvalBehind, setApprovalBehind] = useState(false);
  const [tick, setTick] = useState(0);
  const record = (kind: string, value?: unknown) => { events.push({ kind, value }); setScenario('closed'); };
  useEffect(() => {
    (window as unknown as { dialogPreview: unknown }).dialogPreview = {
      open: (next: string) => { setApprovalBehind(false); setScenario(next); }, rerender: () => setTick((value) => value + 1), events: () => events,
      showApproval: () => setApprovalBehind(true), hideApproval: () => setApprovalBehind(false),
      clear: () => { events.length = 0; }, finish: () => finishGuard?.(),
    };
    document.documentElement.dataset.dialogPreviewReady = 'true';
  }, []);
  return <main className="app-shell">
    <button type="button" id="trigger" onClick={() => setScenario('confirm')}>关闭文件</button>
    <input id="background-input" aria-label="背景编辑器" defaultValue="未保存的代码" />
    <span hidden>{tick}</span>
    {scenario === 'save' && <EditorSavePreview />}
    {(scenario === 'approval' || approvalBehind) && <>
      <ToolCard item={request} onApprove={(_, decision) => record('inline', decision)} />
      <ToolCard item={{ ...request, id: 'other', requestId: 'other-approval' }} onApprove={(_, decision) => record('other-inline', decision)} />
      <ApprovalModal item={request} onApprove={(_, decision) => record('approval', decision)} />
    </>}
    <ConfirmDialog key={scenario === 'mounted-confirm' ? 'mounted' : 'default'} open={scenario === 'confirm' || scenario === 'mounted-confirm'} title="放弃未保存修改？" message="本地修改会丢失。" confirmLabel="放弃修改" danger onConfirm={() => record('confirm')} onCancel={() => record('cancel')} />
    <GuardConfirmationModal request={scenario === 'guard' ? { requestId: 'guard', sessionId: 'fixture', title: '选择操作', question: '需要先检查还是先修改？', options: [{ label: '检查', description: '查看项目结构' }, { label: '修改', description: '修改实现' }] } : null}
      onChoose={async (_, value) => {
        events.push({ kind: 'guard', value });
        await new Promise<void>((resolve) => { finishGuard = resolve; });
        setScenario('closed');
      }} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Preview /></React.StrictMode>);
