'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function runBackgroundAppChecks(context) {
  const { evaluate, click, clickPoint, waitFor, capture, check, fixture, reload, settle } = context;
  const sample = path.join(fixture, 'background-preview');
  fs.mkdirSync(sample, { recursive: true });
  for (const name of ['package.json', 'main.cjs', 'preload.cjs', 'index.html']) fs.copyFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'background-app', name), path.join(sample, name));
  const esmSample = path.join(fixture, 'background-preview-esm');
  fs.mkdirSync(esmSample, { recursive: true });
  fs.writeFileSync(path.join(esmSample, 'package.json'), JSON.stringify({ name: 'esm-app-review', type: 'module', main: 'main.mjs' }));
  for (const name of ['main.mjs', 'preload.cjs', 'index.html']) fs.copyFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'background-app', name), path.join(esmSample, name));
  for (const [directoryName, entry, filenames] of [
    ['background-preview-input', 'native-input.cjs', ['native-input.cjs', 'native-preload.cjs', 'native-input.html']],
    ['background-preview-windows', 'multi-window.cjs', ['multi-window.cjs', 'multi-preload.cjs', 'multi-window.html']],
  ]) {
    const directory = path.join(fixture, directoryName);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: directoryName, main: entry }));
    for (const filename of filenames) fs.copyFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'background-app', filename), path.join(directory, filename));
  }
  const exclude = path.join(fixture, '.git', 'info', 'exclude');
  if (!fs.readFileSync(exclude, 'utf8').includes('background-preview/')) fs.appendFileSync(exclude, '\nbackground-preview/\n');
  if (!fs.readFileSync(exclude, 'utf8').includes('background-preview-esm/')) fs.appendFileSync(exclude, '\nbackground-preview-esm/\n');
  for (const directory of ['background-preview-input/', 'background-preview-windows/']) if (!fs.readFileSync(exclude, 'utf8').includes(directory)) fs.appendFileSync(exclude, `\n${directory}\n`);
  await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify({ recentWorkspaces: [fixture] })})`);
  await reload();
  await waitFor('!!document.querySelector(".rail-settings")', 'background review workspace');
  await click('.rail-settings');
  await evaluate('[...document.querySelectorAll(".settings-nav-item")].find(button => button.textContent.includes("电脑操控")).click()');
  const panel = '[aria-label="后台应用工作台"]';
  const field = async (index, value) => {
    await evaluate(`(() => { const input = document.querySelectorAll(${JSON.stringify(`${panel} input`)})[${index}]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await settle();
  };
  const button = async label => {
    await evaluate(`(() => { const button = [...document.querySelectorAll(${JSON.stringify(`${panel} button`)})].find(button => button.textContent.includes(${JSON.stringify(label)})); if (!button || button.disabled) throw new Error('Unavailable background button'); button.click(); })()`);
    await settle();
    await waitFor(`!document.querySelector(${JSON.stringify(`${panel} [aria-label="后台应用操作进行中"]`)})`, `background ${label}`);
  };
  await check('BACKGROUND App settings exposes the real application capture controls', async () => {
    await waitFor(`!!document.querySelector(${JSON.stringify(panel)})`, 'background app settings');
    assert.equal(await evaluate(`typeof window.zcodeDesktop.backgroundApp.execute`), 'function');
    await field(0, 'background-preview');
    await evaluate(`document.querySelector(${JSON.stringify(panel)}).scrollIntoView({ block: 'start' })`);
    await capture('background-app-settings');
  });
  await check('BACKGROUND UI launches the project and displays a real PNG through production IPC', async () => {
    await button('后台运行');
    assert.match(await evaluate(`document.querySelector(${JSON.stringify(`${panel} [role="status"]`)}).textContent`), /隐藏运行/);
    await button('真实应用截图');
    await waitFor(`document.querySelector(${JSON.stringify(`${panel} img`)})?.naturalWidth > 500`, 'actual application image in settings');
    await evaluate(`document.querySelector(${JSON.stringify(`${panel} img`)}).scrollIntoView({ block: 'center' })`);
    await capture('background-app-ui-capture');
  });
  await check('BACKGROUND UI interaction updates actual main-process IPC and screenshot pixels', async () => {
    const before = await evaluate(`document.querySelector(${JSON.stringify(`${panel} img`)}).src`);
    await field(1, '#name'); await field(2, '设置入口验收'); await button('填写输入框');
    await field(1, '#submit'); await button('点击元素'); await button('检查界面');
    assert.match(await evaluate(`document.querySelector(${JSON.stringify(`${panel} [role="status"]`)}).textContent`), /真实 IPC：设置入口验收/);
    await button('真实应用截图');
    assert.notEqual(await evaluate(`document.querySelector(${JSON.stringify(`${panel} img`)}).src`), before);
    await evaluate(`document.querySelector(${JSON.stringify(`${panel} img`)}).scrollIntoView({ block: 'center' })`);
    await capture('background-app-ui-updated');
  });
  await check('BACKGROUND UI closes the hidden child and disables further capture', async () => {
    await button('结束应用');
    assert.match(await evaluate(`document.querySelector(${JSON.stringify(`${panel} [role="status"]`)}).textContent`), /已关闭/);
    assert.equal(await evaluate(`[...document.querySelectorAll(${JSON.stringify(`${panel} button`)})].find(button => button.textContent.includes('真实应用截图')).disabled`), true);
  });
  await check('BACKGROUND UI renders an ESM project through the same real capture controls', async () => {
    await field(0, 'background-preview-esm');
    await button('后台运行');
    assert.match(await evaluate(`document.querySelector(${JSON.stringify(`${panel} [role="status"]`)}).textContent`), /隐藏运行/);
    await field(1, '#submit');
    await button('点击元素');
    await button('检查界面');
    assert.match(await evaluate(`document.querySelector(${JSON.stringify(`${panel} [role="status"]`)}).textContent`), /真实 IPC：首次截图/);
    await button('真实应用截图');
    await waitFor(`document.querySelector(${JSON.stringify(`${panel} img`)})?.naturalWidth > 500`, 'ESM application screenshot');
    await waitFor(`document.querySelector(${JSON.stringify(`${panel} [role="status"]`)})?.textContent.includes('已截取后台应用真实画面') && !document.querySelector(${JSON.stringify(`${panel} [aria-label="后台应用操作进行中"]`)})`, 'ESM screenshot operation has completed');
    await evaluate(`document.querySelector(${JSON.stringify(`${panel} img`)}).scrollIntoView({ block: 'center' })`);
    fs.writeFileSync(path.join(__dirname, '..', 'out', 'app-review', 'background-app-esm-state.json'), JSON.stringify(await evaluate(`(() => { const panel = document.querySelector(${JSON.stringify(panel)}); const image = panel.querySelector('img'); return { output: panel.querySelector('[role="status"]').textContent, busy: !!panel.querySelector('[aria-label="后台应用操作进行中"]'), width: image.naturalWidth, height: image.naturalHeight }; })()`), null, 2));
    await capture('background-app-esm-ui');
    await button('结束应用');
  });
  await check('BACKGROUND screenshot clicks and keyboard controls edit the actual hidden renderer', async () => {
    await field(0, 'background-preview-input');
    await button('后台运行'); await button('真实应用截图');
    await waitFor(`document.querySelector(${JSON.stringify(`${panel} img`)})?.naturalWidth > 500`, 'native input preview');
    const before = await evaluate(`document.querySelector(${JSON.stringify(`${panel} img`)}).src`);
    await evaluate(`document.querySelector(${JSON.stringify(`${panel} img`)}).scrollIntoView({ block: 'center' })`);
    const point = await evaluate(`(() => { const image = document.querySelector(${JSON.stringify(`${panel} img`)}); const bounds = image.getBoundingClientRect(); const scale = Math.min(image.clientWidth/image.naturalWidth,image.clientHeight/image.naturalHeight); return { x: bounds.left+image.clientLeft+(image.clientWidth-image.naturalWidth*scale)/2+80*scale, y: bounds.top+image.clientTop+(image.clientHeight-image.naturalHeight*scale)/2+160*scale }; })()`);
    await clickPoint(point);
    await waitFor(`document.querySelector(${JSON.stringify(`${panel} img`)})?.src !== ${JSON.stringify(before)} && !document.querySelector(${JSON.stringify(`${panel} [aria-label="后台应用操作进行中"]`)})`, 'preview click auto refresh');
    await field(3, 'Control+A'); await button('发送快捷键');
    await field(2, '界面真实输入'); await button('输入文字'); await button('检查界面');
    const result = JSON.parse(await evaluate(`document.querySelector(${JSON.stringify(`${panel} [role="status"]`)}).textContent`));
    const current = JSON.parse(result.snapshot.text.match(/STATE: (\{[^\n]+\})/u)[1]);
    assert.equal(current.first, '界面真实输入'); assert.ok(current.trustedInputs > 0);
    await button('真实应用截图');
    await evaluate(`document.querySelector(${JSON.stringify(`${panel} img`)}).scrollIntoView({ block: 'center' })`);
    await capture('background-app-real-input-ui');
    await button('结束应用');
  });
  await check('BACKGROUND window refresh recovers a closed splash and never shows the old window image', async () => {
    await field(0, 'background-preview-windows'); await button('后台运行');
    await field(1, '#advance'); await button('点击元素'); await button('刷新窗口'); await button('检查界面');
    const inspected = JSON.parse(await evaluate(`document.querySelector(${JSON.stringify(`${panel} [role="status"]`)}).textContent`));
    assert.equal(inspected.snapshot.title, '主窗口');
    await button('真实应用截图');
    const auxiliary = await evaluate(`[...document.querySelectorAll(${JSON.stringify(`${panel} select option`)})].find(option => option.textContent.includes('辅助窗口'))?.value`);
    assert.ok(auxiliary);
    await evaluate(`(() => { const select = document.querySelector(${JSON.stringify(`${panel} select`)}); select.value = ${JSON.stringify(auxiliary)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await settle();
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(`${panel} img`)})`), false);
    await button('检查界面');
    const selected = JSON.parse(await evaluate(`document.querySelector(${JSON.stringify(`${panel} [role="status"]`)}).textContent`));
    assert.equal(selected.snapshot.title, '辅助窗口');
    await button('真实应用截图');
    await capture('background-app-window-choice');
    await button('结束应用');
  });
  await check('BACKGROUND leaving the workbench closes its manual process without retaining an orphan', async () => {
    const launched = await evaluate('window.zcodeDesktop.backgroundApp.execute("background_app_open", { path: "background-preview" })');
    assert.equal(launched.ok, true, launched.output);
    await evaluate('[...document.querySelectorAll(".settings-nav-item")].find(button => button.textContent.trim() === "常规").click()');
    await waitFor(`(async () => { const result = await window.zcodeDesktop.backgroundApp.execute('background_app_inspect', ${JSON.stringify({ appId: launched.data.appId })}); return result.ok === false; })()`, 'manual background app closes when settings section unmounts');
  });
};
