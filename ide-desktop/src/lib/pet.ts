export type PetSettings = {
  visible: boolean;
  scale: number;
  opacity: number;
  right: number;
  bottom: number;
};

export const PET_STORAGE_KEY = 'yoycode.pet.v1';

export const DEFAULT_PET_SETTINGS: PetSettings = {
  visible: true,
  scale: 1,
  opacity: 0.96,
  right: 24,
  bottom: 24,
};

export function clampPetScale(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PET_SETTINGS.scale;
  return Math.min(1.35, Math.max(0.75, Math.round(parsed * 100) / 100));
}

export function clampPetOpacity(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PET_SETTINGS.opacity;
  return Math.min(1, Math.max(0.55, Math.round(parsed * 100) / 100));
}

export function clampPetOffset(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 24;
  return Math.min(10000, Math.max(12, Math.round(parsed)));
}

export function clampPetPosition(
  right: number,
  bottom: number,
  viewportWidth: number,
  viewportHeight: number,
  petWidth: number,
  petHeight: number,
  margin = 12,
): Pick<PetSettings, 'right' | 'bottom'> {
  const maxRight = Math.max(margin, viewportWidth - petWidth - margin);
  const maxBottom = Math.max(margin, viewportHeight - petHeight - margin);
  return {
    right: Math.min(maxRight, Math.max(margin, Math.round(right))),
    bottom: Math.min(maxBottom, Math.max(margin, Math.round(bottom))),
  };
}

export function normalizePetSettings(value: unknown): PetSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_PET_SETTINGS };
  const input = value as Record<string, unknown>;
  return {
    visible: input.visible !== false,
    scale: clampPetScale(input.scale),
    opacity: clampPetOpacity(input.opacity),
    right: clampPetOffset(input.right),
    bottom: clampPetOffset(input.bottom),
  };
}

export function readPetSettings(storage?: Pick<Storage, 'getItem'>): PetSettings {
  try {
    const raw = storage?.getItem(PET_STORAGE_KEY);
    return raw ? normalizePetSettings(JSON.parse(raw)) : { ...DEFAULT_PET_SETTINGS };
  } catch {
    return { ...DEFAULT_PET_SETTINGS };
  }
}

export function writePetSettings(settings: PetSettings, storage?: Pick<Storage, 'setItem'>): void {
  try {
    storage?.setItem(PET_STORAGE_KEY, JSON.stringify(normalizePetSettings(settings)));
  } catch {
    // Persistence is best effort; the in-memory widget remains usable.
  }
}
