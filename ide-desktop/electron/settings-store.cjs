const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteJson } = require('./atomic-file.cjs');
const { quarantine } = require('./json-store.cjs');

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
  let writeQueue = Promise.resolve();

  /**
   * Merge a parsed file over the defaults, then repair the collection fields.
   *
   * `update` dereferences `providers.filter` and `recentWorkspaces.filter`, so a
   * settings file carrying `recentWorkspaces: null` (or a hand-edited provider
   * block that is not a list) made EVERY later save reject with a TypeError —
   * the app kept running on the values it had loaded and silently stopped
   * persisting anything, including a provider the user had just added.
   */
  function normalizeSettings(parsed) {
    const merged = { ...defaultSettings, ...parsed };
    if (!Array.isArray(merged.providers)) merged.providers = structuredClone(defaultSettings.providers);
    if (!Array.isArray(merged.recentWorkspaces)) merged.recentWorkspaces = [];
    if (!merged.preferences || typeof merged.preferences !== 'object' || Array.isArray(merged.preferences)) {
      delete merged.preferences;
    }
    return merged;
  }

  /*
   * Migrate the retired 沙箱模式 preference onto the approval mode.
   *
   * The two knobs used to be separate: approval mode reached the CLI while
   * 沙箱模式 lived only in the main process, so they could contradict each
   * other. They are now one tier knob (cli/src/safety/policy.ts pathScopeFor),
   * which means a stored `gen.sandboxMode` would otherwise be silently ignored
   * — and a user who had chosen 严格 would quietly lose the protection it gave.
   *
   *   strict    → 只读 (deny):    refuses every write, the closest equivalent
   *   workspace → 变更前确认 (ask): still prompts before each change
   *   off       → no change
   *
   * Only applied when the approval mode is still the default, so an explicit
   * choice the user made in the approval control always wins.
   */
  function migrateSandboxMode(settings) {
    const prefs = settings.preferences;
    if (!prefs || typeof prefs !== 'object') return settings;
    const legacy = prefs['gen.sandboxMode'];
    if (typeof legacy !== 'string') return settings;
    const { 'gen.sandboxMode': _retired, ...rest } = prefs;
    const migrated = { ...settings, preferences: rest };
    if (settings.approval && settings.approval !== defaultSettings.approval) return migrated;
    if (legacy === 'strict') return { ...migrated, approval: 'deny' };
    if (legacy === 'workspace') return { ...migrated, approval: 'ask' };
    return migrated;
  }

  async function readSettings(options = {}) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return migrateSandboxMode(normalizeSettings(parseSettings(raw)));
    } catch (error) {
      if (error && error.code === 'ENOENT') return structuredClone(defaultSettings);
      // JSON parse errors (e.g., trailing garbage from a partial write) are
      // non-fatal: the app still starts on defaults. Saving, however, would
      // replace a file the user can no longer read but we could still recover
      // by hand — so a WRITE moves the unreadable copy aside first. A read
      // never touches the file.
      if (error instanceof SyntaxError) {
        console.error('[settings-store] unrecoverable settings JSON, falling back to defaults:', error.message);
        if (options.forWrite) {
          await quarantine(file).catch(() => undefined);
        }
        return structuredClone(defaultSettings);
      }
      throw error;
    }
  }

  async function get() {
    await writeQueue;
    return readSettings();
  }

  function update(change) {
    const pending = writeQueue.then(async () => {
      const current = await readSettings({ forWrite: true });
      const next = change(current);
      const { providerUpdates, removeProviderIds, ...fields } = next;
      const merged = { ...current, ...fields };
      if (next.preferences && typeof next.preferences === 'object') {
        merged.preferences = { ...current.preferences, ...next.preferences };
      }
      if (Array.isArray(providerUpdates) || Array.isArray(removeProviderIds)) {
        const removed = new Set(Array.isArray(removeProviderIds) ? removeProviderIds : []);
        merged.providers = current.providers.filter((provider) => !removed.has(provider.id)).map((provider) => ({ ...provider }));
        for (const patch of providerUpdates ?? []) {
          if (!patch || typeof patch.id !== 'string' || !patch.id) throw new Error('Provider id is required');
          const index = merged.providers.findIndex((provider) => provider.id === patch.id);
          if (index < 0) {
            if (!patch.type || typeof patch.baseUrl !== 'string') throw new Error('Provider configuration is incomplete');
            merged.providers.push({ ...patch });
          } else {
            merged.providers[index] = { ...merged.providers[index], ...patch };
          }
        }
      }
      await atomicWriteJson(file, merged);
      return merged;
    });
    writeQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async function set(next) {
    const snapshot = structuredClone(next);
    return update(() => snapshot);
  }

  async function addRecentWorkspace(workspaceRoot) {
    return update((current) => ({
      recentWorkspaces: [workspaceRoot, ...current.recentWorkspaces.filter((item) => item !== workspaceRoot)].slice(0, 10),
    }));
  }

  return { get, set, addRecentWorkspace };
}

module.exports = { createSettingsStore, defaultSettings };
