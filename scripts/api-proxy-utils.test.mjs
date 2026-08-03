import assert from 'node:assert/strict';
import test from 'node:test';

import {
  headerValueToByteString,
  isRetryableFetchError,
  normalizeModelNameForUpstream,
} from './api-proxy-utils.mjs';

test('removes ZCode provider UUID prefix from model names', () => {
  assert.equal(
    normalizeModelNameForUpstream('03351671-c6eb-47c4-84b7-72d2c60a8947/grok-4.5'),
    'grok-4.5',
  );
});

test('keeps plain upstream model names unchanged', () => {
  assert.equal(normalizeModelNameForUpstream('grok-4.5'), 'grok-4.5');
});

test('keeps non-UUID scoped model names unchanged', () => {
  assert.equal(normalizeModelNameForUpstream('vendor/grok-4.5'), 'vendor/grok-4.5');
});

test('drops non-ByteString request headers instead of throwing', () => {
  assert.equal(headerValueToByteString('ZCode 中文'), null);
});

test('keeps ASCII request headers unchanged', () => {
  assert.equal(headerValueToByteString('application/json'), 'application/json');
});

test('marks TLS socket setup failures as retryable', () => {
  const error = new TypeError('fetch failed');
  error.cause = { message: 'Client network socket disconnected before secure TLS connection was established' };

  assert.equal(isRetryableFetchError(error), true);
});

test('marks closed upstream sockets as retryable', () => {
  const error = new TypeError('fetch failed');
  error.cause = { message: 'other side closed' };

  assert.equal(isRetryableFetchError(error), true);
});
