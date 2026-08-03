import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const PORT = 8791;
const SCRIPT_URL = new URL('./yunqiao-zcode-proxy.mjs', import.meta.url).href;

async function waitForHealth(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return;
    } catch {
      // The child may still be starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('proxy did not become healthy');
}

test('upstream failure after headers does not terminate the proxy', async () => {
  const bootstrap = `
    globalThis.fetch = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\\n\\n'));
          setTimeout(() => controller.error(new Error('simulated upstream disconnect')), 100);
        }
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
    import(${JSON.stringify(SCRIPT_URL)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', bootstrap, String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => stderr += chunk);

  try {
    await waitForHealth();

    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'grok-4.5',
          stream: true,
          messages: [{ role: 'user', content: 'test' }],
        }),
      });
      await response.text();
    } catch {
      // The response may terminate because the simulated upstream failed.
    }

    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(child.exitCode, null, stderr || 'proxy process exited');
    const health = await fetch(`http://127.0.0.1:${PORT}/health`);
    assert.equal(health.status, 200);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
