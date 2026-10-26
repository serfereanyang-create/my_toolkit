'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/*
* 输入框里的附件，对着真实的 Electron 窗口跑。
*
* 单测能验证卡片标记，验证不了这条链路上最容易断的三段：粘贴的图有没有真的
* 落到磁盘（CLI 要靠那个路径把图片读成 image part 发给模型）、缩略图能不能
* 从主进程读回来、以及回形针走的是不是真的原生选择器。所以这里全部用真事件：
* 派发一次 paste、点一次按钮，然后去查 DOM 和磁盘上的现场。唯一被替换的是
* 操作系统的文件对话框本身（无头窗口点不了原生模态），替换后返回的仍是一条
* 真实存在的图片路径。
*/

// 1×1 的透明 PNG，够让 Chromium 认成图片、也够让缩略图有真内容。
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AABAAA//8DAAf+Av0AAAAASUVORK5CYII=';

module.exports = async function runAttachmentChecks(context) {
  const { evaluate, click, waitFor, capture, check, ownedDirectory, fixture, settle } = context;
  const { dialog } = require('electron');

  const openChat = async () => {
    await click('.rail button[aria-label="对话"]');
    await waitFor('!!document.querySelector(".composer-input-row textarea")', '输入框');
  };

  await check('输入框是「输入 / 查看命令」，左下角有回形针添加附件', async () => {
    await openChat();
    const placeholder = await evaluate('document.querySelector(".composer-input-row textarea").getAttribute("placeholder")');
    assert.equal(placeholder, '输入 / 查看命令');
    assert.equal(await evaluate('!!document.querySelector(".composer-tools button[aria-label=\\"添加附件\\"]")'), true);
    assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card").length'), 0);
  });

  await check('粘贴的图片变成带缩略图的卡，并且真的落到了 .aicode/paste', async () => {
    await evaluate(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(ONE_PIXEL_PNG)}), (character) => character.charCodeAt(0));
      const file = new File([bytes], 'pasted-shot.png', { type: 'image/png' });
      const data = new DataTransfer();
      data.items.add(file);
      const textarea = document.querySelector('.composer-input-row textarea');
      textarea.focus();
      textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await waitFor('!!document.querySelector(".file-attachment-card img.file-attachment-thumb")', '粘贴后的缩略图');

    const thumbnail = await evaluate('document.querySelector(".file-attachment-card img.file-attachment-thumb").getAttribute("src")');
    assert.match(thumbnail, /^data:image\/png;base64,/, '缩略图必须是真实图片的 data URL，不是占位图');
    assert.equal(await evaluate('document.querySelector(".file-attachment-card").getAttribute("data-attachment")'), 'image');
    assert.match(await evaluate('document.querySelector(".file-attachment-card").textContent'), /pasted-image-\d+\.png/);

    // 落盘位置决定模型能不能看见这张图：CLI 只认工作区里的路径。
    const pasteDir = path.join(fixture, '.aicode', 'paste');
    const written = fs.readdirSync(pasteDir).filter((name) => name.endsWith('.png'));
    assert.ok(written.length > 0, `粘贴的图片应当写进 ${pasteDir}`);
    const onDisk = fs.readFileSync(path.join(pasteDir, written[written.length - 1]));
    assert.deepEqual(onDisk, Buffer.from(ONE_PIXEL_PNG, 'base64'), '磁盘上的字节必须和粘贴的一致');

    await capture('attachments-pasted');
  });

  await check('卡片上的 × 真的能移除附件', async () => {
    await click('.file-attachment-card .file-remove');
    await waitFor('document.querySelectorAll(".file-attachment-card").length === 0', '附件移除');
    await settle();
    assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card").length'), 0);
  });

  await check('回形针走真实选择器与真实读盘：缩略图就是那个文件的字节', async () => {
    const outside = ownedDirectory('attachment-source');
    const imagePath = path.join(outside, 'shot-from-disk.png');
    fs.writeFileSync(imagePath, Buffer.from(ONE_PIXEL_PNG, 'base64'));

    const originalShowOpenDialog = dialog.showOpenDialog;
    try {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [imagePath] });
      await click('.composer-tools button[aria-label="添加附件"]');
      await waitFor('!!document.querySelector(".file-attachment-card img.file-attachment-thumb")', '选择器回来的缩略图');
      const thumbnail = await evaluate('document.querySelector(".file-attachment-card img.file-attachment-thumb").getAttribute("src")');
      assert.equal(thumbnail, `data:image/png;base64,${ONE_PIXEL_PNG}`, '缩略图应当是主进程按路径读回来的原始字节');
      const label = await evaluate('document.querySelector(".file-attachment-card").textContent');
      assert.match(label, /shot-from-disk\.png/);
      assert.match(label, /图片/);
      await capture('attachments-picked');
    } finally {
      dialog.showOpenDialog = originalShowOpenDialog;
      await evaluate('document.querySelector(".file-attachment-card .file-remove")?.click()');
    }
  });
};
