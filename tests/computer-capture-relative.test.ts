import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComputerTools, COMPUTER_USE_STRATEGY } from '../src/tools/computer.js';
import {
  describeDrift,
  loadCapture,
  newCaptureId,
  saveCapture,
  toScreenPoint,
  type CaptureRecord,
} from '../src/tools/computerCapture.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '../src/tools/types.js';

/**
 * The capture-relative coordinate model, which is what makes a click survive
 * (or honestly fail) when the window it targets is not where it was.
 *
 * Nothing here touches a window: the translation and the registry are pure
 * functions over numbers, which is exactly why they are testable — a real
 * click would need a real app on screen and would move the user's pointer.
 */

function toolsByName(): Map<string, ToolDefinition<unknown>> {
  const list = createComputerTools() as unknown as ToolDefinition<unknown>[];
  return new Map(list.map((tool) => [tool.name, tool]));
}

const capture: CaptureRecord = {
  id: 'shot-11112222',
  window: '1234',
  title: 'notes.txt - Notepad',
  className: 'Notepad',
  hwnd: 42,
  left: 100,
  top: 50,
  width: 800,
  height: 600,
  imageWidth: 800,
  imageHeight: 600,
  at: 1_700_000_000_000,
};

test('an image point becomes a screen point using the window origin', () => {
  assert.deepEqual(toScreenPoint(capture, 0, 0), { x: 100, y: 50 });
  assert.deepEqual(toScreenPoint(capture, 400, 300), { x: 500, y: 350 });
});

test('a downscaled capture is scaled back up', () => {
  // The model reads coordinates off the image it was sent, which is capped at
  // 1568px wide; a 4K window therefore arrives at ~0.61x. Treating image
  // pixels as screen pixels would land the click roughly 1000px to the left.
  const huge: CaptureRecord = { ...capture, width: 2560, height: 1600, imageWidth: 1568, imageHeight: 980 };
  const point = toScreenPoint(huge, 784, 490);
  assert.equal(point.x, 100 + 1280);
  assert.equal(point.y, 50 + 800);
});

test('a capture whose window has not moved is trusted', () => {
  assert.equal(describeDrift(capture, { ...capture }), undefined);
});

test('a capture whose window moved is refused with both geometries', () => {
  const moved = describeDrift(capture, { ...capture, left: 300, top: 50 });
  assert.match(moved ?? '', /moved/);
  assert.match(moved ?? '', /100,50/);
  assert.match(moved ?? '', /300,50/);
});

test('a resized window is refused even when its corner is unchanged', () => {
  const resized = describeDrift(capture, { ...capture, width: 1000 });
  assert.match(resized ?? '', /resized/);
});

test('a title change alone is not drift', () => {
  // Saving a document renames the window. Nothing on screen moved, so a
  // coordinate read off the previous capture is still correct.
  const live: CaptureRecord = { ...capture, title: 'notes.txt* - Notepad' };
  assert.equal(describeDrift(capture, live), undefined);
});

test('captures round-trip through the workspace registry, newest first', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-capture-'));
  try {
    const first = { ...capture, id: newCaptureId() };
    const second = { ...capture, id: newCaptureId(), window: '5678' };
    await saveCapture(workspace, first);
    await saveCapture(workspace, second);
    assert.deepEqual(await loadCapture(workspace, first.id), first);
    assert.deepEqual(await loadCapture(workspace, second.id), second);
    assert.equal(await loadCapture(workspace, 'shot-doesnotexist'), undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a missing registry reads as "not captured yet" instead of throwing', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-capture-'));
  try {
    assert.equal(await loadCapture(workspace, 'shot-00000000'), undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('every drag accepts the same capture-relative shape as click', () => {
  const drag = toolsByName().get('computer_drag');
  assert.ok(drag, 'drag must be registered — it is the only way to operate a canvas');
  assert.equal(drag!.risk, 'shell');
  assert.deepEqual(
    drag!.validate({ screenshotId: 'shot-1a2b3c4d', fromX: 10, fromY: 20, toX: 300, toY: 20 }),
    { fromX: 10, fromY: 20, toX: 300, toY: 20, screenshotId: 'shot-1a2b3c4d' },
  );
  // Without an id the values are absolute screen coordinates, which cannot be
  // negative on a normal desktop and must not be silently accepted as such.
  assert.throws(() => drag!.validate({ fromX: -5, fromY: 0, toX: 10, toY: 10 }), /fromX must be between/);
  assert.throws(() => drag!.validate({ fromX: 1, fromY: 2, toX: 3 }), /toY must be a number/);
});

test('click and scroll carry the id through validation', () => {
  const click = toolsByName().get('computer_click')!;
  assert.deepEqual(
    click.validate({ screenshotId: 'shot-1a2b3c4d', x: 400, y: 300 }),
    { x: 400, y: 300, button: 'left', double: false, screenshotId: 'shot-1a2b3c4d' },
  );
  // The window is optional, but when present it names the capture's window and
  // is checked against it — a click on window A must not use window B's id.
  const named = click.validate({ window: '记事本', screenshotId: 'shot-1a2b3c4d', x: 1, y: 2 }) as { window?: string };
  assert.deepEqual(named.window, '记事本');
  const scroll = toolsByName().get('computer_scroll')!;
  assert.deepEqual(
    scroll.validate({ screenshotId: 'shot-1a2b3c4d', x: 10, y: 20, direction: 'up' }),
    { x: 10, y: 20, direction: 'up', amount: 3, screenshotId: 'shot-1a2b3c4d' },
  );
  // Scrolling at a point in a capture is meaningless without the point.
  assert.throws(() => scroll.validate({ screenshotId: 'shot-1a2b3c4d', direction: 'down' }), /x and y are required/);
});

test('the strategy tells the model not to do coordinate math', () => {
  // The old text told the model to multiply by a scale factor itself, which is
  // the instruction that produced clicks landing off-target.
  assert.match(COMPUTER_USE_STRATEGY, /screenshotId/);
  assert.match(COMPUTER_USE_STRATEGY, /Do not do scale-factor/);
  // A minimized window IS capturable now (restored offscreen for the length of
  // the capture), but the text must not let the model believe it can click the
  // result: a minimized window has no live screen position to aim at.
  assert.match(COMPUTER_USE_STRATEGY, /restored offscreen/);
  assert.match(COMPUTER_USE_STRATEGY, /no on-screen position to click/);
  assert.doesNotMatch(COMPUTER_USE_STRATEGY, /it is refused rather than restored/);
});

test('a minimized capture is readable but refuses to be aimed at', async () => {
  // The window was photographed while parked offscreen, so its pixels are real
  // and its coordinates are not: (400, 300) belongs to no screen point. Without
  // this refusal, resolvePoint would derive one from the remembered rect — and
  // click whatever is sitting there now.
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-capture-'));
  try {
    const stale: CaptureRecord = { ...capture, id: newCaptureId(), minimized: true };
    await saveCapture(workspace, stale);
    const click = toolsByName().get('computer_click')!;
    const result = await click.execute(
      { x: 400, y: 300, button: 'left', double: false, screenshotId: stale.id },
      { workspaceRoot: workspace } as never,
    );
    assert.equal(result.ok, false);
    assert.match(result.output, /minimized/);
    assert.match(result.output, /computer_window_shot again/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a window that cannot be parked off screen is refused, not shown', async () => {
  // Measured behaviour that this guards: Chrome and Edge clamp a restored
  // position of (-30000,-30000) back to (0,0), the user's top-left corner. An
  // earlier version assumed the park had worked and, on finding the window
  // elsewhere afterwards, treated it as "the user moved it" and left it there —
  // so the window stayed restored, in front of the user, which is the one thing
  // this tool must never cause.
  //
  // The contract now is: an app with no acceptable off-screen position gets a
  // refusal that explains itself, and the strategy says the same thing, so the
  // model falls back instead of retrying.
  assert.match(COMPUTER_USE_STRATEGY, /clamps its position back on screen is refused/);
  const shot = toolsByName().get('computer_window_shot')!;
  assert.match(shot.description, /not captured at all/);
  // It must never advertise activation as a way to make this work: that would
  // be the tool deciding to take the user's screen.
  assert.doesNotMatch(shot.description, /will activate it for you/);
});

test('the strategy names drag for the things that can only be moved', () => {  // Sliders, scrollbar thumbs and canvases have no control to press; without
  // computer_drag in the loop the model would keep trying to click them.
  assert.match(COMPUTER_USE_STRATEGY, /computer_drag/);
  assert.match(COMPUTER_USE_STRATEGY, /slider/i);
  assert.match(COMPUTER_USE_STRATEGY, /covered by another window/);
});
