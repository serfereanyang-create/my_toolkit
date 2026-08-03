const fs = require('node:fs/promises');
const path = require('node:path');

const defaultSettings = {
  activeProviderId: 'mock',
  approval: 'ask',
  providers: [
    { id: 'mock', type: 'mock', label: 'Mock', model: 'mock-code-agent-v1', baseUrl: '' },
    { id: 'openai', type: 'openai', label: 'OpenAI compatible', model: 'gpt-5.5', baseUrl: 'https://api.openai.com/v1' },
    { id: 'anthropic', type: 'anthropic', label: 'Anthropic', model: 'claude-3-5-sonnet-latest', baseUrl: '' },
  ],
  recentWorkspaces: [],
};

function createSettingsStore(userDataDir) {
  const file = path.join(userDataDir, 'settings.json');

  async function get() {
    try {
      return { ...defaultSettings, ...JSON.parse(await fs.readFile(file, 'utf8')) };
    } catch (error) {
      if (error && error.code === 'ENOENT') return defaultSettings;
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
