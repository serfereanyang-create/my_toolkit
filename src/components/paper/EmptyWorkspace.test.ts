import { describe, expect, it } from 'vitest';
import { emptyWorkspaceCopy } from './EmptyWorkspace';

describe('emptyWorkspaceCopy', () => {
  it('returns loading copy', () => {
    expect(emptyWorkspaceCopy('loading')).toContain('正在恢复本地账户');
  });

  it('returns anonymous login guidance', () => {
    expect(emptyWorkspaceCopy('anonymous')).toContain('登录');
  });

  it('returns authenticated empty library guidance', () => {
    expect(emptyWorkspaceCopy('authenticated')).toBe('当前账户还没有论文卡片');
  });
});
