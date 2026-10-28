import fs from 'node:fs';

const path = process.argv[2] ?? '.aicode/sessions/sess_20261026115924_c6ffef29.json';
const raw = fs.readFileSync(path, 'utf8');
const session = JSON.parse(raw);

const size = (value) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
const fields = Object.entries(session)
  .map(([key, value]) => ({ key, bytes: size(value), type: Array.isArray(value) ? `array(${value.length})` : typeof value }))
  .sort((a, b) => b.bytes - a.bytes);

const messages = session.messages ?? [];
const msgChars = messages.reduce((sum, m) => (sum + (typeof m.content === 'string' ? m.content.length : 0)), 0);
const msgBytes = size(messages);
const estTokens = Math.ceil(Buffer.byteLength(messages.map((m) => m.content ?? '').join('\n'), 'utf8') / 4);

console.log(JSON.stringify({
  fileBytes: Buffer.byteLength(raw, 'utf8'),
  estTokens,
  messageCount: messages.length,
  msgChars,
  msgBytes,
  fields: fields.slice(0, 12),
  firstMessage: (messages[0]?.content ?? '').slice(0, 80),
  lastMessages: messages.slice(-4).map((m) => ({ role: m.role, name: m.name ?? '', len: (m.content ?? '').length })),
}, null, 2));
