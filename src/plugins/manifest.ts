import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type PluginManifest = {
  tools?: PluginToolManifest[];
};

export type PluginToolManifest = {
  name: string;
  description: string;
  command: string;
  // Optional governance fields.
  //
  // `risk` is deliberately limited to 'write' | 'shell'. A plugin tool is a
  // shell command, and a 'read' label made the policy treat it as
  // `allowed: true, needsPrompt: false` in every mode — including `deny` — and
  // put it in the read-only expert/sub-agent tool set. A manifest that asks for
  // 'read' is downgraded to the conservative 'shell' tier instead (see
  // normalizeTool).
  //
  // `autoApprove` lets the workspace owner opt a specific plugin command into
  // auto-mode execution without matching the built-in shell allowlist — the
  // destructive-pattern blocklist (rm -rf, format, ...) still applies.
  risk?: 'write' | 'shell';
  autoApprove?: boolean;
};

export async function readPluginManifest(workspaceRoot: string, path = '.aicode/plugins.json') {
  const manifestPath = resolve(workspaceRoot, path);
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    return normalizeManifest(parsed);
  } catch (error) {
    if (isMissingFile(error)) return { tools: [] } satisfies PluginManifest;
    throw new Error(`Invalid plugin manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeManifest(value: unknown): PluginManifest {
  if (!isRecord(value)) throw new Error('expected a JSON object');
  const tools: PluginToolManifest[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value.tools)) {
    for (const raw of value.tools) {
      const tool = normalizeTool(raw);
      if (!tool) continue;
      // Two entries with the same name used to reach the registry as two
      // tools; `createAgentRuntime` registers without `replace`, so the
      // duplicate threw "Tool already registered" and the whole CLI refused to
      // start. First declaration wins, deterministically.
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      tools.push(tool);
    }
  }
  return { tools };
}

function normalizeTool(value: unknown): PluginToolManifest | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.name !== 'string' || !/^plugin_[a-z0-9_]+$/i.test(value.name)) return undefined;
  if (typeof value.description !== 'string' || typeof value.command !== 'string') return undefined;
  const risk = value.risk === 'write' || value.risk === 'shell'
    ? value.risk
    // 'read' (or anything else) is not a tier a command tool may claim.
    : value.risk === 'read' ? 'shell' : undefined;
  return {
    name: value.name,
    description: value.description,
    command: value.command,
    ...(risk ? { risk } : {}),
    ...(value.autoApprove === true ? { autoApprove: true } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown) {
  return isRecord(error) && error.code === 'ENOENT';
}
