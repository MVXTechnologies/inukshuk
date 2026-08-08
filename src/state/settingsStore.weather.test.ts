// src/state/settingsStore.weather.test.ts
import { useSettingsStore } from './settingsStore';

const mockReadJson = jest.fn(async (): Promise<unknown> => null);
jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: () => mockReadJson(),
}));

describe('weatherLayer setting', () => {
  it('defaults to off (null) and persists a chosen layer', () => {
    expect(useSettingsStore.getState().weatherLayer).toBeNull();
    useSettingsStore.getState().set('weatherLayer', 'radar-rain');
    expect(useSettingsStore.getState().weatherLayer).toBe('radar-rain');
    useSettingsStore.getState().set('weatherLayer', null);
    expect(useSettingsStore.getState().weatherLayer).toBeNull();
  });

  it('sanitizes persisted junk on hydration (typeof-null migration trap)', async () => {
    // The migration ladder only compares typeof against the default; null's
    // typeof is 'object', so an object-shaped value would slip through
    // without the deep sanitize in hydrate().
    mockReadJson.mockResolvedValueOnce({
      schemaVersion: 2,
      weatherLayer: { id: 'radar-rain' },
    });
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().weatherLayer).toBeNull();
  });

  it('keeps a valid persisted layer id on hydration', async () => {
    mockReadJson.mockResolvedValueOnce({ schemaVersion: 2, weatherLayer: 'wind' });
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().weatherLayer).toBe('wind');
  });
});
