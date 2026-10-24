const fs = require('fs');
const f = process.argv[2];
const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
const byModel = new Map();
for (const l of lines) {
  let o;
  try { o = JSON.parse(l); } catch (e) { continue; }
  if (!o.model) continue;
  const mid = typeof o.model === 'string' ? o.model : o.model.modelId;
  const pid = typeof o.model === 'string' ? '' : o.model.providerId;
  const key = mid + ' @ ' + pid;
  if (byModel.has(key)) continue;
  byModel.set(key, o);
}
for (const [k, o] of byModel) {
  console.log('=====', k);
  console.log('headers:', JSON.stringify((o.response && o.response.headers) || {}));
  console.log('responseId:', (o.response && o.response.responseId) || '');
  console.log('usage:', JSON.stringify((o.response && o.response.usage) || {}));
  console.log('');
}
