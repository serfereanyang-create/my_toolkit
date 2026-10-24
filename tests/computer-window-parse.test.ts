import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWindowLine } from '../src/tools/computer.js';

/**
 * computer_list_windows emits one pipe-delimited row per window and the desktop
 * panel parses it back into structured data. The title comes last precisely
 * because titles can contain `|` (a document named "a | b.txt"), so the cases
 * here are the shapes that would silently shift the numeric columns.
 *
 * The `iconic` column is not decoration: a minimized window's geometry is the
 * placement it WOULD be restored to, so a consumer that turns those numbers
 * into a click aims at a place the window currently is not.
 */

const ROW = '1234|0|Notepad|0|0|0|0|800|600|notes.txt - Notepad';

test('a plain row parses into named fields', () => {
  assert.deepEqual(parseWindowLine(ROW), {
    pid: 1234, appPid: 0, class: 'Notepad', cloaked: false, iconic: false,
    left: 0, top: 0, right: 800, bottom: 600, title: 'notes.txt - Notepad',
  });
});

test('a minimized window is reported as such', () => {
  const parsed = parseWindowLine('1234|0|Chrome_WidgetWin_1|0|1|0|0|800|600|邮件 - Chrome');
  assert.ok(parsed);
  assert.equal(parsed.iconic, true);
  assert.equal(parsed.left, 0, 'the geometry survives — it is the restored placement');
});

test('a pipe in the title stays in the title', () => {
  const parsed = parseWindowLine('9|0|Notepad|0|0|-100|20|700|500|a|b|c - Notepad');
  assert.ok(parsed);
  assert.equal(parsed.title, 'a|b|c - Notepad');
  assert.equal(parsed.left, -100, 'a negative left is a real coordinate on a second monitor');
  assert.equal(parsed.right, 700);
});

test('a cloaked packaged-app row keeps its app pid', () => {
  const parsed = parseWindowLine('500|900|ApplicationFrameWindow|1|0|10|10|600|400|设置');
  assert.ok(parsed);
  assert.equal(parsed.cloaked, true);
  assert.equal(parsed.pid, 500);
  assert.equal(parsed.appPid, 900, 'ApplicationFrameHost owns the window; the app pid is what activation needs');
});

test('an empty title is empty, not undefined', () => {
  const parsed = parseWindowLine('1|0|Shell_TrayWnd|0|0|0|0|1920|48|');
  assert.ok(parsed);
  assert.equal(parsed.title, '');
});

test('rows that would corrupt the numeric columns are refused', () => {
  assert.equal(parseWindowLine(''), null);
  assert.equal(parseWindowLine('1|2|Notepad'), null, 'too few columns');
  // The old 8-column shape has no iconic column, so reading it would put the
  // flags where the geometry belongs. Refusing it is the honest answer.
  assert.equal(parseWindowLine('1234|0|Notepad|0|0|0|800|600|notes.txt - Notepad'), null, 'pre-iconic shape');
  assert.equal(parseWindowLine('abc|0|Notepad|0|0|0|0|800|600|t'), null, 'non-numeric pid');
  assert.equal(parseWindowLine('1|0|Notepad|0|0|x|0|800|600|t'), null, 'non-numeric geometry');
});

test('a header line is not mistaken for a window', () => {
  // The tool prints `yoy:screen=...` and a header before the rows; neither may
  // reach the panel as a window with NaN geometry.
  assert.equal(parseWindowLine('yoy:screen=0|0|1920|1080'), null);
  assert.equal(parseWindowLine('pid|appPid|class|cloaked|iconic|left|top|right|bottom|title'), null);
});
