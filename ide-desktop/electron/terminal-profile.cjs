/*
 * Shell profile discovery — compact port of zcode's terminalProfile service.
 * Enumerates the shells actually available on this machine so the terminal
 * UI can offer a picker; the first entry is the recommended default.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function existsOnPath(file) {
  if (file.includes(path.sep) || file.includes('/')) {
    return fs.existsSync(file);
  }
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return pathDirs.some((dir) => {
    const direct = path.join(dir, file);
    if (fs.existsSync(direct)) return true;
    // Windows resolves bare commands with an implicit .exe extension.
    if (process.platform === 'win32' && !file.toLowerCase().endsWith('.exe') && fs.existsSync(`${direct}.exe`)) return true;
    return false;
  });
}

function fileExists(...segments) {
  try {
    return fs.existsSync(path.join(...segments));
  } catch {
    return false;
  }
}

function listShellProfiles() {
  if (process.platform === 'win32') {
    const profiles = [
      { id: 'powershell', name: 'PowerShell', file: 'powershell.exe', args: ['-NoLogo'] },
      { id: 'cmd', name: '命令提示符', file: 'cmd.exe', args: [] },
    ];
    // PowerShell 7 lives beside the Windows one when installed.
    if (fileExists(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')) {
      profiles.unshift({ id: 'pwsh', name: 'PowerShell 7', file: path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'), args: ['-NoLogo'] });
    }
    // Git for Windows installs bash in one of these two layouts.
    for (const gitRoot of ['C:\\Program Files\\Git', 'C:\\Program Files (x86)\\Git', path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git')]) {
      if (fileExists(gitRoot, 'bin', 'bash.exe')) {
        profiles.push({ id: 'gitbash', name: 'Git Bash', file: path.join(gitRoot, 'bin', 'bash.exe'), args: ['-i', '-l'] });
        break;
      }
    }
    if (fileExists(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')) {
      profiles.push({ id: 'wsl', name: 'WSL', file: 'wsl.exe', args: [] });
    }
    return profiles.filter((profile) => profile.file.includes('\\') ? fs.existsSync(profile.file) : existsOnPath(profile.file));
  }

  const profiles = [];
  const loginShell = process.env.SHELL;
  if (loginShell) profiles.push({ id: path.basename(loginShell), name: loginShell, file: loginShell, args: ['-i'] });
  for (const [id, name, file] of [['zsh', 'Zsh', '/bin/zsh'], ['bash', 'Bash', '/bin/bash'], ['sh', 'Sh', '/bin/sh']]) {
    if (!profiles.some((profile) => profile.file === file) && fs.existsSync(file)) {
      profiles.push({ id, name, file, args: ['-i'] });
    }
  }
  return profiles;
}

module.exports = { listShellProfiles };
