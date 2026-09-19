/**
 * sessionTitle.ts — 会话标题启发式生成（纯函数，无模型）。
 *
 * 策略优先级：
 *  1. 首条用户消息清洗后截断（去 markdown/命令前缀/多余空白）
 *  2. 首条过短（如"继续"）→ 取首条助手回复的标题行/首句
 *  3. 都缺失 → 基于工具活动的摘要标题
 * 同时提供活动摘要（top 工具/失败数），供标题与列表副标题。
 */

export interface TitleSource {
  firstUser?: string;
  firstAssistant?: string;
  toolNames?: string[];
}

export interface TitleSuggestion {
  title: string;
  strategy: 'first-user' | 'assistant-heading' | 'activity' | 'fallback';
  confidence: number; // 0-1
}

const MAX_TITLE = 42;

/** 清洗：去命令前缀、markdown 记号、压缩空白。 */
export function cleanForTitle(text: string): string {
  let out = text.trim();
  if (out.startsWith('/')) {
    const space = out.indexOf(' ');
    out = space > 0 ? out.slice(space + 1) : out.slice(1);
  }
  out = out
    .replace(/^#+\s*/, '')
    .replace(/[*_`>~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return out;
}

/** 截断到标题长度，按词/句边界优雅收尾。 */
export function truncateTitle(text: string): string {
  if (text.length <= MAX_TITLE) return text;
  const cut = text.slice(0, MAX_TITLE);
  const lastSpace = cut.lastIndexOf(' ');
  const lastPunct = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('、'));
  const boundary = Math.max(lastSpace, lastPunct);
  if (boundary > MAX_TITLE * 0.5) return cut.slice(0, boundary).trim();
  return cut.trim() + '…';
}

/** 从助手回复提取标题行：优先 markdown 标题，其次首句。 */
export function titleFromAssistant(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading?.[1]) return truncateTitle(cleanForTitle(heading[1]));
  }
  const first = lines[0];
  if (!first) return null;
  const sentence = first.split(/[。.!？?；;]/)[0] ?? '';
  if (sentence.trim().length < 6) return null;
  return truncateTitle(cleanForTitle(sentence));
}

/** 工具活动摘要（副标题用）。 */
export function summarizeActivity(toolNames: string[]): string {
  if (toolNames.length === 0) return '';
  const counts = new Map<string, number>();
  for (const name of toolNames) counts.set(name, (counts.get(name) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const parts = top.map(([name, n]) => `${name}×${n}`);
  return `${counts.size} 种工具 · ${toolNames.length} 次调用（${parts.join('、')}）`;
}

/** 生成标题建议。 */
export function suggestTitle(source: TitleSource): TitleSuggestion {
  const userClean = source.firstUser ? cleanForTitle(source.firstUser) : '';
  if (userClean.length >= 6) {
    return { title: truncateTitle(userClean), strategy: 'first-user', confidence: userClean.length >= 12 ? 0.9 : 0.7 };
  }
  if (source.firstAssistant) {
    const fromAssistant = titleFromAssistant(source.firstAssistant);
    if (fromAssistant) return { title: fromAssistant, strategy: 'assistant-heading', confidence: 0.6 };
  }
  if (source.toolNames && source.toolNames.length > 0) {
    const activity = summarizeActivity(source.toolNames);
    if (activity) return { title: truncateTitle(activity), strategy: 'activity', confidence: 0.4 };
  }
  return { title: '未命名会话', strategy: 'fallback', confidence: 0.2 };
}
