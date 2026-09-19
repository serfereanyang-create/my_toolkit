import type { McpJsonRpcNotification, McpJsonRpcRequest, McpJsonRpcResponse } from './types.js';

export type McpMessage = McpJsonRpcRequest | McpJsonRpcNotification | McpJsonRpcResponse;

/** Maximum JSON-RPC payload accepted from an MCP server. */
export const MAX_MCP_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_MCP_HEADER_BYTES = 8 * 1024;
const MAX_MCP_BUFFER_BYTES = MAX_MCP_FRAME_BYTES + MAX_MCP_HEADER_BYTES + 4;

export function encodeMcpMessage(message: McpMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_MCP_FRAME_BYTES) {
    throw new Error(`MCP message exceeds ${MAX_MCP_FRAME_BYTES} byte limit`);
  }
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  return Buffer.concat([header, body]);
}

export class McpFrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer | string): McpMessage[] {
    const next: Buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? next : Buffer.concat([this.buffer, next]);
    const messages: McpMessage[] = [];
    while (true) {
      const message = this.tryReadOne();
      if (!message) break;
      messages.push(message);
    }
    // A complete frame is consumed above. Any remaining data is necessarily a
    // partial header/body and must be bounded to prevent an unbounded stream from
    // exhausting the client while it waits for a delimiter or payload.
    if (this.buffer.length > MAX_MCP_BUFFER_BYTES) {
      throw new Error(`MCP framing buffer exceeds ${MAX_MCP_BUFFER_BYTES} bytes`);
    }
    return messages;
  }

  private tryReadOne(): McpMessage | undefined {
    const headerEnd = indexOfHeaderEnd(this.buffer);
    if (headerEnd < 0) {
      if (this.buffer.length > MAX_MCP_HEADER_BYTES) {
        throw new Error(`MCP header exceeds ${MAX_MCP_HEADER_BYTES} bytes`);
      }
      return undefined;
    }
    if (headerEnd > MAX_MCP_HEADER_BYTES) {
      throw new Error(`MCP header exceeds ${MAX_MCP_HEADER_BYTES} bytes`);
    }

    const headerText = this.buffer.subarray(0, headerEnd).toString('ascii');
    const lines = headerText.split('\r\n').filter(Boolean);
    const lengthHeaders = lines.filter((line) => /^Content-Length\s*:/i.test(line));
    if (lengthHeaders.length !== 1) {
      throw new Error('invalid MCP Content-Length header');
    }
    const lengthMatch = lengthHeaders[0]?.match(/^Content-Length\s*:\s*(\d+)\s*$/i);
    if (!lengthMatch) {
      throw new Error('invalid MCP Content-Length header');
    }
    const contentLength = Number(lengthMatch[1]);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_MCP_FRAME_BYTES) {
      throw new Error(`invalid MCP Content-Length: ${lengthMatch[1]}`);
    }

    const bodyStart = headerEnd + 4;
    const frameEnd = bodyStart + contentLength;
    if (this.buffer.length < frameEnd) return undefined;
    const body = this.buffer.subarray(bodyStart, frameEnd).toString('utf8');
    this.buffer = Buffer.from(this.buffer.subarray(frameEnd));

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`invalid MCP JSON body: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== '2.0') {
      throw new Error('invalid MCP JSON-RPC message');
    }
    return parsed as McpMessage;
  }
}

function indexOfHeaderEnd(buffer: Buffer) {
  const marker = Buffer.from('\r\n\r\n', 'utf8');
  return buffer.indexOf(marker);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
