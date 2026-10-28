import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const log = path.join(os.homedir(), '.aicode', 'usage.jsonl');
const rows = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// real-provider turns only (drop mock / fixture)
const real = rows.filter((r) => r.provider !== 'mock' && r.provider !== 'fixture');

const grouped = new Map();
for (const r of real) {
  const k = `${r.provider}@${(() => { try { return new URL(r.baseUrl).host; } catch { return r.baseUrl || '?'; } })()}`;
  grouped.set(k, [...(grouped.get(k) ?? []), r]);
}

const out = [];
for (const [endpoint, list] of grouped) {
  let prevTs = null;
  const turns = list.map((r) => {
    const ts = Date.parse(r.ts);
    const gapMin = prevTs === null ? null : +((ts - prevTs) / 60000).toFixed(2);
    prevTs = ts;
    const read = r.cacheReadTokens ?? 0;
    const inp = r.inputTokens ?? 0;
    return {
      ts: r.ts,
      model: r.model,
      session: (r.sessionId ?? '').slice(-8),
      input: inp,
      read,
      eff: inp + read > 0 ? +(read / (inp + read) * 100).toFixed(1) : null,
      predictedPct: r.localCachePredictedRate === undefined ? null : +(r.localCachePredictedRate * 100).toFixed(1),
      gapSincePrevMin: gapMin,
      turnMs: r.durationMs,
      gapVsTtl: gapMin === null ? null : gapMin > 5 ? 'EXCEEDS 5m TTL' : 'within 5m',
      tools: r.toolCount,
      scope: r.toolScope,
    };
  });
  const sumIn = list.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
  const sumRead = list.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0);
  const sumOut = list.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
  const avgPred = list.filter((r) => typeof r.localCachePredictedRate === 'number');
  out.push({
    endpoint,
    turns: list.length,
    sumInput: sumIn,
    sumCacheRead: sumRead,
    sumOutput: sumOut,
    realHitRatePct: sumIn + sumRead > 0 ? +(sumRead / (sumIn + sumRead) * 100).toFixed(1) : null,
    avgPredictedPct: avgPred.length ? +(avgPred.reduce((s, r) => s + r.localCachePredictedRate, 0) / avgPred.length * 100).toFixed(1) : null,
    toolCounts: [...new Set(list.map((r) => r.toolCount))],
    longestTurnMin: +(Math.max(...list.map((r) => r.durationMs ?? 0)) / 60000).toFixed(2),
    detail: turns,
  });
}

console.log(JSON.stringify({ totalRows: rows.length, realTurns: real.length, endpoints: out }, null, 2));
