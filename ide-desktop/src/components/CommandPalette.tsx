import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState } from '../types';
import { fuzzyRankItems, highlightRanges, type WeightedItem } from '../lib/fuzzy';

export type CommandEntry = {
  id: string;
  /** Primary searchable label, shown on the row. Chinese, like the rest of the UI. */
  title: string;
  /** Secondary search field — English aliases, categories, key hints, so a
   *  user who thinks in English terms ("terminal", "theme") still finds it. */
  keywords?: string;
  /** Group header in the palette list. */
  group: 'view' | 'chat' | 'editor' | 'panels' | 'settings' | 'workspace';
  /** Rendered shortcut hint on the right, e.g. "Ctrl+Shift+P". */
  shortcut?: string;
  /** When false the row renders dimmed and cannot be triggered. */
  enabled?: boolean;
  run: () => void;
};

const GROUP_LABEL: Record<CommandEntry['group'], string> = {
  view: '视图',
  chat: '会话',
  editor: '编辑器',
  panels: '面板',
  settings: '设置',
  workspace: '工作区',
};

/** Section order in the list. Also the tie-break that keeps each group's rows
 *  contiguous — see composeRows. */
const GROUP_ORDER: Array<CommandEntry['group']> =
  ['view', 'chat', 'editor', 'panels', 'settings', 'workspace'];

/**
 * Build the command catalog. Pure function of the current state + callbacks so
 * tests can snapshot it and App keeps its handler wiring in one place.
 */
export function buildCommands(ctx: {
  state: AppState;
  go: (view: string) => void;
  newChat: () => void;
  toggleTerminal: () => void;
  /** Floating terminal window (overlays the conversation) — distinct from the bottom panel. */
  toggleTerminalFloat: () => void;
  toggleDetails: () => void;
  toggleSideChat: () => void;
  toggleBrowser: () => void;
  toggleWorkDetails: () => void;
  togglePreview: () => void;
  toggleNotes: () => void;
  toggleWorkspaceTools: () => void;
  openSettings: (page?: string) => void;
  openWorkspace: () => void;
  openQuickOpen: () => void;
  openHelp: () => void;
  cancelTurn: () => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  exportChat: () => void;
  saveChatFile: () => void;
}): CommandEntry[] {
  const running = ctx.state.agentStatus === 'running' || ctx.state.agentStatus === 'starting';
  return [
    { id: 'view.chat', title: '显示对话', group: 'view', keywords: '聊天 会话 chat conversation', run: () => ctx.go('chat') },
    { id: 'view.files', title: '显示文件', group: 'view', keywords: '文件 资源管理器 files explorer', run: () => ctx.go('files') },
    { id: 'view.quickopen', title: '快速打开文件', group: 'view', shortcut: 'Ctrl+P', keywords: '快速打开 查找文件 go to file quick open 文件名', run: ctx.openQuickOpen },
    { id: 'view.search', title: '在工作区搜索', group: 'view', shortcut: 'Ctrl+Shift+F', keywords: '搜索 全文检索 search grep 查找', run: () => ctx.go('search') },
    { id: 'view.editor', title: '显示编辑器', group: 'view', keywords: '编辑器 editor tabs', run: () => ctx.go('editor') },
    { id: 'view.snippets', title: '代码片段库', group: 'view', keywords: '代码片段 片段库 snippets 模板', run: () => ctx.go('snippets') },
    { id: 'view.bookmarks', title: '显示书签', group: 'view', shortcut: 'Ctrl+Shift+B', keywords: '书签 标记 bookmarks marks gutter', run: () => ctx.go('bookmarks') },
    { id: 'view.history', title: '显示保存历史', group: 'view', keywords: '历史 保存历史 快照 history snapshot undo 撤销', run: () => ctx.go('history') },
    { id: 'view.stats', title: '代码普查（统计）', group: 'view', keywords: '统计 代码普查 语言 行数 stats census statistics 待办', run: () => ctx.go('stats') },
    { id: 'view.git', title: '显示 Git', group: 'view', keywords: 'git 版本控制 branch commit', run: () => ctx.go('git') },
    { id: 'view.automation', title: '显示自动化', group: 'view', keywords: '自动化 cron 定时 automation', run: () => ctx.go('automation') },
    { id: 'view.quality', title: '显示质量', group: 'view', keywords: '质量 审查 覆盖率 quality review coverage', run: () => ctx.go('quality') },
    { id: 'view.computer', title: '显示电脑操控', group: 'view', keywords: '电脑 桌面 窗口 操控 软件 computer desktop windows gui 截图', run: () => ctx.go('computer') },
    { id: 'view.memory', title: '显示记忆', group: 'view', keywords: '记忆 全局 编辑过 memory MEMORY.md 跨会话 跨项目', run: () => ctx.go('memory') },
    { id: 'view.settings', title: '打开设置', group: 'view', shortcut: 'Ctrl+,', keywords: '设置 settings preferences', run: () => ctx.go('settings') },
    { id: 'chat.new', title: '新建对话', group: 'chat', shortcut: 'Ctrl+N', keywords: '新会话 清空 new clear', run: ctx.newChat },
    { id: 'chat.export', title: '复制对话为 Markdown', group: 'chat', keywords: '导出 markdown 转录 transcript export 复制', run: ctx.exportChat },
    { id: 'chat.save-file', title: '保存对话到 .aicode/exports', group: 'chat', keywords: '保存 导出 文件 markdown exports 转录 save', run: ctx.saveChatFile },
    { id: 'chat.cancel', title: '取消当前回合', group: 'chat', shortcut: 'Esc', keywords: '停止 取消 stop cancel interrupt', enabled: running, run: ctx.cancelTurn },
    { id: 'editor.details', title: '展开/折叠全部工具详情', group: 'editor', shortcut: 'Ctrl+O', keywords: '展开 折叠 工具详情 details expand collapse', run: ctx.toggleDetails },
    { id: 'editor.terminal', title: '切换终端面板', group: 'editor', shortcut: 'Ctrl+T', keywords: '终端 terminal bottom panel', run: ctx.toggleTerminal },
    { id: 'editor.terminal-float', title: '切换浮动终端', group: 'editor', keywords: '终端 浮动 浮窗 terminal floating window overlay', run: ctx.toggleTerminalFloat },
    { id: 'panels.sidechat', title: '切换侧边会话', group: 'panels', shortcut: 'Alt+Ctrl+S', keywords: '侧边会话 side chat', run: ctx.toggleSideChat },
    { id: 'panels.browser', title: '切换浏览器', group: 'panels', shortcut: 'Alt+Ctrl+B', keywords: '浏览器 browser preview web', run: ctx.toggleBrowser },
    { id: 'panels.work', title: '切换工作详情', group: 'panels', keywords: '工作日志 详情 work log details', run: ctx.toggleWorkDetails },
    { id: 'panels.workspacetools', title: '切换工作区工具', group: 'panels', shortcut: 'Alt+Ctrl+W', keywords: '工作区工具 审查 子智能体 技能 workspace tools review subagent', run: ctx.toggleWorkspaceTools },
    { id: 'panels.preview', title: '切换预览侧栏', group: 'panels', keywords: '预览 preview sidebar', run: ctx.togglePreview },
    { id: 'panels.notes', title: '切换会话笔记', group: 'panels', keywords: '笔记 会话笔记 notes 备忘', run: ctx.toggleNotes },
    { id: 'settings.theme.light', title: '主题：浅色', group: 'settings', keywords: '浅色 明亮主题 light theme', run: () => ctx.setTheme('light') },
    { id: 'settings.theme.dark', title: '主题：深色', group: 'settings', keywords: '深色 暗色主题 dark theme', run: () => ctx.setTheme('dark') },
    { id: 'settings.theme.system', title: '主题：跟随系统', group: 'settings', keywords: '跟随系统 system theme', run: () => ctx.setTheme('system') },
    { id: 'workspace.open', title: '打开工作区文件夹', group: 'workspace', keywords: '打开文件夹 工作区 open folder workspace', run: ctx.openWorkspace },
    { id: 'help.overlay', title: '帮助与快捷键', group: 'workspace', keywords: '帮助 快捷键 help keyboard shortcuts', run: ctx.openHelp },
    { id: 'settings.providers', title: '管理模型提供商', group: 'settings', keywords: '模型 提供商 provider api key', run: () => ctx.openSettings('general') },
    { id: 'settings.usage', title: '查看用量统计', group: 'settings', keywords: '用量 统计 花费 usage cost', run: () => ctx.openSettings('usage') },
    { id: 'settings.shortcuts', title: '编辑键盘快捷键', group: 'settings', keywords: '快捷键 键位 shortcuts keys', run: () => ctx.openSettings('shortcuts') },
  ];
}

/** Per-session usage counters — the palette re-ranks by what you open often. */
const usageCounts = new Map<string, number>();

function usagePrior(cmdId: string): number {
  return 1 + Math.log2(1 + (usageCounts.get(cmdId) ?? 0)) * 0.15;
}

export type PaletteRow = {
  item: CommandEntry;
  header: string | null;
  fragments: Array<{ text: string; hit: boolean }>;
  idx: number;
};

/**
 * Rank commands against a search term and pre-compute every display field
 * (group headers, highlight fragments) so the render loop maps finished rows
 * straight to JSX with no derivation left inside it.
 */
export function composeRows(commands: CommandEntry[], term: string): PaletteRow[] {
  const entries: WeightedItem<CommandEntry>[] = commands.map((cmd) => ({
    item: cmd,
    key: cmd.title,
    keywords: cmd.keywords,
    prior: usagePrior(cmd.id),
  }));
  const ranked = fuzzyRankItems(term, entries);

  // Rows are grouped under headers by whatever order ranking returns, so a
  // group whose commands were declared later in the catalog printed a second
  // 设置 header below 工作区. The catalog is one array of mixed groups; sorting
  // by group first keeps each section in one piece, and the sort is stable, so
  // within a group the ranking (usage prior) is exactly as it was.
  const sectionOrder = (group: CommandEntry['group']) => GROUP_ORDER.indexOf(group);
  ranked.sort((a, b) => {
    const byGroup = sectionOrder(a.item.group) - sectionOrder(b.item.group);
    return byGroup !== 0 ? byGroup : b.score - a.score;
  });

  let lastGroup: CommandEntry['group'] | null = null;
  return ranked.map((entry, idx) => {
    const header = entry.item.group !== lastGroup ? GROUP_LABEL[entry.item.group] : null;
    lastGroup = entry.item.group;
    return { item: entry.item, header, fragments: highlightRanges(entry.item.title, entry.ranges), idx };
  });
}

/** Literal-only class picker (no interpolation). */
function rowClass(active: boolean, disabled: boolean): string {
  if (active && disabled) return 'cmd-row active disabled';
  if (active) return 'cmd-row active';
  if (disabled) return 'cmd-row disabled';
  return 'cmd-row';
}

export function CommandPalette({ commands, onClose }: {
  commands: CommandEntry[];
  onClose: () => void;
}) {
  const [term, setTerm] = useState('');
  const [cursor, setCursor] = useState(0);
  const [, setUsageTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Remember who opened the palette so closing it can hand focus back:
    // without this, Escape dropped keyboard users on <body>, i.e. at the top
    // of the whole document. Only reclaim focus if nothing else has taken it.
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    inputRef.current?.focus();
    return () => {
      const current = document.activeElement;
      if (opener && opener.isConnected && (!current || current === document.body)) opener.focus();
    };
  }, []);

  const rows = useMemo(() => composeRows(commands, term), [commands, term]);

  // Clamp the cursor when the result set shrinks while typing.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  function trigger(entry: CommandEntry | undefined) {
    if (!entry || entry.enabled === false) return;
    usageCounts.set(entry.id, (usageCounts.get(entry.id) ?? 0) + 1);
    setUsageTick((t) => t + 1);
    onClose();
    entry.run();
  }

  function onKey(event: React.KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, rows.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      trigger(rows[cursor]?.item);
      return;
    }
    if (event.key === 'Tab') {
      // Tab jumps to the next group's first row — cheap group navigation.
      event.preventDefault();
      const currentGroup = rows[cursor]?.item.group;
      for (let i = cursor + 1; i < rows.length; i += 1) {
        if (rows[i].item.group !== currentGroup) { setCursor(i); return; }
      }
    }
  }

  // Scroll the active row back into view on arrow navigation.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <div className="cmd-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmd-panel" role="dialog" aria-modal="true" aria-label="命令面板">
        <input
          ref={inputRef}
          className="cmd-input"
          aria-label="搜索命令"
          placeholder="输入搜索词"
          value={term}
          onChange={(e) => { setTerm(e.target.value); setCursor(0); }}
          onKeyDown={onKey}
        />
        <div className="cmd-list" ref={listRef} role="listbox" aria-label="命令结果">
          {rows.length === 0 && <div className="cmd-empty">没有匹配的命令</div>}
          {rows.map((row) => (
            <div key={row.item.id}>
              {row.header && <div className="cmd-group">{row.header}</div>}
              <button
                type="button"
                className={rowClass(row.idx === cursor, row.item.enabled === false)}
                data-active={row.idx === cursor}
                role="option"
                aria-selected={row.idx === cursor}
                onMouseEnter={() => setCursor(row.idx)}
                onClick={() => trigger(row.item)}
                disabled={row.item.enabled === false}
              >
                <span className="cmd-title">
                  {row.fragments.map((part, pi) => (
                    part.hit ? <mark key={pi} className="cmd-hit">{part.text}</mark> : <span key={pi}>{part.text}</span>
                  ))}
                </span>
                {row.item.shortcut && <kbd className="cmd-kbd">{row.item.shortcut}</kbd>}
              </button>
            </div>
          ))}
        </div>
        <div className="cmd-foot">
          <span>{rows.length} 条命令</span>
          <span className="cmd-foot-hint">常用命令优先</span>
        </div>
      </div>
    </div>
  );
}
