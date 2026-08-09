// src/state/settingsStore.marine.test.ts
import { useSettingsStore } from './settingsStore';

const mockReadJson = jest.fn(async (): Promise<unknown> => null);
jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: () => mockReadJson(),
}));

describe('marineLayers setting', () => {
  it('defaults to off (empty) and persists checked layers', () => {
    expect(useSettingsStore.getState().marineLayers).toEqual([]);
    useSettingsStore.getState().set('marineLayers', ['bathymetry', 'seamarks']);
    expect(useSettingsStore.getState().marineLayers).toEqual(['bathymetry', 'seamarks']);
    useSettingsStore.getState().set('marineLayers', []);
    expect(useSettingsStore.getState().marineLayers).toEqual([]);
  });

  it('sanitizes persisted junk entries on hydration', async () => {
    // The migration ladder only compares typeof against the default ([] is
    // 'object'), so junk inside the array — or a whole junk array — would
    // slip through without the deep sanitize in hydrate().
    mockReadJson.mockResolvedValueOnce({
      schemaVersion: 2,
      marineLayers: ['seamarks', 'navionics', 42, { id: 'bathymetry' }],
    });
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().marineLayers).toEqual(['seamarks']);
  });

  it('keeps a valid persisted list on hydration', async () => {
    mockReadJson.mockResolvedValueOnce({ schemaVersion: 2, marineLayers: ['bathymetry'] });
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().marineLayers).toEqual(['bathymetry']);
  });
});
