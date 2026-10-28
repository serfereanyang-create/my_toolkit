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

/*
 * 什么时候该重新构建 —— 只比「真正由构建写出来的文件」的 mtime。
 *
 * 原来的写法是：只要 outputs 里有任何一个比最新的源码旧，就整包重来。而
 * dist/icon.svg、dist/icon-16.png、dist/icon-32.png 是 vite 从 resources/ 直接
 * 拷进 dist 的，拷完的 mtime 跟着源文件走（resources/icon.svg 比仓库里最新的
 * 源码还老），所以 needsBuild() 永远为真 —— 每次双击启动都要先跑一遍
 * icons + tsc + vite（≈1 分钟）才见得到窗口。用户看到的就是「每次加载半天」。
 *
 * 现在分成两组：
 *   buildArtifacts  —— 构建产物，mtime 就是「上次构建完成的时刻」，拿它和源码比；
 *   requiredOutputs —— 还必须存在，但 mtime 不能当构建时间用（那些拷贝来的图标）。
 */
const desktopBuildArtifacts = [
  path.join(desktopRoot, 'dist', 'index.html'),
  path.join(desktopRoot, 'dist', 'assets'),
  path.join(desktopRoot, 'resources', 'icon.ico'),
  path.join(desktopRoot, 'resources', 'yoycode-app.ico'),
];
const desktopOutputs = [
  ...desktopBuildArtifacts,
  path.join(desktopRoot, 'dist', 'icon.svg'),
  path.join(desktopRoot, 'dist', 'icon-16.png'),
  path.join(desktopRoot, 'dist', 'icon-32.png'),
];
const desktopSources = [
  path.join(desktopRoot, 'src'),
  // electron/*.cjs 故意不在这里：主进程和 preload 是运行时直接加载的源码，
  // tsc/vite 都不碰它们，改一行 main.cjs 不该触发一次 40 秒的整包构建。
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

  const desktopStale = needsBuild(desktopSources, desktopOutputs, desktopBuildArtifacts);
  const cliStale = needsBuild(cliSources, cliOutputs, cliOutputs);

  // 冒烟/排查用：只看判定结果，不构建也不起窗口。
  if (process.env.YOYCODE_LAUNCH_DRY_RUN === '1') {
    console.log(JSON.stringify({
      wouldBuildDesktop: desktopStale,
      wouldBuildCli: cliStale,
      newestDesktopSourceMs: newestMtime(desktopSources),
      desktopBuiltAtMs: buildTime(desktopBuildArtifacts),
      newestCliSourceMs: newestMtime(cliSources),
      cliBuiltAtMs: buildTime(cliOutputs),
    }, null, 2));
    process.exit(0);
  }

  if (desktopStale) {
    run(nodeBin, [iconBuildScript], desktopRoot, 'Icon build failed for ide-desktop');
    run(nodeBin, [tscBin, '-p', 'tsconfig.json'], desktopRoot, 'TypeScript build failed for ide-desktop');
    run(nodeBin, [viteBin, 'build'], desktopRoot, 'Vite build failed for ide-desktop');
  }

  if (cliStale) {
    run(nodeBin, [cliTscBin, '-p', 'tsconfig.json'], cliRoot, 'TypeScript build failed for cli');
  }

  // Launch the real GUI. When this launcher is itself run via electron-as-node
  // (ELECTRON_RUN_AS_NODE=1), that flag MUST be stripped here, otherwise the
  // spawned electron would boot as a plain Node runtime and no window appears.
  ensureToastShortcut();

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

function needsBuild(sources, requiredOutputs, buildArtifacts) {
  // 产物缺了（第一次启动、dist 被清过）就必须构建。
  if (requiredOutputs.some((output) => !fs.existsSync(output))) return true;
  return buildTime(buildArtifacts) < newestMtime(sources);
}

// 「上次构建完成」的时刻：只取构建真正写出来的产物里最新的那个。
function buildTime(artifacts) {
  return artifacts.reduce((newest, output) => Math.max(newest, newestForPath(output)), 0);
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

/**
 * Windows 通知横幅显示的是「com.yoycode.desktop」而不是应用名，也没有图标。
 *
 * toast 的应用名和图标不是 Notification 参数给的，是 Windows 拿进程注册的
 * AppUserModelId 去「开始菜单」里找同名 ID 的快捷方式，找到就拿快捷方式的名字
 * 和图标来画。没有那条快捷方式，横幅只能把 ID 原样印上去（就是那行
 * com.yoycode.desktop），图标空白。
 *
 * 所以启动时顺手补一条：只在缺失时跑一次 PowerShell（自包含脚本，幂等），
 * 不阻塞启动，失败也只是横幅难看，不影响开窗。
 */
function ensureToastShortcut() {
  if (process.platform !== 'win32') return;
  const shortcut = path.join(
    process.env.APPDATA ?? '',
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'YOYcode IDE.lnk',
  );
  if (!process.env.APPDATA || fs.existsSync(shortcut)) return;
  try {
    const child = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', path.join(__dirname, 'register-toast-shortcut.ps1'),
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch {
    // 注册失败只影响通知横幅的外观。
  }
}
