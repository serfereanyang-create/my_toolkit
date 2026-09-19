/**
 * prDescriptionTool.ts — generate_pr_description 工具注册。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '../tools/types.js';
import { generatePrDescription, renderPrMarkdown } from './prDescription.js';

const execFileAsync = promisify(execFile);

async function gitDiff(workspaceRoot: string, base: string, head: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['diff', `${base}...${head}`, '--'], {
    cwd: workspaceRoot,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function gitLogTitles(workspaceRoot: string, base: string, head: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['log', '--pretty=format:%s', `${base}...${head}`], {
    cwd: workspaceRoot,
    maxBuffer: 1024 * 1024,
  });
  return stdout.split('\n').filter(Boolean).slice(0, 30);
}

export const prDescriptionTool: ToolDefinition<{
  base?: string;
  head?: string;
  branch?: string;
  diffText?: string;
}> = {
  name: 'generate_pr_description',
  description: '从 git diff（或传入的 diff 文本）生成规范 PR 描述：概述/影响面/重命名/测试/自查清单',
  inputHint: '{ "base": "main", "head": "feature-x", "branch": "feature-x" } 或 { "diffText": "..." }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    if (typeof r.diffText === 'string' && r.diffText.trim()) return { diffText: r.diffText };
    if (typeof r.base !== 'string' || typeof r.head !== 'string') {
      throw new Error('需要 diffText，或 base+head 两个分支名');
    }
    return {
      base: r.base.trim() || 'main',
      head: r.head.trim(),
      branch: typeof r.branch === 'string' ? r.branch.trim() : undefined,
    };
  },

  async execute(input, context) {
    let diffText = input.diffText;
    let commits: string[] = [];
    if (!diffText && input.base && input.head) {
      try {
        diffText = await gitDiff(context.workspaceRoot, input.base, input.head);
        commits = await gitLogTitles(context.workspaceRoot, input.base, input.head);
      } catch (err) {
        return { ok: false, output: `读取 git 信息失败: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    if (!diffText?.trim()) {
      return { ok: true, output: 'diff 为空：两分支间没有文件变更（或未提供 diffText）。' };
    }

    const desc = generatePrDescription({
      diffA: diffText,
      branchName: input.branch ?? (input.head ? `${input.base}→${input.head}` : undefined),
      commits,
    });
    return { ok: true, output: renderPrMarkdown(desc), data: desc };
  },
};

export const prDescriptionTools = [prDescriptionTool];
