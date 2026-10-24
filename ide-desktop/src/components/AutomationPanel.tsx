import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  Check,
  Clock3,
  FileClock,
  GitBranch,
  History,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Workflow,
} from 'lucide-react';
import { desktop } from '../lib/ipc';
import type { AutomationRun, AutomationTask, AutomationTrigger } from '../types';
import { ConfirmDialog } from './ConfirmDialog';

type Draft = {
  id?: string;
  name: string;
  description: string;
  triggerType: AutomationTrigger['type'];
  cron: string;
  patterns: string;
  fileEvents: Array<'create' | 'modify' | 'delete'>;
  debounceMs: number;
  gitEvents: Array<'commit' | 'push' | 'pull'>;
  branches: string;
  pollIntervalMs: number;
  goal: string;
};

const EMPTY_DRAFT: Draft = {
  name: '',
  description: '',
  triggerType: 'cron',
  cron: '0 9 * * 1-5',
  patterns: 'src/**/*.ts',
  fileEvents: ['modify'],
  debounceMs: 1500,
  gitEvents: ['commit'],
  branches: '',
  pollIntervalMs: 30000,
  goal: '',
};

const TRIGGER_META = {
  cron: { label: '定时', icon: CalendarClock },
  file_watch: { label: '文件变化', icon: FileClock },
  git_event: { label: 'Git 事件', icon: GitBranch },
  manual: { label: '手动', icon: Play },
} satisfies Record<AutomationTrigger['type'], { label: string; icon: typeof CalendarClock }>;

export function AutomationPanel() {
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string>();
  const [error, setError] = useState('');
  // Which required fields the last save attempt found empty. Cleared by a
  // successful save or by leaving the form, so an old attempt never keeps a
  // field marked after the user fixed it.
  const [invalidFields, setInvalidFields] = useState({ name: false, goal: false });
  const [deleteTask, setDeleteTask] = useState<AutomationTask | null>(null);

  const selected = useMemo(() => tasks.find((task) => task.id === selectedId), [tasks, selectedId]);

  const refresh = useCallback(async () => {
    try {
      const [nextTasks, active] = await Promise.all([desktop.automation.list(), desktop.automation.active()]);
      setTasks(nextTasks);
      setActiveIds(new Set(active.map((item) => item.id)));
      setSelectedId((current) => current && nextTasks.some((task) => task.id === current) ? current : nextTasks[0]?.id);
      setError('');
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return desktop.automation.onChanged(() => { void refresh(); });
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) {
      setHistory([]);
      return;
    }
    void desktop.automation.history(selectedId, 12).then(setHistory).catch(() => setHistory([]));
  }, [selectedId, tasks]);

  function beginCreate() {
    setDraft({ ...EMPTY_DRAFT, fileEvents: [...EMPTY_DRAFT.fileEvents], gitEvents: [...EMPTY_DRAFT.gitEvents] });
    setEditing(true);
    setSelectedId(undefined);
    setError('');
  }

  function beginEdit(task: AutomationTask) {
    setDraft(taskToDraft(task));
    setEditing(true);
    setSelectedId(task.id);
    setError('');
  }

  async function saveDraft() {
    if (!draft.name.trim() || !draft.goal.trim()) {
      const missing = { name: !draft.name.trim(), goal: !draft.goal.trim() };
      setError('名称和任务目标不能为空。');
      setInvalidFields(missing);
      // Focus the first offending field: the banner is above the task list,
      // far from the form, so without this the user has to hunt for what
      // failed.
      const selector = missing.name ? '.automation-form input[aria-invalid="true"]'
        : '.automation-form textarea[aria-invalid="true"]';
      window.setTimeout(() => {
        const field = document.querySelector<HTMLElement>(selector);
        field?.focus();
      }, 0);
      return;
    }
    setInvalidFields({ name: false, goal: false });
    setBusyAction('save');
    try {
      const input = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        trigger: draftToTrigger(draft),
        action: { type: 'task_board' as const, goal: draft.goal.trim(), confirmPlan: true as const },
      };
      const saved = draft.id
        ? await desktop.automation.update(draft.id, input)
        : await desktop.automation.create(input);
      setEditing(false);
      setSelectedId(saved.id);
      await refresh();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function runAction(action: 'start' | 'stop' | 'run' | 'delete', task: AutomationTask) {
    if (action === 'delete') { setDeleteTask(task); return; }
    setBusyAction(`${action}:${task.id}`);
    setError('');
    try {
      if (action === 'start') await desktop.automation.start(task.id);
      else if (action === 'stop') await desktop.automation.stop(task.id);
      else if (action === 'run') await desktop.automation.run(task.id);
      await refresh();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function confirmDelete() {
    const task = deleteTask;
    setDeleteTask(null);
    if (!task) return;
    setBusyAction(`delete:${task.id}`);
    setError('');
    try {
      await desktop.automation.delete(task.id);
      setSelectedId(undefined);
      await refresh();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusyAction(undefined);
    }
  }

  return (
    <section className="automation-view">
      <header className="automation-header">
        <div>
          {/* No eyebrow: the topbar already names the view 自动化, and an
              eyebrow restating it one line above 任务调度 is pure repetition. */}
          <h1>任务调度</h1>
          <p>按时间、文件变化或 Git 事件自动执行多专家任务板。</p>
        </div>
        <div className="automation-header-actions">
          <button className="icon-button" title="刷新" onClick={() => void refresh()}><RefreshCw size={17} /></button>
          <button className="automation-primary" onClick={beginCreate}><Plus size={16} /> 新建自动化</button>
        </div>
      </header>

      {error && <div className="automation-error">{error}</div>}

      <div className="automation-workspace">
        <aside className="automation-list-pane">
          <div className="automation-pane-label">任务 {tasks.length}</div>
          {loading ? (
            <div className="automation-empty">正在读取任务…</div>
          ) : tasks.length === 0 ? (
            <button className="automation-empty automation-empty-action" onClick={beginCreate}>
              <Plus size={18} />
              <span>创建第一个自动化任务</span>
            </button>
          ) : tasks.map((task) => {
            const meta = TRIGGER_META[task.trigger.type];
            const Icon = meta.icon;
            const active = activeIds.has(task.id);
            return (
              <button
                key={task.id}
                className={`automation-list-item ${selectedId === task.id ? 'active' : ''}`}
                onClick={() => { setSelectedId(task.id); setEditing(false); }}
              >
                <span className="automation-task-icon"><Icon size={17} /></span>
                <span className="automation-task-copy">
                  <strong>{task.name}</strong>
                  <small>{triggerSummary(task.trigger)}</small>
                </span>
                <span className={`automation-status-dot ${active ? 'running' : task.enabled ? 'waiting' : 'stopped'}`} title={active ? '运行中' : task.enabled ? '等待触发' : '已暂停'} />
              </button>
            );
          })}
        </aside>

        <main className="automation-detail-pane">
          {editing ? (
            <AutomationForm draft={draft} setDraft={setDraft} saving={busyAction === 'save'}
              invalid={invalidFields}
              onFix={(field) => setInvalidFields((current) => ({ ...current, [field]: false }))}
              onCancel={() => { setEditing(false); setInvalidFields({ name: false, goal: false }); }}
              onSave={() => void saveDraft()} />
          ) : selected ? (
            <AutomationDetail
              task={selected}
              active={activeIds.has(selected.id)}
              history={history}
              busyAction={busyAction}
              onEdit={() => beginEdit(selected)}
              onAction={(action) => void runAction(action, selected)}
            />
          ) : (
            <div className="automation-detail-empty">
              <Workflow size={28} />
              <strong>选择任务查看详情</strong>
              <span>或新建一个自动化工作流。</span>
            </div>
          )}
        </main>
      </div>
      <ConfirmDialog
        open={deleteTask !== null}
        title="删除自动化任务？"
        message={`“${deleteTask?.name ?? ''}”将从任务列表中删除，已有运行记录会保留。`}
        confirmLabel="删除任务"
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTask(null)}
      />
    </section>
  );
}

function AutomationForm({ draft, setDraft, saving, onCancel, onSave, invalid, onFix }: {
  draft: Draft;
  setDraft: (next: Draft) => void;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  /** Fields the last save attempt found empty. Both are required, and the
   *  form has no per-field messages — marking the input puts the failure
   *  where the fix goes instead of only in the banner above the list. */
  invalid: { name: boolean; goal: boolean };
  /** Clear one field's mark once it holds a value. */
  onFix: (field: 'name' | 'goal') => void;
}) {
  const triggerTypes = Object.entries(TRIGGER_META) as Array<[AutomationTrigger['type'], (typeof TRIGGER_META)[AutomationTrigger['type']]]>;
  return (
    <div className="automation-form">
      <div className="automation-detail-title">
        <div><span>{draft.id ? '编辑任务' : '新建任务'}</span><h2>{draft.id ? draft.name : '配置自动化'}</h2></div>
      </div>

      <label>名称<input className={invalid.name ? 'invalid' : undefined} aria-invalid={invalid.name || undefined}
        aria-required="true" value={draft.name} onChange={(event) => {
          setDraft({ ...draft, name: event.target.value });
          // Typing is the fix, so stop calling the field invalid immediately
          // rather than waiting for the next save attempt to re-judge it.
          if (invalid.name && event.target.value.trim()) onFix('name');
        }} placeholder="例如：工作日测试" /></label>
      <label>说明<input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="可选" /></label>

      <fieldset>
        <legend>触发方式</legend>
        <div className="automation-segments">
          {triggerTypes.map(([type, meta]) => {
            const Icon = meta.icon;
            return <button key={type} className={draft.triggerType === type ? 'active' : ''} onClick={() => setDraft({ ...draft, triggerType: type })}><Icon size={15} />{meta.label}</button>;
          })}
        </div>
      </fieldset>

      {draft.triggerType === 'cron' && (
        <label>Cron 表达式<input className="mono" value={draft.cron} onChange={(event) => setDraft({ ...draft, cron: event.target.value })} placeholder="0 9 * * 1-5" /></label>
      )}
      {draft.triggerType === 'file_watch' && (
        <>
          <label>监听模式<textarea value={draft.patterns} onChange={(event) => setDraft({ ...draft, patterns: event.target.value })} placeholder={'src/**/*.ts\ntests/**/*.test.ts'} /></label>
          <CheckGroup label="文件事件" values={draft.fileEvents} options={['create', 'modify', 'delete']} onChange={(fileEvents) => setDraft({ ...draft, fileEvents })} />
          <label>防抖（毫秒）<input type="number" min={100} max={60000} value={draft.debounceMs} onChange={(event) => setDraft({ ...draft, debounceMs: Number(event.target.value) })} /></label>
        </>
      )}
      {draft.triggerType === 'git_event' && (
        <>
          <CheckGroup label="Git 事件" values={draft.gitEvents} options={['commit', 'push', 'pull']} onChange={(gitEvents) => setDraft({ ...draft, gitEvents })} />
          <label>分支（逗号分隔）<input value={draft.branches} onChange={(event) => setDraft({ ...draft, branches: event.target.value })} placeholder="main, develop；留空表示全部" /></label>
          <label>轮询间隔（毫秒）<input type="number" min={5000} max={300000} value={draft.pollIntervalMs} onChange={(event) => setDraft({ ...draft, pollIntervalMs: Number(event.target.value) })} /></label>
        </>
      )}

      <label>任务板目标<textarea className={`automation-goal-input${invalid.goal ? ' invalid' : ''}`}
        aria-invalid={invalid.goal || undefined} aria-required="true"
        value={draft.goal} onChange={(event) => {
          setDraft({ ...draft, goal: event.target.value });
          if (invalid.goal && event.target.value.trim()) onFix('goal');
        }} placeholder="描述触发后需要自主完成的目标" /></label>
      <div className="automation-form-actions">
        <button className="automation-secondary" onClick={onCancel}>取消</button>
        <button className="automation-primary" disabled={saving} onClick={onSave}><Save size={16} /> {saving ? '保存中…' : '保存'}</button>
      </div>
    </div>
  );
}

function AutomationDetail({ task, active, history, busyAction, onEdit, onAction }: {
  task: AutomationTask;
  active: boolean;
  history: AutomationRun[];
  busyAction?: string;
  onEdit: () => void;
  onAction: (action: 'start' | 'stop' | 'run' | 'delete') => void;
}) {
  const meta = TRIGGER_META[task.trigger.type];
  const Icon = meta.icon;
  const busy = Boolean(busyAction?.endsWith(task.id));
  return (
    <div className="automation-detail">
      <div className="automation-detail-title">
        <div><span><Icon size={15} /> {meta.label}</span><h2>{task.name}</h2></div>
        <div className="automation-detail-actions">
          <button className="icon-button" title="编辑" onClick={onEdit}><Save size={16} /></button>
          <button className="icon-button danger" title="删除" disabled={busy} onClick={() => onAction('delete')}><Trash2 size={16} /></button>
        </div>
      </div>
      {task.description && <p className="automation-description">{task.description}</p>}

      <div className="automation-command-row">
        <button className="automation-primary" disabled={busy} onClick={() => onAction('run')}><Play size={16} /> 立即运行</button>
        {task.enabled
          ? <button className="automation-secondary" disabled={busy} onClick={() => onAction('stop')}><Pause size={16} /> 暂停调度</button>
          : <button className="automation-secondary" disabled={busy} onClick={() => onAction('start')}><Clock3 size={16} /> 启用调度</button>}
        <span className={`automation-state ${active ? 'active' : ''}`}>{active ? '监听中' : task.enabled ? '已启用' : '已暂停'}</span>
      </div>

      <dl className="automation-properties">
        <div><dt>触发条件</dt><dd>{triggerSummary(task.trigger)}</dd></div>
        <div><dt>任务目标</dt><dd>{task.action.goal}</dd></div>
        {/* "上次运行" is the timestamp of one run; the section below is the run
            history. Both used to read 最近运行, so the summary row looked like a
            header for a list that was already printed under it. */}
        <div><dt>上次运行</dt><dd>{task.lastRunAt ? formatDate(task.lastRunAt) : '尚未运行'}</dd></div>
        <div><dt>执行状态</dt><dd>{statusLabel(task.lastRunStatus)}{task.lastRunError ? ` · ${task.lastRunError}` : ''}</dd></div>
        <div><dt>连续失败</dt><dd>{task.consecutiveFailures || 0} / 3</dd></div>
      </dl>

      <div className="automation-history">
        <div className="automation-pane-label"><History size={14} /> 最近运行</div>
        {history.length === 0 ? <div className="automation-history-empty">暂无运行记录</div> : history.map((run) => (
          <div className="automation-run" key={`${run.startedAt}-${run.status}`}>
            <span className={`automation-run-icon ${run.status}`}>{run.status === 'success' ? <Check size={14} /> : <Clock3 size={14} />}</span>
            <span><strong>{statusLabel(run.status)}</strong><small>{formatDate(run.finishedAt)}</small></span>
            <code>{String(run.trigger?.type ?? 'manual')}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function CheckGroup<T extends string>({ label, values, options, onChange }: { label: string; values: T[]; options: T[]; onChange: (values: T[]) => void }) {
  return (
    <fieldset><legend>{label}</legend><div className="automation-checks">{options.map((option) => (
      <label key={option}><input type="checkbox" checked={values.includes(option)} onChange={(event) => onChange(event.target.checked ? [...values, option] : values.filter((value) => value !== option))} />{option}</label>
    ))}</div></fieldset>
  );
}

function taskToDraft(task: AutomationTask): Draft {
  const draft: Draft = { ...EMPTY_DRAFT, id: task.id, name: task.name, description: task.description ?? '', goal: task.action.goal, triggerType: task.trigger.type, fileEvents: [...EMPTY_DRAFT.fileEvents], gitEvents: [...EMPTY_DRAFT.gitEvents] };
  if (task.trigger.type === 'cron') draft.cron = task.trigger.expression;
  if (task.trigger.type === 'file_watch') Object.assign(draft, { patterns: task.trigger.patterns.join('\n'), fileEvents: [...task.trigger.events], debounceMs: task.trigger.debounceMs });
  if (task.trigger.type === 'git_event') Object.assign(draft, { gitEvents: [...task.trigger.events], branches: task.trigger.branches.join(', '), pollIntervalMs: task.trigger.pollIntervalMs });
  return draft;
}

function draftToTrigger(draft: Draft): AutomationTrigger {
  if (draft.triggerType === 'cron') return { type: 'cron', expression: draft.cron.trim() };
  if (draft.triggerType === 'file_watch') return { type: 'file_watch', patterns: draft.patterns.split(/[\n,]/).map((item) => item.trim()).filter(Boolean), events: draft.fileEvents, debounceMs: draft.debounceMs };
  if (draft.triggerType === 'git_event') return { type: 'git_event', events: draft.gitEvents, branches: draft.branches.split(',').map((item) => item.trim()).filter(Boolean), pollIntervalMs: draft.pollIntervalMs };
  return { type: 'manual' };
}

function triggerSummary(trigger: AutomationTrigger) {
  if (trigger.type === 'cron') return trigger.expression;
  if (trigger.type === 'file_watch') return `${trigger.patterns.join(', ')} · ${trigger.events.join('/')}`;
  if (trigger.type === 'git_event') return `${trigger.events.join('/')} · ${trigger.branches.length ? trigger.branches.join(', ') : '全部分支'}`;
  return '仅手动运行';
}

function statusLabel(status?: AutomationTask['lastRunStatus'] | AutomationRun['status']) {
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'blocked') return '已阻塞';
  return '未运行';
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
