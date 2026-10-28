/**
 * bg-browser-workbench-preview — 后台浏览器工作台的面板骨架（`--page=bg-browser`）。
 *
 * 这块是 BackgroundBrowserPanel：地址栏、下载、选择器、检查/点击/填写/截图/结束
 * 五个动作、页面链接列表、截图预览、在文件夹中显示。它同时用 settings-shell.css
 * 的分组与字段样式和 background-browser.css 自己的类，所以两份都要引。
 *
 * 冻结口径（离线）：`desktop.backgroundBrowser.*` 全部由本地录制替身回答，不拉起
 * 隐藏浏览器、不下载、不发网络。截图用 canvas 画一张 800×600 的假图（尺寸必须
 * 是真的：面板按图片自身尺寸把点击换算回页面坐标）。
 *
 * `window.bgBrowserPreview.stage(name)` 做的是"用户会怎么点到这里"，一步不跳：
 * 先重挂组件拿到干净基线，再按真实顺序点按钮。
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import '../src/settings-shell.css';
import '../src/background-browser.css';

type Stage = 'idle' | 'inspected' | 'saved' | 'failed';

const SHOT_PNG = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, 800, 600);
  context.fillStyle = '#f3f3f3';
  context.fillRect(0, 0, 800, 40);
  context.fillStyle = '#e8eef7';
  context.fillRect(40, 80, 320, 20);
  context.fillRect(40, 120, 480, 12);
  context.fillRect(40, 144, 420, 12);
  return canvas.toDataURL('image/png').split(',')[1];
})();

let failNext = false;

function reply(tool: string, input: Record<string, unknown>) {
  if (failNext) {
    failNext = false;
    return { ok: false, output: '后台浏览器被策略拒绝：目标主机不在网络白名单内。' };
  }
  if (tool === 'background_browser_open') {
    return { ok: true, output: `已在隐藏浏览器中打开 ${String(input.url ?? input.path)}。`, data: { browserId: 'browser_preview', url: String(input.url ?? ''), hidden: true } };
  }
  if (tool === 'background_browser_inspect') {
    return {
      ok: true,
      output: ['页面：https://example.com/start', '标题：Library', '', '可见文本：', 'Library', 'Paper', 'Notes'].join('\n'),
      data: {
        browserId: 'browser_preview',
        links: [
          { href: 'https://example.com/paper.pdf', text: 'Download the paper' },
          { href: 'https://example.com/next', text: 'Next chapter' },
          { href: 'https://example.com/about', text: 'About this library' },
        ],
        computerImage: { mediaType: 'image/png', data: SHOT_PNG },
      },
    };
  }
  if (tool === 'background_browser_download') {
    return { ok: true, output: '已下载 paper.pdf（598 字节）到 downloads/paper.pdf。', data: { browserId: 'browser_preview', path: 'downloads/paper.pdf', armed: !input.url } };
  }
  return { ok: true, output: `${tool} ok`, data: { browserId: 'browser_preview' } };
}

(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = {
  backgroundBrowser: {
    execute: async (tool: string, input: Record<string, unknown>) => reply(tool, input),
    close: async () => ({ ok: true }),
    status: async () => ({ sessions: [{ sessionId: 'manual-background', browserId: 'browser_preview' }] }),
  },
  workspace: { reveal: async () => ({ ok: true }) },
  preview: { openExternal: async () => ({ ok: true }) },
};

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function clickWhen<T extends HTMLElement>(find: () => T | undefined): Promise<boolean> {
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
  const { BackgroundBrowserPanel } = await import('../src/components/BackgroundBrowserPanel');

  function Preview() {
    const [nonce, setNonce] = useState(0);
    const pending = useRef<(() => void) | null>(null);
    useEffect(() => {
      (window as unknown as { bgBrowserPreview: unknown }).bgBrowserPreview = {
        stage: async (name: Stage) => {
          await new Promise<void>((resolve) => { pending.current = resolve; setNonce((value) => value + 1); });
          if (name === 'idle') return;
          if (name === 'failed') {
            failNext = true;
            await clickWhen(buttonWithText('.background-browser-input-row', '后台打开'));
            await sleep(80);
            return;
          }
          await clickWhen(buttonWithText('.background-browser-input-row', '后台打开'));
          if (name === 'inspected') {
            await clickWhen(buttonWithText('.background-browser-actions', '检查页面'));
            await sleep(80);
            return;
          }
          await clickWhen(buttonWithText('.background-browser-input-row', '下载到 downloads/'));
          await sleep(80);
        },
      };
      document.documentElement.dataset.previewReady = 'true';
      if (pending.current) { const done = pending.current; pending.current = null; void frame().then(done); }
    }, [nonce]);
    return (
      // 真实挂载链是 设置 → 电脑操控 → ComputerSettings 里的 .settings-page，
      // 而控件的 3:1 边框规则写在 `.settings-view :where(.settings-text-field…)`
      // 里。裸挂会把这条规则落在作用域外，量出 1.39:1 —— 那是夹具丢了祖先，
      // 不是产品缺陷。所以这里照原样补上 .settings-view > .settings-content
      // > .settings-page（只把导航列压成单列，不让空栏占位）。
      <div className="settings-view" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
        <div className="settings-content">
          <div className="settings-page">
            <BackgroundBrowserPanel key={nonce} />
          </div>
        </div>
      </div>
    );
  }

  createRoot(document.getElementById('root')!).render(<Preview />);
}

void mount();
