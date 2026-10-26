import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextSidebar } from './ContextSidebar';
import { buildContextPanel } from '../lib/contextSidebar';
import type { ContextStats } from '../types';

const stats = (overrides: Partial<ContextStats> = {}): ContextStats => ({
  provider: 'openai',
  model: 'gpt-test',
  inputTokens: 100_000,
  outputTokens: 500,
  providerCacheReported: true,
  cacheReadTokens: 50_000,
  cacheCreationTokens: 0,
  predictedPromptCacheRate: null,
  categories: { messages: 83_300, systemTools: 35_300, mcpTools: 49_400, skills: 3_800, systemPrompt: 4_900, other: 0 },
  localCache: { totalHits: 0, totalMisses: 0, totalLookups: 0, hitRate: null, buckets: [] },
  contextWindow: 272_000,
  autoCompactLimit: 244_800,
  ...overrides,
});

function render(overrides: {
  panel?: ReturnType<typeof buildContextPanel>;
  outputs?: Array<{ path: string; added: number; removed: number; turns: number }>;
  workspaceRoot?: string;
  recentWorkspaces?: string[];
  recentFiles?: Array<{ path: string; lastOpenedAt: number; opens: number }>;
} = {}) {
  return renderToStaticMarkup(createElement(ContextSidebar, {
    panel: overrides.panel ?? buildContextPanel(stats()),
    outputs: overrides.outputs ?? [],
    workspaceRoot: overrides.workspaceRoot ?? 'D:\\c_proj',
    recentWorkspaces: overrides.recentWorkspaces ?? ['D:\\c_proj', 'C:\\other'],
    recentFiles: overrides.recentFiles ?? [],
    compacting: false,
    onCompact: () => {},
    onOpenFile: () => {},
    onOpenWorkspace: () => {},
    onSwitchWorkspace: () => {},
    onOpenRecent: () => {},
  }));
}

describe('ContextSidebar', () => {
  it('三块都在，而且没有折叠/收起之类的入口', () => {
    const html = render();
    expect(html).toContain('环境');
    expect(html).toContain('上下文');
    expect(html).toContain('输出');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('aria-collapsed');
  });

  it('最近文件跟着这块面板走：有就列出来，没有就不占位', () => {
    const withFiles = render({
      recentFiles: [
        { path: 'D:\\c_proj\\src\\a.ts', lastOpenedAt: Date.now() - 60_000, opens: 3 },
        { path: 'D:\\c_proj\\src\\b.ts', lastOpenedAt: Date.now() - 3_600_000, opens: 1 },
      ],
    });
    expect(withFiles).toContain('最近文件');
    expect([...withFiles.matchAll(/data-recent-path="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'D:\\c_proj\\src\\a.ts',
      'D:\\c_proj\\src\\b.ts',
    ]);
    expect(render()).not.toContain('最近文件');
  });

  it('上下文数字来自快照：占用比例、已用/窗口、分类图例', () => {
    const html = render();
    expect(html).toContain('data-context-percent="65"');
    expect(html).toContain('176.7k');
    expect(html).toContain('272k');
    const segments = [...html.matchAll(/data-context-legend="([a-zA-Z]+)"/g)].map((match) => match[1]);
    expect(segments).toEqual(['messages', 'mcpTools', 'systemTools', 'systemPrompt', 'skills', 'buffer', 'free']);
  });

  it('窗口未知时不打百分比，也不编「还剩多少」', () => {
    const html = render({ panel: buildContextPanel(stats({ contextWindow: undefined, autoCompactLimit: undefined })) });
    expect(html).toContain('窗口未知');
    expect(html).toContain('data-context-until=""');
    expect(html).not.toContain('后自动压缩');
  });

  it('没有快照时压缩按钮禁用，并说明没有可压缩的内容', () => {
    const html = render({ panel: buildContextPanel(null) });
    expect(html).toMatch(/<button[^>]*data-context-compact[^>]*disabled/);
    expect(html).toContain('还没有跑过模型调用');
  });

  it('有快照时压缩按钮可点', () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*data-context-compact/);
    expect(html).not.toMatch(/<button[^>]*data-context-compact[^>]*disabled/);
  });

  it('环境区列出当前工作区和其它最近工作区', () => {
    const html = render();
    expect(html).toContain('data-env-current="D:\\c_proj"');
    expect(html).toContain('data-env-recent="C:\\other"');
    // 当前工作区不在「最近」里重复出现
    expect(html.match(/data-env-recent="D:\\\\c_proj"/g)).toBeNull();
  });

  it('输出区按真实改动列出文件与增删行数，没有就说明没有', () => {
    const withFiles = render({ outputs: [{ path: 'src/App.tsx', added: 12, removed: 3, turns: 2 }] });
    expect(withFiles).toContain('data-output-path="src/App.tsx"');
    expect(withFiles).toContain('+12');
    expect(withFiles).toContain('-3');
    expect(render()).toContain('本会话还没有改动过文件');
  });

  it('超过 8 个文件时给出总数提示', () => {
    const outputs = Array.from({ length: 10 }, (_, index) => ({ path: `src/f${index}.ts`, added: 1, removed: 0, turns: 1 }));
    const html = render({ outputs });
    expect(html).toContain('另有 2 个文件');
  });
});
