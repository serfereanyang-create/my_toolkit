/**
 * docTools.ts — 文档生成工具注册
 */

import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { ToolDefinition } from '../tools/types.js';
import {
  extractProjectMetadata,
  extractApiEntries,
  generateReadme,
  generateApiDocs,
  extractGitLog,
  generateChangelog,
} from './docGeneration.js';

export const generateReadmeTool: ToolDefinition<{
  includeApi?: boolean;
  pattern?: string;
}> = {
  name: 'generate_readme',
  description: '生成项目 README.md 骨架（概述、安装、使用、API、贡献）',
  inputHint: '{ "includeApi": true, "pattern": "src/**/*.ts" }',
  risk: 'write',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      includeApi: typeof record.includeApi === 'boolean' ? record.includeApi : false,
      pattern: typeof record.pattern === 'string' && record.pattern.trim() ? record.pattern.trim() : undefined,
    };
  },

  async execute(input, context) {
    const metadata = await extractProjectMetadata(context.workspaceRoot);
    let apiSummary: { entryCount: number; files: string[] } | undefined;

    if (input.includeApi) {
      const pattern = input.pattern ?? 'src/**/*.ts';
      const files = await findSourceFiles(context.workspaceRoot, pattern);
      let totalEntries = 0;
      for (const file of files.slice(0, 50)) {
        const entries = await extractApiEntries(file, context.workspaceRoot);
        totalEntries += entries.length;
      }
      apiSummary = { entryCount: totalEntries, files: files.slice(0, 50) };
    }

    const readme = generateReadme(metadata, apiSummary);
    return {
      ok: true,
      output: `Generated README.md for ${metadata.name}.\n\nReview and customize the TODO placeholders before committing.`,
      data: { content: readme, metadata },
    };
  },
};

export const generateApiDocsTool: ToolDefinition<{
  pattern: string;
  maxFiles: number;
}> = {
  name: 'generate_api_docs',
  description: '从 TSDoc/JSDoc 生成 API 文档（按文件分组）',
  inputHint: '{ "pattern": "src/**/*.ts", "maxFiles": 50 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      pattern: typeof record.pattern === 'string' && record.pattern.trim() ? record.pattern.trim() : 'src/**/*.ts',
      maxFiles: typeof record.maxFiles === 'number' && record.maxFiles > 0 ? Math.floor(record.maxFiles) : 50,
    };
  },

  async execute(input, context) {
    const files = await findSourceFiles(context.workspaceRoot, input.pattern);
    const selected = files.slice(0, input.maxFiles);
    const allEntries: Awaited<ReturnType<typeof extractApiEntries>> = [];
    for (const file of selected) {
      const entries = await extractApiEntries(file, context.workspaceRoot);
      allEntries.push(...entries);
    }

    if (allEntries.length === 0) {
      return {
        ok: true,
        output: `No exported APIs found in ${selected.length} files matching "${input.pattern}".`,
        data: { entries: 0 },
      };
    }

    const apiDoc = generateApiDocs(allEntries);
    return {
      ok: true,
      output: `Generated API documentation for ${allEntries.length} entries across ${selected.length} files.`,
      data: { content: apiDoc, entries: allEntries.length, files: selected.length },
    };
  },
};

export const generateChangelogTool: ToolDefinition<{
  limit?: number;
  version?: string;
}> = {
  name: 'generate_changelog',
  description: '从 git log 生成 CHANGELOG.md（按 feat/fix/docs 等类型分组）',
  inputHint: '{ "limit": 50, "version": "1.0.0" }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      limit: typeof record.limit === 'number' && record.limit > 0 ? Math.floor(record.limit) : 50,
      version: typeof record.version === 'string' && record.version.trim() ? record.version.trim() : undefined,
    };
  },

  async execute(input, context) {
    const entries = await extractGitLog(context.workspaceRoot, input.limit);
    if (entries.length === 0) {
      return {
        ok: false,
        output: 'No git history found. Ensure the workspace is a git repository with commits.',
      };
    }

    const changelog = generateChangelog(entries, input.version);
    return {
      ok: true,
      output: `Generated CHANGELOG from ${entries.length} commits${input.version ? ` for version ${input.version}` : ''}.`,
      data: { content: changelog, commits: entries.length },
    };
  },
};

/**
 * 简单文件查找（glob 的轻量替代，支持 ** 通配）。
 */
async function findSourceFiles(root: string, pattern: string): Promise<string[]> {
  const results: string[] = [];
  const parts = pattern.split('/');
  
  async function scan(dir: string, depth: number): Promise<void> {
    if (depth >= parts.length) return;
    const segment = parts[depth]!;
    
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        
        if (segment === '**') {
          // 递归扫描
          if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
            await scan(fullPath, depth);
            await scan(fullPath, depth + 1);
          } else if (entry.isFile() && depth === parts.length - 1) {
            const ext = parts[parts.length - 1]?.replace('*', '') ?? '';
            if (ext && fullPath.endsWith(ext)) results.push(fullPath);
          }
        } else if (segment.includes('*')) {
          // 简单通配符
          const regex = new RegExp('^' + segment.replace(/\*/g, '.*') + '$');
          if (regex.test(entry.name)) {
            if (entry.isFile() && depth === parts.length - 1) {
              results.push(fullPath);
            } else if (entry.isDirectory() && depth < parts.length - 1) {
              await scan(fullPath, depth + 1);
            }
          }
        } else {
          // 精确匹配
          if (entry.name === segment) {
            if (entry.isFile() && depth === parts.length - 1) {
              results.push(fullPath);
            } else if (entry.isDirectory()) {
              await scan(fullPath, depth + 1);
            }
          }
        }
      }
    } catch {
      // 权限错误或不存在，跳过
    }
  }
  
  await scan(root, 0);
  return results;
}

export const docTools = [generateReadmeTool, generateApiDocsTool, generateChangelogTool];
