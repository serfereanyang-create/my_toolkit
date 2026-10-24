'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createDocumentPreviewService } = require('../electron/document-preview.cjs');

/*
 * The four gates between a preview pane and a file on disk.
 *
 * Each one is here because skipping it is a real defect rather than a
 * theoretical one:
 *
 *   - token      — a token is minted per file when the pane opens; accepting a
 *                  token minted for another file lets a pane read anything.
 *   - containment — the path is re-checked against the workspace after
 *                  realpath, so a symlink swapped in after the pane opened is
 *                  caught.
 *   - extension  — the token is minted for a kind, so a workbook renamed to
 *                  .docx must not reach the docx renderer.
 *   - size       — these are parsed synchronously in the main process, so an
 *                  oversized file would freeze the whole app.
 *
 * The old docx handler had all four inline in ipc.cjs, where `node --test`
 * cannot require them — so none of this was covered, and only the docx path had
 * them at all.
 */

const fixture = (name) => path.join(__dirname, 'fixtures', name);

function makeService(overrides = {}) {
  const calls = { validated: [], realpath: [], stat: [] };
  const service = createDocumentPreviewService({
    validateToken: (token, expectation) => {
      calls.validated.push({ token, ...expectation });
      return token === 'good-token';
    },
    workspaceRoot: () => 'C:\\ws',
    assertInsideRoot: (real, root) => {
      if (!real.startsWith(root)) throw new Error('Path is outside workspace root');
    },
    resolveAbsolutePath: async (relativePath) => `C:\\ws\\${relativePath}`,
    realpathSync: (p) => { calls.realpath.push(p); return p; },
    statSync: (p) => { calls.stat.push(p); return { isFile: () => true, size: 1024 }; },
    ...overrides,
  });
  return { service, calls };
}

test('a valid token for this exact path returns a parsed workbook', async () => {
  const bytes = readFileSync(fixture('cli-created.xlsx'));
  const { service, calls } = makeService({ readFileSync: () => bytes });

  const result = await service.read('xlsx', 'budget.xlsx', 'good-token');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.workbook.sheets[0].name, '收入明细');
  // The token was checked against the file it was minted for, not just checked
  // for validity.
  assert.deepEqual(calls.validated[0], {
    token: 'good-token',
    workspaceRoot: 'C:\\ws',
    kind: 'xlsx',
    absolutePath: 'C:\\ws\\budget.xlsx',
  });
});

test('an invalid token is refused before the file is touched', async () => {
  const { service, calls } = makeService({ readFileSync: () => Buffer.from('x') });
  const result = await service.read('xlsx', 'budget.xlsx', 'stolen-token');
  assert.equal(result.ok, false);
  assert.match(result.error, /token/i);
  assert.deepEqual(calls.realpath, [], 'nothing was read');
});

test('a symlink pointing outside the workspace is refused', async () => {
  // The token still validates — it was minted for this path — but the real
  // target is elsewhere, which is the case realpath-then-recheck exists for.
  const { service } = makeService({
    realpathSync: () => 'C:\\elsewhere\\secret.xlsx',
    readFileSync: () => { throw new Error('must not read'); },
  });
  const result = await service.read('xlsx', 'budget.xlsx', 'good-token');
  assert.equal(result.ok, false);
  assert.match(result.error, /outside/i);
});

test('a file renamed to another kind is refused by extension, not parsed', async () => {
  // The token says docx; the file is a workbook. Feeding it to docx-preview
  // would produce a confusing render failure instead of an honest refusal.
  const { service } = makeService({
    realpathSync: () => 'C:\\ws\\actually-a-sheet.xlsx',
    readFileSync: () => { throw new Error('must not read'); },
  });
  const result = await service.read('docx', 'actually-a-sheet.xlsx', 'good-token');
  assert.equal(result.ok, false);
  assert.match(result.error, /DOCX/);
});

test('an oversized document is refused before it is read', async () => {
  const { service, calls } = makeService({
    statSync: () => ({ isFile: () => true, size: 200 * 1024 * 1024 }),
    readFileSync: () => { throw new Error('must not read'); },
  });
  const result = await service.read('xlsx', 'huge.xlsx', 'good-token');
  assert.equal(result.ok, false);
  assert.match(result.error, /过大/);
  assert.equal(calls.realpath.length, 1, 'stat was reached, the read was not');
});

test('a directory is refused', async () => {
  const { service } = makeService({ statSync: () => ({ isFile: () => false, size: 0 }) });
  const result = await service.read('xlsx', 'adirectory.xlsx', 'good-token');
  assert.equal(result.ok, false);
  assert.match(result.error, /该路径不是文件/);
});

test('a missing file reports a path error rather than throwing', async () => {
  const { service } = makeService({
    resolveAbsolutePath: async () => { throw new Error('文件不存在'); },
  });
  const result = await service.read('xlsx', 'gone.xlsx', 'good-token');
  assert.equal(result.ok, false);
  assert.equal(result.pathError, true, 'the caller can tell a stale path from a refusal');
  assert.match(result.error, /不存在/);
});

test('an unreadable document is reported, not thrown', async () => {
  const { service } = makeService({
    readFileSync: () => { throw new Error('EBUSY: resource busy'); },
  });
  const result = await service.read('pptx', 'deck.pptx', 'good-token');
  assert.equal(result.ok, false);
  assert.match(result.error, /EBUSY/);
});

test('docx is handed to the renderer as bytes, xlsx and pptx as parsed data', async () => {
  // docx-preview parses in the renderer, so the bytes must cross IPC. The other
  // two are parsed in the main process so only the small result does — which is
  // also what keeps a 20 MB workbook from becoming a 20 MB IPC payload.
  const docxBytes = readFileSync(fixture('cli-created.xlsx'));  // any bytes; contents are not parsed here
  const docx = makeService({ readFileSync: () => docxBytes });
  const docxResult = await docx.service.read('docx', 'report.docx', 'good-token');
  assert.equal(docxResult.ok, true, docxResult.error);
  assert.ok(docxResult.buffer, 'raw bytes for the renderer');
  assert.equal(docxResult.byteLength, docxBytes.length);
  assert.equal(docxResult.workbook, undefined);

  const xlsx = makeService({ readFileSync: () => readFileSync(fixture('cli-created.xlsx')) });
  const xlsxResult = await xlsx.service.read('xlsx', 'budget.xlsx', 'good-token');
  assert.ok(xlsxResult.workbook, 'parsed grid');
  assert.equal(xlsxResult.buffer, undefined);

  const pptx = makeService({ readFileSync: () => readFileSync(fixture('cli-created.pptx')) });
  const pptxResult = await pptx.service.read('pptx', 'deck.pptx', 'good-token');
  assert.ok(pptxResult.deck, 'parsed slides');
  assert.equal(pptxResult.deck.slides.length, 2);
});

test('an unparseable document is a refusal, not a crash', async () => {
  const { service } = makeService({ readFileSync: () => Buffer.from('not a workbook at all') });
  const result = await service.read('xlsx', 'broken.xlsx', 'good-token');
  assert.equal(result.ok, false);
  assert.match(result.error, /zip|Office/i);
});

test('an unknown kind is refused', async () => {
  const { service } = makeService();
  const result = await service.read('pdf', 'doc.pdf', 'good-token');
  assert.equal(result.ok, false);
  assert.match(result.error, /不支持/);
});
