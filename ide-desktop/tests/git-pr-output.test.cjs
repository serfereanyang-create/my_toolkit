'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parsePullRequestOutput } = require('../electron/git.cjs');

test('PR output parses GitHub.com and Enterprise pull request URLs', () => {
  assert.deepEqual(parsePullRequestOutput('https://github.com/acme/app/pull/42\n', 'Fix bug'), {
    url: 'https://github.com/acme/app/pull/42', number: 42, title: 'Fix bug',
  });
  assert.deepEqual(parsePullRequestOutput('created: https://git.example.internal/team/app/pull/7.', 'Enterprise'), {
    url: 'https://git.example.internal/team/app/pull/7', number: 7, title: 'Enterprise',
  });
});

test('unparseable PR output stays honest and does not invent a number', () => {
  assert.deepEqual(parsePullRequestOutput('Pull request created', 'Draft'), {
    url: 'Pull request created', number: null, title: 'Draft',
  });
});
