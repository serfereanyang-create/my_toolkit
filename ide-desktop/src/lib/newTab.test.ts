import { describe, expect, it } from 'vitest';
import { ARTIFACT_FILTERS, ARTIFACT_PLUGIN_IDS, NEW_TAB_SHORTCUTS, artifactTiles, toWorkspaceRelative } from './newTab';
import type { PluginDef, PluginStatus } from './plugins';

const def = (id: string, name: string): PluginDef => ({
  id,
  name,
  desc: `${name} 的描述`,
  category: 'artifacts',
  requires: 'workspace',
  platforms: null,
  route: `/plugin/${id}`,
});

const status = (entries: Array<{ id: string; available: boolean; reason?: string | null }>): PluginStatus => ({
  plugins: entries.map((entry) => ({ id: entry.id, available: entry.available, reason: entry.reason ?? null })),
  workspaceRoot: 'C:\\proj',
  hasGit: true,
  platform: 'win32',
});

describe('新标签页的五个入口', () => {
  it('正好是截图上的那五个，且顺序固定', () => {
    expect(NEW_TAB_SHORTCUTS.map((item) => item.action)).toEqual(['files', 'browser', 'terminal', 'review', 'sidechat']);
    expect(NEW_TAB_SHORTCUTS.map((item) => item.title)).toEqual(['文件', '浏览器', '终端', '审查', '辅助对话']);
  });
});

describe('artifactTiles', () => {
  it('按注册表顺序给出四个工件，缺哪个就少哪个', () => {
    const tiles = artifactTiles([def('pdf', 'PDF'), def('documents', 'Documents')], null);
    expect(tiles.map((tile) => tile.id)).toEqual(['pdf', 'documents']);
    expect(tiles[0]).toMatchObject({ name: 'PDF', desc: 'PDF 的描述', available: true, reason: null });
  });

  it('注册表里完全没有这个插件时，不摆一个假格子', () => {
    expect(artifactTiles([], null)).toEqual([]);
  });

  it('禁用的插件留着格子但标成不可用，并带上原因', () => {
    const tiles = artifactTiles(
      ARTIFACT_PLUGIN_IDS.map((id) => def(id, id)),
      status([
        { id: 'pdf', available: true },
        { id: 'presentations', available: false, reason: '需要打开工作区' },
        { id: 'spreadsheets', available: true },
        { id: 'documents', available: true },
      ]),
    );
    const presentations = tiles.find((tile) => tile.id === 'presentations');
    expect(presentations).toMatchObject({ available: false, reason: '需要打开工作区' });
    expect(tiles.filter((tile) => tile.available)).toHaveLength(3);
  });

  it('格子名用中文标签，不跟着注册表的英文名走', () => {
    const tiles = artifactTiles([def('presentations', 'Presentations'), def('documents', 'Documents')], null);
    expect(tiles.map((tile) => tile.name)).toEqual(['演示文稿', 'Word 文档']);
    expect(tiles[0].desc).toBe('Presentations 的描述');
  });

  it('注册表顺序和格子顺序不一致时，格子顺序不变', () => {
    const tiles = artifactTiles([def('documents', 'Word'), def('pdf', 'PDF')], status([]));
    expect(tiles.map((tile) => tile.id)).toEqual(['pdf', 'documents']);
  });
});

describe('ARTIFACT_FILTERS', () => {
  it('每种工件都给了可交给系统对话框的扩展名，且不带点', () => {
    for (const id of ARTIFACT_PLUGIN_IDS) {
      const filter = ARTIFACT_FILTERS[id];
      expect(filter.label.length).toBeGreaterThan(0);
      expect(filter.extensions.length).toBeGreaterThan(0);
      for (const ext of filter.extensions) expect(ext).toMatch(/^[a-z0-9]+$/);
    }
  });
});

describe('toWorkspaceRelative', () => {
  it('工作区内的文件转成相对路径，分隔符统一成 /', () => {
    expect(toWorkspaceRelative('C:\\proj', 'C:\\proj\\docs\\a.pdf')).toBe('docs/a.pdf');
    expect(toWorkspaceRelative('C:/proj', 'C:/proj/docs/a.pdf')).toBe('docs/a.pdf');
  });

  it('大小写和末尾斜杠不影响判定', () => {
    expect(toWorkspaceRelative('C:\\Proj\\', 'c:\\proj\\docs\\a.pdf')).toBe('docs/a.pdf');
  });

  it('工作区根目录本身返回空串（不是 null，也不是绝对路径）', () => {
    expect(toWorkspaceRelative('C:\\proj', 'C:\\proj\\')).toBe('');
  });

  it('越界、前缀相同但不是子目录、空 root 一律返回 null', () => {
    expect(toWorkspaceRelative('C:\\proj', 'C:\\other\\a.pdf')).toBeNull();
    expect(toWorkspaceRelative('C:\\proj', 'C:\\proj-other\\a.pdf')).toBeNull();
    expect(toWorkspaceRelative('', 'C:\\proj\\a.pdf')).toBeNull();
  });
});
