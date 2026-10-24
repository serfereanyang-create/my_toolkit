'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');

function createBackgroundProcessJob(processId, profile) {
  if (process.platform !== 'win32') return Promise.resolve(undefined);
  if (!Number.isSafeInteger(processId) || processId < 1) return Promise.reject(new Error('无效的后台进程 ID。'));
  if (typeof profile !== 'string' || !path.isAbsolute(profile) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(path.basename(profile))) return Promise.reject(new Error('无效的后台进程归属标记。'));
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'background-process-job.ps1'), '-TargetProcessId', String(processId), '-ExpectedProfile', profile], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false;
  let errors = '';
  let output = '';
  const stopped = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
  child.stdin.on('error', () => {});
  child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4000); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('后台进程回收保护启动超时。')); }, 15_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`后台进程回收保护失败（${code}）：${errors}`)); });
    child.stdout.on('data', chunk => {
      output = (output + chunk.toString()).slice(-1024);
      if (!output.includes('YOY_JOB_READY')) return;
      clearTimeout(timer);
      resolve({
        processId: child.pid,
        async close() {
          if (!exited) child.stdin.end();
          await stopped;
        },
      });
    });
  });
}

module.exports = { createBackgroundProcessJob };
