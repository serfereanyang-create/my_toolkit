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
  const { hash } = hashPassword(String(password || ''), salt);
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
  const byName = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(value);
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
  if (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE OR email = ?').get(username, username.toLowerCase())) {
    return { ok: false, error: '用户名已被使用' };
  }
  if (email && db.prepare('SELECT id FROM users WHERE email = ? OR username = ? COLLATE NOCASE').get(email, email)) {
    return { ok: false, error: '邮箱已被使用' };
  }

  const { hash, salt } = hashPassword(input.password);
  const id = newId();
  const ts = nowIso();
  const createUser = db.transaction(() => {
    db.prepare(
      `INSERT INTO users (
        id, username, email, password_hash, password_salt,
        display_name, institution, research_field, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '', '', '', '', ?, ?)`,
    ).run(id, username, email, hash, salt, ts, ts);
    createSession(id);
  });
  createUser();
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
      const other = db.prepare(
        'SELECT id FROM users WHERE (email = ? OR username = ? COLLATE NOCASE) AND id != ?',
      ).get(email, email, userId);
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
  hashPassword,
  verifyPassword,
  validateUsername,
  validatePassword,
};
