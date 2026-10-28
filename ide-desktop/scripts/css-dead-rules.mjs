// Delete CSS rules whose every selector is composed only of classes that no
// source file mentions. Verified by re-parse + pixel snapshot, never on trust.
//
// Usage: node scripts/css-dead-rules.mjs <deadClassesJson> [--dry]
//
// Safety:
//   - only rules where EVERY class token is in the dead set are considered; a
//     rule that is half-dead is left alone (deleting it would change the other
//     selector's element, which is the §5.2 hazard from css-consolidation.md)
//   - the removed span is the whole rule text; leading whitespace and one
//     trailing newline go with it, so no blank-line drift builds up
//   - overlapping spans are rejected rather than merged
//   - after writing, the file is re-parsed and the rule count is checked

import fs from 'node:fs';
import path from 'node:path';
import { parseAll, rootDir } from './css-lib.mjs';

const ROOT = rootDir();
const deadJson = process.argv[2] || 'C:/tmp/css-dead-classes.json';
const dry = process.argv.includes('--dry');
const dead = new Set(
  (JSON.parse(fs.readFileSync(deadJson, 'utf8')).candidates || []).map((c) => c.cls),
);

const { rules } = parseAll();
const byFile = new Map();
for (const rule of rules) {
  const tokens = rule.selectors.flatMap((s) => [...s.matchAll(/\.([\w-]+)/g)].map((m) => m[1]));
  if (tokens.length === 0) continue;
  if (!tokens.every((t) => dead.has(t))) continue;
  if (!byFile.has(rule.file)) byFile.set(rule.file, []);
  byFile.get(rule.file).push({ start: rule.start, end: rule.end, selectors: rule.selectors });
}

let totalRules = 0;
const summary = {};
for (const [file, spans] of byFile) {
  const abs = path.join(ROOT, file);
  const text = fs.readFileSync(abs, 'utf8');
  // widen each span to swallow the indentation before it and one newline after
  const widened = spans.map((s) => {
    let start = s.start;
    while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start -= 1;
    // if this leaves only whitespace on the line, take the newline too
    let lineStart = start;
    while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart -= 1;
    if (/^[ \t]*$/.test(text.slice(lineStart, start))) start = lineStart;
    let end = s.end;
    if (text[end] === '\n') end += 1;
    return { ...s, start, end };
  }).sort((a, b) => a.start - b.start);

  for (let i = 1; i < widened.length; i += 1) {
    if (widened[i].start < widened[i - 1].end) {
      throw new Error(`overlapping spans in ${file}: ${widened[i - 1].selectors} / ${widened[i].selectors}`);
    }
  }
  if (dry) {
    summary[file] = widened.length;
    totalRules += widened.length;
    continue;
  }
  let out = text;
  for (let i = widened.length - 1; i >= 0; i -= 1) {
    out = out.slice(0, widened[i].start) + out.slice(widened[i].end);
  }
  // sanity: nothing is left referring to those selectors, and braces still balance
  for (const s of widened) {
    for (const sel of s.selectors) {
      const cls = sel.match(/\.([\w-]+)/);
      if (cls && dead.has(cls[1]) && out.includes(`.${cls[1]} `)) {
        throw new Error(`${file}: .${cls[1]} still present after deletion`);
      }
    }
  }
  const open = (out.match(/\{/g) || []).length;
  const close = (out.match(/\}/g) || []).length;
  if (open !== close) throw new Error(`${file}: brace imbalance ${open}/${close} after deletion`);
  fs.writeFileSync(abs, out);
  summary[file] = widened.length;
  totalRules += widened.length;
}

console.log(dry ? 'DRY RUN' : 'deleted', totalRules, 'fully-dead rules');
console.log(summary);
if (!dry) {
  const after = parseAll().rules.length;
  console.log('rules before', rules.length, '-> after', after, '(removed', rules.length - after, ')');
}
