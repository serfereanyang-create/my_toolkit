/*
 * Portable settings export/import — compact port of zcode's settings-sync.
 *
 * Hard rule (mirrors the app's secret policy): API keys NEVER leave the
 * machine. Exported providers carry `hasApiKey` booleans only; import matches
 * providers by id and keeps whatever keys already exist locally.
 */

const BUNDLE_VERSION = 1;

function redactProvider(provider) {
  const { apiKey, ...rest } = provider ?? {};
  const hadKey = typeof apiKey === 'string' ? apiKey.length > 0 : Boolean(provider?.hasApiKey);
  return { ...rest, hasApiKey: hadKey };
}

function exportSettingsBundle(settings) {
  const providers = (settings.providers ?? []).map(redactProvider);
  return {
    bundleVersion: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    preferences: settings.preferences ?? {},
    providers,
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge an exported bundle back into the live settings. Unknown bundle
 * versions are rejected; providers are matched by id and local API keys are
 * preserved regardless of what the bundle claims. Returns the merged settings
 * plus a report of what changed.
 */
function importSettingsBundle(bundle, currentSettings) {
  if (!isPlainObject(bundle) || bundle.bundleVersion !== BUNDLE_VERSION) {
    throw new Error(`Unsupported settings bundle (version ${bundle?.bundleVersion ?? 'unknown'})`);
  }
  if (!isPlainObject(bundle.preferences) && bundle.preferences !== undefined) {
    throw new Error('Invalid settings bundle: preferences must be an object');
  }
  if (bundle.providers !== undefined && !Array.isArray(bundle.providers)) {
    throw new Error('Invalid settings bundle: providers must be an array');
  }

  const merged = { ...currentSettings };
  merged.preferences = { ...(currentSettings.preferences ?? {}), ...(bundle.preferences ?? {}) };

  const currentProviders = Array.isArray(currentSettings.providers) ? currentSettings.providers : [];
  const bundledProviders = Array.isArray(bundle.providers) ? bundle.providers : [];
  const byId = new Map(currentProviders.map((provider) => [provider?.id, provider]));

  const report = { providersAdded: 0, providersUpdated: 0, skipped: 0 };
  const nextProviders = [...currentProviders];
  for (const incoming of bundledProviders) {
    if (!isPlainObject(incoming) || typeof incoming.id !== 'string' || incoming.id.length === 0) {
      report.skipped += 1;
      continue;
    }
    const existing = byId.get(incoming.id);
    if (!existing) {
      nextProviders.push({ ...incoming, apiKey: undefined });
      report.providersAdded += 1;
      continue;
    }
    nextProviders.splice(nextProviders.indexOf(existing), 1, { ...existing, ...incoming, apiKey: existing.apiKey });
    report.providersUpdated += 1;
  }
  merged.providers = nextProviders;
  return { settings: merged, report };
}

module.exports = { BUNDLE_VERSION, exportSettingsBundle, importSettingsBundle, redactProvider };
