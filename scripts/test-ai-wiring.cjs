const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');

for (const channel of ['ai:get-config', 'ai:save-config', 'ai:test-connection', 'ai:generate-review', 'ai:cancel-review']) {
  assert.ok(main.includes(`'${channel}'`), `main missing ${channel}`);
}
assert.ok(main.includes('configureAiService({ userDataPath })'), 'ai service not configured at startup');
assert.ok(preload.includes('ai:'), 'preload missing desktopApi.ai');
for (const event of ['ai:review-chunk', 'ai:review-done', 'ai:review-error']) {
  assert.ok(main.includes(`'${event}'`), `main missing event ${event}`);
  assert.ok(preload.includes(`'${event}'`), `preload missing event ${event}`);
}
console.log('ai wiring tests passed');
