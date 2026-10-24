/**
 * gui-control.cjs — the desktop side of the 电脑操控 sidebar panel.
 *
 * The panel lists windows, reads an accessibility tree, presses a control and
 * takes screenshots without a model in the loop. Each interaction spawns one
 * headless `--gui-tool` CLI run (ELECTRON_RUN_AS_NODE, so no extra Node install
 * is needed) and reads back a single JSON line. That reuses the exact tool code
 * the agent drives — same window resolution, same UIA walk, same stale-index
 * guard — instead of a second implementation that would drift.
 *
 * Why a child process per action and not a long-lived one: the computer_* tools
 * are PowerShell + user32, and their state (which window is foreground) is
 * global. A fresh process per action means a crash inside UIA can never leave
 * the panel with a wedged helper, and a slow screenshot cannot block a press.
 *
 * Calls are still serialized *here*: two overlapping presses would both try to
 * bring their window forward and the second would act on whatever the first
 * left focused.
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Every tool the panel may run. Mirrors cli/src/cli/guiTool.ts. */
const ALLOWED_TOOLS = new Set([
  'computer_list_windows',
  'computer_elements',
  'computer_press',
  'computer_screenshot',
  'computer_window_shot',
  'computer_click',
  'computer_drag',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_activate',
]);

// UIA walks and DWM activation take a few seconds on a busy desktop; a full
// multi-monitor screenshot plus PNG encode can take longer than a click.
const TIMEOUT_MS = { 'computer_screenshot': 60_000, 'computer_window_shot': 60_000, 'computer_elements': 60_000, 'computer_press': 60_000 };
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
const MAX_STDERR_CHARS = 4_000;

function createGuiControlService({ cliRoot }) {
  const entry = path.join(cliRoot, 'dist', 'src', 'index.js');

  // One action at a time, in submission order. A rejection is absorbed into the
  // chain itself so one failed action never poisons the next.
  let chain = Promise.resolve();

  function runOnce(tool, input, signal) {
    return new Promise((resolve) => {
      let payload;
      try {
        payload = JSON.stringify(input ?? {});
      } catch {
        resolve({ ok: false, output: '', error: 'GUI tool input must be JSON-serializable' });
        return;
      }

      const args = [entry, '--gui-tool', tool, '--gui-input', payload, '--quiet'];
      const child = spawn(process.execPath, args, {
        cwd: cliRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeoutMs = TIMEOUT_MS[tool] ?? DEFAULT_TIMEOUT_MS;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        // The child drives the user's real windows; a hung one must not keep
        // the panel's next action queued forever.
        try { child.kill(); } catch { /* already gone */ }
        finish({ ok: false, output: '', error: tool + ' 超时（' + Math.round(timeoutMs / 1000) + ' 秒），已中止。' });
      }, timeoutMs);
      const abort = () => { try { child.kill(); } catch {} finish({ ok: false, output: '', error: '电脑操控截图已取消。' }); };
      signal?.addEventListener('abort', abort, { once: true });
      const finishWithCleanup = finish;

      child.stdout.on('data', (chunk) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => finishWithCleanup({ ok: false, output: '', error: '无法启动 GUI 工具进程：' + error.message }));
      child.on('close', (code) => {
        const line = stdout.trim().split('\n').filter(Boolean).pop();
        if (!line) {
          finishWithCleanup({ ok: false, output: '', error: stderr.trim().slice(-MAX_STDERR_CHARS) || (tool + ' 没有输出（退出码 ' + code + '）') });
          return;
        }
        try {
          finishWithCleanup(JSON.parse(line));
        } catch {
          finishWithCleanup({ ok: false, output: '', error: '无法解析工具输出（退出码 ' + code + '）：' + line.slice(0, 200) });
        }
      });
    });
  }

  function invoke(tool, input, signal) {
    if (typeof tool !== 'string' || !ALLOWED_TOOLS.has(tool)) {
      return Promise.resolve({ ok: false, output: '', error: '电脑操控面板不支持该操作：' + String(tool) });
    }
    const next = chain.then(() => runOnce(tool, input, signal));
    chain = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Whether the panel can work at all. Reported before the first action so the
   * UI can explain a missing CLI build instead of showing an empty window list
   * that looks like "no applications are open".
   */
  function status() {
    const built = fs.existsSync(entry);
    return {
      ok: built && process.platform === 'win32',
      platform: process.platform,
      built,
      reason: process.platform !== 'win32'
        ? '电脑操控仅支持 Windows。'
        : built ? undefined : 'CLI 尚未构建，请先运行 cli 的 build。',
    };
  }

  return { invoke, status, allowedTools: () => [...ALLOWED_TOOLS].sort() };
}

module.exports = { createGuiControlService, ALLOWED_TOOLS };
