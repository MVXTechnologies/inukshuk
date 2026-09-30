// #484 — "Labels on satellite": a new persisted overlay switch. Files written
// before it existed must hydrate to the default (on), and a choice must
// survive a relaunch like any other switch.
import { SETTINGS_SCHEMA_VERSION } from '@core/library/migrations';
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
  expect(useSettingsStore.getState().satelliteLabels).toBe(true);
});

it('hydrates an older settings file without the key to the default', async () => {
  useSettingsStore.getState().set('satelliteLabels', false);
  storage.readJson.mockResolvedValue({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    showHeatmap: false,
  });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().satelliteLabels).toBe(true);
  expect(useSettingsStore.getState().showHeatmap).toBe(false);
});

it('persists a saved choice across a relaunch, and drops junk', async () => {
  storage.readJson.mockResolvedValue({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    satelliteLabels: false,
  });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().satelliteLabels).toBe(false);

  storage.readJson.mockResolvedValue({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    satelliteLabels: 'yes',
  });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().satelliteLabels).toBe(true);
});

it('set("satelliteLabels") writes the file', async () => {
  await useSettingsStore.getState().hydrate();
  storage.writeJson.mockClear();
  useSettingsStore.getState().set('satelliteLabels', false);
  expect(storage.writeJson).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ satelliteLabels: false }),
  );
});
