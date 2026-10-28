// Authority analysis for the `styles.css ↔ workspace-shell.css` duplicate-selector
// groups: who actually wins, per longhand, and whether the loser can be deleted.
//
//   node scripts/css-authority-workspace.mjs                 # analysis + JSON
//   node scripts/css-authority-workspace.mjs --md            # also print an MD digest
//
// Order authority comes from the browser: C:/tmp/css-auth-order.json is produced by
// C:/tmp/css-auth-order.cjs (Electron hidden window over a frozen snapshot of the
// six sheets) and carries each rule's real CSSOM orderIndex plus the at-rule
// context the browser actually reported. postcss is used only for source
// offsets/raw text and declaration indices. That split matters: postcss silently
// keeps rules the browser throws away, and it cannot tell you the orderIndex.
//
// Reuses scripts/css-lib.mjs for specificity / shorthand expansion / precedence so
// this file stays a consumer, not a second implementation.
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import {
  FILES, rootDir, coveredLonghands, specificity, cmpSpec, declBeats, splitTopLevel, normalizeSelector, EXPAND,
} from './css-lib.mjs';

const ROOT = rootDir();
const ORDER_JSON = process.argv.includes('--order')
  ? process.argv[process.argv.indexOf('--order') + 1]
  : 'C:/tmp/css-auth-order.json';
const OUT = 'C:/Users/34516/ZCodeProject/out/css-authority-workspace.json';
const STYLES = 'src/styles.css';
const WS = 'src/workspace-shell.css';

/* ── 0. frozen-snapshot guard ───────────────────────────────────────────────
 * The browser read was taken from C:/tmp/css-auth-snap, which is a copy. If the
 * working tree drifted since the copy, every number here describes the copy, not
 * the tree — so say so loudly instead of silently analysing a stale picture. */
const snapOrder = JSON.parse(fs.readFileSync(ORDER_JSON, 'utf8'));
const SNAP = 'C:/tmp/css-auth-snap';
const SNAP_MAP = {
  'src/styles.css': 'styles.css',
  'src/conversation-shell.css': 'conversation-shell.css',
  'src/settings-shell.css': 'settings-shell.css',
  'src/workspace-shell.css': 'workspace-shell.css',
  'src/background-browser.css': 'background-browser.css',
  'src/gui-control.css': 'gui-control.css',
};
function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
// analyse the snapshot copies (so a concurrent edit cannot move a number mid-run),
// and record both hashes so drift is visible in the artefact.
const hashes = { tree: {}, snap: {} };
for (const rel of FILES) {
  const snapFile = path.join(SNAP, SNAP_MAP[rel]);
  const has = fs.existsSync(snapFile);
  hashes.snap[rel] = has ? fnv1a(fs.readFileSync(snapFile, 'utf8')) : null;
  hashes.tree[rel] = fnv1a(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}
const SHA1 = process.env.CSS_SHA1 || null;

/* ── 1. parse with the browser's order ────────────────────────────────────── */
const CONDITIONAL = /^(@media|@supports|@container|@layer|@document|@scope)$/;

function parseFile(abs) {
  const css = fs.readFileSync(abs, 'utf8');
  const ast = postcss.parse(css, { from: abs, map: false });
  const out = [];
  const walk = (node, cond) => {
    node.each((child) => {
      if (child.type === 'atrule') {
        if (CONDITIONAL.test('@' + child.name)) {
          const params = child.params.replace(/\s*:\s*/g, ':').replace(/\s+/g, ' ').trim();
          walk(child, [...cond, `@${child.name} ${params}`.trim()]);
        }
        // @keyframes steps are not style rules: the browser never puts them in the
        // cascade, so parsing them here would shift the alignment against the CSSOM.
        return;
      }
      if (child.type !== 'rule') return;
      const decls = [];
      child.each((d) => {
        if (d.type === 'decl') {
          decls.push({
            prop: d.prop.toLowerCase(),
            value: d.value.trim(),
            important: Boolean(d.important),
            index: decls.length,
            raw: css.slice(d.source.start.offset, d.source.end.offset) + (d.important ? '' : ''),
            start: d.source.start.offset,
            end: d.source.end.offset,
          });
        }
      });
      out.push({
        selectorRaw: child.selector,
        selectors: splitTopLevel(child.selector).map(normalizeSelector),
        decls,
        cond: cond.join(' | '),
        raw: css.slice(child.source.start.offset, child.source.end.offset),
        start: child.source.start.offset,
        end: child.source.end.offset,
      });
    });
  };
  walk(ast, []);
  return out;
}

// aggressive selector-list normalisation: the browser re-serialises selectors
// (", " spacing, combinator spacing, attribute quotes → double), so compare on a
// quote- and whitespace-normalised form.
function selKey(s) {
  return String(s)
    .replace(/'/g, '"')
    // Chrome drops the redundant universal selector: `*::before` serialises as
    // `::before`, and `a *` as `a `.
    .replace(/\*\s*::/g, '::')
    .replace(/\s\*\s/g, ' ')
    .replace(/\s\*$/g, '')
    .replace(/\s*([,>+~])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const browserByFile = new Map(); // file -> ordered browser style rules
for (const r of snapOrder.rules) {
  if (r.type !== 'style') continue;
  const file = Object.entries(SNAP_MAP).find(([, v]) => v === r.sheetURL.split('/').pop())[0];
  if (!browserByFile.has(file)) browserByFile.set(file, []);
  browserByFile.get(file).push(r);
}

const alignReport = [];
const absentReport = [];
const rules = []; // final model
let orderMatches = 0;

/* ── 1b. does the browser accept each declaration? ──────────────────────────
 * A declaration the browser rejects never enters the cascade, so counting it as a
 * "winner" would be fiction. CSS.supports runs in the browser (see
 * C:/tmp/css-auth-order.cjs); this side writes the list of distinct pairs and then
 * consumes the verdicts. `null` means "not checked", never "valid". */
const DECL_PAIRS = 'C:/tmp/css-auth-decls.json';
const declKey = (prop, value) => `${prop}\u0000${value}`;
const support = new Map(Object.entries(snapOrder.declSupport || {}));
const parsedByFile = new Map();
for (const rel of FILES) parsedByFile.set(rel, parseFile(path.join(SNAP, SNAP_MAP[rel])));
{
  const pairs = new Map();
  for (const list of parsedByFile.values()) for (const r of list) for (const d of r.decls) pairs.set(declKey(d.prop, d.value), { prop: d.prop, value: d.value });
  fs.writeFileSync(DECL_PAIRS, JSON.stringify([...pairs.values()]));
}
let invalidDecls = 0;
let uncheckedDecls = 0;
for (const list of parsedByFile.values()) {
  for (const r of list) {
    for (const d of r.decls) {
      const k = declKey(d.prop, d.value);
      d.browserValid = support.has(k) ? support.get(k) : null;
      if (d.browserValid === false) invalidDecls++;
      else if (d.browserValid === null) uncheckedDecls++;
    }
  }
}

/* ── 1c. align the parsed source to the CSSOM rule sequence ──────────────── */
for (const rel of FILES) {
  const parsed = parsedByFile.get(rel);
  const browsed = browserByFile.get(rel) || [];
  let pi = 0;
  let mismatches = 0;
  for (const br of browsed) {
    let matched = -1;
    for (let k = pi; k < Math.min(pi + 4, parsed.length); k++) {
      if (selKey(parsed[k].selectorRaw) === selKey(br.selectorText)) { matched = k; break; }
    }
    if (matched < 0) { mismatches++; alignReport.push({ file: rel, kind: 'no-match', browser: br.selectorText, orderIndex: br.orderIndex }); continue; }
    if (matched > pi) for (let k = pi; k < matched; k++) alignReport.push({ file: rel, kind: 'skipped-by-browser', selector: parsed[k].selectorRaw });
    const p = parsed[matched];
    pi = matched + 1;
    orderMatches++;
    // Which declarations never made it into the CSSOM? A missing entry is not
    // proof of rejection: Chrome promotes a few properties to shorthands
    // (`white-space` → `white-space-collapse` + `text-wrap-mode`), so the pair
    // simply reappears under other names. Only CSS.supports settles it.
    const bProps = new Set(br.decls.map((d) => d.prop));
    const absent = p.decls.filter((d) => !bProps.has(d.prop)).map((d) => d.prop);
    const dropped = p.decls.filter((d) => !bProps.has(d.prop) && d.browserValid === false).map((d) => d.prop);
    if (dropped.length) alignReport.push({ file: rel, kind: 'decls-dropped-by-browser', selector: p.selectorRaw, dropped });
    if (absent.length && !dropped.length) absentReport.push({ file: rel, selector: p.selectorRaw, absent });
    rules.push({
      file: rel,
      orderIndex: br.orderIndex,
      // css-lib's declBeats() reads `rule.order`; keep both names so the shared
      // comparator is fed the real CSSOM position and nothing silently degrades to
      // comparing declaration indices.
      order: br.orderIndex,
      sheet: br.sheet,
      cond: (br.cond || []).join(' | ') || p.cond,
      ctxFromBrowser: (br.cond || []).length > 0,
      selectorRaw: p.selectorRaw,
      selectors: p.selectors.map((s) => ({ text: s, key: selKey(s) })),
      decls: p.decls,
      raw: p.raw,
      start: p.start,
      end: p.end,
      browserDeclCount: br.decls.length,
      browserDropped: dropped,
    });
  }
  for (const k of Array.from({ length: parsed.length - pi }, (_, i) => pi + i)) {
    alignReport.push({ file: rel, kind: 'not-in-browser (zero-decl rule)', selector: parsed[k].selectorRaw });
  }
}
// derived: specificity of each selector of each rule (once)
for (const r of rules) for (const s of r.selectors) s.spec = specificity(s.text);

/* ── 2. cascade index ─────────────────────────────────────────────────────── */
// key: ctx \0 selectorKey \0 longhand -> entries
const cascadeIndex = new Map();
let comparisons = 0;
for (const r of rules) {
  for (const s of r.selectors) {
    for (const d of r.decls) {
      if (d.browserValid === false) continue;
      for (const L of coveredLonghands(d.prop)) {
        const key = `${r.cond}\u0000${s.key}\u0000${L}`;
        let arr = cascadeIndex.get(key);
        if (!arr) { arr = []; cascadeIndex.set(key, arr); }
        arr.push({ rule: r, sel: s, decl: d, L, spec: s.spec });
      }
    }
  }
}
function winnerOf(ctx, selKeyStr, L) {
  const arr = cascadeIndex.get(`${ctx}\u0000${selKeyStr}\u0000${L}`);
  if (!arr || !arr.length) return null;
  let best = arr[0];
  for (let i = 1; i < arr.length; i++) { comparisons++; if (declBeats(arr[i], best)) best = arr[i]; }
  return best;
}

/* ── 2b. rule-granularity death check ──────────────────────────────────────
 * A declaration inside a multi-selector rule can lose for the selector this group is
 * about and still be the winner for a sibling selector. Deleting it then breaks the
 * sibling's page. So "removable" is decided over *every* selector of the rule, not
 * just the group's one — same rule granularity the previous round used. */
const comparisonsBeforeGlobal = comparisons;
for (const r of rules) {
  for (const d of r.decls) {
    let dead = d.browserValid !== false;
    if (dead) {
      for (const sel of r.selectors) {
        for (const L of coveredLonghands(d.prop)) {
          const w = winnerOf(r.cond, sel.key, L);
          if (w && w.decl === d) { dead = false; break; }
        }
        if (!dead) break;
      }
    }
    d.removableForWholeRule = d.browserValid !== false && dead;
  }
}

const ruleGranularityComparisons = comparisons - comparisonsBeforeGlobal;
comparisons = comparisonsBeforeGlobal;

/* ── 3. grouping: selector + exact at-rule context, both files present ────── */
const groups = new Map();
for (const r of rules) {
  for (const s of r.selectors) {
    const key = `${r.cond}\u0000${s.key}`;
    let g = groups.get(key);
    if (!g) { g = { key, selector: s.text, selKey: s.key, ctx: r.cond, rules: [] }; groups.set(key, g); }
    if (!g.rules.includes(r)) g.rules.push(r);
  }
}
const target = [];
for (const g of groups.values()) {
  const files = new Set(g.rules.map((r) => r.file));
  if (!files.has(STYLES) || !files.has(WS)) continue;
  target.push(g);
}

/* ── 4. token / style signals ─────────────────────────────────────────────── */
const NEW_TOKEN = /var\(\s*--(r-|sp-|fs-|rad|space|gap-|dur|ease|border-subtle|bg-side|bg-elev|text-|accent)/;
const ANY_VAR = /var\(\s*--[\w-]+/;
const MIX = /color-mix\(/;
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const RGBA = /\brgba?\(/;
const OLD_PX_RADIUS = /(^|\s)\d+(\.\d+)?px/;
const DESIGN_PROPS = new Set([
  'color', 'background-color', 'background-image', 'background-position', 'background-size', 'background-repeat',
  'background-attachment', 'background-origin', 'background-clip',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'box-shadow', 'opacity', 'font-size', 'font-weight', 'font-style', 'font-family', 'font-variant', 'font-stretch',
  'line-height', 'letter-spacing', 'text-transform', 'text-align', 'text-decoration-color', 'text-decoration-line',
  'text-decoration-style', 'text-decoration-thickness', 'text-shadow', 'text-indent',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'padding-inline', 'padding-block', 'margin-inline', 'margin-block',
  'row-gap', 'column-gap', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'aspect-ratio',
  'outline-color', 'outline-width', 'outline-style', 'outline-offset',
  'fill', 'stroke', 'filter', 'backdrop-filter', 'accent-color', 'scrollbar-width', 'scrollbar-color', 'caret-color',
  'transform', 'translate', 'rotate', 'scale', 'transform-origin', 'zoom',
]);
const BASE_PROPS = new Set([
  'display', 'position', 'flex-direction', 'flex-wrap', 'align-items', 'align-self', 'align-content', 'justify-content', 'justify-items', 'justify-self',
  'flex-grow', 'flex-shrink', 'flex-basis', 'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
  'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end', 'grid-auto-rows', 'grid-auto-columns', 'grid-auto-flow',
  'box-sizing', 'overflow-x', 'overflow-y', 'overflow-clip-margin', 'visibility', 'z-index', 'top', 'right', 'bottom', 'left', 'float', 'clear',
  'place-items', 'place-content', 'place-self', 'order', 'pointer-events', 'user-select', 'white-space', 'text-overflow',
  'word-break', 'overflow-wrap', 'word-wrap', 'cursor', 'contain', 'isolation', 'appearance', 'resize', 'container-type',
  'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end', 'direction', 'writing-mode', 'scroll-behavior',
  'list-style-type', 'list-style-position', 'list-style-image', 'columns', 'column-count', 'column-width',
]);
const MOTION_PROPS = /^(transition|animation)-/;
// Shorthands are classified through their own expansion, so `border` is one design
// decision, `flex` is layout, and nothing depends on a hand-written shorthand list.
function kindOfLonghand(L) {
  if (MOTION_PROPS.test(L)) return 'motion';
  if (BASE_PROPS.has(L)) return 'base';
  if (DESIGN_PROPS.has(L)) return 'design';
  return null;
}
function kindOf(prop) {
  const longs = coveredLonghands(prop);
  const kinds = longs.map(kindOfLonghand);
  if (kinds.some((k) => k === null)) return null;
  if (kinds.every((k) => k === 'base')) return 'base';
  if (kinds.some((k) => k === 'design')) return 'design';
  return 'motion';
}
const KIND_LABEL = { base: '基础/布局', design: '设计选择', motion: '动效' };

function declSignals(decls) {
  const sig = { declCount: decls.length, newToken: 0, anyVar: 0, colorMix: 0, hex: 0, rgba: 0, literalPx: 0, props: [] };
  for (const d of decls) {
    sig.props.push(d.prop);
    if (NEW_TOKEN.test(d.value)) sig.newToken++;
    if (ANY_VAR.test(d.value)) sig.anyVar++;
    if (MIX.test(d.value)) sig.colorMix++;
    if (HEX.test(d.value)) sig.hex++;
    if (RGBA.test(d.value)) sig.rgba++;
    if (OLD_PX_RADIUS.test(d.value)) sig.literalPx++;
  }
  return sig;
}

/* ── 5b. per-longhand value extraction ──────────────────────────────────────
 * `border: 1px solid var(--x)` and `border-bottom-width: 1px` both cover
 * border-bottom-width, but comparing the two *declaration texts* is meaningless —
 * it says "1px" differs from "1px solid var(--x)". Every value comparison has to
 * happen on the longhand, so pull the longhand value out of the shorthand first,
 * and say "not comparable" when the shorthand cannot be decomposed safely. */
function tokenSplit(v) {
  const out = [];
  let depth = 0, q = null, buf = '';
  for (const ch of v) {
    if (q) { buf += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; buf += ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && /\s/.test(ch)) { if (buf) { out.push(buf); buf = ''; } continue; }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}
function box4(v) {
  const t = tokenSplit(v);
  if (!t.length || t.length > 4) return null;
  const [a, b = a, c = a, d2 = b] = t;
  if (t.length === 1) return [a, a, a, a];
  if (t.length === 2) return [a, b, a, b];
  if (t.length === 3) return [a, b, c, b];
  return [a, b, c, d2];
}
const BORDER_STYLE_KW = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset']);
const BORDER_WIDTH_KW = new Set(['thin', 'medium', 'thick']);
const isColorish = (t) => /^#|^rgba?\(|^hsla?\(|^color\(|^color-mix\(|^var\(|^currentcolor$|^transparent$|^[a-z]+$/i.test(t)
  && !BORDER_STYLE_KW.has(t.toLowerCase()) && !BORDER_WIDTH_KW.has(t.toLowerCase());
function border3(v) {
  const t = tokenSplit(v);
  if (!t.length || t.length > 3) return null;
  let width = null, style = null, color = null;
  for (const tok of t) {
    const low = tok.toLowerCase();
    if (BORDER_STYLE_KW.has(low)) { style = tok; continue; }
    if (BORDER_WIDTH_KW.has(low) || /^-?[\d.]+(px|em|rem|pt|%|vw|vh)$/i.test(tok) || /^calc\(|^var\(--[\w-]*(w|width)/i.test(tok) || tok === '0') { width = tok; continue; }
    if (isColorish(tok)) { color = tok; continue; }
  }
  const missing = (style === 'none' || style === 'hidden');
  return {
    width: width ?? (missing ? '0' : (style ? 'medium' : null)),
    style: style ?? (width || color ? 'none' : null),
    color: color ?? (style || width ? 'currentcolor' : null),
  };
}
function longhandValue(prop, value) {
  const V = value.trim();
  switch (prop) {
    case 'margin': case 'padding': case 'scroll-margin': case 'scroll-padding': case 'inset': case 'inset-block': case 'inset-inline':
    case 'border-width': case 'border-style': case 'border-color': case 'border-radius': case 'scroll-margin-block': case 'scroll-padding-block': {
      if (V.includes('/')) return null; // elliptical radius: not worth guessing
      const t = box4(V);
      if (!t) return null;
      const out = {};
      if (prop === 'border-radius') {
        out['border-top-left-radius'] = t[0]; out['border-top-right-radius'] = t[1];
        out['border-bottom-right-radius'] = t[2]; out['border-bottom-left-radius'] = t[3];
      } else if (prop === 'inset-block' || prop === 'inset-inline') {
        const [a, b] = t;
        const k = prop === 'inset-block' ? ['inset-block-start', 'inset-block-end'] : ['inset-inline-start', 'inset-inline-end'];
        out[k[0]] = a; out[k[1]] = b;
      } else if (prop.startsWith('scroll-')) {
        const base = prop;
        ['top', 'right', 'bottom', 'left'].forEach((s, i) => { out[`${base}-${s}`] = t[i]; });
      } else if (/^border-(width|style|color)$/.test(prop)) {
        const suffix = prop.split('-')[1];
        ['top', 'right', 'bottom', 'left'].forEach((s, i) => { out[`border-${s}-${suffix}`] = t[i]; });
      } else {
        const base = prop === 'inset' ? '' : `${prop}-`;
        ['top', 'right', 'bottom', 'left'].forEach((s, i) => { out[`${base}${s}`] = t[i]; });
      }
      return out;
    }
    case 'border': case 'outline': case 'column-rule': {
      const b = border3(V);
      if (!b) return null;
      if (prop === 'border') {
        const out = {};
        for (const s of ['top', 'right', 'bottom', 'left']) { out[`border-${s}-width`] = b.width; out[`border-${s}-style`] = b.style; out[`border-${s}-color`] = b.color; }
        return out;
      }
      return { [`${prop}-width`]: b.width, [`${prop}-style`]: b.style, [`${prop}-color`]: b.color };
    }
    case 'border-top': case 'border-right': case 'border-bottom': case 'border-left': {
      const b = border3(V);
      if (!b) return null;
      return { [`${prop}-width`]: b.width, [`${prop}-style`]: b.style, [`${prop}-color`]: b.color };
    }
    case 'gap': case 'grid-gap': {
      const t = tokenSplit(V);
      if (t.length === 1) return { 'row-gap': t[0], 'column-gap': t[0] };
      if (t.length === 2) return { 'row-gap': t[0], 'column-gap': t[1] };
      return null;
    }
    case 'place-items': case 'place-content': case 'place-self': {
      const [alignL, justifyL] = EXPAND[prop];
      const t = tokenSplit(V);
      if (t.length === 1) return { [alignL]: t[0], [justifyL]: t[0] };
      if (t.length === 2) return { [alignL]: t[0], [justifyL]: t[1] };
      return null;
    }
    case 'flex': {
      const t = tokenSplit(V);
      if (t.length === 1) {
        if (/^[\d.]+$/.test(t[0])) return { 'flex-grow': t[0], 'flex-shrink': '1', 'flex-basis': '0%' };
        return { 'flex-grow': '1', 'flex-shrink': '1', 'flex-basis': t[0] };
      }
      if (t.length === 2) {
        if (/^[\d.]+$/.test(t[1])) return { 'flex-grow': t[0], 'flex-shrink': t[1], 'flex-basis': '0%' };
        return { 'flex-grow': t[0], 'flex-shrink': '1', 'flex-basis': t[1] };
      }
      if (t.length === 3) return { 'flex-grow': t[0], 'flex-shrink': t[1], 'flex-basis': t[2] };
      return null;
    }
    case 'flex-flow': {
      const t = tokenSplit(V);
      const out = {};
      for (const tok of t) {
        if (/^(row|column)(-reverse)?$/.test(tok)) out['flex-direction'] = tok;
        else if (/^(wrap|nowrap|wrap-reverse)$/.test(tok)) out['flex-wrap'] = tok;
      }
      return Object.keys(out).length ? out : null;
    }
    case 'overflow': case 'overscroll-behavior': {
      const t = tokenSplit(V);
      if (t.length === 1) return { [`${prop}-x`]: t[0], [`${prop}-y`]: t[0] };
      if (t.length === 2) return { [`${prop}-x`]: t[0], [`${prop}-y`]: t[1] };
      return null;
    }
    case 'background': {
      // only the two longhands that actually carry a visual decision here; the
      // position/size/repeat/attachment/origin/clip six are reset-to-initial noise
      const t = tokenSplit(V);
      const image = t.find((x) => /gradient\(|url\(/i.test(x)) || null;
      const color = [...t].reverse().find((x) => /^#|^rgba?\(|^hsla?\(|^color-mix\(|^var\(|^currentcolor$|^transparent$/i.test(x)) || null;
      return { 'background-image': image ?? 'none', 'background-color': color ?? 'transparent' };
    }
    case 'background-color': case 'background-image':
      return { [prop]: V };
    case 'grid-row': case 'grid-column': {
      const t = tokenSplit(V);
      if (t.length === 1) return { [`${prop}-start`]: t[0], [`${prop}-end`]: t[0] };
      if (t.length === 2) return { [`${prop}-start`]: t[0], [`${prop}-end`]: t[1] };
      return null;
    }
    default:
      // coversLonghands(prop) is [prop] → the declaration value IS the longhand value
      return coveredLonghands(prop).length === 1 && coveredLonghands(prop)[0] === prop ? { [prop]: V } : null;
  }
}
// longhand → comparable value, or null when the shorthand could not be decomposed
function valueOf(decl, L) {
  if (coveredLonghands(decl.prop).length === 1) return decl.prop === L ? decl.value : null;
  const map = longhandValue(decl.prop, decl.value);
  if (!map || !(L in map)) return null;
  return map[L];
}

/* ── 5. value resolution through the var table ────────────────────────────── */
// Resolve var(--x) so "differently written, same result" is not reported as a
// visual difference. Light theme first; dark overrides are recorded separately.
const varTable = { light: new Map(), dark: new Map() };
for (const r of rules) {
  for (const s of r.selectors) {
    const isRoot = /:root/.test(s.key);
    const isDark = /\[data-theme=("|')?dark("|')?\]/.test(s.key) || /data-theme/.test(s.key);
    if (!isRoot && !isDark) continue;
    for (const d of r.decls) {
      if (!d.prop.startsWith('--')) continue;
      (isRoot ? varTable.light : varTable.dark).set(d.prop, d.value);
    }
  }
}
function resolveValue(v, table, depth = 0) {
  if (depth > 6 || !v) return v;
  let out = String(v);
  let hit = false;
  out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_m, name, fallback) => {
    const val = table.get(name);
    if (val == null) { if (fallback != null) { hit = true; return fallback.trim(); } return _m; }
    hit = true;
    return resolveValue(val, table, depth + 1);
  });
  return hit ? out : out;
}
// dark overrides layered on top of the light table
const varTableDark = new Map([...varTable.light, ...varTable.dark]);
function normVal(v) {
  return String(v).trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').replace(/\s*\/\s*/g, '/');
}
function hexExpand(v) {
  return normVal(v).replace(/#([0-9a-f])([0-9a-f])([0-9a-f])\b/g, '#$1$1$2$2$3$3');
}

/* ── 6. reach proxy: how many source sites use the selector's classes ────── */
const srcFiles = [];
(function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!/node_modules|dist|\.git/.test(entry.name)) scan(p); continue; }
    if (/\.(tsx|ts|jsx|js|html)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)) srcFiles.push(p);
  }
})(path.join(ROOT, 'src'));
const srcText = srcFiles.map((f) => ({ f, t: fs.readFileSync(f, 'utf8') }));
const reachCache = new Map();
function reachOf(selKeyStr) {
  if (reachCache.has(selKeyStr)) return reachCache.get(selKeyStr);
  const subject = selKeyStr.split(/[>+~ ]/).filter(Boolean).pop() || selKeyStr;
  const tokens = [...subject.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
  if (!tokens.length) { reachCache.set(selKeyStr, { tokens: [], sites: 0, files: 0 }); return reachCache.get(selKeyStr); }
  // Count source lines that carry *every* class of the subject compound — counting
  // one token at a time would score `.editor-tab.active` off the word "active"
  // alone, which says nothing about how many elements the rule can match.
  const tokenRes = tokens.map((t) => new RegExp(`(?<![\\w-])${t.replace(/[-]/g, '\\-')}(?![\\w-])`));
  let sites = 0;
  const hitFiles = new Set();
  for (const { f, t } of srcText) {
    for (const line of t.split('\n')) {
      if (!tokenRes.every((re) => re.test(line))) continue;
      sites++;
      hitFiles.add(path.relative(ROOT, f));
    }
  }
  const out = { tokens, sites, files: hitFiles.size, method: 'source lines carrying all subject classes' };
  reachCache.set(selKeyStr, out);
  return out;
}

/* ── 7. per-group analysis ────────────────────────────────────────────────── */
const SIDES = { [STYLES]: 'styles', [WS]: 'workspace' };
const FAMILY_ORDER = [
  ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
];
function compressLonghands(ls) {
  // show "margin" when all four sides resolve the same way
  const out = [];
  const set = new Set(ls);
  const used = new Set();
  for (const fam of FAMILY_ORDER) {
    if (fam.every((L) => set.has(L))) {
      const base = fam[0].replace(/-top.*/, '');
      out.push(`${base}*`);
      fam.forEach((L) => used.add(L));
    }
  }
  for (const L of ls) if (!used.has(L)) out.push(L);
  return out.sort();
}

const groupReports = [];
let otherFileContaminated = 0;
for (const g of target) {
  const bySide = { styles: [], workspace: [] };
  for (const r of g.rules) {
    const side = SIDES[r.file];
    if (!side) { otherFileContaminated++; continue; }
    bySide[side].push(r);
  }
  // per-longhand winner among the group's own declarations, per selector key
  const longhands = new Set();
  for (const r of g.rules) for (const d of r.decls) { if (d.browserValid === false) continue; for (const L of coveredLonghands(d.prop)) longhands.add(L); }
  const conflicts = [];
  const perDecl = new Map(); // decl -> Set(winning longhands)
  for (const r of g.rules) for (const d of r.decls) perDecl.set(d, new Set());
  const sideNet = { styles: new Set(), workspace: new Set() };
  const sideLost = new Set(); // contested longhands lost by a side — filled below
  for (const L of longhands) {
    const dec = [];
    for (const side of ['styles', 'workspace']) {
      for (const r of bySide[side]) {
        for (const s of r.selectors) {
          if (s.key !== g.selKey) continue;
          for (const d of r.decls) {
            if (d.browserValid === false) continue;
            if (coveredLonghands(d.prop).includes(L)) dec.push({ side, rule: r, decl: d, sel: s, spec: s.spec });
          }
        }
      }
    }
    if (!dec.length) continue;
    let best = dec[0];
    for (let i = 1; i < dec.length; i++) { comparisons++; if (declBeats(dec[i], best)) best = dec[i]; }
    perDecl.get(best.decl).add(L);
    sideNet[best.side].add(L);
    const files = new Set(dec.map((x) => x.side));
    if (files.size > 1) {
      const loser = dec.find((x) => x.side !== best.side);
      // compare the *longhand* values, never the declaration texts
      const wLong = valueOf(best.decl, L);
      const lLong = valueOf(loser.decl, L);
      const comparable = wLong != null && lLong != null;
      const rw = comparable ? resolveValue(wLong, varTable.light) : null;
      const rl = comparable ? resolveValue(lLong, varTable.light) : null;
      let same = null;
      if (comparable) {
        const eq = (a, b) => normVal(a) === normVal(b) || hexExpand(a) === hexExpand(b);
        // both themes: two different tokens can coincide in light and diverge in dark
        const darkW = resolveValue(wLong, varTableDark);
        const darkL = resolveValue(lLong, varTableDark);
        same = eq(rw, rl) && eq(darkW, darkL);
        var darkSame = same;
      }
      else if (best.decl.prop === loser.decl.prop) same = normVal(best.decl.value) === normVal(loser.decl.value);
      conflicts.push({
        longhand: L,
        winnerSide: best.side,
        winnerFile: best.rule.file,
        winnerProp: best.decl.prop,
        winnerValue: best.decl.value,
        winnerLonghandValue: wLong,
        winnerOrderIndex: best.rule.orderIndex,
        loserSide: loser.side,
        loserFile: loser.rule.file,
        loserProp: loser.decl.prop,
        loserValue: loser.decl.value,
        loserLonghandValue: lLong,
        loserOrderIndex: loser.rule.orderIndex,
        valueComparable: comparable,
        sameValueText: best.decl.value === loser.decl.value,
        sameValue: same, // true / false / null(=cannot compare → no claim)
        resolvedWinner: rw,
        resolvedLoser: rl,
        varUnresolved: comparable && /var\(/.test((best.decl.value || '') + (loser.decl.value || '')) && /var\(/.test(rw + rl),
      });
    }
  }
  // per-declaration verdicts
  const ruleReports = [];
  for (const r of g.rules) {
    const side = SIDES[r.file] || null;
    const declReports = r.decls.map((d) => {
      const wins = d.browserValid === false ? [] : [...(perDecl.get(d) || [])];
      const covered = coveredLonghands(d.prop);
      const lost = covered.filter((L) => !wins.includes(L));
      return {
        prop: d.prop,
        value: d.value,
        important: d.important,
        index: d.index,
        raw: d.raw,
        browserValid: d.browserValid,
        // true only when this declaration is dead for *every* selector of its rule
        removableForWholeRule: d.removableForWholeRule,
        covers: covered,
        wins,
        loses: lost,
        netContribution: wins,
        verdict: d.browserValid === false ? 'rejected-by-browser'
          : wins.length === 0 ? 'zero-contribution' : (lost.length === 0 ? 'wins-all' : 'partial'),
      };
    });
    const multi = r.selectors.length > 1;
    ruleReports.push({
      side,
      file: r.file,
      orderIndex: r.orderIndex,
      ctx: r.cond,
      selectorRaw: r.selectorRaw,
      multiSelector: multi,
      otherSelectors: multi ? r.selectors.filter((s) => s.key !== g.selKey).map((s) => s.text) : [],
      specificityOfGroupSelector: r.selectors.find((s) => s.key === g.selKey)?.spec || null,
      specText: r.selectors.find((s) => s.key === g.selKey) ? specificityText(r.selectors.find((s) => s.key === g.selKey).spec) : null,
      declCount: r.decls.length,
      decls: declReports,
      raw: r.raw,
      netContribution: [...new Set(declReports.flatMap((d) => d.netContribution))].sort(),
      zeroDecls: declReports.filter((d) => d.verdict === 'zero-contribution').length,
      browserDropped: r.browserDropped,
    });
  }
  function specificityText(s) { return s ? `${s[0]},${s[1]},${s[2]}` : null; }

  // ── side summary ────────────────────────────────────────────────────────
  const sideSummary = {};
  for (const side of ['styles', 'workspace']) {
    const rs = ruleReports.filter((r) => r.side === side);
    const decls = rs.flatMap((r) => r.decls);
    const kept = decls.filter((d) => d.netContribution.length > 0);
    sideSummary[side] = {
      present: rs.length > 0,
      ruleCount: rs.length,
      declCount: decls.length,
      netContribution: [...sideNet[side]].sort(),
      // The decision unit is the declaration, not the longhand: `background` owning
      // 8 expanded longhands is one design decision, not eight.
      contributedDecls: kept.map((d) => ({
        prop: d.prop,
        value: d.value,
        important: d.important,
        kind: kindOf(d.prop),
        full: d.verdict === 'wins-all',
        wins: d.wins,
      })),
      contributedProps: [...new Set(kept.map((d) => d.prop))],
      zeroDecls: decls.filter((d) => d.verdict === 'zero-contribution').map((d) => `${d.prop}: ${d.value}`),
      allZero: decls.length > 0 && kept.length === 0,
      wonContested: [...new Set(conflicts.filter((c) => c.winnerSide === side).map((c) => c.longhand))].sort(),
      lostContested: [...new Set(conflicts.filter((c) => c.loserSide === side).map((c) => c.longhand))].sort(),
      signals: declSignals(decls.map((d) => ({ prop: d.prop, value: d.value }))),
      multiSelectorRules: rs.filter((r) => r.multiSelector).map((r) => r.selectorRaw),
    };
  }

  // ── which side reads newer ──────────────────────────────────────────────
  const sSig = sideSummary.styles.signals;
  const wSig = sideSummary.workspace.signals;
  let newerSide = null;
  let newerMargin = 0;
  const newerWhy = [];
  {
    const score = { styles: 0, workspace: 0 };
    const rate = (s) => s.newToken / Math.max(1, s.declCount);
    if (rate(sSig) < rate(wSig)) { score.workspace += 2; newerWhy.push(`新 token 密度 workspace ${(rate(wSig) * 100).toFixed(0)}% > styles ${(rate(sSig) * 100).toFixed(0)}%`); }
    else if (rate(sSig) > rate(wSig)) { score.styles += 2; newerWhy.push(`新 token 密度 styles ${(rate(sSig) * 100).toFixed(0)}% > workspace ${(rate(wSig) * 100).toFixed(0)}%`); }
    if (sSig.hex > wSig.hex) { score.workspace += 1; newerWhy.push(`写死 hex：workspace ${wSig.hex} < styles ${sSig.hex}`); }
    else if (wSig.hex > sSig.hex) { score.styles += 1; newerWhy.push(`写死 hex：styles ${sSig.hex} < workspace ${wSig.hex}`); }
    if (sSig.colorMix < wSig.colorMix) { score.workspace += 1; newerWhy.push(`color-mix：workspace ${wSig.colorMix} > styles ${sSig.colorMix}`); }
    else if (sSig.colorMix > wSig.colorMix) { score.styles += 1; newerWhy.push(`color-mix：styles ${sSig.colorMix} > workspace ${wSig.colorMix}`); }
    if (wSig.declCount < sSig.declCount) { score.workspace += 1; newerWhy.push(`声明更少：workspace ${wSig.declCount} < styles ${sSig.declCount}（靠旧表兜底）`); }
    else if (sSig.declCount < wSig.declCount) { score.styles += 1; newerWhy.push(`声明更少：styles ${sSig.declCount} < workspace ${wSig.declCount}`); }
    newerSide = score.workspace === score.styles ? null : (score.workspace > score.styles ? 'workspace' : 'styles');
    newerMargin = Math.abs(score.workspace - score.styles);
  }

  // ── bucket ─────────────────────────────────────────────────────────────
  const contested = [...new Set(conflicts.map((c) => c.longhand))];
  const differing = conflicts.filter((c) => c.sameValue === false);
  const uncomparable = conflicts.filter((c) => c.sameValue === null);
  // at declaration granularity, so 8 background longhands count once
  const differingPairs = [...new Set(differing.map((c) => `${c.winnerProp}|${c.loserProp}`))];
  // D: the winner carries a frozen literal while the loser had the token — judged
  // on the longhand values, so a shorthand text is never compared against a longhand.
  const oldStyleWinner = differing.filter((c) => {
    const w = c.winnerLonghandValue, l = c.loserLonghandValue;
    const wOld = (HEX.test(w) || RGBA.test(w)
      || (OLD_PX_RADIUS.test(w) && /radius|padding|margin|gap|width|height|top|left|right|bottom/i.test(c.longhand))) && !ANY_VAR.test(w);
    const lNew = ANY_VAR.test(l) || MIX.test(l);
    return wOld && lNew;
  });
  const sWon = sideSummary.styles.wonContested.length;
  const wWon = sideSummary.workspace.wonContested.length;
  const sameValueOf = new Map();
  for (const c of conflicts) sameValueOf.set(c.longhand, c.sameValue);

  // A side is deletable only if nothing it currently wins can change value when
  // removed: either it wins nothing, or every longhand it wins is contested and the
  // two sides resolve to the same value. Complementary properties can never be
  // dropped — nothing else provides them.
  function deletability(side) {
    const contributed = sideSummary[side].netContribution;
    if (!contributed.length) return { verdict: 'safe-empty', note: '零净贡献：每条声明都输' };
    const unequal = contributed.filter((L) => sameValueOf.get(L) !== true);
    if (!unequal.length) return { verdict: 'safe-same-value', note: `赢的 ${contributed.length} 个长写属性两边值相同` };
    return { verdict: 'keep', unequal };
  }
  const sDel = deletability('styles');
  const wDel = deletability('workspace');

  let bucket = 'C';
  let reason = '';
  let note = '';
  let loserSide = null;
  let bucketReasonCode = '';

  function describeKeep(side) {
    const decls = sideSummary[side].contributedDecls;
    const unknownProps = [...new Set(decls.filter((d) => d.kind === null).map((d) => d.prop))];
    const kinds = [...new Set(decls.map((d) => d.kind).filter(Boolean))];
    let code;
    if (unknownProps.length) {
      bucket = 'C';
      code = 'C-evidence-insufficient';
      reason = `${side} 必须保住 ${unknownProps.slice(0, 4).join('/')} 等属性，但它们的归类无法自动判定，证据不足`;
    } else if (kinds.length === 1 && kinds[0] === 'base') {
      bucket = 'B';
      code = 'B-loser-base-only';
      reason = `${side} 只占基础/布局属性（${decls.length} 条），可并入赢家那条规则`;
    } else if (kinds.every((k) => k === 'motion')) {
      bucket = 'C';
      code = 'C-loser-motion-only';
      reason = `${side} 只占动效属性（${decls.length} 条），静态视觉无差异但动效会丢`;
    } else {
      bucket = 'C';
      code = 'C-loser-design';
      reason = `${side} 还占${kinds.map((k) => KIND_LABEL[k]).join('/')}属性（${decls.length} 条），属设计取舍`;
    }
    note = `${side} 必须保住：${decls.map((d) => `${d.prop}: ${d.value}`).slice(0, 6).join('；')}`;
    bucketReasonCode = code;
  }

  if (oldStyleWinner.length) {
    bucket = 'D';
    bucketReasonCode = 'D-winner-is-old-writing';
    loserSide = oldStyleWinner[0].loserSide;
    const byWinner = ['styles', 'workspace']
      .map((s) => [s, oldStyleWinner.filter((c) => c.winnerSide === s).length]).filter(([, n]) => n);
    reason = `赢家反而是旧写法 ${oldStyleWinner.length} 处（${byWinner.map(([s, n]) => `${s} ${n}`).join(' / ')}），token 版那一侧输了`;
    note = oldStyleWinner.slice(0, 4).map((c) => `${c.longhand}: 赢家「${c.winnerLonghandValue}」 vs ${c.loserSide}「${c.loserLonghandValue}」`).join('；');
  } else if (sDel.verdict !== 'keep' && wDel.verdict !== 'keep') {
    bucket = 'A';
    bucketReasonCode = 'A-both-sides';
    reason = `两侧删掉都不改变计算值（styles: ${sDel.note}；workspace: ${wDel.note}）`;
    note = '两侧内容等价，可直接合并成一条';
  } else if (sDel.verdict !== 'keep') {
    bucket = 'A';
    bucketReasonCode = sDel.verdict === 'safe-empty' ? 'A-loser-zero-contribution' : 'A-loser-same-value';
    loserSide = 'styles';
    reason = `styles 可整条删：${sDel.note}`;
    note = `该侧 ${contested.length} 个冲突长写属性全部被 workspace 覆盖；这些声明当前的取值根本没有生效，删掉不产生任何值变化`;
  } else if (wDel.verdict !== 'keep') {
    bucket = 'A';
    bucketReasonCode = wDel.verdict === 'safe-empty' ? 'A-loser-zero-contribution' : 'A-loser-same-value';
    loserSide = 'workspace';
    reason = `workspace 可整条删：${wDel.note}`;
    note = `该侧 ${contested.length} 个冲突长写属性全部被 styles 覆盖；这些声明当前的取值根本没有生效，删掉不产生任何值变化`;
  } else if (!contested.length) {
    bucket = 'C';
    bucketReasonCode = 'C-no-conflict';
    reason = '无冲突：两边没有同一个属性，纯叠加层（没有「输家」，删任一侧都丢样式）';
    note = `styles 只占 ${sideSummary.styles.contributedProps.join('/') || '-'}；workspace 只占 ${sideSummary.workspace.contributedProps.join('/') || '-'}`;
  } else if (wWon === 0) {
    loserSide = 'workspace';
    describeKeep('workspace');
  } else if (sWon === 0) {
    loserSide = 'styles';
    describeKeep('styles');
  } else {
    bucket = 'C';
    bucketReasonCode = 'C-mixed-winners';
    reason = `冲突属性互有胜负（${sWon} 个归 styles、${wWon} 个归 workspace），逐属性赢家不同`;
    note = differing.slice(0, 5).map((c) => `${c.longhand}→${c.winnerSide}`).join('；');
  }
  const reasonCode = bucketReasonCode;
  const uncomparableCount = uncomparable.length;

  // Broader evidence for the D question: every differing conflict whose winner is a
  // frozen literal. Only "winner literal + loser token" is dangerous (old writing
  // beating the token); two literals just means neither side is tokenized.
  const literalWinner = differing.filter((c) => !ANY_VAR.test(c.winnerLonghandValue) && !MIX.test(c.winnerLonghandValue));
  const tokenLoser = literalWinner.filter((c) => ANY_VAR.test(c.loserLonghandValue) || MIX.test(c.loserLonghandValue));
  // The previous round agreed never to touch keyboard-focus rules or .md* rules,
  // so a group landing there is informational only.
  const conventionExcluded = /:focus/.test(g.selector) || /(^|[\s>+~,])\.md[A-Za-z-]*$/.test(g.selector);

  const reach = reachOf(g.selKey);
  const impact = differingPairs.length;
  const score = Math.max(1, reach.sites) * (1 + impact) + (bucket === 'D' ? 50 : 0);

  groupReports.push({
    selector: g.selector,
    ctx: g.ctx || '(top level)',
    files: [...new Set(g.rules.map((r) => r.file))],
    otherFileRival: g.rules.some((r) => !SIDES[r.file]),
    rules: ruleReports,
    conflicts,
    sideSummary,
    newerSide,
    newerMargin,
    newerConfidence: newerSide == null ? 'tie' : (newerMargin >= 2 && Math.min(sSig.declCount, wSig.declCount) >= 3 ? 'strong' : 'weak'),
    newerWhy,
    conventionExcluded,
    literalWinner: literalWinner.length,
    tokenLoser: tokenLoser.length,
    // rule-granularity guard: a multi-selector rule cannot be deleted on the strength
    // of this group alone — its sibling selectors are governed by other groups.
    loserMultiSelector: !!loserSide && sideSummary[loserSide].multiSelectorRules.length > 0,
    bucket,
    reasonCode,
    loserSide,
    reason,
    note,
    reach,
    impact,
    score,
    counts: {
      longhands: longhands.size,
      contested: contested.length,
      differingLonghands: differing.length,
      differingPairs: differingPairs.length,
      uncomparable: uncomparable.length,
      sameValue: conflicts.filter((c) => c.sameValue === true).length,
    },
  });
}

groupReports.sort((a, b) => b.score - a.score || b.impact - a.impact);
groupReports.forEach((g, i) => { g.id = `W${String(i + 1).padStart(3, '0')}`; });
// Ranking for "what to touch first": only groups that actually need a decision.
// C-no-conflict has no winner question at all, so it must not crowd the list.
const actionable = groupReports.filter((g) => g.reasonCode !== 'C-no-conflict')
  .sort((a, b) => b.score - a.score || b.impact - a.impact);
actionable.forEach((g, i) => { g.actionRank = i + 1; });
const noAction = groupReports.filter((g) => g.reasonCode === 'C-no-conflict');

/* ── 8. aggregate ─────────────────────────────────────────────────────────── */
const byBucket = { A: [], B: [], C: [], D: [] };
for (const g of groupReports) byBucket[g.bucket].push(g);
const reasonCounts = {};
for (const g of groupReports) {
  const k = `${g.bucket}:${g.reasonCode}`;
  reasonCounts[k] = (reasonCounts[k] || 0) + 1;
}
let declTotal = 0, zeroTotal = 0, multiRules = 0;
for (const g of groupReports) for (const r of g.rules) { declTotal += r.decls.length; zeroTotal += r.zeroDecls; if (r.multiSelector) multiRules++; }

const SCHEMA = {
  note: '每个字段的含义；所有 orderIndex 来自浏览器 CSSOM（C:/tmp/css-auth-order.json），不是文件顺序推断',
  'selector': '组键里的选择器（已去掉多余空白，保持原大小写）',
  'ctx': 'at-rule 上下文；来自浏览器 conditionText，不在同一上下文的同名选择器不会合进同一组',
  'rules[].orderIndex': '该规则在 CSSOM 文档序中的全局位置；赢家比较用它，而不是文件位置',
  'rules[].specificityOfGroupSelector': '[a,b,c] 形式；同一规则的不同选择器特异性可以不同',
  'rules[].multiSelector': 'true 表示该规则还有别的选择器，按规则粒度判：只要对兄弟选择器仍赢，整条必须保住',
  'rules[].decls[].covers': '展开 shorthand 后这条声明覆盖的长写属性（padding → 4 条…）',
  'rules[].decls[].wins': '在本组声明里，这条声明是哪些长写属性的赢家',
  'rules[].decls[].netContribution': '= wins；空数组即「零净贡献」，删这条不改变任何计算值',
  'conflicts[]': '只有两边都声明了同一长写属性时才有条目；逐属性列赢家',
  'conflicts[].sameValueResolved': '两边文本可能不同，但沿 var() 解析（取 :root 亮色表）后值相等 → 删除不产生视觉差异',
  'sideSummary[side].netContribution': '该侧在本组里仍是赢家的长写属性集合（=赢的冲突属性 + 只有它声明的属性）',
  'sideSummary[side].wonContested / lostContested': '冲突属性里赢/输的部分',
  'sideSummary[side].signals': 'newToken=用 --r-*/--sp-*/--fs-* 等新 token 的声明数；hex/rgba=写死颜色；literalPx=写死 px；declCount=声明数',
  'newerSide + newerWhy': '客观信号投票，tie 时给 null',
  'bucket': 'A 可删（输家零净贡献）/ B 需合并（净贡献是基础布局属性）/ C 需人判断 / D 危险（赢家是旧写法）',
  'reach': 'selector 主体里的 class 在 src/**/*.tsx|ts 里出现的次数（受影响元素数的代理指标）',
  'impact': '两边都声明且解析值不同的长写属性数（视觉差异程度）',
  'score': 'reach.sites × (1+impact)，D 桶额外 +50；用于排"最该先处理"',
};

const report = {
  generatedAt: new Date().toISOString(),
  scope: 'styles.css ↔ workspace-shell.css 跨文件重复选择器组',
  method: {
    orderAuthority: 'Chromium CSSOM via C:/tmp/css-auth-order.cjs (frozen snapshot C:/tmp/css-auth-snap)',
    precedence: '(!important, specificity, CSSOM orderIndex, declaration index)',
    shorthand: 'EXPAND from scripts/css-lib.mjs, 60+ shorthands',
    context: 'group key = at-rule context + selector；@media/@supports 内不同上下文不合并',
    caveat: '其他文件里同选择器的高序规则未纳入赢家比较（本报告只判这两个文件之间谁赢）；otherFileRival=true 表示该组还有第三个文件参与',
  },
  snapshot: { dir: SNAP, hashes, orderJson: ORDER_JSON, cssom: snapOrder.sheets },
  alignment: { matchedRules: orderMatches, problems: alignReport, absentInCssom: absentReport },
  declarationValidation: {
    distinctPairs: null,
    rejectedByBrowser: invalidDecls,
    unchecked: uncheckedDecls,
    source: 'CSS.supports(prop, value) evaluated in the same Chromium as the order read',
  },
  totals: {
    groups: groupReports.length,
    buckets: { A: byBucket.A.length, B: byBucket.B.length, C: byBucket.C.length, D: byBucket.D.length },
    declarationsInGroups: declTotal,
    zeroContributionDeclarations: zeroTotal,
    rulesWithMultipleSelectors: multiRules,
    deadForGroupSelectorButAliveForSibling: groupReports.reduce((n, g) => n + g.rules.reduce((m, r) => m + r.decls.filter((d) => d.verdict === 'zero-contribution' && d.removableForWholeRule === false).length, 0), 0),
    propertyComparisons: comparisons,
    ruleGranularityComparisons,
    otherFileContaminated: groupReports.filter((g) => g.otherFileRival).length,
    needsDecision: actionable.length,
    noConflict: noAction.length,
    conventionExcluded: groupReports.filter((g) => g.conventionExcluded).length,
  },
  reasonCounts,
  // Declarations that are provably removable right now: they lose every longhand they
  // cover to the other file's declaration, so deleting them cannot change a computed
  // value. This is the only part of the 113 groups that is mechanical.
  zeroContributionDecls: groupReports.flatMap((g) => g.rules.flatMap((r) => r.decls
    .filter((d) => d.verdict === 'zero-contribution' && d.removableForWholeRule)
    .map((d) => ({
      groupId: g.id,
      selector: g.selector,
      file: r.file,
      orderIndex: r.orderIndex,
      prop: d.prop,
      value: d.value,
      covers: d.covers,
      multiSelector: r.multiSelector,
      otherSelectors: r.otherSelectors,
      beatenBy: g.conflicts.filter((c) => d.covers.includes(c.longhand) && c.loserSide === r.side)
        .map((c) => `${c.winnerFile}:${c.winnerProp}: ${c.winnerLonghandValue}`)[0] || null,
    })))).sort((a, b) => a.selector.localeCompare(b.selector)),
  // The list to work from: groups that need a decision, biggest blast radius first.
  triage: groupReports
    .filter((g) => g.reasonCode !== 'C-no-conflict')
    .sort((a, b) => b.impact - a.impact || b.score - a.score)
    .slice(0, 15)
    .map((g) => ({
      id: g.id, selector: g.selector, bucket: g.bucket, reasonCode: g.reasonCode,
      reach: g.reach.sites, impact: g.impact, loserSide: g.loserSide,
      differences: g.conflicts.filter((c) => c.sameValue === false)
        .map((c) => `${c.longhand}: ${c.winnerLonghandValue} ← ${c.loserLonghandValue}`),
      keep: g.sideSummary[g.loserSide]?.contributedProps || [],
    })),
  schema: SCHEMA,
  groups: groupReports,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

console.log('groups', groupReports.length, 'buckets', report.totals.buckets);
console.log('decls', declTotal, 'zero-contribution', zeroTotal, 'comparisons', comparisons);
console.log('alignment problems', alignReport.length, JSON.stringify(alignReport.slice(0, 5)));
console.log('otherFileRival', report.totals.otherFileContaminated);
console.log('wrote', OUT);
for (const g of groupReports.slice(0, 12)) console.log(g.id, g.bucket, g.score.toFixed(0), g.selector, '|', g.reason.slice(0, 60));

if (process.argv.includes('--md')) {
  for (const b of ['A', 'B', 'C', 'D']) {
    console.log(`\n=== ${b} (${byBucket[b].length}) ===`);
    for (const g of byBucket[b]) {
      console.log(`${g.id} ${g.selector} impact=${g.impact} reach=${g.reach.sites}`);
      for (const r of g.rules) console.log(`   ${r.side.padEnd(9)} oi=${String(r.orderIndex).padStart(5)} spec=${r.specText} decls=${r.declCount} zero=${r.zeroDecls} net=[${r.netContribution.join(',')}]`);
      for (const c of g.conflicts) console.log(`     · ${c.longhand}: ${c.winnerSide}«${c.winnerValue}» vs ${c.loserSide}«${c.loserValue}»${c.sameValueResolved ? ' (解析值相同)' : ''}`);
    }
  }
}
