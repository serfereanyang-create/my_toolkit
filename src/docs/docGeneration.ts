/**
 * docGeneration.ts — 文档生成核心逻辑
 *
 * 支持：
 *  - README 生成（项目概述、安装、使用、API、贡献）
 *  - API 文档生成（从 TSDoc/JSDoc 提取）
 *  - CHANGELOG 生成（从 git commits 推导）
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative, extname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as ts from 'typescript';
import { parseSourceFile } from '../analysis/parseCache.js';

const execFileAsync = promisify(execFile);

type ProjectMetadata = {
  name: string;
  description?: string;
  version?: string;
  license?: string;
  author?: string;
  repository?: string;
  homepage?: string;
  keywords?: string[];
};

/**
 * 从 package.json 读取项目元数据。
 */
export async function extractProjectMetadata(workspaceRoot: string): Promise<ProjectMetadata> {
  try {
    const pkgPath = join(workspaceRoot, 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>;
    return {
      name: typeof pkg.name === 'string' ? pkg.name : basename(workspaceRoot),
      description: typeof pkg.description === 'string' ? pkg.description : undefined,
      version: typeof pkg.version === 'string' ? pkg.version : undefined,
      license: typeof pkg.license === 'string' ? pkg.license : undefined,
      author: typeof pkg.author === 'string'
        ? pkg.author
        : typeof pkg.author === 'object' && pkg.author && typeof (pkg.author as { name?: unknown }).name === 'string'
          ? (pkg.author as { name: string }).name
          : undefined,
      repository: typeof pkg.repository === 'string'
        ? pkg.repository
        : typeof pkg.repository === 'object' && pkg.repository && typeof (pkg.repository as { url?: unknown }).url === 'string'
          ? (pkg.repository as { url: string }).url
          : undefined,
      homepage: typeof pkg.homepage === 'string' ? pkg.homepage : undefined,
      keywords: Array.isArray(pkg.keywords) ? pkg.keywords.filter((k): k is string => typeof k === 'string') : undefined,
    };
  } catch {
    return { name: basename(workspaceRoot) };
  }
}

type ApiEntry = {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const';
  signature: string;
  doc?: string;
  filePath: string;
};

/**
 * 提取 TSDoc/JSDoc 注释。
 */
function extractDocComment(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  const fullText = sourceFile.getFullText();
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
  if (!ranges || ranges.length === 0) return undefined;
  const lastComment = ranges[ranges.length - 1];
  const text = fullText.slice(lastComment.pos, lastComment.end);
  // 去掉 /** */ 包装和每行的前导 *
  return text
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * 从源文件提取导出的 API 实体。
 */
export async function extractApiEntries(filePath: string, workspaceRoot: string): Promise<ApiEntry[]> {
  const parsedFile = await parseSourceFile(filePath, workspaceRoot);
  if (!parsedFile) return [];
  const sourceFile: ts.SourceFile = parsedFile;
  const entries: ApiEntry[] = [];
  const relPath = relative(workspaceRoot, filePath);

  function visit(node: ts.Node) {
    const isExported = ts.canHaveModifiers(node)
      ? ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (!isExported) {
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      entries.push({
        name: node.name.text,
        kind: 'function',
        signature: node.getText(sourceFile).split('\n')[0]!.trim(),
        doc: extractDocComment(node, sourceFile),
        filePath: relPath,
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      entries.push({
        name: node.name.text,
        kind: 'class',
        signature: `class ${node.name.text}`,
        doc: extractDocComment(node, sourceFile),
        filePath: relPath,
      });
    } else if (ts.isInterfaceDeclaration(node)) {
      entries.push({
        name: node.name.text,
        kind: 'interface',
        signature: `interface ${node.name.text}`,
        doc: extractDocComment(node, sourceFile),
        filePath: relPath,
      });
    } else if (ts.isTypeAliasDeclaration(node)) {
      entries.push({
        name: node.name.text,
        kind: 'type',
        signature: node.getText(sourceFile).split('\n')[0]!.trim(),
        doc: extractDocComment(node, sourceFile),
        filePath: relPath,
      });
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          entries.push({
            name: decl.name.text,
            kind: 'const',
            signature: node.getText(sourceFile).split('\n')[0]!.trim(),
            doc: extractDocComment(node, sourceFile),
            filePath: relPath,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return entries;
}

/**
 * 生成 README.md 骨架。
 */
export function generateReadme(metadata: ProjectMetadata, apiSummary?: { entryCount: number; files: string[] }): string {
  const lines: string[] = [`# ${metadata.name}`, ''];
  if (metadata.description) lines.push(metadata.description, '');
  if (metadata.version) lines.push(`**Version**: ${metadata.version}`, '');
  if (metadata.license) lines.push(`**License**: ${metadata.license}`, '');

  lines.push('## Installation', '', '```bash', `npm install ${metadata.name}`, '```', '');
  lines.push('## Usage', '', '```typescript', `import { /* TODO */ } from '${metadata.name}';`, '', '// TODO: Add usage examples', '```', '');

  if (apiSummary && apiSummary.entryCount > 0) {
    lines.push('## API', '', `This project exports ${apiSummary.entryCount} public APIs across ${apiSummary.files.length} files. See [API Documentation](./docs/API.md) for details.`, '');
  }

  lines.push('## Contributing', '', 'Contributions are welcome! Please open an issue or submit a pull request.', '');
  if (metadata.repository) {
    lines.push(`Repository: ${metadata.repository}`, '');
  }

  return lines.join('\n');
}

/**
 * 生成 API.md 文档（按文件分组）。
 */
export function generateApiDocs(entries: ApiEntry[]): string {
  const lines: string[] = ['# API Documentation', ''];
  const byFile = new Map<string, ApiEntry[]>();
  for (const entry of entries) {
    if (!byFile.has(entry.filePath)) byFile.set(entry.filePath, []);
    byFile.get(entry.filePath)!.push(entry);
  }

  for (const [file, items] of byFile.entries()) {
    lines.push(`## \`${file}\``, '');
    for (const item of items) {
      lines.push(`### \`${item.name}\` (${item.kind})`, '');
      lines.push('```typescript', item.signature, '```', '');
      if (item.doc) {
        lines.push(item.doc, '');
      }
    }
  }

  return lines.join('\n');
}

type ChangelogEntry = {
  hash: string;
  date: string;
  message: string;
  author: string;
};

/**
 * 从 git log 提取最近的 commits（用于 CHANGELOG 生成）。
 */
export async function extractGitLog(workspaceRoot: string, limit = 50): Promise<ChangelogEntry[]> {
  try {
    const { stdout } = await execFileAsync('git', ['log', `--max-count=${limit}`, '--pretty=format:%H|%ai|%s|%an'], { cwd: workspaceRoot });
    return stdout.split('\n').filter(Boolean).map((line) => {
      const [hash, date, message, author] = line.split('|').map((s) => s.trim());
      return { hash: hash!, date: date!, message: message!, author: author! };
    });
  } catch {
    return [];
  }
}

/**
 * 生成 CHANGELOG.md（按类型分组：feat/fix/docs/chore/breaking）。
 */
export function generateChangelog(entries: ChangelogEntry[], version?: string): string {
  const lines: string[] = ['# Changelog', ''];
  if (version) lines.push(`## [${version}] - ${new Date().toISOString().split('T')[0]}`, '');

  const byType = new Map<string, ChangelogEntry[]>();
  for (const entry of entries) {
    const match = entry.message.match(/^(feat|fix|docs|chore|perf|refactor|test|breaking)(\(.+?\))?:/i);
    const type = match ? match[1]!.toLowerCase() : 'other';
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(entry);
  }

  const order = ['breaking', 'feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'chore', 'other'];
  const labels: Record<string, string> = {
    breaking: '⚠️ BREAKING CHANGES',
    feat: '✨ Features',
    fix: '🐛 Bug Fixes',
    perf: '⚡ Performance',
    refactor: '♻️ Refactor',
    docs: '📚 Documentation',
    test: '✅ Tests',
    chore: '🔧 Chore',
    other: '📦 Other',
  };

  for (const type of order) {
    const items = byType.get(type);
    if (!items || items.length === 0) continue;
    lines.push(`### ${labels[type] ?? type}`, '');
    for (const item of items) {
      const msg = item.message.replace(/^(feat|fix|docs|chore|perf|refactor|test|breaking)(\(.+?\))?:\s*/i, '');
      lines.push(`- ${msg} ([${item.hash.slice(0, 7)}](../../commit/${item.hash}))`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
