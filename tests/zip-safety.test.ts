import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { createZipTool, extractZipTool, listZipEntries, safeArchivePath } from '../src/tools/zip.js';

/*
 * A downloaded archive is untrusted input, and extraction is the point where it
 * becomes files on disk. These tests exist because that path had no coverage at
 * all, and the bug was real: `extract_zip` joined the archive's own member name
 * onto the target directory, so an entry called `../../escaped.txt` wrote two
 * directories above the workspace. The sanitizer tests pin the rule; the two
 * end-to-end tests build a real archive and check what actually landed.
 */

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-zip-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A single-member ZIP with a caller-chosen name — the shape an attack takes. */
function oneMemberZip(name: string, payload = 'pwned'): Buffer {
  const data = Buffer.from(payload, 'utf8');
  const compressed = deflateRawSync(data);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const nameBuffer = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuffer.length, 12);
  eocd.writeUInt32LE(local.length + nameBuffer.length + compressed.length, 16);

  return Buffer.concat([local, nameBuffer, compressed, central, nameBuffer, eocd]);
}

test('a member name that climbs out of the target is refused', () => {
  for (const hostile of ['../../escaped.txt', '..', 'a/../../b', '/etc/passwd', 'C:\\Windows\\evil.dll', 'a\\..\\..\\b', '']) {
    assert.equal(safeArchivePath(hostile), null, `${hostile} must be refused`);
  }
});

test('an ordinary member name is kept, with backslashes treated as separators', () => {
  assert.equal(safeArchivePath('docs/readme.md'), 'docs/readme.md');
  assert.equal(safeArchivePath('./docs/readme.md'), 'docs/readme.md');
  assert.equal(safeArchivePath('docs\\readme.md'), 'docs/readme.md');
  assert.equal(safeArchivePath('readme.md'), 'readme.md');
});

test('a malicious archive writes nothing outside the target and says so', async () => {
  await withTempDir(async (dir) => {
    const workspace = join(dir, 'ws');
    await writeFile(join(dir, 'marker'), '');
    await rm(join(dir, 'marker'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'evil.zip'), oneMemberZip('../../escaped.txt'));

    const result = await extractZipTool.execute({ path: 'evil.zip', maxFiles: 10 }, { workspaceRoot: workspace, approval: 'auto' });

    assert.equal(result.ok, true);
    assert.deepEqual((result.data as { extracted: string[] }).extracted, []);
    assert.deepEqual((result.data as { refused: string[] }).refused, ['../../escaped.txt']);
    assert.equal(existsSync(resolve(workspace, '../../escaped.txt')), false, 'nothing may be written outside the workspace');
    assert.equal(existsSync(join(workspace, 'escaped.txt')), false, 'nor may it be flattened into the workspace');
    assert.match(result.output, /Refused 1 entry/);
  });
});

test('a normal archive still extracts into the target directory', async () => {
  await withTempDir(async (dir) => {
    const workspace = join(dir, 'ws');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'ok.zip'), oneMemberZip('nested/report.txt', 'hello'));

    const result = await extractZipTool.execute({ path: 'ok.zip', maxFiles: 10 }, { workspaceRoot: workspace, approval: 'auto' });

    assert.deepEqual((result.data as { extracted: string[] }).extracted, ['nested/report.txt']);
    assert.equal(await readFile(join(workspace, 'nested', 'report.txt'), 'utf8'), 'hello');
  });
});

test('create_zip cannot write a member that extract_zip would refuse', async () => {
  await withTempDir(async (dir) => {
    // Inline content is the one way a caller names a member directly, so it is
    // the way a traversal name could otherwise enter an archive this tool makes.
    const result = await createZipTool.execute(
      { path: 'out.zip', files: [{ path: '../escaped.txt', content: 'x' }] },
      { workspaceRoot: dir, approval: 'auto' },
    );
    assert.equal(result.ok, false, 'an archive with only an escaping member is refused');
    assert.match(result.output, /leave the archive root/);
    assert.equal(existsSync(join(dir, 'out.zip')), false);
  });
});

test('create_zip marks member names as UTF-8 so other tools read them correctly', async () => {
  await withTempDir(async (dir) => {
    // Without general-purpose bit 11 a reader falls back to CP437: Windows
    // Explorer guesses UTF-8 and looked right, while Python and macOS unzip
    // rendered 报告.md as 'µèÑσæè.md'.
    const result = await createZipTool.execute(
      { path: 'cn.zip', files: [{ path: '报告.md', content: '# 中文' }] },
      { workspaceRoot: dir, approval: 'auto' },
    );
    assert.equal(result.ok, true);
    const entries = listZipEntries(await readFile(join(dir, 'cn.zip')));
    assert.equal(entries[0].name, '报告.md');
    assert.equal(entries[0].utf8Name, true, 'the UTF-8 flag must be set');
  });
});

test('create_zip keeps the safe members and reports the omitted ones', async () => {
  await withTempDir(async (dir) => {
    const result = await createZipTool.execute(
      { path: 'mixed.zip', files: [{ path: 'keep.txt', content: 'ok' }, { path: '../drop.txt', content: 'x' }] },
      { workspaceRoot: dir, approval: 'auto' },
    );
    assert.equal(result.ok, true);
    assert.match(result.output, /Omitted 1 path/);
    const entries = await readdir(dir);
    assert.ok(entries.includes('mixed.zip'));
  });
});
