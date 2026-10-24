import type { DesktopPreferences, DesktopSettings, ProviderConfig } from '../types';

export type SettingsPatch = Partial<Omit<DesktopSettings, 'providers'>> & {
  providers?: ProviderConfig[];
  providerUpdates?: Array<Partial<ProviderConfig> & { id: string }>;
  removeProviderIds?: string[];
};

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function settingsPatch(before: DesktopSettings, after: DesktopSettings): SettingsPatch {
  const patch: SettingsPatch = {};
  if (before.activeProviderId !== after.activeProviderId) patch.activeProviderId = after.activeProviderId;
  if (before.approval !== after.approval) patch.approval = after.approval;
  if (!equal(before.recentWorkspaces, after.recentWorkspaces)) patch.recentWorkspaces = after.recentWorkspaces;

  const preferences: DesktopPreferences = {};
  for (const [key, value] of Object.entries(after.preferences ?? {})) {
    if (!equal(value, before.preferences?.[key])) preferences[key] = value;
  }
  if (Object.keys(preferences).length) patch.preferences = preferences;

  const updates: SettingsPatch['providerUpdates'] = [];
  for (const provider of after.providers) {
    const previous = before.providers.find((entry) => entry.id === provider.id);
    if (!previous) {
      const { keyHint: _hint, ...persisted } = provider;
      updates.push(persisted);
      continue;
    }
    const update: Record<string, unknown> = { id: provider.id };
    for (const [key, value] of Object.entries(provider)) {
      if (key !== 'id' && key !== 'keyHint' && !equal(value, previous[key as keyof ProviderConfig])) update[key] = value;
    }
    if (Object.keys(update).length > 1) updates.push(update as Partial<ProviderConfig> & { id: string });
  }
  if (updates.length) patch.providerUpdates = updates;
  const removed = before.providers.filter((entry) => !after.providers.some((next) => next.id === entry.id)).map((entry) => entry.id);
  if (removed.length) patch.removeProviderIds = removed;
  return patch;
}
