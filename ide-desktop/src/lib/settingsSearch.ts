/**
 * Iteration 15 — settings search model.
 *
 * The settings nav search used to be a substring test on the Chinese label
 * only, so "theme" found nothing and "深色" missed 外观. This module gives
 * every nav entry a keyword set (both languages plus a few natural English
 * queries) and matches through the iteration-2 fuzzy ranker, returning the
 * surviving nav ids in best-match order.
 */

import { fuzzyRankItems, type WeightedItem } from './fuzzy';

export type SearchableNav = {
  id: string;
  label: string;
  keywords: string;
};

/**
 * The canonical keyword table. Kept beside the function (not inside
 * SettingsView) so it is unit-testable and the UI owns only rendering.
 */
export const SETTINGS_NAV_KEYWORDS: Record<string, string> = {
  general: '常规 通用 general approval 审批 工作区 workspace 最近',
  appearance: '外观 theme 主题 深色 浅色 dark light 字体 font 字号 大小 editor 编辑器 显示',
  model: '模型 model provider 提供商 api key 密钥 deepseek openai anthropic 供应商 自定义',
  usage: '用量 统计 usage 花费 cost token 缓存 cache 图表',
  personalize: '个性化 人格 personalize persona 提示词 prompt',
  shortcuts: '快捷键 键位 shortcut keyboard key 绑定',
  plugins: '插件 plugins 扩展 extension mcp',
  browser: '浏览器 browser 网页 web',
  computer: '电脑 操控 computer 鼠标 mouse excel 应用 app',
  hooks: '钩子 hooks 安全 security',
  connections: '连接 connections 网络 network 代理 proxy',
  git: 'git 分支 branch 提交 commit pr 合并 merge',
  environment: '环境 environment 终端 terminal shell 系统',
  worktrees: 'worktree 工作树 副本',
  archived: '归档 archive 已删除 历史聊天',
  search: '搜索 search 全文 检索',
  snippets: '片段 代码片段 snippets 模板',
  bookmarks: '书签 bookmarks 标记 行号',
  history: '历史 history 保存 快照 snapshot',
  stats: '统计 普查 stats census 语言 行数 todo',
  notes: '笔记 notes 备忘 记录',
};

/**
 * Rank nav entries against a query. Empty query returns entries untouched
 * (caller keeps its own grouping order). Non-empty query drops everything
 * below the match threshold and returns the surviving ids in score order.
 */
export function searchNavIds(query: string, entries: SearchableNav[]): string[] {
  if (!query.trim()) return entries.map((e) => e.id);
  const weighted: WeightedItem<string>[] = entries.map((entry) => ({
    item: entry.id,
    key: entry.label,
    keywords: SETTINGS_NAV_KEYWORDS[entry.id] ?? entry.keywords,
  }));
  const ranked = fuzzyRankItems(query, weighted);
  // fuzzyRankItems only returns actual matches (substring or subsequence), so
  // no extra score floor is needed — everything listed ranked above noise.
  return ranked.map((r) => r.item);
}
