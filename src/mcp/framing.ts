import type { McpJsonRpcNotification, McpJsonRpcRequest, McpJsonRpcResponse } from './types.js';

export type McpMessage = McpJsonRpcRequest | McpJsonRpcNotification | McpJsonRpcResponse;

export function encodeMcpMessage(message: McpMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
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
    return messages;
  }

  private tryReadOne(): McpMessage | undefined {
    const headerEnd = indexOfHeaderEnd(this.buffer);
    if (headerEnd < 0) return undefined;
    const headerText = this.buffer.subarray(0, headerEnd).toString('utf8');
    const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
      // Drop a single line if framing is corrupt so we do not spin forever.
      const nextLine = this.buffer.indexOf('\n');
      this.buffer = nextLine >= 0 ? Buffer.from(this.buffer.subarray(nextLine + 1)) : Buffer.alloc(0);
      return undefined;
    }
    const contentLength = Number(lengthMatch[1]);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > 16 * 1024 * 1024) {
      throw new Error(`invalid MCP Content-Length: ${lengthMatch[1]}`);
    }
    const bodyStart = headerEnd + 4;
    if (this.buffer.length < bodyStart + contentLength) return undefined;
    const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8');
    this.buffer = Buffer.from(this.buffer.subarray(bodyStart + contentLength));
    return JSON.parse(body) as McpMessage;
  }
}

function indexOfHeaderEnd(buffer: Buffer) {
  const marker = Buffer.from('\r\n\r\n', 'utf8');
  return buffer.indexOf(marker);
}
