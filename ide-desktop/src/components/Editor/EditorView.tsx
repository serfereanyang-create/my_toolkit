import { useState, useCallback } from 'react';
import { MonacoEditor, type MonacoEditorOptions } from './MonacoEditor';
import { EditorTabs, type EditorTab } from './EditorTabs';
import { FileText } from 'lucide-react';

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
  onSetActive: (path: string) => void;
  /** User editor preferences (settings → 外观); applied to Monaco live. */
  editorOptions?: MonacoEditorOptions;
  /** Request to reveal a 1-based line in a file (quality panel jump). */
  pendingReveal?: { path: string; line: number } | null;
  /** Called after the pending reveal was applied. */
  onRevealDone?: () => void;
}

// Detect language from file extension
function detectLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'go': 'go',
    'rs': 'rust',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'h': 'cpp',
    'hpp': 'cpp',
    'cs': 'csharp',
    'rb': 'ruby',
    'php': 'php',
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'json': 'json',
    'xml': 'xml',
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'less': 'less',
    'md': 'markdown',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'sql': 'sql',
  };
  return languageMap[ext || ''] || 'plaintext';
}

export function EditorView({
  openFiles,
  activeFile,
  onSaveFile,
  onCloseFile,
  onContentChange,
  onSetActive,
  editorOptions,
  pendingReveal,
  onRevealDone,
}: EditorViewProps) {
  const tabs: EditorTab[] = openFiles.map(f => ({ path: f.path, dirty: f.dirty, stale: f.stale }));

  const handleTabClose = useCallback((path: string) => {
    const file = openFiles.find(f => f.path === path);
    if (file?.dirty) {
      // Dirty tab close asks for confirmation so local edits never vanish silently.
      const confirmed = confirm(`${path} 有未保存的更改。是否关闭？`);
      if (!confirmed) return;
    }
    onCloseFile(path);
  }, [openFiles, onCloseFile]);

  const handleContentChange = useCallback((content: string) => {
    if (activeFile) {
      onContentChange(activeFile, content);
    }
  }, [activeFile, onContentChange]);

  const activeFileData = openFiles.find(f => f.path === activeFile);
  const prefersDark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';

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
    <div className="editor-view">
      <EditorTabs
        tabs={tabs}
        activeTab={activeFile}
        onTabClick={onSetActive}
        onTabClose={handleTabClose}
      />
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
        />
      )}
    </div>
  );
}
