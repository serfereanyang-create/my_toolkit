import { writeFileSync } from 'node:fs';

const out = process.argv[2] || '/tmp/shot.png';
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && t.url?.startsWith('file://'));
if (!page) { console.error('no page target'); process.exit(3); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error(`timeout ${method}`)), 12000);
  });
}
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
  setTimeout(() => reject(new Error('ws open timeout')), 8000);
});

await send('Emulation.setFocusEmulationEnabled', { enabled: true });
const vis = await send('Runtime.evaluate', { expression: 'document.visibilityState' });
console.log('visibility', vis.result?.result?.value);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('wrote', out, shot.result.data.length);
ws.close();
process.exit(0);
