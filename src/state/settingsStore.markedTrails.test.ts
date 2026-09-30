// src/state/settingsStore.markedTrails.test.ts — the "Marked trails"
// (Waymarked Trails) overlay was retired for Explore's long-distance trails
// (#467). A settings.json written while it was on must still hydrate, keep
// every other choice, and lose the dead key at the next write.
import type { useSettingsStore as UseSettingsStore } from './settingsStore';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

interface StorageMock {
  writeJson: jest.Mock;
  readJson: jest.Mock;
}

function load(): { store: typeof UseSettingsStore; storage: StorageMock } {
  let loaded!: { store: typeof UseSettingsStore; storage: StorageMock };
  jest.isolateModules(() => {
    loaded = {
      storage: jest.requireMock<StorageMock>('@data/storage'),
      store:
        jest.requireActual<typeof import('./settingsStore')>('./settingsStore').useSettingsStore,
    };
  });
  return loaded;
}

it('hydrates an old file with marked trails on, and drops the key on the next write', async () => {
  const { store, storage } = load();
  storage.readJson.mockResolvedValueOnce({
    schemaVersion: 3,
    markedTrailsNetworks: ['hiking', 'mtb'],
    units: 'imperial',
    showHeatmap: false,
  });
  await store.getState().hydrate();

  const state = store.getState() as unknown as Record<string, unknown>;
  expect(state.hydrated).toBe(true);
  expect(state.units).toBe('imperial');
  expect(state.showHeatmap).toBe(false);
  expect(state.markedTrailsNetworks).toBeUndefined();

  store.getState().set('themeMode', 'dark');
  const written = storage.writeJson.mock.calls.at(-1)?.[1] as Record<string, unknown>;
  expect(written.themeMode).toBe('dark');
  expect(written.units).toBe('imperial');
  expect('markedTrailsNetworks' in written).toBe(false);
});
