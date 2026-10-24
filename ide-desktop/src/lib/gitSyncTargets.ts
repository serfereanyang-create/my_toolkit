import type { GitBranchList, GitStatus } from './ipc';

export type GitSyncTarget = { remote: string; branch: string; localBranch: string };
export type GitSyncPlan = {
  remotes: string[];
  push?: GitSyncTarget;
  pull?: GitSyncTarget;
  publish: boolean;
  pushReason?: string;
  pullReason?: string;
};

export function resolveGitSyncTargets(status: GitStatus | null, branches: GitBranchList | null, override = ''): GitSyncPlan {
  const sync = branches?.sync;
  const remotes = [...(sync?.remotes ?? [])];
  if ((sync?.tracking?.remote === '.' || sync?.pushDefault === '.') && !remotes.includes('.')) remotes.push('.');
  const unavailable = (reason: string): GitSyncPlan => ({ remotes, publish: false, pushReason: reason, pullReason: reason });
  if (!status?.ok || !status.branch) return unavailable('仓库状态不可用');
  if (status.unborn) return unavailable('完成首次提交后即可同步');
  if (status.detached || status.branch === 'HEAD') return unavailable('请先切换或创建本地分支');
  if (!sync || !branches?.ok) return unavailable('同步目标暂不可用，请刷新');
  if (branches.current && branches.current !== status.branch) return unavailable('分支状态已变化，请刷新');
  if (override && !remotes.includes(override)) return unavailable('所选远程已不存在，请重新选择');
  if (!remotes.length) return unavailable('尚未配置远程仓库');
  const single = remotes.length === 1 ? remotes[0] : undefined;
  const pushRemote = override || (sync.invalidPushDefault ? undefined : sync.pushDefault || sync.tracking?.remote || (sync.invalidTracking ? undefined : single));
  const pullRemote = override || (sync.invalidTracking ? undefined : sync.tracking?.remote || single);
  const target = (remote: string): GitSyncTarget => ({ remote, branch: remote === sync.tracking?.remote ? sync.tracking.branch : status.branch!, localBranch: status.branch! });
  return {
    remotes,
    push: pushRemote ? target(pushRemote) : undefined,
    pull: pullRemote && !status.hasConflicts ? target(pullRemote) : undefined,
    publish: Boolean(pushRemote && !sync.tracking && !sync.invalidTracking),
    pushReason: pushRemote ? undefined : sync.invalidPushDefault ? '默认推送远程不可用，请选择目标' : sync.invalidTracking ? '追踪配置不可用，请选择目标' : '请选择远程仓库',
    pullReason: status.hasConflicts ? '请先解决合并冲突再拉取' : pullRemote ? undefined : sync.invalidTracking ? '追踪配置不可用，请选择目标' : '请选择远程仓库',
  };
}

export function gitSyncTargetLabel(target?: GitSyncTarget): string {
  return target ? `${target.remote === '.' ? '本地' : target.remote}/${target.branch}` : '未配置';
}
