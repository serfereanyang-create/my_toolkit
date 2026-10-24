// Aliasing test: send one identical prompt under several different advertised
// model names. If distinct frontier models really serve them, outputs must
// diverge. If every name returns the same upstream, the names are aliases.
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('C:/Users/34516/.zcode/v2/config.json', 'utf8'));

const target = process.argv[2];
const models = process.argv.slice(3);
const p = cfg.provider[target];
const base = (p.options.baseURL || '').replace(/\/+$/, '');
const key = p.options.apiKey;

// A prompt with a real random component: identical outputs across different
// model names then cannot be explained by deterministic sampling.
function makePrompt() {
  const nums = Array.from({ length: 8 }, () => Math.floor(Math.random() * 900) + 100);
  return 'Compute and output only the result, no explanation.\n' +
    nums.join(' * ') + ' = ?\n' +
    'Then output exactly one random word from this list: alpha, bravo, charlie, delta, echo.';
}

async function ask(model, prompt) {
  const t0 = Date.now();
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 300 }),
  });
  const j = await res.json().catch(() => null);
  return {
    model,
    status: res.status,
    ms: Date.now() - t0,
    reported: j && j.model,
    text: j && j.choices && j.choices[0] && j.choices[0].message
      ? (j.choices[0].message.content || '').trim().replace(/\s+/g, ' ')
      : JSON.stringify(j).slice(0, 200),
    usage: j && j.usage,
  };
}

(async () => {
  const prompt = makePrompt();
  console.log('prompt:', prompt.replace(/\n/g, ' | '));
  console.log('');
  const results = [];
  for (const m of models) {
    const r = await ask(m, prompt);
    results.push(r);
    console.log(`[${m}] status=${r.status} ${r.ms}ms reported=${r.reported}`);
    console.log('   ->', r.text.slice(0, 200));
    console.log('   usage:', JSON.stringify(r.usage));
  }
  const texts = results.map(r => r.text);
  const dupes = texts.length - new Set(texts).size;
  console.log('\n=== distinct outputs:', new Set(texts).size, 'of', texts.length, '=> duplicate answers:', dupes);
  console.log('=== reported model names:', JSON.stringify(results.map(r => r.reported)));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
