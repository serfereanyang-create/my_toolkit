/**
 * commitLint.ts — Conventional Commits 标题规范校验（纯函数）。
 *
 * 规则：type(scope)!: subject —— type 白名单、scope 小写、subject 非空、
 * 首字母不大写（可选）、长度建议、BREAKING 一致性（! 与 BREAKING FOOTER）。
 * 输出每条问题（级别/建议），供 git_commit 前置检查与仓库历史审计。
 */

export type LintLevel = 'error' | 'warning' | 'info';

export interface LintIssue {
  level: LintLevel;
  rule: string;
  message: string;
}

export interface ParsedHeader {
  valid: boolean;
  type?: string;
  scope?: string;
  breakingFlag?: boolean;
  subject?: string;
}

export interface CommitLintResult {
  header: string;
  ok: boolean;
  issues: LintIssue[];
  parsed: ParsedHeader;
}

export const CONVENTIONAL_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];

/** 解析标题：`type(scope)!: subject`。无括号冒号结构 → invalid。 */
export function parseHeader(header: string): ParsedHeader {
  const colon = header.indexOf(':');
  if (colon <= 0) return { valid: false };
  let prefix = header.slice(0, colon);
  let scope: string | undefined;
  let breakingFlag = false;
  if (prefix.endsWith('!')) {
    breakingFlag = true;
    prefix = prefix.slice(0, -1);
  }
  const open = prefix.indexOf('(');
  let type = prefix;
  if (open >= 0 && prefix.endsWith(')')) {
    type = prefix.slice(0, open);
    scope = prefix.slice(open + 1, -1);
  }
  const subject = header.slice(colon + 1).trim();
  if (!type || !/^[a-z][a-z0-9-]*$/.test(type)) return { valid: false, type, scope, breakingFlag, subject };
  return { valid: true, type, scope, breakingFlag, subject };
}

/** 校验单条标题。 */
export function lintSubjectLine(subject: string): LintIssue[] {
  const issues: LintIssue[] = [];
  if (!subject) {
    issues.push({ level: 'error', rule: 'subject-empty', message: '冒号后缺少描述内容' });
    return issues;
  }
  if (subject.length < 5) {
    issues.push({ level: 'warning', rule: 'subject-too-short', message: `描述过短（${subject.length} 字符），建议说明改了什么/为什么` });
  }
  if (subject.length > 72) {
    issues.push({ level: 'warning', rule: 'subject-too-long', message: `描述过长（${subject.length} 字符），建议拆到正文` });
  }
  if (/[。\.]$/.test(subject)) {
    issues.push({ level: 'info', rule: 'no-trailing-period', message: '描述末尾不需要句号' });
  }
  const first = subject.charAt(0);
  if (first >= 'A' && first <= 'Z') {
    issues.push({ level: 'info', rule: 'lowercase-subject', message: '建议描述首字母小写（保持历史一致）' });
  }
  return issues;
}

/** 校验一条 commit 标题（含可选 BREAKING footer 一致性）。 */
export function lintCommitMessage(title: string, body?: string): CommitLintResult {
  const parsed = parseHeader(title);
  const issues: LintIssue[] = [];
  if (!parsed.valid || !parsed.type) {
    issues.push({ level: 'error', rule: 'header-format', message: '不符合 type(scope)!: subject 格式（例如 feat(auth): 支持扫码登录）' });
    return { header: title, ok: false, issues, parsed };
  }
  if (!CONVENTIONAL_TYPES.includes(parsed.type)) {
    issues.push({ level: 'error', rule: 'type-unknown', message: `未知 type "${parsed.type}"，可选：${CONVENTIONAL_TYPES.join(', ')}` });
  }
  if (parsed.scope !== undefined) {
    if (!parsed.scope) {
      issues.push({ level: 'error', rule: 'scope-empty', message: '括号里缺少 scope 内容' });
    } else if (/[A-Z_ ]/.test(parsed.scope)) {
      issues.push({ level: 'warning', rule: 'scope-style', message: `scope "${parsed.scope}" 建议小写短横线（如 auth）` });
    }
  }
  if (!parsed.subject || parsed.subject.length === 0) {
    issues.push({ level: 'error', rule: 'subject-empty', message: '冒号后缺少描述内容' });
  } else {
    issues.push(...lintSubjectLine(parsed.subject));
  }
  // BREAKING 一致性：标题带 ! 或 footer 含 BREAKING CHANGE 视为破坏性
  const breakingFooter = /\bBREAKING[ -]CHANGE\b/i.test(body ?? '');
  if (parsed.breakingFlag && !breakingFooter) {
    issues.push({ level: 'warning', rule: 'breaking-missing', message: '标题带 ! 但正文缺少 BREAKING CHANGE: 说明' });
  }
  if (!parsed.breakingFlag && breakingFooter && parsed.type && ['feat', 'fix'].includes(parsed.type)) {
    issues.push({ level: 'info', rule: 'breaking-flag', message: `正文声明了破坏性变更，建议标题改为 ${parsed.type}(...)! 便于解析` });
  }
  return { header: title, ok: !issues.some((i) => i.level === 'error'), issues, parsed };
}

/** 批量校验（历史审计入口，取最近 N 条标题）。 */
export function lintHistory(titles: string[]): { results: CommitLintResult[]; errorCount: number; warningCount: number } {
  const results = titles.map((title) => lintCommitMessage(title));
  let errorCount = 0;
  let warningCount = 0;
  for (const r of results) {
    for (const i of r.issues) {
      if (i.level === 'error') errorCount += 1;
      else if (i.level === 'warning') warningCount += 1;
    }
  }
  return { results, errorCount, warningCount };
}
