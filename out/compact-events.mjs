import fs from 'node:fs';

const path = process.argv[2] ?? '.aicode/sessions/sess_20261026115924_c6ffef29.trajectory.jsonl';
const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean);
const events = [];
for (const line of lines) {
  if (!line.includes('context_compaction')) continue;
  try {
    const row = JSON.parse(line);
    const walk = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 6) return;
      if (value.type === 'context_compaction') {
        events.push({ phase: value.phase, auto: value.auto, before: value.before, after: value.after, reason: value.reason });
        return;
      }
      for (const child of Object.values(value)) walk(child, depth + 1);
    };
    walk(row);
  } catch {
    events.push({ unparsed: line.slice(0, 120) });
  }
}
console.log(JSON.stringify({ trajectoryLines: lines.length, compactionEvents: events }, null, 2));
