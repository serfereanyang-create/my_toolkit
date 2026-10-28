/**
 * gui-control-preview — 电脑操控面板（`--page=gui-control`）。
 *
 * 这块是 GuiControlPanel：窗口地图 + 控件列表 + 截图 + 前台操作的确认条。它自己
 * 有一套 CSS（gui-control.css），颜色全部来自 token，正好和别处不同源，之前没有
 * 任何可访问性门禁。
 *
 * 冻结口径（离线）：`desktop.guiControl.status/invoke` 由本地录制替身回答，形状照
 * CLI 的真实回包抄（窗口行、`index|type|name|(x,y WxH)|action` 控件行、被最小化的
 * 窗口没有坐标、截图带 id）。不拉起 CLI、不抓屏、不移动鼠标。
 *
 * `window.guiControlPreview.stage(name)` 走用户真实路径：重挂 → 选中窗口 → 读控件
 * → 截窗口 → 触发一次需要确认的前台操作。没有一步是直接塞 state。
 */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import '../src/workspace-shell.css';
import '../src/gui-control.css';

type Stage = 'windows' | 'detail' | 'confirm' | 'shot';

const WINDOWS = [
  { pid: 100, appPid: 0, class: 'Notepad', cloaked: false, iconic: false, title: 'notes.txt - Notepad', left: 0, top: 0, right: 800, bottom: 600 },
  { pid: 200, appPid: 300, class: 'ApplicationFrameWindow', cloaked: true, iconic: true, title: '设置', left: 100, top: 100, right: 700, bottom: 700 },
];

const ELEMENTS = [
  '2|Button|文件|(10,10 60x24)|invoke',
  '3|Button|编辑|(80,10 60x24)|invoke',
  '5|Edit|搜索|(10,60 200x24)|invoke',
  '7|Text|准备就绪|(10,100 200x24)|text',
  '9|MenuItem|新建标签页|(10,140 120x24)|invoke',
].join('\n');

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
  return canvas.toDataURL('image/png').split(',')[1];
})();

function reply(tool: string, input: Record<string, unknown>) {
  if (tool === 'computer_list_windows') {
    return { ok: true, output: `${WINDOWS.length} window(s)`, data: { windows: WINDOWS, screen: { left: 0, top: 0, width: 1920, height: 1080 } } };
  }
  if (tool === 'computer_elements') {
    // 被最小化的窗口没有屏幕矩形：CLI 在位置列打 `(minimized)`，行本身仍留着，
    // 因为序号就是按它的方式。这条分支要能出现在夹具里，否则那段提示永远量不到。
    if (input.window === '300') {
      const mini = [
        '1|Button|最小化|(minimized)|invoke',
        '2|Button|关闭|(minimized)|invoke',
        '3|Text|窗口已最小化|(minimized)|text',
      ].join('\n');
      return { ok: true, output: `3 of 3 element(s) in 设置 — "index|type|name|(x,y WxH)|action"\n${mini}` };
    }
    return { ok: true, output: `5 of 5 element(s) in notes.txt - Notepad — header\n${ELEMENTS}` };
  }
  if (tool === 'computer_window_shot') {
    return {
      ok: true,
      output: 'Captured "notes.txt - Notepad" (Notepad) at 0,0 — 800x600. The user\'s desktop was not touched.\nScreenshot id shot-9f8e7d6c.',
      data: {
        computerImage: { mediaType: 'image/png', data: SHOT_PNG },
        screenshotId: 'shot-9f8e7d6c',
        window: input.window,
        rect: { left: 0, top: 0, width: 800, height: 600 },
        image: { width: 800, height: 600 },
      },
    };
  }
  if (tool === 'computer_click') {
    return { ok: true, output: `clicked ${String(input.x ?? 'center')}, ${String(input.y ?? '')}` };
  }
  if (tool === 'computer_press') return { ok: true, output: `invoked element ${String(input.index)} (${String(input.expected ?? '')})` };
  return { ok: true, output: `${tool} ok` };
}

(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = {
  guiControl: {
    status: async () => ({ ok: true, platform: 'win32', built: true }),
    invoke: async (tool: string, input: Record<string, unknown> = {}) => reply(tool, input),
  },
};

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function clickWhen(find: () => HTMLElement | undefined): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const element = find();
    if (element && !element.hasAttribute('disabled')) {
      element.click();
      await frame();
      await sleep(60);
      return true;
    }
    await sleep(50);
  }
  return false;
}

const buttonWithText = (root: string, text: string) => () =>
  [...document.querySelectorAll<HTMLElement>(`${root} button`)].find((button) => (button.textContent || '').includes(text));

async function mount() {
  const { GuiControlPanel } = await import('../src/components/GuiControlPanel');

  function Preview() {
    const [nonce, setNonce] = useState(0);
    const pending = useRef<(() => void) | null>(null);
    useEffect(() => {
      (window as unknown as { guiControlPreview: unknown }).guiControlPreview = {
        stage: async (name: Stage) => {
          await new Promise<void>((resolve) => { pending.current = resolve; setNonce((value) => value + 1); });
          // 面板挂载时会自动选中第一个窗口（refreshWindows 里挑的），所以
          // `windows` 这一档本身就已经是"选中 + 控件列表"。
          if (name === 'windows') return;
          if (name === 'detail') {
            // 第二行是被最小化的那个窗口：它的控件没有屏幕坐标，面板得如实标注。
            await clickWhen(() => [...document.querySelectorAll<HTMLElement>('.gui-window')][1]);
            await sleep(140);
            return;
          }
          // 其余档都从第一个（在屏幕上的）窗口起步。
          await clickWhen(() => document.querySelector<HTMLElement>('.gui-window') ?? undefined);
          await sleep(120);
          if (name === 'shot') {
            await clickWhen(buttonWithText('.gui-head-actions', '截取窗口'));
            await sleep(120);
            return;
          }
          // 点中心会移动真实指针，面板因此先问一句——要的就是那条确认条。
          await clickWhen(buttonWithText('.gui-detail-actions', '点中心'));
          await sleep(80);
        },
      };
      document.documentElement.dataset.previewReady = 'true';
      if (pending.current) { const done = pending.current; pending.current = null; void frame().then(done); }
    }, [nonce]);
    // App.tsx 把这块直接挂在 `.main` 里（mainView === 'computer'），所以外壳
    // 也照原样给：.chat-shell 的网格 + .main，只是 rail 与右栏压成 0。
    return (
      <div className="chat-shell" style={{ ['--rail-w' as string]: '0px', ['--panel-w' as string]: '0px', ['--context-w' as string]: '0px', ['--preview-w' as string]: '0px' } as React.CSSProperties}>
        <div className="main">
          <GuiControlPanel key={nonce} desktopMode onAskAgent={() => {}} />
        </div>
      </div>
    );
  }

  createRoot(document.getElementById('root')!).render(<Preview />);
}

void mount();
