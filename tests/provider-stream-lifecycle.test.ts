import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { iterateSseDataLines } from '../src/providers/protocol.js';

test('completed and early-returned streams let an owned Node process exit without waiting for the idle deadline', async () => {
  const run = promisify(execFile);
  const moduleUrl = new URL('../src/providers/protocol.js', import.meta.url).href;
  const script = `import { iterateSseDataLines } from ${JSON.stringify(moduleUrl)};
    for await (const row of iterateSseDataLines(new Response('data: complete\\n\\n'))) { if (row !== 'complete') throw new Error(row); }
    let cancelled = false;
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: first\\n\\n')); }, cancel() { cancelled = true; } }));
    for await (const row of iterateSseDataLines(response)) { break; }
    if (!cancelled) throw new Error('Early return left the reader alive');
    console.log('streams released');`;
  const result = await run(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, timeout: 5000 });
  assert.match(result.stdout, /streams released/);
});

test('an idle stream cancels its source and releases its lock after reporting the deadline', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
  await assert.rejects(async () => { for await (const row of iterateSseDataLines(response, 20)) { assert.fail(`An idle source unexpectedly produced ${row}`); } }, /Provider stream idle timeout/);
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
});
