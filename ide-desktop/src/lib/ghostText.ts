import type * as Monaco from 'monaco-editor';

/**
 * 幽灵文本渲染器
 * 使用 Monaco decorations 在编辑器中显示 AI 建议的代码补全
 * 用户可以按 Tab 接受或 Esc 取消
 */
export class GhostTextRenderer {
  private editor: Monaco.editor.IStandaloneCodeEditor;
  private monaco: typeof Monaco;
  private decorations: string[] = [];
  private currentSuggestion: string | null = null;
  private currentPosition: Monaco.IPosition | null = null;

  constructor(editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) {
    this.editor = editor;
    this.monaco = monaco;
  }

  /**
   * 显示幽灵文本建议
   */
  show(text: string, position: Monaco.IPosition) {
    this.currentSuggestion = text;
    this.currentPosition = position;

    // 将建议文本分割成多行
    const lines = text.split('\n');
    const decorations: Monaco.editor.IModelDeltaDecoration[] = [];

    lines.forEach((line, index) => {
      const targetLine = position.lineNumber + index;
      
      if (index === 0) {
        // 第一行：在光标位置后显示
        decorations.push({
          range: new this.monaco.Range(
            targetLine,
            position.column,
            targetLine,
            position.column
          ),
          options: {
            after: {
              content: line,
              inlineClassName: 'ghost-text-inline',
              cursorStops: this.monaco.editor.InjectedTextCursorStops.None
            }
          }
        });
      } else {
        // 后续行：作为新行显示
        decorations.push({
          range: new this.monaco.Range(
            targetLine,
            1,
            targetLine,
            1
          ),
          options: {
            before: {
              content: line,
              inlineClassName: 'ghost-text-line',
              cursorStops: this.monaco.editor.InjectedTextCursorStops.None
            },
            isWholeLine: false
          }
        });
      }
    });

    // 应用装饰
    this.decorations = this.editor.deltaDecorations(this.decorations, decorations);
  }

  /**
   * 隐藏幽灵文本
   */
  hide() {
    if (this.decorations.length > 0) {
      this.editor.deltaDecorations(this.decorations, []);
      this.decorations = [];
    }
    this.currentSuggestion = null;
    this.currentPosition = null;
  }

  /**
   * 接受建议并插入到编辑器
   */
  accept() {
    if (!this.currentSuggestion || !this.currentPosition) return;

    const model = this.editor.getModel();
    if (!model) return;

    // 插入建议文本
    this.editor.executeEdits('ghost-text-accept', [{
      range: new this.monaco.Range(
        this.currentPosition.lineNumber,
        this.currentPosition.column,
        this.currentPosition.lineNumber,
        this.currentPosition.column
      ),
      text: this.currentSuggestion
    }]);

    // 移动光标到插入文本的末尾
    const lines = this.currentSuggestion.split('\n');
    const lastLine = lines[lines.length - 1];
    const newPosition = {
      lineNumber: this.currentPosition.lineNumber + lines.length - 1,
      column: lines.length === 1 
        ? this.currentPosition.column + lastLine.length
        : lastLine.length + 1
    };
    this.editor.setPosition(newPosition);

    // 清理
    this.hide();
  }

  /**
   * 获取当前建议
   */
  getSuggestion(): string | null {
    return this.currentSuggestion;
  }

  /**
   * 是否有活跃的建议
   */
  hasSuggestion(): boolean {
    return this.currentSuggestion !== null;
  }
}
