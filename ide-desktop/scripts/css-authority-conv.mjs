// Authority audit for the cross-stylesheet duplicate-selector groups that are
// mine: conversation-shell ↔ styles and settings-shell ↔ styles (plus the one
// three-file group). Read-only: never writes under src/.
//
// Usage: node scripts/css-authority-conv.mjs [outJson] [probeJson]
//
// What it decides, per group (same selector + same at-rule context):
//   1. who actually wins, per longhand, using the browser-read orderIndex
//   2. which side looks newer (objective token / literal signals)
//   3. each declaration's net contribution, so a loser can be proven dead
//   4. bucket A / B / C / D
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseAll, FILES, coveredLonghands, specificity, declBeats, normalizeSelector } from './css-lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = process.argv[2] || 'C:/tmp/css-authority-conv.json';
const PROBE = process.argv[3] || 'C:/tmp/css-order-probe.json';

const { rules, fileHashes, sourceText } = parseAll();
const lineOf = (file, off) => sourceText[file].slice(0, off).split('\n').length;

/* ── property taxonomy ──────────────────────────────────────── */
// Mechanically structural longhands: merging one of these changes plumbing, not
// a design decision. Everything else (colour, size, spacing, radius, shadow,
// type) is a design choice and needs a human.
const BASELINE = new Set([
  'display', 'position', 'top', 'right', 'bottom', 'left', 'box-sizing',
  'overflow-x', 'overflow-y', 'overflow-clip-margin',
  'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'order',
  'align-items', 'align-self', 'align-content', 'justify-content', 'justify-self', 'justify-items',
  'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end',
  'grid-template-rows', 'grid-template-columns', 'grid-template-areas',
  'grid-auto-rows', 'grid-auto-columns', 'grid-auto-flow',
  'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end',
  'z-index', 'visibility', 'table-layout', 'direction', 'writing-mode',
  'scroll-snap-type', 'scroll-snap-align', 'scrollbar-gutter', 'contain', 'isolation',
  'content', 'float', 'clear', 'columns', 'column-count', 'column-width', 'column-span',
]);
const kindOf = (p) => (BASELINE.has(p) ? 'baseline' : 'design');

/* ── value classifiers ──────────────────────────────────────── */
const NEW_TOKEN_RE = /^--(r|sp|fs|radius|space|dur|ease|shadow|ring|lh|h-|gap-)[\w-]*$|border-subtle|bg-side|(^|-)accent|(^|-)line-(soft|strong)/;
const VAR_RE = /var\(\s*(--[\w-]+)/g;
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGBA_RE = /\brgba?\(/g;
const HSL_RE = /\bhsla?\(/g;
const MIX_RE = /color-mix\(/g;
const KEYWORD_RE = /^(inherit|initial|unset|revert|revert-layer)$/;
// "literal" = a hardcoded colour, or a hardcoded length that is not going
// through a custom property. Only a literal on the winning side paired with a
// var() on the losing side counts as a real "new-vs-old inversion".
const literalKind = (v) => {
  if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(v)) return 'color';
  if (/\bvar\(--/.test(v)) return /\d+(\.\d+)?px\b/.test(v) ? 'length-with-var' : null;
  if (/\d+(\.\d+)?px\b/.test(v)) return 'length';
  return null;
};
const isTokenValue = (v) => /var\(--|color-mix\(/.test(v);

/* ── custom-property values, for resolving token evidence ──── */
const tokenValue = new Map();
for (const r of rules) {
  if (!r.selectors.some((s) => s === ':root' || s === 'html')) continue;
  for (const d of r.decls) if (d.prop.startsWith('--')) tokenValue.set(d.prop, { value: d.value, file: r.file, order: r.order });
}
function resolveValue(v) {
  let out = v, guard = 0;
  while (/var\(\s*--[\w-]+/.test(out) && guard++ < 4) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g, (m, name) => tokenValue.get(name)?.value ?? m);
  }
  return out;
}

/* ── which file defines which custom property ──────────────── */
const tokenOwner = new Map();
for (const r of rules) {
  for (const d of r.decls) {
    if (!d.prop.startsWith('--')) continue;
    if (!tokenOwner.has(d.prop)) tokenOwner.set(d.prop, new Set());
    tokenOwner.get(d.prop).add(r.file);
  }
}

/* ── who references each token (var(--x)) ──────────────────── */
const tokenRefs = new Map(); // name -> Map(file -> count)
for (const r of rules) {
  for (const d of r.decls) {
    for (const m of d.value.matchAll(VAR_RE)) {
      const name = m[1];
      if (!tokenRefs.has(name)) tokenRefs.set(name, new Map());
      const mf = tokenRefs.get(name);
      mf.set(r.file, (mf.get(r.file) || 0) + 1);
    }
  }
}

function signalsOf(sideRules) {
  let nDecl = 0, nNew = 0, nVar = 0, nVarOwn = 0, nMix = 0, nHex = 0, nRgb = 0, nHsl = 0, nImp = 0, nLiteralPx = 0;
  const tokens = new Set();
  for (const r of sideRules) {
    for (const d of r.decls) {
      nDecl++;
      if (d.important) nImp++;
      const vars = [...d.value.matchAll(VAR_RE)].map((m) => m[1]);
      vars.forEach((name) => {
        tokens.add(name);
        nVar++;
        if (NEW_TOKEN_RE.test(name)) nNew++;
        const owners = tokenOwner.get(name);
        if (owners && owners.has(r.file)) nVarOwn++;
      });
      nMix += (d.value.match(MIX_RE) || []).length;
      nHex += (d.value.match(HEX_RE) || []).length;
      nRgb += (d.value.match(RGBA_RE) || []).length;
      nHsl += (d.value.match(HSL_RE) || []).length;
      if (!isTokenValue(d.value) && /\d+px\b/.test(d.value)) nLiteralPx++;
    }
  }
  const literals = nHex + nRgb + nHsl;
  return {
    decls: nDecl,
    newTokenRefs: nNew,          // --r-* / --sp-* / --fs-* / --border-subtle / --bg-side ...
    allTokenRefs: nVar,
    distinctTokens: tokens.size,
    tokensDefinedInThisFile: nVarOwn,
    colorMix: nMix,
    hexLiterals: nHex,
    rgbLiterals: nRgb + nHsl,
    pxLiterals: nLiteralPx,
    important: nImp,
    verdict: nNew >= 2 && literals === 0 ? '新（纯 token，无字面量）'
      : nNew === 0 && literals > 0 ? '旧（无新 token，有字面量）'
        : '混合',
  };
}

/* ── global (ctx, selector, longhand) winner index ──────────── */
const bucket = new Map();
for (const rule of rules) {
  for (const S of rule.selectors) {
    const spec = specificity(S);
    for (const decl of rule.decls) {
      for (const L of coveredLonghands(decl.prop)) {
        const key = `${rule.ctx}\u0000${S}\u0000${L}`;
        let arr = bucket.get(key);
        if (!arr) { arr = []; bucket.set(key, arr); }
        arr.push({ rule, S, decl, L, spec });
      }
    }
  }
}
const winnerMap = new Map(); // key -> entry
for (const [key, arr] of bucket) {
  let best = arr[0];
  for (let i = 1; i < arr.length; i++) if (declBeats(arr[i], best)) best = arr[i];
  winnerMap.set(key, best);
}
const winnerOf = (ctx, S, L) => winnerMap.get(`${ctx}\u0000${S}\u0000${L}`) || null;

// A declaration is globally dead only when it wins no longhand under ANY of its
// rule's selectors. (That is what makes deleting it provable, not guessed: every
// rule it would have applied with is in the bucket, so some other declaration
// with the same selector always beats it on the very same elements.)
const declStatus = new Map(); // decl -> {dead, wins:[{S,L}], loses:[{S,L}]}
for (const rule of rules) {
  for (const decl of rule.decls) {
    const wins = [], loses = [];
    for (const S of rule.selectors) {
      for (const L of coveredLonghands(decl.prop)) {
        const w = winnerOf(rule.ctx, S, L);
        if (w && w.decl === decl) wins.push({ S, L });
        else loses.push({ S, L, by: w ? { file: w.rule.file, order: w.rule.order, selector: w.S } : null });
      }
    }
    declStatus.set(decl, { dead: wins.length === 0, wins, loses });
  }
}

/* ── group duplicate selectors by (ctx, selector) ──────────── */
const groups = new Map();
for (const rule of rules) {
  for (const S of rule.selectors) {
    const key = `${rule.ctx}\u0000${S}`;
    let g = groups.get(key);
    if (!g) { g = { selector: S, ctx: rule.ctx, rules: [] }; groups.set(key, g); }
    if (!g.rules.includes(rule)) g.rules.push(rule);
  }
}
const allDupGroups = [...groups.values()].filter((g) => new Set(g.rules.map((r) => r.file)).size > 1);
const MINE = (fileSet) => {
  if (!fileSet.has('src/styles.css')) return false;
  if (fileSet.has('src/workspace-shell.css')) return false;      // other agent's 112
  return fileSet.has('src/conversation-shell.css') || fileSet.has('src/settings-shell.css');
};
const myGroups = allDupGroups.filter((g) => MINE(new Set(g.rules.map((r) => r.file))));

/* ── group turn: winners for the group's own selector ──────── */
function groupWinners(g) {
  const perL = new Map();      // L -> [{rule, decl, value}]
  for (const rule of g.rules) {
    for (const d of rule.decls) {
      for (const L of coveredLonghands(d.prop)) {
        if (!perL.has(L)) perL.set(L, []);
        perL.get(L).push({ rule, decl: d });
      }
    }
  }
  const res = new Map();
  for (const [L, arr] of perL) {
    const key = `${g.ctx}\u0000${g.selector}\u0000${L}`;
    const w = winnerMap.get(key);
    res.set(L, { winner: w, all: arr });
  }
  return res;
}

/* ── merge blockers (why a surviving prop cannot just move) ── */
// Global index: every declaration that speaks to longhand L, with the
// specificity of its own selector, so a move between two orders can be checked
// against every rule that could land on the same element while sitting between.
const byLonghandGlobal = new Map();
for (const rule of rules) {
  for (const S of rule.selectors) {
    const spec = specificity(S).join(',');
    for (const decl of rule.decls) {
      for (const L of coveredLonghands(decl.prop)) {
        let arr = byLonghandGlobal.get(L);
        if (!arr) { arr = []; byLonghandGlobal.set(L, arr); }
        arr.push({ rule, S, decl, spec });
      }
    }
  }
}
// A surviving declaration from side P can only be re-expressed inside side Q when
// no rule of equal importance + equal specificity that can co-match S sits
// strictly between the two orders and declares a different value for that
// longhand. Whatever passes this test is a provably identical merge.
function blockerCounts(srcRule, tgtRule, S) {
  const lo = Math.min(srcRule.order, tgtRule.order), hi = Math.max(srcRule.order, tgtRule.order);
  const tSpec = specificity(S).join(',');
  const perProp = new Map();
  for (const d of srcRule.decls) {
    if (!declStatus.get(d).wins.length) continue;
    for (const L of coveredLonghands(d.prop)) {
      for (const e of byLonghandGlobal.get(L) || []) {
        if (e.decl === d) continue;
        if (e.rule === tgtRule) continue;
        if (e.rule.order <= lo || e.rule.order >= hi) continue;
        if ((e.decl.important ? 1 : 0) !== (d.important ? 1 : 0)) continue;
        if (e.spec !== tSpec) continue;
        if (e.rule.ctx !== srcRule.ctx) continue;   // @media 不是同一层叠位置
        if (!canCoMatchLite(e.S, S)) continue;
        if (e.decl.value === d.value) continue;
        if (!perProp.has(L)) perProp.set(L, []);
        perProp.get(L).push({ file: e.rule.file, order: e.rule.order, selector: e.S, value: e.decl.value });
      }
    }
  }
  return [...perProp.entries()].map(([prop, list]) => {
    const seen = new Set(); const uniq = [];
    for (const b of list) { const k = `${b.order}|${b.selector}`; if (seen.has(k)) continue; seen.add(k); uniq.push(b); }
    uniq.sort((a, b) => b.order - a.order);
    return { prop, blockerRules: uniq.length, examples: uniq.slice(0, 3) };
  }).filter((x) => x.blockerRules > 0);
}

function canCoMatchLite(a, b) {
  const subj = (s) => {
    let depth = 0, buf = '', last = '';
    for (const ch of s) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (depth === 0 && '>+~ '.includes(ch)) { if (buf.trim()) last = buf.trim(); buf = ''; continue; }
      buf += ch;
    }
    return buf.trim() || last;
  };
  const A = subj(a), B = subj(b);
  const ids = (s) => new Set([...s.matchAll(/#([\w-]+)/g)].map((m) => m[1]));
  const tag = (s) => (s.match(/^([a-zA-Z][\w-]*)/) || [])[1]?.toLowerCase() ?? null;
  const PE = ['before', 'after', 'first-line', 'first-letter', 'placeholder', 'selection', 'marker', 'backdrop'];
  const pe = (s) => new Set([...s.matchAll(/::?([\w-]+)/g)].map((m) => m[1]).filter((x) => PE.includes(x)));
  const ai = ids(A), bi = ids(B);
  for (const x of ai) if (bi.size && !bi.has(x)) return false;
  for (const x of bi) if (ai.size && !ai.has(x)) return false;
  const ta = tag(A), tb = tag(B);
  if (ta && tb && ta !== tb) return false;
  const pa = pe(A), pb = pe(B);
  if (pa.size && pb.size && ![...pa].some((x) => pb.has(x))) return false;
  return true;
}

/* ── CSSOM orderIndex cross-check ──────────────────────────── */
let probe = null;
if (fs.existsSync(PROBE)) probe = JSON.parse(fs.readFileSync(PROBE, 'utf8'));
const probeByOrder = new Map();
if (probe) for (const row of probe.rows) if (row.order > 0) probeByOrder.set(row.order, row);
// Chromium re-serialises selectors (adds quotes to attribute values, drops the
// universal selector in front of pseudo-elements). Compare after stripping both.
const loose = (s) => String(s).replace(/["'*]/g, '').replace(/\s+/g, '').toLowerCase();
const orderCheck = { checked: 0, mismatches: [], missing: 0, global: { checked: 0, mismatches: 0, missing: 0, example: [] } };
// Whole-of-scope cross-check: every rule in the three sheets this report covers
// (styles / conversation-shell / settings-shell), not only the duplicate groups.
if (probe) {
  for (const rule of rules) {
    if (rule.file === 'src/workspace-shell.css' || rule.file === 'src/background-browser.css' || rule.file === 'src/gui-control.css') continue;
    orderCheck.global.checked++;
    const row = probeByOrder.get(rule.order);
    if (!row || row.sheet < 0) { orderCheck.global.missing++; continue; }
    if (loose(row.sel) !== loose(rule.selectorRaw)) {
      orderCheck.global.mismatches++;
      if (orderCheck.global.example.length < 3) orderCheck.global.example.push({ file: rule.file, order: rule.order, postcss: rule.selectorRaw, cssom: row.sel });
    }
  }
}

/* ── flags ──────────────────────────────────────────────────── */
const SKIP_FOCUS = /:focus(?:-visible|-within|-ring)?\b/;
const SKIP_MD = /(?:^|[\s>+~,])\.md(?:[\s-]|$|\.|:|\[)/;

/* ── main loop ──────────────────────────────────────────────── */
const outGroups = [];
let id = 0;
for (const g of myGroups) {
  id++;
  const files = [...new Set(g.rules.map((r) => r.file))].sort();
  const sides = Object.fromEntries(files.map((f) => [f, g.rules.filter((r) => r.file === f)]));
  const gw = groupWinners(g);

  /* sides */
  const sideInfo = {};
  for (const f of files) {
    const contrib = new Set();
    const decls = [];
    for (const rule of sides[f]) {
      for (const d of rule.decls) {
        const st = declStatus.get(d);
        const underGroup = st.wins.filter((x) => x.S === g.selector && (!x.st ? true : true));
        const longhandsHere = st.wins.filter((w) => w.S === g.selector).map((w) => w.L);
        longhandsHere.forEach((L) => contrib.add(L));
        decls.push({
          rule: { file: f, orderIndex: rule.order, line: lineOf(f, rule.start), ctx: rule.ctx, multiSelector: rule.selectors.length > 1, selectorRaw: rule.selectorRaw },
          prop: d.prop,
          value: d.value,
          important: d.important,
          blockIndex: d.index,
          raw: d.raw,
          covered: coveredLonghands(d.prop),
          winsHere: longhandsHere.sort(),
          losesHere: st.loses.filter((l) => l.S === g.selector).map((l) => l.L).sort(),
          globallyDead: st.dead,
          winsElsewhere: st.wins.filter((w) => w.S !== g.selector).map((w) => `${w.S} → ${w.L}`),
          keyword: KEYWORD_RE.test(d.value),
          verdict: st.dead ? 'dead(零贡献·可删)'
            : longhandsHere.length === 0 ? 'aliveUnderSiblingSelector(本选择器下无效，但兄弟选择器下存活)'
              : 'contributing(有净贡献)',
          _underGroup: underGroup.length,
        });
      }
    }
    sideInfo[f] = {
      file: f,
      rules: sides[f].map((r) => ({
        orderIndex: r.order,
        line: lineOf(f, r.start),
        ctx: r.ctx,
        selectorRaw: r.selectorRaw,
        multiSelector: r.selectors.length > 1,
        raw: r.raw,
      })),
      declarations: decls,
      contributingLonghands: [...contrib].sort(),
      contributingDeclarations: decls.filter((d) => d.verdict.startsWith('contributing'))
        .map((d) => ({ raw: d.raw, prop: d.prop, value: d.value, winsHere: d.winsHere, line: d.rule.line })),
      deadDeclarations: decls.filter((d) => d.globallyDead)
        .map((d) => ({ raw: d.raw, prop: d.prop, value: d.value, line: d.rule.line })),
      siblingOnlyDeclarations: decls.filter((d) => d.verdict.startsWith('aliveUnderSibling'))
        .map((d) => ({ raw: d.raw, winsElsewhere: d.winsElsewhere, line: d.rule.line })),
      signals: signalsOf(sides[f]),
    };
  }

  /* longhand table */
  const longhands = [...gw.keys()].sort().map((L) => {
    const { winner, all } = gw.get(L);
    const cands = [...all].sort((a, b) => {
      const ai = a.decl.important ? 1 : 0, bi = b.decl.important ? 1 : 0;
      if (ai !== bi) return bi - ai;
      if (a.rule.order !== b.rule.order) return b.rule.order - a.rule.order;
      return b.decl.index - a.decl.index;
    });
    const winnerValues = cands.filter((c) => c.decl === winner.decl).length;
    return {
      prop: L,
      kind: kindOf(L),
      winner: winner.rule.file,
      winnerOrderIndex: winner.rule.order,
      winnerLine: lineOf(winner.rule.file, winner.rule.start),
      winnerProp: winner.decl.prop,
      winnerValue: winner.decl.value,
      winnerImportant: winner.decl.important,
      sameValueDuplicates: cands.filter((c) => c.decl !== winner.decl && c.decl.value === winner.decl.value).length,
      candidates: cands.map((c) => ({
        file: c.rule.file,
        orderIndex: c.rule.order,
        line: lineOf(c.rule.file, c.rule.start),
        prop: c.decl.prop,
        value: c.decl.value,
        important: c.decl.important,
        win: c.decl === winner.decl,
      })),
      _winnerDupCount: winnerValues,
    };
  });

  const winsByFile = {};
  for (const f of files) winsByFile[f] = longhands.filter((l) => l.winner === f).map((l) => l.prop);
  const stylesF = 'src/styles.css';
  const others = files.filter((f) => f !== stylesF);

  // the "loser" = the side whose removal costs least: fewer won longhands, then
  // fewer surviving declarations. (Either sheet can be the loser — in 90+ of
  // these groups the *newer* shell only re-declares a few properties, and in a
  // handful the old block is the one that is fully shadowed.)
  const rank = (f) => [winsByFile[f].length, sideInfo[f].contributingDeclarations.length];
  const loserF = files.slice().sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1])[0];
  const winnerF = files.filter((f) => f !== loserF).sort((a, b) => rank(b)[0] - rank(a)[0])[0];
  const loserInfo = sideInfo[loserF];
  const loserContrib = winsByFile[loserF];

  /* newer side */
  const scoreOf = (s) => s.newTokenRefs * 2 + s.colorMix * 2 - s.hexLiterals * 2 - s.rgbLiterals - s.pxLiterals * 0.25 - s.important * 0.5;
  const scores = Object.fromEntries(files.map((f) => [f, Math.round(scoreOf(sideInfo[f].signals) * 10) / 10]));
  const best = Math.max(...Object.values(scores)), worst = Math.min(...Object.values(scores));
  const newer = best === worst ? 'unknown' : Object.keys(scores).find((f) => scores[f] === best);

  /* danger evidence: winning side hardcodes, losing side uses a var()/token */
  const tokenLost = [];      // literal on the winning side, var() on a loser  → bucket D
  const tokenSwap = [];      // both sides tokenised, but the loser uses the newer token name
  for (const l of longhands) {
    const wc = l.candidates.find((c) => c.win);
    if (!wc) continue;
    for (const c of l.candidates) {
      if (c.win) continue;
      const wk = literalKind(wc.value);
      const lossy = isTokenValue(c.value) && literalKind(c.value) === null;
      if (wk === 'color' || wk === 'length') {
        if (lossy) {
          tokenLost.push({
            prop: l.prop,
            winner: { file: wc.file, orderIndex: wc.orderIndex, line: wc.line, decl: `${wc.prop}: ${wc.value}` },
            loser: { file: c.file, orderIndex: c.orderIndex, line: c.line, decl: `${c.prop}: ${c.value}` },
            resolvedLoserValue: resolveValue(c.value),
            valuesEqual: resolveValue(c.value).replace(/\s+/g, ' ') === wc.value.replace(/\s+/g, ' '),
          });
        }
        continue;
      }
      // token vs older token name (e.g. --border lost to --border-subtle)
      const wt = (wc.value.match(/(--[\w-]+)/g) || []);
      const lt = (c.value.match(/(--[\w-]+)/g) || []);
      if (wt.length && lt.length && lt.some((t) => NEW_TOKEN_RE.test(t)) && !wt.some((t) => NEW_TOKEN_RE.test(t))) {
        tokenSwap.push({
          prop: l.prop,
          winner: { file: wc.file, orderIndex: wc.orderIndex, line: wc.line, decl: `${wc.prop}: ${wc.value}` },
          loser: { file: c.file, orderIndex: c.orderIndex, line: c.line, decl: `${c.prop}: ${c.value}` },
        });
      }
    }
  }

  /* per-property diff table: what each side alone would say */
  const diffBySide = {};
  for (const of_ of others) {
    const rows = [];
    for (const L of [...gw.keys()].sort()) {
      const { all } = gw.get(L);
      const bestOf = (f) => {
        const arr = all.filter((e) => e.rule.file === f);
        if (!arr.length) return null;
        return arr.sort((a, b) => {
          const ai = a.decl.important ? 1 : 0, bi = b.decl.important ? 1 : 0;
          if (ai !== bi) return bi - ai;
          if (a.rule.order !== b.rule.order) return b.rule.order - a.rule.order;
          return b.decl.index - a.decl.index;
        })[0];
      };
      const A = bestOf(stylesF), B = bestOf(of_);
      if (!A || !B) continue; // only one side speaks to this longhand
      rows.push({
        prop: L,
        kind: kindOf(L),
        styles: { value: A.decl.value, prop: A.decl.prop, orderIndex: A.rule.order, line: lineOf(stylesF, A.rule.start) },
        other: { value: B.decl.value, prop: B.decl.prop, orderIndex: B.rule.order, line: lineOf(of_, B.rule.start) },
        winner: (winnerMap.get(`${g.ctx}\u0000${g.selector}\u0000${L}`) || {}).rule?.file,
        sameValue: A.decl.value === B.decl.value,
      });
    }
    diffBySide[of_] = rows;
  }
  const diffTable = diffBySide[others[0]] || [];

  /* bucket */
  let bucketName, bucketReason, confidence = 'high';
  const basisOnly = loserContrib.length > 0 && loserContrib.every((p) => BASELINE.has(p));
  const designProps = loserContrib.filter((p) => !BASELINE.has(p));
  if (loserContrib.length === 0) {
    if (tokenLost.length) {
      bucketName = 'D';
      bucketReason = `输家在本选择器下零净贡献，但胜方有 ${tokenLost.length} 个长写是字面量、输方那份是 token —— 删之前先确认哪份才是想要的`;
      confidence = 'medium';
    } else {
      bucketName = 'A';
      bucketReason = `输家 ${loserInfo.deadDeclarations.length} 条声明在本选择器下零净贡献，删掉不改变任何元素的任何长写`;
    }
  } else if (basisOnly) {
    bucketName = tokenLost.length ? 'D' : 'B';
    bucketReason = tokenLost.length
      ? `输家净贡献 ${loserContrib.length} 个基础属性，但胜方同属性用的是字面量、输方是 token（${tokenLost.length} 处）`
      : `输家净贡献 ${loserContrib.length} 个长写且全是 layout 基础属性（${loserContrib.join(', ')}），并到胜方即可`;
    if (tokenLost.length) confidence = 'medium';
  } else {
    bucketName = tokenLost.length ? 'D' : 'C';
    bucketReason = tokenLost.length
      ? `胜方用字面量赢下了 ${tokenLost.length} 个长写，而输方给的是 token 版 —— 真正的"新旧倒挂"`
      : `输家净贡献 ${loserContrib.length} 个长写，其中 ${designProps.length} 个是设计属性（${designProps.slice(0, 6).join(', ')}${designProps.length > 6 ? '…' : ''}）`;
    if (tokenLost.length) confidence = 'medium';
  }
  if (tokenSwap.length && bucketName === 'C') bucketReason += `；另有 ${tokenSwap.length} 处 token 名新旧倒挂（疑似未生效的迁移）`;
  if (newer === 'unknown' && bucketName !== 'A') { confidence = confidence === 'high' ? 'medium' : 'low'; }

  /* merge risk for surviving loser declarations */
  let mergeRisk = [];
  if (loserContrib.length) {
    const tgt = sides[winnerF][sides[winnerF].length - 1];
    for (const src of sides[loserF]) {
      const counts = blockerCounts(src, tgt, g.selector);
      for (const c of counts) {
        const ex = mergeRisk.find((m) => m.prop === c.prop && m.from === src.file);
        if (ex) { ex.blockerRules += c.blockerRules; ex.examples.push(...c.examples); ex.examples = ex.examples.slice(0, 3); }
        else mergeRisk.push({ prop: c.prop, from: src.file, fromOrder: src.order, blockerRules: c.blockerRules, examples: c.examples.slice(0, 3) });
      }
    }
  }

  /* custom-property notes: a token defined in one file and consumed by the
     other is not a duplicate declaration, it is the only definition */
  const customPropNotes = [];
  for (const f of files) {
    for (const p2 of sideInfo[f].contributingLonghands) {
      if (!p2.startsWith('--')) continue;
      const definedIn = [...(tokenOwner.get(p2) || [])];
      const refs = tokenRefs.get(p2) || new Map();
      const referencedIn = Object.fromEntries([...refs].filter(([ff]) => ff !== f));
      customPropNotes.push({
        prop: p2, definedIn, referencedIn,
        referencedSameFile: refs.get(f) || 0,
        onlyDefinition: definedIn.length === 1,
      });
    }
  }

  const flags = {
    focusRule: g.rules.some((r) => SKIP_FOCUS.test(r.selectorRaw)),
    markdownRule: g.rules.some((r) => SKIP_MD.test(r.selectorRaw)),
    multiSelectorRule: g.rules.some((r) => r.selectors.length > 1),
    keywordValues: [...new Set(g.rules.flatMap((r) => r.decls.filter((d) => KEYWORD_RE.test(d.value)).map((d) => `${d.prop}: ${d.value}`)))],
    sameCtx: new Set(g.rules.map((r) => r.ctx)).size === 1,
    siblingSelectorRescue: Object.values(sideInfo).some((s) => s.siblingOnlyDeclarations.length > 0),
  };
  if (flags.focusRule) flags.note = '该段近期被改过（:focus-visible 精修），改动需与之协调';
  if (flags.markdownRule) flags.note = (flags.note ? flags.note + '；' : '') + '该段近期被改过（.md-* 排版精修），改动需与之协调';

  /* orderIndex cross-check against the browser */
  if (probe) {
    for (const r of g.rules) {
      orderCheck.checked++;
      const row = probeByOrder.get(r.order);
      if (!row || row.sheet < 0) { orderCheck.missing++; continue; }
      if (loose(row.sel) !== loose(r.selectorRaw)) {
        orderCheck.mismatches.push({ file: r.file, order: r.order, postcss: r.selectorRaw, cssom: row.sel });
      }
    }
  }

  outGroups.push({
    id: `g${String(id).padStart(3, '0')}`,
    selector: g.selector,
    selectorRaw: [...new Set(g.rules.map((r) => r.selectorRaw))],
    ctx: g.ctx || '(top level)',
    filePair: files.join(' ↔ '),
    orderIndex: Object.fromEntries(files.map((f) => [f, sides[f].map((r) => r.order)])),
    lines: Object.fromEntries(files.map((f) => [f, sides[f].map((r) => lineOf(f, r.start))])),
    rules: Object.fromEntries(files.map((f) => [f, sideInfo[f].rules])),
    declarations: Object.fromEntries(files.map((f) => [f, sideInfo[f].declarations])),
    signals: Object.fromEntries(files.map((f) => [f, sideInfo[f].signals])),
    longhands,
    longhandCount: longhands.length,
    winsByFile,
    winnerFile: winnerF,
    loser: {
      file: loserF,
      contributingLonghands: loserContrib,
      contributingDeclarations: loserInfo.contributingDeclarations,
      deadDeclarations: loserInfo.deadDeclarations,
      basisOnly,
      designProps,
    },
    newerSide: { file: newer, scores, signals: Object.fromEntries(files.map((f) => [f, sideInfo[f].signals])) },
    customPropNotes,
    tokenLostEvidence: tokenLost,
    tokenSwapEvidence: tokenSwap,
    diffTable,
    diffTableBySide: diffBySide,
    bucket: bucketName,
    bucketReason,
    confidence,
    mergeRisk,
    mergeRiskTotal: mergeRisk.reduce((n, m) => n + m.blockerRules, 0),
    mergeProvablySafe: mergeRisk.length === 0,
    deadDeclCount: Object.values(sideInfo).reduce((n, s2) => n + s2.deadDeclarations.length, 0),
    flags,
  });
}

/* ── summary ────────────────────────────────────────────────── */
const byBucket = {}, byPair = {};
for (const g of outGroups) {
  byBucket[g.bucket] = (byBucket[g.bucket] || 0) + 1;
  byPair[g.filePair] = (byPair[g.filePair] || 0) + 1;
}
const sha1 = (f) => createHash('sha1').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');

const report = {
  meta: {
    generatedAt: new Date().toISOString(),
    generator: 'ide-desktop/scripts/css-authority-conv.mjs',
    scope: 'conversation-shell.css ↔ styles.css、settings-shell.css ↔ styles.css（含 1 组三文件共有）；workspace-shell 的 112 组不在本报告内',
    loadOrder: FILES,
    orderIndexSource: probe
      ? `Electron/Chromium CSSOM 实读（C:/tmp/css-order-probe.cjs → ${PROBE}，${probe.rows.length} 条 CSSStyleRule，6 个 sheet），postcss 文档序仅作定位`
      : '未找到探针输出，退化为 postcss 文档序',
    orderVerification: {
      rulesCrossChecked: orderCheck.checked,
      mismatches: orderCheck.mismatches.length,
      missing: orderCheck.missing,
      examples: orderCheck.mismatches.slice(0, 5),
      wholeScope: {
        files: ['src/styles.css', 'src/conversation-shell.css', 'src/settings-shell.css'],
        rulesChecked: orderCheck.global.checked,
        mismatches: orderCheck.global.mismatches,
        missing: orderCheck.global.missing,
        examples: orderCheck.global.example,
      },
      note: '逐条比对 postcss 解析出的规则与浏览器 orderIndex 位置的 selectorText；0 条不一致即证明 orderIndex 可用作层叠序。workspace-shell / background-browser / gui-control 的规则未纳入全表核对（workspace-shell 在本轮被另一 agent 同时编辑，order 会漂）。wholeScope = 本范围三个表全部规则的核对结果',
    },
    cssSha1: Object.fromEntries(FILES.map((f) => [f, sha1(f)])),
    cssFnvHash: fileHashes,
    counts: {
      stylesheetRules: rules.length,
      duplicateGroupsAll: allDupGroups.length,
      groupsInScope: outGroups.length,
      byPair, byBucket,
      globallyDeadDeclarations: [...declStatus.values()].filter((s) => s.dead).length,
    },
    method: [
      '分组键 = (at-rule 上下文, 完整选择器字符串)；同名选择器跨上下文不算同一组',
      '赢家 = 对每个长写按 (!important, 特异性, orderIndex, 块内声明序) 取最大者；shorthand 先展开',
      '零贡献 = 该声明在其规则的每一个选择器、每一个覆盖的长写下都不是赢家（同选择器必然同时命中，故删掉必不改值）',
      '新写法信号 = 新 token 引用（--r-*/--sp-*/--fs-*/--border-subtle/--bg-side/color-mix）vs 字面量（hex/rgb/hsl/px）',
      'D 桶 = 胜方用字面量赢下的长写，输方那份是 token 版',
    ],
    schema: {
      'groups[].selector / ctx': '完整选择器 + at-rule 上下文',
      'groups[].orderIndex[file]': 'CSSOM 规则顺序号（浏览器实读），每文件一个数组',
      'groups[].lines[file]': '同一选择器在各自文件的起始行',
      'groups[].declarations[file][]': '声明级：prop/value/important/blockIndex/raw/covered(展开长写)/winsHere/losesHere/globallyDead/winsElsewhere/verdict',
      'groups[].signals[file]': '新写法信号：newTokenRefs、allTokenRefs、distinctTokens、tokensDefinedInThisFile、colorMix、hexLiterals、rgbLiterals、pxLiterals、important、verdict',
      'groups[].longhands[]': '属性级赢家：prop、kind(baseline/design)、winner、winnerOrderIndex、winnerLine、winnerValue、sameValueDuplicates、全部 candidates',
      'groups[].loser': '若删一侧：contributingLonghands（净贡献长写，空=可安全删）、contributingDeclarations、deadDeclarations、basisOnly、designProps',
      'groups[].newerSide': '哪边更像新 + 两边的信号分（token×2 + color-mix×2 − hex×2 − rgb − px/4 − !important/2）',
      'groups[].tokenLostEvidence': 'D 桶证据：胜方字面量值 vs 输方同名长写的 token 值（含 resolveValue 解析出的实际值与是否同值）',
      'groups[].tokenSwapEvidence': 'token 名新旧倒挂（胜方 var(--border) vs 输方 var(--border-subtle) 等），C 桶附注',
      'groups[].customPropNotes': '自定义属性归属：定义在哪些文件、被哪些文件 var() 引用几处、是否唯一定义（删=断链）',
      'groups[].diffTable': '两边都声明了同一长写的对照行（styles 值 vs 另一侧值 + 各自 orderIndex/行号 + 赢家 + 是否同值）',
      'groups[].diffTableBySide': '同上，三文件组按非 styles 侧分别给一份',
      'groups[].deadDeclCount': '本组内全局零贡献声明条数（两侧合计）',
      'groups[].mergeRiskTotal / mergeProvablySafe': '挡路规则总数；=0 表示把输家存活声明搬过去可证明不改变任何计算值',
      'groups[].bucket': 'A 可删 / B 需合并(仅基础属性) / C 需人判断(设计属性) / D 危险(赢家是旧写法)',
      'groups[].mergeRisk[]': '把输家存活声明搬到胜方位置时的挡路规则：同上下文、同特异性、可共匹配、值不同、位置居中',
      'groups[].flags': 'focus/markdown/多选择器/关键字值/兄弟选择器救援/同上下文',
    },
  },
  summary: {
    byBucket, byPair,
    bucketMembers: Object.fromEntries(['A', 'B', 'C', 'D'].map((b) => [b, outGroups.filter((g) => g.bucket === b).map((g) => g.id)])),
  },
  groups: outGroups,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log('groups in scope:', outGroups.length, JSON.stringify(byPair));
console.log('buckets:', JSON.stringify(byBucket));
console.log('orderIndex cross-check:', orderCheck.checked, 'mismatches', orderCheck.mismatches.length, 'missing', orderCheck.missing);
console.log('focus/md flagged:', outGroups.filter((g) => g.flags.focusRule || g.flags.markdownRule).length);
console.log('wrote', OUT);
