import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanForTitle,
  truncateTitle,
  titleFromAssistant,
  summarizeActivity,
  suggestTitle,
} from '../src/session/sessionTitle.js';

test('cleanForTitle strips commands and markdown', () => {
  assert.equal(cleanForTitle('/implement **写一个**解析器'), '写一个解析器');
  assert.equal(cleanForTitle('# 大标题 ## 子标题'), '大标题 ## 子标题'.replace(/^#+\s*/, ''));
  assert.equal(cleanForTitle('[链接](http://x)'), '链接');
});

test('truncateTitle respects length boundary', () => {
  assert.equal(truncateTitle('短标题'), '短标题');
  const long = truncateTitle('这是一个非常非常长的会话标题'.repeat(5));
  assert.ok(long.length <= 43);
  assert.match(long, /…$/);
});

test('titleFromAssistant prefers heading then first sentence', () => {
  assert.equal(titleFromAssistant('## 登录模块设计\n\n内容'), '登录模块设计');
  assert.equal(titleFromAssistant('这个会话处理数据导出问题。后面还有很多内容'), '这个会话处理数据导出问题');
  assert.equal(titleFromAssistant('短'), null);
});

test('summarizeActivity counts tool usage', () => {
  const summary = summarizeActivity(['read_file', 'read_file', 'run_command']);
  assert.ok(summary.includes('2 种工具'));
  assert.ok(summary.includes('3 次调用'));
  assert.ok(summary.includes('read_file×2'));
  assert.equal(summarizeActivity([]), '');
});

test('suggestTitle picks strategy by available data', () => {
  assert.equal(suggestTitle({ firstUser: '请帮我重构鉴权模块并补测试' }).strategy, 'first-user');
  assert.equal(suggestTitle({ firstUser: '继续', firstAssistant: '## 数据导出方案\n实现中' }).strategy, 'assistant-heading');
  assert.equal(suggestTitle({ firstUser: '好', toolNames: ['read_file'] }).strategy, 'activity');
  assert.equal(suggestTitle({}).strategy, 'fallback');
});
