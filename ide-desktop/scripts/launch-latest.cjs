const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..');
const cliRoot = path.join(repoRoot, 'cli');
const launchLogPath = path.join(desktopRoot, '.aicode', 'launcher-error.log');

const nodeBin = process.execPath;
const tscBin = path.join(desktopRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const viteBin = path.join(desktopRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const iconBuildScript = path.join(desktopRoot, 'scripts', 'build-icons.cjs');
const cliTscBin = path.join(cliRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const electronBin = resolveElectronBinary(desktopRoot);

const desktopOutputs = [
  path.join(desktopRoot, 'dist', 'index.html'),
  path.join(desktopRoot, 'dist', 'assets'),
  path.join(desktopRoot, 'dist', 'icon.svg'),
  path.join(desktopRoot, 'dist', 'icon-16.png'),
  path.join(desktopRoot, 'dist', 'icon-32.png'),
  path.join(desktopRoot, 'resources', 'icon.ico'),
  path.join(desktopRoot, 'resources', 'yoycode-app.ico'),
];
const desktopSources = [
  path.join(desktopRoot, 'src'),
  path.join(desktopRoot, 'electron'),
  path.join(desktopRoot, 'resources', 'icon.svg'),
  iconBuildScript,
  path.join(desktopRoot, 'index.html'),
  path.join(desktopRoot, 'package.json'),
  path.join(desktopRoot, 'tsconfig.json'),
  path.join(desktopRoot, 'vite.config.ts'),
];
const cliOutputs = [path.join(cliRoot, 'dist', 'src', 'index.js')];
const cliSources = [
  path.join(cliRoot, 'src'),
  path.join(cliRoot, 'package.json'),
  path.join(cliRoot, 'tsconfig.json'),
];

try {
  clearLaunchLog();

  if (needsBuild(desktopSources, desktopOutputs)) {
    run(nodeBin, [iconBuildScript], desktopRoot, 'Icon build failed for ide-desktop');
    run(nodeBin, [tscBin, '-p', 'tsconfig.json'], desktopRoot, 'TypeScript build failed for ide-desktop');
    run(nodeBin, [viteBin, 'build'], desktopRoot, 'Vite build failed for ide-desktop');
  }

  if (needsBuild(cliSources, cliOutputs)) {
    run(nodeBin, [cliTscBin, '-p', 'tsconfig.json'], cliRoot, 'TypeScript build failed for cli');
  }

  // Launch the real GUI. When this launcher is itself run via electron-as-node
  // (ELECTRON_RUN_AS_NODE=1), that flag MUST be stripped here, otherwise the
  // spawned electron would boot as a plain Node runtime and no window appears.
  const guiEnv = { ...process.env };
  delete guiEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, ['.'], {
    cwd: desktopRoot,
    detached: true,
    stdio: 'ignore',
    env: guiEnv,
  });
  child.unref();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeLaunchLog(message);
  process.exit(1);
}

function run(command, args, cwd, failureMessage) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  });
  if (result.status !== 0) {
    const stdout = normalizeOutput(result.stdout);
    const stderr = normalizeOutput(result.stderr);
    const detail = [
      failureMessage,
      stdout ? `stdout:\n${stdout}` : '',
      stderr ? `stderr:\n${stderr}` : '',
    ].filter(Boolean).join('\n\n');
    throw new Error(detail || failureMessage);
  }
}

function normalizeOutput(buffer) {
  const text = buffer ? String(buffer.toString('utf8')) : '';
  return text
    .split(/\r?\n/)
    .filter((line) => !line.includes("The CJS build of Vite's Node API is deprecated"))
    .join('\n')
    .trim();
}

function clearLaunchLog() {
  try {
    fs.rmSync(launchLogPath, { force: true });
  } catch {
    // ignore stale log cleanup failure
  }
}

function writeLaunchLog(message) {
  fs.mkdirSync(path.dirname(launchLogPath), { recursive: true });
  fs.writeFileSync(launchLogPath, `${message}\n`, 'utf8');
}

function needsBuild(sources, outputs) {
  const sourceTime = newestMtime(sources);
  return outputs.some((output) => newestForPath(output) < sourceTime);
}

function newestMtime(paths) {
  let newest = 0;
  for (const target of paths) newest = Math.max(newest, newestForPath(target));
  return newest;
}

function newestForPath(target) {
  if (!fs.existsSync(target)) return 0;
  const stat = fs.statSync(target);
  if (stat.isFile()) return stat.mtimeMs;
  if (!stat.isDirectory()) return 0;

  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(target)) {
    newest = Math.max(newest, newestForPath(path.join(target, entry)));
  }
  return newest;
}

function resolveElectronBinary(projectRoot) {
  const distDir = path.join(projectRoot, 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(distDir, 'electron.exe');
  if (process.platform === 'darwin') return path.join(distDir, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(distDir, 'electron');
}
