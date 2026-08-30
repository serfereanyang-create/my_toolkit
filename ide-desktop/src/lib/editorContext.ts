import type * as Monaco from 'monaco-editor';

export type Position = {
  line: number;
  column: number;
};

export type EditorContext = {
  filePath: string;
  language: string;
  content: string;
  cursorLine: number;
  cursorColumn: number;
  selection: { start: Position; end: Position } | null;
  visibleRange: { start: number; end: number };
};

/**
 * 编辑器上下文追踪器
 * 追踪当前编辑器状态：文件路径、光标位置、选区、可见范围等
 * 供 AI 代码补全和编辑功能使用
 */
export class EditorContextTracker {
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private monaco: typeof Monaco | null = null;
  private filePath: string = '';
  private listeners: Array<(ctx: EditorContext) => void> = [];
  private disposeCallbacks: Array<() => void> = [];

  /**
   * 设置当前活跃的编辑器实例
   */
  setEditor(editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco, filePath: string) {
    // 清理之前的监听器
    this.dispose();

    this.editor = editor;
    this.monaco = monaco;
    this.filePath = filePath;

    // 监听光标移动
    const cursorDispose = editor.onDidChangeCursorPosition(() => {
      this.notifyListeners();
    });
    this.disposeCallbacks.push(() => cursorDispose.dispose());

    // 监听内容变化
    const contentDispose = editor.onDidChangeModelContent(() => {
      this.notifyListeners();
    });
    this.disposeCallbacks.push(() => contentDispose.dispose());

    // 监听选区变化
    const selectionDispose = editor.onDidChangeCursorSelection(() => {
      this.notifyListeners();
    });
    this.disposeCallbacks.push(() => selectionDispose.dispose());

    // 初始通知
    this.notifyListeners();
  }

  /**
   * 获取当前编辑器上下文
   */
  getContext(): EditorContext | null {
    if (!this.editor || !this.monaco) return null;

    const model = this.editor.getModel();
    if (!model) return null;

    const position = this.editor.getPosition();
    const selection = this.editor.getSelection();
    const visibleRanges = this.editor.getVisibleRanges();

    return {
      filePath: this.filePath,
      language: model.getLanguageId(),
      content: model.getValue(),
      cursorLine: position?.lineNumber ?? 1,
      cursorColumn: position?.column ?? 1,
      selection: selection && !selection.isEmpty() ? {
        start: { line: selection.startLineNumber, column: selection.startColumn },
        end: { line: selection.endLineNumber, column: selection.endColumn }
      } : null,
      visibleRange: visibleRanges[0] ? {
        start: visibleRanges[0].startLineNumber,
        end: visibleRanges[0].endLineNumber
      } : { start: 1, end: 100 }
    };
  }

  /**
   * 注册上下文变化监听器
   * 返回取消订阅函数
   */
  onChange(listener: (ctx: EditorContext) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  /**
   * 清理所有监听器
   */
  dispose() {
    this.disposeCallbacks.forEach(cb => cb());
    this.disposeCallbacks = [];
    this.listeners = [];
  }

  private notifyListeners() {
    const ctx = this.getContext();
    if (ctx) {
      this.listeners.forEach(l => l(ctx));
    }
  }
}

// 全局单例
export const editorContext = new EditorContextTracker();
