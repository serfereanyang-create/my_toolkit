const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { selectWorkspaceCandidate, defaultLooksLikeProject } = require('../electron/workspace-picker.cjs');

function fakeFs({ dirs = [], projectRoots = [] }) {
  const dirSet = new Set(dirs);
  const projSet = new Set(projectRoots);
  return {
    isDirectory: async (t) => dirSet.has(t),
    looksLikeProject: async (t) => projSet.has(t),
  };
}

test('recent project workspace wins over plain folders and home', async () => {
  const home = 'C:\\Users\\dev';
  const pick = await selectWorkspaceCandidate({
    recents: [home, 'D:\\notes', 'C:\\Users\\dev\\ZCodeProject\\cli'],
    home,
    ...fakeFs({
      dirs: [home, 'D:\\notes', 'C:\\Users\\dev\\ZCodeProject\\cli'],
      projectRoots: ['C:\\Users\\dev\\ZCodeProject\\cli'],
    }),
  });
  assert.equal(pick.root, 'C:\\Users\\dev\\ZCodeProject\\cli');
  assert.equal(pick.reason, 'recent-project');
});

test('a plain (non-home) recent folder still restores', async () => {
  const home = 'C:\\Users\\dev';
  const pick = await selectWorkspaceCandidate({
    recents: ['D:\\scratch'],
    home,
    ...fakeFs({ dirs: ['D:\\scratch'] }),
  });
  assert.equal(pick.root, 'D:\\scratch');
  assert.equal(pick.reason, 'recent-plain');
});

test('home-dir-only recents return null — no silent home fallback', async () => {
  const home = 'C:\\Users\\dev';
  const pick = await selectWorkspaceCandidate({
    recents: [home],
    home,
    ...fakeFs({ dirs: [home] }),
  });
  assert.equal(pick.root, null);
  assert.equal(pick.reason, 'none');
});

test('empty/missing recents return null', async () => {
  const pick = await selectWorkspaceCandidate({ recents: [], ...fakeFs({}) });
  assert.equal(pick.root, null);
  const stale = await selectWorkspaceCandidate({
    recents: ['C:\\gone'],
    ...fakeFs({ dirs: [] }),
  });
  assert.equal(stale.root, null);
});

test('non-string recents are ignored without throwing', async () => {
  const pick = await selectWorkspaceCandidate({
    recents: [null, 42, '', '   ', 'D:\\real'],
    home: 'C:\\Users\\dev',
    ...fakeFs({ dirs: ['D:\\real'], projectRoots: ['D:\\real'] }),
  });
  assert.equal(pick.root, 'D:\\real');
});

test('defaultLooksLikeProject detects a real repo and rejects a bare dir', async () => {
  // This very workspace: cli has .git + package.json; os.tmpdir()-style empty
  // dir has neither. Use the repo we run inside as the positive case.
  const cliRoot = path.resolve(__dirname, '..', '..', 'cli');
  const os = require('node:os');
  assert.equal(await defaultLooksLikeProject(cliRoot), true);
  assert.equal(await defaultLooksLikeProject(os.tmpdir()), false);
  assert.equal(await defaultLooksLikeProject('C:\\definitely-not-here-xyz'), false);
});
