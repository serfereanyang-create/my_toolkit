const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const cliRoot = path.resolve(root, '..', 'cli');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const cliTscBin = path.join(cliRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const electronBin = resolveElectronBinary(root);

const cliBuild = spawn(process.execPath, [cliTscBin, '-p', 'tsconfig.json'], {
  cwd: cliRoot,
  stdio: 'inherit',
});
cliBuild.once('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);
  startDevServer();
});

function startDevServer() {
  const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', '5174'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

pipeOutput(vite.stdout, process.stdout);
pipeOutput(vite.stderr, process.stderr);

waitForViteUrl(vite).then((url) => {
  const electron = spawn(electronBin, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: url },
  });
  electron.on('exit', (code) => {
    vite.kill();
    process.exit(code ?? 0);
  });
}).catch((error) => {
  console.error(error.message);
  vite.kill();
  process.exit(1);
});

  process.on('SIGINT', () => {
    vite.kill();
    process.exit(130);
  });
}

function resolveElectronBinary(projectRoot) {
  const distDir = path.join(projectRoot, 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(distDir, 'electron.exe');
  if (process.platform === 'darwin') return path.join(distDir, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(distDir, 'electron');
}

function pipeOutput(stream, target) {
  if (!stream) return;
  stream.on('data', (chunk) => target.write(chunk));
}

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function waitForViteUrl(child) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    let buffer = '';
    let settled = false;

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };

    const matchUrl = (chunk) => {
      buffer = `${buffer}${stripAnsi(chunk)}`.slice(-4000);
      const match = buffer.match(/https?:\/\/127\.0\.0\.1:\d+\//);
      if (!match) return;
      const url = match[0];
      waitFor(url).then(() => finish(resolve, url)).catch((error) => finish(reject, error));
    };

    if (child.stdout) child.stdout.on('data', (chunk) => matchUrl(String(chunk)));
    if (child.stderr) child.stderr.on('data', (chunk) => matchUrl(String(chunk)));
    child.once('exit', (code) => {
      if (settled) return;
      finish(reject, new Error(`Vite exited before reporting a dev URL (code ${code ?? 'unknown'})`));
    });

    const timer = setInterval(() => {
      if (settled) {
        clearInterval(timer);
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        finish(reject, new Error('Timed out waiting for Vite to report a dev URL'));
      }
    }, 250);
  });
}

function waitFor(target) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const tick = () => {
      const req = http.get(target, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${target}`));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}
