// Shared CSS parsing / cascade helpers for the style-consolidation work.
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

export const FILES = [
  'src/styles.css',
  'src/conversation-shell.css',
  'src/settings-shell.css',
  'src/workspace-shell.css',
  'src/background-browser.css',
  'src/gui-control.css',
];

export function rootDir() {
  return path.resolve(import.meta.dirname, '..');
}

export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

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
export function specKey(s) { return s.join(','); }

// Cascade precedence: importance, specificity, rule order, declaration index.
export function declBeats(c, b) {
  const cImp = c.decl.important ? 1 : 0;
  const bImp = b.decl.important ? 1 : 0;
  if (cImp !== bImp) return cImp > bImp;
  const sc = cmpSpec(c.spec, b.spec);
  if (sc !== 0) return sc > 0;
  if (c.rule.order !== b.rule.order) return c.rule.order > b.rule.order;
  return c.decl.index > b.decl.index;
}

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
      while (i < s.length && /[\w-]/.test(s[i])) i++;
      c++; continue;
    }
    i++;
  }
  return [a, b, c];
}

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

export function coveredLonghands(prop) {
  if (prop.startsWith('--')) return [prop];
  return EXPAND[prop] || [prop];
}

export function normalizeSelector(s) {
  return s.replace(/\s*([>+~])\s*/g, '$1').replace(/\s+/g, ' ').trim();
}

const CONDITIONAL = /^(@media|@supports|@container|@layer|@document|@scope)$/;

export function parseAll(root = rootDir()) {
  const rules = [];
  const fileHashes = {};
  const sourceText = {};
  let globalOrder = 0;
  for (const rel of FILES) {
    const abs = path.join(root, rel);
    const css = fs.readFileSync(abs, 'utf8');
    fileHashes[rel] = hash(css);
    sourceText[rel] = css;
    const ast = postcss.parse(css, { from: abs, map: false });
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
                raw: sourceText[rel].slice(d.source.start.offset, d.source.end.offset),
              });
            }
          });
          if (!decls.length) return;
          rules.push({
            id: rules.length,
            file: rel,
            order: globalOrder,
            ctx: ctx.join(' | '),
            selectorRaw: child.selector,
            selectors,
            decls,
            start: child.source.start.offset,
            end: child.source.end.offset,
            raw: sourceText[rel].slice(child.source.start.offset, child.source.end.offset),
          });
        }
      });
    };
    walk(ast, []);
  }
  for (const r of rules) for (const d of r.decls) d.rule = r;
  return { rules, fileHashes, sourceText };
}

/* ── subject-compound compatibility ──────────────────────────── */
function compoundsOf(sel) {
  const parts = [];
  let depth = 0, quote = null, buf = '';
  for (const ch of sel) {
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && (ch === '>' || ch === '+' || ch === '~' || ch === ' ')) {
      if (buf.trim()) parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function subjectFacts(sel) {
  const cs = compoundsOf(sel);
  const subject = cs[cs.length - 1] || sel;
  const facts = { type: null, ids: [], attrs: new Map(), pseudoElements: new Set() };
  // strip pseudo-element functions? keep simple
  const typeMatch = subject.match(/^([a-zA-Z][\w-]*)/);
  if (typeMatch) facts.type = typeMatch[1].toLowerCase();
  for (const m of subject.matchAll(/#([\w-]+)/g)) facts.ids.push(m[1]);
  for (const m of subject.matchAll(/\[([^\]=~|^$*\s]+)\s*([~|^$*]?=)\s*("([^"]*)"|'([^']*)'|[^\]]+)\]/g)) {
    const name = m[1].toLowerCase();
    const val = (m[4] ?? m[5] ?? m[3] ?? '').trim();
    facts.attrs.set(name, val);
  }
  for (const m of subject.matchAll(/::([\w-]+)/g)) facts.pseudoElements.add(m[1].toLowerCase());
  for (const m of subject.matchAll(/(?<!:):(before|after|first-line|first-letter)\b/g)) facts.pseudoElements.add(m[1].toLowerCase());
  return facts;
}

export function canCoMatch(a, b) {
  const fa = subjectFacts(a);
  const fb = subjectFacts(b);
  if (fa.type && fb.type && fa.type !== fb.type) return false;
  for (const id of fa.ids) if (fb.ids.length && !fb.ids.includes(id)) return false;
  for (const id of fb.ids) if (fa.ids.length && !fa.ids.includes(id)) return false;
  for (const [name, val] of fa.attrs) {
    if (fb.attrs.has(name) && fb.attrs.get(name) !== val) return false;
  }
  if (fa.pseudoElements.size && fb.pseudoElements.size) {
    const inter = [...fa.pseudoElements].some((x) => fb.pseudoElements.has(x));
    if (!inter) return false;
  } else if (fa.pseudoElements.size !== fb.pseudoElements.size) {
    return false;
  }
  return true;
}
