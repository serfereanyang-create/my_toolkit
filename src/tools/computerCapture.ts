/**
 * computerCapture.ts — the screenshot-id registry behind window-relative
 * input.
 *
 * A window-relative coordinate is only meaningful against one specific
 * capture: (400, 300) means "the button that was at 400,300 in that picture",
 * and that stops being true the moment the window is moved, resized, or
 * restored from a different placement. Codex binds coordinates to a
 * `screenshotId` for exactly this reason; so do we, and the binding is what
 * turns "the click missed" into "the window moved since you looked".
 *
 * Ids have to survive a process boundary because every computer_* call is its
 * own headless CLI run (see cli/src/cli/guiTool.ts). The registry is therefore
 * a small JSON file under the workspace's .aicode directory rather than
 * in-memory state.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type CaptureRecord = {
  /** Opaque id handed to the model; `shot-` plus 8 hex characters. */
  id: string;
  /** The `window` argument that produced the capture (pid or title substring). */
  window: string;
  title: string;
  className: string;
  hwnd: number;
  left: number;
  top: number;
  /** The window's own size in screen pixels. */
  width: number;
  height: number;
  /**
   * The size of the PNG the model actually looked at. It can be smaller than
   * the window (a 4K window is downscaled before it is sent), and the model
   * reads coordinates off THAT image — so translating back has to go through
   * this ratio, not assume one image pixel is one screen pixel.
   */
  imageWidth: number;
  imageHeight: number;
  /**
   * Set when the window was minimized and was photographed offscreen. The
   * pixels are the app's own, but there is no live screen position behind them:
   * a point in this image cannot be translated into a click, and pretending
   * otherwise would aim at wherever the window would have been — which may be
   * another app entirely. Such a capture is readable, never actionable.
   */
  minimized?: boolean;
  /** Unix ms. */
  at: number;
};

export type CaptureRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** Newest first; older captures fall off so the file cannot grow forever. */
const MAX_CAPTURES = 24;

export function newCaptureId(): string {
  return 'shot-' + randomBytes(4).toString('hex');
}

export function capturePath(workspaceRoot: string): string {
  return join(workspaceRoot, '.aicode', 'computer', 'captures.json');
}

/** Image-space point from a capture → the screen point SetCursorPos takes. */
export function toScreenPoint(
  capture: CaptureRect & { imageWidth: number; imageHeight: number },
  x: number,
  y: number,
): { x: number; y: number } {
  const sx = capture.imageWidth > 0 ? capture.width / capture.imageWidth : 1;
  const sy = capture.imageHeight > 0 ? capture.height / capture.imageHeight : 1;
  return { x: capture.left + Math.round(x * sx), y: capture.top + Math.round(y * sy) };
}

/**
 * Why a capture can no longer be trusted for coordinates, or undefined when its
 * geometry still matches the live window.
 *
 * Only geometry is compared: the same window may have a different title by now
 * (a document was saved, a tab changed) and that does not move any pixel.
 */
export function describeDrift(capture: CaptureRect, live: CaptureRect): string | undefined {
  const moved = capture.left !== live.left || capture.top !== live.top;
  const resized = capture.width !== live.width || capture.height !== live.height;
  if (!moved && !resized) return undefined;
  const what = moved && resized ? 'moved and was resized' : moved ? 'moved' : 'was resized';
  return `the window ${what} since the screenshot: it was at (${capture.left},${capture.top}) ${capture.width}×${capture.height}, `
    + `it is now at (${live.left},${live.top}) ${live.width}×${live.height}`;
}

async function readAll(path: string): Promise<CaptureRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { shots?: unknown };
    if (!Array.isArray(parsed.shots)) return [];
    return parsed.shots.filter((row): row is CaptureRecord =>
      Boolean(row) && typeof row === 'object'
      && typeof (row as CaptureRecord).id === 'string'
      && Number.isFinite((row as CaptureRecord).left)
      && Number.isFinite((row as CaptureRecord).width));
  } catch {
    // A missing or corrupt registry means "no ids known yet", never a crash:
    // the caller turns that into "capture the window again".
    return [];
  }
}

export async function saveCapture(workspaceRoot: string, record: CaptureRecord): Promise<void> {
  const path = capturePath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true });
  const previous = (await readAll(path)).filter((row) => row.id !== record.id);
  await writeFile(path, JSON.stringify({ shots: [record, ...previous].slice(0, MAX_CAPTURES) }), 'utf8');
}

export async function loadCapture(workspaceRoot: string, id: string): Promise<CaptureRecord | undefined> {
  return (await readAll(capturePath(workspaceRoot))).find((row) => row.id === id);
}
