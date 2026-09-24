'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const os = require('node:os');
const { terminateProcessTree } = require('./process-tree.cjs');
const { listShellProfiles } = require('./terminal-profile.cjs');

/*
 * Terminal manager (pipe-based fallback).
 *
 * Windows encoding: cmd.exe / PowerShell default to system code page (GBK on
 * Chinese Windows). We launch PowerShell and set UTF-8 encoding via start-up
 * args BEFORE any output is produced, which is the only reliable fix.
 */

function defaultShell() {
  if (process.platform !== 'win32') {
    return { file: process.env.SHELL || '/bin/bash', args: ['-i'] };
  }
  // PowerShell: set UTF-8 encoding as very first thing, then stay interactive.
  // -Command runs the encoding setup; the trailing `& powershell` keeps a
  // live prompt open.  Using -NoLogo suppresses the copyright header (which
  // would otherwise be emitted in GBK before encoding is set).
  return {
    file: 'powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
      '[Console]::InputEncoding=[System.Text.Encoding]::UTF8;' +
      '$OutputEncoding=[System.Text.Encoding]::UTF8;' +
      'powershell.exe -NoLogo -NoProfile',
    ],
  };
}

function buildEnv() {
  const env = { ...process.env };
  if (process.platform === 'win32') {
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUTF8 = '1';
  }
  return env;
}

class TerminalManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.seq = 0;
  }

  create({ cwd } = {}) {
    const id = `term-${++this.seq}`;
    const shell = defaultShell();
    const workingDir = cwd && typeof cwd === 'string' ? cwd : os.homedir();

    let child;
    try {
      child = spawn(shell.file, shell.args, {
        cwd: workingDir,
        env: buildEnv(),
        windowsHide: true,
      });
    } catch (error) {
      this.emit('event', { id, type: 'exit', code: -1, error: String(error && error.message) });
      return { id, cwd: workingDir, shell: shell.file };
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.emit('event', { id, type: 'data', data: chunk }));
    child.stderr.on('data', (chunk) => this.emit('event', { id, type: 'data', data: chunk }));
    child.on('exit', (code) => {
      this.sessions.delete(id);
      this.emit('event', { id, type: 'exit', code: code ?? 0 });
    });
    child.on('error', (error) => {
      this.emit('event', { id, type: 'data', data: `\r\n[terminal error] ${error.message}\r\n` });
    });

    this.sessions.set(id, child);
    return { id, cwd: workingDir, shell: shell.file };
  }

  write(id, data) {
    const child = this.sessions.get(id);
    if (!child || !child.stdin.writable) return { ok: false };
    child.stdin.write(data);
    return { ok: true };
  }

  resize() { return { ok: true }; }

  kill(id) {
    const child = this.sessions.get(id);
    if (!child) return Promise.resolve({ ok: false });
    this.sessions.delete(id);
    // child.kill() alone orphans everything the user started inside the
    // terminal (dev servers, watchers...). Terminate the whole tree instead.
    return terminateProcessTree(child, { forceAfterMs: 2000 }).then((result) => ({ ok: true, forced: result.forced }));
  }

  disposeAll() {
    const terminations = [];
    for (const [, child] of this.sessions) {
      terminations.push(terminateProcessTree(child, { forceAfterMs: 1000 }).catch(() => {}));
    }
    this.sessions.clear();
    return Promise.all(terminations);
  }
}

module.exports = { TerminalManager, defaultShell, listShellProfiles };
