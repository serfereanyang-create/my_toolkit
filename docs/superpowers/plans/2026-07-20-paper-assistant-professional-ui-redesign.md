# Paper Assistant Professional UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the paper assistant desktop UI into a minimal cold-professional two-column layout with right-side drawers, three visually distinct themes, clearer typography, and non-flashy empty/loading states—without changing account, SQLite, or paper business logic.

**Architecture:** Keep Electron auth/library IPC and the current paper data model. Extract pure UI state helpers first (theme tokens, drawer exclusivity, save status, session status). Then split the monolithic `src/App.tsx` into focused React components and restyle `src/styles.css` around a dual-pane shell + 400px drawers. Business handlers stay in `App.tsx` (or a thin controller layer) and pass callbacks into presentational components.

**Tech Stack:** React 19, Ant Design 6, TypeScript, Vite, Vitest, Electron, existing `desktopApi.auth` / `desktopApi.library`.

**Spec:** `docs/superpowers/specs/2026-07-18-paper-assistant-professional-ui-redesign.md`

---

## File map

| File | Responsibility |
|------|----------------|
| `src/lib/uiState.ts` | Pure helpers: theme tokens, drawer toggle, save status transitions, session status mapping |
| `src/lib/uiState.test.ts` | Unit tests for the pure UI state helpers |
| `src/types/paperApp.ts` | Shared UI/domain types used by components (`Paper`, `AuthUser`, drawer/session/save unions) |
| `src/components/paper/AppHeader.tsx` | Top 56px bar: brand/current paper, search, check/theme/account/more |
| `src/components/paper/PaperLibrary.tsx` | Collapsible left library list + filters |
| `src/components/paper/PaperWorkspace.tsx` | Editor shell composing metadata/notes/evidence |
| `src/components/paper/PaperMetadata.tsx` | Title + citation metadata grid |
| `src/components/paper/ReadingNotes.tsx` | Overview/notes sections |
| `src/components/paper/EvidenceEditor.tsx` | Evidence list editor |
| `src/components/paper/QualityDrawer.tsx` | Right quality drawer content |
| `src/components/paper/AccountDrawer.tsx` | Login/register/profile/password/logout drawer |
| `src/components/paper/DisplaySettings.tsx` | Theme + advanced display settings |
| `src/components/paper/EmptyWorkspace.tsx` | Loading / anonymous / empty-library center states |
| `src/App.tsx` | Orchestrates business state, IPC, handlers; renders shell with extracted components |
| `src/styles.css` | Dual-pane layout, drawers, theme surfaces, typography, density |
| `electron/main.cjs` | Keep `devTools: false`; no DevTools menu (already done) |
| `scripts/test-renderer-auth-wiring.cjs` | Update markers if account UI moves from popover to drawer |

---

### Task 1: UI state helpers + tests

**Files:**
- Create: `src/lib/uiState.ts`
- Create: `src/lib/uiState.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/uiState.test.ts
import { describe, expect, it } from 'vitest';
import {
  getThemeTokens,
  nextActiveDrawer,
  nextSaveStatus,
  resolveSessionStatus,
  type AppTheme,
} from './uiState';

describe('getThemeTokens', () => {
  it('returns distinct surface tokens for all three themes', () => {
    const cool = getThemeTokens('cool');
    const paper = getThemeTokens('paper');
    const dark = getThemeTokens('dark');

    const fingerprints = [cool, paper, dark].map((token) =>
      [token.appBg, token.sidebarBg, token.canvasBg, token.accent, token.border, token.shadow].join('|'),
    );
    expect(new Set(fingerprints).size).toBe(3);
    expect(cool.canvasBg).not.toBe(paper.canvasBg);
    expect(dark.appBg).not.toBe(cool.appBg);
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
    expect(resolveSessionStatus({ loading: false, user: null })).toBe('anonymous');
    expect(resolveSessionStatus({ loading: false, user: { id: 'u1' } })).toBe('authenticated');
  });
});
```

- [ ] **Step 2: Run tests (expect fail)**

```bash
npm test -- src/lib/uiState.test.ts
```

Expected: FAIL because `src/lib/uiState.ts` does not exist.

- [ ] **Step 3: Implement helpers**

```ts
// src/lib/uiState.ts
export type AppTheme = 'cool' | 'paper' | 'dark';
export type ActiveDrawer = 'quality' | 'account' | null;
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';
export type SessionStatus = 'loading' | 'authenticated' | 'anonymous';

export type ThemeTokens = {
  appBg: string;
  sidebarBg: string;
  canvasBg: string;
  inputBg: string;
  border: string;
  accent: string;
  textPrimary: string;
  textSecondary: string;
  selectedBg: string;
  shadow: string;
  antPrimary: string;
  antBgBase: string;
  antTextBase: string;
  isDark: boolean;
};

const THEMES: Record<AppTheme, ThemeTokens> = {
  cool: {
    appBg: '#eef3f9',
    sidebarBg: '#e4ebf4',
    canvasBg: '#ffffff',
    inputBg: '#f7fafc',
    border: '#b7c5d8',
    accent: '#2454d6',
    textPrimary: '#152033',
    textSecondary: '#5b6b80',
    selectedBg: '#d9e6ff',
    shadow: '0 10px 28px rgba(24, 52, 102, 0.10)',
    antPrimary: '#2454d6',
    antBgBase: '#eef3f9',
    antTextBase: '#152033',
    isDark: false,
  },
  paper: {
    appBg: '#f3eee6',
    sidebarBg: '#ebe3d6',
    canvasBg: '#fffaf2',
    inputBg: '#fbf6ee',
    border: '#c9b79a',
    accent: '#8a5a2b',
    textPrimary: '#2a241c',
    textSecondary: '#6d6154',
    selectedBg: '#f0e2cd',
    shadow: '0 10px 28px rgba(92, 64, 28, 0.10)',
    antPrimary: '#8a5a2b',
    antBgBase: '#f3eee6',
    antTextBase: '#2a241c',
    isDark: false,
  },
  dark: {
    appBg: '#0f141d',
    sidebarBg: '#0b1018',
    canvasBg: '#171c26',
    inputBg: '#1d2430',
    border: '#4a556b',
    accent: '#7aa2ff',
    textPrimary: '#e8edf7',
    textSecondary: '#a7b2c5',
    selectedBg: '#24324a',
    shadow: '0 12px 30px rgba(0, 0, 0, 0.35)',
    antPrimary: '#7aa2ff',
    antBgBase: '#0f141d',
    antTextBase: '#e8edf7',
    isDark: true,
  },
};

export function getThemeTokens(theme: AppTheme): ThemeTokens {
  return THEMES[theme] ?? THEMES.cool;
}

export function nextActiveDrawer(current: ActiveDrawer, target: Exclude<ActiveDrawer, null>): ActiveDrawer {
  return current === target ? null : target;
}

export function nextSaveStatus(current: SaveStatus, event: 'start' | 'success' | 'error' | 'retry'): SaveStatus {
  if (event === 'start' || event === 'retry') return 'saving';
  if (event === 'success') return 'saved';
  if (event === 'error') return 'failed';
  return current;
}

export function resolveSessionStatus(input: { loading: boolean; user: { id: string } | null }): SessionStatus {
  if (input.loading) return 'loading';
  return input.user ? 'authenticated' : 'anonymous';
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- src/lib/uiState.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit if git available**

```bash
git add src/lib/uiState.ts src/lib/uiState.test.ts
git commit -m "feat: add paper ui state helpers for redesign"
```

If not a git repo, skip commit steps for the whole plan.

---

### Task 2: Shared types for paper UI

**Files:**
- Create: `src/types/paperApp.ts`
- Modify: `src/App.tsx` (later tasks import from here)

- [ ] **Step 1: Create shared types**

Move the paper/auth UI types that components will need out of the monolithic App file. Keep behavior identical.

```ts
// src/types/paperApp.ts
export type EditorSection = 'overview' | 'notes' | 'evidence';
export type PaperStatus = '未读' | '粗读' | '精读' | '已摘录' | '待复核';
export type Reliability = '高' | '中' | '低';

export type Evidence = {
  id: string;
  claim: string;
  support: string;
  locator: string;
  reliability: Reliability;
  tags: string[];
};

export type Paper = {
  id: string;
  title: string;
  authors: string;
  year: string;
  source: string;
  doi: string;
  url: string;
  status: PaperStatus;
  tags: string[];
  question: string;
  method: string;
  dataset: string;
  findings: string;
  limitations: string;
  credibility: string;
  evidence: Evidence[];
  checklist: Record<string, boolean>;
};

export type AuthUser = {
  id: string;
  username: string;
  email: string;
  displayName: string;
  institution: string;
  researchField: string;
  notes: string;
};

export type AccountProfile = {
  displayName: string;
  institution: string;
  researchField: string;
  email: string;
  notes: string;
};

export type AuthResult = { ok: true; user: AuthUser } | { ok: false; error: string };
```

- [ ] **Step 2: Add a type smoke test**

```ts
// append to src/lib/uiState.test.ts
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
```

- [ ] **Step 3: Run tests**

```bash
npm test -- src/lib/uiState.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit if git available**

```bash
git add src/types/paperApp.ts src/lib/uiState.test.ts
git commit -m "feat: extract shared paper ui types"
```

---

### Task 3: Dual-pane shell CSS foundation

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: Replace the core layout tokens and shell classes**

At the top of theme definitions, ensure each theme defines distinct surfaces:

```css
:root,
[data-theme='cool'] {
  --bg-app: #eef3f9;
  --bg-sidebar: #e4ebf4;
  --bg-canvas: #ffffff;
  --bg-input: #f7fafc;
  --bg-selected: #d9e6ff;
  --border-soft: #c7d3e3;
  --border-strong: #b7c5d8;
  --text-primary: #152033;
  --text-secondary: #5b6b80;
  --text-tertiary: #8090a3;
  --accent: #2454d6;
  --shadow-panel: 0 10px 28px rgba(24, 52, 102, 0.10);
  --page-max: 900px;
  --library-width: 264px;
  --header-height: 56px;
  --drawer-width: 400px;
}

[data-theme='paper'] {
  --bg-app: #f3eee6;
  --bg-sidebar: #ebe3d6;
  --bg-canvas: #fffaf2;
  --bg-input: #fbf6ee;
  --bg-selected: #f0e2cd;
  --border-soft: #d8c7ad;
  --border-strong: #c9b79a;
  --text-primary: #2a241c;
  --text-secondary: #6d6154;
  --text-tertiary: #948675;
  --accent: #8a5a2b;
  --shadow-panel: 0 10px 28px rgba(92, 64, 28, 0.10);
}

[data-theme='dark'] {
  --bg-app: #0f141d;
  --bg-sidebar: #0b1018;
  --bg-canvas: #171c26;
  --bg-input: #1d2430;
  --bg-selected: #24324a;
  --border-soft: #3a4558;
  --border-strong: #4a556b;
  --text-primary: #e8edf7;
  --text-secondary: #a7b2c5;
  --text-tertiary: #7f8aa0;
  --accent: #7aa2ff;
  --shadow-panel: 0 12px 30px rgba(0, 0, 0, 0.35);
}
```

Replace the main shell rules with dual-pane layout:

```css
.desktop-workbench {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-app);
  color: var(--text-primary);
}

.command-bar {
  height: var(--header-height);
  min-height: var(--header-height);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border-strong);
  background: color-mix(in srgb, var(--bg-canvas) 92%, transparent);
}

.workbench-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: var(--library-width) minmax(0, 1fr);
}

.workbench-body.library-collapsed {
  grid-template-columns: 48px minmax(0, 1fr);
}

.paper-library {
  min-width: 0;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-strong);
  overflow: auto;
}

.paper-editor {
  min-width: 0;
  overflow: auto;
  background: var(--bg-app);
}

.document-page {
  max-width: var(--page-max);
  margin: 0 auto;
  padding: 28px 28px 64px;
  background: var(--bg-canvas);
  border: 1px solid var(--border-soft);
  border-radius: 12px;
  box-shadow: var(--shadow-panel);
  margin-top: 18px;
  margin-bottom: 24px;
}

.drawer-shell {
  width: min(var(--drawer-width), 100vw);
}

.paper-row.active {
  background: var(--bg-selected);
  box-shadow: inset 3px 0 0 var(--accent);
}

.document-title-input {
  font-size: 30px !important;
  line-height: 1.25 !important;
  font-weight: 700 !important;
}

.note-area,
.property-value .ant-input,
.property-value .ant-select-selector {
  background: var(--bg-input) !important;
  border: 1px solid var(--border-soft) !important;
}
```

Remove/disable the old rule that permanently hides product subtitle if the new header wants current paper title; do **not** reintroduce `toggleDevTools`.

- [ ] **Step 2: Build CSS compiles via production build later; for now static check**

```bash
node -e "const fs=require('fs'); const css=fs.readFileSync('src/styles.css','utf8'); if(!css.includes('--library-width')) process.exit(1); if(!css.includes('--drawer-width')) process.exit(1); if(css.includes(\"role: 'toggleDevTools'\")) process.exit(1); console.log('css shell markers ok')"
```

Expected: `css shell markers ok`

- [ ] **Step 3: Commit if git available**

```bash
git add src/styles.css
git commit -m "style: add dual-pane shell tokens and surfaces"
```

---

### Task 4: Extract presentational components

**Files:**
- Create: `src/components/paper/AppHeader.tsx`
- Create: `src/components/paper/PaperLibrary.tsx`
- Create: `src/components/paper/PaperMetadata.tsx`
- Create: `src/components/paper/ReadingNotes.tsx`
- Create: `src/components/paper/EvidenceEditor.tsx`
- Create: `src/components/paper/PaperWorkspace.tsx`
- Create: `src/components/paper/QualityDrawer.tsx`
- Create: `src/components/paper/AccountDrawer.tsx`
- Create: `src/components/paper/DisplaySettings.tsx`
- Create: `src/components/paper/EmptyWorkspace.tsx`

- [ ] **Step 1: Create components with explicit props**

Implement each component as a pure presentational module. Example contracts:

```tsx
// AppHeader.tsx props (representative)
type Props = {
  currentTitle: string;
  issueCount: number;
  saveStatus: 'idle' | 'saving' | 'saved' | 'failed';
  query: string;
  onQueryChange: (value: string) => void;
  onOpenQuality: () => void;
  onOpenAccount: () => void;
  onRetrySave: () => void;
  moreMenuItems: any[];
  displaySettings: React.ReactNode;
};
```

```tsx
// AccountDrawer.tsx props (representative)
type Props = {
  open: boolean;
  onClose: () => void;
  currentUser: AuthUser | null;
  authMode: 'login' | 'register';
  authBusy: boolean;
  authError: string;
  loginForm: { account: string; password: string };
  registerForm: { username: string; email: string; password: string; confirmPassword: string };
  accountDraft: AccountProfile;
  passwordForm: { oldPassword: string; newPassword: string; confirmPassword: string };
  onAuthModeChange: (mode: 'login' | 'register') => void;
  onLoginFormChange: (patch: Partial<{ account: string; password: string }>) => void;
  onRegisterFormChange: (patch: Partial<{ username: string; email: string; password: string; confirmPassword: string }>) => void;
  onAccountDraftChange: <K extends keyof AccountProfile>(key: K, value: AccountProfile[K]) => void;
  onPasswordFormChange: (patch: Partial<{ oldPassword: string; newPassword: string; confirmPassword: string }>) => void;
  onLogin: () => void;
  onRegister: () => void;
  onSaveProfile: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
};
```

Key UI requirements inside components:

1. `AppHeader`: 56px bar; check button shows badge with `issueCount`; save status text + retry when failed.
2. `PaperLibrary`: 264px list; active row class `paper-row active`; collapse toggle.
3. `PaperWorkspace`: document page max width 900px; sections overview/notes/evidence.
4. `QualityDrawer` / `AccountDrawer`: Ant Design `Drawer` width 400, destroyOnClose=false so form state can persist while closed if parent keeps state.
5. `EmptyWorkspace`: render by `sessionStatus`:
   - `loading`: “正在恢复本地账户…”
   - `anonymous`: login CTA
   - `authenticated` empty papers: new paper + import library CTAs
6. `DisplaySettings`: theme segmented first; font/contrast under “高级显示设置”.

- [ ] **Step 2: Add a lightweight component smoke test**

```ts
// src/components/paper/EmptyWorkspace.test.tsx
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyWorkspace } from './EmptyWorkspace';

describe('EmptyWorkspace', () => {
  it('renders loading copy', () => {
    const html = renderToStaticMarkup(createElement(EmptyWorkspace, {
      sessionStatus: 'loading',
      onLogin: () => undefined,
      onCreatePaper: () => undefined,
      onImportLibrary: () => undefined,
    }));
    expect(html).toContain('正在恢复本地账户');
  });

  it('renders anonymous CTA', () => {
    const html = renderToStaticMarkup(createElement(EmptyWorkspace, {
      sessionStatus: 'anonymous',
      onLogin: () => undefined,
      onCreatePaper: () => undefined,
      onImportLibrary: () => undefined,
    }));
    expect(html).toContain('登录');
  });
});
```

If `react-dom/server` is unavailable in current deps, use a pure text helper instead:

```ts
export function emptyWorkspaceCopy(status: 'loading' | 'anonymous' | 'authenticated') {
  if (status === 'loading') return '正在恢复本地账户…';
  if (status === 'anonymous') return '登录本机账户以访问论文库';
  return '当前账户还没有论文卡片';
}
```

and test that helper. Prefer component render if dependencies already support it.

- [ ] **Step 3: Run tests**

```bash
npm test -- src/components/paper/EmptyWorkspace.test.tsx src/lib/uiState.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit if git available**

```bash
git add src/components/paper
git commit -m "feat: extract paper assistant presentational components"
```

---

### Task 5: Wire App.tsx to dual-pane + drawers

**Files:**
- Modify: `src/App.tsx`
- Modify: `scripts/test-renderer-auth-wiring.cjs`

- [ ] **Step 1: Update renderer wiring test markers first**

```js
// scripts/test-renderer-auth-wiring.cjs
const markers = [
  'type AuthUser =',
  'useState<Paper[]>(() => (window.desktopApi?.auth ? [] : loadPapers()))',
  'const [currentUser, setCurrentUser]',
  "const [activeDrawer, setActiveDrawer] = useState<'quality' | 'account' | null>(null)",
  "const [sessionStatus, setSessionStatus] = useState<'loading' | 'authenticated' | 'anonymous'>",
  "const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>",
  'nextActiveDrawer',
  'AccountDrawer',
  'QualityDrawer',
  "title: '发现旧版本地论文库'",
  "message.warning('请先登录账户')",
  'devTools: false', // checked separately in electron wiring
];
```

Also assert no old exclusive popover account panel title dependency if removed:

```js
assert.equal(source.includes('settings-popover account only'), false);
```

Prefer checking for drawer open props:

```js
assert.ok(source.includes('<AccountDrawer'));
assert.ok(source.includes('<QualityDrawer'));
```

- [ ] **Step 2: Run marker test (expect fail until App wired)**

```bash
node scripts/test-renderer-auth-wiring.cjs
```

Expected: FAIL on missing drawer markers.

- [ ] **Step 3: Refactor App state model**

In `App`:

```ts
import { getThemeTokens, nextActiveDrawer, nextSaveStatus, resolveSessionStatus } from './lib/uiState';
import type { ActiveDrawer, SaveStatus, SessionStatus } from './lib/uiState';

const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>(null);
const [libraryCollapsed, setLibraryCollapsed] = useState(false);
const [sessionLoading, setSessionLoading] = useState(Boolean(window.desktopApi?.auth));
const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
const sessionStatus: SessionStatus = resolveSessionStatus({ loading: sessionLoading, user: currentUser });
```

Replace popover account/quality fixed sider with:

```tsx
<AccountDrawer open={activeDrawer === 'account'} onClose={() => setActiveDrawer(null)} ... />
<QualityDrawer open={activeDrawer === 'quality'} onClose={() => setActiveDrawer(null)} ... />
```

Header open handlers:

```ts
const openQuality = () => setActiveDrawer((prev) => nextActiveDrawer(prev, 'quality'));
const openAccount = () => setActiveDrawer((prev) => nextActiveDrawer(prev, 'account'));
```

Session boot:

```ts
useEffect(() => {
  let cancelled = false;
  async function boot() {
    if (!window.desktopApi?.auth) {
      setSessionLoading(false);
      return;
    }
    try {
      const session = await window.desktopApi.auth.getSession();
      if (cancelled) return;
      if (!session?.user) {
        setCurrentUser(null);
        setPapers([]);
        setSelectedId('');
        return;
      }
      setCurrentUser(session.user);
      // load papers as today
    } finally {
      if (!cancelled) setSessionLoading(false);
    }
  }
  void boot();
  return () => { cancelled = true; };
}, []);
```

Persist with save status:

```ts
async function persist(next: Paper[]) {
  if (!requireDesktopLogin()) return;
  setPapers(next);
  if (window.desktopApi?.library && currentUser) {
    setSaveStatus(nextSaveStatus(saveStatus, 'start'));
    try {
      await window.desktopApi.library.save(next);
      setSaveStatus(nextSaveStatus('saving', 'success'));
    } catch {
      setSaveStatus(nextSaveStatus('saving', 'error'));
      message.error('论文库保存失败，请重试');
    }
    return;
  }
  localStorage.setItem(storageKey, JSON.stringify(next));
  setSaveStatus('saved');
}
```

Do **not** return an isolated empty page that drops the shell. Always render:

```tsx
<Layout className="desktop-workbench">
  <AppHeader ... />
  <div className={libraryCollapsed ? 'workbench-body library-collapsed' : 'workbench-body'}>
    <PaperLibrary ... />
    {sessionStatus !== 'authenticated' || !selected ? (
      <EmptyWorkspace sessionStatus={sessionStatus === 'authenticated' ? 'authenticated' : sessionStatus} ... />
    ) : (
      <PaperWorkspace ... />
    )}
  </div>
  <QualityDrawer ... />
  <AccountDrawer ... />
</Layout>
```

Keep all existing business handlers (`handleLogin`, `handleRegister`, import/export, legacy migration, auth gating).

- [ ] **Step 4: Update renderer wiring test and run**

```bash
node scripts/test-renderer-auth-wiring.cjs
npm test
npm run build
```

Expected:
- renderer markers pass
- vitest all pass
- production build succeeds

- [ ] **Step 5: Commit if git available**

```bash
git add src/App.tsx src/components/paper src/styles.css scripts/test-renderer-auth-wiring.cjs
git commit -m "feat: wire dual-pane paper shell with exclusive drawers"
```

---

### Task 6: Theme differentiation polish

**Files:**
- Modify: `src/styles.css`
- Modify: `src/App.tsx` (use `getThemeTokens` for Ant ConfigProvider)
- Modify: `src/lib/uiState.ts` if token values need tuning after visual check

- [ ] **Step 1: Apply theme tokens to ConfigProvider**

```ts
const tokens = getThemeTokens(appTheme);
// ConfigProvider theme.token:
{
  colorPrimary: tokens.antPrimary,
  colorBgBase: tokens.antBgBase,
  colorTextBase: tokens.antTextBase,
  borderRadius: 10,
  fontFamily: activeFontFamily,
}
algorithm: tokens.isDark ? theme.darkAlgorithm : theme.defaultAlgorithm
```

Also set document CSS variables from tokens when theme changes, or rely on `data-theme` CSS already defined—prefer `data-theme` CSS for surfaces and Ant tokens for controls.

- [ ] **Step 2: Ensure advanced display settings remain available**

Display settings panel order:

1. 主题 segmented: 冰川蓝 / 暖纸白 / 午夜黑 (map to cool/paper/dark)
2. 高级显示设置 collapse:
   - 文字对比度
   - 界面对比度
   - 界面字体
   - 文档字体 (if split implemented; otherwise keep single font control and note in UI only if already present)

Do not invent new localStorage keys unless required; keep existing keys.

- [ ] **Step 3: Add regression assertion for token uniqueness remains green**

```bash
npm test -- src/lib/uiState.test.ts
```

Expected: PASS with 3 distinct fingerprints.

- [ ] **Step 4: Commit if git available**

```bash
git add src/App.tsx src/styles.css src/lib/uiState.ts
git commit -m "feat: differentiate cool paper and dark theme surfaces"
```

---

### Task 7: Desktop verification + DevTools guard

**Files:**
- Verify: `electron/main.cjs`
- Modify if needed: `scripts/test-electron-wiring.cjs`

- [ ] **Step 1: Confirm DevTools remains disabled**

```bash
node scripts/test-electron-wiring.cjs
```

Expected: pass, including:

- no `toggleDevTools`
- `devTools: false`

- [ ] **Step 2: Build and launch desktop app**

```bash
npm run build
./node_modules/.bin/electron .
```

Manual checklist:

1. Layout is two columns; quality is a drawer, not fixed right sider.
2. Account opens as drawer ~400px, not tiny popover stack.
3. Switch cool/paper/dark: backgrounds and canvas clearly change.
4. Login shell stays framed; loading does not white-flash old sample papers.
5. Save a paper edit: status shows saving/saved; force failure path if practical.
6. F12 / Ctrl+Shift+I does not open DevTools.
7. Existing auth flows still work: register/login/logout/session restore.

- [ ] **Step 3: Run full automated suite**

```bash
node scripts/test-auth-core.cjs
node scripts/test-library-store.cjs
node scripts/test-electron-wiring.cjs
node scripts/test-renderer-auth-wiring.cjs
npm test
npm run build
```

Note: after Electron native rebuilds, Node tests for better-sqlite3 may need `npm rebuild better-sqlite3` first. If so:

```bash
npm rebuild better-sqlite3
# run node auth/library tests
npx @electron/rebuild -f -w better-sqlite3
# then desktop run
```

- [ ] **Step 4: Update spec status only after checklist passes**

In `docs/superpowers/specs/2026-07-18-paper-assistant-professional-ui-redesign.md` set:

```md
状态：已实现
```

- [ ] **Step 5: Commit if git available**

```bash
git add docs/superpowers/specs/2026-07-18-paper-assistant-professional-ui-redesign.md
git commit -m "docs: mark professional ui redesign implemented"
```

---

## Spec coverage self-check

| Spec requirement | Task |
|---|---|
| Dual-pane + right drawer | Task 3, 5 |
| 56px header with check badge | Task 4, 5 |
| Collapsible 264px library | Task 3, 4, 5 |
| Editor max width ~900px, title ~30px | Task 3, 4 |
| Visible editable inputs | Task 3 |
| Quality drawer 400px exclusive | Task 4, 5 |
| Account drawer replaces popover | Task 4, 5 |
| Framed empty/loading states | Task 4, 5 |
| Three distinct theme surfaces | Task 1, 3, 6 |
| Advanced display settings | Task 4, 6 |
| Component split boundaries | Task 2, 4 |
| Save status + retry | Task 1, 5 |
| Session loading status | Task 1, 5 |
| No DevTools | Task 7 |
| Business regression + build | Task 5, 7 |

## Placeholder scan

No TBD/TODO steps. Commit steps are conditional on git. Native module ABI flip between Node tests and Electron is documented with exact commands.

## Type consistency

- Drawer union: `'quality' | 'account' | null`
- Save status: `'idle' | 'saving' | 'saved' | 'failed'`
- Session status: `'loading' | 'authenticated' | 'anonymous'`
- Theme ids remain storage-compatible: `'cool' | 'paper' | 'dark'`
- Public auth/paper types match existing desktop IPC contracts

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-20-paper-assistant-professional-ui-redesign.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with checkpoints  

Which approach?
