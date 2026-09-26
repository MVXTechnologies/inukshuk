// src/state/settingsStore.hydration.test.ts — writes that land before
// settings.json has been read must never overwrite it with DEFAULTS.
import type { useSettingsStore as UseSettingsStore } from './settingsStore';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

interface StorageMock {
  writeJson: jest.Mock;
  readJson: jest.Mock;
}

/**
 * A fresh store per test: the pending-write set and the in-flight hydration
 * are module state, and each case needs its own "before settings.json was
 * read" moment.
 */
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

/** A read of settings.json that stays open until the test says so. */
function heldRead(storage: StorageMock): (saved: unknown) => void {
  let release: (saved: unknown) => void = () => {};
  storage.readJson.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  return (saved) => release(saved);
}

/** What a user who opted out of error reports has on disk. */
const ON_DISK = { schemaVersion: 2, errorReporting: false, units: 'imperial', showHeatmap: false };

it('an early set writes nothing, and cannot reset the saved settings — opt-out included', async () => {
  const { store, storage } = load();
  const release = heldRead(storage);
  const hydrating = store.getState().hydrate();

  // A toggle flipped while the file is still being read.
  store.getState().set('themeMode', 'dark');
  expect(store.getState().themeMode).toBe('dark');
  expect(storage.writeJson).not.toHaveBeenCalled();

  release(ON_DISK);
  await hydrating;

  const state = store.getState();
  expect(state.errorReporting).toBe(false);
  expect(state.units).toBe('imperial');
  expect(state.showHeatmap).toBe(false);
  expect(state.themeMode).toBe('dark');
  // One write, of the merged settings: the saved values plus the new one.
  expect(storage.writeJson).toHaveBeenCalledTimes(1);
  expect(storage.writeJson).toHaveBeenCalledWith(
    'settings.json',
    expect.objectContaining({ errorReporting: false, units: 'imperial', themeMode: 'dark' }),
  );
});

it('holds early writes made before hydrate() is even called', async () => {
  const { store, storage } = load();
  store.getState().set('units', 'metric'); // the default: no change, nothing to hold
  store.getState().set('librarySortKey', 'distance');
  expect(storage.writeJson).not.toHaveBeenCalled();

  storage.readJson.mockResolvedValueOnce(ON_DISK);
  await store.getState().hydrate();

  expect(store.getState().librarySortKey).toBe('distance');
  expect(store.getState().units).toBe('imperial');
  expect(store.getState().errorReporting).toBe(false);
});

it('lets the user opt out before hydration, and keeps that choice', async () => {
  const { store, storage } = load();
  store.getState().set('errorReporting', false);
  storage.readJson.mockResolvedValueOnce({ schemaVersion: 2, errorReporting: true });
  await store.getState().hydrate();

  expect(store.getState().errorReporting).toBe(false);
  expect(storage.writeJson).toHaveBeenLastCalledWith(
    'settings.json',
    expect.objectContaining({ errorReporting: false }),
  );
});

it('keeps early writes in memory and off disk while hydration fails, then lands them', async () => {
  const { store, storage } = load();
  store.getState().set('themeMode', 'light');
  storage.readJson.mockRejectedValueOnce(new Error('EIO'));
  await expect(store.getState().hydrate()).rejects.toThrow('EIO');

  expect(store.getState().hydrated).toBe(false);
  store.getState().set('units', 'imperial');
  expect(storage.writeJson).not.toHaveBeenCalled();

  // The foreground retry.
  storage.readJson.mockResolvedValueOnce({ schemaVersion: 2, errorReporting: false });
  await store.getState().hydrate();
  expect(store.getState()).toMatchObject({
    themeMode: 'light',
    units: 'imperial',
    errorReporting: false,
  });
  expect(storage.writeJson).toHaveBeenCalledTimes(1);
});

it('a reset before hydration writes nothing until the file is read', async () => {
  const { store, storage } = load();
  store.getState().reset();
  expect(storage.writeJson).not.toHaveBeenCalled();

  storage.readJson.mockResolvedValueOnce(ON_DISK);
  await store.getState().hydrate();
  // The user asked for defaults; they get them, written once.
  expect(store.getState().units).toBe('metric');
  expect(storage.writeJson).toHaveBeenCalledTimes(1);
});

it('reads settings.json once for concurrent hydrate() calls', async () => {
  const { store, storage } = load();
  const release = heldRead(storage);
  const launch = store.getState().hydrate();
  const foregroundRetry = store.getState().hydrate();
  expect(storage.readJson).toHaveBeenCalledTimes(1);

  release(ON_DISK);
  await Promise.all([launch, foregroundRetry]);
  expect(store.getState().units).toBe('imperial');
});

it('writes straight through once hydrated, as before', async () => {
  const { store, storage } = load();
  await store.getState().hydrate();
  expect(storage.writeJson).not.toHaveBeenCalled(); // nothing was pending

  store.getState().set('units', 'imperial');
  expect(storage.writeJson).toHaveBeenCalledTimes(1);
});
