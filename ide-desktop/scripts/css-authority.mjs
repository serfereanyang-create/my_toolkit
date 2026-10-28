// css-authority — per-group authority decision for the 216 cross-file duplicate
// selectors left over after the zero-contribution sweep (audit-notes/ui/
// css-consolidation.md §3.4).
//
//   node scripts/css-authority.mjs
//   node scripts/css-authority.mjs --root=C:/tmp/css-authority-snapshot \
//        --counts=C:/tmp/css-authority-counts.json \
//        --out=../out/css-authority.json
//
// Read-only: never writes to src/. See "cost" in the console summary for how
// many property comparisons a recompute performs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  parseAll, FILES, coveredLonghands, specificity, cmpSpec, canCoMatch, declBeats,
} from './css-lib.mjs';

const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PROJECT = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(argOf('root', PROJECT));
const COUNTS = argOf('counts', 'C:/tmp/css-authority-counts.json');
const VERIFY = argOf('verify', 'C:/tmp/css-authority-verify.json');
const OUT = path.resolve(argOf('out', path.resolve(PROJECT, '..', 'out', 'css-authority.json')));

const { rules } = parseAll(ROOT);
const fileSha1 = {};
for (const rel of FILES) {
  fileSha1[rel] = crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
}

/* ── property taxonomy ──────────────────────────────────────────
 * BASE  : layout plumbing. Copying one into the winner's rule does not decide
 *         how the element looks, only how it is laid out by machinery that is
 *         all-or-nothing. -> bucket B ("补进赢家即可").
 * DESIGN: colour / size / spacing / radius / type / motion. Moving one across a
 *         file boundary is a design decision. -> bucket C.
 */
const BASE = new Set([
  'display', 'position', 'box-sizing',
  'flex', 'flex-direction', 'flex-wrap', 'flex-flow', 'flex-grow', 'flex-shrink', 'flex-basis',
  'align-items', 'align-self', 'align-content', 'justify-content', 'justify-items', 'justify-self',
  'place-items', 'place-self', 'place-content',
  'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
  'grid-auto-flow', 'grid-auto-rows', 'grid-auto-columns',
  'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end', 'grid-area',
  'order', 'inset', 'top', 'right', 'bottom', 'left', 'z-index',
  'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end',
  'overflow-x', 'overflow-y', 'pointer-events', 'isolation', 'contain', 'will-change',
  'content-visibility', 'float', 'clear', 'table-layout', 'border-collapse', 'appearance',
]);
const WEIGHT = {
  color: 3, 'background-color': 3, 'background-image': 3, 'box-shadow': 3, opacity: 3,
  'border-radius': 2, 'padding-top': 2, 'padding-right': 2, 'padding-bottom': 2, 'padding-left': 2,
  'margin-top': 2, 'margin-right': 2, 'margin-bottom': 2, 'margin-left': 2,
  'font-size': 2, 'font-weight': 2, 'line-height': 2, 'letter-spacing': 2, 'font-family': 2,
  display: 2, position: 2, 'flex-direction': 2,
  'border-top-color': 2, 'border-bottom-color': 2, 'border-left-color': 2, 'border-right-color': 2,
  height: 2, width: 2,
};
const propKind = (lh) => (BASE.has(lh) ? 'base' : 'design');
const propWeight = (lh) => WEIGHT[lh] ?? 1;

/* ── per-longhand value decomposition ──────────────────────────
 * To answer "does a hardcoded value win over a tokenised one for THIS longhand"
 * we must read the sub-value of a shorthand that governs that longhand, e.g.
 * `margin: 0 0 var(--sp-1)` -> margin-bottom = `var(--sp-1)`.
 * Returns { value, exact }; exact=false means we could not attribute the
 * component, and the caller must treat the age signal as unproven.
 */
function boxComponent(prop, longhand, value) {
  const pad = prop === 'inset' ? longhand : (longhand.startsWith(`${prop}-`) ? longhand.slice(prop.length + 1) : null);
  if (pad == null) return null;
  const m = pad.match(/^(top|right|bottom|left)$/);
  if (!m) return null;
  const parts = value.trim().split(/\s+/);
  if (!parts.length || parts.length > 4) return null;
  const idx = { top: 0, right: 1, bottom: 2, left: 3 }[m[1]];
  const table = [parts[0], parts[1] ?? parts[0], parts[2] ?? parts[0], parts[3] ?? parts[1] ?? parts[0]];
  return table[idx] ?? null;
}
function flexComponent(prop, longhand, value) {
  if (prop !== 'flex' || !/^flex-(grow|shrink|basis)$/.test(longhand)) return null;
  const parts = value.trim().split(/\s+/);
  if (!parts.length || parts.length > 3) return null;
  const grow = parts[0];
  const shrink = parts[1] ?? '1';
  const basis = parts[2] ?? '0%';
  return longhand === 'flex-grow' ? grow : longhand === 'flex-shrink' ? shrink : basis;
}
function gapComponent(prop, longhand, value) {
  if (!/^(gap|grid-gap)$/.test(prop) || !/^(row-gap|column-gap)$/.test(longhand)) return null;
  const parts = value.trim().split(/\s+/);
  if (!parts.length || parts.length > 2) return null;
  return longhand === 'row-gap' ? parts[0] : (parts[1] ?? parts[0]);
}
function placeComponent(prop, longhand, value) {
  const map = {
    'place-items': ['align-items', 'justify-items'],
    'place-content': ['align-content', 'justify-content'],
    'place-self': ['align-self', 'justify-self'],
  };
  const pair = map[prop];
  if (!pair) return null;
  const i = pair.indexOf(longhand);
  if (i < 0) return null;
  const parts = value.trim().split(/\s+/);
  if (!parts.length || parts.length > 2) return null;
  return parts[i] ?? parts[0];
}
const BORDER_STYLES = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/;
const BORDER_WIDTHS = /^([0-9.]+(px|rem|em|pt)?|thin|medium|thick|0)$/;
const WIDE_KEYWORD = /^(inherit|initial|unset|revert|revert-layer)$/i;
function borderComponent(prop, longhand, value) {
  // family shorthands: border-color/width/style and border-radius apply the
  // same component to every side / corner
  if (prop === 'border-color' && /^border-(top|right|bottom|left)-color$/.test(longhand)) return value.trim();
  if (prop === 'border-width' && /^border-(top|right|bottom|left)-width$/.test(longhand)) return value.trim();
  if (prop === 'border-style' && /^border-(top|right|bottom|left)-style$/.test(longhand)) return value.trim();
  if (prop === 'border-radius' && /radius$/.test(longhand)) return value.trim();
  const m = longhand.match(/^border-(top|right|bottom|left)-(width|style|color)$/);
  if (!m) return null;
  if (prop !== `border-${m[1]}` && prop !== 'border') return null;
  const want = m[2];
  for (const tok of value.trim().split(/\s+/)) {
    if (want === 'style' && BORDER_STYLES.test(tok)) return tok;
    if (want === 'width' && BORDER_WIDTHS.test(tok)) return tok;
    if (want === 'color' && !BORDER_STYLES.test(tok) && !BORDER_WIDTHS.test(tok) && tok !== '0') return tok;
  }
  // CSS initial values when the component is omitted from the shorthand
  return want === 'width' ? 'medium' : want === 'style' ? 'none' : 'currentcolor';
}
// `background: <one colour-ish component>` only tells us the background-color;
// the other seven longhands it resets are not attributable from the text alone.
function backgroundComponent(prop, longhand, value) {
  if (prop !== 'background') return null;
  if (longhand !== 'background-color') return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 1) return null;
  if (/^(none|transparent|currentcolor)$/i.test(parts[0])) return parts[0];
  return /^(var\(|#|rgb|hsl|color\()/i.test(parts[0]) ? parts[0] : null;
}
function resolvedFor(decl, longhand) {
  if (decl.prop === longhand) return { value: decl.value, exact: true };
  // a CSS-wide keyword (`font: inherit`, `flex: inherit`) applies to every
  // longhand the shorthand covers
  if (WIDE_KEYWORD.test(decl.value.trim())) return { value: decl.value.trim(), exact: true };
  const box = boxComponent(decl.prop, longhand, decl.value);
  if (box != null) return { value: box, exact: true };
  const br = borderComponent(decl.prop, longhand, decl.value);
  if (br != null) return { value: br, exact: true };
  const fl = flexComponent(decl.prop, longhand, decl.value);
  if (fl != null) return { value: fl, exact: true };
  const gp = gapComponent(decl.prop, longhand, decl.value);
  if (gp != null) return { value: gp, exact: true };
  const pl = placeComponent(decl.prop, longhand, decl.value);
  if (pl != null) return { value: pl, exact: true };
  const bg = backgroundComponent(decl.prop, longhand, decl.value);
  if (bg != null) return { value: bg, exact: true };
  return { value: decl.value, exact: false };
}
const hasToken = (v) => typeof v === 'string' && /var\(/.test(v);
const isLiteral = (v) => typeof v === 'string' && !/var\(/.test(v) && /^[#0-9.\-]/.test(v.trim());

/* ── token / legacy signals (evidence for "which side is newer") ── */
const TOKEN_RE = /var\(\s*(--[a-z0-9-]+)/gi;
const HEX_RE = /#[0-9a-f]{3,8}\b/gi;
const RGB_RE = /\brgba\(/i;
const TOKEN_FAMILY = (n) => (/^--r-/.test(n) ? 'radius'
  : /^--sp-/.test(n) ? 'spacing'
    : /^--fs-/.test(n) ? 'font-size'
      : /^--(fg|bg|border|accent|danger|ok|warn|blue|orange|pet)/.test(n) ? 'color'
        : /^--(ease|dur)/.test(n) ? 'motion'
          : /^--shadow/.test(n) ? 'shadow'
            : /^--font/.test(n) ? 'type' : 'other');

function signalsOf(rule) {
  const tokens = new Map();
  const families = new Set();
  let hex = [];
  let rgbLiterals = [];
  let colorMix = 0;
  let tokenDecls = 0;
  for (const d of rule.decls) {
    let hit = false;
    for (const m of d.value.matchAll(TOKEN_RE)) {
      hit = true;
      const name = m[1];
      if (!tokens.has(name)) tokens.set(name, TOKEN_FAMILY(name));
      families.add(TOKEN_FAMILY(name));
    }
    if (/color-mix\(/i.test(d.value)) { hit = true; colorMix += 1; }
    const hx = d.value.match(HEX_RE);
    if (hx) hex = hex.concat(hx);
    if (RGB_RE.test(d.value) && !/var\(/.test(d.value)) rgbLiterals.push(d.value.trim());
    if (hit) tokenDecls += 1;
  }
  const n = rule.decls.length || 1;
  return {
    declCount: rule.decls.length,
    tokenDecls,
    tokenScore: Number((tokenDecls / n).toFixed(3)),
    tokens: [...tokens.keys()].sort(),
    tokenFamilies: [...families].sort(),
    colorMix,
    hex,
    rgbLiterals,
  };
}
function styleAge(sig) {
  const hardcoded = sig.hex.length + sig.rgbLiterals.length;
  const modern = sig.tokenScore >= 0.4 || sig.colorMix > 0;
  const legacy = hardcoded > 0 && sig.tokenScore < 0.25;
  let label = 'mixed';
  let confident = false;
  if (modern && !legacy) { label = 'new'; confident = true; }
  else if (legacy && !modern) { label = 'legacy'; confident = true; }
  else if (!modern && !legacy && sig.declCount <= 4) label = 'neutral';
  return { label, confident, hardcoded };
}

/* ── grouping: identical selector string + identical at-rule context ── */
const groupsMap = new Map();
for (const rule of rules) {
  for (const sel of rule.selectors) {
    const key = `${rule.ctx}\u0000${sel}`;
    let g = groupsMap.get(key);
    if (!g) { g = { sel, ctx: rule.ctx, rules: [] }; groupsMap.set(key, g); }
    if (!g.rules.includes(rule)) g.rules.push(rule);
  }
}
const crossFile = [...groupsMap.values()]
  .filter((g) => new Set(g.rules.map((r) => r.file)).size >= 2 && g.rules.length >= 2);

/* ── global index: (ctx, selector, longhand) -> every entry ───────
 * The authority for "is this declaration needed at all" has to span the whole
 * stylesheet, not just the group: a loser's declaration may be dead for this
 * selector yet be the only source for one of its sibling selectors.
 */
const bucketIndex = new Map();
for (const rule of rules) {
  for (const S of rule.selectors) {
    const spec = specificity(S);
    for (const d of rule.decls) {
      for (const L of coveredLonghands(d.prop)) {
        const key = `${rule.ctx}\u0000${S}\u0000${L}`;
        let arr = bucketIndex.get(key);
        if (!arr) { arr = []; bucketIndex.set(key, arr); }
        arr.push({ rule, S, L, decl: d, spec });
      }
    }
  }
}
let comparisons = 0;
const winnerCache = new Map();
function globalWinner(ctx, S, L) {
  const key = `${ctx}\u0000${S}\u0000${L}`;
  if (winnerCache.has(key)) return winnerCache.get(key);
  const arr = bucketIndex.get(key);
  let best = null;
  if (arr && arr.length) {
    best = arr[0];
    for (let i = 1; i < arr.length; i += 1) { comparisons += 1; if (declBeats(arr[i], best)) best = arr[i]; }
  }
  winnerCache.set(key, best);
  return best;
}
// declarative form: every longhand a declaration wins, for one selector
function winsFor(d, ctx, S) {
  const out = [];
  for (const L of coveredLonghands(d.prop)) {
    const w = globalWinner(ctx, S, L);
    if (w && w.decl === d) out.push(L);
  }
  return out;
}
// needed by any of its selectors?
const liveDecl = new Set();
for (const rule of rules) {
  for (const d of rule.decls) {
    for (const S of rule.selectors) {
      if (winsFor(d, rule.ctx, S).length) { liveDecl.add(d); break; }
    }
  }
}
const deadDeclsTotal = rules.reduce((n, r) => n + r.decls.filter((d) => !liveDecl.has(d)).length, 0);

/* ── static usage proxy (for selectors the previews never render) ── */
const SRC_DIR = path.join(PROJECT, 'src');
function collectSources(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!/node_modules|__tests__/.test(entry.name)) collectSources(p, acc); }
    else if (/\.(tsx|ts)$/.test(entry.name) && !/\.test\./.test(entry.name)) acc.push(p);
  }
  return acc;
}
const sourcesText = (() => {
  try { return collectSources(SRC_DIR).map((f) => fs.readFileSync(f, 'utf8')).join('\n'); } catch { return ''; }
})();
const classHitCache = new Map();
function classHits(cls) {
  if (classHitCache.has(cls)) return classHitCache.get(cls);
  let n = 0;
  if (sourcesText) {
    const re = new RegExp(`(^|[^\\w-])${cls.replace(/[-]/g, '-')}(?![\\w-])`, 'g');
    n = (sourcesText.match(re) || []).length;
  }
  classHitCache.set(cls, n);
  return n;
}

const countsAll = fs.existsSync(COUNTS) ? JSON.parse(fs.readFileSync(COUNTS, 'utf8')) : null;
const countsBySel = countsAll?.counts || {};
const verifyAll = fs.existsSync(VERIFY) ? JSON.parse(fs.readFileSync(VERIFY, 'utf8')) : null;
const verifyBySel = new Map((verifyAll?.groups || []).map((g) => [g.selector, g]));

/* ── per-group analysis ───────────────────────────────────────── */
const groups = crossFile.map((g, gi) => {
  const spec = specificity(g.sel);
  const ordered = [...g.rules].sort((a, b) => a.order - b.order);
  const winnerRule = ordered[ordered.length - 1];
  const loserRules = ordered.slice(0, -1);
  const isWinner = (r) => r === winnerRule;

  // every longhand the group talks about, and everyone who states it
  const perLonghand = new Map();
  for (const rule of ordered) {
    for (const d of rule.decls) {
      for (const L of coveredLonghands(d.prop)) {
        let arr = perLonghand.get(L);
        if (!arr) { arr = []; perLonghand.set(L, arr); }
        arr.push({ rule, decl: d });
      }
    }
  }

  const properties = [];
  for (const L of [...perLonghand.keys()].sort()) {
    const arr = perLonghand.get(L);
    const win = globalWinner(g.ctx, g.sel, L);
    comparisons += Math.max(0, arr.length - 1);
    const rivals = arr.filter((e) => !(win && e.decl === win.decl && e.rule === win.rule));
    // compare *resolved* per-longhand values, not raw declaration text: a
    // `border: 1px solid var(--border)` rival and a `border-color: var(--border)`
    // winner agree, and must not be reported as a conflict.
    const winResolved = win ? resolvedFor(win.decl, L) : { value: null, exact: false };
    const rivalResolved = rivals.map((e) => ({ e, r: resolvedFor(e.decl, L) }));
    const differing = rivalResolved.filter((x) => x.r.value !== winResolved.value);
    const diffValues = [...new Set(differing.map((x) => x.r.value))];
    const blockers = (() => {
      if (!win) return [];
      const out = [];
      const pool = bucketIndex.get(`${g.ctx}\u0000${g.sel}\u0000${L}`) || [];
      for (const e of pool) {
        comparisons += 1;
        if (e.decl === win.decl) continue;
        if (ordered.includes(e.rule)) continue; // group members are the subjects, not blockers
        if (e.rule.order >= win.rule.order) continue; // must sit earlier than the winner
        if (cmpSpec(e.spec, spec) !== 0) continue;
        if (!canCoMatch(e.S, g.sel)) continue;
        if (e.decl.value === win.decl.value) continue;
        out.push({
          file: e.rule.file, order: e.rule.order,
          selector: e.rule.selectorRaw.slice(0, 88),
          prop: e.decl.prop, value: e.decl.value,
        });
      }
      return out;
    })();
    properties.push({
      longhand: L,
      kind: propKind(L),
      weight: propWeight(L),
      winner: win ? {
        file: win.rule.file, order: win.rule.order,
        prop: win.decl.prop, value: win.decl.value, raw: win.decl.raw,
        resolved: winResolved.value, resolvedExact: winResolved.exact,
      } : null,
      // values the losing side resolves to for this longhand (may be identical)
      loserValues: diffValues,
      allLoserValues: [...new Set(rivalResolved.map((x) => x.r.value))],
      // a *resolved* disagreement: this is where authority shows on screen
      valueConflict: diffValues.length > 0,
      // both sides had to be reducible to this longhand for the claim to be hard
      attributable: winResolved.exact && rivalResolved.every((x) => x.r.exact),
      losers: rivalResolved.map(({ e, r }) => ({
        file: e.rule.file, order: e.rule.order, prop: e.decl.prop,
        value: e.decl.value, raw: e.decl.raw,
        resolved: r.value, resolvedExact: r.exact,
      })),
      // token-vs-literal, resolved down to this longhand: the direct evidence
      // for "is a modern tokenised value being masked by a hardcoded one"
      tokenMasked: (() => {
        if (!win) return null;
        if (!isLiteral(winResolved.value)) return null;
        const masked = rivalResolved.filter((x) => hasToken(x.r.value));
        if (!masked.length) return null;
        return {
          winnerValue: winResolved.value,
          winnerExact: winResolved.exact,
          loserTokens: [...new Set(masked.map((x) => x.r.value))],
        };
      })(),
      blockers: blockers.slice(0, 6),
      blockerCount: blockers.length,
      soleSource: arr.length === 1,
      // set below once we know whether the border is even visible
      moot: false,
      mootReason: null,
    });
  }
  const propsByLonghand = new Map(properties.map((p) => [p.longhand, p]));

  /* A border colour that nobody can see is not a conflict: if the effective
   * border-style is none/hidden or the width is 0, drop the colour from the
   * conflict set (the winner still owns the longhand, it just does not show). */
  for (const p of properties) {
    const m = p.longhand.match(/^border-(top|right|bottom|left)-color$/);
    if (!m) continue;
    const side = m[1];
    const w = propsByLonghand.get(`border-${side}-width`);
    const s = propsByLonghand.get(`border-${side}-style`);
    const widthVal = w?.winner?.resolved ?? null;
    const styleVal = s?.winner?.resolved ?? null;
    if (widthVal === '0' || widthVal === '0px' || (styleVal && /^(none|hidden)$/.test(styleVal))) {
      p.moot = true;
      p.mootReason = `border-${side} 不显示（width=${widthVal ?? '?'} style=${styleVal ?? '?'}）`;
    }
  }
  // only claim a conflict we can trace back to this longhand on both sides
  const visibleConflicts = properties.filter((p) => p.valueConflict && !p.moot && p.attributable);
  const unattributedConflicts = properties.filter((p) => p.valueConflict && !p.moot && !p.attributable);

  /* per-rule detail, evaluated against the whole stylesheet */
  const rulesInfo = ordered.map((rule) => {
    const sig = signalsOf(rule);
    const age = styleAge(sig);
    const decls = rule.decls.map((d) => {
      const won = winsFor(d, g.ctx, g.sel);
      return {
        prop: d.prop,
        value: d.value,
        raw: d.raw,
        index: d.index,
        writes: coveredLonghands(d.prop),
        winsHere: won,
        neededHere: won.length > 0,
        liveAnywhere: liveDecl.has(d),
        raw2: undefined,
      };
    });
    return {
      file: rule.file,
      order: rule.order,
      specificity: spec,
      multiSelector: rule.selectors.length > 1,
      selectorRaw: rule.selectorRaw,
      declCount: rule.decls.length,
      role: isWinner(rule) ? 'winner' : 'loser',
      decls,
      // longhands for which this rule is the effective source *for this selector*
      ownsLonghands: [...new Set(decls.flatMap((d) => d.winsHere))].sort(),
      ...sig,
      age: age.label,
      ageConfident: age.confident,
    };
  });
  for (const r of rulesInfo) for (const d of r.decls) delete d.raw2;

  const wInfo = rulesInfo.find((r) => r.role === 'winner');
  const lInfos = rulesInfo.filter((r) => r.role === 'loser');

  /* ── net contribution of the losing side ─────────────────── */
  const loserOwnsHere = [...new Set(lInfos.flatMap((r) => r.ownsLonghands))].sort();
  const allLoserDead = lInfos.every((r) => r.decls.every((d) => !d.liveAnywhere));
  const loserDeadDecls = lInfos.flatMap((r) => r.decls.filter((d) => !d.liveAnywhere)
    .map((d) => ({ file: r.file, order: r.order, prop: d.prop, value: d.value })));
  const loserLiveDecls = lInfos.flatMap((r) => r.decls.filter((d) => d.liveAnywhere)
    .map((d) => ({ file: r.file, order: r.order, prop: d.prop, value: d.value, ownsHere: d.winsHere })));

  const conflicts = visibleConflicts;
  const conflictWeight = conflicts.reduce((n, p) => n + p.weight, 0);
  const mutedConflicts = properties.filter((p) => p.valueConflict && p.moot);
  const owned = loserOwnsHere.map((L) => propsByLonghand.get(L));
  const ownedDesign = owned.filter((p) => p.kind === 'design');
  const ownedBase = owned.filter((p) => p.kind === 'base');

  const maxLoserToken = Math.max(...lInfos.map((r) => r.tokenScore), 0);
  const tokenGap = Number((maxLoserToken - wInfo.tokenScore).toFixed(3));
  const loserAge = lInfos.every((r) => r.age === 'new') ? 'new'
    : lInfos.every((r) => r.age === 'legacy') ? 'legacy'
      : lInfos.every((r) => r.age === 'neutral') ? 'neutral' : 'mixed';

  /* ── bucket ──────────────────────────────────────────────── */
  // D evidence: a hardcoded value wins a longhand while a tokenised value for
  // that same longhand exists in the group. Both sides must be attributable.
  const maskedProps = properties.filter((p) => p.tokenMasked && p.tokenMasked.winnerExact && !p.moot);
  const maskedDesign = maskedProps.filter((p) => p.kind === 'design');

  let bucket;
  let bucketReason;
  let caveat;
  let evidenceInsufficient = false;

  if (allLoserDead) {
    bucket = 'A';
    bucketReason = '输家每条声明在整张表里都不再是任何长写的赢家 → 整条删掉，计算样式不变';
  } else if (loserOwnsHere.length === 0) {
    bucket = 'C';
    evidenceInsufficient = true;
    bucketReason = '输家对本选择器已无净贡献，但它的声明对兄弟选择器仍然活着 → 不能整条删，需拆分规则';
    caveat = 'multi-selector 规则共用声明';
  } else if (maskedDesign.length > 0 && wInfo.age !== 'new') {
    bucket = 'D';
    bucketReason = `赢家(${wInfo.file}) 用字面量压住了 token 版：`
      + maskedDesign.map((p) => `${p.longhand}=${p.tokenMasked.winnerValue} 盖住了 ${p.tokenMasked.loserTokens.join('/')}`).join('；');
  } else if (ownedDesign.length === 0) {
    bucket = 'B';
    bucketReason = `输家净贡献全是基础属性（${[...new Set(ownedBase.map((p) => p.longhand))].join(', ')}）→ 补进赢家即可`;
  } else {
    bucket = 'C';
    bucketReason = `输家有净贡献且含设计属性（${[...new Set(ownedDesign.map((p) => p.longhand))].slice(0, 7).join(', ')}）→ 需人判断`;
  }
  // token-masked longhands are a signal, never a guess: if the winning rule is
  // itself fully tokenised we treat the masking as a deliberate newer choice.
  let dUpgraded = null;
  if (bucket === 'D' && wInfo.age === 'new') {
    dUpgraded = '赢家本身是 token 版（tokenScore ' + wInfo.tokenScore + '），这条不按 D 处理';
    bucket = 'C';
    bucketReason = dUpgraded;
  }
  if (bucket === 'B' && lInfos.some((r) => r.multiSelector)) {
    caveat = '输家是多选择器规则：需先把该选择器的声明拆出来再并入，或整条保留';
  }
  // C is two very different things; split them so the reader can triage.
  const subBucket = bucket === 'C'
    ? (conflicts.length > 0 ? 'C-conflict' : 'C-complementary')
    : undefined;

  /* ── merge sheet for B (and the same data is useful for D) ── */
  const mergeSheet = bucket === 'B' || bucket === 'D'
    ? owned.map((p) => ({
      longhand: p.longhand,
      kind: p.kind,
      winnerValue: p.winner ? p.winner.value : null,
      loserValue: p.losers[0]?.resolved ?? null,
      from: lInfos.flatMap((r) => r.decls.filter((d) => d.winsHere.includes(p.longhand))
        .map((d) => ({ file: r.file, order: r.order, prop: d.prop, raw: d.raw }))),
      blockerCount: p.blockerCount,
      blockers: p.blockers,
    }))
    : undefined;

  /* ── affected elements + priority ────────────────────────── */
  const c = countsBySel[g.sel] || null;
  const classes = [...new Set([...g.sel.matchAll(/\.([\w-]+)/g)].map((m) => m[1]))];
  const classCounts = Object.fromEntries(classes.map((cl) => [cl, classHits(cl)]));
  const staticMin = classes.length ? Math.min(...classes.map((cl) => classHits(cl))) : 0;
  const elementsMax = c ? (c.distinctMax ?? c.max ?? 0) : 0;
  const elementsTotal = c ? (c.total ?? 0) : 0;
  // Reach = how many elements one repaint would touch. Measured DOM wins; when
  // the previews never render the selector (121 of 216), fall back to the count
  // of TSX references to its rarest class token, capped so a guess can never
  // outrank a real measurement of the same visual weight.
  const measured = elementsTotal > 0;
  const reach = measured
    ? elementsMax + Math.sqrt(elementsTotal) * 0.5
    : Math.min(staticMin, 25) * 0.4;
  const score = Number((reach * (1 + conflictWeight)).toFixed(2));

  return {
    id: gi,
    selector: g.sel,
    ctx: g.ctx,
    filePair: [...new Set(ordered.map((r) => r.file))].join(' + '),
    specificity: spec,
    winner: {
      file: wInfo.file, order: wInfo.order, declCount: wInfo.declCount,
      age: wInfo.age, tokenScore: wInfo.tokenScore,
    },
    losers: lInfos.map((r) => ({ file: r.file, order: r.order, declCount: r.declCount, age: r.age, tokenScore: r.tokenScore })),
    properties,
    rules: rulesInfo,
    netContribution: {
      loserOwnsLonghands: loserOwnsHere,
      loserOwnsDesignProps: ownedDesign.map((p) => p.longhand),
      loserOwnsBaseProps: ownedBase.map((p) => p.longhand),
      loserDeadDecls,
      loserLiveDecls,
      allLoserDeclsDead: allLoserDead,
    },
    newness: {
      winner: wInfo.age,
      loser: loserAge,
      winnerTokenScore: wInfo.tokenScore,
      loserTokenScore: maxLoserToken,
      tokenGap,
      evidence: {
        winner: {
          file: wInfo.file, declCount: wInfo.declCount, tokenScore: wInfo.tokenScore,
          tokenFamilies: wInfo.tokenFamilies, tokens: wInfo.tokens.slice(0, 14),
          hex: wInfo.hex.slice(0, 8), colorMix: wInfo.colorMix,
        },
        losers: lInfos.map((r) => ({
          file: r.file, declCount: r.declCount, tokenScore: r.tokenScore,
          tokenFamilies: r.tokenFamilies, tokens: r.tokens.slice(0, 14),
          hex: r.hex.slice(0, 8), colorMix: r.colorMix,
        })),
      },
    },
    bucket,
    subBucket,
    caveat,
    bucketReason,
    evidenceInsufficient,
    dUpgraded,
    // the previous round excluded focus and markdown rules from its edit set;
    // anything landing here needs that policy decision re-taken
    exclusionZone: (/:(focus|focus-visible|focus-within|focus-ring)\b/.test(g.sel)
      ? 'focus'
      : /(?:^|[\s>+~,])\.md(?:[\s.:#[>+~,]|$)/.test(g.sel) ? 'markdown' : null),
    tokenMasked: maskedProps.map((p) => ({
      longhand: p.longhand,
      kind: p.kind,
      winnerValue: p.tokenMasked.winnerValue,
      loserTokens: p.tokenMasked.loserTokens,
    })),
    conflicts: {
      count: conflicts.length,
      weight: conflictWeight,
      mutedCount: mutedConflicts.length,
      unattributedCount: unattributedConflicts.length,
      unattributedLonghands: unattributedConflicts.map((p) => p.longhand),
      longhands: conflicts.map((p) => ({
        longhand: p.longhand,
        kind: p.kind,
        attributable: p.attributable,
        winnerValue: p.winner?.resolved ?? null,
        winnerRaw: p.winner?.raw ?? null,
        losers: p.losers.map((l) => ({ file: l.file, prop: l.prop, value: l.resolved, raw: l.raw })),
      })),
    },
    mergeSheet,
    affected: c
      ? { total: elementsTotal, distinctMax: elementsMax, bySource: c.bySource, syn: c.syn, pseudo: c.pseudo }
      : null,
    staticUsage: { classes: classCounts, min: staticMin },
    // independent cross-check: delete the loser from the in-memory CSSOM on a
    // synthetic fixture and diff computed styles (see C:/tmp/css-authority-verify.cjs)
    empirical: (() => {
      const v = verifyBySel.get(g.sel);
      if (!v) return null;
      const cls = v.error ? 'errored' : v.deltaCount === 0 ? 'unchanged' : (v.deltaDesign && v.deltaDesign.length ? 'design-delta' : 'base-only-delta');
      return {
        outcome: cls,
        error: v.error || null,
        deltaCount: v.deltaCount ?? null,
        deltaBase: v.deltaBase || [],
        deltaDesign: v.deltaDesign || [],
        // an empty delta on a single-child fixture is weak evidence: :first/
        // :last-child rules fire there, so it never proves deletability alone
        note: cls === 'unchanged'
          ? '夹具上删除无差异；单子元素夹具会命中 :first/:last-child 规则，不能据此判定可删'
          : cls === 'design-delta' && g.bucket === 'B'
            ? '设计属性变化多为 display 改变的连带结果，不是独立贡献'
            : null,
      };
    })(),
    reach: { measured, value: Number(reach.toFixed(2)) },
    priorityScore: score,
    surgery: undefined,
  };
});

/* ── D: how invasive is the fix? ───────────────────────────── */
for (const g of groups) {
  if (g.bucket !== 'D') continue;
  const multi = g.rules.some((r) => r.role === 'loser' && r.multiSelector);
  const loserDecls = g.rules.filter((r) => r.role === 'loser').reduce((n, r) => n + r.declCount, 0);
  const designOwned = g.netContribution.loserOwnsDesignProps.length;
  g.surgery = {
    shape: multi || designOwned > 4 ? 'block' : 'local',
    loserDeclCount: loserDecls,
    designPropsOnLoser: designOwned,
    multiSelector: multi,
    hint: multi
      ? '输家是多选择器列表，动它会波及兄弟选择器 → 整块手术'
      : designOwned > 4
        ? `输家一次写了 ${designOwned} 条设计属性，建议整段重写而非逐行改`
        : '输家只写了少数设计属性 → 局部改几行',
  };
}

/* ── emit ─────────────────────────────────────────────────── */
const byBucket = { A: 0, B: 0, C: 0, D: 0 };
const bySub = {};
for (const g of groups) {
  byBucket[g.bucket] += 1;
  if (g.subBucket) bySub[g.subBucket] = (bySub[g.subBucket] || 0) + 1;
}
const ranked = [...groups].sort((a, b) => b.priorityScore - a.priorityScore);
const withConflicts = groups.filter((g) => g.conflicts.count > 0);
const measuredCount = groups.filter((g) => g.reach.measured).length;

const payload = {
  _schema: {
    what: '216 组跨文件重复选择器的权威判定。每组 = 同一 at-rule 上下文下选择器字符串完全相同的 2-3 条规则。',
    howWinnerDecided: 'CSSOM orderIndex（源文档序，已与真实 Chromium CSSOM 比对）+ 特异性 + 块内声明序。组内选择器字符串相同 ⇒ 特异性相同；216 组内 0 条 !important ⇒ 组内某长写的赢家 = order 最大的那条规则。',
    crucialDistinction: '"净贡献" ≠ "是否赢过长写"。输家的声明本来就被赢家盖住，删掉永远不改变当前渲染。真正要问的是：哪些长写只有输家提供（`loserOwnsLonghands`）——那才是删掉输家会丢掉的样式，也是"补进赢家"要搬的东西。',
    fields: {
      id: '序号',
      selector: '规范化选择器（分组键）',
      ctx: 'at-rule 上下文（分组键），空串=顶层',
      filePair: '参与文件，按加载序',
      specificity: '[a,b,c]；组内所有规则相同',
      'winner{file,order,declCount,age,tokenScore}': '实际赢家规则',
      'losers[]': '输家规则（1 或 2 条）',
      'properties[]': '逐长写明细：winner / loserValues / valueConflict（有值差=屏幕上能看出分歧）/ soleSource / blockers（夹在输赢之间、同特异性、可能同元素命中的第三方规则）',
      'rules[]': '每条规则原文级明细：decls[].raw 声明原文、winsHere（本选择器下赢得的长写）、liveAnywhere（对全表的任一选择器是否仍有意义）、age/tokenScore/hex 等年龄证据',
      'netContribution.loserOwnsLonghands': '★ 输家对本选择器仍是唯一来源的长写 —— 删输家会丢的样式',
      'netContribution.loserDeadDecls': '整表零贡献的输家声明（可安全删）',
      'netContribution.loserLiveDecls': '仍活着的输家声明（含 ownsHere）',
      'newness': '谁更像新设计：标签 + tokenScore + token 家族 + hex 证据 + declCount',
      bucket: 'A 可删 / B 需合并(基础属性) / C 需人判断 / D 危险(赢家反而旧)',
      subBucket: 'C 再分：C-conflict（两边对同一长写有值分歧，屏幕上已可见）｜C-complementary（各管一半属性，无分歧，合并纯属整洁）',
      exclusionZone: '上一轮按任务要求排除的编辑区（focus / markdown）；非 null 表示要动它得先重新拍板',
      caveat: '额外限制（如多选择器规则需先拆分）',
      bucketReason: '分桶理由（人读）',
      evidenceInsufficient: 'true = 信号不硬，被降级进 C',
      dUpgraded: '（D 候选被降级的说明）',
      tokenMasked: '字面量压住 token 的逐属性证据（D 类的判据）',
      'conflicts{}': '值分歧汇总：count、视觉权重 weight、mutedCount（边框不显示故不算）、unattributedCount、逐长写两边值',
      mergeSheet: '（B/D）逐属性搬迁清单，含 blockerCount',
      affected: '实测受影响元素数（Electron 探针，21 个预览状态）',
      staticUsage: 'TSX 静态引用计数（预览未覆盖的选择器用得上）',
      reach: '{measured, value}：reach 的算法与是否实测',
      priorityScore: 'reach × (1 + 冲突视觉权重)',
      empirical: '★ 独立实测：在内存里删掉输家规则后计算样式的差异 {outcome: unchanged|base-only-delta|design-delta|errored, deltaBase, deltaDesign}',
      surgery: '（D）block 整块手术 / local 局部改几行',
    },
    independentCheck: 'crossCheck 给出「分桶 × 实测」交叉表：B 类应落在 base-only-delta，C 类应落在 design-delta，可用来验证口径是否自洽。',
  },
  generatedAt: new Date().toISOString(),
  root: ROOT,
  fileSha1,
  totals: {
    stylesheetRules: rules.length,
    duplicateGroups: groups.length,
    byBucket,
    bySubBucket: bySub,
    groupsWithValueConflict: withConflicts.length,
    groupsWithNoValueConflict: groups.length - withConflicts.length,
    groupsMeasuredInDom: measuredCount,
    groupsEstimatedOnly: groups.length - measuredCount,
    longhandComparisons: comparisons,
    deadDeclsGlobal: deadDeclsTotal,
  },
  ordering: {
    fileLoadOrder: FILES,
    note: 'group 内无 !important、选择器字符串相同 ⇒ 赢家必为 order 最大者（加载序靠后的文件）。已用真实 CSSOM 校验 orderIndex 口径。',
  },
  countsSource: countsAll
    ? { generatedAt: countsAll.generatedAt, fileSha1: countsAll.fileSha1, note: countsAll.note, failures: countsAll.failures }
    : null,
  verifySource: verifyAll
    ? {
      generatedAt: verifyAll.generatedAt,
      mode: verifyAll.mode,
      fileSha1: verifyAll.fileSha1,
      summary: verifyAll.summary
        ? {
          tested: verifyAll.summary.tested,
          errored: verifyAll.summary.errored,
          groupsUnchanged: verifyAll.summary.groupsUnchanged,
          groupsChanged: verifyAll.summary.groupsChanged,
        }
        : null,
      caveats: [
        '夹具是合成的：每个选择器只造一个最小 DOM，单子元素会命中 :first-child/:last-child 规则，所以「删除无差异」不能单独证明可删。',
        '8 个 :hover/:focus/:disabled/:focus-within 选择器在夹具里无状态，无法测试（含 A 类全部 2 组）。',
        '删除输家后 width/height 等派生值会随 display 改变，属连带效应，不是独立贡献。',
      ],
    }
    : null,
  crossCheck: (() => {
    if (!verifyAll) return null;
    const tab = {};
    for (const g of groups) {
      const e = g.empirical;
      if (!e) { tab[`${g.bucket}|missing`] = (tab[`${g.bucket}|missing`] || 0) + 1; continue; }
      const k = `${g.bucket}|${e.outcome}`;
      tab[k] = (tab[k] || 0) + 1;
    }
    return {
      what: 'bucket × 实测（删除输家后计算样式是否变化）交叉表，用于验证分桶口径',
      table: tab,
      reading: 'B 类几乎全部落在 base-only-delta：实测只丢基础属性，佐证「补进赢家即可」。C 类绝大多数落在 design-delta：实测确实丢掉设计属性。A 类 2 组均为焦点规则无法实测，其安全性由声明原文自证（输家值与赢家相同，或已被赢家显式覆盖）。',
    };
  })(),
  groups,
  ranking: ranked.slice(0, 40).map((g) => ({
    id: g.id, selector: g.selector, bucket: g.bucket, subBucket: g.subBucket,
    priorityScore: g.priorityScore,
    measured: g.reach.measured,
    affected: g.affected ? { total: g.affected.total, distinctMax: g.affected.distinctMax } : null,
    staticMin: g.staticUsage.min,
    conflictWeight: g.conflicts.weight,
    conflictCount: g.conflicts.count,
    files: g.filePair,
  })),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));

/* ── console summary ─────────────────────────────────────── */
console.log(`root             ${ROOT}`);
console.log(`stylesheet rules ${rules.length}`);
console.log(`duplicate groups ${groups.length}`);
console.log(`buckets          A=${byBucket.A}  B=${byBucket.B}  C=${byBucket.C}  D=${byBucket.D}`);
console.log(`value conflict   ${withConflicts.length} groups / ${groups.length}`);
console.log(`dead decls (all) ${deadDeclsTotal}`);
console.log(`cost             ${comparisons} property comparisons, ${groups.length} groups`);
console.log(`wrote            ${OUT}`);
console.log('\ntop 15 by priority:');
for (const g of ranked.slice(0, 15)) {
  const a = g.affected ? `${g.affected.distinctMax}/${g.affected.total}` : '0';
  console.log(`  ${String(g.priorityScore).padStart(7)} ${g.bucket} ${g.selector.slice(0, 40).padEnd(42)} elem=${a.padEnd(7)} conflict=${String(g.conflicts.weight).padStart(2)} ${g.filePair}`);
}
