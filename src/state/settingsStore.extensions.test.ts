// src/state/settingsStore.extensions.test.ts — the extension registry's
// settings migration, end to end through the store: settings.json files as
// the builds before the registry wrote them hydrate with every install and
// switch kept, and what the store writes back still carries the flat keys an
// older build (an OTA rollback) reads.
import beforeExtensions from '@core/extensions/__fixtures__/settings-before-extensions.json';
import geodeticOnly from '@core/extensions/__fixtures__/settings-geodetic-only-3dc166ff.json';
import mainShaped from '@core/extensions/__fixtures__/settings-main-39dd7848.json';

import type { useSettingsStore as UseSettingsStore } from './settingsStore';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

interface StorageMock {
  writeJson: jest.Mock;
  readJson: jest.Mock;
}

/** A fresh store per test (hydration is module state). */
function load(saved: unknown): { store: typeof UseSettingsStore; storage: StorageMock } {
  let loaded!: { store: typeof UseSettingsStore; storage: StorageMock };
  jest.isolateModules(() => {
    loaded = {
      storage: jest.requireMock<StorageMock>('@data/storage'),
      store:
        jest.requireActual<typeof import('./settingsStore')>('./settingsStore').useSettingsStore,
    };
  });
  loaded.storage.readJson.mockResolvedValueOnce(JSON.parse(JSON.stringify(saved)));
  loaded.storage.writeJson.mockClear();
  return loaded;
}

/** The last settings.json the store wrote. */
function lastWrite(storage: StorageMock): Record<string, unknown> {
  const call = storage.writeJson.mock.calls.at(-1) as [string, Record<string, unknown>];
  return call[1];
}

it('a file from before any extension: nothing installed', async () => {
  const { store } = load(beforeExtensions);
  await store.getState().hydrate();
  expect(store.getState().extensions).toEqual({
    geodetic: { installedAt: 0, show: true, offline: true },
    tides: { installedAt: 0, show: true, offline: false },
    gnss: { installedAt: 0, show: true, offline: false },
  });
  // The rest of the file is untouched by the migration.
  expect(store.getState().themeMode).toBe('dark');
  expect(store.getState().terrainContours).toBe(true);
});

it('geodetic installed with its switches off (3dc166ff): kept', async () => {
  const { store } = load(geodeticOnly);
  await store.getState().hydrate();
  expect(store.getState().extensions.geodetic).toEqual({
    installedAt: 1_759_683_600_000,
    show: false,
    offline: false,
  });
  expect(store.getState().extensions.tides.installedAt).toBe(0);
});

it('both installed (main, 39dd7848): kept, filter and tab too', async () => {
  const { store } = load(mainShaped);
  await store.getState().hydrate();
  const s = store.getState();
  expect(s.extensions).toEqual({
    geodetic: { installedAt: 1_759_683_600_000, show: true, offline: true },
    tides: { installedAt: 1_759_770_000_000, show: false, offline: false },
    gnss: { installedAt: 0, show: true, offline: false },
  });
  expect(s.geodeticFilter.hasHeights).toBe(true);
  expect(s.overlaysTab).toBe('extensions');
});

it('writes `extensions` AND the flat keys, and reads its own file back the same', async () => {
  const { store, storage } = load(mainShaped);
  await store.getState().hydrate();
  store.getState().set('units', 'imperial');
  const written = lastWrite(storage);
  expect(written.extensions).toEqual(store.getState().extensions);
  expect(written).toMatchObject({
    geodeticInstalledAt: 1_759_683_600_000,
    showGeodetic: true,
    geodeticOffline: true,
    tidesInstalledAt: 1_759_770_000_000,
    showTideStations: false,
  });

  const again = load(written);
  await again.store.getState().hydrate();
  expect(again.store.getState().extensions).toEqual(store.getState().extensions);
});
