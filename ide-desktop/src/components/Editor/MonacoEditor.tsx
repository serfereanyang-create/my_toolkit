import { useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { editorContext } from '../../lib/editorContext';
import { GhostTextRenderer } from '../../lib/ghostText';
import { CompletionTrigger } from '../../lib/completionTrigger';
import { InlineEditWidget } from '../../lib/inlineEdit';
import { registerLanguageProviders } from '../../lib/languageProviders';
import { desktop, type Bookmark } from '../../lib/ipc';

export interface MonacoEditorOptions {
  fontSize?: number;
  fontFamily?: string;
  tabSize?: number;
  minimap?: boolean;
  wordWrap?: boolean;
}

export interface MonacoEditorProps {
  value: string;
  language: string;
  path: string;
  onChange: (value: string) => void;
  /** Called with the current model value when Ctrl/Cmd+S is pressed. */
  onSave?: (value: string) => void | Promise<void>;
  theme?: 'vs-dark' | 'vs-light';
  /** User preferences from settings; applied at mount and live-updated. */
  editorOptions?: MonacoEditorOptions;
  /** Request to reveal a 1-based line in this file (quality panel jump). */
  pendingReveal?: { path: string; line: number } | null;
  /** Called after the pending reveal was applied so the requester can clear it. */
  onRevealDone?: () => void;
}

export function MonacoEditor({ value, language, path, onChange, onSave, theme = 'vs-dark', editorOptions, pendingReveal, onRevealDone }: MonacoEditorProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  // The monaco editor instance is reused when the user switches tabs, so
  // onMount handlers must not capture `path` from the mount-time closure.
  const pathRef = useRef(path);
  pathRef.current = path;
  const ghostRendererRef = useRef<GhostTextRenderer | null>(null);
  const triggerRef = useRef<CompletionTrigger | null>(null);
  const inlineEditRef = useRef<InlineEditWidget | null>(null);
  const languageDisposableRef = useRef<(() => void) | null>(null);
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  // Iteration 6 — line bookmarks: gutter toggling, decorations, persistence.
  const bookmarkDecosRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const bookmarksRef = useRef<Bookmark[]>([]);
  // Monaco 是懒加载的（见 lib/monacoRuntime.ts）：它进首屏 chunk 会让每次启动
  // 都先解析一整个编辑器。这里是它真正被需要的地方——第一次画编辑器时拉一次。
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import('../../lib/monacoRuntime')
      .then((module) => module.ensureMonaco())
      .then(() => { if (!cancelled) setRuntimeReady(true); })
      .catch((error: unknown) => {
        if (!cancelled) setRuntimeError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, []);

  /** Re-paint bookmark decorations from bookmarksRef against the live model. */
  function repaintBookmarks() {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    const maxLine = model.getLineCount();
    const decorations: Monaco.editor.IModelDeltaDecoration[] = [];
    for (const bm of bookmarksRef.current) {
      if (bm.line < 1 || bm.line > maxLine) continue; // drifted off-file; hidden
      decorations.push({
        range: new monaco.Range(bm.line, 1, bm.line, 1),
        options: {
          isWholeLine: false,
          linesDecorationsClassName: 'bookmark-gutter-icon',
          glyphMarginClassName: bm.note ? 'bookmark-gutter-note' : undefined,
          hoverMessage: { value: bm.note ? `**书签** ${bm.note}` : '**书签**' },
          overviewRuler: { color: 'rgba(200, 117, 61, 0.85)', position: 4 },
        },
      });
    }
    bookmarkDecosRef.current?.clear();
    bookmarkDecosRef.current = editor.createDecorationsCollection(decorations);
  }

  /** Load this file's bookmarks from the workspace sidecar store. */
  function reloadBookmarks(targetPath: string) {
    if (!targetPath) return;
    desktop.bookmarks.listFor(targetPath).then((list) => {
      bookmarksRef.current = list;
      repaintBookmarks();
    }).catch(() => { /* no workspace / store error: show nothing */ });
  }

  /** Toggle a bookmark on a 1-based line; `anchor` stores the line text. */
  async function toggleBookmarkAt(targetPath: string, line: number) {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !targetPath) return;
    if (line < 1 || line > model.getLineCount()) return;
    const anchor = model.getLineContent(line).trim().slice(0, 240);
    try {
      const res = await desktop.bookmarks.toggle(targetPath, line, anchor);
      const list = await desktop.bookmarks.listFor(targetPath);
      bookmarksRef.current = list;
      repaintBookmarks();
      void res;
    } catch { /* store full or invalid: keep prior decorations */ }
  }

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

    // Register real language providers (hover, go-to-def, find-refs) for TS/JS
    const model = editor.getModel();
    if (model) {
      languageDisposableRef.current = registerLanguageProviders(monaco, model) ?? null;
    }

    // 初始化幽灵文本渲染器
    ghostRendererRef.current = new GhostTextRenderer(editor, monaco);

    // 初始化补全触发器
    triggerRef.current = new CompletionTrigger(ghostRendererRef.current);
    triggerRef.current.start();

    // 初始化内联编辑 Widget
    inlineEditRef.current = new InlineEditWidget(editor, monaco);

    // 配置编辑器选项：用户偏好优先，未设置时用默认值
    editor.updateOptions({
      fontSize: editorOptions?.fontSize ?? 13,
      fontFamily: editorOptions?.fontFamily,
      lineNumbers: 'on',
      glyphMargin: true,
      minimap: { enabled: editorOptions?.minimap ?? true },
      wordWrap: (editorOptions?.wordWrap ?? false) ? 'on' : 'off',
      tabSize: editorOptions?.tabSize ?? 2,
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
      onSaveRef.current?.(currentValue);
    });

    // Iteration 6: glyph-margin click toggles a bookmark on that line.
    editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      if (!e.target.position) return;
      void toggleBookmarkAt(pathRef.current, e.target.position.lineNumber);
    });

    reloadBookmarks(path);
  };

  // Refresh bookmark decorations when the active tab changes (the editor
  // instance itself is reused across tabs).
  useEffect(() => {
    reloadBookmarks(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined) {
      onChange(value);
    }
  };

  // Live-apply editor preference changes without remounting. Primitive deps
  // keep this off the render path when nothing actually changed.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions({
      fontSize: editorOptions?.fontSize ?? 13,
      fontFamily: editorOptions?.fontFamily,
      minimap: { enabled: editorOptions?.minimap ?? true },
      wordWrap: (editorOptions?.wordWrap ?? false) ? 'on' : 'off',
      tabSize: editorOptions?.tabSize ?? 2,
    });
  }, [editorOptions?.fontSize, editorOptions?.tabSize, editorOptions?.minimap, editorOptions?.wordWrap]);

  // Reveal a requested line (quality panel "jump to source"). The editor may
  // still be mounting when the request arrives — retry briefly until ready.
  useEffect(() => {
    if (!pendingReveal || pendingReveal.path !== path) return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      const editor = editorRef.current;
      if (!editor) {
        if (attempts < 20) {
          attempts += 1;
          timer = setTimeout(apply, 100);
        }
        return;
      }
      editor.revealLineInCenter(pendingReveal.line);
      editor.setPosition({ lineNumber: pendingReveal.line, column: 1 });
      editor.focus();
      onRevealDone?.();
    };
    apply();
    return () => { if (timer) clearTimeout(timer); };
  }, [pendingReveal, path, onRevealDone]);

  // 清理函数
  useEffect(() => {
    return () => {
      triggerRef.current?.stop();
      ghostRendererRef.current?.hide();
      inlineEditRef.current?.hide();
      languageDisposableRef.current?.();
      editorContext.dispose();
    };
  }, []);

  if (runtimeError) {
    return (
      <div className="monaco-container monaco-status" role="alert">
        编辑器加载失败：{runtimeError}
      </div>
    );
  }

  return (
    <div className="monaco-container">
      {runtimeReady ? <Editor
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
      /> : (
        <div className="monaco-status" aria-live="polite">正在加载编辑器…</div>
      )}
    </div>
  );
}
