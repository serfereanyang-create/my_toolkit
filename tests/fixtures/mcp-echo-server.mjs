#!/usr/bin/env node
/**
 * Minimal stdio MCP server for aicode tests.
 * Implements initialize, tools/list, tools/call (echo).
 */
import { Buffer } from 'node:buffer';

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) break;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
    buffer = buffer.subarray(bodyStart + length);
    handleMessage(JSON.parse(body));
  }
});

function write(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'aicode-echo', version: '0.0.1' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo text back',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'fail',
            description: 'Return an error payload',
            inputSchema: { type: 'object', properties: {} },
            annotations: { destructiveHint: true },
          },
        ],
      },
    });
    return;
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    if (name === 'echo') {
      const text = message.params?.arguments?.text ?? '';
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: `echo:${text}` }],
        },
      });
      return;
    }
    if (name === 'fail') {
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: 'intentional failure' }],
          isError: true,
        },
      });
      return;
    }
    write({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    });
    return;
  }
  if (message.id !== undefined) {
    write({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    });
  }
}
