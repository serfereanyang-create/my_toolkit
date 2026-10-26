import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextStatsMenu } from './ContextStatsMenu';
import type { ContextStats } from '../types';

const stats = (overrides: Partial<ContextStats> = {}): ContextStats => ({
  provider: 'openai',
  model: 'gpt-test',
  inputTokens: 29_000,
  outputTokens: 500,
  providerCacheReported: true,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  predictedPromptCacheRate: 0.096,
  categories: { messages: 20_000, systemTools: 5_000, mcpTools: 2_000, skills: 1_000, systemPrompt: 1_000, other: 0 },
  localCache: { totalHits: 1, totalMisses: 1, totalLookups: 2, hitRate: 0.5, buckets: [] },
  contextWindow: 128_000,
  autoCompactLimit: 115_200,
  ...overrides,
});

function render(overrides: Partial<ContextStats> = {}) {
  return renderToStaticMarkup(createElement(ContextStatsMenu, {
    stats: stats(overrides),
    onClose: () => {},
  }));
}

describe('ContextStatsMenu', () => {
  it('缓存只留一行命中率，不再并列四个口径', () => {
    const html = render({ cacheReadTokens: 12_345, inputTokens: 17_655 });
    const rows = [...html.matchAll(/<div class="cache-row[^"]*">[\s\S]*?<\/div>/g)];
    expect(rows).toHaveLength(1);
    expect(html).toContain('缓存命中率');
    expect(html).not.toContain('自主预测');
    expect(html).not.toContain('本地缓存探针');
    expect(html).toContain('data-cache-hit-rate="41.1"');
  });

  it('供应商没报缓存就写「未提供」，不估一个数', () => {
    const html = render({ providerCacheReported: false, cacheReadTokens: 0 });
    expect(html).toContain('未提供');
    expect(html).toContain('data-cache-hit-rate=""');
    expect(html).toContain('没有返回 cache_read');
  });
});
