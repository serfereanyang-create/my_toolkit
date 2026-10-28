import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const logPath = process.argv[2] ?? path.join(os.homedir(), '.aicode', 'usage.jsonl');
const raw = fs.readFileSync(logPath, 'utf8');
const rows = raw.split('\n').filter(Boolean).map((line) => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(Boolean);

const sessionArg = process.argv[3];
const pick = sessionArg ? rows.filter((r) => r.sessionId === sessionArg) : rows.slice(-40);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const per = pick.map((r, i) => {
  const input = num(r.inputTokens);
  const read = num(r.cacheReadTokens);
  // 真实命中率：被缓存覆盖的输入占全部提示 token 的比例
  const hitOfTotal = input > 0 ? read / input : null;
  // 与本地预测的差：预测会命中多少，实际命中多少
  const predicted = typeof r.localCachePredictedRate === 'number' ? r.localCachePredictedRate : null;
  return {
    i,
    ts: r.ts,
    model: r.model,
    provider: r.provider,
    baseUrl: r.baseUrl ?? '',
    input,
    read,
    hitOfTotal: hitOfTotal === null ? null : Number(hitOfTotal.toFixed(4)),
    reportedEff: typeof r.cacheEfficiency === 'number' ? Number(r.cacheEfficiency.toFixed(4)) : null,
    predicted: predicted === null ? null : Number(predicted.toFixed(4)),
    gap: hitOfTotal !== null && predicted !== null ? Number((predicted - hitOfTotal).toFixed(4)) : null,
    tools: r.toolCount ?? null,
    scope: r.toolScope ?? '',
    ms: r.durationMs ?? null,
  };
});

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const withRead = per.filter((p) => p.read > 0);
const totals = per.reduce((acc, p) => {
  acc.input += p.input; acc.read += p.read; return acc;
}, { input: 0, read: 0 });

console.log(JSON.stringify({
  log: logPath,
  rows: rows.length,
  analyzed: per.length,
  sessionIds: [...new Set(per.map((p) => p.model))],
  aggregate: {
    inputTokens: totals.input,
    cacheReadTokens: totals.read,
    hitOfTotal: totals.input ? Number((totals.read / totals.input).toFixed(4)) : null,
  },
  turnsWithCache: withRead.length,
  turnsWithZeroCache: per.length - withRead.length,
  avgHitAllTurns: avg(per.map((p) => p.hitOfTotal).filter((v) => v !== null)),
  avgPredicted: avg(per.map((p) => p.predicted).filter((v) => v !== null)),
  avgGap: avg(per.map((p) => p.gap).filter((v) => v !== null)),
  last12: per.slice(-12),
}, null, 2));
