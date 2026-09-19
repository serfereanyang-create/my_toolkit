/**
 * tools.ts — 文档工具集成（CLI 工具注册）
 * 
 * 将文档生成、API 文档、Changelog 等功能注册为 CLI 工具
 */

import { defineTool } from '../tools/define.js';
import type { ToolResult } from '../tools/types.js';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { globSync } from 'glob';
import {
  extractAPIFromFile,
  generateAPIDocumentation,
  analyzeArchitecture,
  generateArchitectureDoc,
  generateREADME,
} from './doc-generator.js';
import {
  getGitCommits,
  groupCommitsByVersion,
  generateChangelog,
  recommendNextVersion,
  generateReleaseNotes,
} from './changelog.js';

/**
 * 生成 API 文档工具
 */
export const generateAPIDocTool = defineTool({
  name: 'generate_api_docs',
  description: '自动生成 API 文档（基于 JSDoc 注释）',
  risk: 'write',
  input: {
    pattern: {
      type: 'string',
      description: 'Glob 模式匹配文件，默认 "src/**/*.{ts,tsx}"',
      optional: true,
    },
    outputFile: {
      type: 'string',
      description: '输出文件路径，默认 API.md',
      optional: true,
    },
    writeToFile: {
      type: 'boolean',
      description: '是否写入文件，默认 false（仅预览）',
      optional: true,
    },
  },
  examples: [
    {
      input: { pattern: 'src/**/*.ts', outputFile: 'docs/API.md', writeToFile: true },
      output: '生成 API 文档并写入 docs/API.md',
    },
  ],
  
  async execute({ pattern = 'src/**/*.{ts,tsx}', outputFile = 'API.md', writeToFile = false }, context): Promise<ToolResult> {
    try {
      const files = globSync(pattern, {
        cwd: context.cwd,
        ignore: ['**/node_modules/**', '**/dist/**', '**/*.test.*', '**/*.spec.*'],
      });
      
      if (files.length === 0) {
        return {
          ok: true,
          output: '未找到匹配的文件',
        };
      }
      
      const allAPIs = [];
      
      for (const file of files) {
        const apis = await extractAPIFromFile(file, context.cwd);
        allAPIs.push(...apis);
      }
      
      const exportedAPIs = allAPIs.filter(api => api.exported);
      
      if (exportedAPIs.length === 0) {
        return {
          ok: true,
          output: '未找到导出的 API',
        };
      }
      
      const doc = generateAPIDocumentation(exportedAPIs);
      
      if (writeToFile) {
        const outputPath = resolve(context.cwd, outputFile);
        await writeFile(outputPath, doc, 'utf-8');
        
        return {
          ok: true,
          output: `✅ API 文档已生成: ${outputFile}\n\n包含 ${exportedAPIs.length} 个 API 条目`,
          data: { path: outputFile, count: exportedAPIs.length },
        };
      } else {
        return {
          ok: true,
          output: `# API 文档预览\n\n包含 ${exportedAPIs.length} 个 API 条目\n\n${doc.substring(0, 1000)}...\n\n💡 使用 writeToFile: true 写入文件`,
          data: { apis: exportedAPIs },
        };
      }
    } catch (error) {
      return {
        ok: false,
        output: `API 文档生成失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 生成架构文档工具
 */
export const generateArchitectureDocTool = defineTool({
  name: 'generate_architecture_doc',
  description: '分析项目架构并生成架构文档',
  risk: 'write',
  input: {
    rootDir: {
      type: 'string',
      description: '项目根目录，默认 src',
      optional: true,
    },
    outputFile: {
      type: 'string',
      description: '输出文件路径，默认 ARCHITECTURE.md',
      optional: true,
    },
    writeToFile: {
      type: 'boolean',
      description: '是否写入文件，默认 false',
      optional: true,
    },
  },
  examples: [
    {
      input: { rootDir: 'src', outputFile: 'docs/ARCHITECTURE.md', writeToFile: true },
      output: '分析架构并生成文档',
    },
  ],
  
  async execute({ rootDir = 'src', outputFile = 'ARCHITECTURE.md', writeToFile = false }, context): Promise<ToolResult> {
    try {
      const arch = await analyzeArchitecture(rootDir, context.cwd);
      const doc = generateArchitectureDoc(arch);
      
      if (writeToFile) {
        const outputPath = resolve(context.cwd, outputFile);
        await writeFile(outputPath, doc, 'utf-8');
        
        return {
          ok: true,
          output: `✅ 架构文档已生成: ${outputFile}\n\n模块总数: ${arch.modules.length}\n分层数: ${arch.layers.length}`,
          data: { path: outputFile, modules: arch.modules.length },
        };
      } else {
        return {
          ok: true,
          output: doc + '\n\n💡 使用 writeToFile: true 写入文件',
          data: arch,
        };
      }
    } catch (error) {
      return {
        ok: false,
        output: `架构文档生成失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 生成 Changelog 工具
 */
export const generateChangelogTool = defineTool({
  name: 'generate_changelog',
  description: '基于 Git 提交历史生成 Changelog',
  risk: 'write',
  input: {
    outputFile: {
      type: 'string',
      description: '输出文件路径，默认 CHANGELOG.md',
      optional: true,
    },
    writeToFile: {
      type: 'boolean',
      description: '是否写入文件，默认 false',
      optional: true,
    },
  },
  examples: [
    {
      input: { outputFile: 'CHANGELOG.md', writeToFile: true },
      output: '生成 Changelog 并写入文件',
    },
  ],
  
  async execute({ outputFile = 'CHANGELOG.md', writeToFile = false }, context): Promise<ToolResult> {
    try {
      const versions = await groupCommitsByVersion(context.cwd);
      
      if (versions.length === 0) {
        return {
          ok: true,
          output: '未找到任何版本标签',
        };
      }
      
      const changelog = generateChangelog(versions);
      
      if (writeToFile) {
        const outputPath = resolve(context.cwd, outputFile);
        await writeFile(outputPath, changelog, 'utf-8');
        
        const totalCommits = versions.reduce((sum, v) => sum + v.commits.length, 0);
        
        return {
          ok: true,
          output: `✅ Changelog 已生成: ${outputFile}\n\n版本数: ${versions.length}\n总提交数: ${totalCommits}`,
          data: { path: outputFile, versions: versions.length },
        };
      } else {
        return {
          ok: true,
          output: changelog.substring(0, 2000) + '\n\n...\n\n💡 使用 writeToFile: true 写入文件',
          data: versions,
        };
      }
    } catch (error) {
      return {
        ok: false,
        output: `Changelog 生成失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 推荐版本号工具
 */
export const recommendVersionTool = defineTool({
  name: 'recommend_version',
  description: '基于提交历史推荐下一个版本号（Semantic Versioning）',
  risk: 'read',
  input: {
    currentVersion: {
      type: 'string',
      description: '当前版本号，如 1.2.3',
    },
    from: {
      type: 'string',
      description: '起始标签（可选）',
      optional: true,
    },
  },
  examples: [
    {
      input: { currentVersion: '1.2.3' },
      output: '推荐下一个版本号',
    },
  ],
  
  async execute({ currentVersion, from }, context): Promise<ToolResult> {
    try {
      const commits = await getGitCommits(context.cwd, { from });
      
      if (commits.length === 0) {
        return {
          ok: true,
          output: '没有新提交，无需发布新版本',
        };
      }
      
      const nextVersion = recommendNextVersion(currentVersion, commits);
      
      const lines: string[] = [];
      lines.push('# 版本号推荐\n');
      lines.push(`**当前版本:** ${currentVersion}`);
      lines.push(`**推荐版本:** ${nextVersion}\n`);
      
      // 统计
      const featCount = commits.filter(c => c.type === 'feat').length;
      const fixCount = commits.filter(c => c.type === 'fix').length;
      const breakingCount = commits.filter(c => c.breaking).length;
      
      lines.push('**变更统计:**');
      lines.push(`- Breaking Changes: ${breakingCount}`);
      lines.push(`- 新功能: ${featCount}`);
      lines.push(`- Bug 修复: ${fixCount}`);
      lines.push(`- 总提交数: ${commits.length}\n`);
      
      if (breakingCount > 0) {
        lines.push('⚠️ 检测到 Breaking Changes，推荐主版本升级');
      } else if (featCount > 0) {
        lines.push('✨ 检测到新功能，推荐次版本升级');
      } else if (fixCount > 0) {
        lines.push('🐛 仅修复，推荐补丁版本升级');
      } else {
        lines.push('ℹ️ 无显著变更');
      }
      
      return {
        ok: true,
        output: lines.join('\n'),
        data: { currentVersion, nextVersion, commits: commits.length },
      };
    } catch (error) {
      return {
        ok: false,
        output: `版本推荐失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 生成发布说明工具
 */
export const generateReleaseNotesTool = defineTool({
  name: 'generate_release_notes',
  description: '生成版本发布说明',
  risk: 'write',
  input: {
    version: {
      type: 'string',
      description: '版本号',
    },
    from: {
      type: 'string',
      description: '起始标签（可选）',
      optional: true,
    },
    outputFile: {
      type: 'string',
      description: '输出文件路径（可选）',
      optional: true,
    },
  },
  examples: [
    {
      input: { version: '2.0.0', from: 'v1.9.0' },
      output: '生成 2.0.0 的发布说明',
    },
  ],
  
  async execute({ version, from, outputFile }, context): Promise<ToolResult> {
    try {
      const commits = await getGitCommits(context.cwd, { from });
      
      if (commits.length === 0) {
        return {
          ok: true,
          output: '没有新提交',
        };
      }
      
      const notes = generateReleaseNotes(version, commits);
      
      if (outputFile) {
        const outputPath = resolve(context.cwd, outputFile);
        await writeFile(outputPath, notes, 'utf-8');
        
        return {
          ok: true,
          output: `✅ 发布说明已生成: ${outputFile}`,
          data: { path: outputFile },
        };
      } else {
        return {
          ok: true,
          output: notes,
          data: { version, commits: commits.length },
        };
      }
    } catch (error) {
      return {
        ok: false,
        output: `发布说明生成失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

/**
 * 生成 README 工具
 */
export const generateREADMETool = defineTool({
  name: 'generate_readme',
  description: '生成项目 README',
  risk: 'write',
  input: {
    projectName: {
      type: 'string',
      description: '项目名称',
    },
    description: {
      type: 'string',
      description: '项目描述',
    },
    features: {
      type: 'array',
      description: '特性列表（可选）',
      optional: true,
    },
    includeArchitecture: {
      type: 'boolean',
      description: '是否包含架构信息，默认 true',
      optional: true,
    },
    outputFile: {
      type: 'string',
      description: '输出文件路径，默认 README.md',
      optional: true,
    },
  },
  examples: [
    {
      input: { 
        projectName: 'My Project', 
        description: 'A great project',
        features: ['Fast', 'Reliable', 'Easy to use']
      },
      output: '生成 README',
    },
  ],
  
  async execute({ projectName, description, features, includeArchitecture = true, outputFile = 'README.md' }, context): Promise<ToolResult> {
    try {
      let architecture;
      
      if (includeArchitecture) {
        try {
          architecture = await analyzeArchitecture('src', context.cwd);
        } catch {
          // 架构分析失败，忽略
        }
      }
      
      const readme = generateREADME({
        projectName,
        description,
        features: features as string[] | undefined,
        installation: 'npm install',
        usage: 'import { something } from "package"',
        architecture,
      });
      
      const outputPath = resolve(context.cwd, outputFile);
      await writeFile(outputPath, readme, 'utf-8');
      
      return {
        ok: true,
        output: `✅ README 已生成: ${outputFile}`,
        data: { path: outputFile },
      };
    } catch (error) {
      return {
        ok: false,
        output: `README 生成失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

export const docTools = [
  generateAPIDocTool,
  generateArchitectureDocTool,
  generateChangelogTool,
  recommendVersionTool,
  generateReleaseNotesTool,
  generateREADMETool,
];
