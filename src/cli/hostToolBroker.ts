import { randomUUID } from 'node:crypto';
import type { ToolResult } from '../tools/types.js';

export const DEFAULT_HOST_TOOL_TIMEOUT_MS = 60_000;

/** Desktop-only transport; the host, not the CLI, owns the hidden browser. */
export type HostToolInvoker = (tool: string, input: Record<string, unknown>) => Promise<ToolResult>;

export type DesktopHostToolBrokerOptions = {
  emit: (event: Record<string, unknown>) => void;
  /** Tests may shorten the deadline; production defaults to 60 seconds. */
  timeoutMs?: number;
  /** When supplied, no other host capabilities may be requested. */
  allowedTools?: ReadonlySet<string>;
};

type Pending = {
  tool: string;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
};

/** Validate the new RPC boundary without coercing malformed responses to success. */
export function validateHostToolResult(value: unknown): ToolResult {
  if (!isRecord(value)) throw new Error('host_tool_response result must be an object');
  for (const key of Object.keys(value)) {
    if (key !== 'ok' && key !== 'output' && key !== 'data') {
      throw new Error(`Unknown host_tool_response result field: ${key}`);
    }
  }
  if (typeof value.ok !== 'boolean') throw new Error('host_tool_response result.ok must be a boolean');
  if (typeof value.output !== 'string') throw new Error('host_tool_response result.output must be a string');
  return { ok: value.ok, output: value.output, ...('data' in value ? { data: value.data } : {}) };
}

/**
 * Newline-JSON request/response transport for a desktop-owned capability.
 *
 * Pending entries are installed before emit (a host may answer synchronously),
 * and removed before settling. Unknown, duplicate and late replies cannot
 * revive cancelled work. Cancellation suspends new requests until the next turn
 * explicitly resumes; closing the bridge makes that suspension permanent.
 */
export class DesktopHostToolBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private cancelledReason: string | undefined;
  private closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly options: DesktopHostToolBrokerOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HOST_TOOL_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('Host tool timeout must be a positive integer');
    }
  }

  request: HostToolInvoker = async (tool, input) => {
    if (this.cancelledReason) throw new Error(this.cancelledReason);
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(tool)) throw new Error('Invalid host tool name');
    if (this.options.allowedTools && !this.options.allowedTools.has(tool)) {
      throw new Error(`Desktop host capability is not enabled: ${tool}`);
    }
    if (!isRecord(input)) throw new Error('Host tool input must be an object');

    const requestId = `host_${randomUUID()}`;
    return new Promise<ToolResult>((resolve, reject) => {
      const timer = setTimeout(() => this.timeout(requestId), this.timeoutMs);
      this.pending.set(requestId, {
        tool,
        deadline: Date.now() + this.timeoutMs,
        timer,
        resolve,
        reject,
      });
      try {
        this.options.emit({ type: 'host_tool_request', sessionId: this.sessionId, requestId, tool, input });
      } catch (error) {
        const entry = this.take(requestId);
        entry?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  resolve(requestId: string, value: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    // A stalled event loop must not accept a response after the deadline just
    // because the timeout callback has not run yet.
    if (Date.now() >= entry.deadline) {
      this.timeout(requestId);
      return false;
    }
    const result = validateHostToolResult(value);
    this.take(requestId)?.resolve(result);
    return true;
  }

  cancelAll(reason = 'Desktop host tool execution cancelled') {
    this.cancelledReason = reason;
    const requestIds = [...this.pending.keys()];
    const entries = [...this.pending.values()];
    this.pending.clear();
    if (requestIds.length) {
      try { this.options.emit({ type: 'host_tool_cancel', sessionId: this.sessionId, requestIds }); } catch { this.cancelledReason = reason; }
    }
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }

  /** A fresh user/automation turn may use the capability again after cancel. */
  resume() {
    if (!this.closed) this.cancelledReason = undefined;
  }

  close(reason = 'Desktop bridge is shutting down') {
    this.closed = true;
    this.cancelAll(reason);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private take(requestId: string): Pending | undefined {
    const entry = this.pending.get(requestId);
    if (entry) {
      this.pending.delete(requestId);
      clearTimeout(entry.timer);
    }
    return entry;
  }

  private timeout(requestId: string) {
    const entry = this.take(requestId);
    entry?.reject(new Error(`Desktop host tool timed out after ${this.timeoutMs}ms: ${entry.tool}`));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
