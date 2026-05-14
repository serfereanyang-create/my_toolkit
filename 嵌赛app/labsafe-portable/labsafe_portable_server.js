const http = require('http');
const fs = require('fs');
const path = require('path');

const uiPort = Number(process.env.LABSAFE_UI_PORT || process.argv[2] || 8082);
const apiPort = Number(process.env.LABSAFE_HTTP_PORT || 8765);
const root = __dirname;

function headers(type) {
  return {
    'Content-Type': type,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  };
}

function proxyApi(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers('text/plain; charset=utf-8'));
    res.end();
    return;
  }

  const upstream = http.request({
    host: '127.0.0.1',
    port: apiPort,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `127.0.0.1:${apiPort}` }
  }, (apiRes) => {
    res.writeHead(apiRes.statusCode || 502, {
      ...apiRes.headers,
      ...headers(apiRes.headers['content-type'] || 'application/json; charset=utf-8')
    });
    apiRes.pipe(res);
  });

  upstream.on('error', (err) => {
    res.writeHead(502, headers('application/json; charset=utf-8'));
    res.end(JSON.stringify({ ok: false, message: err.message }));
  });

  req.pipe(upstream);
}

http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/') || url.pathname === '/snapshot' || url.pathname === '/health') {
    proxyApi(req, res);
    return;
  }

  const filePath = path.join(root, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, headers('text/plain; charset=utf-8'));
      res.end('Not found');
      return;
    }
    res.writeHead(200, headers('text/html; charset=utf-8'));
    res.end(data);
  });
}).listen(uiPort, '127.0.0.1', () => {
  console.log(`LabSafe UI: http://127.0.0.1:${uiPort}/index.html`);
});
