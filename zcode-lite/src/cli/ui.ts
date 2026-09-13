import readline from 'node:readline/promises';
import type { ApprovalRequest } from '../tools/types.js';
export function createTerminalConfirm(input = process.stdin, output = process.stdout) { const rl = readline.createInterface({ input, output }); return async (_message: string, request: ApprovalRequest) => { const answer = (await rl.question(`\nApproval required: ${request.tool} (${request.risk}). Allow? [y]es/[n]o/[a]lways: `)).trim().toLowerCase(); return answer === 'a' ? 'allow_session' : answer === 'y' || answer === 'yes'; }; }
export function printResult(text: string): void { process.stdout.write(`${text}\n`); }
