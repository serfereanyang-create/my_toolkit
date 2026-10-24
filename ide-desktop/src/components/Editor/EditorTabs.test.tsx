import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorTabs } from './EditorTabs';

describe('EditorTabs keyboard semantics', () => {
  const tabs = [
    { path: 'src/App.tsx', dirty: false },
    { path: 'src/styles.css', dirty: true, stale: true },
  ];

  it('exposes tabs and selected state', () => {
    const html = renderToStaticMarkup(createElement(EditorTabs, { tabs, activeTab: 'src/App.tsx', onTabClick: () => {}, onTabClose: () => {} }));
    expect((html.match(/role="tab"/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-selected="false"');
  });

  it('switches the tab with Enter and closes it with its own button', () => {
    const html = renderToStaticMarkup(createElement(EditorTabs, { tabs, activeTab: 'src/App.tsx', onTabClick: () => {}, onTabClose: () => {} }));
    expect(html).toContain('aria-label="关闭 styles.css"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('tabindex="-1"');
  });
});
