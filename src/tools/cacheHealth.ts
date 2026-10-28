import { defineTool } from '../tools/define.js';
import type { ToolResult } from '../tools/types.js';
import { analyzeCacheHealth, formatCacheHealth } from '../usage/cacheHealth.js';
import { resolveCacheTtl } from '../providers/cacheStrategy.js';

/**
 * cache_health — 提示缓存健康诊断
 *
 * 读真实 usage 台账按轮分类命中模式（冷启动/健康/前缀重建/前缀不稳定），
 * 输出命中率统计与可执行修复建议。对应行业主流的"分段哈希定位缓存杀手"诊断法。
 */
export const cacheHealthTool = defineTool({
  name: 'cache_health',
  description: '诊断提示缓存命中健康：读 usage 台账按轮分类（冷启动/健康/前缀重建/前缀不稳定），给出命中率与修复建议。',
  risk: 'read',
  input: {
    logPath: { type: 'string', description: '台账路径（默认 ~/.aicode/usage.jsonl）', optional: true },
    limit: { type: 'number', description: '分析最近 N 轮，默认 60', optional: true },
  },
  examples: [
    { input: { limit: 60 }, output: '返回最近 60 轮的命中率统计与诊断' },
    { input: { limit: 20, logPath: '/path/to/usage.jsonl' }, output: '只分析指定台账的最近 20 轮' },
  ],

  async execute(input): Promise<ToolResult> {
    try {
      const report = await analyzeCacheHealth({ logPath: input.logPath, limit: input.limit });
      const ttl = resolveCacheTtl();
      const lines = [
        formatCacheHealth(report),
        '',
        '当前断点 TTL: ' + ttl + (ttl === '5m' ? '（AICODE_CACHE_TTL=1h 可延长到 1 小时，写入费 2x）' : ''),
      ];
      return { ok: true, output: lines.join('\n'), data: { report } };
    } catch (error) {
      return { ok: false, output: '缓存诊断失败: ' + (error instanceof Error ? error.message : String(error)) };
    }
  },
});

export const cacheHealthTools = [cacheHealthTool];
