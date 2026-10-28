'use strict';
require('./lib/probe-guard.cjs');


const { app, BrowserWindow, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pickWorkspaceFile } = require('../electron/file-picker.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'native-dialog-review');
const fixture = path.join(output, 'fixture');
const title = 'YOYcode Native File Picker';
const reports = [];

function runPowerShell(action, target) {
  const escapedTitle = title.replace(/'/g, "''");
  const escapedTarget = target.replace(/'/g, "''");
  const command = action === 'pick'
    ? `$title='${escapedTitle}'; $target='${escapedTarget}'; Add-Type @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeDialogWindows {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  public static string[] Titles() { var result = new List<string>(); EnumWindows((hWnd, extra) => { if (!IsWindowVisible(hWnd)) return true; var text = new StringBuilder(512); GetWindowText(hWnd, text, text.Capacity); if (text.Length > 0) result.Add(text.ToString()); return true; }, IntPtr.Zero); return result.ToArray(); }
}
'@; $shell=New-Object -ComObject WScript.Shell; $deadline=(Get-Date).AddSeconds(15); do { $windowTitle=[NativeDialogWindows]::Titles() | Where-Object { $_ -eq $title -or $_ -match '^(Open|打开|选择|文件)' } | Select-Object -First 1; if ($windowTitle) { break }; Start-Sleep -Milliseconds 100 } while ((Get-Date) -lt $deadline); if (-not $windowTitle) { [Console]::Error.WriteLine(([NativeDialogWindows]::Titles() -join ' | ')); exit 2 }; $shell.AppActivate($windowTitle) | Out-Null; Start-Sleep -Milliseconds 250; $shell.SendKeys('%n'); Start-Sleep -Milliseconds 100; $shell.SendKeys('^a'); $shell.SendKeys($target); Start-Sleep -Milliseconds 100; $shell.SendKeys('{ENTER}')`
    : `$title='${escapedTitle}'; Add-Type @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeDialogWindows {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  public static string[] Titles() { var result = new List<string>(); EnumWindows((hWnd, extra) => { if (!IsWindowVisible(hWnd)) return true; var text = new StringBuilder(512); GetWindowText(hWnd, text, text.Capacity); if (text.Length > 0) result.Add(text.ToString()); return true; }, IntPtr.Zero); return result.ToArray(); }
}
'@; $shell=New-Object -ComObject WScript.Shell; $deadline=(Get-Date).AddSeconds(15); do { $windowTitle=[NativeDialogWindows]::Titles() | Where-Object { $_ -eq $title -or $_ -match '^(Open|打开|选择|文件)' } | Select-Object -First 1; if ($windowTitle) { break }; Start-Sleep -Milliseconds 100 } while ((Get-Date) -lt $deadline); if (-not $windowTitle) { [Console]::Error.WriteLine(([NativeDialogWindows]::Titles() -join ' | ')); exit 2 }; $shell.AppActivate($windowTitle) | Out-Null; Start-Sleep -Milliseconds 250; $shell.SendKeys('{ESC}')`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`PowerShell dialog automation exited with ${code}`)));
  });
}

async function check(name, action) {
  try {
    await action();
    reports.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    reports.push({ name, ok: false, error: error.stack || String(error) });
    console.error(`FAIL ${name}: ${error.stack || error}`);
    throw error;
  }
}

async function choose(window, action) {
  const promise = pickWorkspaceFile({
    dialog,
    owner: window,
    root: fixture,
    options: { title, filters: [{ name: '文本文件', extensions: ['txt'] }] },
    stat: (filePath) => fs.stat(filePath),
  });
  await runPowerShell(action, path.join(fixture, 'pick-me.txt'));
  return promise;
}

async function main() {
  await fs.mkdir(fixture, { recursive: true });
  await fs.writeFile(path.join(fixture, 'pick-me.txt'), 'native picker fixture\n', 'utf8');
  await fs.writeFile(path.join(fixture, 'ignore.json'), '{}\n', 'utf8');
  const window = new BrowserWindow({ show: true, width: 520, height: 320, title, webPreferences: { contextIsolation: true, sandbox: true } });

  await check('real Windows dialog returns the selected file under the locked workspace root', async () => {
    const result = await choose(window, 'pick');
    assert.deepEqual(result, { ok: true, path: path.join(fixture, 'pick-me.txt'), size: Buffer.byteLength('native picker fixture\n') });
  });
  await check('real Windows dialog cancellation stays explicit', async () => {
    const result = await choose(window, 'cancel');
    assert.deepEqual(result, { ok: false, canceled: true });
  });
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ title, fixture, reports }, null, 2), 'utf8');
  await window.destroy();
}

app.whenReady().then(() => main().then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); }));
