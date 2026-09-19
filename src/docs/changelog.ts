/**
 * changelog.ts — Changelog 生成器
 * 
 * 基于 Git 提交历史自动生成 Changelog
 * - 解析 Conventional Commits
 * - 分组和分类
 * - 生成 Markdown 格式
 * - 版本号推荐
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * 提交类型
 */
export type CommitType = 
  | 'feat'        // 新功能
  | 'fix'         // 修复
  | 'docs'        // 文档
  | 'style'       // 格式
  | 'refactor'    // 重构
  | 'perf'        // 性能
  | 'test'        // 测试
  | 'build'       // 构建
  | 'ci'          // CI/CD
  | 'chore'       // 其他
  | 'revert';     // 回滚

/**
 * 解析的提交信息
 */
export interface ParsedCommit {
  hash: string;
  type: CommitType;
  scope?: string;
  subject: string;
  body?: string;
  breaking: boolean;
  closes?: string[];
  date: Date;
  author: string;
}

/**
 * 版本变更
 */
export interface VersionChange {
  version: string;
  date: Date;
  commits: ParsedCommit[];
  breaking: ParsedCommit[];
}

/**
 * Changelog 配置
 */
export interface ChangelogOptions {
  /** 起始标签 */
  from?: string;
  /** 结束标签 */
  to?: string;
  /** 是否包含所有提交（非 Conventional Commits） */
  includeAll?: boolean;
  /** 是否按作者分组 */
  groupByAuthor?: boolean;
}

/**
 * 解析 Conventional Commit 消息
 */
export function parseConventionalCommit(message: string): Partial<ParsedCommit> | null {
  // 格式: type(scope): subject
  const match = message.match(/^(\w+)(?:\(([^)]+)\))?: (.+)$/);
  
  if (!match) return null;
  
  const [, type, scope, subject] = match;
  
  // 检查是否是有效的类型
  const validTypes: CommitType[] = [
    'feat', 'fix', 'docs', 'style', 'refactor', 
    'perf', 'test', 'build', 'ci', 'chore', 'revert'
  ];
  
  if (!validTypes.includes(type as CommitType)) {
    return null;
  }
  
  const breaking = subject.startsWith('!') || message.includes('BREAKING CHANGE');
  
  return {
    type: type as CommitType,
    scope,
    subject: subject.replace(/^!/, '').trim(),
    breaking,
  };
}

/**
 * 获取 Git 提交历史
 */
export async function getGitCommits(
  workspaceRoot: string,
  options: ChangelogOptions = {}
): Promise<ParsedCommit[]> {
  const { from, to = 'HEAD' } = options;
  
  // 构建 git log 命令
  const range = from ? `${from}..${to}` : to;
  const format = '%H|%s|%b|%an|%aI'; // hash|subject|body|author|date
  
  const command = `git log ${range} --pretty=format:"${format}" --no-merges`;
  
  try {
    const { stdout } = await execAsync(command, { cwd: workspaceRoot });
    
    if (!stdout.trim()) {
      return [];
    }
    
    const commits: ParsedCommit[] = [];
    const lines = stdout.trim().split('\n');
    
    for (const line of lines) {
      const [hash, subject, body, author, dateStr] = line.split('|');
      
      const parsed = parseConventionalCommit(subject);
      
      if (!parsed && !options.includeAll) {
        continue; // 跳过非 Conventional Commits
      }
      
      // 提取 closes 引用
      const closes: string[] = [];
      const closesMatch = (subject + ' ' + body).matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi);
      for (const match of closesMatch) {
        closes.push(`#${match[1]}`);
      }
      
      commits.push({
        hash: hash.substring(0, 7),
        type: parsed?.type || 'chore',
        scope: parsed?.scope,
        subject: parsed?.subject || subject,
        body: body || undefined,
        breaking: parsed?.breaking || false,
        closes: closes.length > 0 ? closes : undefined,
        date: new Date(dateStr),
        author,
      });
    }
    
    return commits;
  } catch (error) {
    throw new Error(`获取 Git 提交失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 按版本分组提交
 */
export async function groupCommitsByVersion(
  workspaceRoot: string
): Promise<VersionChange[]> {
  try {
    // 获取所有标签
    const { stdout: tagsOutput } = await execAsync(
      'git tag --sort=-creatordate',
      { cwd: workspaceRoot }
    );
    
    const tags = tagsOutput.trim().split('\n').filter(Boolean);
    
    const versions: VersionChange[] = [];
    
    for (let i = 0; i < tags.length; i++) {
      const currentTag = tags[i];
      const previousTag = tags[i + 1];
      
      const commits = await getGitCommits(workspaceRoot, {
        from: previousTag,
        to: currentTag,
      });
      
      // 获取标签日期
      const { stdout: dateOutput } = await execAsync(
        `git log -1 --format=%aI ${currentTag}`,
        { cwd: workspaceRoot }
      );
      
      versions.push({
        version: currentTag,
        date: new Date(dateOutput.trim()),
        commits,
        breaking: commits.filter(c => c.breaking),
      });
    }
    
    // 未发布的提交
    if (tags.length > 0) {
      const unreleased = await getGitCommits(workspaceRoot, {
        from: tags[0],
        to: 'HEAD',
      });
      
      if (unreleased.length > 0) {
        versions.unshift({
          version: 'Unreleased',
          date: new Date(),
          commits: unreleased,
          breaking: unreleased.filter(c => c.breaking),
        });
      }
    }
    
    return versions;
  } catch (error) {
    throw new Error(`分组版本失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 生成 Changelog
 */
export function generateChangelog(versions: VersionChange[]): string {
  const lines: string[] = [];
  
  lines.push('# Changelog\n');
  lines.push('所有显著的变更都会记录在此文件中。\n');
  lines.push('本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。\n');
  
  for (const version of versions) {
    const dateStr = version.date.toISOString().split('T')[0];
    
    if (version.version === 'Unreleased') {
      lines.push(`## [${version.version}]\n`);
    } else {
      lines.push(`## [${version.version}] - ${dateStr}\n`);
    }
    
    // Breaking Changes
    if (version.breaking.length > 0) {
      lines.push('### ⚠️ BREAKING CHANGES\n');
      for (const commit of version.breaking) {
        lines.push(`- ${commit.subject} ([${commit.hash}])`);
      }
      lines.push('');
    }
    
    // 按类型分组
    const byType = new Map<CommitType, ParsedCommit[]>();
    
    for (const commit of version.commits) {
      if (!byType.has(commit.type)) {
        byType.set(commit.type, []);
      }
      byType.get(commit.type)!.push(commit);
    }
    
    // 功能
    if (byType.has('feat')) {
      lines.push('### ✨ 新功能\n');
      for (const commit of byType.get('feat')!) {
        const scopeText = commit.scope ? `**${commit.scope}**: ` : '';
        const closesText = commit.closes ? ` (${commit.closes.join(', ')})` : '';
        lines.push(`- ${scopeText}${commit.subject} ([${commit.hash}])${closesText}`);
      }
      lines.push('');
    }
    
    // 修复
    if (byType.has('fix')) {
      lines.push('### 🐛 Bug 修复\n');
      for (const commit of byType.get('fix')!) {
        const scopeText = commit.scope ? `**${commit.scope}**: ` : '';
        const closesText = commit.closes ? ` (${commit.closes.join(', ')})` : '';
        lines.push(`- ${scopeText}${commit.subject} ([${commit.hash}])${closesText}`);
      }
      lines.push('');
    }
    
    // 性能优化
    if (byType.has('perf')) {
      lines.push('### ⚡ 性能优化\n');
      for (const commit of byType.get('perf')!) {
        const scopeText = commit.scope ? `**${commit.scope}**: ` : '';
        lines.push(`- ${scopeText}${commit.subject} ([${commit.hash}])`);
      }
      lines.push('');
    }
    
    // 重构
    if (byType.has('refactor')) {
      lines.push('### ♻️ 代码重构\n');
      for (const commit of byType.get('refactor')!) {
        const scopeText = commit.scope ? `**${commit.scope}**: ` : '';
        lines.push(`- ${scopeText}${commit.subject} ([${commit.hash}])`);
      }
      lines.push('');
    }
    
    // 文档
    if (byType.has('docs')) {
      lines.push('### 📝 文档\n');
      for (const commit of byType.get('docs')!) {
        lines.push(`- ${commit.subject} ([${commit.hash}])`);
      }
      lines.push('');
    }
    
    // 其他
    const otherTypes: CommitType[] = ['style', 'test', 'build', 'ci', 'chore'];
    const otherCommits = otherTypes.flatMap(type => byType.get(type) || []);
    
    if (otherCommits.length > 0) {
      lines.push('### 🔧 其他变更\n');
      for (const commit of otherCommits) {
        const scopeText = commit.scope ? `**${commit.scope}**: ` : '';
        lines.push(`- [${commit.type}] ${scopeText}${commit.subject} ([${commit.hash}])`);
      }
      lines.push('');
    }
  }
  
  return lines.join('\n');
}

/**
 * 推荐下一个版本号（Semantic Versioning）
 */
export function recommendNextVersion(
  currentVersion: string,
  commits: ParsedCommit[]
): string {
  const match = currentVersion.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  
  if (!match) {
    return '1.0.0';
  }
  
  let [, major, minor, patch] = match.map(Number);
  
  // 检查是否有 breaking changes
  const hasBreaking = commits.some(c => c.breaking);
  if (hasBreaking) {
    return `${major + 1}.0.0`;
  }
  
  // 检查是否有新功能
  const hasFeat = commits.some(c => c.type === 'feat');
  if (hasFeat) {
    return `${major}.${minor + 1}.0`;
  }
  
  // 仅修复或其他变更
  const hasFix = commits.some(c => c.type === 'fix');
  if (hasFix) {
    return `${major}.${minor}.${patch + 1}`;
  }
  
  // 没有显著变更
  return currentVersion;
}

/**
 * 生成发布说明
 */
export function generateReleaseNotes(
  version: string,
  commits: ParsedCommit[]
): string {
  const lines: string[] = [];
  
  lines.push(`# Release ${version}\n`);
  
  // 统计
  const featCount = commits.filter(c => c.type === 'feat').length;
  const fixCount = commits.filter(c => c.type === 'fix').length;
  const breakingCount = commits.filter(c => c.breaking).length;
  
  lines.push('## 📊 本次发布统计\n');
  lines.push(`- ✨ 新功能: ${featCount}`);
  lines.push(`- 🐛 Bug 修复: ${fixCount}`);
  lines.push(`- ⚠️ Breaking Changes: ${breakingCount}`);
  lines.push(`- 📝 总提交数: ${commits.length}\n`);
  
  // Breaking Changes
  const breaking = commits.filter(c => c.breaking);
  if (breaking.length > 0) {
    lines.push('## ⚠️ Breaking Changes\n');
    for (const commit of breaking) {
      lines.push(`- ${commit.subject}`);
      if (commit.body) {
        lines.push(`  ${commit.body}`);
      }
    }
    lines.push('');
  }
  
  // 主要功能
  const features = commits.filter(c => c.type === 'feat');
  if (features.length > 0) {
    lines.push('## ✨ 新功能\n');
    for (const commit of features.slice(0, 10)) {
      const scopeText = commit.scope ? `**${commit.scope}**: ` : '';
      lines.push(`- ${scopeText}${commit.subject}`);
    }
    if (features.length > 10) {
      lines.push(`- ... 还有 ${features.length - 10} 个新功能`);
    }
    lines.push('');
  }
  
  // Bug 修复
  const fixes = commits.filter(c => c.type === 'fix');
  if (fixes.length > 0) {
    lines.push('## 🐛 Bug 修复\n');
    for (const commit of fixes.slice(0, 10)) {
      const scopeText = commit.scope ? `**${commit.scope}**: ` : '';
      const closesText = commit.closes ? ` (${commit.closes.join(', ')})` : '';
      lines.push(`- ${scopeText}${commit.subject}${closesText}`);
    }
    if (fixes.length > 10) {
      lines.push(`- ... 还有 ${fixes.length - 10} 个修复`);
    }
    lines.push('');
  }
  
  // 贡献者
  const authors = new Set(commits.map(c => c.author));
  lines.push(`## 👥 贡献者 (${authors.size})\n`);
  lines.push('感谢以下贡献者的付出：\n');
  for (const author of authors) {
    const authorCommits = commits.filter(c => c.author === author);
    lines.push(`- ${author} (${authorCommits.length} 个提交)`);
  }
  lines.push('');
  
  lines.push('---\n');
  lines.push('完整变更日志请查看 [CHANGELOG.md](CHANGELOG.md)\n');
  
  return lines.join('\n');
}
