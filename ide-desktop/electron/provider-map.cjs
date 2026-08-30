/*
 * Pure mapping from a desktop ProviderConfig to the CLI's spawn parameters.
 * Extracted so the wire-format decision (especially custom → openai/anthropic
 * via apiFormat) is unit-testable without spawning Electron or the CLI.
 */

const OFFICIAL_OPENAI_BASE_URL = 'https://api.openai.com/v1';

// Map a provider config to the CLI --provider value.
// Gemini uses its native Generative Language API adapter.
function cliProviderName(providerConfig) {
  switch (providerConfig.type) {
    case 'mock':
      return 'mock';
    case 'anthropic':
      return 'anthropic';
    case 'gemini':
      return 'gemini';
    case 'custom':
      if (providerConfig.vendor === 'google' || providerConfig.apiFormat === 'gemini-generative') return 'gemini';
      if (providerConfig.apiFormat === 'openai-responses') return 'openai-responses';
      return ['anthropic', 'anthropic-messages'].includes(providerConfig.apiFormat) ? 'anthropic' : 'openai';
    default:
      return 'openai';
  }
}

// Resolve the base URL to pass to the CLI. The built-in OpenAI provider is
// forced to the official endpoint when empty (never fall through to the CLI's
// third-party proxy default); custom providers pass their own URL through.
function resolveBaseUrl(providerConfig) {
  const raw = providerConfig.baseUrl;
  if (providerConfig.type === 'openai' && !(raw && String(raw).trim())) {
    return OFFICIAL_OPENAI_BASE_URL;
  }
  return raw;
}

// Which encrypted key env var the CLI expects for this provider.
function apiKeyEnvVar(cliProvider) {
  if (cliProvider === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (cliProvider === 'openai' || cliProvider === 'openai-responses') return 'OPENAI_API_KEY';
  if (cliProvider === 'gemini') return 'GEMINI_API_KEY';
  return null; // mock needs none
}

module.exports = { cliProviderName, resolveBaseUrl, apiKeyEnvVar, OFFICIAL_OPENAI_BASE_URL };
