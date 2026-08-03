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

try {
  assert.throws(() => library.loadPapers(), /未登录/);
  assert.throws(() => library.savePapers([]), /未登录/);

  auth.register({ username: 'alice', password: 'password1', confirmPassword: 'password1' });
  library.savePapers([
    { id: 'p1', title: 'A', authors: '', year: '2024', status: '未读', tags: [], evidence: [], checklist: {} },
  ]);
  assert.throws(
    () => library.savePapers([{ title: 'Missing id' }]),
    /论文记录缺少有效 id/,
  );
  let papers = library.loadPapers();
  assert.equal(papers.length, 1);
  assert.equal(papers[0].title, 'A');

  auth.logout();
  auth.register({ username: 'bob', password: 'password1', confirmPassword: 'password1' });
  papers = library.loadPapers();
  assert.equal(papers.length, 0);

  library.savePapers([
    { id: 'p2', title: 'B', authors: '', year: '2023', status: '粗读', tags: [], evidence: [], checklist: {} },
  ]);
  auth.logout();
  auth.login({ account: 'alice', password: 'password1' });
  papers = library.loadPapers();
  assert.equal(papers.length, 1);
  assert.equal(papers[0].id, 'p1');

  library.savePapers([]);
  assert.deepEqual(library.loadPapers(), []);

  console.log('library store tests passed');
} finally {
  closeDb();
}
