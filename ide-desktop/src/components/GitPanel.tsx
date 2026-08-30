import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GitBranch, GitCommit, GitPullRequest, RefreshCw, ChevronDown, ChevronRight,
  Plus, Minus, RotateCcw, Upload, Download, Check, X, AlertCircle, Loader2,
} from 'lucide-react';
import { desktop } from '../lib/ipc';
import type { GitStatus, GitBranchList, GitCommit as GitCommitType, GitFileStatus } from '../lib/ipc';

// ── sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ label, count, color }: { label: string; count: number; color: string }) {
  if (count === 0) return null;
  return (
    <span className="git-badge" style={{ background: color }}>
      {count} {label}
    </span>
  );
}

function FileRow({ file, checked, onCheck, onAction, actionIcon, actionTitle }: {
  file: GitFileStatus | string;
  checked: boolean;
  onCheck: () => void;
  onAction?: () => void;
  actionIcon?: React.ReactNode;
  actionTitle?: string;
}) {
  const isString = typeof file === 'string';
  const filePath  = isString ? file : (file as GitFileStatus).path;
  const indexChar = isString ? '?' : (file as GitFileStatus).index;
  const workChar  = isString ? '?' : (file as GitFileStatus).working;
  const letter    = isString ? 'U' : (indexChar !== ' ' ? indexChar : workChar);

  const letterColor: Record<string, string> = {
    M: 'var(--warn)', A: 'var(--ok)', D: 'var(--danger)',
    R: 'var(--blue)', C: 'var(--blue)', U: 'var(--fg-muted)', '?': 'var(--fg-dim)',
  };

  return (
    <div className="git-file-row">
      <input type="checkbox" className="git-file-check" checked={checked} onChange={onCheck} />
      <span className="git-file-letter" style={{ color: letterColor[letter] ?? 'var(--fg-muted)' }}>
        {letter}
      </span>
      <span className="git-file-path" title={filePath}>{filePath}</span>
      {onAction && (
        <button className="git-file-action icon-button" title={actionTitle} onClick={onAction}>
          {actionIcon}
        </button>
      )}
    </div>
  );
}

function Section({ title, count, open, onToggle, children }: {
  title: string; count: number; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="git-section">
      <button className="git-section-head" onClick={onToggle}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="git-section-title">{title}</span>
        <span className="git-section-count">{count}</span>
      </button>
      {open && <div className="git-section-body">{children}</div>}
    </div>
  );
}

// ── main panel ────────────────────────────────────────────────────────────────

type Tab = 'changes' | 'log' | 'branches';

export function GitPanel({ forcePush = false, branchPrefix = 'codex/' }: { forcePush?: boolean; branchPrefix?: string } = {}) {
  const [tab, setTab]               = useState<Tab>('changes');
  const [status, setStatus]         = useState<GitStatus | null>(null);
  const [branches, setBranches]     = useState<GitBranchList | null>(null);
  const [log, setLog]               = useState<GitCommitType[]>([]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);

  // Staged / unstaged selection
  const [stagedSel, setStagedSel]     = useState<Set<string>>(new Set());
  const [unstagedSel, setUnstagedSel] = useState<Set<string>>(new Set());

  // Commit
  const [commitMsg, setCommitMsg]     = useState('');
  const [committing, setCommitting]   = useState(false);
  const [commitResult, setCommitResult] = useState<string | null>(null);

  // Push / Pull
  const [pushing, setPushing]   = useState(false);
  const [pulling, setPulling]   = useState(false);
  const [syncMsg, setSyncMsg]   = useState<string | null>(null);

  // PR creation
  const [prOpen, setPrOpen]         = useState(false);
  const [prTitle, setPrTitle]       = useState('');
  const [prBody, setPrBody]         = useState('');
  const [prDraft, setPrDraft]       = useState(false);
  const [prBase, setPrBase]         = useState('');
  const [prCreating, setPrCreating] = useState(false);
  const [prResult, setPrResult]     = useState<{ ok: boolean; url?: string; error?: string } | null>(null);

  // Branch
  const [branchOpen, setBranchOpen]   = useState(false);
  const [newBranch, setNewBranch]     = useState('');

  // Sections open/closed
  const [stagedOpen, setStagedOpen]     = useState(true);
  const [unstagedOpen, setUnstagedOpen] = useState(true);
  const [untrackedOpen, setUntrackedOpen] = useState(false);

  const refreshRef = useRef(0);

  const refresh = useCallback(async () => {
    const tick = ++refreshRef.current;
    setLoading(true);
    setError(null);
    try {
      const [s, b] = await Promise.all([desktop.git.status(), desktop.git.branches()]);
      if (tick !== refreshRef.current) return; // stale
      setStatus(s.ok ? s : null);
      setBranches(b.ok ? b : null);
      if (!s.ok) setError(s.error ?? '无法读取 Git 状态');
      // Reset selections when status changes
      setStagedSel(new Set());
      setUnstagedSel(new Set());
    } catch (e) {
      if (tick !== refreshRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (tick === refreshRef.current) setLoading(false);
    }
  }, []);

  const loadLog = useCallback(async () => {
    try {
      const r = await desktop.git.log(50);
      if (r.ok && r.commits) setLog(r.commits);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (tab === 'log') void loadLog();
    if (tab === 'branches' && !branches) void refresh();
  }, [tab, loadLog, refresh, branches]);

  // ── actions ─────────────────────────────────────────────────────────────────

  async function stageSelected() {
    const paths = [...unstagedSel];
    if (!paths.length) return;
    await desktop.git.stage(paths);
    await refresh();
  }

  async function unstageSelected() {
    const paths = [...stagedSel];
    if (!paths.length) return;
    await desktop.git.unstage(paths);
    await refresh();
  }

  async function stageAll() {
    const all = [
      ...(status?.unstaged?.map((f) => f.path) ?? []),
      ...(status?.untracked ?? []),
    ];
    if (!all.length) return;
    await desktop.git.stage(all);
    await refresh();
  }

  async function unstageAll() {
    const all = status?.staged?.map((f) => f.path) ?? [];
    if (!all.length) return;
    await desktop.git.unstage(all);
    await refresh();
  }

  async function discardSelected() {
    const paths = [...unstagedSel].filter((p) =>
      status?.unstaged?.some((f) => f.path === p),
    );
    if (!paths.length) return;
    if (!window.confirm(`放弃 ${paths.length} 个文件的更改？此操作不可撤销。`)) return;
    await desktop.git.discard(paths);
    await refresh();
  }

  async function doCommit() {
    const msg = commitMsg.trim();
    if (!msg) return;
    setCommitting(true);
    setCommitResult(null);
    try {
      const r = await desktop.git.commit(msg);
      if (r.ok) {
        setCommitMsg('');
        setCommitResult(`✔ ${r.shortHash} ${r.message}`);
        await refresh();
        if (tab === 'log') await loadLog();
      } else {
        setCommitResult(`✘ ${r.error}`);
      }
    } finally {
      setCommitting(false);
    }
  }

  async function doPush() {
    setPushing(true);
    setSyncMsg(null);
    try {
      // Honor Settings → Git → 始终强制推送 (--force-with-lease).
      const r = await desktop.git.push('origin', status?.branch ?? '', forcePush);
      setSyncMsg(r.ok ? (forcePush ? '✔ 已强制推送 (--force-with-lease)' : '✔ 已推送') : `✘ ${r.error}`);
      if (r.ok) await refresh();
    } finally {
      setPushing(false);
    }
  }

  async function doPull() {
    setPulling(true);
    setSyncMsg(null);
    try {
      const r = await desktop.git.pull('origin', status?.branch ?? '');
      setSyncMsg(r.ok ? `✔ 已拉取` : `✘ ${r.error}`);
      if (r.ok) { await refresh(); if (tab === 'log') await loadLog(); }
    } finally {
      setPulling(false);
    }
  }

  async function doCheckout(branch: string) {
    const r = await desktop.git.checkout(branch);
    if (r.ok) { await refresh(); if (tab === 'log') await loadLog(); }
    else setError(r.error ?? '无法切换分支');
  }

  async function doCreateBranch() {
    const raw = newBranch.trim();
    if (!raw) return;
    // Apply Settings → Git branch prefix unless the user already typed one.
    const prefix = (branchPrefix || '').trim();
    const name = prefix && !raw.startsWith(prefix) && !raw.includes('/')
      ? `${prefix}${raw}`
      : raw;
    const r = await desktop.git.createBranch(name);
    if (r.ok) { setNewBranch(''); setBranchOpen(false); await refresh(); }
    else setError(r.error ?? '无法创建分支');
  }

  async function doDeleteBranch(name: string) {
    if (!window.confirm(`删除本地分支 "${name}"？`)) return;
    const r = await desktop.git.deleteBranch(name, false);
    if (r.ok) await refresh();
    else setError(r.error ?? '无法删除分支');
  }

  async function doCreatePr() {
    const title = prTitle.trim();
    if (!title) return;
    setPrCreating(true);
    setPrResult(null);
    try {
      const r = await desktop.git.createPr({
        title,
        body: prBody,
        draft: prDraft,
        base: prBase.trim() || undefined,
      });
      setPrResult({ ok: r.ok, url: r.url, error: r.error });
      if (r.ok) {
        // Auto-fill title for next time from last commit
        setPrTitle('');
        setPrBody('');
      }
    } finally {
      setPrCreating(false);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  function toggleSel(set: Set<string>, path: string): Set<string> {
    const next = new Set(set);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  }

  function selectAll(paths: string[], current: Set<string>): Set<string> {
    return current.size === paths.length ? new Set() : new Set(paths);
  }

  // ── render ───────────────────────────────────────────────────────────────────

  const stagedPaths    = status?.staged?.map((f) => f.path) ?? [];
  const unstagedPaths  = status?.unstaged?.map((f) => f.path) ?? [];
  const untracked      = status?.untracked ?? [];
  const totalChanges   = stagedPaths.length + unstagedPaths.length + untracked.length;

  return (
    <div className="git-panel">
      {/* Header */}
      <div className="git-header">
        <div className="git-header-branch">
          <GitBranch size={15} className="git-header-icon" />
          <span className="git-header-branch-name">{status?.branch ?? '…'}</span>
          {status && (status.ahead ?? 0) > 0 && (
            <span className="git-ahead-behind">↑{status.ahead}</span>
          )}
          {status && (status.behind ?? 0) > 0 && (
            <span className="git-ahead-behind">↓{status.behind}</span>
          )}
        </div>
        <div className="git-header-actions">
          <button className="icon-button" title="拉取" disabled={pulling} onClick={doPull}>
            {pulling ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
          </button>
          <button className="icon-button" title="推送" disabled={pushing} onClick={doPush}>
            {pushing ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
          </button>
          <button
            className={`icon-button ${prOpen ? 'active' : ''}`}
            title="创建 Pull Request"
            onClick={() => { setPrOpen((o) => !o); setPrResult(null); }}
          >
            <GitPullRequest size={14} />
          </button>
          <button className="icon-button" title="刷新" disabled={loading} onClick={refresh}>
            {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          </button>
        </div>
      </div>

      {/* Sync message */}
      {syncMsg && (
        <div className={`git-sync-msg ${syncMsg.startsWith('✘') ? 'error' : 'ok'}`}>
          {syncMsg}
          <button className="icon-button" onClick={() => setSyncMsg(null)}><X size={12} /></button>
        </div>
      )}

      {/* PR creation panel */}
      {prOpen && (
        <div className="git-pr-panel">
          <div className="git-pr-title-row">
            <GitPullRequest size={14} />
            <span>创建 Pull Request</span>
            <button className="icon-button" onClick={() => setPrOpen(false)}><X size={13} /></button>
          </div>
          <input
            className="git-pr-input"
            placeholder="PR 标题（必填）"
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) void doCreatePr(); }}
          />
          <textarea
            className="git-pr-body"
            placeholder="PR 描述（可选）"
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            rows={3}
          />
          <input
            className="git-pr-input"
            placeholder={`目标分支（默认 main）`}
            value={prBase}
            onChange={(e) => setPrBase(e.target.value)}
          />
          <div className="git-pr-footer">
            <label className="git-pr-draft">
              <input type="checkbox" checked={prDraft} onChange={(e) => setPrDraft(e.target.checked)} />
              草稿 PR
            </label>
            <button
              className="git-commit-btn"
              disabled={!prTitle.trim() || prCreating}
              onClick={() => void doCreatePr()}
            >
              {prCreating ? <Loader2 size={13} className="spin" /> : <GitPullRequest size={13} />}
              {prCreating ? '创建中…' : '创建 PR'}
            </button>
          </div>
          {prResult && (
            <div className={`git-pr-result ${prResult.ok ? 'ok' : 'error'}`}>
              {prResult.ok ? (
                <>
                  ✔ PR 已创建&nbsp;
                  <a href="#" onClick={(e) => { e.preventDefault(); void desktop.preview.openExternal(prResult.url ?? ''); }}>
                    {prResult.url}
                  </a>
                </>
              ) : (
                <>✘ {prResult.error}</>
              )}
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="git-error">
          <AlertCircle size={14} />
          <span>{error}</span>
          <button className="icon-button" onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      {/* Tabs */}
      <div className="git-tabs">
        <button className={`git-tab ${tab === 'changes' ? 'active' : ''}`} onClick={() => setTab('changes')}>
          变更 {totalChanges > 0 && <span className="git-tab-count">{totalChanges}</span>}
        </button>
        <button className={`git-tab ${tab === 'log' ? 'active' : ''}`} onClick={() => setTab('log')}>
          提交历史
        </button>
        <button className={`git-tab ${tab === 'branches' ? 'active' : ''}`} onClick={() => setTab('branches')}>
          分支
        </button>
      </div>

      {/* ── Changes tab ─────────────────────────────────────────────────────── */}
      {tab === 'changes' && (
        <div className="git-tab-body">
          {/* Staged */}
          <Section
            title="已暂存"
            count={stagedPaths.length}
            open={stagedOpen}
            onToggle={() => setStagedOpen((v) => !v)}
          >
            {stagedPaths.length === 0 ? (
              <div className="git-empty">无已暂存的更改</div>
            ) : (
              <>
                <div className="git-section-toolbar">
                  <input
                    type="checkbox"
                    title="全选"
                    checked={stagedSel.size === stagedPaths.length && stagedPaths.length > 0}
                    onChange={() => setStagedSel(selectAll(stagedPaths, stagedSel))}
                  />
                  <button className="git-toolbar-btn" title="取消暂存选中" disabled={stagedSel.size === 0} onClick={unstageSelected}>
                    <Minus size={12} /> 取消暂存
                  </button>
                  <button className="git-toolbar-btn" title="取消暂存全部" onClick={unstageAll}>
                    全部取消
                  </button>
                </div>
                {status?.staged?.map((f) => (
                  <FileRow
                    key={f.path}
                    file={f}
                    checked={stagedSel.has(f.path)}
                    onCheck={() => setStagedSel(toggleSel(stagedSel, f.path))}
                    onAction={() => void desktop.git.unstage([f.path]).then(refresh)}
                    actionIcon={<Minus size={13} />}
                    actionTitle="取消暂存"
                  />
                ))}
              </>
            )}
          </Section>

          {/* Unstaged */}
          <Section
            title="未暂存"
            count={unstagedPaths.length}
            open={unstagedOpen}
            onToggle={() => setUnstagedOpen((v) => !v)}
          >
            {unstagedPaths.length === 0 ? (
              <div className="git-empty">无未暂存的更改</div>
            ) : (
              <>
                <div className="git-section-toolbar">
                  <input
                    type="checkbox"
                    title="全选"
                    checked={unstagedSel.size === unstagedPaths.length && unstagedPaths.length > 0}
                    onChange={() => setUnstagedSel(selectAll(unstagedPaths, unstagedSel))}
                  />
                  <button className="git-toolbar-btn" title="暂存选中" disabled={unstagedSel.size === 0} onClick={stageSelected}>
                    <Plus size={12} /> 暂存
                  </button>
                  <button className="git-toolbar-btn" title="全部暂存" onClick={stageAll}>
                    全部暂存
                  </button>
                  <button className="git-toolbar-btn danger" title="放弃更改" disabled={unstagedSel.size === 0} onClick={discardSelected}>
                    <RotateCcw size={12} /> 放弃
                  </button>
                </div>
                {status?.unstaged?.map((f) => (
                  <FileRow
                    key={f.path}
                    file={f}
                    checked={unstagedSel.has(f.path)}
                    onCheck={() => setUnstagedSel(toggleSel(unstagedSel, f.path))}
                    onAction={() => void desktop.git.stage([f.path]).then(refresh)}
                    actionIcon={<Plus size={13} />}
                    actionTitle="暂存此文件"
                  />
                ))}
              </>
            )}
          </Section>

          {/* Untracked */}
          {untracked.length > 0 && (
            <Section
              title="未追踪"
              count={untracked.length}
              open={untrackedOpen}
              onToggle={() => setUntrackedOpen((v) => !v)}
            >
              <div className="git-section-toolbar">
                <button className="git-toolbar-btn" onClick={() => void desktop.git.stage(untracked).then(refresh)}>
                  <Plus size={12} /> 全部暂存
                </button>
              </div>
              {untracked.map((p) => (
                <FileRow
                  key={p}
                  file={{ path: p, index: '?', working: '?' }}
                  checked={false}
                  onCheck={() => {}}
                  onAction={() => void desktop.git.stage([p]).then(refresh)}
                  actionIcon={<Plus size={13} />}
                  actionTitle="暂存此文件"
                />
              ))}
            </Section>
          )}

          {/* Commit box */}
          <div className="git-commit-box">
            <textarea
              className="git-commit-input"
              placeholder="提交说明（必填）"
              rows={3}
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void doCommit(); }
              }}
            />
            <div className="git-commit-row">
              {commitResult && (
                <span className={`git-commit-result ${commitResult.startsWith('✘') ? 'error' : 'ok'}`}>
                  {commitResult}
                </span>
              )}
              <button
                className="git-commit-btn"
                disabled={committing || !commitMsg.trim() || stagedPaths.length === 0}
                onClick={doCommit}
                title={stagedPaths.length === 0 ? '请先暂存文件' : 'Ctrl+Enter 提交'}
              >
                {committing ? <Loader2 size={14} className="spin" /> : <GitCommit size={14} />}
                提交
              </button>
            </div>
            {stagedPaths.length === 0 && commitMsg.trim() !== '' && (
              <div className="git-commit-hint">⚠ 没有已暂存的文件，请先暂存</div>
            )}
          </div>
        </div>
      )}

      {/* ── Log tab ──────────────────────────────────────────────────────────── */}
      {tab === 'log' && (
        <div className="git-tab-body git-log">
          {log.length === 0 ? (
            <div className="git-empty git-empty-center">暂无提交历史</div>
          ) : (
            log.map((c) => (
              <div key={c.hash} className="git-log-item">
                <code className="git-log-hash">{c.shortHash}</code>
                <span className="git-log-msg" title={c.message}>{c.message}</span>
                <span className="git-log-meta">{c.author} · {new Date(c.date).toLocaleDateString('zh-CN')}</span>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── Branches tab ─────────────────────────────────────────────────────── */}
      {tab === 'branches' && (
        <div className="git-tab-body git-branches">
          {/* New branch form */}
          <div className="git-new-branch">
            <button
              className={`git-new-branch-toggle ${branchOpen ? 'open' : ''}`}
              onClick={() => setBranchOpen((v) => !v)}
            >
              <Plus size={14} /> 新建分支
            </button>
            {branchOpen && (
              <div className="git-new-branch-form">
                <input
                  autoFocus
                  className="git-branch-input"
                  placeholder={branchPrefix ? `${branchPrefix}feature-name` : '分支名称'}
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doCreateBranch();
                    if (e.key === 'Escape') { setBranchOpen(false); setNewBranch(''); }
                  }}
                />
                <button className="icon-button" title="创建" onClick={doCreateBranch}><Check size={14} /></button>
                <button className="icon-button" title="取消" onClick={() => { setBranchOpen(false); setNewBranch(''); }}><X size={14} /></button>
              </div>
            )}
          </div>

          {/* Local branches */}
          <div className="git-branch-group-label">本地</div>
          {(branches?.local ?? []).map((b) => (
            <div key={b} className={`git-branch-row ${b === branches?.current ? 'current' : ''}`}>
              {b === branches?.current && <span className="git-branch-current-dot" />}
              <span className="git-branch-name" title={b}>{b}</span>
              {b !== branches?.current && (
                <>
                  <button className="git-toolbar-btn" title="切换到此分支" onClick={() => void doCheckout(b)}>
                    切换
                  </button>
                  <button className="git-toolbar-btn danger" title="删除分支" onClick={() => void doDeleteBranch(b)}>
                    <X size={12} />
                  </button>
                </>
              )}
            </div>
          ))}

          {/* Remote branches */}
          {(branches?.remote ?? []).length > 0 && (
            <>
              <div className="git-branch-group-label">远程</div>
              {(branches?.remote ?? []).map((b) => (
                <div key={b} className="git-branch-row remote">
                  <GitPullRequest size={13} className="git-branch-remote-icon" />
                  <span className="git-branch-name" title={b}>{b}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
