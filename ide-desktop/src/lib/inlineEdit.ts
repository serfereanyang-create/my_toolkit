import type * as Monaco from 'monaco-editor';
import { desktop } from './ipc';
import { editorContext } from './editorContext';

/**
 * 内联编辑 Widget
 * 按 Cmd+K 弹出输入框，用户输入指令，AI 编辑选中的代码
 */
export class InlineEditWidget {
  private editor: Monaco.editor.IStandaloneCodeEditor;
  private monaco: typeof Monaco;
  private domNode: HTMLDivElement | null = null;
  private inputElement: HTMLTextAreaElement | null = null;
  private originalSelection: string = '';
  private originalRange: Monaco.IRange | null = null;
  private isProcessing = false;

  constructor(editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) {
    this.editor = editor;
    this.monaco = monaco;
  }

  /**
   * 显示内联编辑输入框
   */
  show() {
    // 如果已经显示，不重复创建
    if (this.domNode) return;

    const selection = this.editor.getSelection();
    if (!selection || selection.isEmpty()) {
      // 没有选区，提示用户先选择代码
      this.showToast('请先选择要编辑的代码');
      return;
    }

    const model = this.editor.getModel();
    if (!model) return;

    // 保存原始选区
    this.originalRange = selection;
    this.originalSelection = model.getValueInRange(selection);

    // 创建 DOM 节点
    this.domNode = document.createElement('div');
    this.domNode.className = 'inline-edit-widget';

    // 输入框
    this.inputElement = document.createElement('textarea');
    this.inputElement.className = 'inline-edit-input';
    this.inputElement.placeholder = '告诉 AI 要做什么…（Ctrl+Enter 提交，Esc 取消）';
    this.inputElement.rows = 1;

    // 提交按钮
    const submitBtn = document.createElement('button');
    submitBtn.className = 'inline-edit-submit';
    submitBtn.title = '提交（Ctrl+Enter）';
    submitBtn.innerHTML = '✓';
    submitBtn.onclick = () => this.submit();

    // 取消按钮
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'inline-edit-cancel';
    cancelBtn.title = '取消（Esc）';
    cancelBtn.innerHTML = '✕';
    cancelBtn.onclick = () => this.hide();

    // 组装
    this.domNode.appendChild(this.inputElement);
    this.domNode.appendChild(submitBtn);
    this.domNode.appendChild(cancelBtn);

    // 定位到选区下方
    this.positionWidget(selection);

    // 添加到编辑器容器
    const editorDomNode = this.editor.getDomNode();
    if (editorDomNode) {
      editorDomNode.appendChild(this.domNode);
    }

    // 聚焦输入框
    this.inputElement.focus();

    // 监听键盘事件
    this.inputElement.addEventListener('keydown', this.handleKeyDown);

    // 监听输入自动调整高度
    this.inputElement.addEventListener('input', () => {
      if (this.inputElement) {
        this.inputElement.style.height = 'auto';
        this.inputElement.style.height = this.inputElement.scrollHeight + 'px';
      }
    });
  }

  /**
   * 隐藏并清理
   */
  hide() {
    if (this.domNode) {
      this.domNode.remove();
      this.domNode = null;
    }
    this.inputElement = null;
    this.originalSelection = '';
    this.originalRange = null;
    this.isProcessing = false;
    this.editor.focus();
  }

  /**
   * 提交编辑请求
   */
  private async submit() {
    if (!this.inputElement || !this.originalRange || this.isProcessing) return;

    const instruction = this.inputElement.value.trim();
    if (!instruction) {
      this.showToast('请输入编辑指令');
      return;
    }

    // 禁用输入
    this.isProcessing = true;
    this.inputElement.disabled = true;
    this.inputElement.placeholder = 'AI 正在思考…';

    try {
      const context = editorContext.getContext();
      const result = await desktop.ai.edit(this.originalSelection, instruction, context);

      if (result && result.trim()) {
        // 应用编辑
        this.editor.executeEdits('inline-edit', [{
          range: this.originalRange,
          text: result
        }]);

        // 选中编辑后的文本
        const lines = result.split('\n');
        const endLine = this.originalRange.startLineNumber + lines.length - 1;
        const endColumn = lines.length === 1 
          ? this.originalRange.startColumn + result.length
          : lines[lines.length - 1].length + 1;

        this.editor.setSelection(new this.monaco.Range(
          this.originalRange.startLineNumber,
          this.originalRange.startColumn,
          endLine,
          endColumn
        ));

        this.showToast('编辑成功');
      } else {
        this.showToast('AI 未返回编辑结果');
      }
    } catch (err: any) {
      console.error('[InlineEditWidget] Error:', err);
      this.showToast(`编辑失败: ${err.message || '未知错误'}`);
    } finally {
      this.hide();
    }
  }

  /**
   * 键盘事件处理
   */
  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.hide();
    }
  };

  /**
   * 定位 Widget 到选区下方
   */
  private positionWidget(selection: Monaco.Selection) {
    if (!this.domNode) return;

    const position = { 
      lineNumber: selection.endLineNumber, 
      column: selection.endColumn 
    };
    
    const coords = this.editor.getScrolledVisiblePosition(position);
    
    if (coords) {
      // 定位在选区下方
      this.domNode.style.position = 'absolute';
      this.domNode.style.top = `${coords.top + coords.height + 4}px`;
      this.domNode.style.left = `${coords.left}px`;
      this.domNode.style.zIndex = '1000';
    }
  }

  /**
   * 显示提示消息
   */
  private showToast(message: string) {
    // 简单的 toast 实现
    const toast = document.createElement('div');
    toast.className = 'inline-edit-toast';
    toast.textContent = message;
    
    const editorDomNode = this.editor.getDomNode();
    if (editorDomNode) {
      editorDomNode.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }
  }
}
