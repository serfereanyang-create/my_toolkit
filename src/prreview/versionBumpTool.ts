/**
 * versionBumpTool.ts — version_bump 工具：从提交历史给出版本与 CHANGELOG 建议。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition } from '../tools/types.js';
import { planVersionBump, renderBumpReport } from './versionBump.js';

const execFileAsync = promisify(execFile);

async function readVersionFromPackage(workspaceRoot: string): Promise<string | null> {
  try {
    const raw = await readFile(join(workspaceRoot, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

export const versionBumpTool: ToolDefinition<{ currentVersion?: string; limit?: number; keepPrerelease?: boolean }> = {
  name: 'version_bump',
  description: '分析最近提交（conventional）给出 major/minor/patch 建议与 CHANGELOG 草稿；版本默认读 package.json',
  inputHint: '{ "currentVersion": "1.4.2", "limit": 50 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    return {
      currentVersion: typeof r.currentVersion === 'string' && r.currentVersion.trim() ? r.currentVersion.trim() : undefined,
      limit: typeof r.limit === 'number' && r.limit > 0 ? Math.min(200, Math.floor(r.limit)) : 50,
      keepPrerelease: r.keepPrerelease === true,
    };
  },

  async execute(input, context) {
    const current = input.currentVersion ?? (await readVersionFromPackage(context.workspaceRoot));
    if (!current) {
      return { ok: false, output: '无法确定当前版本：package.json 没有 version 字段，且未传 currentVersion。' };
    }
    const limit = input.limit ?? 50;
    let stdout = '';
    try {
      const maxCount = `--max-count=${limit}`;
      const res = await execFileAsync('git', ['log', maxCount, '--no-merges', '--pretty=format:%s'], {
        cwd: context.workspaceRoot,
        maxBuffer: 4 * 1024 * 1024,
      });
      stdout = res.stdout;
    } catch (err) {
      return { ok: false, output: `git log 读取失败: ${err instanceof Error ? err.message : String(err)}` };
    }
    const titles = stdout.split('\n').map((t) => t.trim()).filter(Boolean);
    if (titles.length === 0) {
      return { ok: true, output: '没有可分析的提交。' };
    }
    const decision = planVersionBump(current, titles, { keepPrerelease: input.keepPrerelease === true });
    return { ok: true, output: renderBumpReport(decision), data: decision };
  },
};

export const versionBumpTools = [versionBumpTool];
