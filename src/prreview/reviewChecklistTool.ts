/**
 * reviewChecklistTool.ts — review_checklist 工具注册。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '../tools/types.js';
import { buildChecklistFromDiff, renderChecklist } from './reviewChecklist.js';

const execFileAsync = promisify(execFile);

async function gitDiff(workspaceRoot: string, base: string, head: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['diff', `${base}...${head}`, '--'], {
    cwd: workspaceRoot,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

export const reviewChecklistTool: ToolDefinition<{
  base?: string;
  head?: string;
  diffText?: string;
}> = {
  name: 'review_checklist',
  description: '从分支 diff 生成 P0/P1/P2 分级评审清单（安全/数据/并发/接口/测试/删除面），可贴进 PR',
  inputHint: '{ "base": "main", "head": "feature-x" } 或 { "diffText": "<unified diff>" }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    if (typeof r.diffText === 'string' && r.diffText.trim()) return { diffText: r.diffText };
    if (typeof r.base !== 'string' || typeof r.head !== 'string') {
      throw new Error('需要 diffText，或 base+head');
    }
    return { base: r.base.trim(), head: r.head.trim() };
  },

  async execute(input, context) {
    let diffText = input.diffText;
    if (!diffText && input.base && input.head) {
      try {
        diffText = await gitDiff(context.workspaceRoot, input.base, input.head);
      } catch (err) {
        return { ok: false, output: `读取 git diff 失败: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    if (!diffText?.trim()) {
      return { ok: true, output: 'diff 为空，无需清单。' };
    }
    const result = buildChecklistFromDiff(diffText);
    return { ok: true, output: renderChecklist(result), data: result };
  },
};

export const reviewChecklistTools = [reviewChecklistTool];
