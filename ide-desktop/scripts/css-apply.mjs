// Apply a css-plan.json edit set with exact-text verification.
// Usage: node scripts/css-apply.mjs C:/tmp/css-plan.json [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { rootDir } from './css-lib.mjs';

const ROOT = rootDir();
const planPath = process.argv[2] || 'C:/tmp/css-plan.json';
const dry = process.argv.includes('--dry');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

const byFile = new Map();
for (const e of plan.edits) {
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file).push(e);
}

let applied = 0;
const failures = [];
for (const [file, edits] of byFile) {
  const abs = path.join(ROOT, file);
  let text = fs.readFileSync(abs, 'utf8');
  // integrity: the edits were computed against this exact content
  for (const e of edits) {
    if (e.expected === undefined) continue;
    const current = text.slice(e.start, e.end);
    if (current !== e.expected) {
      failures.push({ file, kind: e.kind, selector: e.selector, start: e.start, expectedHead: e.expected.slice(0, 80), actualHead: current.slice(0, 80) });
    }
  }
  if (failures.length) continue;
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  // guard against overlapping spans
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].end > sorted[i - 1].start) {
      failures.push({ file, kind: 'overlap', a: sorted[i].selector, b: sorted[i - 1].selector });
    }
  }
  if (failures.length) continue;
  for (const e of sorted) {
    const replacement = e.kind === 'rewrite-rule' ? e.replacement : '';
    text = text.slice(0, e.start) + replacement + text.slice(e.end);
    applied += 1;
  }
  if (!dry) fs.writeFileSync(abs, text);
}
if (failures.length) {
  console.error('ABORT — verification failed, nothing written');
  console.error(JSON.stringify(failures.slice(0, 10), null, 1));
  process.exit(1);
}
console.log(dry ? 'dry run ok' : 'applied', applied, 'edits across', byFile.size, 'files');
for (const [file, edits] of byFile) {
  const kinds = {};
  for (const e of edits) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  console.log(' ', file, JSON.stringify(kinds));
}
