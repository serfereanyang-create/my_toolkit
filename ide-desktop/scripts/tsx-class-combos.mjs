// Extract real className combinations from TSX/TS sources so that
// canCoMatch can be answered from evidence instead of from "a class selector
// could always match any element".
//
// Output: C:/tmp/tsx-class-combos.json
//   classes:  every class token that appears anywhere
//   pairs:    sorted "a\u0000b" for every pair observed on ONE element
//   singles:  class tokens that appear alone in at least one site
//   files:    token -> [files that mention it]
//
// Caveats recorded in the output so a reader is not misled:
//   - template literals and conditionals mean an element may take either side
//     of a ternary; we record BOTH sides as "may appear together" (the safe
//     direction: we only claim co-occurrence, never non-co-occurrence, from a
//     ternary).
//   - dynamic composition (clsx(...), `x ${y}`) records the static tokens it
//     contains, and a `dynamicSites` count so the reader knows the extraction
//     is a lower bound on what can co-occur.

import fs from 'node:fs';
import path from 'node:path';
import { parseAll } from './css-lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = process.argv[2] || 'C:/tmp/tsx-class-combos.json';

// Every class token the stylesheets actually define. Step 5 below uses this as a
// filter so that a bare string in the source is only read as a class LIST when
// every word in it is a real class name.
const cssClassTokens = new Set();
for (const rule of parseAll().rules) {
  for (const selector of rule.selectors) {
    for (const m of selector.matchAll(/\.([\w-]+)/g)) cssClassTokens.add(m[1]);
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out);
    } else if (/\.(tsx|jsx|ts)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(path.join(ROOT, 'src'));

// A class token: lowercase-ish, may contain dashes/underscores/digits.
const TOKEN = /^[a-zA-Z][\w-]*$/;

const combos = new Map(); // sorted pair key -> Set(files)
const classes = new Set();
const tokenFiles = new Map();
let dynamicSites = 0;
let sites = 0;

function noteSite(tokens, file) {
  const clean = [...new Set(tokens.filter((t) => TOKEN.test(t)))];
  if (clean.length === 0) return;
  sites += 1;
  for (const t of clean) {
    classes.add(t);
    let arr = tokenFiles.get(t);
    if (!arr) { arr = new Set(); tokenFiles.set(t, arr); }
    arr.add(file);
  }
  // every pair inside one site is a hard co-occurrence
  for (let i = 0; i < clean.length; i += 1) {
    for (let j = i + 1; j < clean.length; j += 1) {
      const key = [clean[i], clean[j]].sort().join('\u0000');
      let set = combos.get(key);
      if (!set) { set = new Set(); combos.set(key, set); }
      set.add(file);
    }
  }
}

// Split a static class string into tokens. Handles "a b" and multi-line.
const splitStatic = (s) => s.split(/[\s'",`]+/).filter(Boolean);

const filesSeen = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  let touched = false;

  // 1. className="a b c"  and  className='a b'
  for (const m of text.matchAll(/className\s*=\s*(["'])((?:(?!\1).)*)\1/gs)) {
    noteSite(splitStatic(m[2]), rel);
    touched = true;
  }

  // 2. className={`a ${x} b`}  — static tokens around the interpolations
  for (const m of text.matchAll(/className\s*=\s*\{\s*`([^`]*)`\s*\}/gs)) {
    const inner = m[1];
    // split on ${...} leaving the literal fragments
    const frags = inner.split(/\$\{[^}]*\}/g);
    const staticTokens = [];
    for (const frag of frags) staticTokens.push(...splitStatic(frag));
    // tokens produced by an embedded ternary: `a ${c ? 'b' : 'c'}`
    const ternaries = [...inner.matchAll(/\?\s*(['"])((?:(?!\1).)*)\1\s*:\s*(['"])((?:(?!\3).)*)\3/g)];
    for (const t of ternaries) {
      noteSite([...staticTokens, ...splitStatic(t[2])], rel);
      noteSite([...staticTokens, ...splitStatic(t[4])], rel);
    }
    if (ternaries.length === 0) noteSite(staticTokens, rel);
    if (/\$\{/.test(inner)) dynamicSites += 1;
    touched = true;
  }

  // 3. className={cond ? "a" : "b"}  and  className={cond && "a"}
  for (const m of text.matchAll(/className\s*=\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/gs)) {
    const expr = m[1];
    const literals = [...expr.matchAll(/(['"])((?:(?!\1).)*)\1/g)].map((x) => x[2]);
    if (literals.length === 0) continue;
    const statics = literals.flatMap(splitStatic);
    noteSite(statics, rel);
    if (/\b(clsx|classNames|cn)\s*\(/.test(expr)) dynamicSites += 1;
    touched = true;
  }

  // 4. clsx('a', cond && 'b', ...) anywhere (not only in className)
  for (const m of text.matchAll(/\b(?:clsx|classNames|cn)\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gs)) {
    const literals = [...m[1].matchAll(/(['"])((?:(?!\1).)*)\1/g)].map((x) => x[2]);
    if (literals.length) {
      noteSite(literals.flatMap(splitStatic), rel);
      dynamicSites += 1;
      touched = true;
    }
  }

  // 5. Class lists returned from helper functions, e.g.
  //      if (active) return 'cmd-row active';
  //    These never appear next to `className=`, so steps 1-4 miss them and the
  //    token looks "dynamic" to the merge proof. Recover a string literal only
  //    when EVERY token in it is already a known CSS class — that keeps ordinary
  //    prose and i18n strings out, at the cost of missing a brand-new class,
  //    which fails safe (it stays a blocker rather than being dismissed).
  for (const m of text.matchAll(/(['"])([a-z][\w-]*(?: [a-z][\w-]*)+)\1/g)) {
    const tokens = m[2].split(' ');
    if (tokens.length < 2) continue;
    if (!tokens.every((t) => cssClassTokens.has(t))) continue;
    noteSite(tokens, rel);
    touched = true;
  }

  if (touched) filesSeen.push(rel);
}

const pairs = {};
for (const [key, set] of combos) pairs[key] = [...set];
const classesOut = {};
for (const t of [...classes].sort()) classesOut[t] = [...(tokenFiles.get(t) || [])].sort();

const report = {
  generatedAt: new Date().toISOString(),
  caveats: [
    'This is a LOWER BOUND on co-occurrence: a pair present here definitely appears together on one element; a pair absent here MAY still co-occur via dynamic composition.',
    'Ternary branches are recorded as co-occurring with their shared static tokens, which is the conservative direction for a merge proof.',
    `dynamicSites=${dynamicSites} sites used template interpolation or a class-composition helper; their runtime class sets can be wider than recorded.`,
  ],
  counts: { files: filesSeen.length, sites, classes: classes.size, pairs: Object.keys(pairs).length, dynamicSites },
  classes: classesOut,
  pairs,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(`files ${filesSeen.length} sites ${sites} classes ${classes.size} pairs ${Object.keys(pairs).length} dynamicSites ${dynamicSites}`);
console.log(`wrote ${OUT}`);
