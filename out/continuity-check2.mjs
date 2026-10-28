import fs from 'node:fs';

const path = process.argv[2] ?? '.aicode/sessions/sess_20261026115924_c6ffef29.json';
const session = JSON.parse(fs.readFileSync(path, 'utf8'));
const messages = session.messages ?? [];

const interrupted = messages
  .map((m, i) => ({ i, role: m.role, interrupted: m.interrupted === true, len: (m.content ?? '').length, head: String(m.content ?? '').slice(0, 60) }))
  .filter((m) => m.interrupted);

const tail = messages.slice(-6).map((m, k) => ({
  i: messages.length - 6 + k,
  role: m.role,
  name: m.name ?? '',
  interrupted: m.interrupted === true,
  len: (m.content ?? '').length,
  head: String(m.content ?? '').slice(0, 70).replace(/\n/g, ' '),
}));

console.log(JSON.stringify({
  messages: messages.length,
  roles: messages.reduce((a, m) => ((a[m.role] = (a[m.role] ?? 0) + 1), a), {}),
  interruptedCount: interrupted.length,
  interrupted,
  tail,
  toolCalls: Array.isArray(session.toolCalls) ? session.toolCalls.length : 0,
  lastTurn: session.lastTurn ?? null,
}, null, 2));
