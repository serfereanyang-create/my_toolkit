import fs from 'node:fs';
import { compactMessagesForModel } from '../dist/src/agent/contextBudget.js';
import { sessionTokens, estimateTokens } from '../dist/src/agent/autoCompact.js';
import { resolveModelContextWindow, autoCompactTokenLimit } from '../dist/src/agent/modelWindows.js';

const path = process.argv[2] ?? '.aicode/sessions/sess_20261026115924_c6ffef29.json';
const raw = fs.readFileSync(path, 'utf8');
const session = JSON.parse(raw);
const messages = session.messages ?? [];
const toolCalls = Array.isArray(session.toolCalls) ? session.toolCalls : [];

const bytes = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v ?? ''), 'utf8');
const tcSizes = toolCalls
  .map((c, i) => ({ i, tool: c.tool ?? '', bytes: bytes(c) }))
  .sort((a, b) => b.bytes - a.bytes);
const tcTotal = tcSizes.reduce((s, x) => s + x.bytes, 0);

const model = session.model;
const window = resolveModelContextWindow(model);
const limit = autoCompactTokenLimit(window);
const rawTokens = sessionTokens(messages);
const packed = compactMessagesForModel(messages, { model });

console.log(JSON.stringify({
  file: { bytes: bytes(raw), messages: messages.length, toolCalls: toolCalls.length },
  model,
  windowTokens: window,
  triggerAt: limit,
  messagesSide: {
    rawTokens,
    triggerReached: rawTokens >= limit,
    packedChars: packed.compactChars,
    packedTokens: Math.ceil(packed.compactChars / 4),
    packedTokensWithPrompt: Math.ceil((packed.compactChars + 400) / 4),
    droppedMessages: packed.droppedMessages,
    mode: packed.mode,
  },
  toolCallsSide: {
    totalBytes: tcTotal,
    shareOfFile: Number((tcTotal / bytes(raw) * 100).toFixed(1)),
    top: tcSizes.slice(0, 6),
  },
  firstMessage: String(messages[0]?.content ?? '').slice(0, 120),
}, null, 2));
