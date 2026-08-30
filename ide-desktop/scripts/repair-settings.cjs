'use strict';
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(process.env.APPDATA, 'cc-desktop-ide', 'settings.json');
const raw = fs.readFileSync(file, 'utf8');

// Walk the string character by character, tracking JSON depth.
// Stop as soon as the root object closes (depth drops to 0).
let depth = 0;
let endIdx = -1;
let inStr = false;
let escNext = false;

for (let i = 0; i < raw.length; i++) {
  const c = raw[i];

  if (escNext) { escNext = false; continue; }

  if (inStr) {
    if (c === '\\') { escNext = true; continue; }
    if (c === '"')  { inStr = false; }
    continue;
  }

  if (c === '"') { inStr = true; continue; }
  if (c === '{') { depth++; continue; }
  if (c === '}') {
    depth--;
    if (depth === 0) { endIdx = i; break; }
  }
}

if (endIdx < 0) {
  console.error('ERROR: could not locate root closing brace');
  process.exit(1);
}

const clean = raw.slice(0, endIdx + 1);

// Validate before writing
JSON.parse(clean);

fs.writeFileSync(file, clean, 'utf8');
console.log('Repaired: ' + file);
console.log('Kept ' + clean.length + ' of ' + raw.length + ' bytes');
