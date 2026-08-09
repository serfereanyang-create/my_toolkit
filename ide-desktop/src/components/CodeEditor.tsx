import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import type { EditorTab } from '../types';

export function CodeEditor({ tab, onChange, onSave }: { tab?: EditorTab; onChange: (content: string) => void; onSave: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    if (!hostRef.current || editorRef.current) return;
    editorRef.current = monaco.editor.create(hostRef.current, {
      value: '',
      language: 'plaintext',
      theme: 'vs',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 2,
    });
    const disposable = editorRef.current.onDidChangeModelContent(() => onChange(editorRef.current?.getValue() ?? ''));
    editorRef.current.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);
    return () => {
      disposable.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, [onChange, onSave]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !tab) return;
    const model = monaco.editor.createModel(tab.content, tab.language, monaco.Uri.parse(`file:///${tab.path}`));
    const oldModel = editor.getModel();
    editor.setModel(model);
    oldModel?.dispose();
  }, [tab?.path]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !tab) return;
    if (editor.getValue() !== tab.content) editor.setValue(tab.content);
  }, [tab?.content]);

  if (!tab) return <div className="empty-editor">Open a file from the sidebar.</div>;
  return <div className="code-editor" ref={hostRef} />;
}
