/**
 * fimProtocol.ts — FIM 桥的一行请求解析（纯函数，单独放一个文件是为了能单测：
 * fimBridge 一被 import 就会挂上 stdin）。
 *
 * 这一行来自 Electron 主进程的 IPC。`JSON.parse` 之后按类型直接断言，等于把
 * 校验留给下游：`{"prefix": 123}` 会变成 provider 里的 `undefined`，报出来的是
 * 一个跟真正原因无关的错。这里显式收窄，缺什么就说什么。
 */

import type { FimRequest } from '../providers/fim.js';

export type FimRequestLine = { id: string; request: FimRequest };

export function parseFimRequest(line: string): FimRequestLine {
  const parsed: unknown = JSON.parse(line);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('FIM request must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;

  // id 只是回包时的对账标记：缺失也照常处理，用一个占位符而不是整条请求失败。
  const id = typeof record.id === 'string' && record.id ? record.id : 'unknown';

  const required = (key: string) => {
    const value = record[key];
    if (typeof value !== 'string') throw new Error(`FIM request field "${key}" must be a string`);
    return value;
  };
  const optional = (key: string) => {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new Error(`FIM request field "${key}" must be a string`);
    return value;
  };

  const rawMaxTokens = record.maxTokens;
  let maxTokens: number | undefined;
  if (rawMaxTokens !== undefined && rawMaxTokens !== null) {
    if (typeof rawMaxTokens !== 'number' || !Number.isFinite(rawMaxTokens) || rawMaxTokens <= 0) {
      throw new Error('FIM request field "maxTokens" must be a positive number');
    }
    maxTokens = Math.floor(rawMaxTokens);
  }

  return {
    id,
    request: {
      prefix: required('prefix'),
      suffix: required('suffix'),
      language: optional('language'),
      filepath: optional('filepath'),
      maxTokens,
    },
  };
}
