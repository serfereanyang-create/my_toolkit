import { useState } from 'react';
import {
  ChevronRight, Clock, Loader, Undo2, FileEdit, Check,
  Search, Pencil, Terminal, Globe, Brain, Wrench, Eye, FolderOpen,
} from 'lucide-react';
import type { ChatItem, ToolChatItem } from '../types';
import { ToolCard } from './ToolCard';

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}小时${minutes}分`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

function formatDuration(ms?: number): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function dirName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(0, idx + 1) : '';
}

// Classify tool into a category for icon + summary format
type ToolCategory = 'search' | 'read' | 'write' | 'shell' | 'network' | 'think' | 'other';

function categorize(tool: string): ToolCategory {
  const t = tool.toLowerCase();
  if (t.includes('search') || t.includes('grep') || t.includes('find') || t.includes('glob') || t === 'project_index' || t === 'find_symbol' || t === 'find_references') return 'search';
  if (t.includes('read') || t.includes('list') || t === 'head_tail' || t === 'recent_activity' || t === 'project_status' || t.includes('info') || t.includes('stat') || t.includes('probe') || t.includes('diff') || t.includes('preview') || t === 'git_log' || t === 'git_status' || t === 'git_diff') return 'read';
  if (t.includes('write') || t.includes('edit') || t.includes('patch') || t.includes('create') || t.includes('append') || t.includes('rename') || t.includes('delete') || t.includes('copy') || t.includes('mkdir') || t === 'git_add' || t === 'git_commit' || t === 'git_checkout' || t === 'git_reset') return 'write';
  if (t.includes('run') || t.includes('command') || t.includes('bash') || t.includes('shell') || t.includes('script') || t.includes('typecheck') || t.includes('test') || t.includes('lint') || t.includes('install')) return 'shell';
  if (t.includes('fetch') || t.includes('url') || t.includes('web') || t.includes('http') || t.includes('download') || t.includes('link') || t.includes('parse_url') || t.includes('html')) return 'network';
  if (t === 'think' || t === 'reasoning') return 'think';
  return 'other';
}

const CATEGORY_ICONS: Record<ToolCategory, React.ElementType> = {
  search: Search,
  read: Eye,
  write: Pencil,
  shell: Terminal,
  network: Globe,
  think: Brain,
  other: Wrench,
};

const CATEGORY_LABELS: Record<ToolCategory, string> = {
  search: '搜索',
  read: '读取',
  write: '编辑',
  shell: '命令',
  network: '网络',
  think: '思考',
  other: '工具',
};

// Build a one-line summary for a tool step
function stepSummary(step: ToolChatItem): string {
  const input = step.input && typeof step.input === 'object' ? step.input as Record<string, unknown> : {};
  const cat = categorize(step.tool);

  if (cat === 'search') {
    const query = input.query ?? input.pattern ?? input.text ?? input.name ?? '';
    const path = input.path ?? input.directory ?? '';
    if (query) return `"${String(query).slice(0, 40)}"`;
    if (path) return String(path);
    return step.tool;
  }
  if (cat === 'read') {
    const path = input.path ?? input.directory ?? input.relativePath ?? '';
    if (path) return baseName(String(path));
    return step.tool;
  }
  if (cat === 'write') {
    const path = input.path ?? input.relativePath ?? '';
    const name = path ? baseName(String(path)) : '';
    const dir = path ? dirName(String(path)) : '';
    const changes = step.added || step.removed
      ? ` ${step.added ? `+${step.added}` : ''}${step.removed ? ` -${step.removed}` : ''}`
      : '';
    if (name) return `${name}  ${dir}${changes}`;
    return step.tool + changes;
  }
  if (cat === 'shell') {
    const cmd = input.command ?? '';
    if (cmd) return String(cmd).slice(0, 60);
    const script = input.script ?? input.name ?? '';
    if (script) return String(script);
    return step.tool;
  }
  if (cat === 'network') {
    const url = input.url ?? input.query ?? '';
    if (url) return String(url).slice(0, 60);
    return step.tool;
  }
  return step.tool;
}

// Single collapsible step row
function StepRow({ step, onApprove }: {
  step: ToolChatItem;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const cat = categorize(step.tool);
  const Icon = CATEGORY_ICONS[cat];
  const summary = stepSummary(step);
  const dur = formatDuration(step.durationMs);
  const hasDetail = step.input !== undefined || step.output;

  return (
    <div className={`step-row ${step.status}`}>
      <button
        className="step-row-head"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        style={{ cursor: hasDetail ? 'pointer' : 'default' }}
        aria-expanded={expanded}
      >
        {step.status === 'running'
          ? <Loader size={13} className="step-spin" />
          : <Icon size={13} className={`step-icon step-icon-${cat}`} />
        }
        <span className="step-label">{CATEGORY_LABELS[cat]}</span>
        {summary && <span className="step-summary">{summary}</span>}
        {dur && step.status !== 'running' && <span className="step-dur">{dur}</span>}
        {(step.added || step.removed) && step.status !== 'running' && (
          <span className="step-changes">
            {step.added ? <span className="turn-add">+{step.added}</span> : null}
            {step.removed ? <span className="turn-del">-{step.removed}</span> : null}
          </span>
        )}
        {hasDetail && (
          <ChevronRight size={12} className={`step-caret ${expanded ? 'open' : ''}`} />
        )}
      </button>
      {expanded && (
        <div className="step-detail">
          <ToolCard item={step} onApprove={onApprove} />
        </div>
      )}
    </div>
  );
}

export function TurnSummary({ item, onApprove, onUndo, now }: {
  item: Extract<ChatItem, { kind: 'turn' }>;
  onApprove: (requestId: string, decision: 'allow_once' | 'allow_session' | 'deny') => void;
  onUndo: (turnId: string) => void;
  now: number;
}) {
  const running = item.endedAt === undefined;
  const [collapsed, setCollapsed] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const elapsed = formatElapsed((item.endedAt ?? now) - item.startedAt);
  const files = item.files ?? [];
  const hasFiles = files.length > 0;
  const undoable = files.some((f) => f.checkpointIds.length > 0);
  const undoState = item.undo ?? 'idle';

  return (
    <section className={`turn-summary ${running ? 'running' : 'done'}`}>
      {/* Step list — default expanded, collapsible */}
      {!collapsed && (
        <div className="turn-steps-inline">
          {item.steps.map((step) => (
            <StepRow key={step.id} step={step} onApprove={onApprove} />
          ))}
        </div>
      )}

      {/* Footer bar: elapsed · steps · changes · collapse toggle */}
      <button
        className="turn-head"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? '展开步骤' : '折叠步骤'}
      >
        <ChevronRight className={`turn-caret ${!collapsed ? 'open' : ''}`} size={15} />
        <span className="turn-elapsed">
          {running ? <Loader className="turn-spin" size={14} /> : <Clock size={14} />}
          已工作 {elapsed}
        </span>
        <span className="turn-count">{item.steps.length} 步</span>
        {(item.added > 0 || item.removed > 0) && (
          <>
            <span className="turn-count">·</span>
            <span className="turn-add">+{item.added}</span>
            <span className="turn-del">-{item.removed}</span>
          </>
        )}
      </button>

      {/* Changed-files bar */}
      {hasFiles && !running && (
        <div className={`turn-changes-bar ${undoState === 'undone' ? 'undone' : ''}`}>
          <button className="turn-changes-head" onClick={() => setFilesOpen((v) => !v)} aria-expanded={filesOpen}>
            <ChevronRight className={`turn-caret ${filesOpen ? 'open' : ''}`} size={14} />
            <FileEdit size={14} />
            <span className="turn-changes-label">{files.length} 个文件已更改</span>
          </button>
          {undoState === 'undone' ? (
            <span className="turn-undo-done"><Check size={13} /> 已撤销</span>
          ) : undoable ? (
            <button className="turn-undo-btn" disabled={undoState === 'undoing'} onClick={() => onUndo(item.id)}>
              <Undo2 size={13} /> {undoState === 'undoing' ? '撤销中…' : '撤销'}
            </button>
          ) : null}
          {filesOpen && (
            <ul className="turn-file-list">
              {files.map((file) => (
                <li key={file.path} className="turn-file-row" title={file.path}>
                  <span className="turn-file-name">{baseName(file.path)}</span>
                  <span className="turn-file-path">{file.path}</span>
                  <span className="turn-file-stat">
                    {file.added > 0 && <span className="turn-add">+{file.added}</span>}
                    {file.removed > 0 && <span className="turn-del">-{file.removed}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {undoState === 'failed' && <span className="turn-undo-error">撤销失败，请重试</span>}
        </div>
      )}
    </section>
  );
}
