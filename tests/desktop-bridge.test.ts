import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('desktop bridge accepts a user message and emits JSON events', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-bridge-'));
  const child = spawn(
    process.execPath,
    [
      resolve('dist/src/index.js'),
      '--desktop-bridge',
      '--provider', 'mock',
      '--approval', 'auto',
      '--workspace', workspace,
      '--session-dir', join(workspace, '.aicode', 'sessions'),
    ],
    { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const events: Array<Record<string, unknown>> = [];
  child.stdout.setEncoding('utf8');
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* swallow non-JSON */ }
    }
  });
  // Surface stderr for debugging on failure.
  const stderrChunks: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderrChunks.push(String(chunk)));

  // Wait for bridge_ready before sending the first command.
  const readyDeadline = Date.now() + 10000;
  while (Date.now() < readyDeadline && !events.some((event) => event.type === 'bridge_ready')) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(
    events.some((event) => event.type === 'bridge_ready'),
    `bridge_ready not received. stderr=${stderrChunks.join('')}`,
  );

  child.stdin.write(`${JSON.stringify({ type: 'user_message', text: 'smoke multi-tool task' })}\n`);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !events.some((event) => event.type === 'turn_done')) {
    await new Promise((r) => setTimeout(r, 50));
  }

  child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
  const exit = once(child, 'exit');
  const guard = new Promise((_r, reject) => setTimeout(() => reject(new Error('bridge did not exit')), 5000));
  try {
    await Promise.race([exit, guard]);
  } catch {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }

  const kinds = new Set(events.map((event) => event.type));
  assert.ok(kinds.has('bridge_ready'), `missing bridge_ready. saw=${[...kinds].join(',')}`);
  assert.ok(kinds.has('turn_start'), `missing turn_start. saw=${[...kinds].join(',')}`);
  assert.ok(
    kinds.has('assistant_delta') || kinds.has('assistant'),
    `missing assistant output. saw=${[...kinds].join(',')}`,
  );
  assert.ok(kinds.has('tool_start'), `missing tool_start. saw=${[...kinds].join(',')}`);
  assert.ok(kinds.has('tool_result'), `missing tool_result. saw=${[...kinds].join(',')}`);
  assert.ok(kinds.has('turn_done'), `missing turn_done. saw=${[...kinds].join(',')}`);

  await rm(workspace, { recursive: true, force: true });
});

test('desktop bridge responds to ping with pong', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-bridge-ping-'));
  const child = spawn(
    process.execPath,
    [
      resolve('dist/src/index.js'),
      '--desktop-bridge',
      '--provider', 'mock',
      '--approval', 'auto',
      '--workspace', workspace,
      '--session-dir', join(workspace, '.aicode', 'sessions'),
    ],
    { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const events: Array<Record<string, unknown>> = [];
  child.stdout.setEncoding('utf8');
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* swallow */ }
    }
  });

  const readyDeadline = Date.now() + 10000;
  while (Date.now() < readyDeadline && !events.some((event) => event.type === 'bridge_ready')) {
    await new Promise((r) => setTimeout(r, 25));
  }

  child.stdin.write(`${JSON.stringify({ type: 'ping' })}\n`);
  const pongDeadline = Date.now() + 5000;
  while (Date.now() < pongDeadline && !events.some((event) => event.type === 'pong')) {
    await new Promise((r) => setTimeout(r, 25));
  }

  child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
  const exit = once(child, 'exit');
  const guard = new Promise((_r, reject) => setTimeout(() => reject(new Error('bridge did not exit')), 5000));
  try {
    await Promise.race([exit, guard]);
  } catch {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }

  assert.ok(events.some((event) => event.type === 'pong'));
  await rm(workspace, { recursive: true, force: true });
});
