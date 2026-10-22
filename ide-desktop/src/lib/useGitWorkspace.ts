import { useCallback, useEffect, useRef, useState } from 'react';
import { desktop, type GitBranchList, type GitDiffStats, type GitStatus } from './ipc';

type GitResult = { ok: boolean; error?: string };

export function useGitWorkspace(workspaceRoot: string) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranchList | null>(null);
  const [stats, setStats] = useState<GitDiffStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The workspace folder has never been a repository: the panel offers to run
  // `git init` instead of showing git's "not a git repository" fatal message.
  const [notRepo, setNotRepo] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const scope = useRef({ root: workspaceRoot });
  if (scope.current.root !== workspaceRoot) scope.current = { root: workspaceRoot };
  const loadedScope = useRef<typeof scope.current | null>(null);
  const activeAction = useRef<object | null>(null);
  const request = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current += 1; };
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    const identity = scope.current;
    const revision = ++request.current;
    const current = () => mounted.current && scope.current === identity && request.current === revision;
    if (!quiet) setLoading(true);
    try {
      const [repository, branchList, diff] = await Promise.allSettled([
        desktop.git.status(), desktop.git.branches(), desktop.git.diffStats(),
      ]);
      if (!current()) return;
      const repositoryValue = repository.status === 'fulfilled' ? repository.value : null;
      const branchValue = branchList.status === 'fulfilled' ? branchList.value : null;
      const diffValue = diff.status === 'fulfilled' ? diff.value : null;
      const missingRepo = repositoryValue?.ok === false && repositoryValue.notRepo === true;
      setStatus(repositoryValue?.ok ? repositoryValue : null);
      // A missing repository is a loaded scope, not a broken one: `git init`
      // must be allowed to run here, and runAction refuses operations while the
      // loaded scope is unknown.
      loadedScope.current = repositoryValue && (repositoryValue.ok || missingRepo) ? identity : null;
      setBranches(branchValue?.ok ? branchValue : null);
      setStats(diffValue?.ok ? diffValue : null);
      setNotRepo(missingRepo);
      // With no repository there are no branches and no diff to report either;
      // the empty state says everything, so those must not become error banners.
      const issues = missingRepo ? [] : [
        !repositoryValue?.ok ? repositoryValue?.error || (repository.status === 'rejected' ? String(repository.reason) : '无法读取 Git 状态') : '',
        !branchValue?.ok ? '分支列表暂不可用' : '',
        !diffValue?.ok ? '增删行统计暂不可用' : '',
      ].filter(Boolean);
      setError(issues.join('；') || null);
    } catch (failure) {
      if (current()) {
        loadedScope.current = null;
        setStatus(null);
        setNotRepo(false);
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      if (current()) setLoading(false);
    }
  }, [workspaceRoot]);

  useEffect(() => {
    loadedScope.current = null;
    activeAction.current = null;
    setPending(null); setNotice(null); setError(null);
    setStatus(null); setBranches(null); setStats(null);
    setNotRepo(false);
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (error || !status) return;
    const timer = setInterval(() => { if (!activeAction.current) void refresh(true); }, 8000);
    return () => clearInterval(timer);
  }, [refresh, error, Boolean(status)]);

  async function runAction<Result extends GitResult>(label: string, operation: () => Promise<Result>, success: (result: Result) => string): Promise<Result | null> {
    if (activeAction.current || loading || loadedScope.current !== scope.current) return null;
    const identity = scope.current;
    const action = {};
    request.current += 1;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    activeAction.current = action;
    setPending(label); setError(null); setNotice(null);
    const current = () => mounted.current && scope.current === identity;
    try {
      const result = await operation();
      if (!current()) return null;
      if (!result.ok) throw new Error(result.error || '操作未完成');
      await refresh();
      if (!current()) return null;
      setNotice(success(result));
      return result;
    } catch (failure) {
      if (current()) setError(`${label}失败：${failure instanceof Error ? failure.message : String(failure)}`);
      return null;
    } finally {
      if (activeAction.current === action) {
        activeAction.current = null;
        if (current()) {
          setPending(null);
          requestAnimationFrame(() => {
            if (!current() || activeAction.current || !previousFocus?.isConnected || previousFocus.matches(':disabled')) return;
            const focused = document.activeElement;
            if (focused === document.body || (focused instanceof HTMLElement && focused.getAttribute('aria-modal') === 'true' && focused.contains(previousFocus))) previousFocus.focus();
          });
        }
      }
    }
  }

  return { status, branches, stats, loading, error, notice, pending, refresh, runAction,
    notRepo,
    disabled: loading || pending !== null || loadedScope.current !== scope.current,
    clearError: () => setError(null) };
}
