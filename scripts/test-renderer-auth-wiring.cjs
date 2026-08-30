const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
const uiStateSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'uiState.ts'), 'utf8');

for (const marker of [
  'AuthUser',
  'useState<Paper[]>(() => (window.desktopApi?.auth ? [] : loadPapers()))',
  'const [currentUser, setCurrentUser]',
  "const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>(null)",
  'const [libraryCollapsed, setLibraryCollapsed]',
  'const [sessionLoading, setSessionLoading]',
  "const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')",
  'const hasDesktopAuth = Boolean(window.desktopApi?.auth)',
  'resolveSessionStatus({ loading: sessionLoading, user: currentUser })',
  'nextActiveDrawer',
  'nextSaveStatus',
  'getThemeTokens',
  '<AccountDrawer',
  '<QualityDrawer',
  '<AppHeader',
  '<PaperLibrary',
  '<EmptyWorkspace',
  '<PaperWorkspace',
  'DisplaySettings',
  'const legacyProfile = loadAccount()',
  'window.desktopApi.auth.getSession()',
  'window.desktopApi.library.save(next)',
  'async function handleRegister()',
  'async function handleLogin()',
  'async function handleLogout()',
  'async function handleChangePassword()',
  "title: '发现旧版本地论文库'",
  "localStorage.setItem(legacyMigrationKey(user.id), 'done')",
  "message.warning('请先登录账户')",
  "className={libraryCollapsed ? 'workbench-body library-collapsed' : 'workbench-body'}",
  'ReviewDrawer',
  'AiSettings',
  'exportMatrix',
  "label: '生成综述'",
  "label: '导出文献矩阵'",
  "'review'",
]) {
  assert.ok(source.includes(marker), `renderer is missing: ${marker}`);
}

assert.ok(
  uiStateSource.includes("'quality' | 'account' | 'review' | null"),
  'ActiveDrawer should be widened with review',
);

assert.ok(!source.includes('className="quality-panel"'), 'fixed quality sider should be removed');
assert.ok(!source.includes('accountPanelContent'), 'inline account popover panel should be removed');

console.log('renderer auth wiring tests passed');
