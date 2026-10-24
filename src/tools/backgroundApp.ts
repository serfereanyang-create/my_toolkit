import { isAbsolute, win32, posix } from 'node:path';
import type { HostToolInvoker } from '../cli/hostToolBroker.js';
import { validateHostToolResult } from '../cli/hostToolBroker.js';
import { resolveWorkspacePath } from '../safety/policy.js';
import { validateScreenshot } from './backgroundBrowser.js';
import type { ToolDefinition } from './types.js';

export const BACKGROUND_APP_TOOL_NAMES: ReadonlySet<string> = new Set(
  ['open', 'windows', 'inspect', 'click', 'fill', 'type', 'key', 'screenshot', 'close'].map(operation => `background_app_${operation}`),
);

export const BACKGROUND_APP_STRATEGY = 'For a local Electron project with a CommonJS or ESM main entry, use background_app_open with its workspace-relative project directory (path "." for the workspace root). '
  + 'This runs the real main/preload/renderer and IPC in a separate process, with hidden offscreen windows and a separate user-data directory; it does not open or focus the user desktop. '
  + 'Build the application first if its main requires built files. Use the returned appId and optional windowId with background_app_inspect, click, fill, key or screenshot. Use background_app_windows to refresh the window list after a splash closes or a new window opens; choose an existing windowId explicitly. A stale windowId fails instead of switching to another window. '
  + 'When multiple windows exist, click/fill/type/key require an explicit windowId; the host refuses an ambiguous write action. '
  + 'Screenshots are real rendered PNG images and are supplied to model vision. Verify after actions and close the app when finished. '
  + 'Click by selector or by x/y pixels in the full-resolution screenshot, including Canvas interfaces. Use background_app_type for real Unicode text entry and background_app_key for renderer shortcuts such as Control+A, Tab and Enter. These actions stay inside the hidden renderer; they do not move the system mouse. '
  + 'This executes trusted workspace project code and is not a security sandbox. Native executables and native dialogs are unsupported; do not launch a foreground app as a fallback.';

export function createBackgroundAppTools(invoke: HostToolInvoker): ToolDefinition[] {
  return [...BACKGROUND_APP_TOOL_NAMES].map(name => {
    const operation = name.slice('background_app_'.length);
    const open = operation === 'open';
    const allowed = open ? ['path', 'width', 'height'] : ['appId', ...(['close', 'windows'].includes(operation) ? [] : ['windowId']), ...(operation === 'click' ? ['selector', 'x', 'y', 'button', 'double'] : []), ...(operation === 'fill' ? ['selector', 'value'] : []), ...(operation === 'type' ? ['selector', 'text'] : []), ...(operation === 'key' ? ['key', 'selector'] : [])];
    const hint = open ? '{ "path": ".", "width": 1280, "height": 800 }' : operation === 'click' ? '{ "appId": "app-id", "x": 120, "y": 80 } or an object with selector; optional button/double and windowId; exactly one selector or coordinate pair' : operation === 'fill' ? '{ "appId": "app-id", "selector": "#name", "value": "hello" }' : operation === 'type' ? '{ "appId": "app-id", "text": "你好" } with optional selector/windowId' : operation === 'key' ? '{ "appId": "app-id", "key": "Control+A" } with optional selector/windowId' : '{ "appId": "app-id" }';
    return {
      name,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(allowed.map(field => [field,
          ['width', 'height'].includes(field) ? { type: 'integer', minimum: 100, maximum: 4096 }
            : field === 'windowId' ? { type: 'integer', minimum: 1 }
              : ['x', 'y'].includes(field) ? { type: 'number', minimum: 0, maximum: 16384 }
                : field === 'double' ? { type: 'boolean' }
                  : field === 'button' ? { type: 'string', enum: ['left', 'middle', 'right'] }
              : { type: 'string' },
        ])),
        required: open ? ['path'] : ['appId', ...(operation === 'fill' ? ['selector', 'value'] : []), ...(operation === 'type' ? ['text'] : []), ...(operation === 'key' ? ['key'] : [])],
        ...(operation === 'click' ? { oneOf: [{ required: ['selector'] }, { required: ['x', 'y'] }] } : {}),
        additionalProperties: false,
      },
      description: open ? 'Run a trusted workspace Electron project with a CommonJS or ESM main entry in a separate background process without displaying/focusing windows. Executes actual application code with real preload/IPC and isolated userData. Requires built JavaScript main entry. Not a security sandbox or a launcher for arbitrary native apps.' : `Perform ${operation} on this conversation's hidden Electron app. Optional windowId selects a window returned by inspect. Screenshot returns real PNG computerImage for model vision; inspect returns DOM text/elements and window visibility. Does not control foreground windows.`,
      inputHint: hint,
      risk: open ? 'shell' : ['windows', 'inspect', 'screenshot'].includes(operation) ? 'read' : 'write',
      autoApprove: true,
      parallelSafe: false,
      validate(input: unknown) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Background app input must be an object');
        const record = input as Record<string, unknown>;
        if (Object.keys(record).some(key => !allowed.includes(key))) throw new Error('Unknown background app input field');
        if (open) {
          if (typeof record.path !== 'string' || !record.path || record.path.length > 2048 || /[\u0000-\u001f]/u.test(record.path) || isAbsolute(record.path) || win32.isAbsolute(record.path) || record.path.includes(':') || posix.normalize(record.path.replaceAll('\\', '/')).split('/').includes('..')) throw new Error('path must be a workspace-relative project directory');
          for (const key of ['width', 'height']) if (record[key] !== undefined && (!Number.isInteger(record[key]) || Number(record[key]) < 100 || Number(record[key]) > 4096)) throw new Error('Invalid viewport size');
        } else {
          if (typeof record.appId !== 'string' || !/^[a-f0-9-]{36}$/.test(record.appId)) throw new Error('Invalid appId');
          if (record.windowId !== undefined && (!Number.isSafeInteger(record.windowId) || Number(record.windowId) < 1)) throw new Error('Invalid windowId');
        }
        for (const key of ['selector', 'key']) if (record[key] !== undefined && (typeof record[key] !== 'string' || !record[key] || record[key].length > 2048)) throw new Error(`Invalid ${key}`);
        if (operation === 'click') {
          const selector = Object.hasOwn(record, 'selector');
          const coordinates = Object.hasOwn(record, 'x') || Object.hasOwn(record, 'y');
          if (selector === coordinates) throw new Error('Exactly one selector or x/y coordinate pair is required');
          if (coordinates && (!Number.isFinite(record.x) || !Number.isFinite(record.y) || Number(record.x) < 0 || Number(record.y) < 0 || Number(record.x) > 16384 || Number(record.y) > 16384)) throw new Error('Invalid screenshot coordinates');
          if (record.button !== undefined && (typeof record.button !== 'string' || !['left', 'middle', 'right'].includes(record.button))) throw new Error('Invalid mouse button');
          if (record.double !== undefined && typeof record.double !== 'boolean') throw new Error('Invalid double flag');
        }
        if (operation === 'fill' && typeof record.selector !== 'string') throw new Error('selector is required');
        if (operation === 'fill' && (typeof record.value !== 'string' || record.value.length > 100_000)) throw new Error('Invalid value');
        if (operation === 'key') validateKeyChord(record.key);
        if (operation === 'type' && (typeof record.text !== 'string' || !record.text || record.text.length > 100_000)) throw new Error('text must contain 1–100000 characters');
        return record;
      },
      async execute(input: Record<string, unknown>, context) {
        if (open) resolveWorkspacePath(context.workspaceRoot, String(input.path));
        const result = validateHostToolResult(await invoke(name, input));
        if (result.ok && operation === 'screenshot') validateScreenshot(result);
        return result;
      },
    } satisfies ToolDefinition<Record<string, unknown>>;
  });
}

function validateKeyChord(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error('Invalid key chord');
  const parts = value.split('+');
  const base = parts.pop() ?? '';
  const aliases: Record<string, string> = { Control: 'Control', Ctrl: 'Control', Meta: 'Meta', Command: 'Meta', Cmd: 'Meta', Shift: 'Shift', Alt: 'Alt' };
  const seen = new Set<string>();
  for (const part of parts) {
    const modifier = Object.hasOwn(aliases, part) ? aliases[part] : undefined;
    if (!modifier || seen.has(modifier)) throw new Error('Invalid or repeated key modifier');
    seen.add(modifier);
  }
  if (!/^(?:[A-Za-z0-9]|F(?:[1-9]|1[0-2])|Enter|Tab|Escape|Backspace|Delete|Insert|ArrowLeft|ArrowUp|ArrowRight|ArrowDown|Home|End|PageUp|PageDown|Space)$/.test(base)) throw new Error('Unsupported key; use background_app_type for text');
}
