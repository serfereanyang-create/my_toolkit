// Reconcile the "123 groups" figure in css-consolidation.md against what a re-count
// says today, and against the snapshot this report was computed from.
//
//   node scripts/css-authority-workspace-reconcile.mjs
//
// Three states, one grouping rule (postcss parse, group key = at-rule context +
// selector, only groups spanning ≥2 files, only the styles ↔ workspace-shell pair):
//
//   C:/tmp/css-backup    改造前   → the 123 in css-consolidation.md §3.1
//   C:/tmp/css-final     改造后   → the 112 this round inherits (byte-identical to the
//                                   snapshot used for the authority analysis)
//   ide-desktop/src      当前工作树 → what a re-count finds right now
//
// Writes C:/tmp/css-auth-reconcile.json so the report can quote the numbers instead
// of re-deriving them.
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { splitTopLevel, normalizeSelector, rootDir } from './css-lib.mjs';

const FILES = ['styles.css', 'conversation-shell.css', 'settings-shell.css', 'workspace-shell.css', 'background-browser.css', 'gui-control.css'];
const CONDITIONAL = /^(@media|@supports|@container|@layer|@document|@scope)$/;

export function groupsIn(dir) {
  const rules = [];
  for (const f of FILES) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const css = fs.readFileSync(p, 'utf8');
    const ast = postcss.parse(css, { from: p, map: false });
    const walk = (node, ctx) => {
      node.each((c) => {
        if (c.type === 'atrule') {
          if (CONDITIONAL.test('@' + c.name)) walk(c, [...ctx, `@${c.name} ${c.params.replace(/\s*:\s*/g, ':').replace(/\s+/g, ' ').trim()}`.trim()]);
          return;
        }
        if (c.type !== 'rule') return;
        const n = c.nodes.filter((d) => d.type === 'decl').length;
        for (const s of splitTopLevel(c.selector).map(normalizeSelector)) rules.push({ file: f, ctx: ctx.join(' | '), sel: s, decls: n });
      });
    };
    walk(ast, []);
  }
  const g = new Map();
  for (const r of rules) {
    if (!r.decls) continue; // zero-declaration rules never enter the cascade
    const k = `${r.ctx}\u0000${r.sel}`;
    if (!g.has(k)) g.set(k, new Set());
    g.get(k).add(r.file);
  }
  const cross = [...g.entries()].filter(([, files]) => files.size > 1);
  const sw = cross.filter(([, files]) => files.has('styles.css') && files.has('workspace-shell.css'));
  return { total: cross.length, stylesWorkspace: sw.length, keys: sw.map(([k]) => k) };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const ROOT = rootDir();
  const states = {
    before: groupsIn('C:/tmp/css-backup'),
    after: groupsIn('C:/tmp/css-final'),
    snapshot: groupsIn('C:/tmp/css-auth-snap'),
    tree: groupsIn(path.join(ROOT, 'src')),
  };
  const out = { generatedAt: new Date().toISOString(), counts: {}, diffs: {} };
  for (const [k, v] of Object.entries(states)) out.counts[k] = { crossFile: v.total, stylesWorkspace: v.stylesWorkspace };
  const setOf = (s) => new Set(states[s].keys);
  const cmp = (a, b) => {
    const A = setOf(a), B = setOf(b);
    return { gone: [...A].filter((k) => !B.has(k)), added: [...B].filter((k) => !A.has(k)) };
  };
  out.diffs.after_vs_before = cmp('before', 'after');
  out.diffs.snapshot_vs_after = cmp('after', 'snapshot');
  out.diffs.tree_vs_snapshot = cmp('snapshot', 'tree');

  fs.mkdirSync('C:/tmp', { recursive: true });
  fs.writeFileSync('C:/tmp/css-auth-reconcile.json', JSON.stringify(out, null, 1));

  for (const [k, v] of Object.entries(out.counts)) console.log(`${k.padEnd(9)} cross-file dup groups ${v.crossFile} | styles↔workspace ${v.stylesWorkspace}`);
  for (const [k, v] of Object.entries(out.diffs)) {
    console.log(`${k}: -${v.gone.length} +${v.added.length}`);
    for (const g of v.gone) console.log('   - ', g.replace('\u0000', ' | '));
    for (const g of v.added) console.log('   + ', g.replace('\u0000', ' | '));
  }
  console.log('wrote C:/tmp/css-auth-reconcile.json');
}
