import { useState, useCallback, useEffect } from 'react';
import { MonacoEditor, type MonacoEditorOptions, type MonacoSelection } from './MonacoEditor';
import { EditorTabs, type EditorTab } from './EditorTabs';
import { AlertTriangle, FileText } from 'lucide-react';
import { ConfirmDialog } from '../ConfirmDialog';

export interface ExternalFileSnapshot {
  content: string;
  mtimeMs?: number;
}

export interface OpenFile {
  path: string;
  content: string;
  dirty: boolean;
  language: string;
  /** Latest disk content observed while local edits were still dirty. */
  external?: ExternalFileSnapshot;
  /** The disk content no longer matches the editor's local content. */
  stale?: boolean;
}

export interface EditorViewProps {
  openFiles: OpenFile[];
  activeFile: string | null;
  onOpenFile: (path: string) => void;
  onSaveFile: (path: string, content: string) => void;
  onCloseFile: (path: string) => void;
  onContentChange: (path: string, content: string) => void;
  onReloadExternal: (path: string) => void;
  onKeepExternal: (path: string) => void;
  onSetActive: (path: string) => void;
  /** User editor preferences (settings → 外观); applied to Monaco live. */
  editorOptions?: MonacoEditorOptions;
  /** Request to reveal a 1-based line in a file (quality panel jump). */
  pendingReveal?: { path: string; line: number } | null;
  /** Called after the pending reveal was applied. */
  onRevealDone?: () => void;
  onSelectionChange?: (selection: MonacoSelection) => void;
}

export function EditorView({
  openFiles,
  activeFile,
  onSaveFile,
  onCloseFile,
  onContentChange,
  onReloadExternal,
  onKeepExternal,
  onSetActive,
  editorOptions,
  pendingReveal,
  onRevealDone,
  onSelectionChange,
}: EditorViewProps) {
  const tabs: EditorTab[] = openFiles.map(f => ({ path: f.path, dirty: f.dirty, stale: f.stale }));
  const [pendingClose, setPendingClose] = useState<string | null>(null);

  const handleTabClose = useCallback((path: string) => {
    const file = openFiles.find(f => f.path === path);
    if (file?.dirty) {
      // Dirty tab close asks for confirmation so local edits never vanish silently.
      setPendingClose(path);
      return;
    }
    onCloseFile(path);
  }, [openFiles, onCloseFile]);

  const handleContentChange = useCallback((content: string) => {
    if (activeFile) {
      onContentChange(activeFile, content);
    }
  }, [activeFile, onContentChange]);

  const activeFileData = openFiles.find(f => f.path === activeFile);
  // The theme is on <html data-theme>, which React does not know about — reading
  // it during render left a Monaco instance stuck on the theme it mounted with
  // when the user switched 浅色/深色. Track the attribute instead.
  const [prefersDark, setPrefersDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark',
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const sync = () => setPrefersDark(root.dataset.theme === 'dark');
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  if (openFiles.length === 0) {
    return (
      <div className="editor-empty">
        <FileText size={48} />
        <h2>没有打开的文件</h2>
        <p>从左侧文件树打开文件，或拖放文件到此处</p>
      </div>
    );
  }

  return (
    <>
    <div className="editor-view">
      <EditorTabs
        tabs={tabs}
        activeTab={activeFile}
        onTabClick={onSetActive}
        onTabClose={handleTabClose}
      />
      {activeFileData?.external && (
        <div className="editor-external-banner" role="alert">
          <AlertTriangle size={15} />
          <span>磁盘内容已被外部修改。你可以加载磁盘版本，或继续保留当前本地编辑。</span>
          <button type="button" onClick={() => onReloadExternal(activeFileData.path)}>加载磁盘版本</button>
          <button type="button" className="secondary" onClick={() => onKeepExternal(activeFileData.path)}>继续保留</button>
        </div>
      )}
      {activeFileData && (
        <MonacoEditor
          key={activeFileData.path}
          value={activeFileData.content}
          language={activeFileData.language}
          path={activeFileData.path}
          onChange={handleContentChange}
          onSave={(content) => onSaveFile(activeFileData.path, content)}
          theme={prefersDark ? 'vs-dark' : 'vs-light'}
          editorOptions={{ ...editorOptions, fontFamily: editorOptions?.fontFamily ?? "'JetBrains Mono', 'Cascadia Code', 'SFMono-Regular', Consolas, monospace" }}
          pendingReveal={pendingReveal}
          onRevealDone={onRevealDone}
          onSelectionChange={onSelectionChange}
        />
      )}
    </div>
    <ConfirmDialog
      open={pendingClose !== null}
      title="关闭未保存文件？"
      message={`${pendingClose ?? ''} 有未保存的更改，关闭后这些修改会丢失。`}
      confirmLabel="关闭文件"
      danger
      onConfirm={() => { const path = pendingClose; setPendingClose(null); if (path) onCloseFile(path); }}
      onCancel={() => setPendingClose(null)}
    />
    </>
  );
}
