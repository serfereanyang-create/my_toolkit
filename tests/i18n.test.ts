import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLocale } from '../src/i18n/locale.js';
import { formatApprovalPrompt, formatGitConfirm, isBlockedOutput, isCancelledOutput } from '../src/i18n/messages.js';

test('detectLocale prefers Chinese when CJK is present', () => {
  assert.equal(detectLocale('帮我写个文件'), 'zh');
  assert.equal(detectLocale('C:\\Users\\x\\Desktop\\测试.docx看'), 'zh');
  assert.equal(detectLocale('please write a file'), 'en');
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
