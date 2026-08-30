import { editorContext, type EditorContext } from './editorContext';
import { completionService } from './codeCompletion';
import type { GhostTextRenderer } from './ghostText';

/**
 * 代码补全触发器
 * 混合模式：
 * - 自动触发：在注释后（//, #, /*, /** 等）
 * - 手动触发：按 Ctrl+Space
 */
export class CompletionTrigger {
  private ghostRenderer: GhostTextRenderer;
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastTriggerTime = 0;
  private isEnabled = true;
  private unsubscribe: (() => void) | null = null;

  constructor(ghostRenderer: GhostTextRenderer) {
    this.ghostRenderer = ghostRenderer;
  }

  /**
   * 启动触发器，开始监听编辑器变化
   */
  start() {
    if (this.unsubscribe) {
      this.unsubscribe();
    }

    this.unsubscribe = editorContext.onChange((ctx) => {
      this.onContextChange(ctx);
    });
  }

  /**
   * 停止触发器
   */
  stop() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.clearDebounce();
  }

  /**
   * 手动触发补全（Ctrl+Space）
   */
  async triggerManual() {
    const ctx = editorContext.getContext();
    if (ctx) {
      await this.triggerCompletion(ctx, 'manual');
    }
  }

  /**
   * 启用/禁用自动触发
   */
  setEnabled(enabled: boolean) {
    this.isEnabled = enabled;
    if (!enabled) {
      this.ghostRenderer.hide();
      this.clearDebounce();
    }
  }

  private onContextChange(ctx: EditorContext) {
    // 清除之前的 debounce
    this.clearDebounce();

    // 如果有建议正在显示，隐藏它
    if (this.ghostRenderer.hasSuggestion()) {
      this.ghostRenderer.hide();
    }

    // 如果禁用了自动触发，跳过
    if (!this.isEnabled) return;

    // 检查是否应该自动触发
    const shouldAutoTrigger = this.shouldAutoTrigger(ctx);

    if (shouldAutoTrigger) {
      // 注释后立即触发（短延迟），其他场景暂不自动触发
      const delay = this.isAfterComment(ctx) ? 300 : 0;

      if (delay > 0) {
        this.debounceTimer = setTimeout(() => {
          this.triggerCompletion(ctx, 'comment');
        }, delay);
      }
    }
  }

  private async triggerCompletion(ctx: EditorContext, kind: 'automatic' | 'manual' | 'comment') {
    // 防抖：距离上次触发至少 200ms
    const now = Date.now();
    if (now - this.lastTriggerTime < 200) return;
    this.lastTriggerTime = now;

    try {
      const result = await completionService.requestCompletion({ 
        context: ctx, 
        triggerKind: kind 
      });

      if (result && result.text && result.text.trim()) {
        this.ghostRenderer.show(result.text, {
          lineNumber: ctx.cursorLine,
          column: ctx.cursorColumn
        });
      }
    } catch (err) {
      console.error('[CompletionTrigger] Error:', err);
    }
  }

  private shouldAutoTrigger(ctx: EditorContext): boolean {
    // 有选区时不自动触发
    if (ctx.selection) return false;

    // 注释后自动触发
    if (this.isAfterComment(ctx)) return true;

    // 其他场景不自动触发（需要手动 Ctrl+Space）
    return false;
  }

  private isAfterComment(ctx: EditorContext): boolean {
    const lines = ctx.content.split('\n');
    const currentLine = lines[ctx.cursorLine - 1] || '';
    const beforeCursor = currentLine.slice(0, ctx.cursorColumn - 1).trim();

    // 检测常见注释符号
    if (beforeCursor.startsWith('//')) return true;
    if (beforeCursor.startsWith('#')) return true;
    if (beforeCursor.startsWith('/*')) return true;
    if (beforeCursor.match(/^\s*\/\*\*/)) return true; // JSDoc

    // 检测 Python docstring
    if (beforeCursor.startsWith('"""') || beforeCursor.startsWith("'''")) return true;

    // 检测 HTML/XML 注释
    if (beforeCursor.startsWith('<!--')) return true;

    return false;
  }

  private clearDebounce() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
