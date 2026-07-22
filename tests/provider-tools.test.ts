import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import { createOpenAIProvider } from '../src/providers/openai.js';
import {
  parseAnthropicContentBlocks,
  parseOpenAIToolCalls,
  toAnthropicTools,
  toOpenAITools,
} from '../src/providers/protocol.js';
import type { ProviderToolSpec } from '../src/providers/types.js';

const sampleTools: ProviderToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    inputHint: '{ "path": "package.json", "maxBytes": 20000 }',
    risk: 'read',
  },
  {
    name: 'run_command',
    description: 'Run a shell command',
    inputHint: '{ "command": "node --version", "timeoutMs": 30000 }',
    risk: 'shell',
  },
];

test('toOpenAITools maps provider specs into function tools', () => {
  const tools = toOpenAITools(sampleTools);
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.type, 'function');
  assert.equal(tools[0]?.function.name, 'read_file');
  assert.equal((tools[0]?.function.parameters as { type?: string }).type, 'object');
  assert.ok((tools[0]?.function.parameters as { properties?: Record<string, unknown> }).properties?.path);
});

test('toAnthropicTools maps provider specs into input_schema tools', () => {
  const tools = toAnthropicTools(sampleTools);
  assert.equal(tools[1]?.name, 'run_command');
  assert.equal((tools[1]?.input_schema as { type?: string }).type, 'object');
  assert.ok((tools[1]?.input_schema as { properties?: Record<string, unknown> }).properties?.command);
});

test('parseOpenAIToolCalls prefers native tool_calls over text content', () => {
  const actions = parseOpenAIToolCalls({
    content: '{"tool":"project_status","input":{}}',
    tool_calls: [
      {
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      },
    ],
  });
  assert.deepEqual(actions, [{ type: 'tool', tool: 'read_file', input: { path: 'README.md' } }]);
});

test('parseOpenAIToolCalls falls back to text JSON protocol', () => {
  const actions = parseOpenAIToolCalls({
    content: '{"tool":"disk_info","input":{"drive":"C"}}',
  });
  assert.deepEqual(actions, [{ type: 'tool', tool: 'disk_info', input: { drive: 'C' } }]);
});

test('parseAnthropicContentBlocks prefers tool_use blocks', () => {
  const actions = parseAnthropicContentBlocks([
    { type: 'text', text: 'thinking' },
    { type: 'tool_use', id: '1', name: 'search_text', input: { query: 'TODO', path: '.' } },
  ]);
  assert.deepEqual(actions, [{ type: 'tool', tool: 'search_text', input: { query: 'TODO', path: '.' } }]);
});

test('OpenAI complete sends tools and parses tool_calls', async () => {
  const originalFetch = globalThis.fetch;
  let outboundBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"package.json\\"}"}}]}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    const provider = createOpenAIProvider({ apiKey: 'k', baseUrl: 'https://openai.test/v1', model: 'm' });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'read package', createdAt: new Date().toISOString() }],
      tools: sampleTools,
      workspaceRoot: process.cwd(),
      toolStrategy: 'Tool strategy:\nintent=file_read',
    });
    assert.ok(Array.isArray(outboundBody?.tools));
    assert.equal(outboundBody?.tool_choice, 'auto');
    assert.equal(outboundBody?.stream, true);
    assert.deepEqual(result.actions, [{ type: 'tool', tool: 'read_file', input: { path: 'package.json' } }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic complete sends tools and parses tool_use', async () => {
  const originalFetch = globalThis.fetch;
  let outboundBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"run_command"}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"node --version\\"}"}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    const provider = createAnthropicProvider({ apiKey: 'k', baseUrl: 'https://anthropic.test/v1', model: 'm' });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'version', createdAt: new Date().toISOString() }],
      tools: sampleTools,
      workspaceRoot: process.cwd(),
    });
    assert.ok(Array.isArray(outboundBody?.tools));
    assert.equal(outboundBody?.stream, true);
    assert.deepEqual(result.actions, [{ type: 'tool', tool: 'run_command', input: { command: 'node --version' } }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
