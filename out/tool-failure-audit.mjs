import fs from 'node:fs';

const path = process.argv[2] ?? '.aicode/sessions/sess_20261026115924_c6ffef29.json';
const session = JSON.parse(fs.readFileSync(path, 'utf8'));
const calls = Array.isArray(session.toolCalls) ? session.toolCalls : [];

const total = calls.length;
const failed = calls.filter((c) => c.ok !== true);
const byTool = new Map();
for (const c of calls) {
  const t = c.tool ?? '?';
  const g = byTool.get(t) ?? { total: 0, fail: 0 };
  g.total += 1;
  if (c.ok !== true) g.fail += 1;
  byTool.set(t, g);
}

// Bucket the failure reasons so the shape of the problem is visible.
const bucket = (text) => {
  const s = String(text ?? '');
  if (/blocked destructive command pattern|已拦截/.test(s)) return 'blocked-by-policy';
  if (/找不到您的文件|not recognized|cannot find|ENOENT|does not exist/.test(s)) return 'wrong-path/platform-cmd';
  if (/cancelled by user|已取消|aborted|取消/.test(s)) return 'cancelled';
  if (/timed out|timeout|超时/.test(s)) return 'timeout';
  if (/invalid input|无效|missing|required|unexpected|Expected/.test(s)) return 'invalid-input';
  if (/maxBuffer/.test(s)) return 'output-too-large';
  return 'other';
};
const reasons = new Map();
for (const c of failed) {
  const b = bucket(c.output);
  reasons.set(b, (reasons.get(b) ?? 0) + 1);
}

// Consecutive-failure runs: how often does it fail back to back?
let streak = 0, maxStreak = 0;
for (const c of calls) {
  if (c.ok !== true) { streak += 1; maxStreak = Math.max(maxStreak, streak); }
  else streak = 0;
}

console.log(JSON.stringify({
  toolCalls: total,
  failed: failed.length,
  failRate: total ? +(failed.length / total * 100).toFixed(1) : 0,
  maxConsecutiveFailures: maxStreak,
  byReason: Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1])),
  byTool: [...byTool].sort((a, b) => b[1].fail - a[1].fail)
    .map(([tool, g]) => ({ tool, ...g, rate: +(g.fail / g.total * 100).toFixed(0) })),
  firstFailures: failed.slice(0, 8).map((c) => ({
    tool: c.tool,
    output: String(c.output ?? '').replace(/\s+/g, ' ').slice(0, 110),
  })),
}, null, 2));
