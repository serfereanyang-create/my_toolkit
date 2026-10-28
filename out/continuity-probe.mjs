import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sessionPath = process.argv[2] ?? '.aicode/sessions/sess_20261026115924_c6ffef29.json';
const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));

const userMsgs = (session.messages ?? []).filter((m) => m.role === 'user');
// injected blocks start with a tag or the compaction prefix — not real user turns
const injected = /^<(global-memory|relevant-project-memories|past-reflections)/;
const compacted = /^\[compacted session history\]/;
const realUser = userMsgs.filter((m) => !injected.test(m.content) && !compacted.test(m.content));

const ledgerPath = path.join(os.homedir(), '.aicode', 'usage.jsonl');
const rows = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);
const mine = rows.filter((r) => r.sessionId === session.id);

console.log(JSON.stringify({
  sessionId: session.id,
  realUserTurns: realUser.length,
  realUserTexts: realUser.map((m) => m.content.slice(0, 70)),
  injectedBlocksAtRuntime: userMsgs.length - realUser.length,
  ledgerRowsForSession: mine.length,
  ledgerDetail: mine.map((r) => ({
    ts: r.ts,
    model: r.model,
    input: r.inputTokens,
    cacheRead: r.cacheReadTokens,
    reportedEff: r.cacheEfficiency,
    toolCalls: r.toolCalls,
    ms: r.durationMs,
  })),
  modelCallsVsUserTurns: `${mine.length} calls / ${realUser.length} user turns`,
}, null, 2));
