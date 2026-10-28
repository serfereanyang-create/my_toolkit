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
import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { ToolDefinition, ToolContext, ToolResult } from './types.js';
import {
  describeDrift,
  loadCapture,
  newCaptureId,
  saveCapture,
  toScreenPoint,
  type CaptureRecord,
} from './computerCapture.js';

const execFileAsync = promisify(execFile);

export const COMPUTER_TOOL_NAMES = new Set([
  'computer_elements',
  'computer_press',
  'computer_screenshot',
  'computer_window_shot',
  'computer_click',
  'computer_drag',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_list_windows',
  'computer_activate',
  'computer_open',
  'computer_close',
  'computer_wait_window',
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
  'Computer control is active. Work in an observe-act-verify loop: look at the app, plan exactly one action, execute it (computer_click / computer_type / computer_key / computer_scroll / computer_press / computer_drag), then look again to verify the effect before continuing. '
  // The default observation is the window, not the monitor. A desktop grab
  // always returns whatever the person is currently looking at, so "check the
  // status bar" turned into "send me their screen"; a window capture is the
  // app being worked on and disturbs nothing.
  + 'To see a specific app use computer_window_shot — it returns that window\'s own pixels even while it is behind other windows or minimized, and never activates anything. A minimized window is restored offscreen for the length of the capture and put straight back, so the user\'s screen never changes; such a capture is for READING only, because a minimized window has no on-screen position to click. Not every app allows this: one that clamps its position back on screen is refused rather than shown to the user, and the error says so — fall back to computer_elements for it. Use computer_screenshot only when the whole desktop is genuinely what you need (finding which apps are open, or a point outside any window). '
  + 'To start a native Windows application, use computer_open with a workspace-relative or allowed absolute .exe/.lnk path, then computer_wait_window with the returned PID before computer_list_windows and computer_window_shot to verify it. Use computer_close only after the user confirms closing that window. computer_open accepts no command-line arguments; paths outside the workspace require the 任意应用 setting and still follow shell approval. '  + 'Prefer the accessibility tree over pixels: computer_elements lists named/interactive controls with an index each; click them by index with computer_press instead of guessing coordinates when the target has a name (buttons, menus, title bars). Re-run computer_elements after the UI changes — indices only cover the latest snapshot. '
  // Codex's coordinate model, and the reason it exists: an absolute screen
  // point stops meaning anything the moment the window moves, while an image
  // pixel plus the id of the capture it was read from stays verifiable.
  + 'For anything the tree does not name (canvas, map, image, a point you can only see), use the capture-relative form instead of screen coordinates: computer_window_shot returns a screenshotId, then pass {"window", "screenshotId", "x", "y"} to computer_click / computer_scroll / computer_drag with x,y in the pixels of THAT image. Do not do scale-factor or window-position arithmetic yourself — the tool converts, and it refuses with the new geometry if the window moved instead of clicking the wrong place. Coordinates without a screenshotId are absolute screen coordinates and are only right for a point read off computer_screenshot. '
  + 'A capture-relative click also refuses when another window covers the point, and says which one: clicking through would have hit the user\'s app, and bringing the target forward is their decision. '
  // Drag is the only way to move a slider, a scrollbar thumb, a splitter or a
  // selection — none of them is a control you can press. It is also the most
  // destructive pointer action, so it takes the same id and checks both ends.
  + 'Use computer_drag for anything that must be moved rather than pressed — sliders, scrollbar thumbs, splitters, canvas panning, text selection: {"screenshotId", "fromX", "fromY", "toX", "toY"} in image pixels. It refuses a drag whose endpoints are covered by another window, because pressing on someone else\'s window there would grab it. '
  + 'To type into an app, first make sure its window is focused (computer_activate or click its title bar). Use computer_key for shortcuts ({ENTER}, {ESC}, ^s, %{F4}). Launch apps that are not open with run_command. '
  // The user's own rule, and a real constraining fact about the tools: reading
  // a window never moves focus, and activation takes the user out of whatever
  // they were doing (a game, a call, a video). So acting on the machine is a
  // last resort for "this app has no other interface", not the default route.
  + 'NEVER take over the desktop without cause: prefer the app\'s own CLI, API, config file, or a hidden background window; only drive real windows when the task truly needs a GUI, and never activate a window merely to observe it. When focus moves, tell the user. '
  + 'If a click misses, capture the window again and use the new id; if it still fails, report what you saw instead of guessing repeatedly.';

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

/**
 * Runs first in every script: make this PowerShell process DPI aware.
 *
 * Measured on a 150% display: without it, `GetWindowRect` and the UIA bounding
 * rectangles disagree with the pixels on screen (1721×1033 logical vs
 * 2562×1530 physical for the very same window), so a coordinate read off a
 * capture landed somewhere else entirely and every click appeared to miss.
 * SetProcessDPIAware must be the first call before any window is touched,
 * which is why it is prepended rather than added to each tool's script.
 */
const DPI_AWARE = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class YoyDpi {',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '}',
  '"@',
  '[YoyDpi]::SetProcessDPIAware() | Out-Null',
].join('\n');

async function runPs(script: string, timeoutMs = 30_000): Promise<string> {
  // Force UTF-8 on the pipe so Chinese window titles survive the round trip.
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8\n${DPI_AWARE}\n${script}`],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout.trim();
  } catch (error) {
    // execFile's own message is just the command line. Without stderr a caller
    // sees "Command failed: powershell.exe -NoProfile …" and learns nothing —
    // an Add-Type compile error or a property typo is indistinguishable from a
    // crash. Surface the parser/compiler text, which is what actually says
    // what to fix.
    const e = error as { stderr?: string | Buffer; stdout?: string | Buffer; code?: number | string; killed?: boolean; signal?: string; message?: string };
    if (e.killed || e.signal) throw new Error(`PowerShell timed out after ${timeoutMs}ms`);
    const stderr = String(e.stderr ?? '').trim();
    const stdout = String(e.stdout ?? '').trim();
    const detail = stderr || stdout || e.message || 'no output';
    throw new Error(`PowerShell failed (exit ${e.code ?? '?'}): ${detail.slice(0, 4000)}`);
  }
}

// Shared user32 binding injected into every input script.
const INPUT_TYPE_DEF = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class YoyInput {',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);',
  '  public const uint LeftDown = 0x0002; public const uint LeftUp = 0x0004;',
  '  public const uint RightDown = 0x0008; public const uint RightUp = 0x0010;',
  '  public const uint MiddleDown = 0x0020; public const uint MiddleUp = 0x0040;',
  '  public const uint Wheel = 0x0800;',
  '  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {',
  '    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;',
  '  }',
  '  [StructLayout(LayoutKind.Explicit, Size = 40)] public struct INPUT {',
  '    [FieldOffset(0)] public uint type;',
  '    [FieldOffset(8)] public KEYBDINPUT ki;',
  '  }',
  '  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);',
  '  public const uint INPUT_KEYBOARD = 1;',
  '  public const uint KEYEVENTF_UNICODE = 0x0004;',
  '  public const uint KEYEVENTF_KEYUP = 0x0002;',
  '  // Type literal text as Unicode key events. SendKeys is unusable here: it',
  '  // drops spaces under some IME/control combinations and cannot send',
  '  // non-ASCII at all, so a prompt like "GUI control works" arrived as',
  '  // "GUIcontrolworks" and Chinese arrived as nothing.',
  '  public static int TypeText(string s) {',
  '    for (int i = 0; i < s.Length; i++) {',
  '      char ch = s[i];',
  '      // CRLF (and a lone \\n) are one Enter press, not a stray \\n glyph:',
  '      // collapsing the pair here keeps callers from having to normalise.',
  '      if (ch == \'\\r\' || ch == \'\\n\') {',
  '        if (ch == \'\\r\' && i + 1 < s.Length && s[i + 1] == \'\\n\') i++;',
  '        byte vkReturn = 0x0D;',
  '        INPUT[] rd = new INPUT[1];',
  '        rd[0].type = INPUT_KEYBOARD; rd[0].ki.wVk = vkReturn; rd[0].ki.wScan = 0; rd[0].ki.dwFlags = 0;',
  '        INPUT[] ru = new INPUT[1];',
  '        ru[0].type = INPUT_KEYBOARD; ru[0].ki.wVk = vkReturn; ru[0].ki.wScan = 0; ru[0].ki.dwFlags = KEYEVENTF_KEYUP;',
  '        SendInput(1, rd, Marshal.SizeOf(typeof(INPUT)));',
  '        SendInput(1, ru, Marshal.SizeOf(typeof(INPUT)));',
  '        System.Threading.Thread.Sleep(4);',
  '        continue;',
  '      }',
  '      ushort code = (ushort)ch;',
  '      INPUT[] down = new INPUT[1];',
  '      down[0].type = INPUT_KEYBOARD;',
  '      down[0].ki.wVk = 0; down[0].ki.wScan = code; down[0].ki.dwFlags = KEYEVENTF_UNICODE;',
  '      INPUT[] up = new INPUT[1];',
  '      up[0].type = INPUT_KEYBOARD;',
  '      up[0].ki.wVk = 0; up[0].ki.wScan = code; up[0].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;',
  '      SendInput(1, down, Marshal.SizeOf(typeof(INPUT)));',
  '      SendInput(1, up, Marshal.SizeOf(typeof(INPUT)));',
  '      System.Threading.Thread.Sleep(2);',
  '    }',
  '    return s.Length;',
  '  }',
  '}',
  '"@',
].join('\n');

function fail(message: string): ToolResult {
  return { ok: false, output: message };
}

// ── accessibility tree (UIA) shared script parts ───────────────────────────

/**
 * PowerShell preamble defining two reusable functions over System.Windows
 * Automation (UIAutomationClient, ships with .NET Framework — no native deps):
 *  YoyFindWindow <pid|0> <titleSubstring>  -> root AutomationElement or $null
 *  YoyWalk <element>                        -> DFS list of interesting controls
 * "Interesting" = has a Name or exposes Invoke/Toggle/ExpandCollapse/Value.
 * The walk is deterministic depth-first in ControlView order, so a later pass
 * over the same unchanged tree reproduces the exact same indexes.
 */
const UIA_TYPE_DEF = [
  'Add-Type -AssemblyName UIAutomationClient',
  'Add-Type -AssemblyName UIAutomationTypes',
  '$script:AE = [System.Windows.Automation.AutomationElement]',
  '$script:TW = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
  'function YoyHasPattern($el, $pattern) { try { $null = $el.GetCurrentPattern($pattern); return $true } catch { return $false } }',
  'function YoyInteresting($el) {',
  '  if ($el.Current.Name) { return $true }',
  '  if (YoyHasPattern $el ([System.Windows.Automation.InvokePattern]::Pattern)) { return $true }',
  '  if (YoyHasPattern $el ([System.Windows.Automation.TogglePattern]::Pattern)) { return $true }',
  '  if (YoyHasPattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)) { return $true }',
  '  return $false',
  '}',
  'function YoyWalk($root) {',
  '  # Deterministic DFS over ControlView in FIRST-TO-LAST sibling order, so',
  '  # the same unchanged tree reproduces the exact same index list. Stack',
  '  # pops are LIFO: push siblings REVERSED so they come out in order.',
  '  $out = New-Object System.Collections.ArrayList',
  '  $stack = New-Object System.Collections.Stack',
  '  $kids = @()',
  '  $c = $script:TW.GetFirstChild($root)',
  '  while ($c) { $kids += $c; $c = $script:TW.GetNextSibling($c) }',
  '  [array]::Reverse($kids)',
  '  foreach ($k in $kids) { $stack.Push($k) }',
  '  while ($stack.Count -gt 0) {',
  '    $el = $stack.Pop()',
  '    $kids = @()',
  '    $c = $script:TW.GetFirstChild($el)',
  '    while ($c) { $kids += $c; $c = $script:TW.GetNextSibling($c) }',
  '    [array]::Reverse($kids)',
  '    foreach ($k in $kids) { $stack.Push($k) }',
  '    if (YoyInteresting $el) { $null = $out.Add($el) }',
  '  }',
  '  return ,$out',
  '}',
].join('\n');

// ── window enumeration (Win32) shared script parts ─────────────────────────
//
// UIA's own root-children list is not a window list. A window that DWM has
// cloaked — every packaged app (设置, 计算器, 输入体验, Nahimic…) is cloaked
// until it is activated — is absent from `RootElement.FindAll(Children)`, so
// the old `YoyFindWindow` reported "no visible window matched" for apps that
// are plainly on screen. Measured on this machine: 设置, Nahimic and
// TextInputHost were enumerable by EnumWindows but invisible to UIA; after
// ShowWindow + SetForegroundWindow the 设置 frame exposed 142 descendants
// where it had exposed 0.
//
// So resolution goes through EnumWindows, and a matched window that is
// cloaked, minimized or zero-sized is brought forward once before its UIA
// element is read. That activation is also what makes the window usable for
// the input tools afterwards.
const WINDOW_TYPE_DEF = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Text;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'public static class YoyWin {',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
  '  // kernel32, NOT user32: declaring this one in user32 compiles fine and then',
  '  // throws EntryPointNotFoundException on the first call inside Activate,',
  '  // which made every activation fail silently while looking like "Windows',
  '  // refused the foreground switch".',
  '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
  '  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {',
  '    public int length, flags, showCmd; public POINT ptMinPosition, ptMaxPosition; public RECT rcNormalPosition;',
  '  }',
  '  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);',
  '  // Bounds as (x, y, w, h). A minimized window has no meaningful rect —',
  '  // Windows parks it at -21333,-21333 sized 158x26 — so its RESTORED',
  '  // placement is used instead. Filtering those out used to hide every',
  '  // minimized app from the window list entirely, which is how "组织一下我的',
  '  // 桌面" found nothing to work with even though the apps were open.',
  '  public static string Rect(IntPtr h) {',
  '    RECT r; GetWindowRect(h, out r);',
  '    if (IsIconic(h)) {',
  '      var p = new WINDOWPLACEMENT(); p.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));',
  '      if (GetWindowPlacement(h, ref p)) r = p.rcNormalPosition;',
  '    }',
  '    return String.Format("{0}|{1}|{2}|{3}", r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);',
  '  }',
  '  // The desktop bounds of the virtual screen, so the panel can place each',
  '  // window inside one coordinate system instead of assuming (0,0) is the',
  '  // top-left: a secondary monitor above or left of the primary has negative',
  '  // coordinates, and those windows would otherwise land off the map.',
  '  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);',
  '  public static string Screen() {',
  '    // SM_XVIRTUALSCREEN=76, SM_YVIRTUALSCREEN=77, SM_CXVIRTUALSCREEN=78, SM_CYVIRTUALSCREEN=79',
  '    return String.Format("{0}|{1}|{2}|{3}", GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79));',
  '  }',
  '  public static List<string> Windows() {',
  '    var o = new List<string>();',
  '    EnumWindows((h, l) => {',
  '      if (!IsWindowVisible(h)) return true;',
  '      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);',
  '      if (sb.Length == 0) return true;',
  '      var cb = new StringBuilder(256); GetClassName(h, cb, 256);',
  '      uint pid; GetWindowThreadProcessId(h, out pid);',
  '      // A packaged app lives in a CoreWindow child of an ApplicationFrameWindow',
  '      // owned by ApplicationFrameHost. Get-Process reports the frame host, so',
  '      // the app\'s real pid has to come from that child.',
  '      int real = 0;',
  '      if (cb.ToString() == "ApplicationFrameWindow") {',
  '        IntPtr child = GetWindow(h, 5); // GW_CHILD',
  '        while (child != IntPtr.Zero) {',
  '          var cc = new StringBuilder(256); GetClassName(child, cc, 256);',
  '          if (cc.ToString() == "Windows.UI.Core.CoreWindow") {',
  '            uint cp; GetWindowThreadProcessId(child, out cp); real = (int)cp; break;',
  '          }',
  '          child = GetWindow(child, 2); // GW_HWNDNEXT',
  '        }',
  '      }',
  '      int cloaked = 0;',
  '      try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }',
  '      // Left|Top|Right|Bottom come from Rect(), which substitutes the',
  '      // restored placement while minimized — GetWindowRect would report',
  '      // -21333,-21333 / 158x26 for those and every consumer would rather',
  '      // not know. Title goes LAST so a "|" inside it is swallowed by the',
  '      // final field instead of shifting a number.',
  '      var rect = Rect(h).Split(\'|\');',
  '      int rx = int.Parse(rect[0]), ry = int.Parse(rect[1]);',
  '      int rw = int.Parse(rect[2]), rh = int.Parse(rect[3]);',
  '      o.Add(String.Format("{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}|{8}|{9}|{10}|{11}|{12}", h.ToInt64(), pid, real,',
  '        cloaked, IsIconic(h) ? 1 : 0, rw, rh, cb,',
  '        rx, ry, rx + rw, ry + rh, sb));',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return o;',
  '  }',
  '  // Bring a window forward, but ONLY when a caller explicitly asked to',
  '  // activate it. Two rules this deliberately follows:',
  '  //  1. No keybd_event pulse and no SwitchToThisWindow. Both work by injecting',
  '  //     input / task-switching into whatever the user is doing (measured: they',
  '  //     yanked focus away from a fullscreen game). Reading a window must never',
  '  //     move the user\'s focus, and activating must not simulate their keyboard.',
  '  //  2. Report the truth. SetForegroundWindow is refused by Windows\'',
  '  //     foreground lock in plenty of cases; the caller verifies with',
  '  //     Foreground() and says so instead of claiming success.',
  '  public static bool Activate(IntPtr h) {',
  '    // SW_RESTORE only for a minimized window — that is what "bring it back"',
  '    // means, and it cannot un-minimize something the user is looking at.',
  '    if (IsIconic(h)) ShowWindow(h, 9);',
  '    IntPtr fg = GetForegroundWindow();',
  '    if (fg == h) return true;',
  '    // Attaching to the foreground thread makes this thread part of the same',
  '    // input queue, which is the one documented way to pass the lock. It is',
  '    // still a focus change — acceptable because it only runs on an explicit',
  '    // activation, never as a side effect of reading.',  '    uint fgPid; uint fgThread = GetWindowThreadProcessId(fg, out fgPid);',
  '    uint me = GetCurrentThreadId();',
  '    bool attached = fgThread != 0 && AttachThreadInput(me, fgThread, true);',
  '    BringWindowToTop(h);',
  '    SetForegroundWindow(h);',
  '    if (attached) AttachThreadInput(me, fgThread, false);',
  '    return GetForegroundWindow() == h;',
  '  }',
  '  // Which window owns a screen point. A window-relative click is only correct',
  '  // if the computed screen point is still over that window: mouse_event is',
  '  // injected into whatever is under the cursor, so clicking through an',
  '  // occluding window would hit the user\'s browser instead of the app. Rather',
  '  // than activate the target (which would steal focus), the caller is told',
  '  // what is actually on top and can decide.',
  '  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);',
  '  public static string OwnsPoint(IntPtr target, int x, int y) {',
  '    POINT p; p.X = x; p.Y = y;',
  '    IntPtr hit = GetAncestor(WindowFromPoint(p), 2); // GA_ROOT',
  '    if (hit == target) return "ok";',
  '    if (hit == IntPtr.Zero) return "none";',
  '    var sb = new StringBuilder(256); GetWindowText(hit, sb, 256);',
  '    var cb = new StringBuilder(256); GetClassName(hit, cb, 256);',
  '    uint pid; GetWindowThreadProcessId(hit, out pid);',
  '    return "other|" + cb + "|" + pid + "|" + sb;',
  '  }',
  '  // Who actually holds the foreground, in the same pipe format as Windows(),',
  '  // so a caller can verify an activation instead of trusting it. WScript.Shell',
  '  // AppActivate returns $true while the window stays behind (measured: it',
  '  // reported success with a game still focused), which made computer_activate',
  '  // claim a focus it never took.',
  '  public static string Foreground() {',
  '    IntPtr h = GetForegroundWindow();',
  '    var sb = new StringBuilder(512); GetWindowText(h, sb, 512);',
  '    var cb = new StringBuilder(256); GetClassName(h, cb, 256);',
  '    uint pid; GetWindowThreadProcessId(h, out pid);',
  '    int real = 0;',
  '    if (cb.ToString() == "ApplicationFrameWindow") {',
  '      IntPtr child = GetWindow(h, 5);',
  '      while (child != IntPtr.Zero) {',
  '        var cc = new StringBuilder(256); GetClassName(child, cc, 256);',
  '        if (cc.ToString() == "Windows.UI.Core.CoreWindow") {',
  '          uint cp; GetWindowThreadProcessId(child, out cp); real = (int)cp; break;',
  '        }',
  '        child = GetWindow(child, 2);',
  '      }',
  '    }',
  '    return String.Format("{0}|{1}|{2}|{3}", pid, real, cb, sb);',
  '  }',
  '}',
  '"@',
].join('\n');

/**
 * Resolve a pid or title substring to a live window and hand back its UIA
 * element. `$f`: hwnd, pid, realPid, cloaked, iconic, width, height, class,
 * left, top, right, bottom, title — the title is the *last* field precisely so
 * a `|` inside it (every browser tab title, many app titles) is absorbed by the
 * final split segment instead of shifting every column after it.
 */
const WINDOW_RESOLVER = [
  'function YoyWindows() {',
  '  foreach ($row in [YoyWin]::Windows()) {',
  '    $f = $row -split "\\|", 13',
  '    [pscustomobject]@{',
  '      Hwnd = [long]$f[0]; Pid = [int]$f[1]; AppPid = [int]$f[2]; Cloaked = [int]$f[3];',
  '      Iconic = [int]$f[4]; Width = [int]$f[5]; Height = [int]$f[6];',
  '      Class = $f[7];',
  '      Left = [int]$f[8]; Top = [int]$f[9]; Right = [int]$f[10]; Bottom = [int]$f[11];',
  '      Title = $f[12]',
  '    }',
  '  }',
  '}',
  'function YoyMatch($w, $pid_, $title) {',
  '  if ($pid_ -gt 0 -and $w.Pid -ne $pid_ -and $w.AppPid -ne $pid_) { return $false }',
  '  if ($title -ne "" -and $w.Title -notlike "*$title*") { return $false }',
  '  return $true',
  '}',
  'function YoyScore($w, $title) {',
  '  # Which of several matching windows is the app itself. EnumWindows is in',
  '  # Z-order, so taking the FIRST match is wrong the moment a menu opens: the',
  '  # popup sits on top, matches the pid, and the UIA tree read back was',
  '  # "主机弹出窗口" (26 elements) instead of Notepad (200+). An exact title',
  '  # match beats a substring, and a plain child of the desktop loses to',
  '  # anything with an ApplicationFrameWindow / normal app class.',
  '  $score = 0',
  '  if ($title -ne "" -and $w.Title -eq $title) { $score += 100 }',
  '  if ($w.Cloaked -eq 0) { $score += 10 }',
  '  if ($w.Iconic -eq 0) { $score += 10 }',
  '  # Menus, tooltips and IME composition windows all share these classes.',
  '  if ($w.Class -notmatch "^(#32768|tooltips_class32|Windows.UI.Core.CoreWindow|ApplicationFrameWindow|Progman|Shell_TrayWnd|WorkerW)$") { $score += 20 }',
  '  if ($w.Class -eq "ApplicationFrameWindow") { $score += 15 }',
  '  if ($w.Class -eq "Windows.UI.Core.CoreWindow") { $score -= 5 }',
  '  if ($w.Width -ge 200 -and $w.Height -ge 200) { $score += 5 }',
  '  return $score',
  '}',
  'function YoyElementAt($w) {',
  '  # READ ONLY. This used to bring a cloaked or minimized window forward first,',
  '  # which meant "look at this app" stole the user\'s focus and, for a game or a',
  '  # fullscreen video, interrupted what they were doing. Reading a window is an',
  '  # observation; activation is a separate, explicit request (computer_activate).',
  '  # A window that is still not activated simply exposes little or no tree, and',
  '  # the caller is told to activate it.',
  '  try { return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$w.Hwnd) } catch { return $null }',
  '}',
  'function YoyBest($windows, $pid_, $title) {',
  '  # Same ranking as uiaWindowLocator, without building a UIA element: the',
  '  # window capture path works from an HWND and must not touch UIA at all.',
  '  $best = $null; $bestScore = -2147483648',
  '  foreach ($w in $windows) {',
  '    if (-not (YoyMatch $w $pid_ $title)) { continue }',
  '    $s = YoyScore $w $title',
  '    if ($s -le $bestScore) { continue }',
  '    $best = $w; $bestScore = $s',
  '  }',
  '  return $best',
  '}',
].join('\n');

function uiaWindowLocator(target: string): string {
  const isPid = /^\d+$/.test(target);
  const pid = isPid ? target : '0';
  const title = isPid ? '' : escapePs(target);
  return [
    `$win = $null`,
    // PowerShell functions take space-separated arguments, never a C-style
    // call: `YoyWindows()` parses as a call *to* YoyWindows *at* an empty
    // expression list and dies with "Expected expression after ')'". The @()
    // keeps a single-window result an array so foreach does not unwind it.
    //
    // Best-scoring match wins, not first: see YoyScore — a menu popup is on top
    // of the app and would otherwise be read instead of the app.
    `$best = -1`,
    `$yoyIconic = 0`,
    `foreach ($w in @(YoyWindows)) {`,
    `  if (-not (YoyMatch $w ${pid} '${title}')) { continue }`,
    `  $s = YoyScore $w '${title}'`,
    `  if ($s -le $best) { continue }`,
    `  $candidate = YoyElementAt $w`,
    `  if ($candidate) { $win = $candidate; $best = $s; $yoyIconic = $w.Iconic }`,
    `}`,
    `if (-not $win) { Write-Output 'no-window'; exit }`,
  ].join('\n');
}

// ── computer_elements ───────────────────────────────────────────────────────

type ElementsInput = { window: string };

export const computerElementsTool: ToolDefinition<ElementsInput> = {
  name: 'computer_elements',
  description: 'Read the accessibility (UIA) control tree of a window via PowerShell — names, control types and screen rects of buttons/menus/fields, with a stable index per element. Prefer this over screenshots for finding click targets: pass the returned index to computer_press. window accepts a pid ("12345") or a title substring ("记事本"). Re-run after the UI changes; indexes cover only the latest snapshot.',
  inputHint: '{ "window": "12345" }',
  risk: 'read',
  parallelSafe: false,

  validate(input: unknown): ElementsInput {
    if (!input || typeof input !== 'object') throw new Error('computer_elements input must be an object');
    const window = (input as Record<string, unknown>).window;
    if (typeof window !== 'string' || !window.trim()) throw new Error('window is required (pid or title substring)');
    if (window.length > 200) throw new Error('window is too long');
    return { window: window.trim() };
  },

  async execute(input: ElementsInput, _context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const script = [
      UIA_TYPE_DEF,
      WINDOW_TYPE_DEF,
      WINDOW_RESOLVER,
      uiaWindowLocator(input.window),
      '$els = YoyWalk $win',
      'Write-Output "yoy:count=$($els.Count)"',
      'Write-Output "yoy:iconic=$yoyIconic"',
      '$i = 0',
      'foreach ($el in $els) {',
      '  if ($i -ge 200) { Write-Output "yoy:truncated"; break }',
      '  try {',
      '    $r = $el.Current.BoundingRectangle',
      '    $ct = $el.Current.ControlType.ProgrammaticName.Replace("ControlType.","")',
      '    $name = ($el.Current.Name -replace "[\\r\\n|]", " ").Trim()',
      '    $inv = YoyHasPattern $el ([System.Windows.Automation.InvokePattern]::Pattern)',
      '    $tog = YoyHasPattern $el ([System.Windows.Automation.TogglePattern]::Pattern)',
      '    $exp = YoyHasPattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)',
      '    $act = if ($inv) { "invoke" } elseif ($tog) { "toggle" } elseif ($exp) { "expand" } else { "text" }',
      // A minimized window's controls are all parked at the same off-screen
      // point, so their rects are real numbers that mean nothing: (-32209,-31999)
      // is not somewhere a click could land. Printing them would invite exactly
      // that mistake, so the column says what is true instead.
      '    $rect = if ($yoyIconic -eq 1) { "(minimized)" } else { "({0},{1} {2}x{3})" -f [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height }',
      '    Write-Output ("{0}|{1}|{2}|{3}|{4}" -f $i, $ct, $name, $rect, $act)',
      '  } catch { }',
      '  $i++',
      '}',
      'Write-Output "yoy:window=$($win.Current.Name)"',
    ].join('\n');
    try {
      const out = await runPs(script, 60_000);
      const lines = out.split(/\r?\n/).filter((l) => l && !l.startsWith('yoy:'));
      const meta = out.split(/\r?\n/).find((l) => l.startsWith('yoy:count='));
      if (!out.includes('yoy:') || out.includes('no-window')) {
        return fail(`computer_elements: no window matched "${input.window}". Run computer_list_windows for candidates.`);
      }
      const winName = out.split(/\r?\n/).find((l) => l.startsWith('yoy:window='))?.slice(11)?.trim() ?? input.window;
      const total = meta ? meta.slice(10) : String(lines.length);
      const iconic = out.split(/\r?\n/).find((l) => l.startsWith('yoy:iconic='))?.slice(11)?.trim() === '1';
      // An unactivated packaged app (设置, 计算器 before they are focused)
      // exposes almost no tree. Reading it must not steal focus, so say what is
      // actually true and name the explicit next step instead of silently
      // activating on the user's behalf.
      const thin = lines.length === 0;
      const hint = thin
        ? ' The window exposes no controls while it is not activated — call computer_activate (or click it) and read again.'
        : iconic
          ? ' The window is minimized, so its controls have no place on screen: press them by index (the action column), and do not treat a rect as a click target until the window is brought forward.'
          : '';
      return {
        ok: true,
        output: `${lines.length} of ${total} element(s) in ${winName} — "index|type|name|(x,y WxH)|action", where the position column reads "(minimized)" for a window that has none. Pass an index to computer_press; re-run this tool after the UI changes.${hint}\n${lines.join('\n')}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_elements failed: ${message.slice(0, 500)}`);
    }
  },
};

// ── computer_press ──────────────────────────────────────────────────────────

type PressInput = { window: string; index: number; expected?: string; double: boolean };

export const computerPressTool: ToolDefinition<PressInput> = {
  name: 'computer_press',
  description: 'Activate (Invoke/Toggle/Expand, falling back to a center click) the element at the given index from the LAST computer_elements snapshot of the same window. Always pass `expected` — the name column of that snapshot line — and the tool refuses with a stale-index error if the UI changed and index now points at a different control. Safer than coordinate clicks: no scale-factor math.',
  inputHint: '{ "window": "12345", "index": 7, "expected": "加粗(Ctrl+B)" }',
  risk: 'shell',

  validate(input: unknown): PressInput {
    if (!input || typeof input !== 'object') throw new Error('computer_press input must be an object');
    const obj = input as Record<string, unknown>;
    const window = obj.window;
    if (typeof window !== 'string' || !window.trim()) throw new Error('window is required (pid or title substring)');
    const expected = typeof obj.expected === 'string' && obj.expected.trim() ? obj.expected.trim().slice(0, 200) : undefined;
    return {
      window: window.trim(),
      index: clampInt(obj.index, 0, 199, 'index'),
      expected,
      double: obj.double === true,
    };
  },

  async execute(input: PressInput, _context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const expectedCheck = input.expected
      ? [
        `$snapName = ($el.Current.Name -replace '[\\r\\n|]', ' ').Trim()`,
        `if ($snapName -notlike '*${escapePs(input.expected)}*') { Write-Output "name-mismatch=$snapName"; exit }`,
      ]
      : [];
    const script = [
      UIA_TYPE_DEF,
      INPUT_TYPE_DEF,
      WINDOW_TYPE_DEF,
      WINDOW_RESOLVER,
      uiaWindowLocator(input.window),
      '$els = YoyWalk $win',
      `if ($els.Count -le ${input.index}) { Write-Output 'stale-index'; exit }`,
      `$el = $els[${input.index}]`,
      ...expectedCheck,
      '$r = $el.Current.BoundingRectangle',
      '$cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)',
      'try {',
      '  $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)',
      '  $p.Invoke()',
      '  Write-Output "invoked"',
      '} catch {',
      '  try {',
      '    $t = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)',
      '    $null = $t.Toggle()',
      '    Write-Output "toggled"',
      '  } catch {',
      '    try {',
      '      $e = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)',
      '      if ($e.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $e.Collapse() } else { $e.Expand() }',
      '      Write-Output "expanded"',
      '    } catch {',
      `      if ($cx -le 0 -or $cy -le 0) { Write-Output 'no-center'; exit }`,
      '      [YoyInput]::SetCursorPos($cx, $cy) | Out-Null; Start-Sleep -Milliseconds 60',
      '      [YoyInput]::mouse_event([YoyInput]::LeftDown, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40',
      '      [YoyInput]::mouse_event([YoyInput]::LeftUp, 0, 0, 0, [UIntPtr]::Zero)',
      input.double ? '      Start-Sleep -Milliseconds 80; [YoyInput]::mouse_event([YoyInput]::LeftDown, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [YoyInput]::mouse_event([YoyInput]::LeftUp, 0, 0, 0, [UIntPtr]::Zero)' : '',
      '      Write-Output "clicked-center"',
      '    }',
      '  }',
      '}',
      'Write-Output "name=$($el.Current.Name)"',
    ].join('\n');
    try {
      const out = await runPs(script, 45_000);
      const lines = out.split(/\r?\n/);
      const first = lines[0]?.trim() ?? '';
      if (first === 'no-window') {
        return fail(`computer_press: no visible window matched "${input.window}".`);
      }
      if (first === 'stale-index') {
        return fail(`computer_press: index ${input.index} is stale (the snapshot had fewer elements or the UI changed). Re-run computer_elements.`);
      }
      if (first.startsWith('name-mismatch=')) {
        const actual = first.slice('name-mismatch='.length);
        return fail(`computer_press: index ${input.index} is stale — expected "${input.expected}" but the UI now shows "${actual}". Re-run computer_elements.`);
      }
      if (first === 'no-center') {
        return fail(`computer_press: element ${input.index} has no usable screen rect and no invoke/toggle/expand pattern; cannot click it.`);
      }
      const name = lines.find((l) => l.startsWith('name='))?.slice(5)?.trim();
      return {
        ok: true,
        output: `${first === 'clicked-center' ? 'Center-clicked' : first} element ${input.index}${name ? ` (${name})` : ''} in "${input.window}". Screenshot to verify the effect.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_press failed: ${message.slice(0, 500)}`);
    }
  },
};

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

// ── computer_window_shot ────────────────────────────────────────────────────

/**
 * Renders one window into a bitmap with PrintWindow(PW_RENDERFULLCONTENT).
 *
 * The difference from computer_screenshot is which pixels come back and whose
 * desktop they come from. A desktop grab is CopyFromScreen: it can only ever
 * return what is physically on the monitor, so it shows whatever is stacked on
 * top of the target — the browser you are reading, not the app being worked on
 * — and it cannot see a window that is minimized or on another virtual desktop.
 * PrintWindow asks the window itself to draw into an offscreen DC, so the
 * result is that window's own pixels regardless of z-order, occlusion, or
 * whether it is minimized, and nothing in the user's session changes.
 *
 * PW_RENDERFULLCONTENT (2) is what makes this work for DirectComposition /
 * Chromium / UWP windows; plain PrintWindow returns an empty frame for them.
 * Apps that refuse still fail honestly: a blank bitmap is reported as such
 * instead of being passed off as a picture of the app.
 */
const WINDOW_CAPTURE_DEF = [
  'Add-Type -AssemblyName System.Drawing',
  // Distinguishes "a real UI" from "one flat rectangle": samples a grid and
  // asks how many distinct colours it saw. That is not the same question as
  // "did PrintWindow return true" — an unrendered window reports success and
  // hands back a solid fill — and it is what both the offscreen settle loop and
  // the final verdict are judged on.
  'function Test-HasContent($bmp) {',
  '  $w = $bmp.Width; $h = $bmp.Height',
  '  if ($w -lt 8 -or $h -lt 8) { return $true }',
  '  $seen = @{}',
  '  $sx = [Math]::Max(1, [int]($w / 40)); $sy = [Math]::Max(1, [int]($h / 40))',
  '  for ($px = 0; $px -lt $w; $px += $sx) {',
  '    for ($py = 0; $py -lt $h; $py += $sy) {',
  '      $seen[$bmp.GetPixel($px, $py).ToArgb()] = 1',
  '      if ($seen.Count -gt 3) { return $true }',
  '    }',
  '  }',
  '  return ($seen.Count -gt 3)',
  '}',
  // "Has this frame stopped changing?" — the question that matters for a window
  // restored off screen. A Chromium window paints its chrome first and its page
  // body hundreds of milliseconds later, so stopping at the first non-flat frame
  // returns the browser frame above an empty page. Sampling a coarse grid and
  // asking whether anything moved is enough to tell the two apart.
  'function Test-Differs($a, $b) {',
  '  if ($a.Width -ne $b.Width -or $a.Height -ne $b.Height) { return $true }',
  '  $sx = [Math]::Max(1, [int]($a.Width / 80)); $sy = [Math]::Max(1, [int]($a.Height / 80))',
  '  for ($px = 0; $px -lt $a.Width; $px += $sx) {',
  '    for ($py = 0; $py -lt $a.Height; $py += $sy) {',
  '      if ($a.GetPixel($px, $py).ToArgb() -ne $b.GetPixel($px, $py).ToArgb()) { return $true }',
  '    }',
  '  }',
  '  return $false',
  '}',
  // How much of the BODY is actually drawn. This exists because "the frame did
  // not change" and "the frame is finished" are different claims, and the gap
  // between them is a screenshot of a browser chrome above a blank page: a
  // window that has not painted its content yet holds perfectly still, so a
  // stability test alone stops at once and returns nothing. Measured on Chrome:
  // the body goes from one flat colour at 90ms to ~150 colours by 250ms, so a
  // threshold in the tens is comfortably below a real UI and far above blank.
  'function Test-BodyDrawn($bmp) {',
  '  $w = $bmp.Width; $h = $bmp.Height',
  '  if ($w -lt 8 -or $h -lt 8) { return $true }',
  '  $top = [int]($h * 0.12)  # skip the title/tab/address strip',
  '  if ($h - $top -lt 8) { $top = [int]($h * 0.05) }',
  '  $seen = @{}',
  '  $sx = [Math]::Max(1, [int]($w / 50)); $sy = [Math]::Max(1, [int](($h - $top) / 50))',
  '  for ($px = 0; $px -lt $w; $px += $sx) {',
  '    for ($py = $top; $py -lt $h; $py += $sy) {',
  '      $seen[$bmp.GetPixel($px, $py).ToArgb()] = 1',
  '      if ($seen.Count -gt 12) { return $true }',
  '    }',
  '  }',
  '  return $false',
  '}',
  // Only the P/Invoke declarations are compiled. A C# body that also touched
  // System.Drawing does not build here: Windows PowerShell 5.1's Add-Type
  // compiler does not reference the drawing assemblies, so `using
  // System.Drawing` fails with "type or namespace Imaging does not exist".
  // Declarations alone compile fine; the bitmap work happens in PowerShell,
  // where Add-Type -AssemblyName has already loaded it.
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class YoyCap {',
  '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {',
  '    public int length, flags, showCmd; public POINT ptMinPosition, ptMaxPosition; public RECT rcNormalPosition;',
  '  }',
  '  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);',
  '  [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);',
  '  public static WINDOWPLACEMENT Placement(IntPtr h) {',
  '    var p = new WINDOWPLACEMENT(); p.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));',
  '    GetWindowPlacement(h, ref p); return p;',
  '  }',
  '  // Where the window may be parked so the user never sees it.',
  '  //',
  '  // -30000 is the obvious answer and it is WRONG for the Chromium family:',
  '  // measured on Chrome and Edge, a normal position of (-30000,-30000) is',
  '  // silently clamped back to (0,0) — i.e. the top-left of the user\'s screen.',
  '  // Restoring a window there is the opposite of invisible. What those apps DO',
  '  // keep exactly is the first column past the right edge of the virtual screen',
  '  // and the first row above its top, so those are the candidates offered; the',
  '  // caller verifies one is accepted BEFORE anything is shown.',
  '  public static int VirtualRight() { return GetSystemMetrics(76) + GetSystemMetrics(78); }',
  '  public static int VirtualTop() { return GetSystemMetrics(77); }',
  '  // Rewrites ONLY the restored rectangle. showCmd is untouched, so a minimized',
  '  // window stays minimized — this is the probe that asks "would you accept',
  '  // that position?" without anything becoming visible, whatever the answer.',
  '  public static bool TryNormalPosition(IntPtr h, int x, int y, int w, int ht) {',
  '    var p = Placement(h);',
  '    p.rcNormalPosition.Left = x; p.rcNormalPosition.Top = y;',
  '    p.rcNormalPosition.Right = x + w; p.rcNormalPosition.Bottom = y + ht;',
  '    SetWindowPlacement(h, ref p);',
  '    var read = Placement(h);',
  '    return read.rcNormalPosition.Left == x && read.rcNormalPosition.Top == y;',
  '  }',
  '  // The restore itself: position and showCmd in ONE SetWindowPlacement, so no',
  '  // frame is ever painted at the window\'s on-screen position. SW_SHOWNOACTIVATE',
  '  // keeps keyboard focus where it was.',
  '  public static void ShowAt(IntPtr h, int x, int y, int w, int ht) {',
  '    var p = Placement(h);',
  '    p.showCmd = 4; // SW_SHOWNOACTIVATE',
  '    p.rcNormalPosition.Left = x; p.rcNormalPosition.Top = y;',
  '    p.rcNormalPosition.Right = x + w; p.rcNormalPosition.Bottom = y + ht;',
  '    SetWindowPlacement(h, ref p);',
  '  }',
  '  // Undo ShowAt exactly. SetWindowPlacement alone restores the saved geometry',
  '  // but leaves the minimize animation/taskbar state to itself, which on some',
  '  // apps strands the taskbar button where the window was; reasserting',
  '  // SW_SHOWMINNOACTIVE is what puts it back.',
  '  //',
  '  // The test is "did the window end up where we parked it", NOT "is it still',
  '  // there". This distinction is the whole safety property: an earlier version',
  '  // treated a window found away from the park position as "the user moved it,',
  '  // leave it alone", and when an app CLAMPED the park position onto the screen',
  '  // that left the window restored, visible, in front of the user. A park that',
  '  // was never accepted is not someone else\'s doing to respect; it is a restore',
  '  // of ours to undo. So the caller records whether the placement write took, and',
  '  // this always restores from `saved`, reporting which case it was.',
  '  public static bool Unpark(IntPtr h, ref WINDOWPLACEMENT saved) {',
  '    SetWindowPlacement(h, ref saved);',
  '    if (saved.showCmd == 2) ShowWindow(h, 7); // SW_SHOWMINNOACTIVE',
  '    var back = Placement(h);',
  '    return back.showCmd == saved.showCmd',
  '      && back.rcNormalPosition.Left == saved.rcNormalPosition.Left',
  '      && back.rcNormalPosition.Top == saved.rcNormalPosition.Top;',
  '  }',
  '}',
  '"@',
].join('\n');

type WindowShotInput = { window: string };

/** Width/height straight out of the PNG IHDR chunk — no image library needed. */
function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** True when every pixel is the same colour — what a refused capture returns. */
function isBlankImage(png: Buffer): boolean {
  // Cheap and dependency-free: a PNG of a single flat colour compresses to a
  // few hundred bytes regardless of dimensions.
  return png.length < 1024;
}

export const computerWindowShotTool: ToolDefinition<WindowShotInput> = {
  name: 'computer_window_shot',
  description: 'Capture ONE window\'s own pixels into a PNG without touching the user\'s desktop: it works while the window is behind others, on another virtual desktop, or minimized, and never activates, raises or focuses anything. A minimized window is restored offscreen just long enough to render and put back — nothing appears on the user\'s screen. An app that refuses to be placed off-screen is not captured at all, because the only other way to photograph it would be to show it to the user. Returns a screenshotId — pass it with x/y in image pixels to computer_click / computer_scroll / computer_drag to act on a point you can see (a minimized capture is readable but not clickable, and says so). Use this instead of computer_screenshot whenever you need to see a specific app: the desktop grab returns whatever the user is currently looking at, not the app you are working on. window accepts a pid ("12345") or a title substring ("记事本").',
  inputHint: '{ "window": "记事本" }',
  risk: 'read',
  parallelSafe: false,

  validate(input: unknown): WindowShotInput {
    if (!input || typeof input !== 'object') throw new Error('computer_window_shot input must be an object');
    const window = (input as Record<string, unknown>).window;
    if (typeof window !== 'string' || !window.trim()) throw new Error('window is required (pid or title substring)');
    if (window.length > 200) throw new Error('window is too long');
    return { window: window.trim() };
  },

  async execute(input: WindowShotInput, context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const dir = join(context.workspaceRoot, '.aicode', 'computer');
    await mkdir(dir, { recursive: true });
    const target = join(dir, `window-${Date.now()}-${randomBytes(3).toString('hex')}.png`);
    const isPid = /^\d+$/.test(input.window);
    const pid = isPid ? input.window : '0';
    const title = isPid ? '' : escapePs(input.window);
    const script = [
      WINDOW_TYPE_DEF,
      WINDOW_RESOLVER,
      WINDOW_CAPTURE_DEF,
      `$target = YoyBest @(YoyWindows) ${pid} '${title}'`,
      `if (-not $target) { Write-Output 'no-window'; exit }`,
      // No activation, no SetForegroundWindow, no ShowWindow: the point of this
      // tool is that the user's session is not disturbed. A minimized window is
      // reported as minimized (and usually still renders), not restored.
      // Geometry comes from the resolver, which already falls back to
      // GetWindowPlacement for iconic windows: GetWindowRect on a minimized
      // window returns the 158x26 title-bar stub, so using it here produced a
      // thumbnail of nothing instead of the window's contents.
      `$hwnd = [IntPtr]$target.Hwnd`,
      `$w = $target.Width; $h = $target.Height`,
      `if ($w -le 0 -or $h -le 0) { Write-Output 'yoy:result=empty'; exit }`,
      `$bmp = $null`,
      // PrintWindow can only print a surface that exists. A minimized window has
      // none, so it is restored OFF SCREEN for the length of the capture and put
      // straight back.
      //
      // Three things here were each measured, and each replaced a guess that was
      // wrong in a way that could have shown the window to the user:
      //
      //  1. WHERE. (-30000,-30000) is the obvious off-screen point and the
      //     Chromium family silently clamps it to (0,0) — the user's top-left
      //     corner. The first column past the right edge of the virtual screen is
      //     accepted exactly, so that is tried first, then the first row above the
      //     top. The choice is VERIFIED by writing the restored rectangle while
      //     the window is still minimized, which cannot show anything whatever the
      //     app decides.
      //  2. NO ACCEPTABLE POSITION means no capture. An app that clamps every
      //     off-screen point would have to be shown on screen to be photographed,
      //     and that is the one thing this tool will not do.
      //  3. WHEN IT IS DONE PAINTING, which is two conditions, not one:
      //     "any content at all" is far too early (a Chromium window paints its
      //     tab strip and address bar first, so the first non-flat frame is
      //     browser chrome above an empty page), and "stopped changing" is not
      //     enough either (a window that painted nothing sits perfectly still).
      //     So the body has to actually hold detail AND the frame has to have
      //     stopped changing — and since Chromium throttles a window it thinks is
      //     unseen, the whole cycle is retried a few times before giving up.
      `$wasIconic = 0`,
      `$parkFell = 0`,
      `if ([YoyCap]::IsIconic($hwnd)) {`,
      `  $wasIconic = 1`,
      `  $saved = [YoyCap]::Placement($hwnd)`,
      `  $parkX = 0; $parkY = 0; $parkMode = 'none'`,
      `  if ([YoyCap]::TryNormalPosition($hwnd, [YoyCap]::VirtualRight(), $saved.rcNormalPosition.Top, $w, $h)) {`,
      `    $parkX = [YoyCap]::VirtualRight(); $parkY = $saved.rcNormalPosition.Top; $parkMode = 'right'`,
      `  } elseif ([YoyCap]::TryNormalPosition($hwnd, $saved.rcNormalPosition.Left, [YoyCap]::VirtualTop() - $h, $w, $h)) {`,
      `    $parkX = $saved.rcNormalPosition.Left; $parkY = [YoyCap]::VirtualTop() - $h; $parkMode = 'above'`,
      `  }`,
      `  if ($parkMode -eq 'none') {`,
      `    # Deliberately not captured. Photographing this window would mean showing`,
      `    # it to the user, and a picture is not worth that.`,
      `    [YoyCap]::Unpark($hwnd, [ref]$saved) | Out-Null`,
      `    Write-Output 'yoy:result=nomode'`,
      `    Write-Output "yoy:title=$($target.Title)"`,
      `    exit`,
      `  }`,
      `  $fgBefore = [YoyCap]::GetForegroundWindow()`,
      `  $drawn = 0`,
      `  try {`,
      `    # Chromium parks its renderer when it believes the window cannot be seen,`,
      `    # and it does not always believe it straight away — measured: the same`,
      `    # window came back blank on one attempt and complete on the next, with no`,
      `    # other change. So the whole park/capture cycle is retried a few times`,
      `    # rather than giving up on one blank frame. Every retry is invisible, so`,
      `    # the only cost is a little time.`,
      `    for ($cycle = 0; $cycle -lt 3 -and $drawn -eq 0; $cycle++) {`,
      `      if ($cycle -gt 0) {`,
      `        [YoyCap]::Unpark($hwnd, [ref]$saved) | Out-Null`,
      `        Start-Sleep -Milliseconds 140`,
      `      }`,
      `      [YoyCap]::ShowAt($hwnd, $parkX, $parkY, $w, $h)`,
      `      $settled = $null`,
      `      for ($attempt = 0; $attempt -lt 8; $attempt++) {`,
      `        Start-Sleep -Milliseconds 90`,
      `        if ($bmp) { $bmp.Dispose() }`,
      `        $bmp = New-Object System.Drawing.Bitmap($w, $h)`,
      `        $g = [System.Drawing.Graphics]::FromImage($bmp)`,
      `        $hdc = $g.GetHdc()`,
      `        $printed = [YoyCap]::PrintWindow($hwnd, $hdc, 2)`,
      `        $g.ReleaseHdc($hdc); $g.Dispose()`,
      `        if (-not $printed) { continue }`,
      `        if (-not (Test-BodyDrawn $bmp)) { continue }`,
      `        $drawn = 1`,
      // Two conditions, because neither alone is enough: the body has to be
      // drawn (a window that painted nothing sits perfectly still, so stability
      // alone stops at once and returns a browser frame above an empty page),
      // and the frame has to have stopped changing (a page still filling in
      // would otherwise be screenshotted half-drawn).
      `        if ($settled -and -not (Test-Differs $settled $bmp)) { break }`,
      `        if ($settled) { $settled.Dispose() }`,
      `        $settled = New-Object System.Drawing.Bitmap($bmp)`,
      `      }`,
      `      if ($settled) { $settled.Dispose() }`,
      `    }`,
      `  } finally {`,
      `    if (-not [YoyCap]::Unpark($hwnd, [ref]$saved)) { $parkFell = 1 }`,
      `    if ([YoyCap]::GetForegroundWindow() -ne $fgBefore) { Write-Output 'yoy:fg=changed' }`,
      `  }`,
      `  if ($parkFell -eq 1) { Write-Output 'yoy:moved=1' }`,
      // Chromium throttles a window it believes nobody can see, so an off-screen
      // restore does not always produce pixels. There is no honest way to force
      // it, and returning the last frame regardless would hand back browser
      // chrome above a blank page and call it a screenshot of the app. So: no
      // drawing, no picture.
      `  if ($drawn -eq 0) {`,
      `    if ($bmp) { $bmp.Dispose() }`,
      `    Write-Output 'yoy:result=undrawn'`,
      `    Write-Output "yoy:title=$($target.Title)"`,
      `    exit`,
      `  }`,
      `} else {`,
      `  $bmp = New-Object System.Drawing.Bitmap($w, $h)`,
      `  $g = [System.Drawing.Graphics]::FromImage($bmp)`,
      `  $hdc = $g.GetHdc()`,
      `  $printed = [YoyCap]::PrintWindow($hwnd, $hdc, 2)`,
      `  $g.ReleaseHdc($hdc); $g.Dispose()`,
      `  if (-not $printed) { $bmp.Dispose(); Write-Output 'yoy:result=refused'; Write-Output "yoy:title=$($target.Title)"; exit }`,
      `}`,
      // A true from PrintWindow is not proof of content: a window whose surface
      // DWM owns comes back as a single flat colour. Reporting that as a
      // screenshot would have the agent "see" a blank app and act on it.
      `if (-not (Test-HasContent $bmp)) { $bmp.Dispose(); Write-Output 'yoy:result=blank'; Write-Output "yoy:title=$($target.Title)"; Write-Output "yoy:iconic=$wasIconic"; exit }`,
      // The picture the model sees is capped at the same width as computer_screenshot,
      // so a 4K window does not arrive as a 12 MB image. The ratio between this
      // size and the window size is recorded with the capture id: coordinates
      // read off the image are image pixels, and the click tool translates them
      // back through that ratio. Without this, "the coordinate I saw" and "the
      // pixel I clicked" silently differ by the downscale factor.
      `$out = $bmp`,
      `if ($bmp.Width -gt 1568) {`,
      `  $nw = 1568; $nh = [int][Math]::Round($bmp.Height * (1568 / $bmp.Width))`,
      `  $small = New-Object System.Drawing.Bitmap($nw, $nh)`,
      `  $g2 = [System.Drawing.Graphics]::FromImage($small)`,
      `  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic`,
      `  $g2.DrawImage($bmp, 0, 0, $nw, $nh)`,
      `  $g2.Dispose()`,
      `  $out = $small`,
      `}`,
      `$out.Save('${escapePs(target.replace(/\\/g, '/'))}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      `Write-Output "yoy:image=$($out.Width)|$($out.Height)"`,
      `if ($out -ne $bmp) { $out.Dispose() }`,
      `$bmp.Dispose()`,
      `Write-Output "yoy:result=$w|$h|$wasIconic"`,
      `Write-Output "yoy:hwnd=$($hwnd.ToInt64())"`,
      `Write-Output "yoy:title=$($target.Title)"`,
      `Write-Output "yoy:class=$($target.Class)"`,
      `Write-Output "yoy:left=$($target.Left)"; Write-Output "yoy:top=$($target.Top)"`,
      `Write-Output "yoy:width=$($target.Width)"; Write-Output "yoy:height=$($target.Height)"`,
    ].join('\n');
    try {
      const out = await runPs(script, 45_000);
      if (out.includes('no-window')) return fail(`computer_window_shot: no window matched "${input.window}". Run computer_list_windows to see candidates.`);
      const field = (name: string): string => (out.match(new RegExp(`^yoy:${name}=(.*)$`, 'm'))?.[1] ?? '').trim();
      const result = field('result');
      if (result === 'empty') return fail('computer_window_shot: the window has zero size — it is closing.');
      if (result === 'nomode') {
        return fail(`computer_window_shot: "${field('title')}" is minimized and refuses every off-screen position, so capturing it would mean putting it on screen — which this tool will not do. Its controls are still readable with computer_elements, or you (the user) can bring the window forward and capture it then.`);
      }
      if (result === 'undrawn') {
        // Chromium parks its renderer when it believes the window cannot be seen,
        // so a window restored off screen sometimes paints nothing at all. The
        // frame was captured; it is just empty above the title bar, and handing
        // that back as "here is the app" would have the model read a blank page.
        return fail(`computer_window_shot: "${field('title')}" was restored off screen but did not paint its contents, so there is nothing to show (this happens with Chromium-based apps that stop rendering while unseen). Nothing was changed on the user's screen. Use computer_elements for its controls, or ask the user to bring the window forward and capture it then.`);
      }
      if (result === 'refused') {
        return fail(`computer_window_shot: "${field('title')}" did not render itself (PrintWindow refused). Nothing was captured — falling back to a screen grab would return whatever is covering it. Use computer_elements for its controls.`);
      }
      if (result === 'blank') {
        // Honest failure, not a picture of nothing: the agent cannot act on a
        // flat rectangle, and pretending otherwise sends it clicking blind. The
        // cure is an explicit activation, which is the user's call to make.
        const minimized = String(field('iconic')) === '1';
        return fail(`computer_window_shot: "${field('title')}" rendered a blank frame${minimized ? ' — it is minimized, and Windows only renders a minimized window once it has been shown at least once' : ''}. Its pixels are not reachable without activating it; use computer_elements for its controls, or computer_activate if you (the user) want it brought to the front.`);
      }
      const [w, h, iconic] = result.split('|');
      const png = await readFile(target);
      if (isBlankImage(png)) {
        return fail(`computer_window_shot: "${field('title')}" returned a blank frame (${w}x${h}). Its content may be drawn by a surface PrintWindow cannot reach; use computer_elements for its controls.`);
      }
      // The restore did not land back on the saved placement, so where the
      // window is now is not known for certain. The picture may be fine, but it
      // is not something to hand back as if nothing happened.
      if (field('moved')) {
        return fail(`computer_window_shot: "${field('title')}" could not be put back exactly where it was after being captured, so the picture is not trusted. It was being captured while minimized; bring it forward (computer_activate, or ask the user) and capture it again.`);
      }
      // The capture is registered so a later computer_click can name it by id
      // instead of recomputing screen coordinates: (x, y) then means "the pixel
      // at x,y in THIS picture", which survives the window being moved between
      // looking and clicking — or, if it did move, is refused with the reason
      // instead of clicking the wrong thing.
      const [imageWidth, imageHeight] = (field('image') || `${w}|${h}`).split('|').map(Number);
      const fromPng = pngSize(png);
      const dimensions = Number.isFinite(imageWidth) && imageWidth > 0
        ? { imageWidth, imageHeight }
        : fromPng
          ? { imageWidth: fromPng.width, imageHeight: fromPng.height }
          : { imageWidth: Number(w), imageHeight: Number(h) };
      const id = newCaptureId();
      // A minimized window was photographed while parked offscreen, so its
      // pixels are real but its coordinates are not actionable: (400, 300) in
      // this image has no live screen point, and re-deriving one from the saved
      // rect would aim at wherever the window WOULD be — quite possibly someone
      // else's window. Recording it as uncapturable makes click/scroll/drag
      // refuse with that reason instead of clicking blind.
      const clickable = iconic !== '1';
      const record: CaptureRecord = {
        id,
        window: input.window,
        title: field('title'),
        className: field('class'),
        hwnd: Number(field('hwnd')),
        left: Number(field('left')),
        top: Number(field('top')),
        width: Number(w),
        height: Number(h),
        imageWidth: dimensions.imageWidth,
        imageHeight: dimensions.imageHeight,
        at: Date.now(),
        ...(clickable ? {} : { minimized: true }),
      };
      await saveCapture(context.workspaceRoot, record);
      const payload: ComputerImagePayload = { mediaType: 'image/png', data: png.toString('base64'), path: target };
      return {
        ok: true,
        output: `Captured "${field('title')}" (${field('class')}) at ${field('left')},${field('top')} — ${w}x${h}${iconic === '1' ? ', was minimized (rendered offscreen — the user saw nothing)' : ''}. The user's desktop was not touched. Image: ${target}`
          + (clickable
            ? `\nScreenshot id ${id}. To act on a point you can see in this image, pass {"window": "${input.window}", "screenshotId": "${id}", "x": <image x>, "y": <image y>} to computer_click / computer_scroll / computer_drag — the coordinates are relative to this image, so no scale-factor or window-position math is needed.`
            : `\nScreenshot id ${id} — for READING only: the window is minimized, so it has no on-screen position and a point in this image cannot be clicked. Read it, or ask the user to bring the window forward and capture again to act on it.`),
        data: { computerImage: payload, screenshotId: id, window: input.window, ...(clickable ? {} : { minimized: true }), rect: { left: record.left, top: record.top, width: record.width, height: record.height }, image: { width: record.imageWidth, height: record.imageHeight } },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_window_shot failed: ${message.slice(0, 500)}`);
    }
  },
};

// ── computer_click ──────────────────────────────────────────────────────────

type ClickInput = {
  x: number;
  y: number;
  button: 'left' | 'right' | 'middle';
  double: boolean;
  /** Name a computer_window_shot capture; x/y then mean image pixels. */
  screenshotId?: string;
  window?: string;
};

/**
 * Translate (x, y) into the screen point to click.
 *
 * Two modes, and which one applies is decided by `screenshotId`:
 *  - With an id: x,y are pixels in that capture's image. The window is checked
 *    again first — if it moved or resized since, the answer is a refusal that
 *    names the new position, because clicking the old screen point would hit
 *    whatever is now there (or nothing at all).
 *  - Without an id: x,y are screen coordinates, as before, for a point read
 *    off computer_screenshot or a window's bounds.
 *
 * Shared by click, scroll and drag so all three agree on what a coordinate
 * means.
 */
async function resolvePoint(
  input: { x: number; y: number; screenshotId?: string; window?: string },
  workspaceRoot: string,
  tool: string,
): Promise<{ ok: true; x: number; y: number; capture?: CaptureRecord } | { ok: false; error: string }> {
  if (!input.screenshotId) return { ok: true, x: input.x, y: input.y };
  const capture = await loadCapture(workspaceRoot, input.screenshotId);
  if (!capture) {
    return { ok: false, error: `${tool}: unknown screenshotId "${input.screenshotId}" — capture the window again with computer_window_shot and use the id it returns.` };
  }
  if (input.window && input.window !== capture.window) {
    return { ok: false, error: `${tool}: screenshotId ${capture.id} belongs to "${capture.window}", not "${input.window}". Use the id from the capture of the window you are acting on.` };
  }
  if (input.x < 0 || input.y < 0 || input.x > capture.imageWidth || input.y > capture.imageHeight) {
    return { ok: false, error: `${tool}: (${input.x}, ${input.y}) is outside the ${capture.imageWidth}×${capture.imageHeight} screenshot ${capture.id}.` };
  }
  // A minimized capture was taken while the window was parked offscreen, so
  // there is no screen point behind any pixel in it. Refusing here is what
  // keeps "click what you see in this picture" from turning into a click at the
  // window's remembered coordinates, which belong to whatever is there now.
  if (capture.minimized) {
    return { ok: false, error: `${tool}: ${capture.id} is a capture of "${capture.title}" while it was minimized, so it has no on-screen position to click. Bring the window forward (computer_activate, or ask the user), then computer_window_shot again and use the new id.` };
  }
  // The window must still be where it was when the picture was taken. This is
  // the whole point of binding the id: (400, 300) is a fact about the old
  // picture, and only still a fact about the desktop if nothing moved.
  const live = await liveRect(capture);
  if (live.missing) {
    return { ok: false, error: `${tool}: "${capture.title}" is no longer open (it closed or its window handle was replaced). Capture again before acting.` };
  }
  const drift = describeDrift(capture, live);
  if (drift) {
    return { ok: false, error: `${tool}: ${drift}. Take a fresh computer_window_shot and use its id — the old coordinates no longer point at the same control.` };
  }
  const point = toScreenPoint(capture, input.x, input.y);
  return { ok: true, x: point.x, y: point.y, capture };
}

/**
 * Ask Windows where the captured window is right now.
 *
 * Matched by hwnd, not by title or pid: a title changes when a document is
 * saved, and a pid can host several windows (every Chrome tab share one).
 */
async function liveRect(capture: CaptureRecord): Promise<CaptureRecord & { missing?: boolean }> {
  const script = [
    WINDOW_TYPE_DEF,
    WINDOW_RESOLVER,
    `$hwnd = [IntPtr]${Math.trunc(capture.hwnd)}`,
    `if (-not [YoyWin]::IsWindow($hwnd)) { Write-Output 'yoy:missing=1'; exit }`,
    // Deliberately not YoyWindows (EnumWindows only enumerates visible
    // top-level windows; a window that has just been cloaked would look
    // closed). The hwnd is known to be a live window at this point.
    `$rect = [YoyWin]::Rect($hwnd)`,
    `Write-Output "yoy:rect=$rect"`,
  ].join('\n');
  try {
    const out = await runPs(script, 20_000);
    if (out.includes('yoy:missing=1')) return { ...capture, missing: true };
    const rect = out.match(/^yoy:rect=(-?\d+)\|(-?\d+)\|(\d+)\|(\d+)$/m);
    if (!rect) return { ...capture, missing: true };
    return { ...capture, left: Number(rect[1]), top: Number(rect[2]), width: Number(rect[3]), height: Number(rect[4]) };
  } catch {
    // A geometry probe that fails must not fall through to a click: the
    // caller turns this into "capture again", which is always safe.
    return { ...capture, missing: true };
  }
}

/**
 * What sits on top of a screen point, when it is not the window we meant to
 * click.
 *
 * Mouse input is injected into whatever is under the pointer, and a click on
 * another app is not something this tool should do silently — it would be a
 * click in the user's browser or editor because the target happened to be
 * behind it. Bringing the target forward instead would steal focus, which is
 * the one thing this toolkit does not do on its own. So the click is refused
 * and the caller is told exactly what is in the way.
 */
async function describeOcclusion(hwnd: number, x: number, y: number): Promise<string | undefined> {
  const script = [
    WINDOW_TYPE_DEF,
    `$hit = [YoyWin]::OwnsPoint([IntPtr]${Math.trunc(hwnd)}, ${x}, ${y})`,
    `Write-Output "yoy:hit=$hit"`,
  ].join('\n');
  try {
    const out = await runPs(script, 20_000);
    const hit = out.match(/^yoy:hit=(.*)$/m)?.[1]?.trim() ?? '';
    if (!hit || hit === 'ok') return undefined;
    if (hit === 'none') return `nothing is at screen (${x}, ${y}) — the window may have closed. Capture it again before acting.`;
    const [, cls, pid, ...titleParts] = hit.split('|');
    const title = titleParts.join('|');
    return `screen (${x}, ${y}) belongs to "${title || cls}" (pid ${pid}, class ${cls}), not the captured window — it is covered at that point. `
      + 'Nothing was clicked: clicking through would have hit the wrong app, and bringing the target forward is the user\'s decision, not a side effect of a click. '
      + 'Use computer_elements to press the control by index, ask the user to bring the window forward, or wait until it is on top.';
  } catch {
    // The guard is an extra safety net, not the safety mechanism itself: if the
    // probe itself fails (a window that closes mid-check), let the click
    // proceed rather than blocking, since the geometry check already passed.
    return undefined;
  }
}

export const computerClickTool: ToolDefinition<ClickInput> = {  name: 'computer_click',
  description: 'Click a point. Prefer the capture-relative form: after computer_window_shot, pass its screenshotId with x/y in image pixels — the tool checks the window has not moved and converts to the real screen point itself. Without a screenshotId, x/y are absolute screen coordinates (computer_screenshot coordinates × its scale factor). Works on a window that is behind others only when the point is not covered — the tool reports what is on top instead of clicking through it.',
  inputHint: '{ "screenshotId": "shot-1a2b3c4d", "x": 400, "y": 300, "button": "left" }',
  risk: 'shell',

  validate(input: unknown): ClickInput {
    if (!input || typeof input !== 'object') throw new Error('computer_click input must be an object');
    const obj = input as Record<string, unknown>;
    const button = obj.button === 'right' || obj.button === 'middle' ? obj.button : 'left';
    const screenshotId = typeof obj.screenshotId === 'string' && obj.screenshotId.trim() ? obj.screenshotId.trim() : undefined;
    const window = typeof obj.window === 'string' && obj.window.trim() ? obj.window.trim() : undefined;
    return {
      // Capture-relative coordinates can legitimately exceed any fixed bound;
      // absolute screen coordinates cannot. The id decides which rule applies.
      x: clampInt(obj.x, screenshotId ? -10_000 : 0, screenshotId ? 100_000 : 20_000, 'x'),
      y: clampInt(obj.y, screenshotId ? -10_000 : 0, screenshotId ? 100_000 : 20_000, 'y'),
      button,
      double: obj.double === true,
      ...(screenshotId ? { screenshotId } : {}),
      ...(window ? { window } : {}),
    };
  },

  async execute(input: ClickInput, context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const point = await resolvePoint(input, context.workspaceRoot, 'computer_click');
    if (!point.ok) return fail(point.error);
    if (point.capture) {
      const covered = await describeOcclusion(point.capture.hwnd, point.x, point.y);
      if (covered) return fail(`computer_click: ${covered}`);
    }
    const down = input.button === 'right' ? 'RightDown' : input.button === 'middle' ? 'MiddleDown' : 'LeftDown';
    const up = input.button === 'right' ? 'RightUp' : input.button === 'middle' ? 'MiddleUp' : 'LeftUp';
    const clickBlock =
      `[YoyInput]::mouse_event([YoyInput]::${down}, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; ` +
      `[YoyInput]::mouse_event([YoyInput]::${up}, 0, 0, 0, [UIntPtr]::Zero)`;
    const script = `${INPUT_TYPE_DEF}\n[YoyInput]::SetCursorPos(${point.x}, ${point.y}) | Out-Null; Start-Sleep -Milliseconds 60; ${clickBlock}${input.double ? `; Start-Sleep -Milliseconds 80; ${clickBlock}` : ''}; Write-Output 'ok'`;
    try {
      await runPs(script);
      const where = point.capture
        ? `${input.x},${input.y} in ${point.capture.id} = screen (${point.x}, ${point.y}) on "${point.capture.title}"`
        : `(${point.x}, ${point.y})`;
      return { ok: true, output: `${input.double ? 'Double ' : ''}${input.button}-click at ${where}. Capture again to verify the effect.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_click failed: ${message.slice(0, 500)}`);
    }
  },
};

// ── computer_type ───────────────────────────────────────────────────────────

type TypeInput = { text: string; window?: string };

/**
 * PowerShell that resolves the foreground window's title and pid. Used as a
 * pre-flight check by the input tools: typing or pressing keys always lands on
 * whatever is focused, so without this a stray click or a late-launching app
 * silently receives the text — the failure mode that made GUI control look
 * broken when it was really aiming at the wrong window.
 */
const FOREGROUND_TYPE_DEF = [
  'Add-Type -TypeDefinition @"',
  'using System; using System.Text; using System.Runtime.InteropServices;',
  'public static class YoyForeground {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  public static string Describe() {',
  '    IntPtr h = GetForegroundWindow();',
  '    var sb = new StringBuilder(512); GetWindowText(h, sb, 512);',
  '    uint pid; GetWindowThreadProcessId(h, out pid);',
  '    return pid + "|" + sb.ToString();',
  '  }',
  '}',
  '"@',
].join('\n');

/** `window` is optional so existing prompts keep working; when given, a
 *  mismatch is a failure rather than a silent mis-type. */
function foregroundGuard(window: string | undefined): string[] {
  if (!window) return [];
  const escaped = escapePs(window);
  return [
    FOREGROUND_TYPE_DEF,
    '$fg = [YoyForeground]::Describe()',
    'if ($fg -notlike "*' + escaped + '*") { Write-Output "wrong-window=$fg"; exit }',
  ];
}

function wrongWindowResult(out: string, tool: string): ToolResult | undefined {
  if (!out.startsWith('wrong-window=')) return undefined;
  const [pid, ...rest] = out.slice('wrong-window='.length).split('|');
  return fail(
    `${tool}: the focused window is "${rest.join('|')}" (pid ${pid}), not the requested one. `
    + 'Call computer_activate with that window first, then retry.',
  );
}

export const computerTypeTool: ToolDefinition<TypeInput> = {
  name: 'computer_type',
  description: 'Type literal text into the focused window. Activate the target app first (computer_activate or click its window). Pass `window` to have the tool verify the focused window before typing — without it, text goes wherever focus happens to be. Handles spaces, newlines and non-ASCII (Chinese, emoji). Use computer_key instead for single keys or shortcuts.',
  inputHint: '{ "window": "Notepad", "text": "hello world" }',
  risk: 'shell',

  validate(input: unknown): TypeInput {
    if (!input || typeof input !== 'object') throw new Error('computer_type input must be an object');
    const obj = input as Record<string, unknown>;
    const text = obj.text;
    if (typeof text !== 'string' || text.length === 0) throw new Error('text is required and must be non-empty');
    if (text.length > 4000) throw new Error('text is too long (max 4000 chars)');
    const window = typeof obj.window === 'string' && obj.window.trim() ? obj.window.trim() : undefined;
    return { text, ...(window ? { window } : {}) };
  },

  async execute(input: TypeInput, _context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    // Unicode key injection, not SendKeys — see YoyInput.TypeText for why.
    // The text travels as base64: it is ASCII-only, so quotes, newlines, `$`,
    // emoji and Chinese all survive without any PowerShell escaping rules.
    const encoded = Buffer.from(input.text, 'utf8').toString('base64');
    const script = [
      INPUT_TYPE_DEF,
      ...foregroundGuard(input.window),
      `$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
      '$n = [YoyInput]::TypeText($text)',
      'Write-Output "typed=$n"',
    ].join('\n');
    try {
      const out = await runPs(script, 60_000);
      const wrong = wrongWindowResult(out, 'computer_type');
      if (wrong) return wrong;
      if (!/^typed=\d+/.test(out)) return fail(`computer_type failed: ${out.slice(0, 300)}`);
      return { ok: true, output: `Typed ${input.text.length} characters into the focused window.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_type failed: ${message.slice(0, 500)}`);
    }
  },
};

// ── computer_key ────────────────────────────────────────────────────────────

type KeyInput = { keys: string; window?: string };

export const computerKeyTool: ToolDefinition<KeyInput> = {
  name: 'computer_key',
  description: 'Send a key or shortcut to the focused window using SendKeys syntax: {ENTER}, {ESC}, {TAB}, {F5}, ^s (Ctrl+S), %{F4} (Alt+F4), ^+{ESC} (Ctrl+Shift+Esc). Modifiers: ^ Ctrl, % Alt, + Shift. Pass `window` to verify the focused window first.',
  inputHint: '{ "keys": "{ENTER}" }',
  risk: 'shell',

  validate(input: unknown): KeyInput {
    if (!input || typeof input !== 'object') throw new Error('computer_key input must be an object');
    const obj = input as Record<string, unknown>;
    const keys = obj.keys;
    if (typeof keys !== 'string' || keys.length === 0) throw new Error('keys is required');
    if (keys.length > 128) throw new Error('keys is too long (max 128)');
    if (!/^[\w+^%~{}()\[\] -]{1,128}$/.test(keys)) throw new Error('keys contains unsupported characters');
    const window = typeof obj.window === 'string' && obj.window.trim() ? obj.window.trim() : undefined;
    return { keys, ...(window ? { window } : {}) };
  },

  async execute(input: KeyInput, _context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const script = [
      ...foregroundGuard(input.window),
      'Add-Type -AssemblyName System.Windows.Forms',
      `[System.Windows.Forms.SendKeys]::SendWait('${escapePs(input.keys)}')`,
      'Write-Output "ok"',
    ].join('\n');
    try {
      const out = await runPs(script);
      const wrong = wrongWindowResult(out, 'computer_key');
      if (wrong) return wrong;
      return { ok: true, output: `Sent keys ${input.keys} to the focused window.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_key failed: ${message.slice(0, 500)}`);
    }
  },
};

// ── computer_scroll ─────────────────────────────────────────────────────────

type ScrollInput = {
  x?: number;
  y?: number;
  direction: 'up' | 'down';
  amount: number;
  screenshotId?: string;
  window?: string;
};

export const computerScrollTool: ToolDefinition<ScrollInput> = {
  name: 'computer_scroll',
  description: 'Scroll the mouse wheel. With a screenshotId from computer_window_shot, x/y are pixels in that image and the wheel turns over that point in the captured window; without one they are absolute screen coordinates, and omitting them scrolls wherever the pointer already is. amount is wheel notches (1-20).',
  inputHint: '{ "screenshotId": "shot-1a2b3c4d", "x": 400, "y": 300, "direction": "down", "amount": 3 }',
  risk: 'shell',

  validate(input: unknown): ScrollInput {
    if (!input || typeof input !== 'object') throw new Error('computer_scroll input must be an object');
    const obj = input as Record<string, unknown>;
    const direction = obj.direction === 'up' ? 'up' : 'down';
    const amount = clampInt(obj.amount ?? 3, 1, 20, 'amount');
    const screenshotId = typeof obj.screenshotId === 'string' && obj.screenshotId.trim() ? obj.screenshotId.trim() : undefined;
    const window = typeof obj.window === 'string' && obj.window.trim() ? obj.window.trim() : undefined;
    const x = obj.x === undefined ? undefined : clampInt(obj.x, screenshotId ? -10_000 : 0, screenshotId ? 100_000 : 20_000, 'x');
    const y = obj.y === undefined ? undefined : clampInt(obj.y, screenshotId ? -10_000 : 0, screenshotId ? 100_000 : 20_000, 'y');
    if ((x === undefined) !== (y === undefined)) throw new Error('x and y must be provided together');
    if (screenshotId && x === undefined) throw new Error('x and y are required with a screenshotId (the point to scroll over)');
    return { x, y, direction, amount, ...(screenshotId ? { screenshotId } : {}), ...(window ? { window } : {}) };
  },

  async execute(input: ScrollInput, context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    let point = { x: input.x, y: input.y };
    if (input.x !== undefined && input.y !== undefined) {
      const resolved = await resolvePoint({ x: input.x, y: input.y, screenshotId: input.screenshotId, window: input.window }, context.workspaceRoot, 'computer_scroll');
      if (!resolved.ok) return fail(resolved.error);
      point = { x: resolved.x, y: resolved.y };
    }
    const delta = input.direction === 'up' ? 120 : -120;
    const move = point.x !== undefined && point.y !== undefined
      ? `[YoyInput]::SetCursorPos(${point.x}, ${point.y}) | Out-Null; Start-Sleep -Milliseconds 40; `
      : '';
    const script = `${INPUT_TYPE_DEF}\n${move}for ($i = 0; $i -lt ${input.amount}; $i++) { [YoyInput]::mouse_event([YoyInput]::Wheel, 0, 0, ${delta}, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }; Write-Output 'ok'`;
    try {
      await runPs(script);
      return { ok: true, output: `Scrolled ${input.direction} ${input.amount} notch(es)${point.x !== undefined ? ` at (${point.x}, ${point.y})` : ''}.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_scroll failed: ${message.slice(0, 500)}`);
    }
  },
};

// ── computer_drag ───────────────────────────────────────────────────────────

type DragInput = {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  screenshotId?: string;
  window?: string;
};

/**
 * Press, move, release — for canvas apps, sliders, and selecting text where
 * there is no accessible control to invoke. Both ends come from the same
 * capture, so the drag is defined against one picture of the window.
 */
export const computerDragTool: ToolDefinition<DragInput> = {
  name: 'computer_drag',
  description: 'Drag with the left mouse button from one point to another — the way to operate canvases, sliders, scrollbars and text selection that expose no invokable control. Pass the screenshotId from computer_window_shot with fromX/fromY/toX/toY in image pixels; without it the four values are absolute screen coordinates.',
  inputHint: '{ "screenshotId": "shot-1a2b3c4d", "fromX": 100, "fromY": 200, "toX": 400, "toY": 200 }',
  risk: 'shell',

  validate(input: unknown): DragInput {
    if (!input || typeof input !== 'object') throw new Error('computer_drag input must be an object');
    const obj = input as Record<string, unknown>;
    const screenshotId = typeof obj.screenshotId === 'string' && obj.screenshotId.trim() ? obj.screenshotId.trim() : undefined;
    const window = typeof obj.window === 'string' && obj.window.trim() ? obj.window.trim() : undefined;
    const min = screenshotId ? -10_000 : 0;
    const max = screenshotId ? 100_000 : 20_000;
    return {
      fromX: clampInt(obj.fromX, min, max, 'fromX'),
      fromY: clampInt(obj.fromY, min, max, 'fromY'),
      toX: clampInt(obj.toX, min, max, 'toX'),
      toY: clampInt(obj.toY, min, max, 'toY'),
      ...(screenshotId ? { screenshotId } : {}),
      ...(window ? { window } : {}),
    };
  },

  async execute(input: DragInput, context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const from = await resolvePoint({ x: input.fromX, y: input.fromY, screenshotId: input.screenshotId, window: input.window }, context.workspaceRoot, 'computer_drag');
    if (!from.ok) return fail(from.error);
    const to = await resolvePoint({ x: input.toX, y: input.toY, screenshotId: input.screenshotId, window: input.window }, context.workspaceRoot, 'computer_drag');
    if (!to.ok) return fail(to.error);
    if (from.x === to.x && from.y === to.y) return fail('computer_drag: from and to are the same point — nothing to drag.');
    // A drag is the more dangerous of the two pointer actions: pressing on a
    // point that belongs to someone else's window does not merely click it, it
    // grabs that window or its selection and moves it. Both endpoints are
    // checked, because the button goes down at one and up at the other.
    for (const point of [from, to]) {
      if (!point.capture) continue;
      const covered = await describeOcclusion(point.capture.hwnd, point.x, point.y);
      if (covered) return fail(`computer_drag: ${covered}`);
    }
    const script = [
      INPUT_TYPE_DEF,
      `[YoyInput]::SetCursorPos(${from.x}, ${from.y}) | Out-Null`,
      'Start-Sleep -Milliseconds 60',
      '[YoyInput]::mouse_event([YoyInput]::LeftDown, 0, 0, 0, [UIntPtr]::Zero)',
      // A drag that jumps straight to the target is not seen as a drag by most
      // toolkits — they need a few intermediate moves with the button down.
      '$steps = 12',
      'for ($i = 1; $i -le $steps; $i++) {',
      `  $nx = [int](${from.x} + (${to.x} - ${from.x}) * $i / $steps)`,
      `  $ny = [int](${from.y} + (${to.y} - ${from.y}) * $i / $steps)`,
      '  [YoyInput]::SetCursorPos($nx, $ny) | Out-Null',
      '  Start-Sleep -Milliseconds 15',
      '}',
      'Start-Sleep -Milliseconds 40',
      '[YoyInput]::mouse_event([YoyInput]::LeftUp, 0, 0, 0, [UIntPtr]::Zero)',
      "Write-Output 'ok'",
    ].join('\n');
    try {
      await runPs(script, 45_000);
      return { ok: true, output: `Dragged from (${from.x}, ${from.y}) to (${to.x}, ${to.y}). Capture again to verify the result.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_drag failed: ${message.slice(0, 500)}`);
    }
  },
};

// ── computer_open ────────────────────────────────────────────────────────────

type OpenComputerInput = { path: string };

export const computerOpenTool: ToolDefinition<OpenComputerInput> = {
  name: 'computer_open',
  description: 'Launch one native Windows application from a workspace-relative or allowed absolute .exe/.lnk path. Does not accept command-line arguments. Use computer_list_windows after launch, then inspect or capture the new window. Shell-risk action: approval still applies.',
  inputHint: '{ "path": "tools/MyApp.exe" }',
  risk: 'shell',
  parallelSafe: false,

  validate(input: unknown): OpenComputerInput {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('computer_open input must be an object');
    const record = input as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'path')) throw new Error('computer_open only accepts path');
    if (typeof record.path !== 'string' || !record.path.trim() || record.path.length > 2000) throw new Error('path must be a non-empty executable path');
    return { path: record.path.trim() };
  },

  async execute(input: OpenComputerInput, context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const target = resolve(isAbsolute(input.path) ? input.path : context.workspaceRoot, input.path);
    const extension = extname(target).toLowerCase();
    if (extension !== '.exe' && extension !== '.lnk') return fail('computer_open: only .exe and .lnk files can be launched; command-line arguments and scripts are not accepted.');
    const workspace = resolve(context.workspaceRoot);
    const outside = relative(workspace, target).startsWith('..') || isAbsolute(relative(workspace, target));
    if (outside && context.computerAnyApp !== true) return fail('computer_open: this path is outside the workspace. Enable 任意应用 or use a workspace-relative executable.');
    try {
      const info = await stat(target);
      if (!info.isFile()) return fail(`computer_open: not a file: ${target}`);
    } catch (error) {
      return fail(`computer_open: cannot read ${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const encoded = Buffer.from(target, 'utf8').toString('base64');
    const encodedWorkspace = Buffer.from(workspace, 'utf8').toString('base64');
    const allowOutside = context.computerAnyApp === true ? '$true' : '$false';
    const script = [
      `$requested = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
      `$workspaceRoot = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedWorkspace}'))`,
      '$launch = $requested',
      '$extension = [IO.Path]::GetExtension($requested).ToLowerInvariant()',
      'if ($extension -eq ".lnk") {',
      '  try {',
      '    $shortcutShell = New-Object -ComObject WScript.Shell',
      '    $shortcut = $shortcutShell.CreateShortcut($requested)',
      '    if (-not [string]::IsNullOrWhiteSpace([string]$shortcut.Arguments)) { Write-Output "error|shortcut arguments are not accepted"; exit 3 }',
      '    $launch = [string]$shortcut.TargetPath',
      '  } catch { Write-Output ("error|cannot resolve shortcut: " + $_.Exception.Message); exit 3 }',
      '}',
      'try { $launch = [IO.Path]::GetFullPath($launch) } catch { Write-Output "error|invalid launch target"; exit 3 }',
      'if ([IO.Path]::GetExtension($launch).ToLowerInvariant() -ne ".exe") { Write-Output "error|shortcut target must be an .exe"; exit 3 }',
      '$rootNorm = $workspaceRoot.TrimEnd("\\") + "\\"',
      '$launchNorm = $launch.TrimEnd("\\")',
      '$outsideTarget = -not ($launchNorm.StartsWith($rootNorm, [StringComparison]::OrdinalIgnoreCase) -or $launchNorm.Equals($workspaceRoot.TrimEnd("\\"), [StringComparison]::OrdinalIgnoreCase))',
      `if ($outsideTarget -and -not ${allowOutside}) { Write-Output "denied|launch target is outside the workspace"; exit 4 }`,
      'if (-not (Test-Path -LiteralPath $launch -PathType Leaf)) { Write-Output "error|launch target does not exist"; exit 3 }',
      '$working = Split-Path -Parent $launch',
      '$process = Start-Process -FilePath $launch -WorkingDirectory $working -PassThru',
      'Write-Output "started|$($process.Id)|$launch"',
    ].join('\n');
    try {
      const output = await runPs(script, 30_000);
      if (output.startsWith('denied|')) return fail(`computer_open: ${output.slice('denied|'.length)}`);
      if (output.startsWith('error|')) return fail(`computer_open: ${output.slice('error|'.length)}`);
      const parts = output.split('|');
      const pid = parts[0] === 'started' ? parts[1]?.trim() ?? '' : '';
      const launchedTarget = parts[0] === 'started' ? parts.slice(2).join('|') : '';
      if (!/^\d+$/.test(pid)) return fail(`computer_open: application started without a readable PID: ${output.slice(0, 500)}`);
      return { ok: true, output: `Started ${launchedTarget || target} (pid ${pid}). Use computer_list_windows, then computer_elements or computer_window_shot to inspect it.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_open failed: ${message.slice(0, 500)}`);
    }
  },
};
// ── computer_close ───────────────────────────────────────────────────────────

type CloseComputerInput = { window: string };

export const computerCloseTool: ToolDefinition<CloseComputerInput> = {
  name: 'computer_close',
  description: 'Request closing a native Windows window by title substring or PID. Destructive: always requires explicit approval. It never activates the target, but the app may show its own unsaved-changes dialog; use computer_list_windows afterward to verify the result.',
  inputHint: '{ "window": "12345" }',
  risk: 'shell',
  alwaysPrompt: true,
  parallelSafe: false,

  validate(input: unknown): CloseComputerInput {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('computer_close input must be an object');
    const record = input as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'window')) throw new Error('computer_close only accepts window');
    if (typeof record.window !== 'string' || !record.window.trim() || record.window.length > 200) throw new Error('window must be a non-empty title substring or PID');
    return { window: record.window.trim() };
  },

  async execute(input: CloseComputerInput, _context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const isPid = /^\d+$/.test(input.window);
    const pid = isPid ? input.window : '0';
    const title = isPid ? '' : escapePs(input.window);
    const script = [
      WINDOW_TYPE_DEF,
      WINDOW_RESOLVER,
      'Add-Type -TypeDefinition @"',
      'using System; using System.Runtime.InteropServices;',
      'public static class YoyClose { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l); }',
      '"@',
      `$hit = YoyBest @(YoyWindows) ${pid} '${title}'`,
      'if (-not $hit) { Write-Output "yoy:not-found"; exit }',
      '[YoyClose]::PostMessage([IntPtr]$hit.Hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null',
      'Start-Sleep -Milliseconds 300',
      '$still = [YoyWin]::IsWindow([IntPtr]$hit.Hwnd)',
      'Write-Output ("yoy:closed={0}|{1}" -f (-not $still), $hit.Title)',
    ].join('\n');
    try {
      const output = await runPs(script, 30_000);
      if (output.includes('yoy:not-found')) return fail(`computer_close: no window matched "${input.window}". Run computer_list_windows for candidates.`);
      const line = output.split(/\r?\n/).find((item) => item.startsWith('yoy:closed='));
      if (!line) return fail(`computer_close: no close result for "${input.window}".`);
      const closed = line.startsWith('yoy:closed=True|');
      return { ok: true, output: closed ? `Close requested for "${input.window}" and the window is gone.` : `Close requested for "${input.window}", but the window is still present; it may be waiting for an unsaved-changes decision.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_close failed: ${message.slice(0, 500)}`);
    }
  },
};
// ── computer_wait_window ────────────────────────────────────────────────────

type WaitWindowInput = { window: string; timeoutMs: number };

export const computerWaitWindowTool: ToolDefinition<WaitWindowInput> = {
  name: 'computer_wait_window',
  description: 'Wait for a native Windows window matching a title substring or PID without activating it or changing foreground focus. Use after computer_open before computer_elements or computer_window_shot.',
  inputHint: '{ "window": "My App", "timeoutMs": 10000 }',
  risk: 'read',
  parallelSafe: false,

  validate(input: unknown): WaitWindowInput {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('computer_wait_window input must be an object');
    const record = input as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'window' && key !== 'timeoutMs')) throw new Error('computer_wait_window only accepts window and timeoutMs');
    if (typeof record.window !== 'string' || !record.window.trim() || record.window.length > 200) throw new Error('window must be a non-empty title substring or PID');
    const timeoutMs = record.timeoutMs === undefined ? 10_000 : Number(record.timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error('timeoutMs must be an integer from 100 to 30000');
    return { window: record.window.trim(), timeoutMs };
  },

  async execute(input: WaitWindowInput, _context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    const isPid = /^\d+$/.test(input.window);
    const pid = isPid ? input.window : '0';
    const title = isPid ? '' : escapePs(input.window);
    const script = [
      WINDOW_TYPE_DEF,
      WINDOW_RESOLVER,
      `$deadline = [DateTime]::UtcNow.AddMilliseconds(${input.timeoutMs})`,
      'while ([DateTime]::UtcNow -lt $deadline) {',
      `  $hit = YoyBest @(YoyWindows) ${pid} '${title}'`,
      '  if ($hit) {',
      '    Write-Output ("yoy:window={0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}|{8}|{9}" -f $hit.Pid, $hit.AppPid, $hit.Class, $hit.Cloaked, $hit.Iconic, $hit.Left, $hit.Top, $hit.Right, $hit.Bottom, $hit.Title)',
      '    exit',
      '  }',
      '  Start-Sleep -Milliseconds 100',
      '}',
      'Write-Output "yoy:timeout"',
    ].join('\n');
    try {
      const output = await runPs(script, input.timeoutMs + 5_000);
      const line = output.split(/\r?\n/).find((item) => item.startsWith('yoy:window='));
      if (!line) return fail(`computer_wait_window: timed out after ${input.timeoutMs}ms waiting for "${input.window}".`);
      return { ok: true, output: `Window "${input.window}" is available without changing foreground focus. ${line.slice('yoy:window='.length)}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_wait_window failed: ${message.slice(0, 500)}`);
    }
  },
};
// ── computer_list_windows ───────────────────────────────────────────────────

type ListWindowsInput = Record<string, never>;

export const computerListWindowsTool: ToolDefinition<ListWindowsInput> = {
  name: 'computer_list_windows',
  description: 'List visible top-level windows with pid, the packaged app\'s own pid (if any), class, cloaked/iconic state, restored geometry and title. Pure read — the user\'s foreground window is untouched. Use before computer_activate/computer_elements to find the target. Packaged apps (设置, 计算器) show their frame-host pid with the real app pid beside it; either one works for the other tools.',
  inputHint: '{}',
  risk: 'read',

  validate(): ListWindowsInput {
    return {};
  },

  async execute(_input: ListWindowsInput, _context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    // EnumWindows rather than Get-Process: a packaged app's own process has no
    // MainWindowTitle (the frame host owns it), so 设置 appeared only as
    // "26956|ApplicationFrameHost|设置" — a pid that computer_elements then
    // refused, because no UIA element carries 26956. The resolver below matches
    // either the frame's pid or the app's real pid.
    const script = [
      WINDOW_TYPE_DEF,
      'Write-Output ("yoy:screen=" + [YoyWin]::Screen())',
      'foreach ($row in [YoyWin]::Windows()) {',
      '  $f = $row -split "\\|", 13',
      '  if ([int]$f[5] -lt 40 -or [int]$f[6] -lt 40) { continue }',
      '  Write-Output ("{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}|{8}|{9}" -f $f[1], $f[2], $f[7], $f[3], $f[4], $f[8], $f[9], $f[10], $f[11], $f[12])',
      '}',
    ].join('\n');
    try {
      const out = await runPs(script);
      const screenLine = out.split(/\r?\n/).find((line) => line.startsWith('yoy:screen='));
      const [sx, sy, sw, sh] = (screenLine?.slice('yoy:screen='.length) ?? '').split('|').map(Number);
      const screen = [sx, sy, sw, sh].every((n) => Number.isFinite(n)) && sw > 0 && sh > 0
        ? { left: sx, top: sy, width: sw, height: sh }
        : null;
      const rows = out.split(/\r?\n/).filter((line) => line && !line.startsWith('yoy:'));
      if (rows.length === 0) return { ok: true, output: '(no visible windows with titles found)', data: { windows: [], screen } };
      const windows = rows.map(parseWindowLine).filter((w): w is WindowInfo => w !== null);
      return {
        ok: true,
        output: `${rows.length} window(s) — "pid|appPid|class|cloaked|iconic|left|top|right|bottom|title". Use the pid with computer_elements/computer_press; a non-zero appPid is the packaged app's own process (the pid column is its frame host). cloaked=1 means the window is off-screen (another virtual desktop / hidden), iconic=1 that it is minimized — and its geometry is then the placement it would be restored to, not where it is now. Reading a window with computer_elements never brings it forward; use computer_activate when it must come to the front.\n${rows.join('\n')}`,
        // Raw geometry travels in data so the desktop window map can draw each
        // window where it is without re-parsing the human-readable text.
        data: { windows, screen },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_list_windows failed: ${message.slice(0, 500)}`);
    }
  },
};

/** One window row, as both the tool output line and the panel's map entry. */
export type WindowInfo = {
  pid: number;
  appPid: number;
  class: string;
  cloaked: boolean;
  /**
   * Minimized. Its left/top/right/bottom describe the placement it WOULD be
   * restored to, not a rectangle on screen — GetWindowRect on a minimized
   * window returns the 158x26 taskbar stub at -21333, which is useless to
   * everyone, so the restored placement is reported in its place. Anything that
   * turns these numbers into a click has to check this flag first.
   */
  iconic: boolean;
  title: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/**
 * Parse one `pid|appPid|class|cloaked|iconic|left|top|right|bottom|title` line.
 *
 * The title is the last field and is taken from the *remainder* of the line, so
 * a window whose title contains `|` ("a | b - Chrome") keeps it instead of
 * producing shifted numbers. Returns null for a malformed row rather than
 * throwing: one odd window must not blank the whole list.
 */
export function parseWindowLine(line: string): WindowInfo | null {
  const parts = line.split('|');
  if (parts.length < 10) return null;
  const [pid, appPid, cls, cloaked, iconic, left, top, right, bottom] = parts;
  const nums = [pid, appPid, left, top, right, bottom].map((value) => Number(value));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [p, a, l, t, r, b] = nums;
  return {
    pid: p, appPid: a, class: cls ?? '', cloaked: cloaked === '1', iconic: iconic === '1',
    left: l, top: t, right: r, bottom: b,
    title: parts.slice(9).join('|'),
  };
}

// ── computer_activate ───────────────────────────────────────────────────────

type ActivateInput = { target: string };

export const computerActivateTool: ToolDefinition<ActivateInput> = {
  name: 'computer_activate',
  description: 'Bring a window to the foreground and focus it, by pid (e.g. "12345") or by title substring (e.g. "记事本"). Required before computer_type/computer_key reach the intended app. This is the only tool that moves the user\'s focus, so call it only when the task actually needs that window in front — never as a side effect of inspecting one. Takes `window` like the other computer_* tools; `target` is accepted as an alias.',
  inputHint: '{ "window": "Notepad" }',
  risk: 'shell',

  validate(input: unknown): ActivateInput {
    if (!input || typeof input !== 'object') throw new Error('computer_activate input must be an object');
    const obj = input as Record<string, unknown>;
    // `window` is what every other computer_* tool calls this, so accepting it
    // here removes a trap: passing {window} used to throw a raw TypeError out
    // of execute instead of failing as a tool result.
    const target = obj.window ?? obj.target;
    if (typeof target !== 'string' || !target.trim()) {
      throw new Error('window is required (pid or title substring, e.g. {"window":"Notepad"})');
    }
    if (target.length > 200) throw new Error('target is too long');
    return { target: target.trim() };
  },

  async execute(input: ActivateInput, _context: ToolContext): Promise<ToolResult> {
    if (!isWindows()) return fail(WINDOWS_ONLY);
    // Bring the window forward, then READ BACK who actually holds the
    // foreground. WScript.Shell AppActivate was the old implementation and it
    // is not trustworthy here: measured on this machine it returned success for
    // Notepad while a fullscreen game still held the foreground, so
    // computer_activate reported a focus it had not taken and the next
    // computer_type went to the wrong window.
    //
    // This is the ONLY tool that moves focus, and it does so only because it was
    // called. See YoyElementAt: reading a window never activates it.
    const isPid = /^\d+$/.test(input.target);
    const pidArg = isPid ? input.target : '0';
    const titleArg = isPid ? '' : escapePs(input.target);
    const script = [
      WINDOW_TYPE_DEF,
      WINDOW_RESOLVER,
      '$hit = $null',
      `foreach ($w in @(YoyWindows)) { if (YoyMatch $w ${pidArg} '${titleArg}') { $hit = $w; break } }`,
      `if (-not $hit) { Write-Output 'not-found'; exit }`,
      '[YoyWin]::Activate([IntPtr]$hit.Hwnd) | Out-Null',
      'Start-Sleep -Milliseconds 200',
      'Write-Output ("fg=" + [YoyWin]::Foreground())',
    ].join('\n');
    try {
      const out = await runPs(script, 45_000);
      const lines = out.split(/\r?\n/);
      if (lines.includes('not-found')) {
        return fail(`computer_activate: no window matched "${input.target}". Run computer_list_windows to see candidates.`);
      }
      const fg = lines.find((line) => line.startsWith('fg='))?.slice(3) ?? '';
      const [fgPid, fgAppPid, fgClass, ...fgTitleParts] = fg.split('|');
      const focusTitle = fgTitleParts.join('|');
      // Verify by title *or* pid: a packaged app's frame reports the host's pid,
      // so an app-pid target only matches on the real pid column.
      const stuck = isPid
        ? fgPid !== input.target && fgAppPid !== input.target
        : !focusTitle.includes(input.target) && !fgClass.includes(input.target);
      if (stuck) {
        return fail(
          `computer_activate: "${input.target}" did not take focus — "${focusTitle || fgClass}" (pid ${fgPid}) still has it. `
          + 'Windows refused the foreground switch (another app is holding it, often a fullscreen or elevated window). '
          + 'Retry, or click the window with computer_click first.',
        );
      }
      return { ok: true, output: `Activated "${focusTitle || input.target}" (pid ${fgPid}). It is now focused.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`computer_activate failed: ${message.slice(0, 500)}`);
    }
  },
};

export function createComputerTools(): ToolDefinition[] {
  return [
    computerElementsTool,
    computerPressTool,
    computerScreenshotTool,
    computerWindowShotTool,
    computerClickTool,
    computerDragTool,
    computerTypeTool,
    computerKeyTool,
    computerScrollTool,
    computerListWindowsTool,
    computerActivateTool,
    computerOpenTool,
    computerCloseTool,
    computerWaitWindowTool,
  ];
}
