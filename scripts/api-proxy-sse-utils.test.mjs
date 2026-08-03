import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSseFrames, inspectSseFrames } from './api-proxy-sse-utils.mjs';

test('parseSseFrames extracts JSON data frames and [DONE]', () => {
  const buffer = Buffer.from(`data: {"id":"resp_123","delta":{"content":"Hi"}}\n\ndata: [DONE]\n\n`);
  const frames = parseSseFrames(buffer);
  
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, 'data');
  assert.equal(frames[0].data.id, 'resp_123');
  assert.equal(frames[0].data.delta.content, 'Hi');
  assert.equal(frames[1].type, 'done');
});

test('parseSseFrames skips malformed JSON', () => {
  const buffer = Buffer.from(`data: {"invalid\n\ndata: {"valid":true}\n\n`);
  const frames = parseSseFrames(buffer);
  
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.valid, true);
});

test('inspectSseFrames detects upstream_error without content', () => {
  const frames = [
    { type: 'data', data: { id: 'resp_123', delta: { role: 'assistant' } } },
    { type: 'data', data: { error: { message: 'Upstream service temporarily unavailable', type: 'upstream_error' } } },
    { type: 'done' },
  ];
  
  const result = inspectSseFrames(frames);
  assert.equal(result.shouldRetry, true);
});

test('inspectSseFrames does not retry when real content is present', () => {
  const frames = [
    { type: 'data', data: { id: 'resp_123', delta: { role: 'assistant' } } },
    { type: 'data', data: { delta: { content: 'Hello' } } },
    { type: 'data', data: { error: { message: 'Upstream service temporarily unavailable' } } },
  ];
  
  const result = inspectSseFrames(frames);
  assert.equal(result.shouldRetry, false);
  assert.equal(result.hasContent, true);
});

test('inspectSseFrames is inconclusive when no error and no conclusive content', () => {
  const frames = [
    { type: 'data', data: { id: 'resp_123', object: 'chat.completion.chunk', created: 1234 } },
  ];
  
  const result = inspectSseFrames(frames);
  assert.equal(result.shouldRetry, false);
  assert.equal(result.hasContent, false);
});

test('inspectSseFrames recognizes content in delta.content', () => {
  const frames = [
    { type: 'data', data: { delta: { content: 'ok' } } },
  ];
  
  const result = inspectSseFrames(frames);
  assert.equal(result.shouldRetry, false);
  assert.equal(result.hasContent, true);
});

test('inspectSseFrames recognizes content in choices[].delta.content', () => {
  const frames = [
    { type: 'data', data: { choices: [{ index: 0, delta: { content: 'Hi' } }] } },
  ];
  
  const result = inspectSseFrames(frames);
  assert.equal(result.shouldRetry, false);
  assert.equal(result.hasContent, true);
});

test('inspectSseFrames does not treat role-only delta as content', () => {
  const frames = [
    { type: 'data', data: { choices: [{ delta: { role: 'assistant' } }] } },
  ];
  
  const result = inspectSseFrames(frames);
  assert.equal(result.shouldRetry, false);
  assert.equal(result.hasContent, false);
});

test('inspectSseFrames recognizes Responses API output as content', () => {
  const frames = [
    { type: 'data', data: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } },
  ];
  
  const result = inspectSseFrames(frames);
  assert.equal(result.shouldRetry, false);
  assert.equal(result.hasContent, true);
});
