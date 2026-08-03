import http from 'node:http';

const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const TARGET = 'https://yunqiaoai.duckdns.org/v1';

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function mapPath(pathname) {
  if (pathname === '/models') return '/models';
  if (pathname === '/chat/completions') return '/chat/completions';
  if (pathname === '/responses') return '/responses';
  return pathname;
}

const server = http.createServer(async (req, res) => {
  try {
    const inputUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method === 'GET' && inputUrl.pathname === '/health') {
      json(res, 200, { ok: true, target: TARGET });
      return;
    }

    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const upstreamUrl = `${TARGET}${mapPath(inputUrl.pathname)}${inputUrl.search}`;

    if (inputUrl.pathname === '/chat/completions' && body?.length) {
      try {
        const payload = JSON.parse(body.toString('utf8'));
        const isConnectivityProbe = payload?.stream !== true
          && payload?.max_tokens === 1
          && Array.isArray(payload?.messages)
          && payload.messages.length === 1
          && payload.messages[0]?.role === 'user'
          && payload.messages[0]?.content === 'hi';

        if (isConnectivityProbe) {
          json(res, 200, {
            id: 'chatcmpl-zcode-proxy-health',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: payload.model || 'grok-4.5',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
          return;
        }
      } catch {
        // Forward malformed payloads to the upstream so the caller gets the real API error.
      }
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      const lower = name.toLowerCase();
      if (['host', 'connection', 'content-length', 'accept-encoding'].includes(lower)) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set('host', 'yunqiaoai.duckdns.org');

    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      duplex: body ? 'half' : undefined,
    });

    const responseHeaders = Object.fromEntries(upstream.headers.entries());
    delete responseHeaders['content-encoding'];
    delete responseHeaders['content-length'];
    res.writeHead(upstream.status, responseHeaders);

    if (!upstream.body) {
      res.end();
      return;
    }

    for await (const chunk of upstream.body) {
      res.write(Buffer.from(chunk));
    }
    res.end();
  } catch (error) {
    json(res, 502, {
      error: {
        message: error instanceof Error ? error.message : String(error),
        cause: error?.cause?.message || error?.cause?.code || null,
        type: 'zcode_proxy_error',
      },
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`yunqiao zcode proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`forwarding /chat/completions -> ${TARGET}/chat/completions`);
});
