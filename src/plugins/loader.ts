import { formatSandboxResult, runSandboxedCommand } from '../safety/sandbox.js';
import type { ToolDefinition } from '../tools/types.js';
import { readPluginManifest, type PluginToolManifest } from './manifest.js';

export async function loadPluginTools(workspaceRoot: string): Promise<ToolDefinition[]> {
  const manifest = await readPluginManifest(workspaceRoot);
  return (manifest.tools ?? []).map(pluginToolDefinition);
}

function pluginToolDefinition(tool: PluginToolManifest): ToolDefinition<{ command: string; timeoutMs: number }> {
  return {
    name: tool.name,
    description: `[plugin] ${tool.description}`,
    inputHint: '{ "timeoutMs": 30000 }',
    // Manifest may declare a risk tier; default to the safest gate ('shell').
    risk: tool.risk ?? 'shell',
    // A workspace owner can opt this command into auto-mode without matching the
    // built-in shell allowlist. Destructive patterns are still hard-blocked.
    ...(tool.autoApprove ? { autoApprove: true } : {}),
    validate(input) {
      if (input === undefined || input === null) return { command: tool.command, timeoutMs: 30000 };
      if (typeof input !== 'object' || Array.isArray(input)) throw new Error('expected an object');
      const record = input as Record<string, unknown>;
      return { command: tool.command, timeoutMs: typeof record.timeoutMs === 'number' && record.timeoutMs > 0 ? Math.min(Math.floor(record.timeoutMs), 120000) : 30000 };
    },
    async execute(input, context) {
      try {
        const result = await runSandboxedCommand({
          command: input.command,
          cwd: context.workspaceRoot,
          timeoutMs: input.timeoutMs,
          maxBuffer: 1024 * 1024,
        });
        const formatted = formatSandboxResult(result, input.command);
        return {
          ...formatted,
          data: { ...(typeof formatted.data === 'object' && formatted.data ? formatted.data : {}), plugin: tool.name },
        };
      } catch (error) {
        return {
          ok: false,
          output: `Plugin command failed: ${error instanceof Error ? error.message : String(error)}`,
          data: { plugin: tool.name },
        };
      }
    },
  };
}
