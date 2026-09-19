/**
 * prDescription.ts — 从 unified diff 生成 PR 描述（纯文本，无执行）。
 *
 * 聚合变更文件（按目录/动作）、conventional 提交类型推断、破坏性变更标记、
 * 测试与文档信号，产出 markdown 正文骨架。配合 review_pr 使用。
 */

import type { FileDiff } from './diffModel.js';
import { parseUnifiedDiff } from './diffModel.js';

export interface PrDescriptionInput {
  diffA: string;
  branchName?: string;
  commits?: string[];
}

export interface PrDescription {
  title: string;
  conventionalType: string;
  breaking: boolean;
  summary: string[];
  impactDirs: Array<{ dir: string; files: number; added: number; removed: number }>;
  addedFiles: string[];
  deletedFiles: string[];
  renamedFiles: string[];
  testFiles: string[];
  docFiles: string[];
  checklist: string[];
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx > 0 ? path.slice(0, idx) : '.';
}

function baseTitle(branch?: string, commits?: string[]): string {
  if (commits && commits.length > 0) {
    // 取第一条非 merge/release 的 commit 标题
    const meaningful = commits.find((c) => !/^(merge|chore\(release\))/i.test(c));
    if (meaningful) return meaningful;
  }
  if (branch) return `从分支 ${branch} 合并的变更`;
  return '更新项目';
}

function classifyType(files: FileDiff[], title: string): string {
  const lower = title.toLowerCase();
  if (/fix|bug|crash|修复/.test(lower)) return 'fix';
  if (/docs|readme|注释|文档/.test(lower) && files.every((f) => /\.(md|txt)$/.test(f.path))) return 'docs';
  if (/refactor|重构/.test(lower)) return 'refactor';
  if (/test|spec|测试/.test(lower)) return 'test';
  if (/deps|package\.json|lock/.test(lower)) return 'chore(deps)';
  const added = files.filter((f) => f.kind === 'added').length;
  const total = files.length || 1;
  if (added / total > 0.5) return 'feat';
  return 'chore';
}

function looksBreaking(files: FileDiff[], commits: string[] | undefined): boolean {
  if (commits?.some((c) => /\bBREAKING\b/i.test(c) || /^[a-z]+(\([^)]+\))?!:/.test(c))) return true;
  // 删除文件 + 大量重命名视为破坏性信号
  const deleted = files.filter((f) => f.kind === 'deleted').length;
  const renamed = files.filter((f) => f.kind === 'renamed').length;
  return files.length > 0 && (deleted + renamed) / files.length > 0.4;
}

export function generatePrDescription(input: PrDescriptionInput): PrDescription {
  const parsed = parseUnifiedDiff(input.diffA);
  const files = parsed.files;
  const title = baseTitle(input.branchName, input.commits);

  const dirAgg = new Map<string, { files: number; added: number; removed: number }>();
  for (const f of files) {
    const dir = dirOf(f.path);
    const cur = dirAgg.get(dir) ?? { files: 0, added: 0, removed: 0 };
    cur.files += 1;
    cur.added += f.addedLines;
    cur.removed += f.removedLines;
    dirAgg.set(dir, cur);
  }
  const impactDirs = [...dirAgg.entries()]
    .map(([dir, v]) => ({ dir, ...v }))
    .sort((a, b) => b.files - a.files);

  const testFiles = files.filter((f) => /\.test\.|\.spec\.|^tests?\//.test(f.path)).map((f) => f.path);
  const docFiles = files.filter((f) => /\.(md|txt|rst)$/.test(f.path)).map((f) => f.path);

  const summary: string[] = [];
  if (files.length > 0) {
    const first = impactDirs[0];
    summary.push(`本 PR 修改 ${files.length} 个文件（+${parsed.totalAdded} / -${parsed.totalRemoved} 行），最集中的区域是 ${first ? first.dir : '未知'}`);
  } else {
    summary.push('当前 diff 中没有解析出文件变更。');
  }
  const deletes = files.filter((f) => f.kind === 'deleted');
  if (deletes.length > 0) summary.push(`包含 ${deletes.length} 个删除文件，注意确认引用已清理`);
  const creates = files.filter((f) => f.kind === 'added');
  if (creates.length > 0) summary.push(`新增 ${creates.length} 个文件`);

  const conventionalType = classifyType(files, title);
  const breaking = looksBreaking(files, input.commits);

  const checklist = [
    '所有自动化测试通过',
    '本地运行受影响模块并抽查行为',
    testFiles.length > 0 ? '测试变更已覆盖新增/修改逻辑' : '补充或更新测试（当前 diff 不含测试文件）',
    'CHANGELOG / 文档同步更新',
    '破坏性变更已标记并说明迁移方式',
    '关联 issue 与 reviewers 已指派',
  ];

  return {
    title: `${conventionalType}: ${title}`,
    conventionalType,
    breaking,
    summary,
    impactDirs,
    addedFiles: creates.map((f) => f.path),
    deletedFiles: deletes.map((f) => f.path),
    renamedFiles: files.filter((f) => f.kind === 'renamed').map((f) => `${f.oldPath} → ${f.path}`),
    testFiles,
    docFiles,
    checklist,
  };
}

/** 渲染为 PR 正文 markdown。 */
export function renderPrMarkdown(desc: PrDescription): string {
  const lines: string[] = [];
  lines.push(`## ${desc.title}`);
  lines.push('');
  if (desc.breaking) lines.push('> ⚠ **BREAKING CHANGE**：合并前请确认下游迁移方案。', '');
  lines.push('### 概述');
  for (const s of desc.summary) lines.push(`- ${s}`);
  if (desc.impactDirs.length > 0) {
    lines.push('', '### 影响面');
    for (const d of desc.impactDirs.slice(0, 15)) {
      lines.push(`- \`${d.dir}\`：${d.files} 个文件（+${d.added} / -${d.removed}）`);
    }
  }
  if (desc.renamedFiles.length > 0) {
    lines.push('', '### 重命名');
    for (const r of desc.renamedFiles.slice(0, 20)) lines.push(`- ${r}`);
  }
  if (desc.deletedFiles.length > 0) {
    lines.push('', '### 删除');
    for (const f of desc.deletedFiles.slice(0, 20)) lines.push(`- ${f}`);
  }
  if (desc.addedFiles.length > 0) {
    lines.push('', '### 新增');
    for (const f of desc.addedFiles.slice(0, 20)) lines.push(`- ${f}`);
  }
  lines.push('', '### 测试与验证', desc.testFiles.length > 0 ? `- 测试文件：${desc.testFiles.slice(0, 10).join(', ')}` : '- 本 PR 未附带测试文件变更，需人工补充验证说明', '');
  lines.push('### 自查清单');
  for (const c of desc.checklist) lines.push(`- [ ] ${c}`);
  return lines.join('\n');
}
