import { describe, expect, it } from 'vitest';
import { normalizeAnthropicUsage } from './anthropic.js';
import { usageFromOpenAI } from './openai.js';
import { VENDOR_PROFILES } from './vendors.js';

/*
 * Token accounting has to agree across providers, because every consumer adds
 * the two together: the cache-hit rate is `read / (input + read)`, the usage
 * page sums `input + cacheRead`, and cost bills them at different prices.
 *
 * Anthropic reports `input_tokens` NET of the cached part. OpenAI-style vendors
 * report `prompt_tokens` INCLUSIVE of it. Passing the inclusive number through
 * unchanged counted cached tokens twice — a real DeepSeek turn with 384896
 * cached of 444742 prompt tokens showed a 46% hit rate instead of 86%.
 */
describe('usageFromOpenAI token normalisation', () => {
  it('reports input net of the cached part (standard cached_tokens)', () => {
    const usage = usageFromOpenAI({
      prompt_tokens: 444742,
      completion_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 384896 },
    });
    expect(usage).toEqual({ inputTokens: 59846, outputTokens: 1200, cacheReadTokens: 384896 });
    // The hit rate every consumer computes from this shape.
    expect(usage!.cacheReadTokens! / (usage!.inputTokens + usage!.cacheReadTokens!)).toBeCloseTo(0.865, 3);
  });

  it('reports input net of the cached part (DeepSeek prompt_cache_hit_tokens)', () => {
    const usage = usageFromOpenAI(
      { prompt_tokens: 100000, completion_tokens: 500, prompt_cache_hit_tokens: 90000 },
      VENDOR_PROFILES.deepseek,
    );
    expect(usage).toEqual({ inputTokens: 10000, outputTokens: 500, cacheReadTokens: 90000 });
  });

  it('leaves the prompt total alone when the provider reports no cache data', () => {
    const usage = usageFromOpenAI({ prompt_tokens: 5000, completion_tokens: 100 });
    expect(usage).toEqual({ inputTokens: 5000, outputTokens: 100 });
    expect(usage!.cacheReadTokens).toBeUndefined();
  });

  it('never returns a negative input count', () => {
    // A proxy that reports more cached tokens than prompt tokens would
    // otherwise produce a negative input and a nonsense hit rate.
    const usage = usageFromOpenAI({
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 1200 },
    });
    expect(usage!.inputTokens).toBe(0);
    expect(usage!.cacheReadTokens).toBe(1200);
  });

  it('returns undefined instead of a fabricated zero entry', () => {
    expect(usageFromOpenAI(undefined)).toBeUndefined();
    expect(usageFromOpenAI({ prompt_tokens: 0, completion_tokens: 0 })).toBeUndefined();
  });
});

describe('normalizeAnthropicUsage token normalisation', () => {
  it('leaves native input_tokens alone (already net of cache)', () => {
    const usage = normalizeAnthropicUsage({
      input_tokens: 1200,
      output_tokens: 40,
      cache_read_input_tokens: 8800,
      cache_creation_input_tokens: 200,
    });
    expect(usage).toEqual({
      inputTokens: 1200,
      outputTokens: 40,
      cacheReadTokens: 8800,
      cacheCreationTokens: 200,
    });
    // 8800 / (1200 + 8800)
    expect(usage!.cacheReadTokens! / (usage!.inputTokens! + usage!.cacheReadTokens!)).toBeCloseTo(0.88, 2);
  });

  it('subtracts the cached part when only an inclusive prompt_tokens is present', () => {
    // An OpenAI-compatible relay speaking the Anthropic protocol: it reports
    // `prompt_tokens` (inclusive) and no native `input_tokens`.
    const usage = normalizeAnthropicUsage({
      prompt_tokens: 50000,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 46000 },
    });
    expect(usage).toEqual({ inputTokens: 4000, outputTokens: 300, cacheReadTokens: 46000 });
  });

  it('never goes negative on an inconsistent proxy report', () => {
    // More cached tokens than prompt tokens cannot be split honestly, so the
    // prompt total is left intact rather than clamped into a smaller lie.
    const usage = normalizeAnthropicUsage({ prompt_tokens: 100, cache_read_input_tokens: 400 });
    expect(usage!.inputTokens).toBeGreaterThanOrEqual(0);
    expect(usage!.inputTokens).toBe(100);
  });
});
