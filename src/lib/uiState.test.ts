import { describe, expect, it } from 'vitest';
import {
  getThemeTokens,
  nextActiveDrawer,
  nextSaveStatus,
  resolveSessionStatus,
} from './uiState';

describe('getThemeTokens', () => {
  it('returns distinct surface tokens for all three themes', () => {
    const cool = getThemeTokens('cool');
    const paper = getThemeTokens('paper');
    const dark = getThemeTokens('dark');

    const fingerprints = [cool, paper, dark].map((token) =>
      [token.appBg, token.sidebarBg, token.canvasBg, token.elevatedBg, token.accent, token.border, token.shadow].join('|'),
    );
    expect(new Set(fingerprints).size).toBe(3);
    expect(cool.canvasBg).not.toBe(paper.canvasBg);
    expect(cool.elevatedBg).not.toBe(paper.elevatedBg);
    expect(dark.appBg).not.toBe(cool.appBg);
    expect(dark.sidebarBg).not.toBe(dark.canvasBg);
    expect(dark.elevatedBg).not.toBe(dark.canvasBg);

    expect(dark.isDark).toBe(true);
    expect(cool.isDark).toBe(false);
    expect(paper.isDark).toBe(false);

    for (const theme of [cool, paper, dark]) {
      expect(theme.antPrimary).toBe(theme.accent);
      expect(theme.antBgBase).toBe(theme.appBg);
      expect(theme.antTextBase).toBe(theme.textPrimary);
      expect(theme.elevatedBg).toBeTruthy();
      expect(theme.inputBg).toBeTruthy();
    }
  });
});

describe('nextActiveDrawer', () => {
  it('opens a drawer and closes the other', () => {
    expect(nextActiveDrawer(null, 'quality')).toBe('quality');
    expect(nextActiveDrawer('quality', 'account')).toBe('account');
    expect(nextActiveDrawer('account', 'account')).toBe(null);
  });
});

describe('nextSaveStatus', () => {
  it('tracks idle → saving → saved / failed → retry', () => {
    expect(nextSaveStatus('idle', 'start')).toBe('saving');
    expect(nextSaveStatus('saving', 'success')).toBe('saved');
    expect(nextSaveStatus('saving', 'error')).toBe('failed');
    expect(nextSaveStatus('failed', 'retry')).toBe('saving');
  });
});

describe('resolveSessionStatus', () => {
  it('maps loading and auth presence', () => {
    expect(resolveSessionStatus({ loading: true, user: null })).toBe('loading');
    expect(resolveSessionStatus({ loading: true, user: { id: 'u1' } })).toBe('loading');
    expect(resolveSessionStatus({ loading: false, user: null })).toBe('anonymous');
    expect(resolveSessionStatus({ loading: false, user: { id: 'u1' } })).toBe('authenticated');
  });
});

import type { Paper, AuthUser } from '../types/paperApp';

describe('paperApp types compile via usage', () => {
  it('accepts minimal paper shape', () => {
    const paper: Paper = {
      id: 'p1',
      title: 'T',
      authors: '',
      year: '2026',
      source: '',
      doi: '',
      url: '',
      status: '未读',
      tags: [],
      question: '',
      method: '',
      dataset: '',
      findings: '',
      limitations: '',
      credibility: '',
      evidence: [],
      checklist: {},
    };
    const user: AuthUser = {
      id: 'u1',
      username: 'alice',
      email: '',
      displayName: '',
      institution: '',
      researchField: '',
      notes: '',
    };
    expect(paper.id).toBe('p1');
    expect(user.username).toBe('alice');
  });
});
