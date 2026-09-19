/**
 * workspaceTools.ts - Monorepo workspace tools:
 *   workspace_list     列出所有子包
 *   workspace_affected 通过变更文件反推受影响包
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '../tools/types.js';
import { discoverWorkspace } from './discover.js';
import { computeAffected } from './affected.js';

const execFileAsync = promisify(execFile);

export const workspaceListTool: ToolDefinition<Record<string, never>> = {
  name: 'workspace_list',
  description: '识别 npm/pnpm/yarn/turbo/nx workspace，列出所有子包（name、版本、路径、入口、本地依赖数）',
  inputHint: '{}',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    return {};
  },

  async execute(_input, context) {
    const discovery = await discoverWorkspace(context.workspaceRoot);
    if (discovery.packages.length === 0) {
      return {
        ok: true,
        output: `未发现 workspace。根目录 ${context.workspaceRoot} 解析不到 package.json 或没有任何 workspace 配置。`,
      };
    }

    const lines: string[] = [
      `## Workspace 概览`,
      '',
      `- 工具: ${discovery.tool}`,
      `- 配置: ${discovery.configFile ?? '无'}`,
      `- Patterns: ${discovery.patterns.join(', ') || '（无 — 单包）'}`,
      `- 子包数: ${discovery.packages.length}`,
      '',
    ];

    for (const pkg of discovery.packages) {
      const depsTotal =
        pkg.dependencies.length + pkg.devDependencies.length + pkg.peerDependencies.length + pkg.optionalDependencies.length;
      const entry = pkg.entryPoints;
      const entryBits: string[] = [];
      if (entry.main) entryBits.push(`main=${entry.main}`);
      if (entry.module) entryBits.push(`module=${entry.module}`);
      if (entry.types) entryBits.push(`types=${entry.types}`);
      if (entry.exportsField) entryBits.push('exports:yes');
      if (entry.bin) entryBits.push(`bin:${Object.keys(entry.bin).length}`);
      lines.push(
        `- **${pkg.name}**@${pkg.version}${pkg.isPrivate ? ' (private)' : ''} — \`${pkg.dir}\`, deps ${depsTotal}${entryBits.length > 0 ? `, ${entryBits.join(' ')}` : ''}`,
      );
    }

    return { ok: true, output: lines.join('\n'), data: discovery };
  },
};

export const workspaceAffectedTool: ToolDefinition<{
  files?: string[];
  /** 用 git status 的变更文件 */
  useGitChanges?: boolean;
}> = {
  name: 'workspace_affected',
  description: '把变更文件反推到受影响包（直接命中 + 依赖方集合）',
  inputHint: '{ "files": ["packages/foo/src/index.ts"] } 或 { "useGitChanges": true }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    return {
      files: Array.isArray(record.files)
        ? (record.files as unknown[]).filter((f): f is string => typeof f === 'string')
        : undefined,
      useGitChanges: record.useGitChanges === true,
    };
  },

  async execute(input, context) {
    const discovery = await discoverWorkspace(context.workspaceRoot);
    if (discovery.packages.length === 0) {
      return { ok: false, output: '未发现 workspace 包' };
    }

    let files: string[] = input.files ?? [];
    if (input.useGitChanges) {
      try {
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
          cwd: context.workspaceRoot,
          maxBuffer: 4 * 1024 * 1024,
        });
        files = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 3)
          .map((line) => {
            // 形如 " M path/to/file" 或 "?? newfile"
            const statusCode = line.slice(0, 2);
            const path = line.slice(3).trim();
            // rename 场景 "R old -> new"
            if (statusCode.startsWith('R')) {
              const arrow = path.indexOf(' -> ');
              if (arrow > 0) return path.slice(arrow + 4);
            }
            return path;
          });
      } catch (err) {
        return {
          ok: false,
          output: `git status 失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (files.length === 0) {
      return { ok: true, output: '没有变更文件，无需计算 affected。' };
    }

    const result = computeAffected(files, discovery.packages);
    const lines: string[] = [
      `## 受影响包分析`,
      '',
      `- 变更文件 ${files.length} 个`,
      `- 直接命中 ${result.direct.length} 个包：${result.direct.map((d) => d.name).join(', ') || '(无)'}`,
      `- 反向依赖受影响 ${result.dependents.length} 个包：${result.dependents.map((d) => d.name).join(', ') || '(无)'}`,
      `- 合计：${result.allAffected.length} 个包`,
    ];
    if (result.unmatchedFiles.length > 0) {
      lines.push('', `### 未匹配到任何包的文件（${result.unmatchedFiles.length}）`);
      for (const f of result.unmatchedFiles.slice(0, 20)) lines.push(`- ${f}`);
    }
    return { ok: true, output: lines.join('\n'), data: result };
  },
};

export const workspaceTools = [workspaceListTool, workspaceAffectedTool];
