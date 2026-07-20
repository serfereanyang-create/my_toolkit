import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readPluginManifest, type PluginToolManifest } from './manifest.js';
import type { ToolDefinition } from '../tools/types.js';

const execAsync = promisify(exec);

export async function loadPluginTools(workspaceRoot: string): Promise<ToolDefinition[]> {
  const manifest = await readPluginManifest(workspaceRoot);
  return (manifest.tools ?? []).map(pluginToolDefinition);
}

function pluginToolDefinition(tool: PluginToolManifest): ToolDefinition<{ command: string; timeoutMs: number }> {
  return {
    name: tool.name,
    description: `[plugin] ${tool.description}`,
    inputHint: '{ "timeoutMs": 30000 }',
    risk: 'shell',
    validate(input) {
      if (input === undefined || input === null) return { command: tool.command, timeoutMs: 30000 };
      if (typeof input !== 'object' || Array.isArray(input)) throw new Error('expected an object');
      const record = input as Record<string, unknown>;
      return { command: tool.command, timeoutMs: typeof record.timeoutMs === 'number' && record.timeoutMs > 0 ? Math.min(Math.floor(record.timeoutMs), 120000) : 30000 };
    },
    async execute(input, context) {
      const result = await execAsync(input.command, { cwd: context.workspaceRoot, timeout: input.timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true });
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
      return { ok: true, output: output || '(no output)', data: { plugin: tool.name } };
    },
  };
}
