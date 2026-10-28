/**
 * guiTool.ts — headless single-action GUI control for the desktop 电脑操控
 * sidebar panel.
 *
 * The desktop panel lists windows, reads an accessibility tree and presses a
 * control without a model in the loop. Sending that through the agent would
 * mean a whole turn (prompt, provider round trip, streaming) to click one
 * button, so the panel calls one `computer_*` tool per interaction instead —
 * the same tool code the agent uses, with the same validation and the same
 * Win32/UIA implementation.
 *
 * Deliberately separate from `--invoke-tool`, which refuses anything but
 * `risk: 'read'` tools: a panel action is an explicit click by the person at
 * the keyboard, so `computer_press`/`computer_type`/`computer_click` have to be
 * reachable here. What keeps that from widening the machine's attack surface is
 * that this path adds no capability a local script does not already have — the
 * tool bodies are PowerShell + user32 calls running as the same user.
 */

import { createComputerTools } from '../tools/computer.js';
import type { ToolContext } from '../tools/types.js';

/** Every action this path accepts. Anything else is refused, not ignored. */
export const GUI_TOOL_NAMES = new Set([
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
  'computer_open',
  'computer_wait_window',
]);

export type GuiToolResult = {
  ok: boolean;
  output: string;
  data?: unknown;
  error?: string;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `--gui-input -` reads the JSON payload from stdin, like --tool-input. */
function readAllStdin(): Promise<string> {
  return new Promise((resolveInput, rejectInput) => {
    let payload = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { payload += chunk; });
    process.stdin.on('end', () => resolveInput(payload));
    process.stdin.on('error', rejectInput);
  });
}

/**
 * Run one computer_* tool and return its result for `--gui-tool` stdout.
 *
 * Every failure is a returned `{ ok: false }` rather than a throw: the caller
 * is a JSON-line protocol, and an exception escaping here would leave the
 * desktop panel waiting for output it can parse.
 */
export async function runGuiTool(
  name: string,
  rawInput: string | undefined,
  workspaceRoot: string,
): Promise<GuiToolResult> {
  if (!GUI_TOOL_NAMES.has(name)) {
    return { ok: false, output: '', error: 'Unknown GUI tool: ' + name };
  }
  const tool = createComputerTools().find((candidate) => candidate.name === name);
  if (!tool) return { ok: false, output: '', error: 'Unknown GUI tool: ' + name };

  let payload = rawInput;
  if (payload === '-') {
    try { payload = await readAllStdin(); } catch (error) {
      return { ok: false, output: '', error: 'Failed to read --gui-input from stdin: ' + errorText(error) };
    }
  }

  let input: unknown;
  try {
    input = payload && payload.trim() ? JSON.parse(payload) : {};
  } catch (error) {
    return { ok: false, output: '', error: '--gui-input is not valid JSON: ' + errorText(error) };
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, output: '', error: '--gui-input must be a JSON object' };
  }

  let validated: unknown;
  try {
    validated = tool.validate(input);
  } catch (error) {
    return { ok: false, output: '', error: errorText(error) };
  }

  // `approval: 'auto'` is what lets a press/type pass the policy layer; the
  // person clicked the control in the panel, which is the confirmation the
  // agent's approval prompt would otherwise be asking for. Destructive tools
  // (`alwaysPrompt`) are not part of this set at all.
  const context: ToolContext = {
    workspaceRoot,
    approval: 'auto',
    computerAnyApp: true,
    computerUse: true,
  };
  try {
    const result = await tool.execute(validated, context);
    return {
      ok: result.ok,
      output: result.output,
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.ok ? {} : { error: result.output }),
    };
  } catch (error) {
    return { ok: false, output: '', error: errorText(error) };
  }
}
