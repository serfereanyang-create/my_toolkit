const fs = require('fs');
const f = process.argv[2];
const wantModel = process.argv[3];
const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);

for (const l of lines) {
  let o;
  try { o = JSON.parse(l); } catch (e) { continue; }
  if (!o.model) continue;
  if (wantModel && o.model !== wantModel) continue;
  console.log('=== record type:', o.type, '| model:', o.model, '| provider:', JSON.stringify(o.providerId || ''));
  console.log('--- top-level keys:', Object.keys(o).join(','));
  if (o.response) {
    console.log('--- response keys:', Object.keys(o.response).join(','));
    console.log('--- response (truncated 3000):');
    console.log(JSON.stringify(o.response, null, 1).slice(0, 3000));
  }
  if (o.request) {
    console.log('--- request keys:', Object.keys(o.request).join(','));
  }
  break;
}
