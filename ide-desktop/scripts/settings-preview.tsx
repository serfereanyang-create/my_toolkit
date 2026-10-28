// The fixture must be installed before any component module is evaluated:
// src/lib/ipc.ts captures `window.zcodeDesktop` at module scope, so assigning
// it from this module's body (after the imports) would leave `desktop`
// undefined and every host-backed page would unmount. Keep this import first.
// See settings-preview-mock.ts for the shapes and the ?scenario=empty variant.
import './settings-preview-mock';
import { PREVIEW_SETTINGS } from './settings-preview-mock';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsView } from '../src/components/Settings/SettingsView';
import type { SettingsNavId } from '../src/components/Settings/SettingsView';
import { MemoryPanel } from '../src/components/MemoryPanel';
import { ToastLayer } from '../src/components/ToastLayer';
import type { DesktopSettings } from '../src/types';
import {
  applyHostPatches, applyThemePreference, ensureHostNamespaces, ensureShellCss,
  findState, restoreHost, runDrive, settingsForState,
} from './settings-states-preview';
import type { PreviewStateDef } from './settings-states-preview';
import '../src/styles.css';
import '../src/conversation-shell.css';
import '../src/settings-shell.css';

const settings: DesktopSettings = PREVIEW_SETTINGS;

// Page selection for the a11y audit (`--page=settings`): `?page=<nav id>` seeds
// the page, and `window.settingsPreview.open(id)` switches it afterwards. The
// switch remounts SettingsView — `initialPage` only seeds useState, so changing
// the prop alone would leave the old page on screen.
const NAV_IDS: SettingsNavId[] = [
  'general', 'appearance', 'model', 'usage', 'personalize', 'shortcuts',
  'plugins', 'browser', 'computer',
  'hooks', 'connections', 'git', 'environment', 'worktrees',
  'archived',
];
const params = new URLSearchParams(window.location.search);
const asked = params.get('page');
const FIRST_PAGE: SettingsNavId = NAV_IDS.find((id) => id === asked) ?? 'general';

/* ── inner-state mode (?state=<id>) ──────────────────────────────────────────
 * The a11y audit drives the 15 pages only to their first paint. Everything a
 * page becomes afterwards — an inline editor, an armed shortcut chip, a confirm
 * dialog, an error row, a toast — is reached here instead, by URL, so the probe
 * needs no click of its own and `scripts/a11y-audit.cjs` stays untouched.
 *
 * Inert unless `?state=` names a known id: with no state the module takes the
 * exact branch it always took, which is what keeps the 120-combination audit at
 * 6232 / 2092 / 3368.
 */
const STATE: PreviewStateDef | null = findState(params.get('state'));
const THEME_PARAM = params.get('theme');
const initialTheme = (() => {
  const pref = THEME_PARAM ?? undefined;
  if (pref === 'dark' || pref === 'light' || pref === 'system') return pref;
  return undefined;
})();

if (STATE) {
  // Host shape before any component mounts: patches replace methods, so they
  // must land before the page's first effect fires (a delayed listArchived has
  // to be delayed on mount, not after).
  ensureHostNamespaces();
  applyHostPatches(STATE.patches ?? []);
  if (initialTheme) applyThemePreference(initialTheme);
  if (STATE.needsShellCss) void ensureShellCss();
}

function Preview() {
  const [page, setPage] = useState<SettingsNavId>(FIRST_PAGE);
  const save = (next: DesktopSettings) => { (window as unknown as { settingsPreviewState?: DesktopSettings }).settingsPreviewState = next; };
  useEffect(() => {
    (window as unknown as { settingsPreview?: unknown }).settingsPreview = {
      pages: NAV_IDS,
      page: () => page,
      open: (id: SettingsNavId) => setPage(id),
    };
    document.documentElement.dataset.previewReady = 'true';
  }, [page]);
  return <SettingsView key={page} settings={settings} initialPage={page} onBack={() => {}} onSave={save} onSaveKey={async () => {}} />;
}

/**
 * One named inner state. The drive runs once, after the first paint, exactly as
 * a person would have caused it; the result is published on
 * `window.__previewStateReport` for the probe to read alongside its scan.
 *
 * `save` keeps the shape real: a settings write is merged back into the
 * rendered settings object, so a theme change or a plugin toggle is visible in
 * the same state that was measured (the app's own write-back does the same
 * through settings.set).
 */
function StatesPreview({ state }: { state: PreviewStateDef }) {
  const [current, setCurrent] = useState<DesktopSettings>(() => settingsForState(settings, state));
  const [page] = useState<SettingsNavId>(state.page ?? FIRST_PAGE);
  const started = useRef(false);

  const save = (next: DesktopSettings) => {
    (window as unknown as { settingsPreviewState?: DesktopSettings }).settingsPreviewState = next;
    setCurrent(next);
    // 外观 → 主题 has no runtime consumer in the fixture shell (App.tsx applies
    // it in the real app), so mirror that one line here; every other pref is
    // read straight off `current` by its page.
    applyThemePreference(next.preferences?.theme);
  };

  const onSaveKey = async (providerId: string, apiKey: string) => {
    void providerId;
    void apiKey;
    // The failure variant is opt-in from the drive, so the same fixture serves
    // both the success and the error path without a second build.
    if ((window as unknown as { __previewSaveKeyFail?: boolean }).__previewSaveKeyFail) {
      throw new Error('预览注入：保存密钥失败');
    }
  };

  useEffect(() => { if (state.toast && state.needsShellCss) void ensureShellCss(); }, [state]);

  // Drive runs after the page's own mount effects (data load, effects) have
  // had a frame to run, so a row exists to click.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let cancelled = false;
    (async () => {
      const report: {
        id: string; missing: string[]; forbidden: string[]; textMismatch: Array<{ selector: string; expected: string }>;
        expectMissingIsFinding: boolean; errors: string[];
      } = { id: state.id, missing: [], forbidden: [], textMismatch: [], expectMissingIsFinding: Boolean(state.expectMissingIsFinding), errors: [] };
      try {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await runDrive(state.steps ?? []);
        for (const selector of state.expect ?? []) {
          if (!document.querySelector(selector)) report.missing.push(selector);
        }
        for (const selector of state.forbid ?? []) {
          if (document.querySelector(selector)) report.forbidden.push(selector);
        }
        for (const check of state.expectText ?? []) {
          const el = document.querySelector(check.selector);
          if (!el || !(el.textContent || '').includes(check.text)) report.textMismatch.push({ selector: check.selector, expected: check.text });
        }
      } catch (error) {
        report.errors.push(error instanceof Error ? error.message : String(error));
      }
      if (cancelled) return;
      (window as unknown as { __previewStateReport?: unknown }).__previewStateReport = report;
      document.documentElement.dataset.previewState = state.id;
      document.documentElement.dataset.previewReady = 'true';
    })();
    return () => { cancelled = true; };
  }, [state]);

  if (state.surface === 'memory') {
    return (
      <>
        <MemoryPanel onOpenFile={() => {}} />
        {state.toast && <ToastLayer onFocusChat={() => {}} />}
      </>
    );
  }

  return (
    <>
      <SettingsView
        key={page}
        settings={current}
        initialPage={page}
        onBack={() => {}}
        onSave={save}
        onSaveKey={onSaveKey}
      />
      {state.toast && <ToastLayer onFocusChat={() => {}} />}
    </>
  );
}

// Exposed for the probe: switch pages without unmounting the state wrapper, so
// a state that lives on another page can still be inspected in place.
if (STATE) {
  (window as unknown as { settingsPreviewStates?: unknown }).settingsPreviewStates = {
    id: STATE.id,
    restoreHost,
  };
}

const container = document.getElementById('root')!;
createRoot(container).render(STATE ? <StatesPreview state={STATE} /> : <Preview />);
