/**
 * cacheStrategy.test.ts — 跨厂商缓存策略测试
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCacheTtl,
  cacheControl,
  buildAutoCacheMessages,
  hashSegment,
  diffCacheSegments,
} from './cacheStrategy.js';
import { toAnthropicTools, toAnthropicAwareMessages } from './protocol.js';
import { classifyTurn, analyzeCacheHealth, formatCacheHealth } from '../usage/cacheHealth.js';
import type { UsageLedgerEntry } from '../usage/ledger.js';

describe('Anthropic TTL 旋钮', () => {
  it('默认 5m（cache_control 不带 ttl 字段，兼容老网关）', () => {
    expect(resolveCacheTtl({} as NodeJS.ProcessEnv)).toBe('5m');
    expect(cacheControl('5m')).toEqual({ type: 'ephemeral' });
  });

  it('AICODE_CACHE_TTL=1h 时断点带 ttl 字段', () => {
    expect(resolveCacheTtl({ AICODE_CACHE_TTL: '1h' } as unknown as NodeJS.ProcessEnv)).toBe('1h');
    expect(cacheControl('1h')).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('工具断点与滑动消息断点都接入 TTL helper', () => {
    process.env.AICODE_CACHE_TTL = '1h';
    try {
      const tools = toAnthropicTools([
        { name: 'a', description: 'a', inputHint: '{}', risk: 'read' },
        { name: 'b', description: 'b', inputHint: '{}', risk: 'read' },
      ]);
      expect(tools[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });

      const messages = toAnthropicAwareMessages([
        { role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:00Z' },
      ], { slidingCacheBreakpoint: true });
      const blocks = messages[0].content as Array<{ cache_control?: { ttl?: string } }>;
      expect(blocks[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    } finally {
      delete process.env.AICODE_CACHE_TTL;
    }
  });
});

describe('自动前缀缓存布局（strategy 尾置）', () => {
  const stableSystem = 'STABLE SYSTEM PROMPT';
  const strategyA = 'turn A strategy';
  const strategyB = 'turn B strategy: different every turn';

  it('稳定 system 在头部，strategy 在尾部', () => {
    const history = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ];
    const layout = buildAutoCacheMessages(stableSystem, history, strategyA);

    expect(layout[0]).toEqual({ role: 'system', content: stableSystem });
    expect(layout[layout.length - 1].role).toBe('system');
    expect(String(layout[layout.length - 1].content)).toContain(strategyA);
  });

  it('轮与轮之间，持久内容（system+历史）从位置 0 起字节一致（自动缓存可命中）', () => {
    const turn1 = buildAutoCacheMessages(stableSystem, [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ], strategyA);
    // turn1 = [sys, q1, a1, strategyA] —— strategy 是单轮临时的，不进历史

    // 下一轮：历史追加，strategy 换新
    const turn2 = buildAutoCacheMessages(stableSystem, [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ], strategyB);
    // turn2 = [sys, q1, a1, q2, strategyB]

    // 最长公共前缀 = [sys, q1, a1]：恰好是 turn1 去掉 strategy 尾，
    // 也是 turn2 去掉"新消息+新 strategy"——两轮的可缓存段完全一致。
    const common = JSON.stringify(turn2.slice(0, turn1.length - 1));
    expect(common).toBe(JSON.stringify(turn1.slice(0, -1)));
    // 差异只出现在各自的尾部（strategy / 新消息）
    expect(turn2[turn1.length - 1].content).toBe('q2');
    expect(turn1[turn1.length - 1].content).toContain(strategyA);
  });

  it('无 strategy 时不追加尾部消息', () => {
    const layout = buildAutoCacheMessages(stableSystem, [{ role: 'user', content: 'q' }]);
    expect(layout).toHaveLength(2);
    const layout2 = buildAutoCacheMessages(stableSystem, [{ role: 'user', content: 'q' }], '   ');
    expect(layout2).toHaveLength(2);
  });
});

describe('分段哈希诊断', () => {
  const base = {
    stableSystem: 'stable',
    toolStrategy: 'strategy-v1',
    messageHistory: 'q1 a1',
    lastMessage: 'q2',
  };

  it('定位 strategy 变化为非致命', () => {
    const diff = diffCacheSegments(base, { ...base, toolStrategy: 'strategy-v2' });
    expect(diff.toolStrategyChanged).toBe(true);
    expect(diff.stableSystemChanged).toBe(false);
    expect(diff.verdict).toContain('strategy');
  });

  it('定位稳定 system 变化为缓存杀手', () => {
    const diff = diffCacheSegments(base, { ...base, stableSystem: 'CHANGED' });
    expect(diff.stableSystemChanged).toBe(true);
    expect(diff.verdict).toContain('缓存杀手');
  });

  it('全段一致时输出健康结论', () => {
    const diff = diffCacheSegments(base, { ...base, lastMessage: 'q3' });
    expect(diff.lastMessageChanged).toBe(true);
    expect(diff.verdict).toContain('符合预期');
  });

  it('hashSegment 稳定且区分输入', () => {
    expect(hashSegment('abc')).toBe(hashSegment('abc'));
    expect(hashSegment('abc')).not.toBe(hashSegment('abd'));
  });
});

describe('台账健康诊断', () => {
  it('分类：冷启动 / 健康 / 前缀不稳定 / 前缀重建', () => {
    const entry = (over: Partial<UsageLedgerEntry>): UsageLedgerEntry => ({
      ts: '2026-09-03T00:00:00Z', sessionId: 's1', provider: 'openai', model: 'm',
      inputTokens: 30000, outputTokens: 100, ...over,
    });

    // 会话首轮 cacheRead=0 → 冷启动
    expect(classifyTurn(entry({ cacheCreationTokens: 33000 }), true)).toBe('cold-start');
    // 非首轮 cacheRead=0 但有写入 → 前缀不稳定
    expect(classifyTurn(entry({ cacheCreationTokens: 33000 }), false)).toBe('unstable-prefix');
    // 正常命中 → 健康
    expect(classifyTurn(entry({ cacheReadTokens: 32000, cacheCreationTokens: 1500 }), false)).toBe('healthy');
    // 写≈读且读小 → 前缀重建
    expect(classifyTurn(entry({ cacheReadTokens: 500, cacheCreationTokens: 32000 }), false)).toBe('prefix-rebuild');
    // 无缓存字段 → no-cache-data
    expect(classifyTurn(entry({}), false)).toBe('no-cache-data');
  });

  it('端到端：台账文件 → 报告含修复建议', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cache-health-'));
    try {
      const logDir = join(root, 'usage');
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, 'usage.jsonl');

      const entry = (sessionId: string, over: Partial<UsageLedgerEntry>): UsageLedgerEntry => ({
        ts: '2026-09-03T00:00:00Z', sessionId, provider: 'openai', model: 'm',
        inputTokens: 30000, outputTokens: 100, ...over,
      });
      const lines = [
        entry('s1', { cacheCreationTokens: 33000, cacheEfficiency: 0 }),
        entry('s1', { cacheReadTokens: 32000, cacheCreationTokens: 1500, cacheEfficiency: 0.96 }),
        entry('s2', { cacheCreationTokens: 33000, cacheEfficiency: 0 }),
        entry('s2', { cacheCreationTokens: 33500, cacheEfficiency: 0 }), // 非首轮零命中 = 不稳定
        entry('s2', { cacheReadTokens: 31000, cacheCreationTokens: 2600, cacheEfficiency: 0.93 }),
      ];
      writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');

      const report = await analyzeCacheHealth({ logPath });
      expect(report.totalTurns).toBe(5);
      expect(report.patternCounts['healthy']).toBe(2);
      expect(report.patternCounts['cold-start']).toBe(2);
      expect(report.patternCounts['unstable-prefix']).toBe(1);
      expect(report.findings.some((f) => f.includes('前缀不稳定'))).toBe(true);

      const text = formatCacheHealth(report);
      expect(text).toContain('缓存健康');
      expect(text).toContain('平均命中率');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('台账不存在时返回空报告不抛错', async () => {
    const report = await analyzeCacheHealth({ logPath: join(tmpdir(), 'no-such-usage.jsonl') });
    expect(report.totalTurns).toBe(0);
    expect(formatCacheHealth(report)).toContain('台账为空');
  });
});
