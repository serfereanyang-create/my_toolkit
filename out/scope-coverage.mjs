import fs from 'node:fs';
import { createDefaultToolRegistry } from '../dist/src/tools/registry.js';

const src = fs.readFileSync('src/tools/scope.ts', 'utf8');
const setOf = (name) => {
  const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
};

const compact = setOf('COMPACT_ALLOW');
const standardExtra = setOf('STANDARD_EXTRA_ALLOW');
const highValue = setOf('HIGH_VALUE_EXTRA');

const all = createDefaultToolRegistry().list().map((t) => ({ name: t.name, risk: t.risk }));
const names = new Set(all.map((t) => t.name));

const unclassified = [];
for (const t of all) {
  if (compact.has(t.name) || standardExtra.has(t.name)) continue;
  unclassified.push({ name: t.name, risk: t.risk, highValueOnly: highValue.has(t.name) });
}

const readOnlyUnclassified = unclassified.filter((t) => t.risk === 'read' && !t.name.startsWith('plugin_') && !t.name.startsWith('mcp_'));
const writeUnclassified = unclassified.filter((t) => t.risk !== 'read' && !t.name.startsWith('plugin_') && !t.name.startsWith('mcp_'));

console.log(JSON.stringify({
  registered: all.length,
  compactAllow: compact.size,
  standardExtra: standardExtra.size,
  highValue: highValue.size,
  fullOnly: unclassified.length,
  readOnlyFullOnly: readOnlyUnclassified.length,
  writeFullOnly: writeUnclassified.length,
  allowlistedButUnregistered: [...compact, ...standardExtra].filter((n) => !names.has(n)),
  readOnlyFullOnlyNames: readOnlyUnclassified.map((t) => t.name + (t.highValueOnly ? '*' : '')),
  writeFullOnlyNames: writeUnclassified.map((t) => `${t.name}(${t.risk})${t.highValueOnly ? '*' : ''}`),
}, null, 2));
