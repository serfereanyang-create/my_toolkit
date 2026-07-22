import { formatSandboxResult, runSandboxedCommand } from '../safety/sandbox.js';
import type { ToolDefinition } from './types.js';

export const runCommandTool: ToolDefinition<{ command: string; timeoutMs: number }> = {
  name: 'run_command',
  description: 'Run an approved shell command in the workspace under the process sandbox.',
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
    try {
      const result = await runSandboxedCommand({
        command: input.command,
        cwd: context.workspaceRoot,
        timeoutMs: input.timeoutMs,
        maxBuffer: 1024 * 1024,
      });
      return formatSandboxResult(result, input.command);
    } catch (error) {
      return {
        ok: false,
        output: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
        data: { command: input.command },
      };
    }
  },
};
