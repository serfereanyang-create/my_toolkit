// Find CSS class selectors that no source file mentions.
//
// Usage: node scripts/css-dead-classes.mjs [combosJson] [outJson]
//
// The test is deliberately the weakest sufficient one: does the literal token
// appear ANYWHERE in the TypeScript/TSX source? That is correct for classes that
// are never written as `className="..."` — measured examples in this codebase:
//   `{ running: { className: 'sup-status-running' } }`  (object property value)
//   `linesDecorationsClassName: 'bookmark-gutter-icon'`  (Monaco option)
// A stricter extractor that only looked at `className=` reported both as dead.
//
// Remaining false positives are dynamic composition (`ip-agent-${status}`), which
// no literal search can see. Classes whose name starts with an interpolated
// prefix are excluded and counted, so the result stays a lower bound.
//
// Nothing is deleted. This prints the candidate set.

import fs from 'node:fs';
import path from 'node:path';
import { parseAll } from './css-lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = process.argv[3] || 'C:/tmp/css-dead-classes.json';

// Collect interpolated prefixes: `ip-agent-${x}` -> "ip-agent-", `${a}-b` -> "-b"
const dynamicPrefixes = new Set();
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out);
    } else if (/\.(tsx|jsx|ts|cjs|mjs|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const sourceFiles = walk(path.join(ROOT, 'src'))
  .concat(walk(path.join(ROOT, 'electron')))
  // scripts/ matters: the preview fixtures under scripts/*.tsx render REAL
  // components with real class names. Leaving them out made
  // `.workspace-preview-quality` look dead and a pixel snapshot caught the
  // deletion changing 752 computed styles on the ws fixture pages.
  .concat(walk(path.join(ROOT, 'scripts')))
  .concat(fs.existsSync(path.join(ROOT, 'index.html')) ? [path.join(ROOT, 'index.html')] : []);
// One big haystack: presence anywhere is enough to prove a class is reachable.
let haystack = '';
for (const file of sourceFiles) haystack += fs.readFileSync(file, 'utf8') + '\n';
// Prefixes that an interpolation can extend into a class name:
//   `ip-agent-${status}` -> "ip-agent-"   (hyphen before the brace)
//   `tag-chip c${idx}`   -> "c"           (no hyphen — the whole suffix is dynamic)
// Requiring a hyphen missed the second form and reported `c1`..`c6` / `b0`..`b4`
// as dead CSS when they are built from an index.
for (const m of haystack.matchAll(/([\w-]*)\$\{/g)) {
  const prefix = m[1] || '';
  if (prefix) dynamicPrefixes.add(prefix);
}

const byClass = new Map(); // class -> {files, selectors}
for (const rule of parseAll().rules) {
  for (const selector of rule.selectors) {
    for (const m of selector.matchAll(/\.([\w-]+)/g)) {
      const cls = m[1];
      let rec = byClass.get(cls);
      if (!rec) { rec = { files: new Set(), selectors: new Set() }; byClass.set(cls, rec); }
      rec.files.add(rule.file);
      rec.selectors.add(selector);
    }
  }
}

const unreferenced = [];
const dynamicExcluded = [];
const referenced = [];
for (const [cls, rec] of byClass) {
  // word-boundary-free substring test: `cmd-row` inside "cmd-row active" counts.
  if (haystack.includes(cls)) { referenced.push(cls); continue; }
  // A class is dynamically reachable when some interpolation prefix could extend
  // into it. A prefix ending in "-" is a namespace (`ip-agent-`), so anything
  // after it is plausible. A bare prefix (`c`) is only accepted when the
  // remainder looks like an index — a short token with no further hyphen, so
  // `c5` matches but `core-button` does not.
  const prefix = [...dynamicPrefixes].find((p) => {
    if (!p || !cls.startsWith(p) || cls === p) return false;
    const rest = cls.slice(p.length);
    if (p.endsWith('-')) return true;
    return !rest.includes('-') && rest.length <= 8;
  });
  if (prefix) { dynamicExcluded.push({ cls, prefix, files: [...rec.files] }); continue; }
  unreferenced.push({ cls, files: [...rec.files], selectors: [...rec.selectors].slice(0, 3) });
}

// A class defined but only ever used as a state modifier alongside a live class
// (`active`, `disabled`) is legitimately unreferenced in source: it is composed
// at runtime. Report those separately rather than as candidates for deletion.
const STATE_TOKENS = new Set([
  'active', 'disabled', 'selected', 'open', 'closed', 'hidden', 'visible', 'dirty',
  'running', 'idle', 'error', 'warn', 'warning', 'ok', 'loading', 'empty', 'filled',
  'primary', 'secondary', 'danger', 'success', 'muted', 'compact', 'wide', 'narrow',
]);

const candidates = unreferenced.filter((u) => !STATE_TOKENS.has(u.cls));
const stateTokens = unreferenced.filter((u) => STATE_TOKENS.has(u.cls));

// Group candidates by their leading token family, so the report can say
// "the whole git-pr-* family is gone" rather than listing 40 names.
const families = new Map();
for (const c of candidates) {
  const fam = c.cls.split('-').slice(0, 2).join('-');
  if (!families.has(fam)) families.set(fam, []);
  families.get(fam).push(c.cls);
}
const familyList = [...families].sort((a, b) => b[1].length - a[1].length)
  .map(([fam, members]) => ({ family: fam, count: members.length, members: members.slice(0, 8) }));

const report = {
  generatedAt: new Date().toISOString(),
  counts: {
    cssClasses: byClass.size,
    referencedInSource: referenced.length,
    unreferenced: unreferenced.length,
    unreferencedAfterStateFilter: candidates.length,
    stateTokens: stateTokens.length,
    dynamicExcluded: dynamicExcluded.length,
  },
  method: 'A class counts as referenced when its literal token appears anywhere under src/ or electron/ (ts, tsx, tsx-in-css, cjs, mjs, css, html). This catches object-property values and Monaco option strings that a className-only extractor would miss.',
  caveat: 'Lower bound on dead CSS. A class excluded as dynamic is proven reachable only if the interpolation prefix is real; a class in `candidates` may still be built by string concatenation this tool does not model. Eyeball before deleting.',
  families: familyList,
  candidates: candidates.sort((a, b) => a.cls.localeCompare(b.cls)),
  stateTokens: stateTokens.map((s) => s.cls).sort(),
  dynamicExcludedSample: dynamicExcluded.sort((a, b) => b.cls.length - a.cls.length).slice(0, 40),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.counts));
console.log('top families:', familyList.slice(0, 12).map((f) => `${f.family}(${f.count})`).join(' '));
console.log('wrote', OUT);
