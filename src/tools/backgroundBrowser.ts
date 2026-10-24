import { isAbsolute, posix, win32 } from 'node:path';
import type { HostToolInvoker } from '../cli/hostToolBroker.js';
import { validateHostToolResult } from '../cli/hostToolBroker.js';
import { decideApproval, evaluateNetworkTarget, resolveWorkspacePath } from '../safety/policy.js';
import type { ToolContext, ToolDefinition, ToolResult } from './types.js';

export const BACKGROUND_BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'background_browser_open',
  'background_browser_navigate',
  'background_browser_inspect',
  'background_browser_click',
  'background_browser_fill',
  'background_browser_key',
  'background_browser_download',
  'background_browser_screenshot',
  'background_browser_close',
]);

export const BACKGROUND_BROWSER_STRATEGY =
  'Background browser tools operate only on a desktop-hosted hidden web page, not native application windows or the system desktop. '
  + 'Open a permitted URL or a workspace-relative HTML path with background_browser_open, then use the returned data.browserId for every subsequent operation. '
  + 'Observe with background_browser_inspect or background_browser_screenshot, perform one DOM action (click/fill/key), and inspect again to verify. '
  + 'To read material a site offers, follow it with background_browser_navigate (a different site is another origin, and a click cannot cross one) '
  + 'or save it with background_browser_download, which writes into the workspace downloads/ directory; the returned path can then be read with '
  + 'pdf_to_text, read_file, html_to_text or extract_zip. Downloading first and analysing the local copy is more reliable than re-fetching the page. '
  + 'There is no arbitrary JavaScript/eval tool. Never pass scripts, shell commands, native GUI coordinates, or secrets as selectors. '
  + 'When background-only mode is enabled, never fall back to computer_* tools or native GUI automation; explain unsupported native-app tasks instead. '
  + 'Close the hidden page when finished. Network and workspace policies still apply.';

export type BackgroundBrowserOpenInput = { url?: string; path?: string; width?: number; height?: number };
export type BackgroundBrowserInput = { browserId: string };
export type BackgroundBrowserNavigateInput = BackgroundBrowserInput & { url: string };
export type BackgroundBrowserInspectInput = BackgroundBrowserInput & { selector?: string; maxElements?: number };
export type BackgroundBrowserClickInput = BackgroundBrowserInput & { selector: string; button?: 'left' | 'middle' | 'right'; double?: boolean };
export type BackgroundBrowserFillInput = BackgroundBrowserInput & { selector: string; value: string };
export type BackgroundBrowserKeyInput = BackgroundBrowserInput & { key: string; selector?: string };
export type BackgroundBrowserDownloadInput = BackgroundBrowserInput & { url?: string; name?: string; maxBytes?: number };
export type BackgroundBrowserScreenshotInput = BackgroundBrowserInput & { fullPage?: boolean };

/**
 * Tools exist only when the desktop bridge provides an RPC invoker. No hidden
 * child processes, native computer tools or local JS execution are used here.
 * The host must independently enforce session ownership, paths and navigation.
 */
export function createBackgroundBrowserTools(invoke: HostToolInvoker): ToolDefinition[] {
  const run = async (tool: string, input: Record<string, unknown>): Promise<ToolResult> => {
    const result = validateHostToolResult(await invoke(tool, input));
    if (result.ok && tool === 'background_browser_screenshot') validateScreenshot(result);
    return result;
  };

  const open: ToolDefinition<BackgroundBrowserOpenInput> = {
    name: 'background_browser_open',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        path: { type: 'string' },
        width: { type: 'integer', minimum: 100, maximum: 4096 },
        height: { type: 'integer', minimum: 100, maximum: 4096 },
      },
      oneOf: [{ required: ['url'] }, { required: ['path'] }],
      additionalProperties: false,
    },
    description: 'Open one desktop-hosted hidden browser page, using exactly one HTTP(S) url or workspace-relative HTML path. Optional width/height set the viewport (integer pixels, 100–4096). Returns data.browserId for subsequent DOM tools. Requires desktop bridge capability; cannot control native apps. Network and workspace policy are enforced.',
    // The legacy hint-to-schema parser marks every "path" field required, so
    // keep the alternative in prose rather than emitting a breaking schema.
    inputHint: '{ "url": "https://example.com/" } or an object with path (workspace-relative HTML); optional "width": 1280, "height": 720; exactly one url/path',
    risk: 'write',
    // A browser session has no file write target in its URL form. Allow the
    // registry to reach the exact network/path gate below, never to bypass it.
    autoApprove: true,
    parallelSafe: false,
    validate(input) {
      const obj = strictObject(input, ['url', 'path', 'width', 'height']);
      const hasUrl = Object.hasOwn(obj, 'url');
      const hasPath = Object.hasOwn(obj, 'path');
      if (hasUrl === hasPath) throw new Error('Exactly one of url or path is required');
      const result: BackgroundBrowserOpenInput = {};
      if (hasUrl) {
        const rawUrl = nonemptyString(obj.url, 'url', 8192);
        const url = new URL(rawUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('url must use http or https');
        if (url.username || url.password) throw new Error('url must not contain credentials');
        result.url = url.toString();
      } else {
        result.path = workspaceRelativePath(obj.path);
      }
      if (Object.hasOwn(obj, 'width')) result.width = integer(obj.width, 'width', 100, 4096);
      if (Object.hasOwn(obj, 'height')) result.height = integer(obj.height, 'height', 100, 4096);
      return result;
    },
    async execute(input, context) {
      const blocked = openPolicyFailure(input, context);
      if (blocked) return { ok: false, output: blocked };
      // Ask/plan already confirmed once through the registry's write gate. Do
      // not prompt a second time; the exact gate above is still hard enforced.
      return run(open.name, input);
    },
  };

  const navigate: ToolDefinition<BackgroundBrowserNavigateInput> = {
    name: 'background_browser_navigate',
    description: 'Go to an http/https URL in this hidden page, including a different site. Use it to follow a search result or a link from background_browser_inspect; a click cannot cross to another origin. Adds the destination origin to this page\'s allowed set for the rest of the session. Returns the final URL after redirects. Network policy applies.',
    inputHint: '{ "browserId": "browser-id", "url": "https://example.com/paper" }',
    risk: 'write',
    autoApprove: true,
    parallelSafe: false,
    validate(input) {
      const obj = strictObject(input, ['browserId', 'url']);
      return { browserId: browserId(obj), url: httpUrl(obj.url) };
    },
    async execute(input, context) {
      const blocked = openPolicyFailure({ url: input.url }, context);
      if (blocked) return { ok: false, output: blocked };
      return run(navigate.name, input);
    },
  };

  const inspect: ToolDefinition<BackgroundBrowserInspectInput> = {
    name: 'background_browser_inspect',
    description: 'Read the hidden page DOM: text and interactive elements with CSS selectors. Optional selector narrows the snapshot; maxElements is an integer from 1 to 200. Re-inspect after every change. Desktop hidden web pages only; no JS/eval or native UI access.',
    inputHint: '{ "browserId": "browser-id", "selector": "main", "maxElements": 100 }',
    risk: 'read',
    parallelSafe: false,
    validate(input) {
      const obj = strictObject(input, ['browserId', 'selector', 'maxElements']);
      const result: BackgroundBrowserInspectInput = { browserId: browserId(obj) };
      if (Object.hasOwn(obj, 'selector')) result.selector = selector(obj.selector);
      if (Object.hasOwn(obj, 'maxElements')) result.maxElements = integer(obj.maxElements, 'maxElements', 1, 200);
      return result;
    },
    execute: (input) => run(inspect.name, input),
  };

  const click: ToolDefinition<BackgroundBrowserClickInput> = {
    name: 'background_browser_click',
    description: 'Click a CSS-selected DOM element in the hidden browser page. button may be left/middle/right and double may request a double-click. May submit forms or navigate; follows approval policy. No desktop coordinates or native GUI control.',
    inputHint: '{ "browserId": "browser-id", "selector": "button.submit", "button": "left", "double": false }',
    risk: 'shell',
    // Curated DOM-only actions carry no shell command: auto mode may execute
    // them, ask/plan still prompt, and deny mode still blocks them.
    autoApprove: true,
    parallelSafe: false,
    validate(input) {
      const obj = strictObject(input, ['browserId', 'selector', 'button', 'double']);
      const result: BackgroundBrowserClickInput = { browserId: browserId(obj), selector: selector(obj.selector) };
      if (Object.hasOwn(obj, 'button')) {
        if (obj.button !== 'left' && obj.button !== 'middle' && obj.button !== 'right') throw new Error('button must be left, middle or right');
        result.button = obj.button;
      }
      if (Object.hasOwn(obj, 'double')) result.double = boolean(obj.double, 'double');
      return result;
    },
    execute: (input) => run(click.name, input),
  };

  const fill: ToolDefinition<BackgroundBrowserFillInput> = {
    name: 'background_browser_fill',
    description: 'Replace the value of a CSS-selected input, textarea or select in the hidden browser page. value is plain text, not executable code; an empty string clears a field. May change page state or send data; follows approval policy. No native typing.',
    inputHint: '{ "browserId": "browser-id", "selector": "input[name=email]", "value": "text" }',
    risk: 'shell',
    autoApprove: true,
    parallelSafe: false,
    validate(input) {
      const obj = strictObject(input, ['browserId', 'selector', 'value']);
      if (typeof obj.value !== 'string' || obj.value.length > 100_000 || obj.value.includes('\0')) throw new Error('value must be a string of at most 100000 characters without NUL');
      return { browserId: browserId(obj), selector: selector(obj.selector), value: obj.value };
    },
    execute: (input) => run(fill.name, input),
  };

  const key: ToolDefinition<BackgroundBrowserKeyInput> = {
    name: 'background_browser_key',
    description: 'Send one DOM key or key chord to the hidden page, optionally focusing a CSS selector first. Examples: Enter, Tab, Escape, ArrowDown, Control+A. Only page keyboard events, never native shortcuts, scripts or shell commands; follows approval policy.',
    inputHint: '{ "browserId": "browser-id", "key": "Enter", "selector": "input[name=q]" }',
    risk: 'shell',
    autoApprove: true,
    parallelSafe: false,
    validate(input) {
      const obj = strictObject(input, ['browserId', 'key', 'selector']);
      const result: BackgroundBrowserKeyInput = { browserId: browserId(obj), key: domKey(obj.key) };
      if (Object.hasOwn(obj, 'selector')) result.selector = selector(obj.selector);
      return result;
    },
    execute: (input) => run(key.name, input),
  };

  const download: ToolDefinition<BackgroundBrowserDownloadInput> = {
    name: 'background_browser_download',
    description: 'Save a file the page offers into the workspace downloads/ directory, using this page\'s own session and cookies. Pass the link\'s url (from background_browser_inspect) or omit it to capture the download triggered by the next click. Returns data.path — a workspace-relative file that pdf_to_text, read_file, html_to_text or extract_zip can open. Files are capped (50MB by default) and named by the server; unsafe names are sanitised. If the URL answers with a web page instead of a file, the page is navigated there and the result says so.',
    inputHint: '{ "browserId": "browser-id", "url": "https://example.com/paper.pdf" }',
    risk: 'network',
    autoApprove: false,
    parallelSafe: false,
    validate(input) {
      const obj = strictObject(input, ['browserId', 'url', 'name', 'maxBytes']);
      const result: BackgroundBrowserDownloadInput = { browserId: browserId(obj) };
      if (Object.hasOwn(obj, 'url')) result.url = httpUrl(obj.url);
      if (Object.hasOwn(obj, 'name')) {
        const name = nonemptyString(obj.name, 'name', 200);
        if (/[\\/]/.test(name)) throw new Error('name must be a bare filename without a directory');
        result.name = name;
      }
      if (Object.hasOwn(obj, 'maxBytes')) result.maxBytes = integer(obj.maxBytes, 'maxBytes', 1024, 200 * 1024 * 1024);
      return result;
    },
    async execute(input, context) {
      if (input.url) {
        // The download passes the same network gate as any other outbound
        // request; `download_file`'s workspace policy does not apply because the
        // host writes into its own downloads/ directory.
        const verdict = evaluateNetworkTarget(input.url, context.networkAllowlist ?? []);
        if (!verdict.ok) return { ok: false, output: `后台浏览器下载被策略拒绝：${verdict.reason}` };
        const decision = decideApproval({
          mode: context.approval,
          risk: 'network',
          workspaceRoot: context.workspaceRoot,
          url: input.url,
          networkAllowlist: context.networkAllowlist,
        });
        if (!decision.allowed) return { ok: false, output: `后台浏览器下载被策略拒绝：${decision.reason}` };
      }
      return run(download.name, input);
    },
  };

  const screenshot: ToolDefinition<BackgroundBrowserScreenshotInput> = {
    name: 'background_browser_screenshot',
    description: 'Capture the hidden page as an image (not the system desktop). Optional fullPage requests the complete page. Returns data.computerImage with mediaType/base64 data/workspace-relative path for image rendering and model vision. Host stores captures only under workspace .aicode; no caller-selected output path.',
    inputHint: '{ "browserId": "browser-id", "fullPage": false }',
    risk: 'read',
    parallelSafe: false,
    validate(input) {
      const obj = strictObject(input, ['browserId', 'fullPage']);
      const result: BackgroundBrowserScreenshotInput = { browserId: browserId(obj) };
      if (Object.hasOwn(obj, 'fullPage')) result.fullPage = boolean(obj.fullPage, 'fullPage');
      return result;
    },
    execute: (input) => run(screenshot.name, input),
  };

  const close: ToolDefinition<BackgroundBrowserInput> = {
    name: 'background_browser_close',
    description: 'Close this conversation’s hidden browser page and discard its unsaved DOM state. Does not close native applications or other conversations’ browsers. Follows write approval policy.',
    inputHint: '{ "browserId": "browser-id" }',
    risk: 'write',
    autoApprove: true,
    parallelSafe: false,
    validate(input) {
      const obj = strictObject(input, ['browserId']);
      return { browserId: browserId(obj) };
    },
    execute: (input) => run(close.name, input),
  };

  return [open, navigate, inspect, click, fill, key, download, screenshot, close];
}

/** Desktop approval cards must show the actual navigation, not just risk=write. */
export function backgroundBrowserOpenApprovalMessage(input: Record<string, unknown>): string {
  const target = typeof input.url === 'string'
    ? `后台浏览器将打开网页：${input.url}`
    : `后台浏览器将打开工作区网页文件：${String(input.path ?? '')}`;
  return `${target}\n仅作用于此会话的隐藏网页，不控制原生桌面应用；页面脚本可能请求网络或提交数据，仍受网络与工作区策略限制。是否允许？`;
}

/** The download card must name the file's source, not just "network". */
export function backgroundBrowserDownloadApprovalMessage(input: Record<string, unknown>): string {
  const source = typeof input.url === 'string' ? input.url : '页面上下一个点击所触发的下载';
  return `后台浏览器将下载文件到工作区 downloads/ 目录：${source}\n文件内容来自外部网站，可能携带任意字节；下载后仅作为数据处理，不会自动执行。是否允许？`;
}

function openPolicyFailure(input: BackgroundBrowserOpenInput, context: ToolContext): string | undefined {
  if (input.url) {
    // decideApproval's plan branch prompts before its network check. Enforce
    // the hard network boundary independently even after a plan-mode approval.
    const verdict = evaluateNetworkTarget(input.url, context.networkAllowlist ?? []);
    if (!verdict.ok) return `后台浏览器网络请求被策略拒绝：${verdict.reason}`;
  } else if (input.path) {
    // Hidden local pages are always workspace-confined, including full access.
    try { resolveWorkspacePath(context.workspaceRoot, input.path); } catch (error) {
      return `后台浏览器路径被策略拒绝：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const decision = decideApproval({
    mode: context.approval,
    risk: input.url ? 'network' : 'write',
    workspaceRoot: context.workspaceRoot,
    targetPath: input.path,
    url: input.url,
    networkAllowlist: context.networkAllowlist,
  });
  return decision.allowed ? undefined : `后台浏览器操作被策略拒绝：${decision.reason}`;
}

function strictObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Background browser input must be an object');
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`Unknown background browser input field: ${key}`);
  }
  return value;
}

function nonemptyString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a nonempty string of at most ${maxLength} characters without control characters`);
  }
  return value.trim();
}

function workspaceRelativePath(value: unknown): string {
  const path = nonemptyString(value, 'path', 4096).replace(/\\/g, '/');
  if (isAbsolute(path) || posix.isAbsolute(path) || win32.isAbsolute(path) || path.includes(':')) throw new Error('path must be workspace-relative');
  if (path.split('/').includes('..')) throw new Error('path must not contain parent traversal');
  const normalized = posix.normalize(path);
  if (normalized === '.' || normalized.endsWith('/')) throw new Error('path must name a workspace-relative file');
  return normalized;
}

function browserId(obj: Record<string, unknown>): string {
  return nonemptyString(obj.browserId, 'browserId', 256);
}

function httpUrl(value: unknown): string {
  const raw = nonemptyString(value, 'url', 8192);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('url must be a valid http or https URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('url must use http or https');
  if (url.username || url.password) throw new Error('url must not contain credentials');
  return url.toString();
}

function selector(value: unknown): string {
  return nonemptyString(value, 'selector', 4096);
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function domKey(value: unknown): string {
  const key = nonemptyString(value, 'key', 80);
  const parts = key.split('+');
  const base = parts.pop() ?? '';
  const modifiers = new Set(['Control', 'Ctrl', 'Meta', 'Shift', 'Alt']);
  const named = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Space']);
  if (parts.length > 4 || parts.some((part) => !modifiers.has(part)) || new Set(parts).size !== parts.length
    || !(named.has(base) || /^F(?:[1-9]|1[0-2])$/.test(base) || Array.from(base).length === 1)) {
    throw new Error('key must be one DOM key or a modifier+key chord (for example Enter or Control+A)');
  }
  return key;
}

export function validateScreenshot(result: ToolResult) {
  const image = isRecord(result.data) ? result.data.computerImage : undefined;
  if (!isRecord(image) || !['image/png', 'image/jpeg', 'image/webp'].includes(String(image.mediaType))
    || typeof image.data !== 'string' || !image.data || image.data.length > 64 * 1024 * 1024
    || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
    throw new Error('Invalid background browser screenshot computerImage payload');
  }
  const path = workspaceRelativePath(image.path);
  if (!path.startsWith('.aicode/')) throw new Error('Background browser screenshots must be stored under workspace .aicode');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
