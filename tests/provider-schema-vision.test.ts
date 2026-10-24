import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGeminiProvider } from '../src/providers/gemini.js';
import { schemaFromInputHint, toOpenAITools, toOpenAIResponsesTools, toAnthropicTools } from '../src/providers/protocol.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createBackgroundAppTools } from '../src/tools/backgroundApp.js';
import { createBackgroundBrowserTools } from '../src/tools/backgroundBrowser.js';
import { bridgeMcpTools } from '../src/mcp/bridge.js';
import type { McpClient } from '../src/mcp/client.js';
import type { ProviderToolSpec } from '../src/providers/types.js';

const schema = { type: 'object', properties: { appId: { type: 'string' }, points: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false } } }, required: ['appId'], additionalProperties: false };
const spec: ProviderToolSpec = { name: 'structured_tool', description: 'structured input', inputHint: '{ "wrongHint": "ignored" }', inputSchema: schema, risk: 'read' };

test('legacy inference reads each value without borrowing digits or booleans from its neighbour', () => {
  const parsed = schemaFromInputHint('{ "appId": "app-id", "x": 120, "text": "version2", "enabled": false, "limit": 20 }') as { properties: Record<string, { type: string }> };
  assert.equal(parsed.properties.appId!.type, 'string');
  assert.equal(parsed.properties.x!.type, 'number');
  assert.equal(parsed.properties.text!.type, 'string');
  assert.equal(parsed.properties.enabled!.type, 'boolean');
  assert.equal(parsed.properties.limit!.type, 'number');
});

test('three native provider formats preserve explicit schemas and optional fields', () => {
  assert.deepEqual(toOpenAITools([spec])[0]!.function.parameters, schema);
  assert.deepEqual(toAnthropicTools([spec])[0]!.input_schema, schema);
  assert.deepEqual(toOpenAIResponsesTools([spec])[0]!.parameters, schema);
  assert.equal(toOpenAIResponsesTools([spec])[0]!.strict, false);
  const legacy = { ...spec, inputSchema: undefined, inputHint: '{ "path": "file.txt", "maxBytes": 100 }' };
  const legacyTool = toOpenAIResponsesTools([legacy])[0]!;
  assert.equal(legacyTool.strict, false);
  assert.deepEqual(legacyTool.parameters.required, ['path']);
});

test('background tools keep required ids, integer window ids and the browser URL/path alternative', () => {
  const invoke = async () => ({ ok: true, output: 'ok' });
  const registry = ToolRegistry.fromTools([...createBackgroundAppTools(invoke), ...createBackgroundBrowserTools(invoke)]);
  const app = registry.specs().find(tool => tool.name === 'background_app_inspect')!;
  assert.deepEqual(app.inputSchema!.required, ['appId']);
  assert.equal((app.inputSchema!.properties as Record<string, { type: string }>).windowId!.type, 'integer');
  const browser = registry.specs().find(tool => tool.name === 'background_browser_open')!;
  assert.deepEqual(browser.inputSchema!.oneOf, [{ required: ['url'] }, { required: ['path'] }]);
  assert.equal(browser.inputSchema!.additionalProperties, false);
});

test('MCP preserves a long nested server schema instead of rebuilding it from a truncated hint', () => {
  const declared = { ...schema, description: 'schema detail '.repeat(80) };
  const client = { name: 'schema', getTools: () => [{ name: 'echo', description: 'echo', inputSchema: declared, annotations: { readOnlyHint: true } }] } as unknown as McpClient;
  const registry = ToolRegistry.fromTools(bridgeMcpTools(client));
  assert.deepEqual(registry.specs()[0]!.inputSchema, declared);
  assert.equal(registry.specs()[0]!.inputHint.length, 240);
});

test('Gemini sends the complete JSON schema and image pixels from user and tool messages', async () => {
  const previousFetch = globalThis.fetch;
  let outbound: Record<string, any> | undefined;
  globalThis.fetch = async (_input, init) => {
    outbound = JSON.parse(String(init?.body));
    return new Response('data: {"candidates":[{"content":{"parts":[{"text":"done"}]}}]}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const provider = createGeminiProvider({ apiKey: 'test-only', baseUrl: 'https://gemini.test', model: 'fixture' });
    await provider.complete({ workspaceRoot: process.cwd(), tools: [spec], messages: [
      { role: 'user', content: 'read the image', createdAt: '2026-10-22T00:00:00Z', parts: [{ type: 'text', text: 'read the image' }, { type: 'image', mediaType: 'image/png', data: 'dXNlcg==' }] },
      { role: 'assistant', content: 'capture', createdAt: '2026-10-22T00:00:01Z' },
      { role: 'tool', name: 'background_app_screenshot', content: 'actual app capture', createdAt: '2026-10-22T00:00:02Z', parts: [{ type: 'image', mediaType: 'image/png', data: 'c2NyZWVu' }] },
    ] });
    assert.deepEqual(outbound!.tools[0].functionDeclarations[0].parametersJsonSchema, schema);
    assert.equal(Object.hasOwn(outbound!.tools[0].functionDeclarations[0], 'parameters'), false);
    const parts = outbound!.contents.flatMap((content: { parts: any[] }) => content.parts);
    assert.ok(parts.some((part: any) => part.inlineData?.mimeType === 'image/png' && part.inlineData.data === 'dXNlcg=='));
    assert.ok(parts.some((part: any) => part.inlineData?.data === 'c2NyZWVu'));
    assert.ok(parts.some((part: any) => part.text?.includes('[tool:background_app_screenshot] actual app capture')));
  } finally { globalThis.fetch = previousFetch; }
});
