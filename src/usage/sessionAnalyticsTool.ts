/**
 * sessionAnalyticsTool.ts — session_analytics 工具：本会话/最近会话的使用分析。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition } from '../tools/types.js';
import { computeSessionAnalytics } from './sessionAnalytics.js';

interface SessionFileShape {
  id?: string;
  updatedAt?: string;
  toolCalls?: Array<{ tool?: unknown; ok?: unknown; output?: unknown }>;
}

async function listSessionFiles(sessionsDir: string): Promise<Array<{ path: string; rel: string }>> {
  const { readdir } = await import('node:fs/promises');
  try {
    const names = await readdir(sessionsDir);
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => ({ path: join(sessionsDir, n), rel: n }));
  } catch {
    return [];
  }
}

export const sessionAnalyticsTool: ToolDefinition<{
  sessionId?: string;
  limit?: number;
}> = {
  name: 'session_analytics',
  description: '分析 usage 账本与会话工具调用：cache 命中率、工具排行与失败样本、平均轮耗时、小时分布',
  inputHint: '{ "sessionId": "可选，默认最近会话", "limit": 200 }',
  risk: 'read',

  validate(input) {
    if (typeof input !== 'object' || input === null) throw new Error('expected an object');
    const r = input as Record<string, unknown>;
    if (typeof r.sessionId === 'string' && (r.sessionId.includes('..') || r.sessionId.includes('/') || r.sessionId.includes('\\'))) {
      throw new Error('sessionId must be a plain session id without path separators');
    }
    return {
      sessionId: typeof r.sessionId === 'string' && r.sessionId.trim() ? r.sessionId.trim() : undefined,
      limit: typeof r.limit === 'number' && r.limit > 0 ? Math.floor(r.limit) : 200,
    };
  },

  async execute(input, context) {
    const sessionsDir = join(context.workspaceRoot, '.aicode', 'sessions');
    const files = await listSessionFiles(sessionsDir);
    if (files.length === 0) {
      return { ok: false, output: '工作区没有会话记录（.aicode/sessions 为空）。' };
    }

    // 目标会话：显式指定 > 最近更新
    let target: { path: string; rel: string } | undefined;
    if (input.sessionId) {
      target = files.find((f) => f.rel === `${input.sessionId}.json`);
      if (!target) return { ok: false, output: `找不到会话 ${input.sessionId}` };
    } else {
      let latestTime = '';
      for (const file of files) {
        try {
          const session = JSON.parse(await readFile(file.path, 'utf-8')) as SessionFileShape;
          if (session.updatedAt && session.updatedAt > latestTime) {
            latestTime = session.updatedAt;
            target = file;
          }
        } catch { /* skip broken */ }
      }
      if (!target) return { ok: false, output: '无法确定最近会话（更新时间缺失）。' };
    }

    let toolCalls: Array<{ tool: string; ok: boolean; output?: string }> = [];
    try {
      const session = JSON.parse(await readFile(target.path, 'utf-8')) as SessionFileShape;
      toolCalls = (session.toolCalls ?? [])
        .map((call) => ({
          tool: typeof call.tool === 'string' ? call.tool : 'unknown',
          ok: call.ok === true,
          output: typeof call.output === 'string' ? call.output : undefined,
        }));
    } catch (err) {
      return { ok: false, output: `读取会话失败: ${err instanceof Error ? err.message : String(err)}` };
    }

    let ledgerText = '';
    try {
      // 账本固定在工作区 .aicode 下（不拼接 env/外部路径）
      ledgerText = await readFile(join(context.workspaceRoot, '.aicode', 'usage.jsonl'), 'utf-8');
    } catch { /* 账本可缺 */ }

    const report = computeSessionAnalytics({ ledgerText, toolCalls, limit: input.limit });

    const lines: string[] = [
      `## 会话使用分析（会话 ${target.rel.replace('.json', '')}）`,
      '',
      `- 最近 ${report.turns} 轮：输入 ${report.totalInputTokens.toLocaleString()} / 输出 ${report.totalOutputTokens.toLocaleString()} tokens`,
      `- 缓存命中率: ${report.cacheHitRate === null ? '无数据' : `${(report.cacheHitRate * 100).toFixed(1)}%`}`,
      `- 平均轮耗时: ${report.avgTurnDurationMs === null ? '无数据' : `${(report.avgTurnDurationMs / 1000).toFixed(1)}s`}`,
      `- 工具调用 ${report.totalToolCalls} 次，整体失败率 ${report.failureRate === null ? '—' : `${(report.failureRate * 100).toFixed(1)}%`}`,
      '',
      '### 工具排行（前 10）',
    ];
    for (const stat of report.topTools) {
      const rate = (stat.failureRate * 100).toFixed(0);
      lines.push(`- **${stat.tool}**: ${stat.calls} 次调用，失败 ${stat.failures}（${rate}%）`);
      for (const f of stat.recentFailures) lines.push(`    · 失败样本: ${f.slice(0, 80)}`);
    }
    const busiest = report.hourHistogram
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)[0];
    if (busiest && busiest.count > 0) {
      lines.push('', `### 活跃时段（UTC）`);
      lines.push(`- 最高峰 ${busiest.hour}:00（${busiest.count} 轮）`);
    }
    return { ok: true, output: lines.join('\n'), data: report };
  },
};

export const sessionAnalyticsTools = [sessionAnalyticsTool];
