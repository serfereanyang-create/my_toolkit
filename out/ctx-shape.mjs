import fs from 'node:fs';

const path = process.argv[2] ?? '.aicode/sessions/sess_20261026115924_c6ffef29.json';
const s = JSON.parse(fs.readFileSync(path, 'utf8'));
const msgs = s.messages ?? [];
const calls = Array.isArray(s.toolCalls) ? s.toolCalls : [];

const byRole = {};
for (const m of msgs) byRole[m.role] = (byRole[m.role] ?? 0) + 1;

console.log(JSON.stringify({
  messages: msgs.length,
  byRole,
  sequence: msgs.map((m) => m.role[0] + (m.name ? `:${m.name}` : '')).join(' '),
  assistantMessages: msgs.filter((m) => m.role === 'assistant').length,
  toolCallsInLedger: calls.length,
  cacheProbeCalls: calls.filter((c) => c.tool === 'cache_probe').length,
  firstMessageHead: String(msgs[0]?.content ?? '').slice(0, 200),
  userMessages: msgs.filter((m) => m.role === 'user').map((m) => ({
    len: String(m.content).length,
    head: String(m.content).replace(/\s+/g, ' ').slice(0, 80),
  })),
}, null, 2));
