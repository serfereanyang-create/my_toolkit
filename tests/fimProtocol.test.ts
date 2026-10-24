import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFimRequest } from '../src/cli/fimProtocol.js';

/*
 * FIM 桥的每一行都来自 Electron 主进程的 IPC。以前这里是一句
 * `JSON.parse(line) as { id: string } & FimRequest`——盲转之后，
 * `{"prefix": 123}` 会一路走到 provider 才炸，报出来的错跟真正原因无关。
 */

test('合法的请求行被原样收窄', () => {
  const parsed = parseFimRequest(JSON.stringify({
    id: 'abc123',
    prefix: 'const a = ',
    suffix: ';\n',
    language: 'typescript',
    filepath: 'src/a.ts',
    maxTokens: 64,
  }));
  assert.equal(parsed.id, 'abc123');
  assert.deepEqual(parsed.request, {
    prefix: 'const a = ',
    suffix: ';\n',
    language: 'typescript',
    filepath: 'src/a.ts',
    maxTokens: 64,
  });
});

test('可选字段缺失时留 undefined，不造一个假值', () => {
  const parsed = parseFimRequest(JSON.stringify({ id: 'x', prefix: '', suffix: '' }));
  assert.deepEqual(parsed.request, { prefix: '', suffix: '', language: undefined, filepath: undefined, maxTokens: undefined });
});

test('缺 id 用占位符，不因为对账标记整条失败', () => {
  assert.equal(parseFimRequest(JSON.stringify({ prefix: 'a', suffix: 'b' })).id, 'unknown');
});

test('不是 JSON 对象就明说', () => {
  assert.throws(() => parseFimRequest('[1,2,3]'), /must be a JSON object/);
  assert.throws(() => parseFimRequest('"text"'), /must be a JSON object/);
  assert.throws(() => parseFimRequest('{oops'), /JSON/);
});

test('prefix/suffix 不是字符串时报出字段名', () => {
  assert.throws(() => parseFimRequest(JSON.stringify({ prefix: 123, suffix: '' })), /"prefix" must be a string/);
  assert.throws(() => parseFimRequest(JSON.stringify({ prefix: '', suffix: null })), /"suffix" must be a string/);
  assert.throws(() => parseFimRequest(JSON.stringify({ prefix: '', suffix: '', language: 7 })), /"language" must be a string/);
});

test('maxTokens 必须是正数，且向下取整', () => {
  assert.throws(() => parseFimRequest(JSON.stringify({ prefix: '', suffix: '', maxTokens: '64' })), /"maxTokens" must be a positive number/);
  assert.throws(() => parseFimRequest(JSON.stringify({ prefix: '', suffix: '', maxTokens: 0 })), /"maxTokens" must be a positive number/);
  assert.equal(parseFimRequest(JSON.stringify({ prefix: '', suffix: '', maxTokens: 12.9 })).request.maxTokens, 12);
});
