'use strict';
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

function pathToFileUrl(p) {
  return pathToFileURL(p);
}

// Reuse the CLI resolver: two implementations would drift apart. The CLI ships
// ESM ("type": "module"), so it must be pulled in with a dynamic import() —
// require() of an ES module throws ERR_REQUIRE_ESM inside the CJS main process.
const ROUTER = join(__dirname, '..', '..', 'cli', 'dist', 'src', 'dispatch', 'tierRouter.js');

let routerModule = null;
async function router() {
  if (!routerModule) {
    routerModule = await import(pathToFileUrl(ROUTER).href);
  }
  return routerModule;
}

function readSelection(sessionPath) {
  if (!existsSync(sessionPath)) return null;
  try {
    const record = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    return record.dispatch ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve both tiers for the UI. Returns { ok, tiers } or { ok:false, error }.
 * The shape mirrors the CLI so the two surfaces report the same thing.
 */
async function resolveForUi(selection) {
  if (!selection || !selection.expensive || !selection.cheap) {
    return { ok: false, configured: false, error: '未配置分级调度' };
  }
  const { resolveTiers } = await router();
  const resolved = resolveTiers(selection);
  if (resolved.error) return { ok: false, configured: false, error: resolved.error };
  return {
    ok: true,
    configured: true,
    tiers: {
      expensive: summarize(resolved.expensive),
      cheap: summarize(resolved.cheap),
    },
  };
}

function summarize(tier) {
  return {
    provider: tier.providerName,
    model: tier.model,
    contextWindow: tier.contextWindow ?? null,
    hasKey: Boolean(tier.apiKey),
  };
}

module.exports = { readSelection, resolveForUi };
