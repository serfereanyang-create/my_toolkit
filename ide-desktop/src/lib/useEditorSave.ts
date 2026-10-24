import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { OpenFile } from '../components/Editor/EditorView';
import type { desktop } from './ipc';

export type SaveConflict = { path: string; content: string; workspaceRoot: string; diskMtime: number };
type Options = {
  workspaceRoot: string;
  getFiles: () => OpenFile[];
  setFiles: Dispatch<SetStateAction<OpenFile[]>>;
  mtimes: Map<string, number>;
  editor: Pick<typeof desktop.editor, 'stat' | 'readFile' | 'saveFile'>;
  onError: (message: string) => void;
};
type WorkspaceScope = { root: string; sequence: number };

export function useEditorSave(options: Options) {
  const [conflict, setConflict] = useState<SaveConflict | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useRef(options);
  current.current = options;
  const inFlight = useRef(new Set<string>());
  const workspace = useRef<WorkspaceScope>({ root: options.workspaceRoot, sequence: 0 });
  if (workspace.current.root !== options.workspaceRoot) {
    workspace.current = { root: options.workspaceRoot, sequence: workspace.current.sequence + 1 };
  }
  const pending = useRef<SaveConflict | null>(null);

  useEffect(() => {
    pending.current = null;
    setConflict(null);
    setBusy(false);
  }, [options.workspaceRoot]);

  const isCurrent = (scope: WorkspaceScope, path: string) => workspace.current === scope
    && current.current.workspaceRoot === scope.root
    && current.current.getFiles().some((file) => file.path === path);

  async function saveFile(path: string, content: string, overwriteMtime?: number) {
    const context = current.current;
    const scope = workspace.current;
    const operation = `${scope.sequence}\0${path}`;
    if (inFlight.current.has(operation) || !isCurrent(scope, path)) return;
    inFlight.current.add(operation);
    try {
      const disk = await context.editor.stat(path);
      if (!isCurrent(scope, path)) return;
      if (!disk.ok || disk.mtimeMs === undefined) throw new Error('无法确认磁盘文件状态，本地编辑已保留。');
      const file = current.current.getFiles().find((candidate) => candidate.path === path)!;
      const known = context.mtimes.get(path);
      const diskChanged = known !== undefined && known !== disk.mtimeMs;
      const confirmationChanged = overwriteMtime !== undefined && overwriteMtime !== disk.mtimeMs;
      if ((file.stale || diskChanged || confirmationChanged) && overwriteMtime !== disk.mtimeMs) {
        setConflict({ path, content: file.content, workspaceRoot: scope.root, diskMtime: disk.mtimeMs });
        return;
      }
      const result = await context.editor.saveFile(path, content);
      if (!isCurrent(scope, path)) return;
      if (!result.ok) throw new Error(result.error || '保存失败，本地编辑已保留。');
      const after = await context.editor.stat(path);
      if (!isCurrent(scope, path)) return;
      if (after.ok && after.mtimeMs !== undefined) context.mtimes.set(path, after.mtimeMs);
      context.setFiles((files) => workspace.current !== scope ? files : files.map((candidate) => {
        if (candidate.path !== path) return candidate;
        if (candidate.content !== content) return { ...candidate, dirty: true, external: undefined, stale: false };
        return { ...candidate, dirty: false, external: undefined, stale: false };
      }));
      setConflict((confirmation) => confirmation?.path === path && confirmation.workspaceRoot === scope.root ? null : confirmation);
    } catch (error) {
      if (isCurrent(scope, path)) context.onError(error instanceof Error ? error.message : String(error));
    } finally { inFlight.current.delete(operation); }
  }

  async function resolveConflict(action: 'reload' | 'overwrite') {
    if (!conflict || pending.current) return;
    const request = conflict;
    const context = current.current;
    const scope = workspace.current;
    if (scope.root !== request.workspaceRoot || !isCurrent(scope, request.path)) { setConflict(null); return; }
    const file = context.getFiles().find((candidate) => candidate.path === request.path)!;
    if (file.content !== request.content) {
      setConflict(null);
      context.onError('编辑内容已变化，请重新保存以确认最新版本。');
      return;
    }
    pending.current = request;
    setBusy(true);
    try {
      if (action === 'overwrite') {
        await saveFile(request.path, request.content, request.diskMtime);
      } else {
        const before = await context.editor.stat(request.path);
        if (!isCurrent(scope, request.path)) return;
        const fresh = await context.editor.readFile(request.path);
        if (!isCurrent(scope, request.path)) return;
        const after = await context.editor.stat(request.path);
        if (!isCurrent(scope, request.path)) return;
        if (!fresh.ok || fresh.content === undefined) throw new Error(fresh.error || '读取失败，本地编辑已保留。');
        if (!before.ok || !after.ok || before.mtimeMs === undefined || before.mtimeMs !== after.mtimeMs) throw new Error('读取期间磁盘文件再次变化，本地编辑已保留，请重新检查。');
        if (current.current.getFiles().find((candidate) => candidate.path === request.path)?.content !== request.content) throw new Error('读取期间编辑内容已变化，本地编辑已保留。');
        const content = fresh.content;
        context.mtimes.set(request.path, after.mtimeMs!);
        context.setFiles((files) => workspace.current !== scope ? files : files.map((candidate) => candidate.path === request.path && candidate.content === request.content
          ? { ...candidate, content, dirty: false, external: undefined, stale: false } : candidate));
        setConflict(null);
      }
    } catch (error) {
      if (isCurrent(scope, request.path)) context.onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  return { conflict, busy, saveFile, cancel: () => { if (!pending.current) setConflict(null); },
    reload: () => resolveConflict('reload'), overwrite: () => resolveConflict('overwrite') };
}
