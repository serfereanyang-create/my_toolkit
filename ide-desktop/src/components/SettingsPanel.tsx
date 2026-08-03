import { useState } from 'react';
import type { DesktopSettings, ProviderConfig } from '../types';

export function SettingsPanel({ settings, onSave, onSaveKey }: {
  settings: DesktopSettings;
  onSave: (settings: DesktopSettings) => void;
  onSaveKey: (providerId: string, apiKey: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});

  function updateProvider(id: string, patch: Partial<ProviderConfig>) {
    setDraft({ ...draft, providers: draft.providers.map((provider) => provider.id === id ? { ...provider, ...patch } : provider) });
  }

  return (
    <div className="settings-panel">
      <h2>Settings</h2>
      <label className="field-row">
        <span>Active provider</span>
        <select value={draft.activeProviderId} onChange={(event) => setDraft({ ...draft, activeProviderId: event.target.value })}>
          {draft.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
        </select>
      </label>
      <label className="field-row">
        <span>Approval</span>
        <select value={draft.approval} onChange={(event) => setDraft({ ...draft, approval: event.target.value as DesktopSettings['approval'] })}>
          <option value="ask">Ask for writes</option>
          <option value="auto">Auto writes, ask shell</option>
          <option value="deny">Deny writes and shell</option>
        </select>
      </label>
      <div className="provider-list">
        {draft.providers.map((provider) => (
          <section key={provider.id} className="provider-row">
            <h3>{provider.label}</h3>
            <label className="field-row">
              <span>Model</span>
              <input value={provider.model} onChange={(event) => updateProvider(provider.id, { model: event.target.value })} />
            </label>
            <label className="field-row">
              <span>Base URL</span>
              <input value={provider.baseUrl} onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })} disabled={provider.type === 'anthropic' || provider.type === 'mock'} />
            </label>
            {provider.type !== 'mock' && (
              <label className="field-row">
                <span>API Key</span>
                <input type="password" value={apiKeys[provider.id] || ''} placeholder={provider.keyHint || 'missing'} onChange={(event) => setApiKeys({ ...apiKeys, [provider.id]: event.target.value })} />
                <button onClick={() => onSaveKey(provider.id, apiKeys[provider.id] || '')}>Save Key</button>
              </label>
            )}
          </section>
        ))}
      </div>
      <button className="primary-button" onClick={() => onSave(draft)}>Save Settings</button>
    </div>
  );
}
