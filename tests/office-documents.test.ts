import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { WorkflowStore } from '../src/workflow/store.js';

/*
 * The Office document builders zip their parts by hand. Two of them called
 * `require('node:zlib')` from inside what is an ES module ("type": "module",
 * module: NodeNext), where `require` does not exist — so `create_pptx` and
 * `insert_docx_image` threw `ReferenceError: require is not defined` the moment
 * the tool ran, and the WorkflowStore's two delete methods caught that same
 * ReferenceError and returned `false` forever.
 *
 * Nothing caught it because no test executed these tools, and `tsc` does not
 * resolve `require` inside an ESM file, so it type-checked clean. The tests
 * below run each one for real and then read the bytes back, because a zip built
 * without a working deflate still starts with "PK".
 */

const ctx = (workspaceRoot: string) => ({ workspaceRoot, approval: 'auto' as const });

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'aicode-office-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every member of a zip, inflated. Reads the central directory. */
function unzip(buffer: Buffer): Map<string, Buffer> {
  const members = new Map<string, Buffer>();
  for (let i = 0; i + 46 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(i) !== 0x02014b50) continue;
    const method = buffer.readUInt16LE(i + 10);
    const compressedSize = buffer.readUInt32LE(i + 20);
    const nameLength = buffer.readUInt16LE(i + 28);
    const extraLength = buffer.readUInt16LE(i + 30);
    const commentLength = buffer.readUInt16LE(i + 32);
    const localOffset = buffer.readUInt32LE(i + 42);
    const name = buffer.toString('utf8', i + 46, i + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    members.set(name, method === 8 ? inflateRawSync(raw) : raw);

    i += 45 + nameLength + extraLength + commentLength;
  }
  return members;
}

test('create_pptx writes a real presentation instead of throwing ReferenceError', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'quarter.pptx');
    const result = await createDefaultToolRegistry().execute(
      'create_pptx',
      {
        path: target,
        title: '2024 Q1 业务汇报',
        subtitle: '技术部',
        slides: [
          { title: '核心指标', bullets: ['用户增长 20%', '营收增长 15%'] },
          { title: '下一步计划', bullets: ['扩展市场'] },
        ],
      },
      ctx(dir),
    );

    assert.equal(result.ok, true, result.output);
    const bytes = await readFile(target);
    assert.equal(bytes.subarray(0, 2).toString('utf8'), 'PK', 'a zip container');

    // Every part must inflate. Without a working deflate the container still
    // looks like a zip from the outside, so reading the members is the check
    // that actually distinguishes built from broken.
    const members = unzip(bytes);
    for (const name of [
      '[Content_Types].xml',
      'ppt/presentation.xml',
      'ppt/_rels/presentation.xml.rels',
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/slide3.xml',
    ]) {
      assert.ok(members.has(name), `${name} missing from [${[...members.keys()].join(', ')}]`);
    }

    const slide1 = members.get('ppt/slides/slide1.xml')!.toString('utf8');
    assert.match(slide1, /2024 Q1 业务汇报/);
    assert.match(slide1, /技术部/);
    const slide2 = members.get('ppt/slides/slide2.xml')!.toString('utf8');
    assert.match(slide2, /核心指标/);
    assert.match(slide2, /用户增长 20%/);
    // The title slide is listed first in the presentation's slide list.
    assert.equal(
      [...members.get('ppt/presentation.xml')!.toString('utf8').matchAll(/<p:sldId\b/g)].length,
      3,
      'all three slides are in the slide list',
    );
  });
});

test('insert_docx_image writes a document with the image part inside it', async () => {
  await withTempDir(async (dir) => {
    // A 1×1 PNG, inline so the test needs no fixture file.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const imagePath = join(dir, 'dot.png');
    await writeFile(imagePath, png);

    const target = join(dir, 'report.docx');
    const result = await createDefaultToolRegistry().execute(
      'insert_docx_image',
      { path: target, title: '产品介绍', images: [{ source: imagePath, caption: '图1' }] },
      ctx(dir),
    );

    assert.equal(result.ok, true, result.output);
    const members = unzip(await readFile(target));

    // This builder pushes a Buffer through the same map the text parts use, so
    // a string-only zip would corrupt the image while still looking valid.
    assert.ok(members.has('word/media/image1.png'), `image part missing from [${[...members.keys()].join(', ')}]`);
    assert.deepEqual(
      [...members.get('word/media/image1.png')!],
      [...png],
      'the image bytes survive the zip round trip',
    );
    assert.match(members.get('word/document.xml')!.toString('utf8'), /产品介绍/);
  });
});

test('WorkflowStore deletes actually delete', async () => {
  await withTempDir(async (dir) => {
    // Previously the require() threw inside the try and the catch swallowed it,
    // so both methods returned false and left the file in place — a delete that
    // silently does nothing is worse than one that fails loudly.
    const store = new WorkflowStore(join(dir, 'store'));
    store.saveWorkflow({
      id: 'wf-1',
      name: 'demo',
      description: '',
      version: '1',
      nodes: [],
      entryNode: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const workflowFile = join(dir, 'store', 'workflows', 'wf-1.json');
    await access(workflowFile);
    assert.equal(store.deleteWorkflow('wf-1'), true, 'deleteWorkflow must report success');
    await assert.rejects(() => access(workflowFile), 'the workflow file is gone');
    assert.equal(store.deleteWorkflow('wf-1'), false, 'deleting a missing workflow reports false');
    assert.equal(store.loadWorkflow('wf-1'), null, 'and it is not readable');

    store.saveExecution({
      id: 'ex-1',
      workflowId: 'wf-1',
      workflowVersion: '1',
      status: 'completed',
      currentNodes: [],
      completedNodes: [],
      failedNodes: [],
      checkpoints: [],
      rollbacks: [],
      startedAt: new Date().toISOString(),
      context: {},
    });

    const executionFile = join(dir, 'store', 'executions', 'ex-1.json');
    await access(executionFile);
    assert.equal(store.deleteExecution('ex-1'), true, 'deleteExecution must report success');
    await assert.rejects(() => access(executionFile), 'the execution file is gone');
  });
});
