/**
 * Harness for scripts/gui-panel-smoke.cjs: renders GuiControlPanel against a
 * recording stand-in for the desktop bridge.
 *
 * `desktop` in src/lib/ipc.ts is captured from window.zcodeDesktop at module
 * evaluation time, so the stub is installed first and the component imported
 * dynamically afterwards. Calls land on window.__guiCalls.
 *
 * The stub answers like the real CLI (window rows, element lines, a refused
 * focus change) so the assertions are about the panel's decisions — what it
 * asks before acting, what it re-reads afterwards — not about the fake.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import '../src/workspace-shell.css';
import '../src/gui-control.css';

type Call = { tool: string; input: Record<string, unknown> };

const calls: Call[] = [];
const asked: string[] = [];

const WINDOWS = [
  { pid: 100, appPid: 0, class: 'Notepad', cloaked: false, iconic: false, title: 'notes.txt - Notepad', left: 0, top: 0, right: 800, bottom: 600 },
  // Minimized: its rect is where it would be restored to, which is why the
  // panel has to label it rather than print a size as if it were on screen.
  { pid: 200, appPid: 300, class: 'ApplicationFrameWindow', cloaked: true, iconic: true, title: '设置', left: 100, top: 100, right: 700, bottom: 700 },
];

const ELEMENTS = [
  '2|Button|文件|(10,10 60x24)|invoke',
  '3|Button|编辑|(80,10 60x24)|invoke',
  '5|Edit|搜索|(10,60 200x24)|invoke',
  '7|Text|准备就绪|(10,100 200x24)|text',
].join('\n');

/**
 * A stand-in capture, drawn at the size the real tool reports (800×600).
 *
 * It has to be a real picture of that size: the panel converts a click on the
 * displayed image back into capture pixels using the image's own dimensions, so
 * a 1×1 placeholder would make every coordinate land on pixel 0 and the test
 * would pass while the feature was broken.
 */
const SHOT_PNG = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, 800, 600);
  context.fillStyle = '#f3f3f3';
  context.fillRect(0, 0, 800, 32);
  context.fillStyle = '#dcdcdc';
  context.fillRect(12, 8, 48, 16);
  context.fillRect(72, 8, 48, 16);
  context.fillStyle = '#e8eef7';
  context.fillRect(12, 60, 240, 24);
  context.fillStyle = '#c9c9c9';
  context.fillRect(12, 110, 320, 12);
  context.fillRect(12, 132, 260, 12);
  return canvas.toDataURL('image/png').split(',')[1];
})();

let elementsReads = 0;

function reply(tool: string, input: Record<string, unknown>) {
  if (tool === 'computer_list_windows') {
    return { ok: true, output: `${WINDOWS.length} window(s)`, data: { windows: WINDOWS, screen: { left: 0, top: 0, width: 1920, height: 1080 } } };
  }
  if (tool === 'computer_elements') {
    elementsReads += 1;
    // A minimized window has no rectangles: the CLI prints `(minimized)` where
    // the position column would be. Those rows must survive parsing — the index
    // is still how they get pressed — so the minimized window returns this shape.
    if (input.window === '300') {
      const mini = [
        '1|Button|最小化|(minimized)|invoke',
        '2|Button|关闭|(minimized)|invoke',
        '3|Text|窗口已最小化|(minimized)|text',
      ].join('\n');
      return {
        ok: true,
        output: `3 of 3 element(s) in 设置 — "index|type|name|(x,y WxH)|action", where the position column reads "(minimized)" for a window that has none. The window is minimized, so its controls have no place on screen.\n${mini}`,
      };
    }
    // The second read reports the menu that the press opened, so the test can
    // tell "re-read after acting" from "showed the stale tree".
    const body = elementsReads === 1 ? ELEMENTS : `${ELEMENTS}\n9|MenuItem|新建标签页|(10,140 120x24)|invoke`;
    return { ok: true, output: `${body.split('\n').length} of 5 element(s) in notes.txt - Notepad — header\n${body}` };
  }
  if (tool === 'computer_window_shot') {
    // Shaped like the real tool: a capture id, the live window rect and the
    // (possibly downscaled) image size. The panel binds later clicks to this id
    // instead of trusting absolute screen coordinates, so the stub has to carry
    // all three or the clickable-image path never runs.
    // The selected window is '100' when it is on screen; '300' is the minimized
    // one (its key comes from appPid, not pid), and the real tool marks that
    // capture `minimized: true` because it was rendered offscreen and has no
    // screen point behind its pixels.
    const minimized = input.window === '300';
    return {
      ok: true,
      output: minimized
        ? 'Captured "设置" (ApplicationFrameWindow) at 100,100 — 600x600, was minimized (rendered offscreen — the user saw nothing).\n'
          + 'Screenshot id shot-1a2b3c4d — for READING only.'
        : 'Captured "notes.txt - Notepad" (Notepad) at 0,0 — 800x600. The user\'s desktop was not touched.\n'
          + 'Screenshot id shot-9f8e7d6c.',
      data: {
        computerImage: { mediaType: 'image/png', data: SHOT_PNG },
        screenshotId: minimized ? 'shot-1a2b3c4d' : 'shot-9f8e7d6c',
        window: input.window,
        ...(minimized ? { minimized: true } : {}),
        rect: { left: 0, top: 0, width: 800, height: 600 },
        image: { width: 800, height: 600 },
      },
    };
  }
  if (tool === 'computer_open') {
    return { ok: true, output: 'Started C:/workspace/tools/Fixture.exe (pid 4242).' };
  }
  if (tool === 'computer_screenshot') {
    return {
      ok: true,
      output: 'Screenshot saved to .aicode/computer/shot.png. Real screen 1920x1080',
      // A desktop grab is not bound to a window, so there is no id to click
      // against — this is the branch that must stay un-clickable.
      data: { computerImage: { mediaType: 'image/png', data: SHOT_PNG, path: '.aicode/computer/shot.png' } },
    };
  }
  if (tool === 'computer_activate') {
    return { ok: false, output: '', error: 'computer_activate: "100" did not take focus' };
  }
  if (tool === 'computer_press') {
    return { ok: true, output: `invoked element ${input.index} (${String(input.expected ?? '')})` };
  }
  if (tool === 'computer_type' || tool === 'computer_key') {
    return { ok: true, output: `${tool} ok` };
  }
  return { ok: true, output: `${tool} ok` };
}

(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = {
  guiControl: {
    status: async () => ({ ok: true, platform: 'win32', built: true }),
    invoke: async (tool: string, input: Record<string, unknown> = {}) => {
      calls.push({ tool, input });
      return reply(tool, input);
    },
  },
};

(window as unknown as { __guiCalls: Call[] }).__guiCalls = calls;
(window as unknown as { __guiAsked: string[] }).__guiAsked = asked;

async function mount() {
  const { GuiControlPanel } = await import('../src/components/GuiControlPanel');
  createRoot(document.getElementById('root')!).render(
    <GuiControlPanel
      desktopMode
      onAskAgent={(text) => { asked.push(text); }}
    />,
  );
}

void mount();
