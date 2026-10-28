// Re-adjudicate the 49 blocked CSS merge groups using real TSX class-combination
// evidence, instead of canCoMatch's "any class selector could match any element".
//
// Usage: node scripts/css-blocked-evidence.mjs [planJson] [combosJson] [outJson]
//
// For each blocked group we ask a narrower question than canCoMatch does:
//   "can one element be matched by BOTH the group selector and the blocking
//    selector?"  In this app the answer is usually no, and we can show it.
//
// The blocker is dismissed only when we can name why:
//   TAG        — different element types (div vs button), canCoMatch already knew
//   ID         — different ids
//   SINGLE     — both sides are a single class token and that pair never appears
//                in TSX, and neither token is composed dynamically
//   DYNAMIC    — a token is composed dynamically -> NOT dismissed, stays blocked
//   COMPLEX    — at least one side is a compound/descendant selector; we do not
//                dismiss on class evidence alone
//
// Output: per-group verdicts + a summary the report can quote verbatim.

import fs from 'node:fs';
import { parseAll, specificity } from './css-lib.mjs';

const PLAN = process.argv[2] || 'C:/tmp/css-plan-now.json';
const COMBOS = process.argv[3] || 'C:/tmp/tsx-class-combos.json';
const OUT = process.argv[4] || 'C:/tmp/css-blocked-evidence.json';

const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
const combos = JSON.parse(fs.readFileSync(COMBOS, 'utf8'));
const pairSet = new Set(Object.keys(combos.pairs));
const classSet = new Set(Object.keys(combos.classes));

// A token is "dynamically composed" when it never appears as a static literal but
// the fixture still lists it; we treat the reverse too: if composition happens at
// all in the app, a token that appears in NO pair may still be paired at runtime.
// So the honest position: a single-class dismissal needs the pair absent AND no
// dynamic composition anywhere near those tokens (i.e. both tokens are static in
// at least one site together with other classes). We approximate that by requiring
// both tokens to be present in the static class inventory.
const dynamicRisk = combos.counts.dynamicSites > 0;

function subjectType(selector) {
  const m = selector.match(/(^|[\s>+~])([a-zA-Z][\w-]*)/);
  if (!m) return null;
  const tag = m[2];
  if (['div', 'span', 'button', 'input', 'a', 'p', 'ul', 'li', 'svg', 'section', 'header', 'footer', 'main', 'nav', 'textarea', 'select', 'option', 'label', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img', 'pre', 'code', 'form', 'aside', 'article'].includes(tag)) return tag;
  return null;
}

function subjectIds(selector) {
  return [...selector.matchAll(/#([\w-]+)/g)].map((m) => m[1]);
}

// Reduce a selector to its subject (rightmost compound) and, if that compound is a
// single class, return that class token. Anything more complex returns null.
function subjectSingleClass(selector) {
  const last = selector.trim().split(/[\s>+~]+/).pop() || '';
  const m = last.match(/^\.([\w-]+)$/);
  return m ? m[1] : null;
}

const verdicts = [];
const tally = { dismissed: 0, staysBlocked: 0 };
const byReason = {};

for (const group of plan.blocked) {
  const groupSelector = group.selector;
  const groupClass = subjectSingleClass(groupSelector);
  const groupType = subjectType(groupSelector);
  const groupIds = subjectIds(groupSelector);

  const failures = [];
  let hasPartial = false;
  for (const failure of group.failures || []) {
    // A `partial` entry means the winning rule has several selectors and only some
    // of them can move (css-consolidation.md §5.2): that rule cannot be edited
    // selector-by-selector, so the group stays blocked regardless of class evidence.
    if ('partial' in failure) {
      hasPartial = true;
      failures.push({
        partial: true,
        partialFrom: failure.from,
        partialMoved: failure.moved,
        partialKept: failure.kept,
        dismissed: [],
        kept: [],
        recoverable: false,
      });
      continue;
    }
    const keptProblems = [];
    const dismissedProblems = [];
    for (const problem of failure.problems || []) {
      const blocker = problem.selector;
      const blockerClass = subjectSingleClass(blocker);
      const blockerType = subjectType(blocker);
      const blockerIds = subjectIds(blocker);

      let reason = null;
      let note = '';

      if (groupType && blockerType && groupType !== blockerType) {
        reason = 'TAG';
        note = `${groupType} vs ${blockerType}`;
      } else if (groupIds.length && blockerIds.length && !groupIds.some((i) => blockerIds.includes(i))) {
        reason = 'ID';
        note = groupIds.join(',') + ' vs ' + blockerIds.join(',');
      } else if (groupClass && blockerClass && groupClass !== blockerClass) {
        const key = [groupClass, blockerClass].sort().join('\u0000');
        if (pairSet.has(key)) {
          reason = null;
          note = `pair ${groupClass}+${blockerClass} DOES co-occur (${(combos.pairs[key] || []).join(', ')})`;
        } else if (!classSet.has(groupClass) || !classSet.has(blockerClass)) {
          reason = 'DYNAMIC';
          note = `token missing from static inventory: ${classSet.has(groupClass) ? blockerClass : groupClass}`;
        } else {
          reason = 'SINGLE';
          note = `${groupClass} + ${blockerClass} never on one element in TSX`;
        }
      } else {
        reason = 'COMPLEX';
        note = 'subject is not a single class on at least one side';
      }

      if (reason === 'TAG' || reason === 'ID' || reason === 'SINGLE') {
        dismissedProblems.push({ ...problem, dismissedBy: reason, note });
      } else {
        keptProblems.push({ ...problem, staysBlockedBy: reason || 'COOCCUR', note });
      }
    }
    if (keptProblems.length === 0) {
      byReason[`resolved:${(dismissedProblems[0] || {}).dismissedBy || 'unknown'}`] = (byReason[`resolved:${(dismissedProblems[0] || {}).dismissedBy || 'unknown'}`] || 0) + 1;
    } else {
      byReason['kept'] = (byReason['kept'] || 0) + 1;
    }
    failures.push({
      prop: failure.prop,
      decl: failure.decl,
      n: failure.n,
      dismissed: dismissedProblems,
      kept: keptProblems,
      recoverable: keptProblems.length === 0,
    });
  }

  const recoverable = failures.length > 0 && failures.every((f) => f.recoverable);
  if (recoverable) tally.dismissed += 1; else tally.staysBlocked += 1;
  verdicts.push({
    selector: groupSelector,
    ctx: group.ctx,
    recoverable,
    reason: recoverable
      ? `all ${failures.reduce((n, f) => n + f.dismissed.length, 0)} blocker(s) shown unable to co-match`
      : `${failures.filter((f) => !f.recoverable).length}/${failures.length} declaration(s) still have a live blocker`,
    failures,
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  inputs: { plan: PLAN, combos: COMBOS },
  evidenceCaveat: combos.caveats,
  dynamicRisk,
  summary: {
    blockedGroups: plan.blocked.length,
    recoverable: tally.dismissed,
    stillBlocked: tally.staysBlocked,
    problemVerdicts: byReason,
    tsxPairsKnown: Object.keys(combos.pairs).length,
    tsxSites: combos.counts.sites,
  },
  verdicts,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

console.log(`blocked ${plan.blocked.length} → recoverable ${tally.dismissed} · still blocked ${tally.staysBlocked}`);
console.log('problem verdicts:', byReason);
const list = verdicts.filter((v) => v.recoverable).map((v) => v.selector);
console.log('recoverable selectors:', JSON.stringify(list));
console.log(`wrote ${OUT}`);
