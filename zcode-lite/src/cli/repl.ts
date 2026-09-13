import readline from 'node:readline/promises';
import type { Agent } from '../agent/agent.js';
export async function runRepl(agent: Agent): Promise<void> { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); process.stdout.write('ZCode-lite REPL. Type /exit to quit.\n'); try { while (true) { const prompt = (await rl.question('zcode-lite> ')).trim(); if (!prompt) continue; if (prompt === '/exit' || prompt === '/quit') break; const result = await agent.run(prompt); process.stdout.write(`${result.text}\n`); } } finally { rl.close(); } }
