import type { HostToolInvoker } from '../cli/hostToolBroker.js';
import { validateHostToolResult } from '../cli/hostToolBroker.js';
import type { ToolDefinition, ToolResult } from './types.js';

export const BACKGROUND_NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set(['background_native_window_screenshot']);

export const BACKGROUND_NATIVE_STRATEGY = 'For a native Windows application that is not an Electron project, use background_native_window_screenshot with a window title substring or PID. '
  + 'It uses the existing offscreen PrintWindow path and never activates, clicks, types, or moves the user\'s foreground window. A minimized capture is readable but not actionable. '
  + 'The result is a real PNG image for model vision. If Windows or the application refuses an offscreen surface, report that honestly and use the accessibility tree or ask the user to bring it forward; never fall back to a desktop screenshot.';

export function createBackgroundNativeTools(invoke: HostToolInvoker): ToolDefinition[] {
  const screenshot: ToolDefinition<{ window: string }> = {
    name: 'background_native_window_screenshot',
    description: 'Capture a real native Windows application window without activating it or changing the user\'s foreground desktop. Uses a title substring or PID, supports minimized offscreen capture when the app exposes a printable surface, and returns computerImage for model vision. Read-only; no click, typing, activation, or coordinate action is available in background mode.',
    inputHint: '{ "window": "Notepad" } or { "window": "12345" }',
    inputSchema: { type: 'object', properties: { window: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['window'], additionalProperties: false },
    risk: 'read',
    parallelSafe: false,
    validate(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Background native screenshot input must be an object');
      const record = input as Record<string, unknown>;
      if (Object.keys(record).some(key => key !== 'window')) throw new Error('Unknown background native screenshot field');
      if (typeof record.window !== 'string' || !record.window.trim() || record.window.length > 200) throw new Error('window must be a nonempty title substring or PID');
      return { window: record.window.trim() };
    },
    async execute(input, context): Promise<ToolResult> {
      const result = validateHostToolResult(await invoke(screenshot.name, input));
      if (result.ok) {
        const image = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? (result.data as Record<string, unknown>).computerImage : undefined;
        if (!image || typeof image !== 'object' || Array.isArray(image) || (image as Record<string, unknown>).mediaType !== 'image/png' || typeof (image as Record<string, unknown>).data !== 'string' || !(image as Record<string, unknown>).data) throw new Error('Invalid native background screenshot payload');
      }
      return result;
    },
  };
  return [screenshot];
}
