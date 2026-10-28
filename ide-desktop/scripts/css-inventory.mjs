// Inventory + property-level cascade analysis for the 6 global stylesheets.
// Usage: node scripts/css-inventory.mjs [outJson]
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = process.argv[2] || 'C:/tmp/css-inv.json';

// Load order is fixed by src/main.tsx:5-10
const FILES = [
  'src/styles.css',
  'src/conversation-shell.css',
  'src/settings-shell.css',
  'src/workspace-shell.css',
  'src/background-browser.css',
  'src/gui-control.css',
];

/* ── specificity ─────────────────────────────────────────────── */
export function splitTopLevel(str, sep = ',') {
  const out = [];
  let depth = 0, buf = '', quote = null;
  for (const ch of str) {
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

export function cmpSpec(x, y) { return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }

export function specificity(sel) {
  let a = 0, b = 0, c = 0;
  let i = 0;
  const s = sel;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '#') { a++; i++; while (i < s.length && /[\w-]/.test(s[i])) i++; continue; }
    if (ch === '.') { b++; i++; while (i < s.length && /[\w-]/.test(s[i])) i++; continue; }
    if (ch === '[') {
      b++; let depth = 1; i++;
      while (i < s.length && depth > 0) { if (s[i] === '[') depth++; else if (s[i] === ']') depth--; i++; }
      continue;
    }
    if (ch === ':') {
      const isElement = s[i + 1] === ':';
      i += isElement ? 2 : 1;
      let name = '';
      while (i < s.length && /[\w-]/.test(s[i])) { name += s[i]; i++; }
      let args = null;
      if (s[i] === '(') {
        let depth = 1; i++; let buf = '';
        while (i < s.length && depth > 0) {
          if (s[i] === '(') depth++;
          else if (s[i] === ')') { depth--; if (depth === 0) { i++; break; } }
          buf += s[i]; i++;
        }
        args = buf;
      }
      if (isElement) { c++; continue; }
      if (/^(before|after|first-line|first-letter)$/.test(name)) { c++; continue; }
      if (['is', 'not', 'has', 'matches', 'any', '-webkit-any', '-moz-any'].includes(name)) {
        if (args != null) {
          let best = [0, 0, 0];
          for (const part of splitTopLevel(args)) {
            const sp = specificity(part);
            if (cmpSpec(sp, best) > 0) best = sp;
          }
          a += best[0]; b += best[1]; c += best[2];
        }
        continue;
      }
      if (name === 'where') continue;
      if (['nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'slotted'].includes(name) && args != null) {
        b++;
        const ofPart = args.match(/\bof\b([\s\S]*)$/);
        if (ofPart) {
          let best = [0, 0, 0];
          for (const part of splitTopLevel(ofPart[1])) {
            const sp = specificity(part);
            if (cmpSpec(sp, best) > 0) best = sp;
          }
          a += best[0]; b += best[1]; c += best[2];
        }
        continue;
      }
      b++; continue;
    }
    if (ch === '*') { i++; continue; }
    if (/[a-zA-Z]/.test(ch)) {
      let name = '';
      while (i < s.length && /[\w-]/.test(s[i])) { name += s[i]; i++; }
      c++; continue;
    }
    i++;
  }
  return [a, b, c];
}

/* ── shorthand expansion ─────────────────────────────────────── */
export const EXPAND = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  inset: ['top', 'right', 'bottom', 'left'],
  'inset-block': ['inset-block-start', 'inset-block-end'],
  'inset-inline': ['inset-inline-start', 'inset-inline-end'],
  gap: ['row-gap', 'column-gap'],
  'grid-gap': ['row-gap', 'column-gap'],
  overflow: ['overflow-x', 'overflow-y'],
  'overscroll-behavior': ['overscroll-behavior-x', 'overscroll-behavior-y'],
  border: [
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  ],
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  'border-block': ['border-block-start-width', 'border-block-end-width', 'border-block-start-style', 'border-block-end-style', 'border-block-start-color', 'border-block-end-color'],
  'border-inline': ['border-inline-start-width', 'border-inline-end-width', 'border-inline-start-style', 'border-inline-end-style', 'border-inline-start-color', 'border-inline-end-color'],
  outline: ['outline-width', 'outline-style', 'outline-color'],
  background: ['background-image', 'background-position', 'background-size', 'background-repeat', 'background-origin', 'background-clip', 'background-attachment', 'background-color'],
  font: ['font-style', 'font-variant', 'font-weight', 'font-stretch', 'font-size', 'line-height', 'font-family'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'],
  animation: ['animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state'],
  'list-style': ['list-style-type', 'list-style-position', 'list-style-image'],
  'text-decoration': ['text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness'],
  'place-items': ['align-items', 'justify-items'],
  'place-self': ['align-self', 'justify-self'],
  'place-content': ['align-content', 'justify-content'],
  'grid-template': ['grid-template-rows', 'grid-template-columns', 'grid-template-areas'],
  'grid-area': ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'],
  'grid-row': ['grid-row-start', 'grid-row-end'],
  'grid-column': ['grid-column-start', 'grid-column-end'],
  columns: ['column-width', 'column-count'],
  'column-rule': ['column-rule-width', 'column-rule-style', 'column-rule-color'],
  scrollbar: ['scrollbar-width', 'scrollbar-color'],
  'scroll-margin': ['scroll-margin-top', 'scroll-margin-right', 'scroll-margin-bottom', 'scroll-margin-left'],
  'scroll-padding': ['scroll-padding-top', 'scroll-padding-right', 'scroll-padding-bottom', 'scroll-padding-left'],
  'border-image': ['border-image-source', 'border-image-slice', 'border-image-width', 'border-image-outset', 'border-image-repeat'],
};

// Property families: a declaration of `prop` blocks the same longhand names.
export function coveredLonghands(prop) {
  if (prop.startsWith('--')) return [prop];
  return EXPAND[prop] || [prop];
}

/* ── parse ───────────────────────────────────────────────────── */
const CONDITIONAL = /^(@media|@supports|@container|@layer|@document|@scope)$/;

export function normalizeSelector(s) {
  return s.replace(/\s*([>+~])\s*/g, '$1').replace(/\s+/g, ' ').trim();
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

const rules = [];
const fileHashes = {};
let globalOrder = 0;

for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  const css = fs.readFileSync(abs, 'utf8');
  fileHashes[rel] = hash(css);
  const root = postcss.parse(css, { from: abs, map: false });

  const walk = (node, ctx) => {
    node.each((child) => {
      if (child.type === 'atrule') {
        if (CONDITIONAL.test('@' + child.name)) {
          const params = child.params.replace(/\s*:\s*/g, ':').replace(/\s+/g, ' ').trim();
          walk(child, ctx.concat(`@${child.name} ${params}`.trim()));
        } else if (/keyframes$/i.test(child.name)) {
          child.walkRules(() => { globalOrder++; });
        } else if (child.nodes) {
          walk(child, ctx);
        }
        return;
      }
      if (child.type === 'rule') {
        globalOrder++;
        const selectors = splitTopLevel(child.selector).map(normalizeSelector);
        const decls = [];
        child.each((d) => {
          if (d.type === 'decl') {
            decls.push({
              prop: d.prop.toLowerCase(),
              value: d.value.trim(),
              important: Boolean(d.important),
              index: decls.length,
              start: d.source.start.offset,
              end: d.source.end.offset,
            });
          }
        });
        if (!decls.length) return;
        rules.push({
          file: rel,
          order: globalOrder,
          ctx: ctx.join(' | '),
          selectorRaw: child.selector,
          selectors,
          decls,
          start: child.source.start.offset,
          end: child.source.end.offset,
        });
      }
    });
  };
  walk(root, []);
}

/* ── group duplicate selectors ───────────────────────────────── */
// key = selector + context (context must match exactly)
const groups = new Map();
for (const rule of rules) {
  for (const sel of rule.selectors) {
    const key = `${rule.ctx}\u0000${sel}`;
    let g = groups.get(key);
    if (!g) {
      g = { selector: sel, ctx: rule.ctx, rules: [] };
      groups.set(key, g);
    }
    g.rules.push(rule);
  }
}

const dupes = [];
for (const g of groups.values()) {
  if (g.rules.length < 2) continue;
  const files = new Set(g.rules.map((r) => r.file));
  if (files.size < 2) continue;
  dupes.push(g);
}

/* ── property-level winner analysis per group ───────────────── */
function analyzeGroup(g) {
  // For each longhand covered by any decl, find winning declaration.
  // Winner precedence: (important, specificity, order). !important inverts specificity/order
  // only relative to non-important, which the tuple handles.
  const byLonghand = new Map(); // longhand -> list of {rule, decl, longhand}
  for (const rule of g.rules) {
    const spec = specificity(g.selector);
    for (const decl of rule.decls) {
      for (const lh of coveredLonghands(decl.prop)) {
        let arr = byLonghand.get(lh);
        if (!arr) { arr = []; byLonghand.set(lh, arr); }
        arr.push({ rule, decl, spec });
      }
    }
  }

  const winners = new Map(); // longhand -> {rule, decl}
  for (const [lh, arr] of byLonghand) {
    let best = null;
    for (const c of arr) {
      if (!best) { best = c; continue; }
      const cImp = c.decl.important ? 1 : 0;
      const bImp = best.decl.important ? 1 : 0;
      if (cImp !== bImp) { if (cImp > bImp) best = c; continue; }
      const sc = cmpSpec(c.spec, best.spec);
      if (sc > 0) { best = c; continue; }
      if (sc < 0) continue;
      if (c.rule.order > best.rule.order) best = c;
      else if (c.rule.order === best.rule.order && c.decl.index > best.decl.index) best = c;
    }
    winners.set(lh, best);
  }

  // per-rule contribution
  const perRule = new Map();
  for (const rule of g.rules) {
    perRule.set(rule, { winningDecls: new Set(), losingDecls: new Set() });
  }
  // map decl -> rule via search
  const declOwner = new Map();
  for (const rule of g.rules) for (const d of rule.decls) declOwner.set(d, rule);

  for (const [, win] of winners) {
    perRule.get(win.rule).winningDecls.add(win.decl);
  }
  for (const rule of g.rules) {
    for (const d of rule.decls) {
      const rec = perRule.get(rule);
      if (!rec.winningDecls.has(d)) {
        // only "losing" if every longhand it covers has a winner that is not this decl
        const allLost = coveredLonghands(d.prop).every((lh) => winners.get(lh).decl !== d);
        if (allLost) rec.losingDecls.add(d);
        else rec.winningDecls.add(d);
      }
    }
  }

  return { winners, perRule };
}

const summary = {
  generatedAt: new Date().toISOString(),
  fileHashes,
  files: FILES,
  totalRules: rules.length,
  duplicateGroups: dupes.length,
  byFilePair: {},
  groups: [],
};

for (const g of dupes) {
  const { winners, perRule } = analyzeGroup(g);
  const pairKey = [...new Set(g.rules.map((r) => r.file))].sort().join(' + ');
  summary.byFilePair[pairKey] = (summary.byFilePair[pairKey] || 0) + 1;
  const entry = {
    selector: g.selector,
    ctx: g.ctx,
    rules: g.rules.map((r) => {
      const rec = perRule.get(r);
      return {
        file: r.file,
        order: r.order,
        spec: specificity(g.selector),
        multiSelector: r.selectors.length > 1,
        selectorRaw: r.selectorRaw,
        decls: r.decls.map((d) => ({
          prop: d.prop,
          value: d.value,
          important: d.important,
          start: d.start,
          end: d.end,
          win: rec.winningDecls.has(d),
          lose: rec.losingDecls.has(d),
        })),
        winningCount: rec.winningDecls.size,
        losingCount: rec.losingDecls.size,
      };
    }),
    winnerCount: winners.size,
    // a rule that contributes nothing at all
    zeroRules: g.rules.filter((r) => perRule.get(r).winningDecls.size === 0).length,
  };
  summary.groups.push(entry);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(summary, null, 1));

console.log('files', FILES.length, 'rules', rules.length);
console.log('duplicate groups', dupes.length);
console.log('by file pair:');
for (const [k, v] of Object.entries(summary.byFilePair).sort((a, b) => b[1] - a[1])) console.log(' ', v, k);
const zero = summary.groups.filter((g) => g.zeroRules > 0).length;
console.log('groups with >=1 fully-eliminable rule:', zero);
let totalDecls = 0, totalZero = 0, totalWin = 0;
for (const g of summary.groups) {
  for (const r of g.rules) { totalDecls += r.decls.length; totalZero += r.losingCount; totalWin += r.winningCount; }
}
console.log('declarations in dup groups:', totalDecls, 'losing:', totalZero, 'winning:', totalWin);
console.log('wrote', OUT);
