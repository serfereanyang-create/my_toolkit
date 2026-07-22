import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { McpConfig, McpServerConfig } from './types.js';

const SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export async function readMcpConfig(workspaceRoot: string, path = '.aicode/mcp.json'): Promise<McpConfig> {
  const manifestPath = resolve(workspaceRoot, path);
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    return normalizeMcpConfig(parsed);
  } catch (error) {
    if (isMissingFile(error)) return { servers: [] };
    throw new Error(`Invalid MCP config ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function normalizeMcpConfig(value: unknown): McpConfig {
  if (!isRecord(value)) throw new Error('expected a JSON object');
  const serversValue = value.servers;
  if (serversValue === undefined) return { servers: [] };
  if (!isRecord(serversValue)) throw new Error('servers must be an object map');

  const servers: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(serversValue)) {
    if (!SERVER_NAME.test(name)) throw new Error(`invalid MCP server name: ${name}`);
    const server = normalizeServer(name, raw);
    if (server) servers.push(server);
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { servers };
}

export function isMcpDisabled(env: NodeJS.ProcessEnv = process.env) {
  const value = env.AICODE_MCP;
  return value === '0' || value === 'false' || value === 'off';
}

function normalizeServer(name: string, value: unknown): McpServerConfig | undefined {
  if (!isRecord(value)) throw new Error(`server ${name} must be an object`);
  if (value.enabled === false) {
    return {
      name,
      command: typeof value.command === 'string' ? value.command : '',
      args: Array.isArray(value.args) ? value.args.map(String) : [],
      env: normalizeEnv(value.env),
      cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
      enabled: false,
    };
  }
  if (typeof value.command !== 'string' || value.command.trim() === '') {
    throw new Error(`server ${name} requires a non-empty command`);
  }
  const args = Array.isArray(value.args)
    ? value.args.map((item) => {
        if (typeof item !== 'string') throw new Error(`server ${name} args must be strings`);
        return item;
      })
    : [];
  return {
    name,
    command: value.command,
    args,
    env: normalizeEnv(value.env),
    cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
    enabled: value.enabled !== false,
  };
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('env must be an object of string values');
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`env.${key} must be a string`);
    env[key] = item;
  }
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown) {
  return isRecord(error) && error.code === 'ENOENT';
}
