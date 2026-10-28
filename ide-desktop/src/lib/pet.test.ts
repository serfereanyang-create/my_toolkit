import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PET_SETTINGS,
  PET_STORAGE_KEY,
  clampPetPosition,
  normalizePetSettings,
  readPetSettings,
  writePetSettings,
} from './pet';

describe('pet settings', () => {
  it('clamps the pet across the full viewport instead of a 240px corner box', () => {
    expect(clampPetPosition(3000, 2000, 1920, 1080, 100, 120)).toEqual({ right: 1808, bottom: 948 });
    expect(clampPetPosition(-100, -100, 1920, 1080, 100, 120)).toEqual({ right: 12, bottom: 12 });
    expect(clampPetPosition(500, 500, 80, 80, 120, 120)).toEqual({ right: 12, bottom: 12 });
  });

  it('uses safe defaults for missing or malformed data', () => {
    expect(normalizePetSettings(null)).toEqual(DEFAULT_PET_SETTINGS);
    expect(normalizePetSettings({ scale: 'bad', opacity: 4, right: -4, bottom: 999 })).toEqual({
      ...DEFAULT_PET_SETTINGS,
      opacity: 1,
      right: 12,
      bottom: 999,
    });
  });

  it('round trips settings through storage', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const next = { ...DEFAULT_PET_SETTINGS, visible: false, scale: 1.2, right: 88 };
    writePetSettings(next, storage);
    expect(values.has(PET_STORAGE_KEY)).toBe(true);
    expect(readPetSettings(storage)).toEqual(next);
  });

  it('recovers from invalid JSON without throwing', () => {
    const storage = { getItem: () => '{' };
    expect(readPetSettings(storage)).toEqual(DEFAULT_PET_SETTINGS);
  });
});
