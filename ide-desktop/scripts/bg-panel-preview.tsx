/**
 * Harness for scripts/bg-panel-smoke.cjs: renders BackgroundBrowserPanel with a
 * recording stand-in for the desktop bridge.
 *
 * `desktop` in src/lib/ipc.ts is captured from window.zcodeDesktop at module
 * evaluation time, so the stub is installed first and the component imported
 * dynamically afterwards. Calls are recorded on window.__calls so the smoke
 * script can assert which tool was invoked with which arguments.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import '../src/workspace-shell.css';
import '../src/background-browser.css';

type Call = { tool: string; input: Record<string, unknown> };

const calls: Call[] = [];
const revealed: string[] = [];
let browserId: string | undefined;

function reply(tool: string, input: Record<string, unknown>) {
  if (tool === 'background_browser_open') {
    return { ok: true, output: `已在隐藏浏览器中打开 ${String(input.url ?? input.path)}。`, data: { browserId: 'browser_test', url: String(input.url ?? ''), hidden: true } };
  }
  if (tool === 'background_browser_navigate') {
    return { ok: true, output: `已导航到 ${String(input.url)}。`, data: { browserId: 'browser_test', url: String(input.url), hidden: true } };
  }
  if (tool === 'background_browser_inspect') {
    return {
      ok: true,
      output: ['页面：https://example.com/start', '标题：Library', '', '可见文本：', 'Library', 'Paper'].join('\n'),
      data: {
        browserId: 'browser_test',
        links: [
          { href: 'https://example.com/paper.pdf', text: 'Download the paper' },
          { href: 'https://example.com/next', text: 'Next chapter' },
        ],
      },
    };
  }
  if (tool === 'background_browser_download') {
    return { ok: true, output: '已下载 paper.pdf（598 字节）到 downloads/paper.pdf。', data: { browserId: 'browser_test', path: 'downloads/paper.pdf', armed: !input.url } };
  }
  return { ok: true, output: `${tool} ok`, data: { browserId: 'browser_test' } };
}

(window as unknown as { zcodeDesktop: unknown }).zcodeDesktop = {
  backgroundBrowser: {
    execute: async (tool: string, input: Record<string, unknown>) => {
      calls.push({ tool, input });
      if ((window as unknown as { __failNext?: boolean }).__failNext) {
        (window as unknown as { __failNext?: boolean }).__failNext = false;
        return { ok: false, output: '后台浏览器下载被策略拒绝：目标主机不在网络白名单内。' };
      }
      const result = reply(tool, input);
      if (result.data?.browserId) browserId = result.data.browserId;
      return result;
    },
    close: async () => ({ ok: true }),
    status: async () => ({ sessions: browserId ? [{ sessionId: 'manual-background', browserId }] : [] }),
  },
  workspace: {
    reveal: async (relativePath: string) => { revealed.push(relativePath); return { ok: true }; },
  },
  preview: { openExternal: async () => ({ ok: true }) },
};

(window as unknown as { __calls: Call[] }).__calls = calls;
(window as unknown as { __revealed: string[] }).__revealed = revealed;

async function mount() {
  const { BackgroundBrowserPanel } = await import('../src/components/BackgroundBrowserPanel');
  createRoot(document.getElementById('root')!).render(<BackgroundBrowserPanel />);
}

void mount();
