import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveWorkspacePath } from '../safety/policy.js';
import { encodeMcpMessage, McpFrameReader, type McpMessage } from './framing.js';
import type {
  McpJsonRpcNotification,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpServerConfig,
  McpToolDescriptor,
  McpToolsCallResult,
} from './types.js';

const PROTOCOL_VERSION = '2024-11-05';

export type McpClientOptions = {
  workspaceRoot: string;
  server: McpServerConfig;
  spawnImpl?: typeof spawn;
  initializeTimeoutMs?: number;
  listTimeoutMs?: number;
  callTimeoutMs?: number;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class McpClient {
  readonly name: string;
  private readonly workspaceRoot: string;
  private readonly server: McpServerConfig;
  private readonly spawnImpl: typeof spawn;
  private readonly initializeTimeoutMs: number;
  private readonly listTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly reader = new McpFrameReader();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private tools: McpToolDescriptor[] = [];
  private closed = false;
  private stderrTail = '';
  private lastError: string | undefined;

  constructor(options: McpClientOptions) {
    this.name = options.server.name;
    this.workspaceRoot = options.workspaceRoot;
    this.server = options.server;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? 15_000;
    this.listTimeoutMs = options.listTimeoutMs ?? 15_000;
    this.callTimeoutMs = options.callTimeoutMs ?? 60_000;
  }

  getTools() {
    return this.tools.slice();
  }

  getLastError() {
    return this.lastError;
  }

  isConnected() {
    return Boolean(this.child && !this.closed && !this.child.killed);
  }

  async connect(): Promise<void> {
    if (!this.server.enabled) {
      this.lastError = 'disabled';
      return;
    }
    if (!this.server.command) {
      this.lastError = 'missing command';
      throw new Error(`MCP server ${this.name}: missing command`);
    }

    const cwd = this.server.cwd
      ? resolveWorkspacePath(this.workspaceRoot, this.server.cwd)
      : this.workspaceRoot;

    this.child = this.spawnImpl(this.server.command, this.server.args, {
      cwd,
      env: { ...process.env, ...this.server.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.stderrTail = `${this.stderrTail}${text}`.slice(-4000);
    });
    this.child.on('error', (error) => {
      this.lastError = error.message;
      this.failAll(error);
    });
    this.child.on('exit', (code, signal) => {
      const reason = `exited code=${code ?? 'null'} signal=${signal ?? 'null'}${this.stderrTail ? ` stderr=${this.stderrTail.trim()}` : ''}`;
      this.lastError = reason;
      this.failAll(new Error(`MCP server ${this.name} ${reason}`));
      this.closed = true;
    });

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'aicode', version: '0.1.0' },
    }, this.initializeTimeoutMs);

    this.notify('notifications/initialized', {});
    this.tools = await this.listAllTools();
    this.lastError = undefined;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = this.callTimeoutMs): Promise<McpToolsCallResult> {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (!isRecord(result)) return { content: [{ type: 'text', text: String(result) }] };
    return result as McpToolsCallResult;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error(`MCP server ${this.name} closed`));
    if (!this.child) return;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    const child = this.child;
    await new Promise<void>((resolveClose) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        resolveClose();
      }, 1000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveClose();
      });
      try {
        child.kill();
      } catch {
        clearTimeout(timer);
        resolveClose();
      }
    });
    this.child = undefined;
  }

  private async listAllTools(): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    do {
      const params = cursor ? { cursor } : {};
      const result = await this.request('tools/list', params, this.listTimeoutMs);
      if (!isRecord(result) || !Array.isArray(result.tools)) break;
      for (const item of result.tools) {
        if (!isRecord(item) || typeof item.name !== 'string') continue;
        tools.push({
          name: item.name,
          description: typeof item.description === 'string' ? item.description : undefined,
          inputSchema: isRecord(item.inputSchema) ? item.inputSchema : undefined,
          annotations: isRecord(item.annotations)
            ? {
                readOnlyHint: item.annotations.readOnlyHint === true,
                destructiveHint: item.annotations.destructiveHint === true,
                openWorldHint: item.annotations.openWorldHint === true,
              }
            : undefined,
        });
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
    } while (cursor);
    return tools;
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.child || this.closed) {
      return Promise.reject(new Error(`MCP server ${this.name} is not connected`));
    }
    const id = this.nextId;
    this.nextId += 1;
    const message: McpJsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`MCP ${this.name} ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.write(message);
    });
  }

  private notify(method: string, params: unknown) {
    const message: McpJsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.write(message);
  }

  private write(message: McpMessage) {
    if (!this.child || this.closed) return;
    this.child.stdin.write(encodeMcpMessage(message));
  }

  private onStdout(chunk: Buffer) {
    let messages: McpMessage[];
    try {
      messages = this.reader.push(chunk);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return;
    }
    for (const message of messages) this.handleMessage(message);
  }

  private handleMessage(message: McpMessage) {
    if (!('id' in message) || message.id === null || message.id === undefined) return;
    if (!('result' in message || 'error' in message)) return;
    const response = message as McpJsonRpcResponse;
    const id = typeof response.id === 'number' ? response.id : Number(response.id);
    if (!Number.isFinite(id)) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(new Error(response.error.message || `MCP error ${response.error.code}`));
      return;
    }
    pending.resolve(response.result);
  }

  private failAll(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export function createMcpClient(options: McpClientOptions) {
  return new McpClient(options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
