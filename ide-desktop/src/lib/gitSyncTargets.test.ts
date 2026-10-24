import { describe, expect, it } from 'vitest';
import type { GitBranchList, GitStatus } from './ipc';
import { resolveGitSyncTargets } from './gitSyncTargets';

const status: GitStatus = { ok: true, branch: 'local', upstream: 'team/release' };
const branches: GitBranchList = { ok: true, current: 'local', sync: { remotes: ['team', 'backup'], tracking: { remote: 'team', branch: 'release' }, pushDefault: 'team' } };
describe('Git sync targets', () => {
  it('uses the real tracking branch rather than origin and the local branch name', () => {
    const result = resolveGitSyncTargets(status, branches);
    expect(result.push).toEqual({ remote: 'team', branch: 'release', localBranch: 'local' });
    expect(result.pull).toEqual(result.push);
    expect(result.publish).toBe(false);
  });
  it('keeps a preferred push remote separate from the pull upstream', () => {
    const result = resolveGitSyncTargets(status, { ...branches, sync: { ...branches.sync!, pushDefault: 'backup' } });
    expect(result.push?.remote).toBe('backup');
    expect(result.push?.branch).toBe('local');
    expect(result.pull?.remote).toBe('team');
    expect(result.pull?.branch).toBe('release');
  });
  it('requires a choice when multiple remotes have no configured target', () => {
    const result = resolveGitSyncTargets(status, { ...branches, sync: { remotes: ['team', 'backup'], tracking: null, pushDefault: null } });
    expect(result.push).toBeUndefined();
    expect(result.pull).toBeUndefined();
    expect(result.pushReason).toContain('选择');
  });
  it('publishes a first upstream only to a selected or sole remote', () => {
    const result = resolveGitSyncTargets(status, { ...branches, sync: { remotes: ['team'], tracking: null, pushDefault: null } });
    expect(result.publish).toBe(true);
    expect(result.push?.remote).toBe('team');
  });
  it('an explicit backup choice does not request an upstream rewrite', () => {
    const result = resolveGitSyncTargets(status, branches, 'backup');
    expect(result.push?.branch).toBe('local');
    expect(result.pull?.remote).toBe('backup');
    expect(result.publish).toBe(false);
  });
  it('never silently falls back after a selected remote is removed', () => {
    const result = resolveGitSyncTargets(status, branches, 'removed');
    expect(result.push).toBeUndefined();
    expect(result.pushReason).toContain('已不存在');
  });
  it('separately blocks an invalid automatic push preference', () => {
    const result = resolveGitSyncTargets(status, { ...branches, sync: { ...branches.sync!, invalidPushDefault: true } });
    expect(result.push).toBeUndefined();
    expect(result.pull?.remote).toBe('team');
  });
  it('shows no-remote state and blocks detached or unborn branches', () => {
    expect(resolveGitSyncTargets(status, { ...branches, sync: { remotes: [], tracking: null, pushDefault: null } }).pushReason).toContain('尚未配置');
    expect(resolveGitSyncTargets({ ...status, unborn: true }, branches).push).toBeUndefined();
    expect(resolveGitSyncTargets({ ...status, detached: true }, branches).pull).toBeUndefined();
  });
  it('requires consistent branch metadata before executing a sync', () => {
    expect(resolveGitSyncTargets(status, { ...branches, current: 'other' }).pushReason).toContain('分支状态已变化');
  });
  it('does not let a pull start over unresolved conflicts', () => {
    const result = resolveGitSyncTargets({ ...status, hasConflicts: true }, branches);
    expect(result.pull).toBeUndefined();
    expect(result.push).toBeDefined();
  });
});
