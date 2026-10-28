export type RovingTabKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

export function nextRovingTabId(tabIds: string[], activeId: string | null, key: RovingTabKey): string | null {
  if (tabIds.length === 0) return null;
  if (key === 'Home') return tabIds[0] ?? null;
  if (key === 'End') return tabIds.at(-1) ?? null;
  const index = Math.max(0, tabIds.indexOf(activeId ?? ''));
  const delta = key === 'ArrowRight' ? 1 : -1;
  return tabIds[(index + delta + tabIds.length) % tabIds.length] ?? null;
}
