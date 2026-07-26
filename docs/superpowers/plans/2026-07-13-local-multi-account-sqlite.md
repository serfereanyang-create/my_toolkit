# Local Multi-Account SQLite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real local multi-user accounts with SQLite (register/login/logout/profile/password), session restore, and per-user paper library isolation for the Electron paper assistant.

**Architecture:** Electron main owns `better-sqlite3` at `{userData}/paper-assistant.sqlite`. Auth and library services run in main; renderer talks only through `desktopApi` IPC. Papers move from renderer `localStorage` authority to DB scoped by `user_id`. Session token plaintext lives in `userData/session.json`; DB stores only token hash.

**Tech Stack:** Electron, better-sqlite3, Node crypto (scrypt), React + Ant Design, Vitest/Node assert scripts for auth unit tests.

**Spec:** `docs/superpowers/specs/2026-07-13-local-multi-account-sqlite-design.md`

---

## File map

| File | Responsibility |
|------|----------------|
| `electron/db.cjs` | Open DB, migrate schema, export helpers |
| `electron/auth.cjs` | Password hash, register/login/logout/session/profile/password |
| `electron/library-store.cjs` | Load/save papers for current user |
| `electron/main.cjs` | Wire IPC handlers; init DB on ready |
| `electron/preload.cjs` | Expose `desktopApi.auth` + `desktopApi.library` |
| `scripts/test-auth-core.cjs` | Pure/unit tests for validation + hash + auth service (temp DB) |
| `src/App.tsx` | Auth UI state machine; library load/save via IPC when desktop |
| `package.json` | Add `better-sqlite3`; optional rebuild script |

---

### Task 1: Add dependency and DB bootstrap

**Files:**
- Create: `electron/db.cjs`
- Modify: `package.json`
- Test: manual open via node script in Task 2

- [ ] **Step 1: Install better-sqlite3**

Run from project root:

```bash
npm install better-sqlite3
```

If native build fails on Windows, install build tools then retry. Do not switch away from SQLite without recording failure in the task log.

- [ ] **Step 2: Create `electron/db.cjs`**

```js
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

let db;

function getDbPath(userDataPath) {
  return path.join(userDataPath, 'paper-assistant.sqlite');
}

function migrate(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      institution TEXT NOT NULL DEFAULT '',
      research_field TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS papers (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      year TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_papers_user ON papers(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);
}

function openDb(userDataPath) {
  fs.mkdirSync(userDataPath, { recursive: true });
  const file = getDbPath(userDataPath);
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { openDb, getDb, closeDb, getDbPath, migrate };
```

- [ ] **Step 3: Verify module loads**

Run:

```bash
node -e "const {openDb,closeDb}=require('./electron/db.cjs'); const p=require('os').tmpdir()+'/pa-db-test'; openDb(p); console.log('ok'); closeDb();"
```

Expected: prints `ok` with no throw.

- [ ] **Step 4: Commit (if git available)**

```bash
git add package.json package-lock.json electron/db.cjs
git commit -m "feat: add sqlite db bootstrap for paper assistant"
```

If not a git repo, skip commit steps for the whole plan and continue.

---

### Task 2: Auth core (hash, register, login, session)

**Files:**
- Create: `electron/auth.cjs`
- Create: `scripts/test-auth-core.cjs`

- [ ] **Step 1: Write failing tests in `scripts/test-auth-core.cjs`**

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, closeDb } = require('../electron/db.cjs');
const auth = require('../electron/auth.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-auth-'));
openDb(tmp);
auth.configureAuth({ userDataPath: tmp, sessionDays: 30 });

function run() {
  const reg = auth.register({
    username: 'alice',
    email: 'alice@example.com',
    password: 'password1',
    confirmPassword: 'password1',
  });
  assert.equal(reg.ok, true);
  assert.equal(reg.user.username, 'alice');
  assert.equal('password_hash' in reg.user, false);

  const dup = auth.register({
    username: 'alice',
    password: 'password1',
    confirmPassword: 'password1',
  });
  assert.equal(dup.ok, false);

  auth.logout();
  const bad = auth.login({ account: 'alice', password: 'wrong-pass' });
  assert.equal(bad.ok, false);

  const good = auth.login({ account: 'alice@example.com', password: 'password1' });
  assert.equal(good.ok, true);
  assert.equal(good.user.username, 'alice');

  const session = auth.getSession();
  assert.ok(session);
  assert.equal(session.user.username, 'alice');

  auth.logout();
  assert.equal(auth.getSession(), null);

  console.log('auth core tests passed');
}

try {
  run();
} finally {
  closeDb();
}
```

- [ ] **Step 2: Run tests (expect fail — module missing)**

```bash
node scripts/test-auth-core.cjs
```

Expected: `Cannot find module '../electron/auth.cjs'` or similar.

- [ ] **Step 3: Implement `electron/auth.cjs`**

```js
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getDb } = require('./db.cjs');

let userDataPath = '';
let sessionDays = 30;

function configureAuth(options = {}) {
  if (options.userDataPath) userDataPath = options.userDataPath;
  if (options.sessionDays) sessionDays = options.sessionDays;
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID();
}

function sessionFile() {
  return path.join(userDataPath, 'session.json');
}

function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  return value ? value : null;
}

function validateUsername(username) {
  const value = String(username || '').trim();
  if (value.length < 3 || value.length > 32) return '用户名长度需为 3–32';
  if (/\s/.test(value)) return '用户名不能包含空白';
  return null;
}

function validatePassword(password) {
  if (String(password || '').length < 8) return '密码至少 8 位';
  return null;
}

function validateEmail(email) {
  if (email == null) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '邮箱格式不正确';
  return null;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email || '',
    displayName: row.display_name || '',
    institution: row.institution || '',
    researchField: row.research_field || '',
    notes: row.notes || '',
  };
}

function writeSessionFile(token) {
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(sessionFile(), JSON.stringify({ token }), 'utf8');
}

function readSessionFile() {
  try {
    const raw = fs.readFileSync(sessionFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.token ? String(parsed.token) : null;
  } catch {
    return null;
  }
}

function clearSessionFile() {
  try {
    fs.unlinkSync(sessionFile());
  } catch {
    // ignore
  }
}

function createSession(userId) {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const id = newId();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + sessionDays * 86400000).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, userId, tokenHash, createdAt, expiresAt);
  writeSessionFile(token);
  return token;
}

function findUserByAccount(account) {
  const db = getDb();
  const value = String(account || '').trim();
  if (!value) return null;
  const byName = db.prepare('SELECT * FROM users WHERE username = ?').get(value);
  if (byName) return byName;
  const email = value.toLowerCase();
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

function register(input) {
  const usernameError = validateUsername(input.username);
  if (usernameError) return { ok: false, error: usernameError };
  const passwordError = validatePassword(input.password);
  if (passwordError) return { ok: false, error: passwordError };
  if (input.password !== input.confirmPassword) return { ok: false, error: '两次密码不一致' };

  const email = normalizeEmail(input.email);
  const emailError = validateEmail(email);
  if (emailError) return { ok: false, error: emailError };

  const db = getDb();
  const username = String(input.username).trim();
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return { ok: false, error: '用户名已存在' };
  }
  if (email && db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return { ok: false, error: '邮箱已被使用' };
  }

  const { hash, salt } = hashPassword(input.password);
  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO users (
      id, username, email, password_hash, password_salt,
      display_name, institution, research_field, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '', '', '', '', ?, ?)`,
  ).run(id, username, email, hash, salt, ts, ts);

  createSession(id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return { ok: true, user: publicUser(row) };
}

function login(input) {
  const row = findUserByAccount(input.account);
  if (!row || !verifyPassword(input.password, row.password_salt, row.password_hash)) {
    return { ok: false, error: '用户名/邮箱或密码错误' };
  }
  createSession(row.id);
  return { ok: true, user: publicUser(row) };
}

function logout() {
  const token = readSessionFile();
  if (token) {
    const db = getDb();
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }
  clearSessionFile();
}

function getSession() {
  const token = readSessionFile();
  if (!token) return null;
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token));
  if (!session) {
    clearSessionFile();
    return null;
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    clearSessionFile();
    return null;
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  if (!row) {
    clearSessionFile();
    return null;
  }
  return { user: publicUser(row), userId: row.id };
}

function requireUserId() {
  const session = getSession();
  if (!session) {
    const err = new Error('未登录');
    err.code = 'UNAUTHENTICATED';
    throw err;
  }
  return session.userId;
}

function updateProfile(patch) {
  const userId = requireUserId();
  const db = getDb();
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!current) return { ok: false, error: '用户不存在' };

  let email = current.email;
  if (Object.prototype.hasOwnProperty.call(patch, 'email')) {
    email = normalizeEmail(patch.email);
    const emailError = validateEmail(email);
    if (emailError) return { ok: false, error: emailError };
    if (email) {
      const other = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, userId);
      if (other) return { ok: false, error: '邮箱已被使用' };
    }
  }

  const displayName = Object.prototype.hasOwnProperty.call(patch, 'displayName')
    ? String(patch.displayName || '').trim()
    : current.display_name;
  const institution = Object.prototype.hasOwnProperty.call(patch, 'institution')
    ? String(patch.institution || '').trim()
    : current.institution;
  const researchField = Object.prototype.hasOwnProperty.call(patch, 'researchField')
    ? String(patch.researchField || '').trim()
    : current.research_field;
  const notes = Object.prototype.hasOwnProperty.call(patch, 'notes')
    ? String(patch.notes || '').trim()
    : current.notes;
  const ts = nowIso();

  db.prepare(
    `UPDATE users SET email = ?, display_name = ?, institution = ?, research_field = ?, notes = ?, updated_at = ?
     WHERE id = ?`,
  ).run(email, displayName, institution, researchField, notes, ts, userId);

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return { ok: true, user: publicUser(row) };
}

function changePassword(input) {
  const userId = requireUserId();
  const passwordError = validatePassword(input.newPassword);
  if (passwordError) return { ok: false, error: passwordError };
  if (input.newPassword !== input.confirmPassword) return { ok: false, error: '两次密码不一致' };

  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row || !verifyPassword(input.oldPassword, row.password_salt, row.password_hash)) {
    return { ok: false, error: '旧密码不正确' };
  }

  const { hash, salt } = hashPassword(input.newPassword);
  const ts = nowIso();
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?')
    .run(hash, salt, ts, userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  createSession(userId);
  return { ok: true };
}

module.exports = {
  configureAuth,
  register,
  login,
  logout,
  getSession,
  requireUserId,
  updateProfile,
  changePassword,
  // exported for tests
  hashPassword,
  verifyPassword,
  validateUsername,
  validatePassword,
};
```

- [ ] **Step 4: Run tests**

```bash
node scripts/test-auth-core.cjs
```

Expected: `auth core tests passed`

- [ ] **Step 5: Commit if git available**

```bash
git add electron/auth.cjs scripts/test-auth-core.cjs
git commit -m "feat: add local auth service with scrypt and sessions"
```

---

### Task 3: Library store per user

**Files:**
- Create: `electron/library-store.cjs`
- Modify: `scripts/test-auth-core.cjs` (append library tests) or create `scripts/test-library-store.cjs`

- [ ] **Step 1: Create `scripts/test-library-store.cjs`**

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, closeDb } = require('../electron/db.cjs');
const auth = require('../electron/auth.cjs');
const library = require('../electron/library-store.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-lib-'));
openDb(tmp);
auth.configureAuth({ userDataPath: tmp });

auth.register({ username: 'alice', password: 'password1', confirmPassword: 'password1' });
library.savePapers([
  { id: 'p1', title: 'A', authors: '', year: '2024', status: '未读', tags: [], evidence: [], checklist: {} },
]);
let papers = library.loadPapers();
assert.equal(papers.length, 1);
assert.equal(papers[0].title, 'A');

auth.logout();
auth.register({ username: 'bob', password: 'password1', confirmPassword: 'password1' });
papers = library.loadPapers();
assert.equal(papers.length, 0);

library.savePapers([{ id: 'p2', title: 'B', authors: '', year: '2023', status: '粗读', tags: [], evidence: [], checklist: {} }]);
auth.logout();
auth.login({ account: 'alice', password: 'password1' });
papers = library.loadPapers();
assert.equal(papers.length, 1);
assert.equal(papers[0].id, 'p1');

console.log('library store tests passed');
closeDb();
```

- [ ] **Step 2: Run (expect fail)**

```bash
node scripts/test-library-store.cjs
```

- [ ] **Step 3: Implement `electron/library-store.cjs`**

```js
const { getDb } = require('./db.cjs');
const { requireUserId } = require('./auth.cjs');

function loadPapers() {
  const userId = requireUserId();
  const rows = getDb().prepare(
    'SELECT payload FROM papers WHERE user_id = ? ORDER BY updated_at DESC',
  ).all(userId);
  return rows.map((row) => JSON.parse(row.payload));
}

function savePapers(papers) {
  const userId = requireUserId();
  const db = getDb();
  const list = Array.isArray(papers) ? papers : [];
  const upsert = db.prepare(
    `INSERT INTO papers (id, user_id, payload, title, year, status, updated_at)
     VALUES (@id, @userId, @payload, @title, @year, @status, @updatedAt)
     ON CONFLICT(user_id, id) DO UPDATE SET
       payload = excluded.payload,
       title = excluded.title,
       year = excluded.year,
       status = excluded.status,
       updated_at = excluded.updated_at`,
  );
  const delMissing = db.prepare(
    `DELETE FROM papers WHERE user_id = ? AND id NOT IN (${list.map(() => '?').join(',') || "''"})`,
  );

  const tx = db.transaction((items) => {
    const now = new Date().toISOString();
    for (const paper of items) {
      upsert.run({
        id: paper.id,
        userId,
        payload: JSON.stringify(paper),
        title: paper.title || '',
        year: paper.year || '',
        status: paper.status || '',
        updatedAt: now,
      });
    }
    if (items.length === 0) {
      db.prepare('DELETE FROM papers WHERE user_id = ?').run(userId);
    } else {
      delMissing.run(userId, ...items.map((p) => p.id));
    }
  });
  tx(list);
}

module.exports = { loadPapers, savePapers };
```

Note: empty `NOT IN ()` is invalid SQL — the implementation above uses a branch for empty list. Keep that branch.

- [ ] **Step 4: Run tests**

```bash
node scripts/test-library-store.cjs
```

Expected: `library store tests passed`

- [ ] **Step 5: Commit if git available**

```bash
git add electron/library-store.cjs scripts/test-library-store.cjs
git commit -m "feat: add per-user paper library store"
```

---

### Task 4: Wire IPC + preload

**Files:**
- Modify: `electron/main.cjs`
- Modify: `electron/preload.cjs`

- [ ] **Step 1: Update `electron/preload.cjs`**

Replace file content with:

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  saveMarkdown: (defaultName, content) => ipcRenderer.invoke('paper:save-markdown', { defaultName, content }),
  exportLibrary: (defaultName, content) => ipcRenderer.invoke('paper:export-library', { defaultName, content }),
  importLibrary: () => ipcRenderer.invoke('paper:import-library'),
  importReferences: () => ipcRenderer.invoke('paper:import-references'),
  onCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('paper:command', listener);
    return () => ipcRenderer.removeListener('paper:command', listener);
  },
  auth: {
    register: (input) => ipcRenderer.invoke('auth:register', input),
    login: (input) => ipcRenderer.invoke('auth:login', input),
    logout: () => ipcRenderer.invoke('auth:logout'),
    getSession: () => ipcRenderer.invoke('auth:get-session'),
    updateProfile: (patch) => ipcRenderer.invoke('auth:update-profile', patch),
    changePassword: (input) => ipcRenderer.invoke('auth:change-password', input),
  },
  library: {
    load: () => ipcRenderer.invoke('library:load'),
    save: (papers) => ipcRenderer.invoke('library:save', papers),
  },
});
```

- [ ] **Step 2: Wire main process**

At top of `electron/main.cjs` after requires:

```js
const { openDb } = require('./db.cjs');
const auth = require('./auth.cjs');
const libraryStore = require('./library-store.cjs');
```

In `app.whenReady()` **before** `createWindow()`:

```js
const userDataPath = app.getPath('userData');
openDb(userDataPath);
auth.configureAuth({ userDataPath, sessionDays: 30 });
```

Add handlers (near other ipc handlers):

```js
ipcMain.handle('auth:register', (_e, input) => auth.register(input || {}));
ipcMain.handle('auth:login', (_e, input) => auth.login(input || {}));
ipcMain.handle('auth:logout', () => {
  auth.logout();
  return { ok: true };
});
ipcMain.handle('auth:get-session', () => {
  const session = auth.getSession();
  return session ? { user: session.user } : null;
});
ipcMain.handle('auth:update-profile', (_e, patch) => auth.updateProfile(patch || {}));
ipcMain.handle('auth:change-password', (_e, input) => auth.changePassword(input || {}));
ipcMain.handle('library:load', () => libraryStore.loadPapers());
ipcMain.handle('library:save', (_e, papers) => {
  libraryStore.savePapers(papers || []);
  return { ok: true };
});
```

- [ ] **Step 3: Smoke-check main loads**

```bash
node -e "require('./electron/db.cjs'); require('./electron/auth.cjs'); require('./electron/library-store.cjs'); console.log('main modules ok')"
```

Expected: `main modules ok`

- [ ] **Step 4: Commit if git available**

```bash
git add electron/main.cjs electron/preload.cjs
git commit -m "feat: expose auth and library ipc apis"
```

---

### Task 5: Renderer types + session bootstrap

**Files:**
- Modify: `src/App.tsx` (DesktopApi types, auth state, replace local account save)

- [ ] **Step 1: Extend DesktopApi types**

Replace `DesktopApi` and related types section with auth-aware API:

```ts
type AuthUser = {
  id: string;
  username: string;
  email: string;
  displayName: string;
  institution: string;
  researchField: string;
  notes: string;
};

type AuthResult = { ok: true; user: AuthUser } | { ok: false; error: string };

type DesktopApi = {
  saveMarkdown: (defaultName: string, content: string) => Promise<{ canceled: boolean; filePath?: string }>;
  exportLibrary: (defaultName: string, content: string) => Promise<{ canceled: boolean; filePath?: string }>;
  importLibrary: () => Promise<{ canceled: boolean; filePath?: string; content?: string }>;
  importReferences: () => Promise<{ canceled: boolean; filePath?: string; content?: string }>;
  onCommand: (callback: (command: DesktopCommand) => void) => () => void;
  auth: {
    register: (input: {
      username: string;
      email?: string;
      password: string;
      confirmPassword: string;
    }) => Promise<AuthResult>;
    login: (input: { account: string; password: string }) => Promise<AuthResult>;
    logout: () => Promise<{ ok: true }>;
    getSession: () => Promise<{ user: AuthUser } | null>;
    updateProfile: (patch: Partial<{
      displayName: string;
      institution: string;
      researchField: string;
      notes: string;
      email: string;
    }>) => Promise<AuthResult>;
    changePassword: (input: {
      oldPassword: string;
      newPassword: string;
      confirmPassword: string;
    }) => Promise<{ ok: true } | { ok: false; error: string }>;
  };
  library: {
    load: () => Promise<Paper[]>;
    save: (papers: Paper[]) => Promise<{ ok: true }>;
  };
};
```

- [ ] **Step 2: Replace local-only account state with session user**

In `App`:

```ts
const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
const [authBusy, setAuthBusy] = useState(false);
const [authError, setAuthError] = useState('');
const [loginForm, setLoginForm] = useState({ account: '', password: '' });
const [registerForm, setRegisterForm] = useState({
  username: '',
  email: '',
  password: '',
  confirmPassword: '',
});
const [passwordForm, setPasswordForm] = useState({
  oldPassword: '',
  newPassword: '',
  confirmPassword: '',
});
```

Keep `accountDraft` fields mapped from `currentUser` when logged in.

- [ ] **Step 3: Bootstrap session + library on mount**

```ts
useEffect(() => {
  let cancelled = false;
  async function boot() {
    if (!window.desktopApi?.auth) return;
    const session = await window.desktopApi.auth.getSession();
    if (cancelled) return;
    if (!session?.user) {
      setCurrentUser(null);
      return;
    }
    setCurrentUser(session.user);
    setAccountDraft({
      displayName: session.user.displayName,
      institution: session.user.institution,
      researchField: session.user.researchField,
      email: session.user.email,
      notes: session.user.notes,
    });
    if (window.desktopApi.library) {
      const remote = await window.desktopApi.library.load();
      if (!cancelled) {
        setPapers(remote);
        setSelectedId(remote[0]?.id ?? '');
      }
    }
  }
  void boot();
  return () => {
    cancelled = true;
  };
}, []);
```

- [ ] **Step 4: Change `persist` to write DB when logged in on desktop**

```ts
function persist(next: Paper[]) {
  setPapers(next);
  if (window.desktopApi?.library && currentUser) {
    void window.desktopApi.library.save(next).catch(() => {
      message.error('论文库保存失败，请重试');
    });
    return;
  }
  localStorage.setItem(storageKey, JSON.stringify(next));
}
```

Important: when not in Electron or not logged in, keep localStorage fallback for web dev only; desktop product path requires login for writes (Task 6 UI gates).

- [ ] **Step 5: Build typecheck**

```bash
npm run build
```

Expected: success (UI may still show old account panel until Task 6).

---

### Task 6: Account panel UI (login / register / profile / logout / password)

**Files:**
- Modify: `src/App.tsx` account Popover content
- Modify: `src/styles.css` minor account form styles if needed

- [ ] **Step 1: Implement auth handlers**

```ts
async function handleRegister() {
  if (!window.desktopApi?.auth) {
    message.error('账户系统仅在桌面端可用');
    return;
  }
  setAuthBusy(true);
  setAuthError('');
  try {
    const result = await window.desktopApi.auth.register(registerForm);
    if (!result.ok) {
      setAuthError(result.error);
      return;
    }
    setCurrentUser(result.user);
    setAccountDraft({
      displayName: result.user.displayName,
      institution: result.user.institution,
      researchField: result.user.researchField,
      email: result.user.email,
      notes: result.user.notes,
    });
    setPapers([]);
    setSelectedId('');
    message.success('注册成功');
    await maybeOfferLegacyImport();
  } finally {
    setAuthBusy(false);
  }
}

async function handleLogin() {
  if (!window.desktopApi?.auth) {
    message.error('账户系统仅在桌面端可用');
    return;
  }
  setAuthBusy(true);
  setAuthError('');
  try {
    const result = await window.desktopApi.auth.login(loginForm);
    if (!result.ok) {
      setAuthError(result.error);
      setLoginForm((prev) => ({ ...prev, password: '' }));
      return;
    }
    setCurrentUser(result.user);
    setAccountDraft({
      displayName: result.user.displayName,
      institution: result.user.institution,
      researchField: result.user.researchField,
      email: result.user.email,
      notes: result.user.notes,
    });
    const remote = await window.desktopApi.library.load();
    setPapers(remote);
    setSelectedId(remote[0]?.id ?? '');
    message.success('登录成功');
    await maybeOfferLegacyImport();
  } finally {
    setAuthBusy(false);
  }
}

async function handleLogout() {
  if (!window.desktopApi?.auth) return;
  await window.desktopApi.auth.logout();
  setCurrentUser(null);
  setPapers([]);
  setSelectedId('');
  setLoginForm({ account: '', password: '' });
  message.success('已退出登录');
}

async function saveAccount() {
  if (!window.desktopApi?.auth || !currentUser) return;
  const result = await window.desktopApi.auth.updateProfile({
    displayName: accountDraft.displayName,
    institution: accountDraft.institution,
    researchField: accountDraft.researchField,
    email: accountDraft.email,
    notes: accountDraft.notes,
  });
  if (!result.ok) {
    message.error(result.error);
    return;
  }
  setCurrentUser(result.user);
  message.success('账户资料已保存');
}
```

- [ ] **Step 2: Replace account popover body**

Unlogged UI:

- Segmented: 登录 | 注册
- Login fields: account, password + button
- Register fields: username, email, password, confirmPassword + button
- Show `authError`

Logged UI:

- Avatar + username
- Profile fields (existing)
- Save profile
- Change password fields + button
- Logout button
- Quiet note: 论文库已按账户隔离；账户间请用导出/导入资料库

- [ ] **Step 3: Gate paper mutations**

At start of `addPaper`, `importReferences`, `importLibrary`, `resetSamples`, `persist` callers that mutate:

```ts
if (window.desktopApi?.auth && !currentUser) {
  message.warning('请先登录账户');
  setAccountOpen(true);
  return;
}
```

- [ ] **Step 4: Build and run desktop**

```bash
npm run build
```

Then launch Electron with latest dist (existing project method).

Manual check:

1. Register user A
2. Create a paper
3. Logout
4. Register/login user B — empty library
5. Login A — paper restored
6. Restart app — still logged in as last user

---

### Task 7: Legacy localStorage migration prompt

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Implement `maybeOfferLegacyImport`**

```ts
async function maybeOfferLegacyImport() {
  if (!window.desktopApi?.library || !currentUser) return;
  const existing = await window.desktopApi.library.load();
  if (existing.length > 0) return;
  const raw = localStorage.getItem(storageKey);
  if (!raw) return;
  let legacy: Paper[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return;
    legacy = parsed as Paper[];
  } catch {
    return;
  }

  Modal.confirm({
    title: '发现旧版本地论文库',
    content: `检测到 ${legacy.length} 篇旧数据。是否导入到当前账户？不会自动删除旧数据。`,
    okText: '导入到当前账户',
    cancelText: '暂不导入',
    onOk: async () => {
      await window.desktopApi!.library.save(legacy);
      setPapers(legacy);
      setSelectedId(legacy[0]?.id ?? '');
      message.success('旧论文库已导入当前账户');
    },
  });
}
```

Call it only after successful login/register (Task 6). Because `currentUser` state may not flush before call, pass user explicitly:

```ts
async function maybeOfferLegacyImport(user: AuthUser) { ... use user ... }
```

and call `await maybeOfferLegacyImport(result.user)`.

- [ ] **Step 2: Manual test**

1. Ensure browser/localStorage has sample papers key `science-paper-assistant:v1`
2. Register fresh user with empty DB library
3. Confirm dialog appears once
4. Import → papers visible
5. Logout/login → still present
6. Decline path: choose 暂不导入 → library empty; localStorage still intact

---

### Task 8: Package native module for Electron

**Files:**
- Modify: `package.json` scripts if needed

- [ ] **Step 1: Rebuild better-sqlite3 for Electron**

```bash
npx @electron/rebuild -f -w better-sqlite3
```

Or:

```bash
npm install --save-dev @electron/rebuild
npx electron-rebuild -f -w better-sqlite3
```

- [ ] **Step 2: Run desktop app**

```bash
npm run desktop:run
```

Expected: window opens; register/login works; no native module crash.

- [ ] **Step 3: If rebuild fails**

Document exact error in a short note under `docs/superpowers/plans/` comments section of PR/summary; do not silently switch storage. Retry with matching Electron version from `node_modules/electron/package.json`.

---

### Task 9: Final verification checklist

- [ ] **Step 1: Automated**

```bash
node scripts/test-auth-core.cjs
node scripts/test-library-store.cjs
npm run build
```

All pass.

- [ ] **Step 2: Manual acceptance (from spec)**

1. Register / login / logout works
2. Restart restores session (within 30 days)
3. User A papers invisible to user B
4. DB file has no plaintext passwords (`password_hash` only)
5. Wrong password shows unified error and allows retry
6. Legacy import only after confirm
7. Export as A → import as B copies into B’s library

- [ ] **Step 3: Update spec status line**

In design doc header set `状态：已实现（P0/P1）` only after checklist passes.

---

## Spec coverage self-check

| Spec requirement | Task |
|------------------|------|
| SQLite in userData | Task 1 |
| users/sessions/papers schema | Task 1 |
| scrypt password hashing | Task 2 |
| register/login/logout/getSession | Task 2, 4, 6 |
| updateProfile/changePassword | Task 2, 6 |
| session.json + token_hash | Task 2 |
| per-user papers | Task 3, 5 |
| IPC desktopApi.auth/library | Task 4 |
| UI login/register/profile | Task 6 |
| gate writes when logged out | Task 6 |
| legacy localStorage confirm import | Task 7 |
| account transfer via export/import | existing import path + Task 6 note |
| native rebuild | Task 8 |
| acceptance tests | Task 9 |

## Placeholder scan

No TBD steps. Commit steps are conditional on git. Native rebuild failure has explicit non-silent handling.

## Type consistency

- Public user fields: `displayName`, `institution`, `researchField`, `notes`, `email`, `username`, `id`
- Auth results: `{ ok: true, user } | { ok: false, error }`
- Library: `load(): Paper[]`, `save(papers): { ok: true }`

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-13-local-multi-account-sqlite.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with checkpoints  

Which approach?
