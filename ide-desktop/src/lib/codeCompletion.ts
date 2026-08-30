import { desktop } from './ipc';
import type { EditorContext, Position } from './editorContext';

export type CompletionRequest = {
  context: EditorContext;
  triggerKind: 'automatic' | 'manual' | 'comment';
};

export type CompletionResult = {
  id: string;
  text: string;
  range: { start: Position; end: Position };
  confidence: number; // 0-1
};

/**
 * 代码补全服务
 * 负责请求 AI 代码补全、缓存结果、管理请求生命周期
 */
export class CodeCompletionService {
  private abortController: AbortController | null = null;
  private cache = new Map<string, CompletionResult>();
  private readonly CACHE_SIZE = 100;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 分钟

  /**
   * 请求代码补全
   */
  async requestCompletion(req: CompletionRequest): Promise<CompletionResult | null> {
    // 取消之前的请求
    if (this.abortController) {
      this.abortController.abort();
    }

    this.abortController = new AbortController();

    // 检查缓存
    const cacheKey = this.getCacheKey(req.context);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      // 调用后端 IPC
      const result = await desktop.ai.complete({
        filePath: req.context.filePath,
        language: req.context.language,
        prefix: this.getPrefix(req.context),
        suffix: this.getSuffix(req.context),
        cursorLine: req.context.cursorLine,
        cursorColumn: req.context.cursorColumn,
        triggerKind: req.triggerKind
      });

      if (result) {
        this.addToCache(cacheKey, result);
        return result;
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return null;
      console.error('Completion error:', err);
    }

    return null;
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this.cache.clear();
  }

  private getCacheKey(ctx: EditorContext): string {
    // 缓存键：文件路径 + 光标位置 + 最近 100 字符内容
    return `${ctx.filePath}:${ctx.cursorLine}:${ctx.cursorColumn}:${this.hashString(ctx.content.slice(-100))}`;
  }

  private addToCache(key: string, result: CompletionResult) {
    // LRU 缓存：超过大小限制时删除最旧的
    if (this.cache.size >= this.CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, result);

    // 设置 TTL 过期
    setTimeout(() => {
      this.cache.delete(key);
    }, this.CACHE_TTL);
  }

  private getPrefix(ctx: EditorContext): string {
    const lines = ctx.content.split('\n');
    const beforeCursor = lines.slice(0, ctx.cursorLine - 1)
      .concat(lines[ctx.cursorLine - 1]?.slice(0, ctx.cursorColumn - 1) ?? '');
    
    // 只取最后 2000 字符（节省 token）
    const prefix = beforeCursor.join('\n');
    return prefix.slice(-2000);
  }

  private getSuffix(ctx: EditorContext): string {
    const lines = ctx.content.split('\n');
    const afterCursor = [lines[ctx.cursorLine - 1]?.slice(ctx.cursorColumn - 1) ?? '']
      .concat(lines.slice(ctx.cursorLine));
    
    // 只取后面 500 字符
    const suffix = afterCursor.join('\n');
    return suffix.slice(0, 500);
  }

  private hashString(str: string): string {
    // 简单的字符串哈希（用于缓存键）
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }
}

// 全局单例
export const completionService = new CodeCompletionService();
