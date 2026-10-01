// src/state/settingsStore.parked3d.test.ts — the parked three.js 3D views
// (main-map Terrain3DLiveView and the trail viewer's GL branch) were removed,
// taking `trailViewMode` and `terrainHypso` with them. A settings.json written
// by an older build must still hydrate, keep every other choice, and lose the
// dead keys at the next write — whatever they hold.
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

it.each<[string, unknown, unknown]>([
  ['the old 3D values', '3d', true],
  ['the 2D value', '2d', false],
  ['junk values', { mode: 42 }, 'yes'],
])(
  'hydrates an old file with %s and drops the dead keys on the next write',
  async (_label, trailViewMode, terrainHypso) => {
    const { store, storage } = load();
    storage.readJson.mockResolvedValueOnce({
      schemaVersion: 3,
      trailViewMode,
      terrainHypso,
      units: 'imperial',
      terrainContours: false,
    });
    await store.getState().hydrate();

    const state = store.getState() as unknown as Record<string, unknown>;
    expect(state.hydrated).toBe(true);
    expect(state.units).toBe('imperial');
    expect(state.terrainContours).toBe(false);
    expect(state.trailViewMode).toBeUndefined();
    expect(state.terrainHypso).toBeUndefined();

    store.getState().set('themeMode', 'dark');
    const written = storage.writeJson.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(written.themeMode).toBe('dark');
    expect(written.units).toBe('imperial');
    expect('trailViewMode' in written).toBe(false);
    expect('terrainHypso' in written).toBe(false);
  },
);
