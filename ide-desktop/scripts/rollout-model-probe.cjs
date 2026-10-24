const fs = require('fs');
const f = process.argv[2];
const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);

const modelCount = new Map();
const baseCount = new Map();
const provCount = new Map();
let firstSample = null;
let lastSample = null;
let total = 0;

for (const l of lines) {
  let o;
  try { o = JSON.parse(l); } catch (e) { continue; }
  total++;
  if (!o || typeof o !== 'object') continue;

  // top-level model field
  const m = typeof o.model === 'string' ? o.model
    : (o.model && typeof o.model === 'object' ? (o.model.modelId || o.model.id || JSON.stringify(o.model).slice(0, 80)) : null);
  if (m) {
    modelCount.set(m, (modelCount.get(m) || 0) + 1);
    if (!firstSample) firstSample = { model: m, ts: o.startedAt };
    lastSample = { model: m, ts: o.startedAt, id: o.requestId };
  }

  const s = l;
  let bm = s.match(/"baseURL"\s*:\s*"([^"]+)"/);
  if (bm) baseCount.set(bm[1], (baseCount.get(bm[1]) || 0) + 1);
  let pm = s.match(/"providerId"\s*:\s*"([^"]+)"/);
  if (pm) provCount.set(pm[1], (provCount.get(pm[1]) || 0) + 1);
}

console.log('file:', f);
console.log('records:', total);
console.log('\n=== model field frequency ===');
for (const [k, v] of [...modelCount].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(5), k);
console.log('\n=== baseURL frequency ===');
for (const [k, v] of [...baseCount].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(String(v).padStart(5), k);
console.log('\n=== providerId frequency ===');
for (const [k, v] of [...provCount].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(String(v).padStart(5), k);
console.log('\nfirst:', JSON.stringify(firstSample));
console.log('last:', JSON.stringify(lastSample));
