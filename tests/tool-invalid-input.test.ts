import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultToolRegistry } from '../src/tools/index.js';

/*
 * The invalid-input message is the only thing the model sees after a call it
 * could not make sense of, and it becomes both the tool result and a line in
 * the session record. So it has to carry enough to act on — the tool's own hint
 * and what actually arrived — and it has to be bounded: an unparseable payload
 * or a pathological object used to be echoed in full, which floods the context
 * it was meant to help with.
 */

const context = () => ({ workspaceRoot: process.cwd(), approval: 'auto' as const, locale: 'zh' as const });

test('an unparseable payload is echoed (bounded) together with the tool hint', async () => {
  const registry = createDefaultToolRegistry();
  const result = await registry.execute('filename_search', { raw: 'x'.repeat(5000) }, context());
  assert.equal(result.ok, false);
  assert.match(result.output, /参数不是合法 JSON/);
  assert.match(result.output, /query/, 'the hint names the field the tool needs');
  assert.ok(result.output.length < 800, `message was ${result.output.length} chars`);
  assert.match(result.output, /…/, 'the received text is truncated, not dumped');
});

test('the echoed key list is bounded too', async () => {
  const registry = createDefaultToolRegistry();
  const input: Record<string, unknown> = {};
  for (let index = 0; index < 2000; index += 1) input[`key${index}`] = index;
  const result = await registry.execute('filename_search', input, context());
  assert.equal(result.ok, false);
  assert.match(result.output, /收到的键/);
  assert.ok(result.output.length < 800, `message was ${result.output.length} chars`);
});

test('the schema complaint is reported as validation, not as the repair failing', async () => {
  const registry = createDefaultToolRegistry();
  const result = await registry.execute('filename_search', { raw: '{"path": "."}' }, context());
  assert.equal(result.ok, false);
  // "could not be repaired (query is required)" reads as though the repair
  // failed for that reason; the two facts are separate.
  assert.match(result.output, /校验结果：query is required/);
});
