export type McpServerConfig = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  enabled: boolean;
};

export type McpConfig = {
  servers: McpServerConfig[];
};

export type McpToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};

export type McpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
};

export type McpJsonRpcRequest = {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
};

export type McpJsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

export type McpJsonRpcResponse = {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type McpServerStatus = {
  name: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  error?: string;
  /** Non-fatal load problems, e.g. tool names skipped because they collided. */
  warning?: string;
  command: string;
};

export type McpContentBlock = {
  type: string;
  text?: string;
};

export type McpToolsCallResult = {
  content?: McpContentBlock[];
  isError?: boolean;
  structuredContent?: unknown;
};
