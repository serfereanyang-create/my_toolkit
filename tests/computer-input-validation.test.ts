import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComputerTools } from '../src/tools/computer.js';
import type { ToolDefinition } from '../src/tools/types.js';

/**
 * Input validation for the computer-control tools. These run without touching
 * Windows: validate() is pure, and the cases below are the argument shapes a
 * model actually produced while driving a real app.
 */
function toolsByName(): Map<string, ToolDefinition<unknown>> {
  const tools = createComputerTools();
  const list = (tools as unknown as { list?: () => ToolDefinition<unknown>[] }).list?.()
    ?? (tools as unknown as ToolDefinition<unknown>[]);
  return new Map(list.map((tool) => [tool.name, tool]));
}

test('computer_activate accepts window as well as target', () => {
  const activate = toolsByName().get('computer_activate');
  assert.ok(activate);
  // Every other computer_* tool spells this argument `window`; passing that
  // used to escape validate() and crash execute() with a raw TypeError.
  assert.deepEqual(activate!.validate({ window: 'Notepad' }), { target: 'Notepad' });
  assert.deepEqual(activate!.validate({ target: 'Notepad' }), { target: 'Notepad' });
});

test('computer_activate explains the expected argument instead of crashing', () => {
  const activate = toolsByName().get('computer_activate');
  assert.throws(() => activate!.validate({}), /window is required .*"window"/);
  assert.throws(() => activate!.validate({ window: '   ' }), /window is required/);
});

test('computer_type keeps whitespace, newlines and non-ASCII in the payload', () => {
  const type = toolsByName().get('computer_type');
  const text = '第二行：含空格 and English 123\nnext line';
  assert.deepEqual(type!.validate({ text }), { text });
  // An optional window is carried through so execute() can verify focus.
  assert.deepEqual(type!.validate({ text, window: ' Notepad ' }), { text, window: 'Notepad' });
  assert.deepEqual(type!.validate({ text, window: '' }), { text });
});

test('computer_key accepts an optional window guard', () => {
  const key = toolsByName().get('computer_key');
  assert.deepEqual(key!.validate({ keys: '^s' }), { keys: '^s' });
  assert.deepEqual(key!.validate({ keys: '^s', window: 'Notepad' }), { keys: '^s', window: 'Notepad' });
  assert.throws(() => key!.validate({ keys: '' }), /keys is required/);
  assert.throws(() => key!.validate({ keys: '^s; rm -rf /' }), /unsupported characters/);
});

test('input tools advertise that typing lands on the focused window', () => {
  const type = toolsByName().get('computer_type');
  const activate = toolsByName().get('computer_activate');
  // The old description promised SendKeys and did not warn that focus decides
  // the destination — the exact mistake that sent test text to the wrong app.
  assert.match(type!.description, /focused window/);
  assert.match(type!.description, /non-ASCII/);
  assert.match(activate!.description, /window/);
});

test('computer_window_shot takes the same window argument as the other tools', () => {
  const shot = toolsByName().get('computer_window_shot');
  assert.ok(shot, 'the background window capture must be registered');
  assert.equal(shot!.risk, 'read', 'capturing a window changes nothing on the machine');
  assert.deepEqual(shot!.validate({ window: ' 记事本 ' }), { window: '记事本' });
  assert.deepEqual(shot!.validate({ window: '1234' }), { window: '1234' });
  assert.throws(() => shot!.validate({}), /window is required/);
  assert.throws(() => shot!.validate({ window: 'x'.repeat(201) }), /too long/);
});

test('computer_open validates executable paths without accepting command arguments', () => {
  const open = toolsByName().get('computer_open');
  assert.ok(open);
  assert.equal(open!.risk, 'shell');
  assert.deepEqual(open!.validate({ path: 'tools/MyApp.exe' }), { path: 'tools/MyApp.exe' });
  assert.deepEqual(open!.validate({ path: 'C:\\Apps\\MyApp.lnk' }), { path: 'C:\\Apps\\MyApp.lnk' });
  assert.deepEqual(open!.validate({ path: 'tools/run.ps1' }), { path: 'tools/run.ps1' });
  assert.throws(() => open!.validate({ path: 'tools/MyApp.exe', args: ['--unsafe'] }), /only accepts path/);
});

test('computer_open refuses scripts before touching the filesystem', async () => {
  const open = toolsByName().get('computer_open')!;
  const result = await open.execute({ path: 'tools/run.ps1' }, { workspaceRoot: process.cwd(), approval: 'auto' } as never);
  assert.equal(result.ok, false);
  assert.match(result.output, /only .exe and .lnk/);
});

test('computer_close requires an explicit window and always prompts', () => {
  const close = toolsByName().get('computer_close');
  assert.ok(close);
  assert.equal(close!.risk, 'shell');
  assert.equal(close!.alwaysPrompt, true);
  assert.deepEqual(close!.validate({ window: 'Fixture' }), { window: 'Fixture' });
  assert.throws(() => close!.validate({}), /window/);
  assert.throws(() => close!.validate({ window: 'Fixture', force: true }), /only accepts/);
});

test('computer_wait_window validates a bounded read-only wait', () => {
  const wait = toolsByName().get('computer_wait_window');
  assert.ok(wait);
  assert.equal(wait!.risk, 'read');
  assert.deepEqual(wait!.validate({ window: 'Fixture', timeoutMs: 5000 }), { window: 'Fixture', timeoutMs: 5000 });
  assert.deepEqual(wait!.validate({ window: 'Fixture' }), { window: 'Fixture', timeoutMs: 10000 });
  assert.throws(() => wait!.validate({ window: 'Fixture', timeoutMs: 99 }), /100 to 30000/);
  assert.throws(() => wait!.validate({ window: 'Fixture', timeoutMs: 30001 }), /100 to 30000/);
  assert.throws(() => wait!.validate({ window: 'Fixture', args: [] }), /only accepts/);
});
