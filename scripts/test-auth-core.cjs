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
  assert.throws(
    () => auth.requireUserId(),
    (error) => error.code === 'UNAUTHENTICATED',
  );
  assert.throws(() => auth.updateProfile({ displayName: 'Blocked' }), /未登录/);
  assert.throws(() => auth.changePassword({
    oldPassword: 'password1',
    newPassword: 'password2',
    confirmPassword: 'password2',
  }), /未登录/);

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
  const missingPassword = auth.login({ account: 'alice' });
  assert.deepEqual(missingPassword, { ok: false, error: '用户名/邮箱或密码错误' });

  const bad = auth.login({ account: 'alice', password: 'wrong-pass' });
  assert.equal(bad.ok, false);

  const good = auth.login({ account: 'alice@example.com', password: 'password1' });
  assert.equal(good.ok, true);
  assert.equal(good.user.username, 'alice');

  const session = auth.getSession();
  assert.ok(session);
  assert.equal(session.user.username, 'alice');

  const profile = auth.updateProfile({
    displayName: 'Alice Zhang',
    institution: 'Research Lab',
    researchField: 'NLP',
    notes: 'Local profile',
  });
  assert.equal(profile.ok, true);
  assert.equal(profile.user.displayName, 'Alice Zhang');

  const badChange = auth.changePassword({
    oldPassword: 'wrong-pass',
    newPassword: 'password2',
    confirmPassword: 'password2',
  });
  assert.deepEqual(badChange, { ok: false, error: '旧密码不正确' });

  const changed = auth.changePassword({
    oldPassword: 'password1',
    newPassword: 'password2',
    confirmPassword: 'password2',
  });
  assert.deepEqual(changed, { ok: true });
  auth.logout();
  assert.equal(auth.login({ account: 'alice', password: 'password1' }).ok, false);
  assert.equal(auth.login({ account: 'alice', password: 'password2' }).ok, true);

  auth.logout();
  assert.equal(auth.getSession(), null);

  const usernameEmailCollision = auth.register({
    username: 'alice@example.com',
    password: 'password3',
    confirmPassword: 'password3',
  });
  assert.deepEqual(usernameEmailCollision, { ok: false, error: '用户名已被使用' });
  const caseVariantCollision = auth.register({
    username: 'ALICE',
    password: 'password3',
    confirmPassword: 'password3',
  });
  assert.deepEqual(caseVariantCollision, { ok: false, error: '用户名已被使用' });

  const identifierOwner = auth.register({
    username: 'taken@example.org',
    password: 'password3',
    confirmPassword: 'password3',
  });
  assert.equal(identifierOwner.ok, true);
  auth.logout();

  const secondUser = auth.register({
    username: 'charlie',
    password: 'password3',
    confirmPassword: 'password3',
  });
  assert.equal(secondUser.ok, true);
  const emailUsernameCollision = auth.updateProfile({ email: 'taken@example.org' });
  assert.deepEqual(emailUsernameCollision, { ok: false, error: '邮箱已被使用' });

  auth.logout();
  const blockedSessionPath = path.join(tmp, 'session-path-blocker');
  fs.writeFileSync(blockedSessionPath, 'not a directory');
  auth.configureAuth({ userDataPath: blockedSessionPath });
  assert.throws(() => auth.register({
    username: 'rollback-user',
    password: 'password4',
    confirmPassword: 'password4',
  }));
  auth.configureAuth({ userDataPath: tmp });
  const retryAfterRollback = auth.register({
    username: 'rollback-user',
    password: 'password4',
    confirmPassword: 'password4',
  });
  assert.equal(retryAfterRollback.ok, true);

  console.log('auth core tests passed');
}

try {
  run();
} finally {
  closeDb();
}
