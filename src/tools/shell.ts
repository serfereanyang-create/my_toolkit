import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from './types.js';

const execAsync = promisify(exec);

export const runCommandTool: ToolDefinition<{ command: string; timeoutMs: number }> = {
  name: 'run_command',
  description: 'Run an approved shell command in the workspace.',
  inputHint: '{ "command": "node --version", "timeoutMs": 30000 }',
  risk: 'shell',
  validate(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('expected an object');
    const record = input as Record<string, unknown>;
    if (typeof record.command !== 'string' || record.command.length === 0) throw new Error('command is required');
    return {
      command: record.command,
      timeoutMs: typeof record.timeoutMs === 'number' && record.timeoutMs > 0 ? Math.min(Math.floor(record.timeoutMs), 120000) : 30000,
    };
  },
  async execute(input, context) {
    const result = await execAsync(input.command, {
      cwd: context.workspaceRoot,
      timeout: input.timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    return { ok: true, output: output || '(no output)', data: { command: input.command } };
  },
};
