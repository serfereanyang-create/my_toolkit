/**
 * End-to-end check of "browse -> download -> analyse" in the hidden browser.
 *
 * tests/background-browser.test.cjs covers the security boundary but cannot
 * open a window; this drives the real offscreen service against a real local
 * HTTP server, so the parts that only exist at runtime are verified:
 *
 *   - a link on the page is returned by inspect with an absolute href,
 *   - navigate follows it (a different port is a different origin, which the
 *     old origin anchor refused outright),
 *   - a PDF is downloaded through the page's session into downloads/,
 *   - the saved file opens with the CLI's pdf_to_text.
 *
 * Run: npx electron scripts/bg-download-smoke.cjs
 */
'use strict';
const { app } = require('electron');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { createBackgroundBrowserService } = require('../electron/background-browser.cjs');

app.on('window-all-closed', () => {});

// A minimal but structurally real PDF: catalog -> pages -> page -> contents.
function makePdf(text) {
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let body = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((obj, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const PDF = makePdf('Downloaded And Analysed');

app.whenReady().then(async () => {
  try {
    await main();
  } catch (error) {
    console.log(`FAIL harness :: ${error && error.stack ? error.stack : error}`);
    app.exit(1);
  }
});

async function main() {
  const results = [];
  const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);

  // Two servers, so the link genuinely crosses an origin.
  const pageServer = http.createServer((req, res) => {
    if (req.url === '/paper.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="paper.pdf"' });
      res.end(PDF);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Library</title>
      <h1>Library</h1>
      <a id="paper" href="/paper.pdf">Download the paper</a>
      <a id="other" href="${otherUrl}">Other site</a>`);
  });
  let otherUrl = '';
  const otherServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>Other</title><h1>OTHER SITE</h1>');
  });
  await new Promise((r) => pageServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => otherServer.listen(0, '127.0.0.1', r));
  otherUrl = `http://127.0.0.1:${otherServer.address().port}/`;

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-dl-'));
  const svc = createBackgroundBrowserService();
  const run = (tool, input) => svc.execute({ sessionId: 's', workspaceRoot: ws, tool, input });

  const open = await run('background_browser_open', { url: `http://127.0.0.1:${pageServer.address().port}/` });
  check('open a real http page', open.ok === true, open.output);
  const browserId = open.data?.browserId;

  const insp = await run('background_browser_inspect', { browserId });
  check('inspect returns the page text', String(insp.output).includes('Library'));
  check('inspect lists resolved links', Array.isArray(insp.data?.links) && insp.data.links.some((l) => /\/paper\.pdf$/.test(l.href)), JSON.stringify(insp.data?.links));

  const nav = await run('background_browser_navigate', { browserId, url: otherUrl });
  check('navigate crosses to another origin', nav.ok === true && String(nav.output).includes('127.0.0.1'), nav.output);
  const back = await run('background_browser_navigate', { browserId, url: `http://127.0.0.1:${pageServer.address().port}/` });
  check('and back', back.ok === true);

  const dl = await run('background_browser_download', { browserId, url: `http://127.0.0.1:${pageServer.address().port}/paper.pdf` });
  check('download saves the file', dl.ok === true, dl.output);
  const saved = String(dl.data?.path ?? '');
  check('saved under downloads/', saved.startsWith('downloads/'), saved);
  const onDisk = path.join(ws, saved);
  check('file exists on disk', fs.existsSync(onDisk) && fs.statSync(onDisk).size > 100);
  check('bytes match', fs.existsSync(onDisk) && fs.statSync(onDisk).size === PDF.length, `${fs.existsSync(onDisk) ? fs.statSync(onDisk).size : 0} vs ${PDF.length}`);

  // The point of the whole exercise: the saved file is analysable. The CLI is
  // an ES module, so it is imported dynamically; `process.execPath` cannot be
  // used to shell out because inside Electron it is Electron, not node.
  const cli = path.resolve(__dirname, '..', '..', 'cli');
  let extracted = '';
  try {
    const { pathToFileURL } = require('node:url');
    const pdf = await import(pathToFileURL(path.join(cli, 'dist/src/tools/pdf-text.js')).href);
    extracted = pdf.extractPdfTextFromBuffer(fs.readFileSync(onDisk));
  } catch (error) { extracted = `ERROR ${error.message}`; }
  check('pdf_to_text reads the downloaded file', extracted.includes('Downloaded And Analysed'), JSON.stringify(extracted.slice(0, 120)));

  // An unsolicited download must still be refused. Clicking the attachment
  // link without arming first is exactly that case: the page asks for a file
  // and nothing in this session authorised it.
  const dir = path.join(ws, 'downloads');
  const list = () => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);
  const before = list();
  const casual = await run('background_browser_click', { browserId, selector: '#paper' });
  await new Promise((r) => setTimeout(r, 600));
  const after = list();
  check('an unarmed download is refused', after === before, `click=${casual.output} files ${before}->${after}`);

  // The armed path: prepare, then click the same link.
  const armed = await run('background_browser_download', { browserId });
  check('download without a url arms the next click', armed.ok === true && armed.data?.armed === true, armed.output);
  const clicked = await run('background_browser_click', { browserId, selector: '#paper' });
  check('the armed click saves the file', clicked.ok === true && String(clicked.data?.path ?? '').startsWith('downloads/'), clicked.output);
  check('two files now exist', list() === 2, `files=${list()}`);

  await svc.disposeAll();
  pageServer.close();
  otherServer.close();
  fs.rmSync(ws, { recursive: true, force: true });

  console.log(results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\nSUMMARY: ${results.length - failed}/${results.length} passed`);
  app.exit(failed > 0 ? 1 : 0);
}
