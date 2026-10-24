import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUI_TOOL_NAMES, runGuiTool } from '../src/cli/guiTool.js';

/**
 * The `--gui-tool` path is what the desktop 电脑操控 panel calls once per
 * click. Every case here fails before a tool body runs, so nothing on the
 * machine is touched — which is exactly the property being asserted: bad input
 * becomes a JSON-shaped refusal, never a thrown exception and never an action.
 */

test('the allowlist is exactly the computer_* actions the panel offers', () => {
  assert.deepEqual([...GUI_TOOL_NAMES].sort(), [
    'computer_activate', 'computer_click', 'computer_drag', 'computer_elements',
    'computer_key', 'computer_list_windows', 'computer_press',
    'computer_screenshot', 'computer_scroll', 'computer_type',
    'computer_window_shot',
  ]);
});

test('anything outside the allowlist is refused, not ignored', async () => {
  const result = await runGuiTool('computer_spawn_anything', '{}', process.cwd());
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Unknown GUI tool/);
});

test('a tool that exists but is not part of this path is refused too', async () => {
  // shell/bash are registered tools elsewhere — this path must not become a
  // second, unapproved way to run them.
  const result = await runGuiTool('run_command', '{}', process.cwd());
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /Unknown GUI tool/);
});

test('malformed JSON is reported as JSON, not thrown', async () => {
  const result = await runGuiTool('computer_elements', '{"window": ', process.cwd());
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not valid JSON/);
});

test('the payload must be an object', async () => {
  const array = await runGuiTool('computer_elements', '["Notepad"]', process.cwd());
  assert.equal(array.ok, false);
  assert.match(array.error ?? '', /must be a JSON object/);
  const scalar = await runGuiTool('computer_elements', '5', process.cwd());
  assert.equal(scalar.ok, false);
  assert.match(scalar.error ?? '', /must be a JSON object/);
});

test('missing input is an empty object, so validation speaks, not JSON', async () => {
  const result = await runGuiTool('computer_elements', undefined, process.cwd());
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /window is required/);
});

test('tool validation still applies on this path', async () => {
  const press = await runGuiTool('computer_press', '{"window":"Notepad"}', process.cwd());
  assert.equal(press.ok, false);
  assert.match(press.error ?? '', /index must be a number/);
  const click = await runGuiTool('computer_click', '{"x":10}', process.cwd());
  assert.equal(click.ok, false);
  assert.match(click.error ?? '', /y must be/);
  const type = await runGuiTool('computer_type', '{"window":"Notepad","text":""}', process.cwd());
  assert.equal(type.ok, false);
  assert.match(type.error ?? '', /required/);
  // x and y scroll at a point; one without the other is a typo, not a default.
  const scroll = await runGuiTool('computer_scroll', '{"x":10,"direction":"up"}', process.cwd());
  assert.equal(scroll.ok, false);
  assert.match(scroll.error ?? '', /together/);
});
