import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

export type SlashCommand = {
  command: string;
  description: string;
  category: 'ai' | 'dialogue' | 'project' | 'analysis' | 'model' | 'search' | 'quicktools' | 'session' | 'git' | 'tools' | 'advanced';
  badge?: string;
};

const SLASH_COMMANDS: SlashCommand[] = [
  // ── AI 操作 ────────────────────────────────────────────────────────────────
  { command: '/explain', description: '解释当前文件代码的逻辑、复杂度和问题',       category: 'ai', badge: 'AI' },
  { command: '/fix',     description: '修复当前文件中的 bug，只返回修改后代码',     category: 'ai', badge: 'AI' },
  { command: '/test',    description: '为当前文件生成单元测试',                    category: 'ai', badge: 'AI' },
  { command: '/comment', description: '为当前文件添加文档注释',                    category: 'ai', badge: 'AI' },
  { command: '/edit',    description: '按指令改写当前代码（/edit <指令>）',         category: 'ai', badge: 'AI' },

  // ── 对话管理 ───────────────────────────────────────────────────────────────
  { command: '/compact',  description: '压缩上下文，保留最近 N 条消息 + 摘要',      category: 'dialogue' },
  { command: '/clear',    description: '清空当前会话历史，开始全新对话',            category: 'dialogue' },
  { command: '/retry',    description: '重发上一条用户消息',                        category: 'dialogue' },
  { command: '/history',  description: '显示最近 N 条对话记录（默认 10）',          category: 'dialogue' },
  { command: '/tokens',   description: '显示上下文字符数及预估词元用量',         category: 'dialogue' },

  // ── 项目设置 ───────────────────────────────────────────────────────────────
  { command: '/init',   description: '创建或更新工作区 AGENTS.md 指令文件',         category: 'project' },
  { command: '/goal',   description: '设置或显示当前会话目标（/goal clear 清除）', category: 'project' },
  { command: '/doctor', description: '检查工作区环境健康（node/git/package.json）', category: 'project' },
  { command: '/env',    description: '显示工作区相关环境变量（自动脱敏）',          category: 'project' },

  // ── 代码分析 ───────────────────────────────────────────────────────────────
  { command: '/review',     description: '对指定文件或目录发起代码审查', category: 'analysis', badge: 'AI' },
  { command: '/security',   description: '对工作区执行安全审查',         category: 'analysis', badge: 'AI' },
  { command: '/lint',       description: '运行 eslint / tsc 并显示结果', category: 'analysis' },
  { command: '/diff',       description: '显示当前工作区 git diff',      category: 'analysis' },
  { command: '/complexity', description: '分析文件复杂度与代码行/函数数', category: 'analysis' },
  { command: '/deps',       description: '显示 package.json 依赖摘要',   category: 'analysis' },

  // ── 模型控制 ───────────────────────────────────────────────────────────────
  { command: '/models',           description: '显示当前激活的 Provider 和模型',           category: 'model' },
  { command: '/thinking off',     description: '关闭推理（off）',                          category: 'model' },
  { command: '/thinking medium',  description: '中等推理强度（medium）',                   category: 'model' },
  { command: '/thinking max',     description: '最强推理强度（max）',                      category: 'model' },
  { command: '/scope auto',       description: '自动工具范围（auto）',                     category: 'model' },
  { command: '/scope full',       description: '全工具范围（full）',                       category: 'model' },

  // ── 搜索 ───────────────────────────────────────────────────────────────────
  { command: '/find', description: '按文件名 pattern 搜索工作区文件',     category: 'search' },
  { command: '/grep', description: '在源码中 grep 文本（使用 git grep）', category: 'search' },

  // ── 快捷工具 ───────────────────────────────────────────────────────────────
  { command: '/run',  description: '在工作区执行 shell 命令并显示输出', category: 'quicktools' },
  { command: '/ls',   description: '列出工作区目录内容',                category: 'quicktools' },
  { command: '/read', description: '读取并显示文件内容（前 100 行）',   category: 'quicktools' },

  // ── 会话管理 ───────────────────────────────────────────────────────────────
  { command: '/rename',   description: '重命名当前会话',           category: 'session' },
  { command: '/pin',      description: '固定 / 取消固定当前会话',  category: 'session' },
  { command: '/share',    description: '显示会话导出路径（JSON）', category: 'session' },
  { command: '/load',     description: '按 ID 切换到指定会话',    category: 'session' },
  { command: '/sessions', description: '列出最近的会话',           category: 'session' },
  { command: '/summary',  description: '生成当前会话摘要',         category: 'session' },
  { command: '/export',   description: '显示会话记录文件路径',     category: 'session' },
  { command: '/undo',     description: '撤销最后一次检查点的文件更改', category: 'session' },
  { command: '/config',   description: '显示当前脱敏配置信息',     category: 'session' },

  // ── 常用 ───────────────────────────────────────────────────────────────────
  { command: '/help',        description: '显示帮助信息与快捷键列表',    category: 'tools' },
  { command: '/status',      description: '显示会话、工作区、Agent 状态', category: 'tools' },
  { command: '/cache',       description: '查看提示词缓存命中率',         category: 'tools' },
  { command: '/attach',      description: '附加文件或图片到下一条消息',   category: 'tools' },
  { command: '/paste-image', description: '从剪贴板粘贴截图到对话',      category: 'tools' },
  { command: '/paste',       description: '多行粘贴模式（以 . 结束）',   category: 'tools' },
  { command: '/attachments', description: '列出已暂存的附件',            category: 'tools' },
  { command: '/tools',       description: '列出可用工具及风险级别',       category: 'tools' },
  { command: '/mcp status',  description: '查看 MCP 服务器连接状态',     category: 'tools' },
  { command: '/mcp reload',  description: '重新加载 MCP 服务器配置',     category: 'tools' },
  { command: '/model',       description: '显示当前激活的模型',           category: 'tools' },
  { command: '/provider',    description: '显示当前激活的 Provider',      category: 'tools' },

  // ── Git ────────────────────────────────────────────────────────────────────
  { command: '/git status',    description: '查看 Git 工作区状态',       category: 'git' },
  { command: '/git commit',    description: '提交任务板关联的更改',       category: 'git' },
  { command: '/git publish',   description: '推送并创建 PR',             category: 'git' },
  { command: '/rollback list', description: '列出可回滚的 Git 安全单元', category: 'git' },

  // ── 高级 ───────────────────────────────────────────────────────────────────
  { command: '/plan',            description: '显示/管理任务板（确认/暂停/继续）', category: 'advanced' },
  { command: '/computer use',    description: '唤醒电脑操控：截图看屏、点击、输入、滚动（本会话有效）', category: 'advanced', badge: 'GUI' },
  { command: '/computer off',    description: '关闭本会话的电脑操控',               category: 'advanced' },
  { command: '/memory list',     description: '列出项目记忆条目',                 category: 'advanced' },
  { command: '/memory add',      description: '添加一条项目记忆',                 category: 'advanced' },
  { command: '/automate list',   description: '列出自动化任务',                   category: 'advanced' },
  { command: '/automate create', description: '创建新的自动化任务',               category: 'advanced' },
  { command: '/subagents',       description: '列出当前会话的子智能体执行记录',   category: 'advanced' },
];

const CATEGORY_LABELS: Record<string, string> = {
  ai:         'AI 操作',
  dialogue:   '对话管理',
  project:    '项目设置',
  analysis:   '代码分析',
  model:      '模型控制',
  search:     '搜索',
  quicktools: '快捷工具',
  session:    '会话管理',
  git:        'Git',
  tools:      '常用工具',
  advanced:   '高级',
};

const CATEGORIES = ['ai', 'dialogue', 'project', 'analysis', 'model', 'search', 'quicktools', 'session', 'git', 'tools', 'advanced'] as const;

/** The list the menu actually shows, in the order it shows it.
 *
 *  Selection used to index SLASH_COMMANDS directly while the sections were
 *  rendered in CATEGORIES order. The declaration order differs (all of 高级
 *  comes last in the source but 高级's categories interleave elsewhere), so
 *  the highlight and Enter disagreed: the 40th visible row read /git status
 *  while Enter inserted /tools. One array now backs both. */
const ORDERED_COMMANDS: SlashCommand[] = CATEGORIES.flatMap((category) =>
  SLASH_COMMANDS.filter((cmd) => cmd.category === category));

export function SlashCommandMenu({ onPick, onClose, initialQuery = '' }: {
  onPick: (command: string) => void;
  onClose: () => void;
  initialQuery?: string;
}) {
  const [search, setSearch] = useState(initialQuery);
  const [activeIndex, setActiveIndex] = useState(0);
  const [size, setSize] = useState({ w: 680, h: 520 });
  const listRef   = useRef<HTMLDivElement>(null);
  const panelRef  = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ edge: string; startX: number; startY: number; startW: number; startH: number } | null>(null);
  const lower = search.toLowerCase();

  const visibleItems = lower
    ? ORDERED_COMMANDS.filter(
        (cmd) =>
          cmd.command.toLowerCase().includes(lower) ||
          cmd.description.toLowerCase().includes(lower),
      )
    : ORDERED_COMMANDS;

  const filtered = lower ? visibleItems : null;

  useEffect(() => { setActiveIndex(0); }, [search]);

  /* Hand focus back to whoever opened the menu (the composer textarea) when it
     closes. Without this, Escape dropped keyboard users on <body>, i.e. at the
     top of the document. The opener has to be read while *rendering*, not in
     an effect: the search field below carries autoFocus, which React applies
     during commit, so by the time a useEffect runs document.activeElement is
     already the menu's own input — restoring to it did nothing once it
     unmounted. */
  const [opener] = useState<HTMLElement | null>(() =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null);
  useEffect(() => () => {
    const current = document.activeElement;
    const lost = !current || current === document.body || panelRef.current?.contains(current) === true;
    if (opener?.isConnected && lost) opener.focus();
  }, [opener]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIndex}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  // ── Resize drag ────────────────────────────────────────────────────────────
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const r = resizeRef.current;
      if (!r) return;
      const dx = e.clientX - r.startX;
      const dy = e.clientY - r.startY;
      let w = r.startW;
      let h = r.startH;
      if (r.edge.includes('e'))  w = Math.max(400, Math.min(window.innerWidth  * 0.95, r.startW + dx));
      if (r.edge.includes('w'))  w = Math.max(400, Math.min(window.innerWidth  * 0.95, r.startW - dx));
      if (r.edge.includes('s'))  h = Math.max(200, Math.min(window.innerHeight * 0.95, r.startH + dy));
      if (r.edge.includes('n'))  h = Math.max(200, Math.min(window.innerHeight * 0.95, r.startH - dy));
      setSize({ w, h });
    }
    function onUp() { resizeRef.current = null; }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',  onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',  onUp);
    };
  }, []);

  function startResize(e: React.MouseEvent, edge: string) {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { edge, startX: e.clientX, startY: e.clientY, startW: size.w, startH: size.h };
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, visibleItems.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'ArrowRight':
      case 'Tab':
        e.preventDefault();
        // Jump down by 5 (page-down feel)
        setActiveIndex((i) => Math.min(i + 5, visibleItems.length - 1));
        break;
      case 'ArrowLeft':
        e.preventDefault();
        // Jump up by 5
        setActiveIndex((i) => Math.max(i - 5, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (visibleItems[activeIndex]) {
          onPick(visibleItems[activeIndex].command);
          onClose();
        }
        break;
      case 'Escape':
        e.preventDefault();
        if (search) setSearch('');
        else onClose();
        break;
    }
  }

  return (
    <div className="slash-menu-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="slash-menu slash-menu-resizable"
        style={{ width: size.w, height: size.h }}
        role="dialog"
        aria-modal="true"
        aria-label="斜杠命令"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Resize handles — 8 directions */}
        <div className="slash-resize-handle slash-resize-n"   onMouseDown={(e) => startResize(e, 'n')} />
        <div className="slash-resize-handle slash-resize-s"   onMouseDown={(e) => startResize(e, 's')} />
        <div className="slash-resize-handle slash-resize-w"   onMouseDown={(e) => startResize(e, 'w')} />
        <div className="slash-resize-handle slash-resize-e"   onMouseDown={(e) => startResize(e, 'e')} />
        <div className="slash-resize-handle slash-resize-nw"  onMouseDown={(e) => startResize(e, 'nw')} />
        <div className="slash-resize-handle slash-resize-ne"  onMouseDown={(e) => startResize(e, 'ne')} />
        <div className="slash-resize-handle slash-resize-sw"  onMouseDown={(e) => startResize(e, 'sw')} />
        <div className="slash-resize-handle slash-resize-se"  onMouseDown={(e) => startResize(e, 'se')} />

        <div className="slash-menu-header">
          <h3>斜杠命令</h3>
          <button className="slash-menu-close" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>

        {/* Search bar */}
        <div className="slash-menu-search">
          <Search size={13} className="slash-menu-search-icon" />
          <input
            autoFocus
            className="slash-menu-search-input"
            aria-label="搜索命令"
            placeholder="搜索命令…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="slash-menu-search-clear" onClick={() => setSearch('')} aria-label="清除搜索">
              <X size={11} />
            </button>
          )}
        </div>

        {/* Keyboard hint */}
        <div className="slash-menu-nav-hint">
          <span>↑↓ 移动</span>
          <span>←→ 跳5行</span>
          <span>Enter 确认</span>
          <span>Esc 关闭</span>
          <span className="slash-menu-nav-hint-drag">⤡ 拖动边缘调整大小</span>
        </div>

        <div className="slash-menu-content" ref={listRef}>
          {filtered ? (
            filtered.length === 0 ? (
              <div className="slash-menu-empty">没有匹配的命令</div>
            ) : (
              filtered.map((cmd, i) => (
                <CommandItem
                  key={cmd.command}
                  cmd={cmd}
                  active={i === activeIndex}
                  dataIdx={i}
                  onPick={onPick}
                  onClose={onClose}
                  onHover={() => setActiveIndex(i)}
                />
              ))
            )
          ) : (
            (() => {
              let globalIdx = 0;
              return CATEGORIES.map((category) => {
                const commands = ORDERED_COMMANDS.filter((cmd) => cmd.category === category);
                if (!commands.length) return null;
                const section = (
                  <div key={category} className="slash-menu-section">
                    <div className="slash-menu-category">{CATEGORY_LABELS[category]}</div>
                    {commands.map((cmd) => {
                      const idx = globalIdx++;
                      return (
                        <CommandItem
                          key={cmd.command}
                          cmd={cmd}
                          active={idx === activeIndex}
                          dataIdx={idx}
                          onPick={onPick}
                          onClose={onClose}
                          onHover={() => setActiveIndex(idx)}
                        />
                      );
                    })}
                  </div>
                );
                return section;
              });
            })()
          )}
        </div>

        <div className="slash-menu-footer">
          输入 <code>/</code> 快速触发 · 输入 <code>@</code> 引用文件或符号
        </div>
      </div>
    </div>
  );
}

function CommandItem({ cmd, active, dataIdx, onPick, onClose, onHover }: {
  cmd: SlashCommand;
  active: boolean;
  dataIdx: number;
  onPick: (command: string) => void;
  onClose: () => void;
  onHover: () => void;
}) {
  return (
    <button
      className={`slash-menu-item ${active ? 'active' : ''}`}
      data-idx={dataIdx}
      onClick={() => { onPick(cmd.command); onClose(); }}
      onMouseEnter={onHover}
    >
      <code className="slash-menu-command">{cmd.command}</code>
      <span className="slash-menu-desc">{cmd.description}</span>
      {cmd.badge && <span className="slash-menu-ai-badge">{cmd.badge}</span>}
    </button>
  );
}

