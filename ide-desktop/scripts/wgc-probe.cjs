/**
 * Does Windows.Graphics.Capture (via Electron's desktopCapturer) actually
 * return pixels for a MINIMIZED window? PrintWindow returns a black strip for
 * those, which is why computer_window_shot refuses them. This probe answers
 * the question with pictures instead of assumptions.
 *
 * The window is never shown, never focused, never activated.
 */
'use strict';
require('./lib/probe-guard.cjs');

const { app, BrowserWindow, desktopCapturer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const output = path.resolve(__dirname, '..', 'out', 'wgc-probe');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 800, height: 600 },
    fetchWindowIcons: false,
  });
  const rows = [];
  for (const source of sources) {
    const size = source.thumbnail.getSize();
    const png = source.thumbnail.toPNG();
    // A blank capture is one flat colour. Sample the bitmap directly.
    const bitmap = source.thumbnail.toBitmap();
    const seen = new Set();
    let changes = 0;
    let last = -1;
    for (let i = 0; i < bitmap.length; i += 4 * 997) {
      const v = (bitmap[i] << 16) | (bitmap[i + 1] << 8) | bitmap[i + 2];
      if (v !== last) changes += 1;
      last = v;
      if (seen.size < 5000) seen.add(v);
    }
    const file = path.join(output, `src-${source.id.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}.png`);
    fs.writeFileSync(file, png);
    rows.push({
      id: source.id,
      name: source.name,
      w: size.width,
      h: size.height,
      bytes: png.length,
      colors: seen.size,
      changes,
      file: path.basename(file),
    });
  }
  fs.writeFileSync(path.join(output, 'sources.json'), JSON.stringify(rows, null, 2));
  for (const row of rows) {
    console.log(`${row.id} ${row.w}x${row.h} colors=${row.colors} changes=${row.changes} ${row.name}`);
  }
}).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => { app.quit(); });
