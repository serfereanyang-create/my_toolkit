import { useEffect, useRef, useState } from 'react';
import { Activity, BarChart3, Bot, CheckCircle2, ChevronRight, FileDiff, FileSearch, GitBranch, History, LayoutTemplate, PanelRightClose, RefreshCw, Sparkles, X } from 'lucide-react';
import { SkillPanel } from './SkillPanel';
import { ReflectionPanel } from './ReflectionPanel';
import { ProjectAuditPanel } from './ProjectAuditPanel';
import { ReviewPanel } from './ReviewPanel';
import { SubagentDirectory } from './SubagentDirectory';

type WorkspaceToolTab = 'overview' | 'quality' | 'changes' | 'review' | 'preview' | 'skills' | 'reflections' | 'audit' | 'subagents';

export type WorkspaceAgentStatus = 'offline' | 'starting' | 'ready' | 'running';

export interface WorkspaceToolsPanelProps {
  open: boolean;
  width: number;
  workspaceRoot: string;
  openFilesCount: number;
  previewOpen: boolean;
  previewTabCount: number;
  agentStatus: WorkspaceAgentStatus;
  pendingDiffCount: number;
  /** Active conversation, so the subagent directory scopes to it. */
  sessionId?: string;
  /** Running subagent count, for the 子智能体 tab badge. */
  runningSubagentCount?: number;
  onClose: () => void;
  onWidthChange: (width: number) => void;
  onOpenQuality: () => void;
  onOpenGit: () => void;
  onOpenPreview: () => void;
  /** Open one file in the editor (from a review row). */
  onOpenFile?: (path: string) => void;
}

const MIN_WIDTH = 320;
const MAX_WIDTH = 720;

function clampWidth(value: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value));
}

function shortPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : normalized || '未选择工作区';
}

const AGENT_STATUS_VIEW: Record<WorkspaceAgentStatus, { label: string; tone: 'ok' | 'busy' | 'idle' }> = {
  ready: { label: '就绪', tone: 'ok' },
  running: { label: '任务执行中', tone: 'busy' },
  starting: { label: '连接中', tone: 'busy' },
  offline: { label: '未连接', tone: 'idle' },
};

export function WorkspaceToolsPanel({
  open,
  width,
  workspaceRoot,
  openFilesCount,
  previewOpen,
  previewTabCount,
  agentStatus,
  pendingDiffCount,
  sessionId,
  runningSubagentCount,
  onClose,
  onWidthChange,
  onOpenQuality,
  onOpenGit,
  onOpenPreview,
  onOpenFile,
}: WorkspaceToolsPanelProps) {
  const [tab, setTab] = useState<WorkspaceToolTab>('overview');
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!dragRef.current) return;
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      onWidthChange(clampWidth(drag.startWidth - (event.clientX - drag.startX)));
    };
    const onUp = () => { dragRef.current = null; document.body.style.userSelect = ''; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [onWidthChange]);

  if (!open) return null;

  const agent = AGENT_STATUS_VIEW[agentStatus];
  const tabs: Array<{ id: WorkspaceToolTab; label: string; icon: JSX.Element; badge?: number }> = [
    { id: 'overview', label: '概览', icon: <Activity size={14} /> },
    { id: 'quality', label: '质量', icon: <BarChart3 size={14} /> },
    { id: 'changes', label: '变更', icon: <GitBranch size={14} />, badge: pendingDiffCount || undefined },
    { id: 'review', label: '审查', icon: <FileSearch size={14} /> },
    { id: 'preview', label: '预览', icon: <FileDiff size={14} />, badge: previewOpen ? previewTabCount || undefined : undefined },
    { id: 'skills', label: '技能', icon: <Sparkles size={14} /> },
    { id: 'reflections', label: '教训', icon: <History size={14} /> },
    { id: 'audit', label: '结构', icon: <LayoutTemplate size={14} /> },
    { id: 'subagents', label: '子智能体', icon: <Bot size={14} />, badge: runningSubagentCount || undefined },
  ];

  return (
    <aside className="workspace-tools-panel" style={{ width }} role="dialog" aria-label="工作区工具面板">
      <button
        type="button"
        className="workspace-tools-resize"
        aria-label="调整工具面板宽度"
        onPointerDown={(event) => {
          event.preventDefault();
          dragRef.current = { startX: event.clientX, startWidth: width };
          document.body.style.userSelect = 'none';
        }}
      />
      <header className="workspace-tools-header">
        <div>
          <span className="workspace-tools-eyebrow">WORKSPACE</span>
          <h2>工作区工具</h2>
        </div>
        <button type="button" className="workspace-tools-close" onClick={onClose} aria-label="关闭工具面板" title="关闭">
          <PanelRightClose size={17} />
        </button>
      </header>

      <div className="workspace-tools-root" title={workspaceRoot}>{shortPath(workspaceRoot)}</div>
      <nav className="workspace-tools-tabs" aria-label="工具分类">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`workspace-tools-tab ${tab === item.id ? 'active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.icon}<span>{item.label}</span>
            {item.badge != null && item.badge > 0 && <span className="workspace-tools-tab-badge">{item.badge}</span>}
          </button>
        ))}
      </nav>

      <div className="workspace-tools-body">
        {tab === 'overview' && (
          <div className="workspace-tools-stack">
            <section className={`workspace-tools-hero tone-${agent.tone}`}>
              <div className="workspace-tools-hero-icon"><CheckCircle2 size={20} /></div>
              <div>
                <strong>{agent.tone === 'ok' ? '工作区已就绪' : agent.label}</strong>
                <span>{agent.tone === 'ok' ? '工具状态正常，可以继续工作' : `智能体状态：${agent.label}`}</span>
              </div>
            </section>
            <div className="workspace-tools-metrics">
              <div><strong>{openFilesCount}</strong><span>打开文件</span></div>
              <div><strong>{previewOpen ? `${previewTabCount} 个` : '关闭'}</strong><span>预览标签</span></div>
              <div><strong>{pendingDiffCount}</strong><span>待审批</span></div>
            </div>
            <button type="button" className="workspace-tools-action-card" onClick={onOpenQuality}>
              <span className="workspace-tools-action-icon quality"><BarChart3 size={17} /></span>
              <span><strong>打开质量工作台</strong><small>复杂度、异味、依赖与评分</small></span>
              <ChevronRight size={16} />
            </button>
            <button type="button" className="workspace-tools-action-card" onClick={onOpenGit}>
              <span className="workspace-tools-action-icon git"><GitBranch size={17} /></span>
              <span><strong>{pendingDiffCount > 0 ? `查看变更（${pendingDiffCount} 项待审批）` : '查看 Git 变更'}</strong><small>状态、分支、提交与同步</small></span>
              <ChevronRight size={16} />
            </button>
            <button type="button" className="workspace-tools-action-card" onClick={onOpenPreview}>
              <span className="workspace-tools-action-icon preview"><FileDiff size={17} /></span>
              <span><strong>{previewOpen ? '回到预览' : '打开预览'}</strong><small>查看 PDF、HTML、图片和文档</small></span>
              <ChevronRight size={16} />
            </button>
          </div>
        )}
        {tab === 'quality' && (
          <div className="workspace-tools-empty">
            <BarChart3 size={28} />
            <strong>质量工作台</strong>
            <span>从已有质量分析入口查看复杂度、覆盖率和性能。</span>
            <button type="button" className="workspace-tools-primary" onClick={onOpenQuality}>打开质量工作台 <ChevronRight size={14} /></button>
          </div>
        )}
        {tab === 'changes' && (
          <div className="workspace-tools-stack">
            {pendingDiffCount > 0 ? (
              <section className="workspace-tools-hero tone-busy">
                <div className="workspace-tools-hero-icon"><GitBranch size={20} /></div>
                <div>
                  <strong>{pendingDiffCount} 项变更待审批</strong>
                  <span>对话流中的审批卡片会实时更新</span>
                </div>
              </section>
            ) : (
              <div className="workspace-tools-empty">
                <GitBranch size={28} />
                <strong>Git 变更</strong>
                <span>当前没有待审批的文件变更。可切换到 Git 面板查看工作区状态。</span>
              </div>
            )}
            <button type="button" className="workspace-tools-primary" onClick={onOpenGit}>查看 Git 变更 <ChevronRight size={14} /></button>
          </div>
        )}
        {tab === 'review' && (
          <div className="workspace-tools-review">
            <ReviewPanel workspaceRoot={workspaceRoot} onOpenFile={onOpenFile} />
          </div>
        )}
        {tab === 'preview' && (
          <div className="workspace-tools-empty">
            <FileDiff size={28} />
            <strong>预览</strong>
            <span>
              {previewOpen
                ? `预览栏已打开，共 ${previewTabCount} 个标签。`
                : '打开已有预览栏，查看文档和静态页面。'}
            </span>
            <button type="button" className="workspace-tools-primary" onClick={onOpenPreview}>{previewOpen ? '回到预览' : '打开预览'} <ChevronRight size={14} /></button>
          </div>
        )}
        {tab === 'skills' && (
          <div className="workspace-tools-skill">
            <SkillPanel />
          </div>
        )}
        {tab === 'reflections' && (
          <div className="workspace-tools-reflection">
            <ReflectionPanel />
          </div>
        )}
        {tab === 'audit' && (
          <div className="workspace-tools-audit">
            <ProjectAuditPanel />
          </div>
        )}
        {tab === 'subagents' && (
          <div className="workspace-tools-subagents">
            <SubagentDirectory sessionId={sessionId} />
          </div>
        )}
      </div>
      <footer className="workspace-tools-footer"><RefreshCw size={13} /><span>面板状态会随工作区实时更新</span><button type="button" onClick={onClose} aria-label="关闭"><X size={14} /></button></footer>
    </aside>
  );
}
