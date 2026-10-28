// Build a consolidation plan: dead declarations to drop + safe merges.
// Usage: node scripts/css-plan.mjs [outJson] [--evidence=<tsx-class-combos.json>]
//
// Without --evidence, canCoMatch answers "could these two selectors match one
// element?" from CSS alone, where two different class selectors are assumed able
// to co-match (true in general, false in this app). With --evidence it also
// requires that, when both subjects are a single class token, that exact pair
// appears together on one element somewhere in the TSX inventory. A pair that
// never co-occurs is proof the blocking rule cannot apply to the same element,
// so the block is dismissed. The flag only ever REMOVES blockers — it never
// invents them — and the extracted inventory is a lower bound on co-occurrence,
// so the result is still conservative in the dangerous direction.
import fs from 'node:fs';
import {
  parseAll, FILES, coveredLonghands, specificity, cmpSpec, canCoMatch, declBeats,
} from './css-lib.mjs';

const OUT = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'C:/tmp/css-plan.json';
const EVIDENCE_PATH = (process.argv.find((a) => a.startsWith('--evidence=')) || '').slice('--evidence='.length);
const explainPath = (process.argv.find((a) => a.startsWith('--explain=')) || '').slice('--explain='.length);
const explainBlocks = [];
let evidencePairs = null;
let evidenceClasses = null;
if (EVIDENCE_PATH) {
  const ev = JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'));
  evidencePairs = new Set(Object.keys(ev.pairs || {}));
  evidenceClasses = new Set(Object.keys(ev.classes || {}));
}
// Rightmost compound, only when it is exactly one class token.
const singleClassSubject = (selector) => {
  const last = selector.trim().split(/[\s>+~]+/).pop() || '';
  const m = last.match(/^\.([\w-]+)$/);
  return m ? m[1] : null;
};
// Evidence-backed co-match: identical to canCoMatch unless both subjects are
// single class tokens with no observed occurrence together.
const canCoMatchWithEvidence = (a, b) => {
  if (!evidencePairs) return canCoMatch(a, b);
  if (!canCoMatch(a, b)) return false;
  const ca = singleClassSubject(a);
  const cb = singleClassSubject(b);
  if (!ca || !cb || ca === cb) return true;
  if (!evidenceClasses.has(ca) || !evidenceClasses.has(cb)) return true;
  return evidencePairs.has([ca, cb].sort().join('\u0000'));
};
const { rules, fileHashes, sourceText } = parseAll();

// The task excludes markdown-layout and keyboard-focus rules: both were
// polished by other agents in the same round, so we never edit them.
const SKIP_SELECTOR = /:focus(?:-visible|-within|-ring)?\b|(?:^|[\s>+~,])\.md(?:[\s.:#[>+~,]|$)/;
const isSkippedRule = (rule) => SKIP_SELECTOR.test(rule.selectorRaw);
const isOutlineDecl = (decl) => /^outline(-|$)/.test(decl.prop);
const skippedRules = rules.filter(isSkippedRule);

/* ── index every (selector, ctx, longhand) → entries ─────────── */
const ruleEntries = new Map(); // rule -> [{S, L, decl, spec}]
const bucket = new Map(); // key -> entries[]
for (const rule of rules) {
  const list = [];
  for (const S of rule.selectors) {
    const spec = specificity(S);
    for (const decl of rule.decls) {
      for (const L of coveredLonghands(decl.prop)) {
        const entry = { rule, S, L, decl, spec };
        list.push(entry);
        const key = `${rule.ctx}\u0000${S}\u0000${L}`;
        let arr = bucket.get(key);
        if (!arr) { arr = []; bucket.set(key, arr); }
        arr.push(entry);
      }
    }
  }
  ruleEntries.set(rule, list);
}

function winnerOf(ctx, S, L) {
  const arr = bucket.get(`${ctx}\u0000${S}\u0000${L}`);
  if (!arr || !arr.length) return null;
  let best = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (declBeats(arr[i], best)) best = arr[i];
  }
  return best;
}

/* ── phase 1: dead declarations ──────────────────────────────── */
// A declaration is dead when, for every selector of its rule, no longhand it
// covers is won by it. Fallback duplicates (same prop twice in one rule) are protected.
const deadDecls = new Set();
const deadReasons = new Map();
let protectedFallback = 0;
for (const rule of rules) {
  const propCount = new Map();
  for (const d of rule.decls) propCount.set(d.prop, (propCount.get(d.prop) || 0) + 1);
  for (const decl of rule.decls) {
    const isFallbackDup = propCount.get(decl.prop) > 1;
    let wins = false;
    for (const S of rule.selectors) {
      for (const L of coveredLonghands(decl.prop)) {
        const w = winnerOf(rule.ctx, S, L);
        if (w && w.decl === decl) { wins = true; break; }
      }
      if (wins) break;
    }
    if (!wins) {
      if (isFallbackDup) { protectedFallback++; continue; }
      deadDecls.add(decl);
    }
  }
}

/* ── survivors ───────────────────────────────────────────────── */
const survivorDecls = new Map(); // rule -> decl[]
for (const rule of rules) {
  const keep = rule.decls.filter((d) => !deadDecls.has(d));
  survivorDecls.set(rule, keep);
}

/* ── phase 2: safe merges ────────────────────────────────────── */
// Candidate groups: same (ctx, selector), ≥2 surviving single-selector rules.
const groupKey = (rule, S) => `${rule.ctx}\u0000${S}`;
const candidateGroups = new Map();
for (const rule of rules) {
  if (rule.selectors.length !== 1) continue;
  if (isSkippedRule(rule)) continue;
  if (survivorDecls.get(rule).length === 0) continue;
  const S = rule.selectors[0];
  const key = groupKey(rule, S);
  let arr = candidateGroups.get(key);
  if (!arr) { arr = []; candidateGroups.set(key, arr); }
  arr.push(rule);
}

// longhand → all entries (for risk checks)
const byLonghand = new Map();
for (const list of ruleEntries.values()) {
  for (const e of list) {
    let arr = byLonghand.get(e.L);
    if (!arr) { arr = []; byLonghand.set(e.L, arr); }
    arr.push(e);
  }
}

function valueFor(entryList, L) {
  // The value a declaration contributes to longhand L (raw value is fine for compare)
  return entryList.find((e) => e.L === L)?.decl.value ?? null;
}

const mergePlans = [];
const blocked = [];
for (const [key, group] of candidateGroups) {
  if (group.length < 2) continue;
  const sorted = [...group].sort((a, b) => b.order - a.order);
  const target = sorted[0];
  const S = target.selectors[0];
  const ctx = target.ctx;
  const moves = [];
  const failures = [];
  for (const src of sorted.slice(1)) {
    const decls = survivorDecls.get(src);
    const srcMoves = [];
    for (const decl of decls) {
      // safety: crossing other rules with equal specificity that can co-match
      const problems = [];
      for (const L of coveredLonghands(decl.prop)) {
        const entries = byLonghand.get(L) || [];
        for (const e of entries) {
          if (e.rule === src || e.rule === target) continue;
          if (e.decl === decl) continue;
          if (e.rule.ctx !== ctx) { /* different context: still may co-apply */ }
          if (e.rule.order <= Math.min(src.order, target.order) || e.rule.order >= Math.max(src.order, target.order)) continue;
          if ((e.decl.important ? 1 : 0) !== (decl.important ? 1 : 0)) continue;
          if (cmpSpec(e.spec, specificity(S)) !== 0) continue;
          if (!canCoMatchWithEvidence(e.S, S)) continue;
          if (valueFor(entries.filter((x) => x.rule === e.rule && x.S === e.S), L) === decl.value) continue;
          problems.push({ L, by: e.rule.file, order: e.rule.order, selector: e.S });
        }
      }
      if (problems.length) {
        // The plan keeps only 3 sample blockers per declaration to stay readable.
        // --explain=<path> dumps every blocker so a classification tool can reason
        // over the complete set instead of a sample.
        failures.push({ decl: decl.raw, prop: decl.prop, problems: problems.slice(0, 3), n: problems.length });
        if (explainPath) explainBlocks.push({ selector: S, ctx, prop: decl.prop, decl: decl.raw, problems });
      } else {
        srcMoves.push(decl);
      }
    }
    if (srcMoves.length === decls.length) {
      moves.push({ from: src, decls: srcMoves });
    } else if (srcMoves.length) {
      failures.push({ partial: true, from: src.file, moved: srcMoves.length, kept: decls.length - srcMoves.length });
    }
  }
  if (moves.length) {
    mergePlans.push({
      selector: S, ctx, targetRule: target,
      targetDecls: survivorDecls.get(target),
      moves: moves.map((m) => ({ rule: m.from, decls: m.decls })),
      failures,
      fullyConsolidated: moves.length === sorted.length - 1 && failures.length === 0,
    });
  } else if (failures.length) {
    blocked.push({ selector: S, ctx, failures });
  }
}

/* ── removal spans (safe text edits) ─────────────────────────── */
function lineStart(text, off) {
  let i = off;
  while (i > 0 && text[i - 1] !== '\n') i--;
  return i;
}
function lineEnd(text, off) {
  let i = off;
  while (i < text.length && text[i] !== '\n') i++;
  return i;
}
function declRemovalSpan(decl) {
  const rule = decl.rule;
  const text = sourceText[rule.file];
  let start = decl.start;
  let end = decl.end;
  if (text[end] === ';') end += 1;
  const ls = lineStart(text, start);
  const prefix = text.slice(ls, start);
  if (/^\s*$/.test(prefix) && ls >= rule.start) {
    // declaration occupies its own line: drop the whole line
    const le = lineEnd(text, end);
    if (/^\s*(\/\*.*)?$/.test(text.slice(end, le))) {
      return { start: ls, end: le + (text[le] === '\n' ? 1 : 0) };
    }
    return { start: ls, end };
  }
  // inline declaration (single-line rule): trim leading spaces only, so that
  // consecutive removals never claim the same separator
  while (start > rule.start && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
  return { start, end };
}
function ruleRemovalSpan(rule) {
  const text = sourceText[rule.file];
  let start = rule.start;
  let end = rule.end;
  const ls = lineStart(text, start);
  if (/^\s*$/.test(text.slice(ls, start))) start = ls;
  if (text[end] === '\n') {
    end += 1;
  } else {
    while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
    while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
  }
  return { start, end };
}

/* ── plan output ─────────────────────────────────────────────── */
const mergeSourceRules = new Set();
const mergeTargetRules = new Set();
for (const plan of mergePlans) {
  mergeTargetRules.add(plan.targetRule);
  for (const m of plan.moves) mergeSourceRules.add(m.rule);
}

const edits = [];
// whole-rule deletions (all decls dead) + dead declarations
for (const rule of rules) {
  if (mergeSourceRules.has(rule) || mergeTargetRules.has(rule)) continue;
  if (isSkippedRule(rule)) continue;
  const keep = survivorDecls.get(rule);
  if (keep.length === 0 && rule.decls.every((d) => deadDecls.has(d))) {
    const span = ruleRemovalSpan(rule);
    edits.push({
      kind: 'delete-rule',
      file: rule.file,
      selector: rule.selectorRaw,
      ctx: rule.ctx,
      raw: rule.raw,
      ...span,
      expected: sourceText[rule.file].slice(span.start, span.end),
    });
  } else {
    for (const d of rule.decls) {
      if (deadDecls.has(d) && !isOutlineDecl(d)) {
        const span = declRemovalSpan(d);
        edits.push({
          kind: 'delete-decl',
          file: rule.file,
          selector: rule.selectorRaw,
          ctx: rule.ctx,
          prop: d.prop,
          value: d.value,
          raw: d.raw,
          ...span,
          expected: sourceText[rule.file].slice(span.start, span.end),
        });
      }
    }
  }
}

// merges: delete source rules, rewrite the target block with the merged
// declaration set ordered by (important, original document order).
function withSemicolon(raw) {
  const trimmed = raw.trim().replace(/;\s*$/, '');
  return `${trimmed};`;
}
for (const plan of mergePlans) {
  for (const m of plan.moves) {
    const span = ruleRemovalSpan(m.rule);
    edits.push({
      kind: 'delete-rule',
      file: m.rule.file,
      selector: m.rule.selectorRaw,
      ctx: m.rule.ctx,
      raw: m.rule.raw,
      ...span,
      expected: sourceText[m.rule.file].slice(span.start, span.end),
      viaMerge: plan.selector,
    });
  }
  const target = plan.targetRule;
  const decls = [
    ...plan.targetDecls.map((d) => ({ d, order: target.order })),
    ...plan.moves.flatMap((m) => m.decls.map((d) => ({ d, order: m.rule.order }))),
  ];
  decls.sort((a, b) => ((a.d.important ? 1 : 0) - (b.d.important ? 1 : 0)) || (a.order - b.order) || (a.d.index - b.d.index));
  const head = target.raw.slice(0, target.raw.indexOf('{')).trimEnd();
  const body = decls.map((x) => withSemicolon(x.d.raw)).join(' ');
  edits.push({
    kind: 'rewrite-rule',
    file: target.file,
    selector: target.selectorRaw,
    ctx: target.ctx,
    start: target.start,
    end: target.end,
    expected: target.raw,
    replacement: `${head} { ${body} }`,
    removedProps: plan.targetDecls.filter((d) => deadDecls.has(d)).map((d) => d.prop),
    movedFrom: plan.moves.map((m) => m.rule.file),
    viaMerge: plan.selector,
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  fileHashes,
  rules: rules.length,
  deadDecls: deadDecls.size,
  protectedFallback,
  skippedRules: skippedRules.map((r) => ({ file: r.file, selector: r.selectorRaw, ctx: r.ctx })),
  mergeGroups: mergePlans.length,
  fullyConsolidated: mergePlans.filter((p) => p.fullyConsolidated).length,
  blockedGroups: blocked.length,
  edits,
  mergePlans: mergePlans.map((p) => ({
    selector: p.selector,
    ctx: p.ctx,
    target: {
      file: p.targetRule.file,
      order: p.targetRule.order,
      raw: p.targetRule.raw,
      decls: p.targetDecls.map((d) => d.raw),
    },
    moves: p.moves.map((m) => ({ from: m.rule.file, order: m.rule.order, raw: m.rule.raw, decls: m.decls.map((d) => d.raw) })),
    failures: p.failures,
    fullyConsolidated: p.fullyConsolidated,
  })),
  blocked,
};

fs.mkdirSync(require_dir(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

function require_dir(p) {
  return p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
}

console.log('rules', rules.length);
console.log('dead declarations (phase 1):', deadDecls.size, '| protected fallback:', protectedFallback);
const ruleDeletes = edits.filter((e) => e.kind === 'delete-rule').length;
const declDeletes = edits.filter((e) => e.kind === 'delete-decl').length;
console.log('delete-rule edits:', ruleDeletes, 'delete-decl edits:', declDeletes);
console.log('merge groups:', mergePlans.length, 'fully consolidated:', report.fullyConsolidated);
console.log('blocked groups:', blocked.length);
const byFile = {};
for (const e of edits) {
  const k = `${e.file}:${e.kind}`;
  byFile[k] = (byFile[k] || 0) + 1;
}
console.log(byFile);
console.log('wrote', OUT);
if (explainPath) {
  fs.writeFileSync(explainPath, JSON.stringify({ generatedAt: new Date().toISOString(), evidence: EVIDENCE_PATH || null, blocks: explainBlocks }, null, 1));
  console.log('wrote', explainPath, `(${explainBlocks.length} blocked declarations, full blocker lists)`);
}
