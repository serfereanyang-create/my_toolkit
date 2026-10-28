'use strict';
require('./lib/probe-guard.cjs');

const electron = require('electron');
const { app } = electron;
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'app-review');
fs.mkdirSync(output, { recursive: true });

/*
 * 启动计时器。
 *
 * 只回答一个问题：从进程起来到「输入框可以打字」，时间花在哪。所以它不点
 * 任何按钮，只按时间顺序记下四个时刻——主进程就绪、窗口建好、页面加载完成、
 * 渲染完成——再把渲染进程自己的 navigation timing 与资源清单抄回来。
 *
 * 数字对不上就别信：这里的每一步都是真的在跑真 app，没有 mock 掉窗口，也没有
 * 跳过 main.cjs。跑两次取较快的那次（第一次要预热磁盘）。
 */

const sandbox = path.join(output, 'startup');
const profile = path.join(sandbox, 'profile');
const workspace = path.join(sandbox, 'workspace');
// 夹具只造一次。每次重造一千多个文件会把「造文件」的时间算进 process.uptime()，
// 于是「启动耗时」里混进几秒的假数据——这坑真的踩过。
const fileCount = process.argv.includes('--big') ? 1500 : 40;
const fixtureStamp = path.join(sandbox, '.filecount');
const fixtureMatches = fs.existsSync(fixtureStamp) && fs.readFileSync(fixtureStamp, 'utf8').trim() === String(fileCount);
if (!fixtureMatches) {
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  // --big 造一棵接近真实仓库的目录树：启动时读工作区树是最容易被忽略的一段
  // 串行 IPC，40 个文件看不出问题，上千个才看得见。
  for (let index = 0; index < fileCount; index += 1) {
    const dir = path.join(workspace, 'src', `group-${index % 40}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `module-${index}.ts`), `export const value${index} = ${index};\n`);
  }
  fs.writeFileSync(path.join(workspace, 'README.md'), '# startup fixture\n');
  fs.writeFileSync(fixtureStamp, String(fileCount));
}
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'startup.gitconfig'), '');
process.env.GIT_CONFIG_GLOBAL = path.join(profile, 'startup.gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';

const { defaultSettings } = require('../electron/settings-store.cjs');
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
  ...defaultSettings,
  recentWorkspaces: [workspace],
  preferences: { theme: 'light', 'gen.turnNotify': 'never', 'gen.permissionNotify': false },
}, null, 2));
const mainMarksFile = path.join(sandbox, 'main-marks.txt');
process.env.YOYCODE_STARTUP_FILE = mainMarksFile;
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'chromium'));
app.disableHardwareAcceleration();
delete process.env.VITE_DEV_SERVER_URL;

const startedAt = Date.now() - Math.round(process.uptime() * 1000);
const marks = [];
const mark = (name, detail) => marks.push({ name, ms: Date.now() - startedAt, ...(detail ? { detail } : {}) });
mark('process-start');

let previewWindow;
class ReviewWindow extends electron.BrowserWindow {
  constructor(options) {
    super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    previewWindow = this;
    mark('window-created');
  }
  show() { mark('window-shown'); }
  focus() {}
}
const originalLoad = Module._load;
const isolated = new Proxy(electron, { get: (target, property) => property === 'BrowserWindow' ? ReviewWindow : Reflect.get(target, property) });
Module._load = function(request, parent, isMain) {
  return request === 'electron' ? isolated : originalLoad.call(this, request, parent, isMain);
};
app.on('ready', () => mark('app-ready'));
app.on('browser-window-created', () => mark('first-window-event'));
mark('before-main-require');
require('../electron/main.cjs');
mark('after-main-require');

const evaluate = (expression) => previewWindow.webContents.executeJavaScript(expression, true);

async function run() {
  await app.whenReady();
  // did-finish-load 之后定时采样，第一次能查到输入框的时刻就是「能打字」。
  await new Promise((resolve) => {
    if (!previewWindow) return app.on('browser-window-created', () => resolve());
    resolve();
  });
  const finishLoad = new Promise((resolve) => previewWindow.webContents.once('did-finish-load', () => { mark('did-finish-load'); resolve(); }));
  await finishLoad;

  const deadline = Date.now() + 30000;
  let composerAt = null;
  while (Date.now() < deadline) {
    const ready = await evaluate('Boolean(document.querySelector(".composer-input-row textarea"))').catch(() => false);
    if (ready) { composerAt = Date.now() - startedAt; mark('composer-ready'); break; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const renderer = await evaluate(`(() => {
    const navigation = performance.getEntriesByType('navigation')[0] || {};
    const resources = performance.getEntriesByType('resource').filter((entry) => /\\.js$/.test(entry.name));
    const paint = performance.getEntriesByType('paint').map((entry) => ({ name: entry.name, startTime: Math.round(entry.startTime) }));
    return {
      nowMs: Math.round(performance.now()),
      domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd || 0),
      loadEventMs: Math.round(navigation.loadEventEnd || 0),
      responseEndMs: Math.round(navigation.responseEnd || 0),
      scriptBytes: resources.reduce((sum, entry) => sum + (entry.encodedBodySize || 0), 0),
      scriptCount: resources.length,
      paint,
      railAt: Math.round(performance.now()),
      monacoLoaded: Boolean(window.monaco),
    };
  })()`).catch((error) => ({ error: String(error) }));

  const dist = path.join(root, 'dist', 'assets');
  const assets = fs.readdirSync(dist)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, bytes: fs.statSync(path.join(dist, name)).size }))
    .sort((a, b) => b.bytes - a.bytes);
  // 真正的入口是 index.html 里 <script> 指向的那个，不是名字最小的那个：
  // Monaco 现在是懒加载的独立 chunk，同样叫 index-*.js。
  const html = fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8');
  const entryName = (html.match(/src="\.\/assets\/([^"]+\.js)"/) || [])[1];
  const entry = assets.find((item) => item.name === entryName);

  // 主进程自己的打点（electron/main.cjs 里 env 门控的那几行）单独读回来，
  // 换算成「从进程启动算起」的毫秒，和上面那组 marks 对齐。
  const mainOffset = (marks.find((item) => item.name === 'before-main-require') || { ms: 0 }).ms;
  const mainMarks = fs.existsSync(mainMarksFile)
    ? fs.readFileSync(mainMarksFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      const [name, ms] = line.split(' ');
      return { name: `main:${name}`, ms: Number(ms) + mainOffset };
    })
    : [];

  const report = {
    marks,
    mainMarks,
    composerReadyMs: composerAt,
    sinceDidFinishLoadMs: composerAt && marks.find((item) => item.name === 'did-finish-load') ? composerAt - marks.find((item) => item.name === 'did-finish-load').ms : null,
    renderer,
    bundle: { entryBytes: entry ? entry.bytes : null, totalJsBytes: assets.reduce((sum, item) => sum + item.bytes, 0), chunks: assets.length },
  };
  fs.writeFileSync(path.join(output, 'startup.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

run().then(() => app.exit(0)).catch((error) => { console.error(error.stack || error); app.exit(1); });
