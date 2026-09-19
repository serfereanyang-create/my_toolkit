/**
 * versionBump.ts — 基于 conventional 提交历史的语义化版本建议 + CHANGELOG 草稿。
 *
 * 纯函数：输入 (currentVersion, titles[])，输出 bump 类型（major/minor/patch）、
 * 建议下一版本、按 type 分组的 CHANGELOG 草稿。与 changelog 生成器互补：
 * 这里聚焦"该升哪个号"的决策依据。
 */

export type BumpKind = 'major' | 'minor' | 'patch' | 'none';

export interface VersionParts {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

export interface BumpDecision {
  current: string;
  suggested: string;
  bump: BumpKind;
  reasons: string[];
  counts: Record<string, number>;
  changelogDraft: Array<{ type: string; entries: string[] }>;
}

/** 解析 semver（支持尾随 -beta.1 等 prerelease 标记）。 */
export function parseVersion(raw: string): VersionParts | null {
  const text = raw.trim().replace(/^v/, '');
  const dash = text.indexOf('-');
  const core = dash >= 0 ? text.slice(0, dash) : text;
  const prerelease = dash >= 0 ? text.slice(dash + 1) : undefined;
  const parts = core.split('.');
  if (parts.length === 0 || parts.length > 3) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  const [major = 0, minor = 0, patch = 0] = nums;
  return { major, minor, patch, ...(prerelease ? { prerelease } : {}) };
}

export function formatVersion(v: VersionParts): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease ? `${base}-${v.prerelease}` : base;
}

/** 从 conventional 标题提取 type/scope/breaking。 */
interface ParsedCommit {
  type: string;
  scope?: string;
  breaking: boolean;
  subject: string;
}

export function parseConventionalTitle(title: string): ParsedCommit | null {
  const colon = title.indexOf(':');
  if (colon <= 0) return null;
  let prefix = title.slice(0, colon);
  let breaking = prefix.endsWith('!');
  if (breaking) prefix = prefix.slice(0, -1);
  const open = prefix.indexOf('(');
  let type = prefix;
  let scope: string | undefined;
  if (open >= 0 && prefix.endsWith(')')) {
    type = prefix.slice(0, open);
    scope = prefix.slice(open + 1, -1) || undefined;
  }
  if (!/^[a-z][a-z0-9-]*$/.test(type)) return null;
  const subject = title.slice(colon + 1).trim();
  if (!subject) return null;
  return { type, scope, breaking, subject };
}

/** 决策 bump 级别：breaking→major；feat→minor；其余→patch；全解析失败→none。 */
export function decideBump(titles: string[]): { bump: BumpKind; reasons: string[] } {
  const reasons: string[] = [];
  let hasBreaking = false;
  let hasFeat = false;
  let hasChange = false;
  for (const title of titles) {
    const parsed = parseConventionalTitle(title);
    if (!parsed) continue;
    hasChange = true;
    if (parsed.breaking) hasBreaking = true;
    if (parsed.type === 'feat') hasFeat = true;
  }
  if (!hasChange) return { bump: 'none', reasons: ['没有可解析的 conventional 提交'] };
  if (hasBreaking) {
    reasons.push('存在破坏性变更（! 标记或 BREAKING CHANGE）→ major');
    return { bump: 'major', reasons };
  }
  if (hasFeat) {
    reasons.push('存在 feat 提交 → minor');
    return { bump: 'minor', reasons };
  }
  reasons.push('仅修复/维护类提交 → patch');
  return { bump: 'patch', reasons };
}

/** 应用 bump 得到下一版本（patch/minor 归零规则按 semver；可选保留 prerelease 后缀）。 */
export function applyBump(current: VersionParts, bump: BumpKind, keepPrerelease = false): VersionParts {
  const base: VersionParts = { ...current, prerelease: undefined };
  let next: VersionParts;
  if (bump === 'major') next = { major: base.major + 1, minor: 0, patch: 0 };
  else if (bump === 'minor') next = { major: base.major, minor: base.minor + 1, patch: 0 };
  else if (bump === 'patch') next = { major: base.major, minor: base.minor, patch: base.patch + 1 };
  else next = base;
  if (keepPrerelease && current.prerelease && bump !== 'none') next.prerelease = current.prerelease;
  return next;
}

const CHANGELOG_GROUPS: Array<{ match: string[]; label: string }> = [
  { match: ['feat'], label: '✨ 新功能' },
  { match: ['fix'], label: '🐛 修复' },
  { match: ['perf'], label: '⚡ 性能' },
  { match: ['refactor'], label: '♻️ 重构' },
  { match: ['docs'], label: '📝 文档' },
  { match: ['test'], label: '✅ 测试' },
  { match: ['build', 'ci', 'chore', 'style', 'revert'], label: '🔧 维护' },
];

/** 生成完整决策：版本建议 + 分组 CHANGELOG 草稿。 */
export function planVersionBump(
  currentVersion: string,
  titles: string[],
  options: { keepPrerelease?: boolean } = {},
): BumpDecision {
  const parsedCurrent = parseVersion(currentVersion);
  const decision = decideBump(titles);
  const counts: Record<string, number> = {};
  const draftMap = new Map<string, string[]>();
  const breakingEntries: string[] = [];

  for (const title of titles) {
    const parsed = parseConventionalTitle(title);
    if (!parsed) continue;
    counts[parsed.type] = (counts[parsed.type] ?? 0) + 1;
    if (parsed.breaking) breakingEntries.push(`${parsed.subject}${parsed.scope ? ` (${parsed.scope})` : ''}`);
    const group = CHANGELOG_GROUPS.find((g) => g.match.includes(parsed.type));
    if (group) {
      const bucket = draftMap.get(group.label) ?? [];
      bucket.push(`- ${parsed.subject}${parsed.scope ? ` (**${parsed.scope}**)` : ''}`);
      draftMap.set(group.label, bucket);
    }
  }

  const changelogDraft: BumpDecision['changelogDraft'] = [];
  if (breakingEntries.length > 0) {
    changelogDraft.push({ type: '💥 BREAKING CHANGES', entries: breakingEntries.map((s) => `- ${s}`) });
  }
  for (const group of CHANGELOG_GROUPS) {
    const entries = draftMap.get(group.label);
    if (entries && entries.length > 0) changelogDraft.push({ type: group.label, entries });
  }

  if (!parsedCurrent) {
    return {
      current: currentVersion,
      suggested: currentVersion,
      bump: decision.bump,
      reasons: [...decision.reasons, `当前版本 "${currentVersion}" 不是合法 semver，未计算建议版本`],
      counts,
      changelogDraft,
    };
  }
  const next = applyBump(parsedCurrent, decision.bump, options.keepPrerelease === true);
  return {
    current: currentVersion,
    suggested: decision.bump === 'none' ? currentVersion : formatVersion(next),
    bump: decision.bump,
    reasons: decision.reasons,
    counts,
    changelogDraft,
  };
}

/** 渲染 markdown 报告（贴进 release PR）。 */
export function renderBumpReport(d: BumpDecision): string {
  const lines: string[] = [
    `## 版本建议：${d.current} → **${d.suggested}**`,
    '',
    `- bump: **${d.bump}**`,
  ];
  for (const r of d.reasons) lines.push(`- 依据: ${r}`);
  const countParts = Object.entries(d.counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`);
  if (countParts.length > 0) lines.push(`- 提交分布: ${countParts.join(' ')}`);
  if (d.changelogDraft.length > 0) {
    lines.push('', '### CHANGELOG 草稿', '');
    for (const section of d.changelogDraft) {
      lines.push(`#### ${section.type}`);
      for (const e of section.entries) lines.push(e);
      lines.push('');
    }
  }
  return lines.join('\n');
}
