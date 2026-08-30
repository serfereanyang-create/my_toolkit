import { useEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { editorContext } from '../../lib/editorContext';
import { GhostTextRenderer } from '../../lib/ghostText';
import { CompletionTrigger } from '../../lib/completionTrigger';
import { InlineEditWidget } from '../../lib/inlineEdit';
import { desktop } from '../../lib/ipc';

export interface MonacoEditorProps {
  value: string;
  language: string;
  path: string;
  onChange: (value: string) => void;
  theme?: 'vs-dark' | 'vs-light';
}

export function MonacoEditor({ value, language, path, onChange, theme = 'vs-dark' }: MonacoEditorProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const ghostRendererRef = useRef<GhostTextRenderer | null>(null);
  const triggerRef = useRef<CompletionTrigger | null>(null);
  const inlineEditRef = useRef<InlineEditWidget | null>(null);
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);

  // Inline "agent changed these lines" highlights: fetch changed ranges from
  // git diff for this file and paint them with a soft accent background.
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    desktop.git.fileChangeRanges(path).then((result) => {
      if (cancelled || !result.ok || !result.hunks?.length) return;
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;
      const decorations: Monaco.editor.IModelDeltaDecoration[] = result.hunks.map((hunk) => ({
        range: new monaco.Range(hunk.start, 1, hunk.end + 1, 1),
        options: {
          isWholeLine: true,
          className: 'agent-changed-line',
          overviewRuler: { color: '#2f81f7', position: 4 },
          minimap: { color: '#2f81f7', position: 1 },
        },
      }));
      decorationsRef.current?.clear();
      decorationsRef.current = editor.createDecorationsCollection(decorations);
    }).catch(() => { /* not a git workspace or file untracked: no highlights */ });
    return () => { cancelled = true; };
  }, [path, value]);


  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // 初始化上下文追踪
    editorContext.setEditor(editor, monaco, path);

    // 初始化幽灵文本渲染器
    ghostRendererRef.current = new GhostTextRenderer(editor, monaco);

    // 初始化补全触发器
    triggerRef.current = new CompletionTrigger(ghostRendererRef.current);
    triggerRef.current.start();

    // 初始化内联编辑 Widget
    inlineEditRef.current = new InlineEditWidget(editor, monaco);

    // 配置编辑器选项
    editor.updateOptions({
      fontSize: 13,
      lineNumbers: 'on',
      minimap: { enabled: true },
      wordWrap: 'off',
      tabSize: 2,
      insertSpaces: true,
      rulers: [80, 120],
      scrollBeyondLastLine: false,
      automaticLayout: true,
      quickSuggestions: false, // 禁用 Monaco 内置补全
      suggestOnTriggerCharacters: false,
      acceptSuggestionOnCommitCharacter: false,
      tabCompletion: 'off',
      wordBasedSuggestions: 'off',
    });

    // Tab 键接受建议
    editor.addCommand(monaco.KeyCode.Tab, () => {
      if (ghostRendererRef.current?.hasSuggestion()) {
        ghostRendererRef.current.accept();
      } else {
        // 没有建议时，执行默认的 Tab 缩进
        editor.trigger('keyboard', 'tab', null);
      }
    });

    // Esc 键取消建议
    editor.addCommand(monaco.KeyCode.Escape, () => {
      if (ghostRendererRef.current?.hasSuggestion()) {
        ghostRendererRef.current.hide();
      }
    });

    // Ctrl+Space 手动触发补全
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
      triggerRef.current?.triggerManual();
    });

    // Cmd+K 快捷编辑
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
      inlineEditRef.current?.show();
    });

    // Ctrl+S / Cmd+S 保存
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const currentValue = editor.getValue();
      onChange(currentValue);
    });
  };

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined) {
      onChange(value);
    }
  };

  // 清理函数
  useEffect(() => {
    return () => {
      triggerRef.current?.stop();
      ghostRendererRef.current?.hide();
      inlineEditRef.current?.hide();
      editorContext.dispose();
    };
  }, []);

  return (
    <div className="monaco-container">
      <Editor
        height="100%"
        language={language}
        value={value}
        theme={theme}
        path={path}
        onChange={handleEditorChange}
        onMount={handleEditorDidMount}
        options={{
          readOnly: false,
        }}
      />
    </div>
  );
}
