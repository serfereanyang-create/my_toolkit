import type { ToolDefinition } from '../tools/types.js';
import { bridgeMcpTools } from './bridge.js';
import { createMcpClient, type McpClient } from './client.js';
import { isMcpDisabled, readMcpConfig } from './config.js';
import type { McpServerConfig, McpServerStatus } from './types.js';

export type McpManager = {
  clients: McpClient[];
  tools: ToolDefinition[];
  statuses: McpServerStatus[];
  close(): Promise<void>;
  reload(): Promise<McpManager>;
};

export type LoadMcpOptions = {
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  existingNames?: Set<string>;
  createClient?: (server: McpServerConfig) => McpClient;
};

export async function loadMcpManager(options: LoadMcpOptions): Promise<McpManager> {
  const env = options.env ?? process.env;
  if (isMcpDisabled(env)) {
    return emptyManager(options);
  }

  let config;
  try {
    config = await readMcpConfig(options.workspaceRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      clients: [],
      tools: [],
      statuses: [{ name: '*', enabled: true, connected: false, toolCount: 0, error: message, command: '' }],
      async close() {},
      async reload() {
        return loadMcpManager(options);
      },
    };
  }

  const existingNames = options.existingNames ?? new Set<string>();
  const clients: McpClient[] = [];
  const tools: ToolDefinition[] = [];
  const statuses: McpServerStatus[] = [];

  for (const server of config.servers) {
    if (!server.enabled) {
      statuses.push({
        name: server.name,
        enabled: false,
        connected: false,
        toolCount: 0,
        error: 'disabled',
        command: formatCommand(server),
      });
      continue;
    }

    const client = options.createClient
      ? options.createClient(server)
      : createMcpClient({ workspaceRoot: options.workspaceRoot, server });

    try {
      await client.connect();
      clients.push(client);
      const bridged = bridgeMcpTools(client);
      let registered = 0;
      for (const tool of bridged) {
        if (existingNames.has(tool.name)) {
          continue;
        }
        existingNames.add(tool.name);
        tools.push(tool);
        registered += 1;
      }
      statuses.push({
        name: server.name,
        enabled: true,
        connected: true,
        toolCount: registered,
        command: formatCommand(server),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statuses.push({
        name: server.name,
        enabled: true,
        connected: false,
        toolCount: 0,
        error: message,
        command: formatCommand(server),
      });
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
  }

  return {
    clients,
    tools,
    statuses,
    async close() {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    },
    async reload() {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
      return loadMcpManager(options);
    },
  };
}

export function formatMcpStatus(statuses: McpServerStatus[]) {
  if (statuses.length === 0) return 'MCP: no servers configured (.aicode/mcp.json)';
  return [
    'MCP servers:',
    ...statuses.map((status) => {
      const state = !status.enabled
        ? 'disabled'
        : status.connected
          ? `connected tools=${status.toolCount}`
          : `error ${status.error ?? 'unknown'}`;
      return `- ${status.name}: ${state}${status.command ? ` (${status.command})` : ''}`;
    }),
  ].join('\n');
}

function emptyManager(options: LoadMcpOptions): McpManager {
  return {
    clients: [],
    tools: [],
    statuses: [],
    async close() {},
    async reload() {
      return loadMcpManager(options);
    },
  };
}

function formatCommand(server: McpServerConfig) {
  return [server.command, ...server.args].filter(Boolean).join(' ');
}
