import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type PluginManifest = {
  tools?: PluginToolManifest[];
};

export type PluginToolManifest = {
  name: string;
  description: string;
  command: string;
  // Optional governance fields. `risk` defaults to 'shell' (the safe default).
  // `autoApprove` lets the workspace owner opt a specific plugin command into
  // auto-mode execution without matching the built-in shell allowlist — the
  // destructive-pattern blocklist (rm -rf, format, ...) still applies.
  risk?: 'read' | 'write' | 'shell';
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
  const tools = Array.isArray(value.tools) ? value.tools.map(normalizeTool).filter((tool): tool is PluginToolManifest => tool !== undefined) : [];
  return { tools };
}

function normalizeTool(value: unknown): PluginToolManifest | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.name !== 'string' || !/^plugin_[a-z0-9_]+$/i.test(value.name)) return undefined;
  if (typeof value.description !== 'string' || typeof value.command !== 'string') return undefined;
  const risk = value.risk === 'read' || value.risk === 'write' || value.risk === 'shell' ? value.risk : undefined;
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
