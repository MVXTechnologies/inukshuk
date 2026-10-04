// Beta "3D terrain": a persisted toggle added with the native 3D terrain.
// Settings files written before it existed carry no `betaTerrain3d` key and
// must hydrate to OFF (the ladder's "missing key → default" rule), junk must
// fall back to OFF, and a choice must survive a relaunch.
import { SETTINGS_SCHEMA_VERSION } from '@core/library/migrations';
import { BETA_FEATURES } from '@core/settings/betaFeatures';
import { useSettingsStore } from './settingsStore';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

const storage = jest.requireMock('@data/storage') as {
  writeJson: jest.Mock;
  readJson: jest.Mock;
};

beforeAll(async () => {
  await useSettingsStore.getState().hydrate();
});

afterEach(() => {
  useSettingsStore.getState().reset();
  storage.readJson.mockResolvedValue(null);
});

it('defaults off', () => {
  expect(useSettingsStore.getState().betaTerrain3d).toBe(false);
});

it('every registered beta is a boolean setting that defaults off', () => {
  const s = useSettingsStore.getState() as unknown as Record<string, unknown>;
  for (const f of BETA_FEATURES) expect(s[f.key]).toBe(false);
});

it('migrates an older settings file (no such key) to off, keeping other choices', async () => {
  storage.readJson.mockResolvedValue({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    tiltRelief: 'dramatic',
  });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().betaTerrain3d).toBe(false);
  expect(useSettingsStore.getState().tiltRelief).toBe('dramatic');
});

it('persists a choice across a relaunch, and drops junk', async () => {
  storage.readJson.mockResolvedValue({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    betaTerrain3d: true,
  });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().betaTerrain3d).toBe(true);

  storage.readJson.mockResolvedValue({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    betaTerrain3d: 'yes',
  });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().betaTerrain3d).toBe(false);
});

it('set("betaTerrain3d") writes the file', async () => {
  await useSettingsStore.getState().hydrate();
  storage.writeJson.mockClear();
  useSettingsStore.getState().set('betaTerrain3d', true);
  expect(storage.writeJson).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ betaTerrain3d: true }),
  );
});
