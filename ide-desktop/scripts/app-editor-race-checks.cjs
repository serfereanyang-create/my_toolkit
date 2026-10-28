'use strict';
require('./lib/probe-guard.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

module.exports = async function runEditorRaceChecks(context) {
  const { evaluate, click, waitFor, settle, check, capture, fixture, ownedDirectory } = context;
  const { dialog } = require('electron');
  const originalPicker = dialog.showOpenDialog;
  const originalRead = fsPromises.readFile;
  const project = ownedDirectory('editor-race-project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"editor-race-project"}');
  const relative = 'src/shared-race.ts';
  const firstPath = path.join(fixture, relative);
  const secondPath = path.join(project, relative);
  const firstOriginal = 'export const workspace = "FIRST_BASE";\n';
  const secondOriginal = 'export const workspace = "SECOND_WORKSPACE_UNCHANGED";\n';
  fs.writeFileSync(firstPath, firstOriginal);
  fs.writeFileSync(secondPath, secondOriginal);
  const output = path.join(__dirname, '..', 'out', 'editor-race-review');
  fs.mkdirSync(output, { recursive: true });
  let holdTarget;
  let readStarted;
  let releaseRead;
  let readFinished;
  let captured = false;
  fsPromises.readFile = async (target, ...args) => {
    if (target === holdTarget && !captured) {
      captured = true;
      const content = await originalRead(target, ...args);
      readStarted?.();
      await new Promise(resolve => { releaseRead = resolve; });
      readFinished?.();
      return content;
    }
    return originalRead(target, ...args);
  };
  const beginRead = target => {
    holdTarget = target;
    captured = false;
    let timer;
    const started = new Promise(resolve => { readStarted = resolve; });
    const finished = new Promise(resolve => { readFinished = resolve; });
    return {
      started: () => Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No live editor file read started')), 5000); })]).finally(() => clearTimeout(timer)),
      finished,
    };
  };
  const openFile = async absolutePath => {
    await click('.rail button[aria-label="新标签页"]');
    await waitFor('!!document.querySelector(".newtab-page")', 'new tab file entry');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [absolutePath] });
    await click('.newtab-cell [data-newtab-artifact="documents"]');
    await waitFor('!!document.querySelector(".editor-tab.active") && !!document.querySelector(".monaco-editor .view-lines")', 'race source editor');
    assert.match(await evaluate('document.querySelector(".editor-tab.active").textContent'), /shared-race.ts/);
  };
  const switchProject = async target => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    await click('.rail-workspace');
    await waitFor(`document.querySelector('.rail-workspace')?.title === ${JSON.stringify(target)}`, 'renderer workspace switch');
  };
  try {
    await openFile(firstPath);
    await evaluate(`window.zcodeDesktop.editor.watchFile(${JSON.stringify(relative)})`);
    const pending = beginRead(firstPath);
    fs.writeFileSync(firstPath, 'export const workspace = "LATE_OLD_WORKSPACE_CONTENT";\n');
    await pending.started();
    await switchProject(project);
    await openFile(secondPath);
    assert.match(await evaluate('document.querySelector(".monaco-editor .view-lines").textContent'), /SECOND_WORKSPACE_UNCHANGED/);
    const isolated = await check('A late external read never replaces the same relative filename in another workspace', async () => {
      releaseRead();
      releaseRead = undefined;
      await pending.finished;
      await settle();
      await settle();
      const visible = await evaluate('document.querySelector(".monaco-editor .view-lines").textContent');
      assert.match(visible, /SECOND_WORKSPACE_UNCHANGED/);
      assert.doesNotMatch(visible, /LATE_OLD_WORKSPACE_CONTENT/);
      assert.equal(fs.readFileSync(secondPath, 'utf8'), secondOriginal);
      await capture('editor-workspace-read-isolated');
    });
    assert.equal(isolated, true, 'external read workspace isolation gate');
  } finally {
    if (releaseRead) releaseRead();
    fsPromises.readFile = originalRead;
    dialog.showOpenDialog = originalPicker;
    fs.writeFileSync(firstPath, firstOriginal);
    fs.writeFileSync(secondPath, secondOriginal);
    if ((await evaluate('document.querySelector(".rail-workspace")?.title')) !== fixture) {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
      await click('.rail-workspace').catch(() => undefined);
      dialog.showOpenDialog = originalPicker;
    }
  }
};
