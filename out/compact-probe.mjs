import fs from 'node:fs';

const path = process.argv[2] ?? '.aicode/sessions/sess_20261026115924_c6ffef29.json';
const raw = fs.readFileSync(path, 'utf8');
const session = JSON.parse(raw);
const messages = session.messages ?? [];
const contentChars = messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
const sizes = messages
  .map((m, i) => ({ i, role: m.role, name: m.name ?? '', len: typeof m.content === 'string' ? m.content.length : 0 }))
  .sort((a, b) => b.len - a.len)
  .slice(0, 5);

console.log(JSON.stringify({
  fileBytes: Buffer.byteLength(raw, 'utf8'),
  messages: messages.length,
  byRole: messages.reduce((acc, m) => ((acc[m.role] = (acc[m.role] ?? 0) + 1), acc), {}),
  contentChars,
  estTokens: Math.ceil(Buffer.byteLength(messages.map((m) => m.content ?? '').join('\n'), 'utf8') / 4),
  largest: sizes,
}, null, 2));
