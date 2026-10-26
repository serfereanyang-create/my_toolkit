'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');

/*
 * 侧栏底部那块常驻面板，对着真实的 Electron 窗口跑。
 *
 * 两件单测证明不了的事：
 *   1. 「常驻」——它不点任何按钮就该在，而且没有折叠入口；
 *   2. 数字是**真的**——界面上显示的已用 token 必须等于 provider 这次真的报告的
 *      值，而不是某个估算或者占位。
 *
 * 所以这里起一个本地 SSE provider，回包里带上 usage（prompt_tokens=40000），
 * 跑一个真回合，然后把 DOM 上的 `data-context-used/window/until` 读回来跟注入
 * 的数字对表。窗口用 CLI 的模型表兜底（fixture 这个模型名不在表里 → 128k），
 * 自动压缩阈值是它的 90%，正好可以一起验。
 */

const PROMPT_TOKENS = 40_000;
const FALLBACK_WINDOW = 128_000;
const AUTO_COMPACT_LIMIT = Math.floor(FALLBACK_WINDOW * 0.9);

module.exports = async function runContextChecks(context) {
  const { evaluate, waitFor, capture, check, fixture, reload, settle } = context;
  const output = path.join(__dirname, '..', 'out', 'context-review', 'app');
  fs.mkdirSync(output, { recursive: true });
  const original = await evaluate('window.zcodeDesktop.settings.get()');

  const server = createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '上下文检查：这一轮回一句短的。' } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: PROMPT_TOKENS, completion_tokens: 12, total_tokens: PROMPT_TOKENS + 12 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const input = 'textarea[aria-label="输入任务或问题"]';
  const submit = async (text) => {
    await evaluate(`(() => { const field = document.querySelector(${JSON.stringify(input)}); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)}); field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await settle();
    await evaluate(`document.querySelector('button[aria-label="发送消息"]').click()`);
    await settle();
  };

  try {
    const provider = {
      id: 'context-fixture', type: 'custom', label: 'Context fixture', apiFormat: 'openai-chat',
      baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fixture', models: [{ id: 'fixture' }],
    };
    await evaluate(`window.zcodeDesktop.secrets.setApiKey('context-fixture', 'test-only')`);
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify({ ...original, activeProviderId: provider.id, providers: [...original.providers.filter(item => item.id !== provider.id), provider], recentWorkspaces: [fixture], preferences: { ...original.preferences, 'gen.sendShortcut': 'enter', 'gen.turnNotify': 'never', 'gen.permissionNotify': false } })})`);
    await reload();
    await waitFor('!!document.querySelector(".rail-primary-new")', 'context fixture workspace');

    const alwaysOn = await check('CONTEXT 面板常驻侧栏：不点任何按钮就在，且没有折叠入口', async () => {
      const state = await evaluate(`(() => {
        const panel = document.querySelector('.context-sidebar');
        if (!panel) return { present: false };
        const box = panel.getBoundingClientRect();
        return {
          present: true,
          visible: box.height > 0,
          sections: [...panel.querySelectorAll('.context-sec')].map(node => node.getAttribute('aria-label')),
          collapse: panel.querySelectorAll('[aria-expanded], [data-collapse], .context-fold').length,
          envCurrent: panel.querySelector('[data-env-current]')?.getAttribute('data-env-current') || '',
          compactDisabled: panel.querySelector('[data-context-compact]')?.disabled === true,
          until: panel.querySelector('[data-context-until]')?.getAttribute('data-context-until') || '',
          // 它现在占的是窗口最右边那一列：贴右边缘、铺满整高、不在左侧栏里。
          inRail: Boolean(document.querySelector('.rail .context-sidebar')),
          rightGap: Math.round(window.innerWidth - box.right),
          height: Math.round(box.height),
          viewportHeight: window.innerHeight,
        };
      })()`);
      fs.writeFileSync(path.join(output, 'context-panel-state.json'), JSON.stringify(state, null, 2));
      assert.equal(state.present, true, '常驻面板没有渲染');
      assert.equal(state.visible, true, '面板被渲染成 0 高度，等于看不见');
      for (const label of ['环境', '上下文', '输出']) {
        assert.ok(state.sections.includes(label), `常驻面板缺区块「${label}」：${state.sections.join('/')}`);
      }
      assert.equal(state.inRail, false, '环境/上下文/输出 不该再挂在左侧会话栏里');
      assert.ok(state.rightGap <= 1, `常驻面板应当贴着窗口右边缘，实际差了 ${state.rightGap}px`);
      assert.ok(Math.abs(state.height - state.viewportHeight) <= 2,
        `常驻面板高度应当铺满窗口：${state.height} vs ${state.viewportHeight}`);
      assert.equal(state.collapse, 0, '常驻面板不该有折叠/收起入口');
      assert.equal(state.envCurrent, fixture);
      assert.equal(state.compactDisabled, true, '还没有任何上下文数据时，压缩按钮应当禁用');
      assert.equal(state.until, '', '没有数据就不该编一个「还剩多少」');
      await capture('context-sidebar-empty');
    });
    assert.equal(alwaysOn, true, '常驻面板闸');

    await evaluate(`document.querySelector('.rail-primary-new').click()`);
    await waitFor(`!!document.querySelector(${JSON.stringify(input)})`, 'chat composer');
    await submit('检查上下文面板');
    await waitFor('document.body.textContent.includes("上下文检查")', 'finished fixture reply');
    await waitFor('document.querySelector("[data-context-percent]")?.getAttribute("data-context-percent") !== ""', 'real context numbers');

    await check('CONTEXT 面板上的数字就是 provider 这次真报的 usage', async () => {
      const panel = await evaluate(`(() => {
        const root = document.querySelector('.context-sidebar');
        const num = (selector, attribute) => Number(root.querySelector(selector)?.getAttribute(attribute));
        return {
          used: num('[data-context-used]', 'data-context-used'),
          window: num('[data-context-window]', 'data-context-window'),
          until: num('[data-context-until]', 'data-context-until'),
          percent: root.querySelector('[data-context-percent]')?.getAttribute('data-context-percent') || '',
          usedText: root.querySelector('[data-context-used]')?.textContent || '',
          windowText: root.querySelector('[data-context-window]')?.textContent || '',
          legend: [...root.querySelectorAll('[data-context-legend]')].map(node => node.getAttribute('data-context-legend')),
          outputs: root.querySelector('[data-context-output-count]')?.getAttribute('data-context-output-count') || '',
          compactDisabled: root.querySelector('[data-context-compact]')?.disabled === true,
        };
      })()`);
      fs.writeFileSync(path.join(output, 'context-panel-filled.json'), JSON.stringify(panel, null, 2));

      // 界面数字 == provider 报告的数字（分类摊开后的和一定回到同一个总量）。
      assert.equal(panel.used, PROMPT_TOKENS, '已用 token 与 provider 报的 prompt_tokens 不一致');
      assert.equal(panel.window, FALLBACK_WINDOW, '窗口不是模型表里的兜底值');
      assert.equal(panel.until, AUTO_COMPACT_LIMIT - PROMPT_TOKENS, '距离自动压缩的余量算错了');
      assert.equal(panel.percent, String(Math.round((PROMPT_TOKENS / FALLBACK_WINDOW) * 1000) / 10));
      assert.equal(panel.usedText, '40k');
      assert.equal(panel.windowText, '128k');
      // 分类里至少要有「消息」和「系统工具」——是真的从 prompt 组成摊开的。
      assert.ok(panel.legend.includes('messages'), `图例缺少 messages：${panel.legend.join(',')}`);
      assert.ok(panel.legend.includes('systemTools'), `图例缺少 systemTools：${panel.legend.join(',')}`);
      assert.equal(panel.compactDisabled, false, '有上下文之后压缩按钮应当可点');
      // 这一会话没有改过文件，所以输出区必须是空的——而不是拿工具参数猜出来的假清单。
      assert.equal(panel.outputs, '0');
      await capture('context-sidebar-filled');
    });
  } finally {
    await evaluate(`window.zcodeDesktop.settings.set(${JSON.stringify(original)})`).catch(() => undefined);
    await reload().catch(() => undefined);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};
