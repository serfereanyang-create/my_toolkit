import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewTabPage } from './NewTabPage';
import type { ArtifactTile } from '../lib/newTab';

const tile = (id: ArtifactTile['id'], available = true, reason: string | null = null): ArtifactTile => ({
  id,
  name: id,
  desc: `${id} 描述`,
  available,
  reason,
});

function render(overrides: {
  artifacts?: ArtifactTile[];
  workspaceReady?: boolean;
} = {}) {
  return renderToStaticMarkup(createElement(NewTabPage, {
    artifacts: overrides.artifacts ?? [tile('pdf'), tile('presentations'), tile('spreadsheets'), tile('documents')],
    workspaceReady: overrides.workspaceReady ?? true,
    onShortcut: () => {},
    onOpenArtifact: () => {},
    onOpenAllPlugins: () => {},
  }));
}

describe('NewTabPage', () => {
  it('五个入口各有一个「打开」，并且每个都带自己的动作标识', () => {
    const html = render();
    const actions = [...html.matchAll(/data-newtab-action="([a-z]+)"/g)].map((match) => match[1]);
    expect(actions).toEqual(['files', 'browser', 'terminal', 'review', 'sidechat']);
    expect(html).toContain('>打开<');
    expect(html).toContain('辅助对话');
  });

  it('四个工件格按 id 渲染，可用时按钮可点', () => {
    const html = render();
    const ids = [...html.matchAll(/data-newtab-artifact="([a-z]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(['pdf', 'presentations', 'spreadsheets', 'documents']);
    expect(html).not.toMatch(/<button[^>]*data-newtab-artifact="pdf"[^>]*disabled/);
  });

  it('插件不可用时按钮禁用，并把原因写在 title 上', () => {
    const html = render({ artifacts: [tile('pdf', false, '需要打开工作区')] });
    expect(html).toMatch(/<button[^>]*data-newtab-artifact="pdf"[^>]*disabled/);
    expect(html).toContain('需要打开工作区');
  });

  it('没有工作区时工件格一律禁用（预览按工作区解析路径）', () => {
    const html = render({ workspaceReady: false });
    for (const id of ['pdf', 'presentations', 'spreadsheets', 'documents']) {
      expect(html).toMatch(new RegExp(`<button[^>]*data-newtab-artifact="${id}"[^>]*disabled`));
    }
    // 上方五个入口不依赖工作区，不能一起禁用。
    expect(html).not.toMatch(/<button[^>]*data-newtab-action="files"[^>]*disabled/);
  });

  it('一个可用工件都没有时给出去设置的路，而不是空着', () => {
    const html = render({ artifacts: [] });
    expect(html).toContain('还没有启用的文档插件');
    expect(html).toContain('去设置');
  });

  it('保留「查看所有插件」的入口', () => {
    expect(render()).toContain('查看所有插件');
  });
});
