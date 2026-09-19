/**
 * tools/qualityHistory.ts — 质量分析历史查询工具
 *
 * 读取 .aicode/quality/ 下由桌面质量网关持久化的分析记录（latest + history），
 * 让 agent 能回答"上次覆盖率多少 / 复杂度趋势如何"这类对比问题。
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition } from './types.js';

type QualityRecord = {
  schemaVersion: number;
  tool: string;
  capturedAt: string;
  revision?: string;
  result?: { ok?: boolean };
};

async function listRecordedTools(workspaceRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(workspaceRoot, '.aicode', 'quality'), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export const qualityHistoryTool: ToolDefinition<{
  tool?: string;
  limit: number;
}> = {
  name: 'quality_history',
  description: '查询历史质量分析记录（覆盖率、复杂度、性能、安全等），支持对比上次与本次结果',
  inputHint: '{ "tool": "analyze_coverage", "limit": 10 }',
  risk: 'read',

  validate(input) {
    if (input === undefined || input === null) return { limit: 10 };
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    const limit = typeof record.limit === 'number' && Number.isFinite(record.limit)
      ? Math.min(Math.max(1, Math.floor(record.limit)), 50)
      : 10;
    return {
      tool: typeof record.tool === 'string' && record.tool.trim() ? record.tool.trim() : undefined,
      limit,
    };
  },

  async execute(input, context) {
    const workspaceRoot = context.workspaceRoot;
    const tools = input.tool ? [input.tool] : await listRecordedTools(workspaceRoot);
    if (tools.length === 0) {
      return {
        ok: true,
        output: 'No quality analysis history recorded yet. Run a quality analysis from the desktop quality workspace first.',
        data: { tools: [] },
      };
    }

    const lines: string[] = [];
    let total = 0;
    for (const tool of tools) {
      const historyPath = join(workspaceRoot, '.aicode', 'quality', tool, 'history.jsonl');
      let raw = '';
      try {
        raw = await readFile(historyPath, 'utf8');
      } catch {
        continue;
      }
      const all = raw.split('\n').filter((line) => line.trim());
      const selected = all.slice(-input.limit).reverse();
      lines.push(`${tool} (${all.length} 条记录，显示 ${selected.length}):`);
      for (const line of selected) {
        try {
          const record = JSON.parse(line) as QualityRecord;
          const revision = record.revision ? ` @ ${record.revision}` : '';
          lines.push(`  - ${record.capturedAt} [${record.result?.ok === false ? 'failed' : 'ok'}]${revision}`);
        } catch {
          // 跳过损坏行，不中断整个列表
        }
        total += 1;
      }
      lines.push('');
    }

    if (total === 0) {
      return {
        ok: true,
        output: input.tool
          ? `No history recorded for "${input.tool}".`
          : 'No quality analysis history recorded yet.',
      };
    }
    return {
      ok: true,
      output: lines.join('\n').trim(),
      data: { tools: input.tool ? [input.tool] : tools, limit: input.limit },
    };
  },
};
