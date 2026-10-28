/** Real-network check: open a site, follow a link, download a PDF, read it. */
'use strict';
require('./lib/probe-guard.cjs');

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createBackgroundBrowserService } = require('../electron/background-browser.cjs');
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-real-'));
  const svc = createBackgroundBrowserService();
  const run = (tool, input) => svc.execute({ sessionId: 's', workspaceRoot: ws, tool, input });
  const log = (...a) => console.log(...a);
  try {
    const open = await run('background_browser_open', { url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf' });
    log('open:', open.ok, open.output.slice(0, 160));
    const id = open.data?.browserId;
    if (id) {
      const insp = await run('background_browser_inspect', { browserId: id });
      log('inspect url:', insp.data?.url, 'links:', insp.data?.links?.length);
      const dl = await run('background_browser_download', { browserId: id });
      log('download(no url, arms):', dl.ok, dl.output.slice(0, 120));
      const files = path.join(ws, 'downloads');
      log('files:', fs.existsSync(files) ? fs.readdirSync(files) : '(none)');
      await run('background_browser_close', { browserId: id });
    }
    // Direct download through a fresh page.
    const open2 = await run('background_browser_open', { url: 'https://www.w3.org/' });
    const id2 = open2.data?.browserId;
    log('open2:', open2.ok);
    const dl2 = await run('background_browser_download', {
      browserId: id2,
      url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    });
    log('download(url):', dl2.ok, dl2.output);
    if (dl2.data?.path) {
      const { pathToFileURL } = require('node:url');
      const pdf = await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'cli', 'dist/src/tools/pdf-text.js')).href);
      const text = pdf.extractPdfTextFromBuffer(fs.readFileSync(path.join(ws, dl2.data.path)));
      log('extracted:', JSON.stringify(text.slice(0, 200)), 'chars=', text.length);
    }
    await run('background_browser_close', { browserId: id2 });
  } catch (error) {
    log('ERROR', error && error.stack ? error.stack : error);
  }
  await svc.disposeAll();
  fs.rmSync(ws, { recursive: true, force: true });
  app.exit(0);
});
