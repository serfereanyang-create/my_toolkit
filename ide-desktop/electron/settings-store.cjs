const fs = require('node:fs/promises');
const path = require('node:path');

const defaultSettings = {
  activeProviderId: 'mock',
  approval: 'ask',
  providers: [
    { id: 'mock', type: 'mock', label: 'Mock', model: 'mock-code-agent-v1', baseUrl: '' },
    { 
      id: 'openai', 
      type: 'openai', 
      label: 'OpenAI compatible', 
      model: 'gpt-5.5', 
      baseUrl: 'https://api.openai.com/v1',
      models: [
        { id: 'gpt-4o', inputPricePerM: 5.00, outputPricePerM: 15.00, cacheReadPricePerM: 2.50, cacheWritePricePerM: 6.25 },
        { id: 'gpt-4o-mini', inputPricePerM: 0.15, outputPricePerM: 0.60, cacheReadPricePerM: 0.075, cacheWritePricePerM: 0.30 },
        { id: 'gpt-4-turbo', inputPricePerM: 10.00, outputPricePerM: 30.00 },
        { id: 'gpt-3.5-turbo', inputPricePerM: 0.50, outputPricePerM: 1.50 },
      ]
    },
    { 
      id: 'anthropic', 
      type: 'anthropic', 
      label: 'Anthropic', 
      model: 'claude-3-5-sonnet-latest', 
      baseUrl: '',
      models: [
        { id: 'claude-opus-4-8', inputPricePerM: 15.00, outputPricePerM: 75.00, cacheReadPricePerM: 1.50, cacheWritePricePerM: 18.75 },
        { id: 'claude-3-5-sonnet-20241022', inputPricePerM: 3.00, outputPricePerM: 15.00, cacheReadPricePerM: 0.30, cacheWritePricePerM: 3.75 },
        { id: 'claude-3-5-sonnet-latest', inputPricePerM: 3.00, outputPricePerM: 15.00, cacheReadPricePerM: 0.30, cacheWritePricePerM: 3.75 },
        { id: 'claude-3-5-haiku-20241022', inputPricePerM: 0.80, outputPricePerM: 4.00, cacheReadPricePerM: 0.08, cacheWritePricePerM: 1.00 },
        { id: 'claude-3-5-haiku-latest', inputPricePerM: 0.80, outputPricePerM: 4.00, cacheReadPricePerM: 0.08, cacheWritePricePerM: 1.00 },
        { id: 'claude-3-haiku-20240307', inputPricePerM: 0.25, outputPricePerM: 1.25, cacheReadPricePerM: 0.03, cacheWritePricePerM: 0.30 },
        { id: 'claude-3-opus-20240229', inputPricePerM: 15.00, outputPricePerM: 75.00, cacheReadPricePerM: 1.50, cacheWritePricePerM: 18.75 },
        { id: 'claude-3-sonnet-20240229', inputPricePerM: 3.00, outputPricePerM: 15.00, cacheReadPricePerM: 0.30, cacheWritePricePerM: 3.75 },
      ]
    },
  ],
  recentWorkspaces: [],
};

/**
 * Try to extract a valid root-level JSON object from raw text that may have
 * trailing garbage bytes caused by a partial or non-truncating write.
 * Falls back to standard JSON.parse when no truncation is needed.
 */
function parseSettings(raw) {
  try {
    return JSON.parse(raw);
  } catch (firstErr) {
    // Walk forward and find the end of the first root-level JSON object.
    let depth = 0, inStr = false, esc = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (esc)    { esc = false; continue; }
      if (inStr)  {
        if (c === '\\') { esc = true; continue; }
        if (c === '"')  { inStr = false; }
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') { depth++; continue; }
      if (c === '}') {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(0, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            console.warn('[settings-store] repaired truncated settings file (kept', candidate.length, 'of', raw.length, 'bytes)');
            return parsed;
          } catch {
            break;
          }
        }
      }
    }
    throw firstErr; // neither strategy worked
  }
}

function createSettingsStore(userDataDir) {
  const file = path.join(userDataDir, 'settings.json');

  async function get() {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return { ...defaultSettings, ...parseSettings(raw) };
    } catch (error) {
      if (error && error.code === 'ENOENT') return defaultSettings;
      // JSON parse errors (e.g., trailing garbage from a partial write) are
      // non-fatal: log the problem and fall back to defaults so the app can
      // still start. The next settings.set() will overwrite the corrupt file.
      if (error instanceof SyntaxError) {
        console.error('[settings-store] unrecoverable settings JSON, resetting to defaults:', error.message);
        return defaultSettings;
      }
      throw error;
    }
  }

  async function set(next) {
    const merged = { ...await get(), ...next };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }

  async function addRecentWorkspace(workspaceRoot) {
    const current = await get();
    const recentWorkspaces = [workspaceRoot, ...current.recentWorkspaces.filter((item) => item !== workspaceRoot)].slice(0, 10);
    return await set({ recentWorkspaces });
  }

  return { get, set, addRecentWorkspace };
}

module.exports = { createSettingsStore, defaultSettings };
