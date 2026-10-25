import { describe, expect, it } from 'vitest';
import { buildContextPanel, formatTokens, sessionOutputs, workspaceLabel } from './contextSidebar';
import type { ChatItem, ContextStats } from '../types';

const stats = (overrides: Partial<ContextStats> = {}): ContextStats => ({
  provider: 'openai',
  model: 'gpt-test',
  inputTokens: 100_000,
  outputTokens: 500,
  providerCacheReported: true,
  cacheReadTokens: 54_600,
  cacheCreationTokens: 0,
  predictedPromptCacheRate: null,
  categories: { messages: 83_300, systemTools: 35_300, mcpTools: 49_400, skills: 3_800, systemPrompt: 4_900, other: 0 },
  localCache: { totalHits: 0, totalMisses: 0, totalLookups: 0, hitRate: null, buckets: [] },
  ...overrides,
});

describe('buildContextPanel', () => {
  it('窗口和阈值直接用 CLI 报的数，不自己乘 0.9', () => {
    const panel = buildContextPanel(stats({ contextWindow: 272_000, autoCompactLimit: 244_800 }));
    expect(panel.window).toBe(272_000);
    expect(panel.limit).toBe(244_800);
    // 176.7k used / 272k window
    expect(panel.used).toBe(176_700);
    expect(panel.percent).toBe(65);
    expect(panel.untilCompact).toBe(244_800 - 176_700);
    expect(panel.buffer).toBe(272_000 - 244_800);
    expect(panel.free).toBe(272_000 - 176_700);
  });

  it('分类之和就是本次输入总量（不重不漏）', () => {
    const panel = buildContextPanel(stats({ contextWindow: 272_000, autoCompactLimit: 244_800 }));
    expect(panel.segments.reduce((sum, segment) => sum + segment.tokens, 0)).toBe(panel.used);
    expect(panel.segments.map((segment) => segment.key)).toEqual(['messages', 'mcpTools', 'systemTools', 'systemPrompt', 'skills']);
  });

  it('窗口拿不到就显示窗口未知，绝不编一个百分比或阈值', () => {
    const panel = buildContextPanel(stats({ contextWindow: undefined, autoCompactLimit: undefined }));
    expect(panel.window).toBeNull();
    expect(panel.percent).toBeNull();
    expect(panel.limit).toBeNull();
    expect(panel.untilCompact).toBeNull();
    expect(panel.buffer).toBeNull();
    expect(panel.free).toBeNull();
    expect(panel.segments.every((segment) => segment.percent === null)).toBe(true);
  });

  it('没有快照时是空面板，不是一堆 0%', () => {
    const panel = buildContextPanel(null);
    expect(panel.used).toBe(0);
    expect(panel.segments).toEqual([]);
    expect(panel.percent).toBeNull();
  });

  it('分类全为 0（旧载荷）时退回 usage 字段', () => {
    const panel = buildContextPanel(stats({
      categories: { messages: 0, systemTools: 0, mcpTools: 0, skills: 0, systemPrompt: 0, other: 0 },
      inputTokens: 1_000,
      cacheReadTokens: 0,
      contextWindow: 10_000,
      autoCompactLimit: 9_000,
    }));
    expect(panel.used).toBe(1_000);
    expect(panel.segments).toEqual([]);
  });
});

describe('formatTokens', () => {
  it('按卡片上的写法缩写', () => {
    expect(formatTokens(580)).toBe('580');
    expect(formatTokens(4_900)).toBe('4.9k');
    expect(formatTokens(154_600)).toBe('154.6k');
    expect(formatTokens(272_000)).toBe('272k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
    expect(formatTokens(0)).toBe('0');
  });
});

const turn = (files: Array<{ path: string; added: number; removed: number }>): ChatItem => ({
  id: `turn-${Math.random()}`,
  kind: 'turn',
  startedAt: 0,
  endedAt: 1,
  steps: [],
  files: files.map((file) => ({ ...file, checkpointIds: [] })),
  added: files.reduce((sum, file) => sum + file.added, 0),
  removed: files.reduce((sum, file) => sum + file.removed, 0),
});

describe('sessionOutputs', () => {
  it('同一文件跨回合累加，最近改的排前面', () => {
    const outputs = sessionOutputs([
      turn([{ path: 'a.ts', added: 3, removed: 1 }]),
      turn([{ path: 'b.ts', added: 1, removed: 0 }]),
      turn([{ path: 'a.ts', added: 2, removed: 4 }]),
    ]);
    expect(outputs.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
    expect(outputs[0]).toMatchObject({ added: 5, removed: 5, turns: 2 });
    expect(outputs[1]).toMatchObject({ added: 1, removed: 0, turns: 1 });
  });

  it('同一回合里写两次只算一个回合', () => {
    const outputs = sessionOutputs([turn([
      { path: 'a.ts', added: 1, removed: 0 },
      { path: 'a.ts', added: 1, removed: 0 },
    ])]);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ added: 2, turns: 1 });
  });

  it('只认改了文件的回合，其它条目忽略', () => {
    const outputs = sessionOutputs([
      { id: 'u', kind: 'user', text: '你好' },
      { id: 'a', kind: 'assistant', text: '在' },
      turn([]),
    ]);
    expect(outputs).toEqual([]);
  });
});

describe('workspaceLabel', () => {
  it('取末级目录名，两种分隔符都认', () => {
    expect(workspaceLabel('D:\\c_proj')).toBe('c_proj');
    expect(workspaceLabel('/home/me/project')).toBe('project');
    expect(workspaceLabel('D:\\c_proj\\')).toBe('c_proj');
  });
});
