// "Parks & protected areas": a persisted overlay switch added after 2.1.0.
// Settings files written before it existed carry no `showParks` key and must
// hydrate to the default (on) — the migration is the ladder's "missing key →
// default" rule, so no schema bump — and a choice must survive a relaunch.
import { migrateSettings, SETTINGS_SCHEMA_VERSION } from '@core/library/migrations';
import { useSettingsStore } from './settingsStore';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

const storage = jest.requireMock('@data/storage') as {
  writeJson: jest.Mock;
  readJson: jest.Mock;
};

// Writes are held until settings.json has been read (see
// settingsStore.hydration.test.ts); these cases are about a loaded store.
beforeAll(async () => {
  await useSettingsStore.getState().hydrate();
});

afterEach(() => {
  useSettingsStore.getState().reset();
  storage.readJson.mockResolvedValue(null);
});

it('defaults on', () => {
  expect(useSettingsStore.getState().showParks).toBe(true);
});

it('migrates a 2.1.0 settings file (no such key) to on, keeping its other choices', async () => {
  useSettingsStore.getState().set('showParks', false);
  storage.readJson.mockResolvedValue({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    satelliteLabels: false,
    peakDensity: 'more',
  });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().showParks).toBe(true);
  expect(useSettingsStore.getState().satelliteLabels).toBe(false);
  expect(useSettingsStore.getState().peakDensity).toBe('more');
});

it('migrates every older schema version the same way', () => {
  const defaults = { showParks: true, showHeatmap: true };
  for (const schemaVersion of [undefined, 1, 2, SETTINGS_SCHEMA_VERSION]) {
    const old = { ...(schemaVersion === undefined ? {} : { schemaVersion }), showHeatmap: false };
    expect(migrateSettings(old, defaults)).toEqual({ showParks: true, showHeatmap: false });
  }
});

it('persists a saved choice across a relaunch, and drops junk', async () => {
  storage.readJson.mockResolvedValue({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    showParks: false,
  });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().showParks).toBe(false);

  storage.readJson.mockResolvedValue({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    showParks: 'no',
  });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().showParks).toBe(true);
});

it('set("showParks") writes the file', async () => {
  await useSettingsStore.getState().hydrate();
  storage.writeJson.mockClear();
  useSettingsStore.getState().set('showParks', false);
  expect(storage.writeJson).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ showParks: false }),
  );
});
