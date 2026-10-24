// Probe a relay station's real behavior: does the model name it advertises
// match the model that actually answers?
const fs = require('fs');
const crypto = require('crypto');

const cfgPath = 'C:/Users/34516/.zcode/v2/config.json';
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const target = process.argv[2]; // provider id
const model = process.argv[3];
const prompt = process.argv[4] || 'Reply with exactly the word: ok';

const p = cfg.provider[target];
if (!p) { console.error('provider not found:', target); process.exit(1); }
const opts = p.options || {};
const base = (opts.baseURL || '').replace(/\/+$/, '');
const key = opts.apiKey;

console.log('provider:', p.name, '| kind:', p.kind, '| base:', base);

async function call(path, body, extraHeaders) {
  const url = base + path;
  const res = await fetch(url, {
    method: 'POST',
    headers: Object.assign({
      'content-type': 'application/json',
      'authorization': 'Bearer ' + key,
    }, extraHeaders || {}),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

function digest(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

(async () => {
  // Probe 1: chat completions, ask it to identify itself
  const r = await call('/chat/completions', {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    max_tokens: 200,
  });
  console.log('\n--- POST /chat/completions ->', r.status);
  const interesting = ['server', 'x-oneapi-request-id', 'x-new-api-version', 'x-request-id',
    'cf-ray', 'x-ratelimit-limit-requests', 'openai-model', 'openai-processing-ms', 'system-fingerprint'];
  for (const k of interesting) {
    if (r.headers.get(k)) console.log('  hdr', k, '=', r.headers.get(k));
  }
  let parsed = null;
  try { parsed = JSON.parse(r.text); } catch (e) {}
  if (parsed) {
    console.log('  self-reported model =', parsed.model);
    console.log('  system_fingerprint =', parsed.system_fingerprint);
    if (parsed.system) console.log('  object =', parsed.object);
    if (parsed.usage) console.log('  usage =', JSON.stringify(parsed.usage));
    const msg = parsed.choices && parsed.choices[0] && parsed.choices[0].message;
    if (msg) {
      console.log('  reply =', JSON.stringify((msg.content || '').slice(0, 300)));
      // fingerprint the response shape
      if (msg.reasoning_content) console.log('  HAS reasoning_content (DeepSeek/GLM style)');
      if (msg.reasoning) console.log('  HAS reasoning field');
    }
  } else {
    console.log('  raw body (600):', r.text.slice(0, 600));
  }

  // Probe 2: the Responses API — real OpenAI gpt-5/6 exposes this; a fake route usually 404s
  const r2 = await call('/responses', {
    model,
    input: 'Reply with exactly the word: ok',
    stream: false,
  });
  console.log('\n--- POST /responses ->', r2.status);
  let p2 = null;
  try { p2 = JSON.parse(r2.text); } catch (e) {}
  if (p2) {
    console.log('  self-reported model =', p2.model);
    console.log('  object =', p2.object);
    console.log('  id =', p2.id);
  } else {
    console.log('  raw body (400):', r2.text.slice(0, 400));
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
