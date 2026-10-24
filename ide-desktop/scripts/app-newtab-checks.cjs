'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/*
 * 新标签页，对着真实的 Electron 窗口跑。
 *
 * 单测只能看标记：五个 `data-newtab-action`、四个 `data-newtab-artifact`。但
 * 这一页的价值恰好不在标记上——「打开」按下去必须真的发生那件事。所以这里
 * 用真实鼠标事件点，然后去查那个能力自己的现场：
 *
 *   - 文件 → 侧栏「文件」变成选中态
 *   - 终端 → 底部终端挂上来（`.terminal-panel`）
 *   - 浏览器 / 辅助对话 → 右栏那两个面板各自的根节点
 *   - 审查 → 源代码管理面板
 *   - 工件格 → 走 `files.pick` 拿到绝对路径、换成工作区相对路径、再进预览
 *
 * `files.pick` 里唯一被替换掉的是操作系统的文件选择框本身（原生模态窗口没
 * 法在无头窗口里点），替换点在主进程的 `dialog.showOpenDialog`，返回的仍然
 * 是一条真实存在的路径——IPC、白名单清洗、路径换算、预览打开全是真的。
 */

const outsideFile = (context) => {
  const directory = context.ownedDirectory('outside');
  const file = path.join(directory, 'outside.txt');
  fs.writeFileSync(file, '工作区外面的文件\n');
  return file;
};

module.exports = async function runNewTabChecks(context) {
  const { evaluate, click, waitFor, capture, check, fixture } = context;
  const { dialog } = require('electron');

  const openNewTab = async () => {
    await click('.rail button[aria-label="新标签页"]');
    await waitFor('!!document.querySelector(".newtab-page")', '新标签页');
  };
  const clickAction = async (action) => {
    await openNewTab();
    await click(`.newtab-cell [data-newtab-action="${action}"]`);
  };

  const originalShowOpenDialog = dialog.showOpenDialog;
  try {
    const rendered = await check('新标签页从侧栏打开，五个入口和四个工件都在', async () => {
      await openNewTab();
      const actions = await evaluate('[...document.querySelectorAll("[data-newtab-action]")].map(button => button.getAttribute("data-newtab-action"))');
      assert.deepEqual(actions, ['files', 'browser', 'terminal', 'review', 'sidechat']);
      const artifacts = await evaluate('[...document.querySelectorAll("[data-newtab-artifact]")].map(button => button.getAttribute("data-newtab-artifact"))');
      assert.deepEqual(artifacts, ['pdf', 'presentations', 'spreadsheets', 'documents']);
      assert.equal(await evaluate('[...document.querySelectorAll("[data-newtab-artifact]")].every(button => !button.disabled)'), true);
      assert.equal(await evaluate('document.querySelector(".rail button[aria-label=\\"新标签页\\"]").getAttribute("aria-pressed")'), 'true');
      await capture('newtab');
    });
    assert.equal(rendered, true, '新标签页渲染闸');

    await check('「文件」把侧栏切到真实文件视图', async () => {
      await clickAction('files');
      await waitFor('document.querySelector(".rail button[aria-label=\\"文件\\"]")?.getAttribute("aria-pressed") === "true"', '文件视图选中');
      assert.equal(await evaluate('!!document.querySelector(".newtab-page")'), false);
    });

    await check('「终端」拉起的是真的底部终端', async () => {
      await clickAction('terminal');
      await waitFor('!!document.querySelector(".terminal-panel")', '底部终端');
      assert.equal(await evaluate('document.querySelectorAll(".terminal-tabs .terminal-tab").length > 0'), true);
    });

    await check('「浏览器」拉起的是真的浏览器面板', async () => {
      await clickAction('browser');
      await waitFor('!!document.querySelector(".browser-panel")', '浏览器面板');
    });

    await check('「辅助对话」拉起的是真的侧聊面板', async () => {
      await clickAction('sidechat');
      await waitFor('!!document.querySelector(".side-chat-panel")', '侧聊面板');
    });

    await check('「审查」进的是真的源代码管理面板', async () => {
      await clickAction('review');
      await waitFor('!!document.querySelector(".gtx-panel[aria-label=\\"源代码管理\\"]") || !!document.querySelector(".gtx-repository")', '源代码管理面板');
    });

    await check('工件格的「打开」把选中的文件送进预览', async () => {
      await openNewTab();
      const target = path.join(fixture, 'src', 'page.html');
      dialog.showOpenDialog = async (...args) => {
        assert.equal(args[1].properties.includes('openFile'), true, '选择框只能是 openFile');
        assert.equal(args[1].properties.includes('openDirectory'), false, '选择框不能要目录');
        return { canceled: false, filePaths: [target] };
      };
      await click('.newtab-cell [data-newtab-artifact="documents"]');
      await waitFor(
        '[...document.querySelectorAll(".preview-tab-label, .editor-tab")].some(node => node.textContent.includes("page.html"))',
        '选中的文件在预览/编辑器里打开',
      );
    });

    await check('工作区外面的文件被就地拒绝，并说明原因', async () => {
      await openNewTab();
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [outsideFile(context)] });
      await click('.newtab-cell [data-newtab-artifact="pdf"]');
      await waitFor('[...document.querySelectorAll(".toast-text")].some(node => node.textContent.includes("只能打开工作区内的文件"))', '越界拒绝提示');
    });

    await check('取消选择什么都不做', async () => {
      await openNewTab();
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      const before = await evaluate('document.querySelectorAll(".preview-tab, .editor-tab").length');
      await click('.newtab-cell [data-newtab-artifact="presentations"]');
      await new Promise((resolve) => setTimeout(resolve, 300));
      const after = await evaluate('document.querySelectorAll(".preview-tab, .editor-tab").length');
      assert.equal(after, before, '取消不应该新开任何东西');
    });
  } finally {
    dialog.showOpenDialog = originalShowOpenDialog;
  }
};
