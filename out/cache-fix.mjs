import fs from 'node:fs';

const path = process.argv[2] ?? 'C:/Users/34516/.aicode/usage.jsonl';
const rows = fs
  .readFileSync(path, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const hit = (r) => {
  const input = r.inputTokens || 0;
  const read = r.cacheReadTokens || 0;
  return input + read > 0 ? +((read / (input + read)) * 100).toFixed(1) : null;
};

const stat = (list) => {
  const input = list.reduce((s, r) => s + (r.inputTokens || 0), 0);
  const read = list.reduce((s, r) => s + (r.cacheReadTokens || 0), 0);
  return {
    turns: list.length,
    inputTokens: input,
    cacheReadTokens: read,
    hitPct: input + read > 0 ? +((read / (input + read)) * 100).toFixed(1) : null,
  };
};

// mock / fixture 永远不报 cache，混进来只会把均值稀释掉。
const isReal = (r) => r.provider !== 'mock' && r.model !== 'mock' && r.model !== 'fixture';
const real = rows.filter(isReal);

const byModel = {};
for (const r of real) (byModel[r.model] ??= []).push(r);

const byBaseUrl = {};
for (const r of real) (byBaseUrl[r.baseUrl || '(none)'] ??= []).push(r);

console.log(
  JSON.stringify(
    {
      file: path,
      allRows: rows.length,
      realRows: real.length,
      mockRows: rows.length - real.length,
      overall: stat(rows),
      realOnly: stat(real),
      byModel: Object.entries(byModel).map(([model, list]) => ({ model, ...stat(list) })),
      byBaseUrl: Object.entries(byBaseUrl).map(([baseUrl, list]) => ({ baseUrl, ...stat(list) })),
      realTurns: real.slice(-10).map((r) => ({
        ts: r.ts,
        model: r.model,
        toolCalls: r.toolCalls ?? null,
        tools: r.toolCount ?? null,
        scope: r.toolScope ?? null,
        inputTokens: r.inputTokens,
        cacheReadTokens: r.cacheReadTokens,
        hitPct: hit(r),
        predictedRate: r.localCachePredictedRate,
        reportedEff: r.cacheEfficiency,
        durationMs: r.durationMs,
      })),
    },
    null,
    2,
  ),
);
