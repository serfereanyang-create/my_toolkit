/**
 * Live check of the 电脑操控 path against real windows on this machine.
 *
 * Asserts the invariant the user asked for twice: listing and reading windows
 * must never move the foreground window. Prints the foreground title before and
 * after so a failure shows what took focus instead of just "false".
 *
 * Run: node scripts/gui-panel-live.cjs
 */
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const cliRoot = path.resolve(__dirname, '..', '..', 'cli');
const entry = path.join(cliRoot, 'dist', 'src', 'index.js');

/**
 * The foreground window's title, read with plain Win32. Deliberately not via
 * the CLI: this is the outside observer that says whether a tool grabbed the
 * desktop, so it must not share code with the thing being checked.
 */
function foregroundTitle() {
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -Namespace Fg -Name W -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);\'',
    '$b = New-Object System.Text.StringBuilder 512',
    '[void][Fg.W]::GetWindowText([Fg.W]::GetForegroundWindow(), $b, 512)',
    '[Console]::Out.Write($b.ToString())',
  ].join('\n');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  }).trim();
}

function call(tool, input = {}) {
  // A refused action exits non-zero on purpose (the panel reads the JSON line
  // and the code together), so a non-zero exit is a result, not a crash.
  let raw;
  try {
    raw = execFileSync(process.execPath, [entry, '--gui-tool', tool, '--gui-input', JSON.stringify(input)], {
      cwd: cliRoot, encoding: 'utf8', timeout: 90000, windowsHide: true,
    });
  } catch (error) {
    if (typeof error?.stdout !== 'string' || !error.stdout.trim()) throw error;
    raw = error.stdout;
  }
  const line = raw.trim().split('\n').filter(Boolean).at(-1);
  return JSON.parse(line);
}

const checks = [];
const check = (name, ok, extra = '') => checks.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);

const before = foregroundTitle();
const listed = call('computer_list_windows');
check('the window list is produced', listed.ok === true, listed.error || '');
const windows = listed.data?.windows ?? [];
check('real windows are listed', windows.length > 0, `${windows.length} windows`);
check('the screen geometry is reported', Boolean(listed.data?.screen), JSON.stringify(listed.data?.screen));
check('listing windows leaves focus where it was', foregroundTitle() === before, `was "${before}"`);

// Reads only what is already open. This script never starts, moves, minimizes,
// or focuses a window — including a scratch one of its own — because doing so
// takes the desktop away from whoever is using the computer. A test that
// interrupts the user to prove "nothing interrupts the user" is worthless.
const pick = (list) => list
  .filter((w) => !w.cloaked && (w.right - w.left) >= 300 && (w.bottom - w.top) >= 200)
  .sort((a, b) => ((b.right - b.left) * (b.bottom - b.top)) - ((a.right - a.left) * (a.bottom - a.top)));
const ranked = pick(windows);
// Prefer an ordinary desktop app; a UWP shell and compositor overlays can
// legitimately expose no printable surface, which would prove nothing about
// the background screenshot path.
const target = ranked.find((w) => w.class !== 'Windows.UI.Core.CoreWindow'
  && w.class !== 'CEF-OSC-WIDGET'
  && w.class !== 'Progman'
  && !/overlay|nvidia/i.test(w.title)) ?? ranked[0];

if (!target) {
  check('a window big enough to read is open', false, 'nothing to read right now');
} else {
  const hint = `「${target.title}」(${target.class}, pid ${target.pid})`;
  const elements = call('computer_elements', { window: String(target.pid) });
  const lines = String(elements.output ?? '').split('\n').filter((line) => /^\d+\|/.test(line));
  check(`reading ${hint} succeeds`, elements.ok === true, elements.error || '');
  check('the read is a real answer', elements.ok === true, `${lines.length} controls`);

  // One sample cannot tell "the tool grabbed focus" from "the person clicked
  // something". Repeat: a tool that activates on read fails every round, while
  // unrelated activity shows up as a single round whose before/after differ.
  const rounds = [];
  for (let i = 0; i < 5; i += 1) {
    const beforeRead = foregroundTitle();
    const read = call('computer_elements', { window: String(target.pid) });
    const afterRead = foregroundTitle();
    rounds.push({ beforeRead, afterRead, ok: read.ok });
  }
  const held = rounds.filter((r) => r.beforeRead === r.afterRead).length;
  check(`reading ${hint} left focus alone in every round`, held === rounds.length,
    `${held}/${rounds.length} · ${rounds.map((r) => `${r.beforeRead}→${r.afterRead}`).join(' | ')}`);
  check('the window that had focus still has it', foregroundTitle() === before, `was "${before}"`);
  const beforeShot = foregroundTitle();
  const shot = call('computer_window_shot', { window: String(target.pid) });
  const image = shot.data?.computerImage;
  check(`background screenshot of ${hint} succeeds`, shot.ok === true, shot.error || '');
  check('background screenshot returns PNG pixels', image?.mediaType === 'image/png' && typeof image.data === 'string' && image.data.length > 0, image ? `${image.data.length} base64 chars` : 'no image');
  check('background screenshot leaves focus where it was', foregroundTitle() === beforeShot, `was "${beforeShot}"`);
}

// Activation must fail loudly rather than pretend, when Windows refuses.
const refused = call('computer_activate', { window: 'no-such-window-title-xyz' });
check('activating a missing window is an error, not a no-op success', refused.ok === false, refused.error || '');

console.log(checks.join('\n'));
const failures = checks.filter((line) => line.startsWith('FAIL')).length;
console.log(`\nSUMMARY: ${checks.length - failures}/${checks.length} passed`);
process.exitCode = failures > 0 ? 1 : 0;
