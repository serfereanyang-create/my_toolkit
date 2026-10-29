import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLocale, resolveSessionLocale } from '../src/i18n/locale.js';
import { formatApprovalOutcome, formatApprovalPrompt, formatGitConfirm, isBlockedOutput, isCancelledOutput, isPathEscapeOutput, localizeReason } from '../src/i18n/messages.js';
import { decideApproval } from '../src/safety/policy.js';

test('detectLocale prefers Chinese when CJK is present', () => {
  assert.equal(detectLocale('帮我写个文件'), 'zh');
  assert.equal(detectLocale('C:\\Users\\x\\Desktop\\测试.docx看'), 'zh');
  assert.equal(detectLocale('please write a file'), 'en');
});

test('resolveSessionLocale sticks Chinese across short follow-ups', async () => {
  assert.equal(resolveSessionLocale({ text: '帮我看磁盘', previous: undefined }), 'zh');
  assert.equal(resolveSessionLocale({ text: '继续', previous: 'zh' }), 'zh');
  assert.equal(resolveSessionLocale({ text: 'ok', previous: 'zh' }), 'zh');
  assert.equal(resolveSessionLocale({ text: 'please rewrite this long english prompt carefully now', previous: 'zh' }), 'en');
});

test('resolveSessionLocale 用整段文本判断是否切英文：4000 字之后的 CJK 也要算数', () => {
  // detectLocale 只看前 4000 字符；长日志后面跟一句中文时，旧实现会误判成 en。
  const pastedLog = `${'a'.repeat(4100)}总结一下`;
  assert.equal(detectLocale(pastedLog), 'en', '取样窗口的既有限制保持不变');
  assert.equal(resolveSessionLocale({ text: pastedLog, previous: 'zh' }), 'zh');
  assert.equal(resolveSessionLocale({ text: pastedLog, previous: 'en' }), 'zh');
});

test('resolveSessionLocale 对同一输入稳定（重复调用结果一致）', () => {
  const samples = ['', '   ', 'ok', '继续', '!!!', '😀🎉', 'hello world', '请帮我', '啊'.repeat(5000), 'x'.repeat(5000)];
  for (const text of samples) {
    for (const previous of [undefined, 'zh', 'en'] as const) {
      const first = resolveSessionLocale({ text, previous });
      assert.equal(resolveSessionLocale({ text, previous }), first, `不稳定：${JSON.stringify(text.slice(0, 12))}/${previous}`);
    }
  }
});

test('detectLocale 的边界：kana 算亚洲语言、emoji/纯符号不算、全角拉丁不算', () => {
  assert.equal(detectLocale('こんにちは'), 'zh');
  assert.equal(detectLocale('!!! ??? ***'), 'en');
  assert.equal(detectLocale('😀🎉👍'), 'en');
  assert.equal(detectLocale('ｈｅｌｌｏ'), 'en');
  assert.equal(detectLocale('請幫我讀取這個檔案'), 'zh', 'zh-TW/zh-HK 繁体同属中文');
  assert.equal(detectLocale(''), 'en');
  assert.equal(detectLocale(undefined), 'en');
});

test('formatApprovalPrompt localizes risk labels', () => {
  assert.match(
    formatApprovalPrompt({ locale: 'zh', tool: 'write_file', risk: 'write', path: '.smoke/a.md' }),
    /是否批准写入工具 write_file/,
  );
  assert.match(
    formatApprovalPrompt({ locale: 'en', tool: 'write_file', risk: 'write', path: '.smoke/a.md' }),
    /Approve write tool write_file/,
  );
});

test('formatGitConfirm localizes init and commit prompts', () => {
  assert.match(formatGitConfirm({ locale: 'zh', kind: 'init_repo' }), /是否初始化本地仓库/);
  assert.match(formatGitConfirm({ locale: 'en', kind: 'init_repo' }), /Initialize a local repository/);
});

test('cancelled and blocked detectors accept zh and en markers', () => {
  assert.equal(isCancelledOutput('Tool write_file cancelled by user'), true);
  assert.equal(isCancelledOutput('工具 write_file 已由用户取消'), true);
  assert.equal(isBlockedOutput('Tool run_command blocked: command is not in auto approval allowlist'), true);
  assert.equal(isBlockedOutput('工具 run_command 已拦截：命令不在自动批准白名单'), true);
});

/*
 * A path escape is an input mistake the model can fix, not a policy verdict.
 * It used to be folded into isBlockedOutput, which made the agent end the turn
 * the moment it reached for a path outside the workspace.
 */
test('a path escape is recoverable and is not reported as a policy block', () => {
  assert.equal(isBlockedOutput('Tool read_file failed: Path escapes workspace: ../other/README.md'), false);
  assert.equal(isBlockedOutput('工具 read_file 失败: 路径越出工作区'), false);
  assert.equal(isPathEscapeOutput('Tool read_file failed: Path escapes workspace: ../other/README.md'), true);
  assert.equal(isPathEscapeOutput('path escapes workspace: a/../b'), true);
  assert.equal(isPathEscapeOutput('工具 read_file 失败: 路径越出工作区'), true);
  assert.equal(isPathEscapeOutput('Tool run_command blocked: nope'), false);
});

/*
 * backgroundBrowser 绕过 registry，直接返回「…被策略拒绝：…」。那是策略
 * 判定（重试同一条命令没有意义），却不会被「已拦截」匹配到，于是被当成
 * 普通失败交给模型反复重试。审核否决（自动审核拒绝）不同：它是可换路的。
 */
test('tools 内联的硬拒绝同样算 blocked；自动审核否决不算', () => {
  assert.equal(isBlockedOutput('后台浏览器网络请求被策略拒绝：example.com 不在联网白名单'), true);
  assert.equal(isBlockedOutput('后台浏览器下载被策略拒绝：unsupported protocol ftp:'), true);
  assert.equal(isBlockedOutput('后台浏览器路径被策略拒绝：Path escapes workspace: ../x'), true);
  assert.equal(isBlockedOutput('后台浏览器操作被策略拒绝：approval mode denies write, shell, and network tools'), true);
  assert.equal(
    isBlockedOutput('Tool write_file cancelled by user\n自动审核拒绝：理由\n这是审核判定，不是执行失败'),
    false,
    '审核否决是可以换路重试的，不能拖长成终局失败',
  );
});

/*
 * localizeReason 是中文模式下面板/终端里唯一能读懂 reason 的地方。旧表
 * 只覆盖 7 条，其中 deny 模式那条的英文早就改了（多了 and network），
 * 于是最常见的两条提示一直原样显示英文。
 */
test('localizeReason 覆盖 policy / network 的全部拒绝文案', () => {
  const cases: Array<[string, RegExp]> = [
    ['read-only tool', /只读工具/],
    ['approval mode denies write, shell, and network tools', /禁止写入、命令与联网工具/],
    ['approval mode denies write and shell tools', /禁止写入与命令工具/],
    ['blocked destructive command pattern', /匹配到危险命令模式/],
    ['blocked destructive command pattern: cmd 会修改系统安全配置', /匹配到危险命令模式：cmd 会修改系统安全配置/],
    ['command is not in auto approval allowlist', /命令不在自动批准白名单/],
    ['write target is not in auto approval allowlist', /写入目标不在自动批准白名单/],
    ['interactive approval required', /需要交互确认/],
    ['interactive approval required for network request', /联网请求需要交互确认/],
    ['auto approval allowlist', /已在自动批准白名单/],
    ['plan mode requires confirmation before every change', /计划模式/],
    ['destructive tool requires explicit confirmation', /破坏性工具需要明确确认/],
    ['confirmation required: 递归删除工作区内内容', /需要确认：递归删除工作区内内容/],
    ['invalid URL', /URL 无效/],
    ['unsupported protocol ftp:', /不支持的协议 ftp:/],
    ['target resolves to a private or loopback address (SSRF blocked)', /私有或回环地址/],
    ['example.com is not in the network allowlist (the request was blocked before it left the machine). Add it to "network.allowlist"', /example\.com 不在联网白名单/],
  ];
  for (const [english, expected] of cases) {
    assert.match(localizeReason(english, 'zh'), expected, english);
  }
  // 未收录的文案原样保留，不能吞掉信息；en 永远原样。
  assert.equal(localizeReason('some future reason', 'zh'), 'some future reason');
  assert.equal(localizeReason('read-only tool', 'en'), 'read-only tool');
});

test('真实 policy 裁决在中文模式下被完整本地化', () => {
  const permission = decideApproval({ mode: 'deny', risk: 'write', workspaceRoot: process.cwd() });
  assert.equal(permission.allowed, false);
  const message = formatApprovalOutcome({ locale: 'zh', kind: 'blocked', tool: 'write_file', reason: permission.reason });
  assert.equal(message, '工具 write_file 已拦截：当前审批模式禁止写入、命令与联网工具');

  const ssrf = decideApproval({ mode: 'auto', risk: 'network', url: 'http://169.254.169.254/latest', networkAllowlist: [], workspaceRoot: process.cwd() });
  assert.equal(ssrf.allowed, false);
  assert.match(formatApprovalOutcome({ locale: 'zh', kind: 'blocked', tool: 'fetch_url', reason: ssrf.reason }), /已拦截：目标是私有或回环地址/);
});
