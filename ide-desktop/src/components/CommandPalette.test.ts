import { describe, expect, it, vi } from 'vitest';
import { buildCommands, composeRows, type CommandEntry } from './CommandPalette';
import type { AppState } from '../types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The palette is the one surface a user reads without any surrounding context,
 * so a language split there is especially visible: the group headers said 视图
 * / 会话 / 编辑器 while every row underneath was English (Show Chat, Quick Open
 * File, …) in an otherwise Chinese application.
 *
 * These tests pin both halves of the contract: rows are Chinese, and the
 * English terms someone might type are still searchable through `keywords`.
 */
function catalog(): CommandEntry[] {
  const noop = vi.fn();
  return buildCommands({
    state: { agentStatus: 'idle' } as unknown as AppState,
    go: noop,
    newChat: noop,
    toggleTerminal: noop,
    toggleTerminalFloat: noop,
    toggleDetails: noop,
    toggleSideChat: noop,
    toggleBrowser: noop,
    toggleWorkDetails: noop,
    togglePreview: noop,
    toggleNotes: noop,
    toggleWorkspaceTools: noop,
    openSettings: noop,
    openWorkspace: noop,
    openQuickOpen: noop,
    openHelp: noop,
    cancelTurn: noop,
    setTheme: noop,
    exportChat: noop,
    saveChatFile: noop,
  });
}

describe('command palette catalog', () => {
  it('uses only ids and groups the palette knows how to render', () => {
    const groups = new Set(['view', 'chat', 'editor', 'panels', 'settings', 'workspace']);
    const ids = catalog().map((cmd) => cmd.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const cmd of catalog()) expect(groups.has(cmd.group)).toBe(true);
  });

  it('renders a Chinese title on every row', () => {
    // Anything with no CJK character is a leftover English label. Shortcuts and
    // product names (Git) are not titles on their own, so this catches the
    // whole-row cases without banning Latin text inside a Chinese title.
    const latinOnly = catalog().filter((cmd) => !/[一-鿿]/.test(cmd.title));
    expect(latinOnly.map((cmd) => `${cmd.id}: ${cmd.title}`)).toEqual([]);
  });

  it('keeps English terms searchable as keywords', () => {
    const byId = new Map(catalog().map((cmd) => [cmd.id, cmd]));
    const expectKeyword = (id: string, term: string) => {
      const entry = byId.get(id);
      expect(entry, id).toBeTruthy();
      expect((entry!.keywords ?? '').toLowerCase()).toContain(term);
    };
    expectKeyword('editor.terminal', 'terminal');
    expectKeyword('settings.theme.dark', 'theme');
    expectKeyword('view.quickopen', 'quick open');
    expectKeyword('chat.export', 'markdown');
    expectKeyword('panels.browser', 'browser');
    expectKeyword('help.overlay', 'shortcuts');
  });

  it('marks the turn-cancel command unavailable unless a turn is running', () => {
    expect(catalog().find((cmd) => cmd.id === 'chat.cancel')?.enabled).toBe(false);
  });

  it('prints each group under one header', () => {
    // The catalog declares the settings rows last but interleaves groups, and
    // headers are derived from runs of the same group. Feeding the raw
    // declaration order straight to the list printed 设置 twice, with 工作区
    // wedged between the halves.
    const headers = composeRows(catalog(), '').filter((row) => row.header).map((row) => row.header);
    expect(headers).toEqual([...new Set(headers)]);
    expect(headers).toEqual(['视图', '会话', '编辑器', '面板', '设置', '工作区']);
  });

  it('keeps rows contiguous inside their section', () => {
    const groups = composeRows(catalog(), '').map((row) => row.item.group);
    // Every group's rows must appear in a single run, so the section count
    // equals the number of distinct groups.
    let runs = 0;
    for (let i = 0; i < groups.length; i += 1) if (i === 0 || groups[i] !== groups[i - 1]) runs += 1;
    expect(runs).toBe(new Set(groups).size);
  });

  it('still ranks by match when a term is typed', () => {
    const rows = composeRows(catalog(), 'terminal');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].item.id).toBe('editor.terminal');
    // English keyword match must survive the localization.
    const themeRows = composeRows(catalog(), 'theme').map((row) => row.item.id);
    expect(themeRows).toEqual(expect.arrayContaining(['settings.theme.light', 'settings.theme.dark', 'settings.theme.system']));
  });
});

describe('overlay placement', () => {
  const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');

  it('mounts the notes drawer outside .main', () => {
    // The drawer is grid track 3 of .chat-shell, like the inspector and the
    // browser panel, so it must be a direct child of the shell. Inside .main
    // it would join .main's own grid instead — and as a position:fixed child
    // it anchored to .main, which is a size container, so it slid into the
    // middle of the conversation whenever a side panel narrowed that column.
    const mainStart = app.indexOf('<div className="main">');
    const drawer = app.indexOf('<SessionNotesDrawer');
    // The first sibling after .main closes is PreviewSidebar; the close tag
    // sits between them. Locate that boundary by the drawer's own comment
    // block, which starts right after it.
    const afterMain = app.indexOf('</div>', app.indexOf('onManageModels'));
    expect(mainStart).toBeGreaterThan(-1);
    expect(afterMain).toBeGreaterThan(mainStart);
    expect(drawer).toBeGreaterThan(afterMain);
  });
});
