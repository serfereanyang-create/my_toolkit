import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import {
  decideApproval,
  isAutoAllowedWrite,
  pathScopeFor,
  resolveReadablePath,
  resolveWorkspacePath,
} from '../src/safety/policy.js';
import type { ApprovalMode } from '../src/providers/types.js';

/*
 * 审批模式是唯一的沙箱分级旋钮：它同时决定确认频率和可及的文件范围。
 *
 * 这两件事过去是分开的——`--approval` 会传给 CLI，而桌面端的「沙箱模式」从不
 * 传给 CLI，只在主进程里替用户自动回答审批。于是「完全访问」这个名字只减少了
 * 确认次数，并没有给出它承诺的访问范围：一个标签在说谎。
 *
 * 本文件把分级矩阵钉死：四档 × 读/写 × 区内/区外。
 */

/** A path that is outside the workspace AND outside every read allow root. */
const OUTSIDE = 'D:/__tier_probe__/file.txt';

test('pathScopeFor: only 完全访问 widens the file scope', () => {
  assert.equal(pathScopeFor('auto'), 'unrestricted', 'auto 是 UI 里的「完全访问」');
  for (const mode of ['ask', 'plan', 'deny'] as ApprovalMode[]) {
    assert.equal(pathScopeFor(mode), 'workspace', `${mode} must stay confined`);
  }
});

test('read: only 完全访问 reaches outside every allow root', () => {
  const ws = 'C:/work/app';
  const inside = resolveReadablePath(ws, 'note.md', pathScopeFor('auto'));
  assert.equal(inside, resolveReadablePath(ws, 'note.md', pathScopeFor('ask')));

  // 完全访问 reads it; every other mode refuses.
  assert.equal(resolveReadablePath(ws, OUTSIDE, pathScopeFor('auto')), resolveReadablePath(ws, OUTSIDE, 'unrestricted'));
  for (const mode of ['ask', 'plan', 'deny'] as ApprovalMode[]) {
    assert.throws(() => resolveReadablePath(ws, OUTSIDE, pathScopeFor(mode)), /not allowed for read|Path escapes workspace/);
  }
});

test('write: only 完全访问 reaches outside every allow root', () => {
  const ws = 'C:/work/app';
  assert.equal(resolveWorkspacePath(ws, OUTSIDE, pathScopeFor('auto')), resolveWorkspacePath(ws, OUTSIDE, 'unrestricted'));
  for (const mode of ['ask', 'plan', 'deny'] as ApprovalMode[]) {
    assert.throws(() => resolveWorkspacePath(ws, OUTSIDE, pathScopeFor(mode)), /Path escapes workspace/);
  }
});

test('a desktop document stays readable in every mode', () => {
  // The read allowlist is behaviour users already rely on (reading a Desktop
  // docx), so narrowing it in the non-auto modes would be a silent regression.
  const ws = 'C:/work/app';
  const doc = join(homedir(), 'Desktop', 'note.docx');
  for (const mode of ['ask', 'plan', 'deny', 'auto'] as ApprovalMode[]) {
    assert.equal(resolveReadablePath(ws, doc, pathScopeFor(mode)), doc, `${mode} must still read Desktop`);
  }
});

test('decideApproval lets 完全访问 write outside, and denies it elsewhere', () => {
  const ws = 'C:/work/app';
  const auto = decideApproval({ mode: 'auto', risk: 'write', workspaceRoot: ws, targetPath: OUTSIDE });
  assert.equal(auto.allowed, true);
  assert.equal(auto.needsPrompt, false);

  // ask mode prompts rather than silently allowing.
  const ask = decideApproval({ mode: 'ask', risk: 'write', workspaceRoot: ws, targetPath: OUTSIDE });
  assert.equal(ask.needsPrompt, true);

  // deny mode refuses outright.
  const deny = decideApproval({ mode: 'deny', risk: 'write', workspaceRoot: ws, targetPath: OUTSIDE });
  assert.equal(deny.allowed, false);
});

test('完全访问 still refuses the workspace’s own protected internals', () => {
  // .git/ and node_modules/ are not a system-directory blocklist: writing them
  // corrupts the user's repository, so they stay protected in every mode.
  const ws = 'C:/work/app';
  assert.equal(isAutoAllowedWrite(ws, '.git/config', 'unrestricted'), false);
  assert.equal(isAutoAllowedWrite(ws, 'node_modules/pkg/index.js', 'unrestricted'), false);
  // …but a normal file outside the workspace is fine.
  assert.equal(isAutoAllowedWrite(ws, OUTSIDE, 'unrestricted'), true);
});

test('create_xlsx resolves through the shared policy, not the raw input', async () => {
  // It used to do `isAbsolute(p) ? resolve(p) : join(root, p)` with no policy
  // call at all. That was reachable only once the approval layer let the call
  // through — i.e. on the desktop, where the user clicks 允许 — and it then
  // wrote wherever the raw input pointed, in any approval mode.
  //
  // Two assertions, because the end-to-end one alone is not trustworthy: on
  // this machine D:\ happens to be unwritable, so the old code fails for an
  // environmental reason and a filesystem-only check would pass either way.
  // The first assertion pins the contract the tool must honour regardless of
  // what the filesystem allows.
  const dir = await mkdtemp(join(tmpdir(), 'tier-xlsx-'));
  const registry = createDefaultToolRegistry();
  const sheet = { name: 'S', headers: ['a'], rows: [['1']] };
  const approveAll = async (_message: string) => true as const;

  try {
    // Contract: the tool must route through the resolver, so a confined scope
    // cannot produce an outside target — whatever the caller approved.
    assert.throws(
      () => resolveWorkspacePath(dir, OUTSIDE, pathScopeFor('ask')),
      /Path escapes workspace/,
      'a confined scope must not yield an outside target for the tool to write',
    );

    // End-to-end: approved but confined → refused, and nothing lands outside.
    const escaped = await registry.execute(
      'create_xlsx',
      { path: OUTSIDE, sheets: [sheet] },
      { workspaceRoot: dir, approval: 'ask', confirm: approveAll },
    );
    assert.equal(escaped.ok, false, 'confined scope must refuse an outside target even when approved');
    assert.equal(await stat(OUTSIDE).then(() => true, () => false), false, 'nothing may be written outside');

    // Same call in 完全访问: allowed, and it lands on the resolved path.
    const outside = join(dir, '..', `__tier_xlsx_out_${Date.now()}.xlsx`);
    const allowed = await registry.execute(
      'create_xlsx',
      { path: outside, sheets: [sheet] },
      { workspaceRoot: dir, approval: 'auto' },
    );
    assert.equal(allowed.ok, true, allowed.output);
    assert.equal(await stat(outside).then(() => true, () => false), true);
    await rm(outside, { force: true });

    // Inside the workspace still works.
    const ok = await registry.execute(
      'create_xlsx',
      { path: 'book.xlsx', sheets: [sheet] },
      { workspaceRoot: dir, approval: 'auto' },
    );
    assert.equal(ok.ok, true, ok.output);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(OUTSIDE, { force: true });
  }
});
