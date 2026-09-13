/**
 * Renderer plugin catalog (iteration 20). The main process owns the truth
 * (electron/plugin-registry.cjs); this module layers presentation (icons,
 * tints) on top and exposes the helpers both PluginsSettings and PluginMenu
 * consume, so the two views can never disagree about which plugins exist.
 */
import {
  FileText, FileType2, Sheet, Presentation, LayoutTemplate, Globe, Monitor,
  Sparkles, Braces, BookmarkCheck, History, BarChart3, StickyNote, MessagesSquare,
  CalendarClock, GitBranch, Gauge, TerminalSquare,
} from 'lucide-react';
import type { ReactNode } from 'react';

export type PluginCategory = 'artifacts' | 'tools' | 'workflow' | 'insight';

export type PluginMeta = { icon: ReactNode; tint: string };

/** Presentation per plugin id. Anything missing from the main catalog simply
 *  won't render; anything extra in the main catalog falls back to a generic
 *  icon so new backend plugins appear without a renderer change. */
const PRESENTATION: Record<string, PluginMeta> = {
  documents: { icon: <FileText size={18} />, tint: '#4b83f0' },
  pdf: { icon: <FileType2 size={18} />, tint: '#e05a4a' },
  spreadsheets: { icon: <Sheet size={18} />, tint: '#3aa675' },
  presentations: { icon: <Presentation size={18} />, tint: '#e8a13a' },
  template: { icon: <LayoutTemplate size={18} />, tint: '#9b8cf0' },
  browser: { icon: <Globe size={18} />, tint: '#4b9ff0' },
  computer: { icon: <Monitor size={18} />, tint: '#4bb0e0' },
  visualize: { icon: <Sparkles size={18} />, tint: '#4b83f0' },
  snippets: { icon: <Braces size={18} />, tint: '#3aa675' },
  bookmarks: { icon: <BookmarkCheck size={18} />, tint: '#e8a13a' },
  history: { icon: <History size={18} />, tint: '#5b5fc7' },
  census: { icon: <BarChart3 size={18} />, tint: '#2b7a9e' },
  notes: { icon: <StickyNote size={18} />, tint: '#c2622a' },
  'session-search': { icon: <MessagesSquare size={18} />, tint: '#a044c4' },
  automation: { icon: <CalendarClock size={18} />, tint: '#4b83f0' },
  git: { icon: <GitBranch size={18} />, tint: '#c0453c' },
  quality: { icon: <Gauge size={18} />, tint: '#1a9e6e' },
  terminal: { icon: <TerminalSquare size={18} />, tint: '#555a66' },
};

const GENERIC: PluginMeta = { icon: <Sparkles size={18} />, tint: '#8a8f9c' };

export function pluginMeta(id: string): PluginMeta {
  return PRESENTATION[id] ?? GENERIC;
}

/** Shape as delivered by desktop.plugins.catalog(). */
export type PluginDef = {
  id: string;
  name: string;
  desc: string;
  category: PluginCategory;
  requires: 'none' | 'workspace' | 'git' | 'platform';
  platforms: string[] | null;
  route: string | null;
};

/** Shape as delivered by desktop.plugins.status(). */
export type PluginStatusEntry = { id: string; available: boolean; reason: string | null };
export type PluginStatus = {
  plugins: PluginStatusEntry[];
  workspaceRoot: string | null;
  hasGit: boolean;
  platform: string;
};

export const CATEGORY_LABEL: Record<PluginCategory, string> = {
  artifacts: '文档工件',
  tools: '工具',
  workflow: '工作流',
  insight: '代码洞察',
};

/** Plugins enabled by default on first run (mirrors the old hardcoded list). */
export const DEFAULT_ENABLED_IDS: string[] = [
  'documents', 'pdf', 'spreadsheets', 'browser', 'visualize', 'snippets', 'notes', 'terminal',
];

/** Stable ordering for grouped rendering. */
export function groupByCategory(defs: PluginDef[]): Array<{ category: PluginCategory; plugins: PluginDef[] }> {
  const order: PluginCategory[] = ['artifacts', 'workflow', 'insight', 'tools'];
  return order
    .map((category) => ({ category, plugins: defs.filter((d) => d.category === category) }))
    .filter((g) => g.plugins.length > 0);
}

/** Filter defs by free-text query over name + desc + id. */
export function filterPlugins(defs: PluginDef[], query: string): PluginDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return defs;
  return defs.filter((d) => `${d.name} ${d.desc} ${d.id}`.toLowerCase().includes(q));
}

/** Status lookup keyed by id; missing entries count as available. */
export function statusMap(status: PluginStatus | null): Map<string, PluginStatusEntry> {
  const map = new Map<string, PluginStatusEntry>();
  for (const entry of status?.plugins ?? []) map.set(entry.id, entry);
  return map;
}
