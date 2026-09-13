/**
 * computer.ts — real GUI computer control on Windows (screenshot, mouse,
 * keyboard, window focus) driven through PowerShell + user32 via execFile.
 *
 * Wake semantics (decided in agent.ts, not here):
 * - Full access (approval 'auto' + desktop "任意应用"): tools are always
 *   available and run without prompts — the agent self-wakes.
 * - Otherwise: the user arms them explicitly with the /computer use slash
 *   command; every input action still passes normal approval.
 *
 * Risk model: screenshot and list_windows are 'read'; every input action is
 * 'shell' so ask mode confirms each click/keystroke and deny mode refuses.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { ToolDefinition, ToolContext, ToolResult } from './types.js';

const execFileAsync = promisify(execFile);

export const COMPUTER_TOOL_NAMES = new Set([
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_list_windows',
  'computer_activate',
]);

/**
 * Pure wake decision, unit-testable: computer control is live for a turn when
 * (a) the session armed it via `/computer use`, or (b) full access
 * (approval 'auto') + desktop "任意应用" lets the agent self-wake.
 * Windows only — the tools are PowerShell/user32 based.
 */
export function computerUseShouldWake(options: {
  platform?: NodeJS.Platform;
  approval?: string;
  computerAnyApp?: boolean;
  sessionArmed?: boolean;
}): boolean {
  if ((options.platform ?? process.platform) !== 'win32') return false;
  if (options.sessionArmed === true) return true;
  return options.approval === 'auto' && options.computerAnyApp === true;
}

export type ComputerImagePayload = { mediaType: string; data: string; path: string };

export const COMPUTER_USE_STRATEGY =
  'Computer control is active. Work in an observe-act-verify loop: call computer_screenshot first to see the screen, plan exactly one action, execute it (computer_click / computer_type / computer_key / computer_scroll / computer_activate), then screenshot again to verify the effect before continuing. '
  + 'Screenshot coordinates are in the DISPLAYED image pixel space; the tool result reports the real screen size and a scale factor — multiply displayed coordinates by the factor to get real coordinates for computer_click/scroll. '
  + 'To type into an app, first make sure its window is focused (computer_activate or click its title bar). Use computer_key for shortcuts ({ENTER}, {ESC}, ^s, %{F4}). Launch apps that are not open with run_command. '
  + 'If a click misses, screenshot, recompute the coordinates, and retry once; if it still fails, report what is on screen instead of guessing repeatedly.';

const WINDOWS_ONLY = 'Computer control is only supported on Windows.';

function isWindows() {
  return process.platform === 'win32';
}

function escapePs(value: string): string {
  return value.replace(/'/g, "''");
}

function clampInt(value: unknown, min: number, max: number, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
  const int = Math.round(n);
  if (int < min || int > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return int;
}

async function runPs(script: string, timeoutMs = 30_000): Promise<string> {
  // Force UTF-8 on the pipe so Chinese window titles survive the round trip.
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`],
    { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout.trim();
}

// Shared user32 binding injected into every input script.
const INPUT_TYPE_DEF = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class YoyInput {',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);',
  '  public const uint LeftDown = 0x0002; public const uint LeftUp = 0x0004;',
  '  public const uint RightDown = 0x0008; public const uint RightUp = 0x0010;',
  '  public const uint MiddleDown = 0x0020; public const uint MiddleUp = 0x0040;',
  '  public const uint Wheel = 0x0800;',
  '}',
  '"@',
].join('\n');

function fail(message: string): ToolResult {
  return { ok: false, output: message };
}

// ── computer_screenshot ─────────────────────────────────────────────────────

type ScreenshotInput = Record<string, never>;

export const computerScreenshotTool: ToolDefinition<ScreenshotInput> = {
  name: 'computer_screenshot',
  description: 'Capture the full Windows desktop (all monitors, virtual screen) as a PNG, save it under .aicode/computer/ and return the real screen size plus a scale factor. The image itself is attached to the tool result so you can see the screen. Coordinates you read off this image must be multiplied by the scale factor before using them in computer_click/computer_scroll.',
  inputHint: '{}',
  risk: 'read',
  parallelSafe: false,

  validate(): ScreenshotInput {
    return {};
  },

  async execute(_input: ScreenshotInput, context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const dir = join(context.workspaceRoot, '.aicode', 'computer');
    await mkdir(dir, { recursive: true });
    const target = join(dir, `shot-${Date.now()}-${randomBytes(3).toString('hex')}.png`);
    const script = [
      'Add-Type -AssemblyName System.Drawing',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen',
      '$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)',
      '$g = [System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen([System.Drawing.Point]::new($vs.X, $vs.Y), [System.Drawing.Point]::new(0, 0), $vs.Size)',
      '$max = 1568',
      '$out = $bmp',
      'if ($bmp.Width -gt $max) {',
      '  $nw = $max',
      '  $nh = [int][Math]::Round($bmp.Height * ($max / $bmp.Width))',
      '  $resized = New-Object System.Drawing.Bitmap($nw, $nh)',
      '  $g2 = [System.Drawing.Graphics]::FromImage($resized)',
      '  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
      '  $g2.DrawImage($bmp, 0, 0, $nw, $nh)',
      '  $out = $resized',
      '}',
      `$out.Save('${escapePs(target)}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$outW = $out.Width; $outH = $out.Height',
      '$out.Dispose(); $bmp.Dispose()',
      'Write-Output "$($vs.Width)|$($vs.Height)|$outW|$outH"',
    ].join('\n');
    try {
      const line = await runPs(script, 45_000);
      const [realW, realH, dispW, dispH] = line.split('|').map((n) => Number(n));
      if (!realW || !realH || !dispW || !dispH) return fail(`screenshot: unexpected PowerShell output: ${line.slice(0, 200)}`);
      const png = await readFile(target);
      const scale = realW / dispW;
      const payload: ComputerImagePayload = { mediaType: 'image/png', data: png.toString('base64'), path: target };
      return {
        ok: true,
        output: `Screenshot saved to ${target}. Real screen ${realW}x${realH}, image ${dispW}x${dispH}, scale factor ${scale.toFixed(3)} (multiply image coordinates by this to get screen coordinates).`,
        data: { computerImage: payload },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_screenshot failed: ${message.slice(0, 500)}`);
    }
  },
};

// ── computer_click ──────────────────────────────────────────────────────────

type ClickInput = { x: number; y: number; button: 'left' | 'right' | 'middle'; double: boolean };

export const computerClickTool: ToolDefinition<ClickInput> = {
  name: 'computer_click',
  description: 'Move the mouse pointer to real screen coordinates and click. Get coordinates from computer_screenshot multiplied by its scale factor (or from window bounds). The action executes immediately in full-access mode.',
  inputHint: '{ "x": 1234, "y": 567, "button": "left" | "right" | "middle", "double": false }',
  risk: 'shell',

  validate(input: unknown): ClickInput {
    if (!input || typeof input !== 'object') throw new Error('computer_click input must be an object');
    const obj = input as Record<string, unknown>;
    const button = obj.button === 'right' || obj.button === 'middle' ? obj.button : 'left';
    return {
      x: clampInt(obj.x, 0, 20000, 'x'),
      y: clampInt(obj.y, 0, 20000, 'y'),
      button,
      double: obj.double === true,
    };
  },

  async execute(input: ClickInput, _context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const down = input.button === 'right' ? 'RightDown' : input.button === 'middle' ? 'MiddleDown' : 'LeftDown';
    const up = input.button === 'right' ? 'RightUp' : input.button === 'middle' ? 'MiddleUp' : 'LeftUp';
    const clickBlock =
      `[YoyInput]::mouse_event([YoyInput]::${down}, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; ` +
      `[YoyInput]::mouse_event([YoyInput]::${up}, 0, 0, 0, [UIntPtr]::Zero)`;
    const script = `${INPUT_TYPE_DEF}\n[YoyInput]::SetCursorPos(${input.x}, ${input.y}) | Out-Null; Start-Sleep -Milliseconds 60; ${clickBlock}${input.double ? `; Start-Sleep -Milliseconds 80; ${clickBlock}` : ''}; Write-Output 'ok'`;
    try {
      await runPs(script);
      return { ok: true, output: `${input.double ? 'Double ' : ''}${input.button}-click at (${input.x}, ${input.y}). Screenshot again to verify the effect.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_click failed: ${message.slice(0, 500)}`);
    }
  },
};

// ── computer_type ───────────────────────────────────────────────────────────

type TypeInput = { text: string };

function escapeSendKeys(value: string): string {
  // SendKeys treats these characters as modifiers/syntax; wrap each one.
  return value.replace(/([+^%~(){}\[\]])/g, '{$1}');
}

export const computerTypeTool: ToolDefinition<TypeInput> = {
  name: 'computer_type',
  description: 'Type literal text into the currently focused window using SendKeys. Activate the target app first (computer_activate or click its window). Use computer_key instead for single keys or shortcuts.',
  inputHint: '{ "text": "hello world" }',
  risk: 'shell',

  validate(input: unknown): TypeInput {
    if (!input || typeof input !== 'object') throw new Error('computer_type input must be an object');
    const text = (input as Record<string, unknown>).text;
    if (typeof text !== 'string' || text.length === 0) throw new Error('text is required and must be non-empty');
    if (text.length > 4000) throw new Error('text is too long (max 4000 chars)');
    return { text };
  },

  async execute(input: TypeInput, _context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      `[System.Windows.Forms.SendKeys]::SendWait('${escapePs(escapeSendKeys(input.text))}')`,
      'Write-Output "ok"',
    ].join('\n');
    try {
      await runPs(script);
      return { ok: true, output: `Typed ${input.text.length} characters into the focused window.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_type failed: ${message.slice(0, 500)}`);
    }
  },
};

// ── computer_key ────────────────────────────────────────────────────────────

type KeyInput = { keys: string };

export const computerKeyTool: ToolDefinition<KeyInput> = {
  name: 'computer_key',
  description: 'Send a key or shortcut to the focused window using SendKeys syntax: {ENTER}, {ESC}, {TAB}, {F5}, ^s (Ctrl+S), %{F4} (Alt+F4), ^+{ESC} (Ctrl+Shift+Esc). Modifiers: ^ Ctrl, % Alt, + Shift.',
  inputHint: '{ "keys": "{ENTER}" }',
  risk: 'shell',

  validate(input: unknown): KeyInput {
    if (!input || typeof input !== 'object') throw new Error('computer_key input must be an object');
    const keys = (input as Record<string, unknown>).keys;
    if (typeof keys !== 'string' || keys.length === 0) throw new Error('keys is required');
    if (keys.length > 128) throw new Error('keys is too long (max 128)');
    if (!/^[\w+^%~{}()\[\] -]{1,128}$/.test(keys)) throw new Error('keys contains unsupported characters');
    return { keys };
  },

  async execute(input: KeyInput, _context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      `[System.Windows.Forms.SendKeys]::SendWait('${escapePs(input.keys)}')`,
      'Write-Output "ok"',
    ].join('\n');
    try {
      await runPs(script);
      return { ok: true, output: `Sent keys ${input.keys} to the focused window.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_key failed: ${message.slice(0, 500)}`);
    }
  },
};

// ── computer_scroll ─────────────────────────────────────────────────────────

type ScrollInput = { x?: number; y?: number; direction: 'up' | 'down'; amount: number };

export const computerScrollTool: ToolDefinition<ScrollInput> = {
  name: 'computer_scroll',
  description: 'Scroll the mouse wheel at optional screen coordinates (uses the current pointer position when omitted). amount is wheel notches (1-20).',
  inputHint: '{ "x": 800, "y": 450, "direction": "down", "amount": 3 }',
  risk: 'shell',

  validate(input: unknown): ScrollInput {
    if (!input || typeof input !== 'object') throw new Error('computer_scroll input must be an object');
    const obj = input as Record<string, unknown>;
    const direction = obj.direction === 'up' ? 'up' : 'down';
    const amount = clampInt(obj.amount ?? 3, 1, 20, 'amount');
    const x = obj.x === undefined ? undefined : clampInt(obj.x, 0, 20000, 'x');
    const y = obj.y === undefined ? undefined : clampInt(obj.y, 0, 20000, 'y');
    if ((x === undefined) !== (y === undefined)) throw new Error('x and y must be provided together');
    return { x, y, direction, amount };
  },

  async execute(input: ScrollInput, _context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const delta = input.direction === 'up' ? 120 : -120;
    const move = input.x !== undefined && input.y !== undefined
      ? `[YoyInput]::SetCursorPos(${input.x}, ${input.y}) | Out-Null; Start-Sleep -Milliseconds 40; `
      : '';
    const script = `${INPUT_TYPE_DEF}\n${move}for ($i = 0; $i -lt ${input.amount}; $i++) { [YoyInput]::mouse_event([YoyInput]::Wheel, 0, 0, ${delta}, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }; Write-Output 'ok'`;
    try {
      await runPs(script);
      return { ok: true, output: `Scrolled ${input.direction} ${input.amount} notch(es)${input.x !== undefined ? ` at (${input.x}, ${input.y})` : ''}.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_scroll failed: ${message.slice(0, 500)}`);
    }
  },
};

// ── computer_list_windows ───────────────────────────────────────────────────

type ListWindowsInput = Record<string, never>;

export const computerListWindowsTool: ToolDefinition<ListWindowsInput> = {
  name: 'computer_list_windows',
  description: 'List visible top-level application windows with pid, process name, and title. Use before computer_activate to find the target.',
  inputHint: '{}',
  risk: 'read',

  validate(): ListWindowsInput {
    return {};
  },

  async execute(_input: ListWindowsInput, _context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const script =
      'Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "$($_.Id)|$($_.ProcessName)|$($_.MainWindowTitle)" }';
    try {
      const out = await runPs(script);
      if (!out) return { ok: true, output: '(no visible windows with titles found)' };
      const rows = out.split(/\r?\n/).filter(Boolean);
      return { ok: true, output: `${rows.length} window(s):\n${rows.join('\n')}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_list_windows failed: ${message.slice(0, 500)}`);
    }
  },
};

// ── computer_activate ───────────────────────────────────────────────────────

type ActivateInput = { target: string };

export const computerActivateTool: ToolDefinition<ActivateInput> = {
  name: 'computer_activate',
  description: 'Bring a window to the foreground and focus it, by pid (e.g. "12345") or by title substring (e.g. "记事本"). Required before computer_type/computer_key reach the intended app.',
  inputHint: '{ "target": "12345" }  // pid or title substring',
  risk: 'shell',

  validate(input: unknown): ActivateInput {
    if (!input || typeof input !== 'object') throw new Error('computer_activate input must be an object');
    const target = (input as Record<string, unknown>).target;
    if (typeof target !== 'string' || !target.trim()) throw new Error('target is required (pid or title substring)');
    if (target.length > 200) throw new Error('target is too long');
    return { target: target.trim() };
  },

  async execute(input: ActivateInput, _context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const isPid = /^\d+$/.test(input.target);
    const arg = isPid ? `[int]${input.target}` : `'${escapePs(input.target)}'`;
    const script = `$ok = (New-Object -ComObject WScript.Shell).AppActivate(${arg}); if ($ok) { Write-Output 'activated' } else { Write-Output 'not-found' }`;
    try {
      const out = await runPs(script);
      if (out === 'activated') {
        return { ok: true, output: `Activated window ${input.target}. It is now focused.` };
      }
      return fail(`computer_activate: no window matched "${input.target}". Run computer_list_windows to see candidates.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_activate failed: ${message.slice(0, 500)}`);
    }
  },
};

export function createComputerTools(): ToolDefinition[] {
  return [
    computerScreenshotTool,
    computerClickTool,
    computerTypeTool,
    computerKeyTool,
    computerScrollTool,
    computerListWindowsTool,
    computerActivateTool,
  ];
}
