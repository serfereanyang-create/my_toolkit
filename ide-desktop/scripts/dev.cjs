const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const url = 'http://127.0.0.1:5174';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const vite = spawn(npx, ['vite', '--host', '127.0.0.1', '--port', '5174'], {
  cwd: root,
  stdio: 'inherit',
});

waitFor(url).then(() => {
  const electron = spawn(npx, ['electron', '.'], {
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
