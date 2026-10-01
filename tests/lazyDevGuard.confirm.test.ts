import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createGuardConfirmationChannel,
  formatTerminalOptions,
  matchTerminalAnswer,
} from '../src/guard/confirm.js';
import type { GuardConfirmationRequest } from '../src/guard/types.js';

const request: GuardConfirmationRequest = {
  title: '需求翻译确认',
  question: '这份专业需求表达准确吗？',
  options: [
    { label: '准确，继续', description: '按此需求进入检查或开发' },
    { label: '补充信息', description: '我再补充一些细节' },
    { label: '重新描述', description: '我会重新描述需求' },
  ],
};

test('prefers the popup channel when it answers in time', async () => {
  const sent: GuardConfirmationRequest[] = [];
  const channel = createGuardConfirmationChannel({
    timeoutMs: 1000,
    popup: async (req) => {
      sent.push(req);
      return { selectedLabel: '准确，继续', source: 'popup' };
    },
  });
  const result = await channel.confirm(request);
  assert.ok(result);
  assert.equal(result.source, 'popup');
  assert.equal(result.selectedLabel, '准确，继续');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '需求翻译确认');
});

test('falls back to the terminal menu when no popup transport exists', async () => {
  const seen: string[] = [];
  const channel = createGuardConfirmationChannel({
    terminal: async (text) => {
      seen.push(text);
      return '2';
    },
  });
  const result = await channel.confirm(request);
  assert.ok(result);
  assert.equal(result.source, 'terminal');
  assert.equal(result.selectedLabel, '补充信息');
  assert.match(seen[0], /1\. 准确，继续/);
});

test('a timed-out popup hands over to the terminal fallback', async () => {
  let popupAsked = false;
  const channel = createGuardConfirmationChannel({
    timeoutMs: 5,
    popup: async () => {
      popupAsked = true;
      return await new Promise((resolve) => setTimeout(() => resolve(null), 50));
    },
    terminal: async () => '3',
  });
  const result = await channel.confirm(request);
  assert.ok(result);
  assert.equal(popupAsked, true);
  assert.equal(result.source, 'terminal');
  assert.equal(result.selectedLabel, '重新描述');
});

test('with no transport at all the safe first option is returned', async () => {
  const channel = createGuardConfirmationChannel({});
  const result = await channel.confirm(request);
  assert.ok(result);
  assert.equal(result.source, 'terminal');
  assert.equal(result.selectedLabel, '准确，继续');
});

test('matchTerminalAnswer accepts a number, a label, and rejects junk', () => {
  assert.equal(matchTerminalAnswer(request, '1'), '准确，继续');
  assert.equal(matchTerminalAnswer(request, ' 2 '), '补充信息');
  assert.equal(matchTerminalAnswer(request, '重新描述'), '重新描述');
  assert.equal(matchTerminalAnswer(request, '99'), null);
  assert.equal(matchTerminalAnswer(request, ''), null);
});

test('formats a numbered terminal menu with labels and descriptions', () => {
  const text = formatTerminalOptions(request);
  assert.match(text, /需求翻译确认/);
  assert.match(text, /这份专业需求表达准确吗？/);
  assert.match(text, /1\. 准确，继续：按此需求进入检查或开发/);
});
