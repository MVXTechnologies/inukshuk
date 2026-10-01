// #476 — long-press › "Hide for an hour" stores a wall-clock timestamp that
// must survive a relaunch (the hour runs whether or not the app is open), and
// it never touches the Settings switch.
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

beforeAll(async () => {
  await useSettingsStore.getState().hydrate();
});

afterEach(() => {
  useSettingsStore.getState().reset();
  storage.readJson.mockResolvedValue(null);
});

it('defaults to not hidden', () => {
  expect(useSettingsStore.getState().tipJarHiddenUntil).toBe(0);
});

it('writes the hide time to the settings file', async () => {
  useSettingsStore.getState().set('tipJarHiddenUntil', 1_234_567);
  await Promise.resolve();
  const written = storage.writeJson.mock.calls.at(-1)?.[1] as Record<string, unknown>;
  expect(written.tipJarHiddenUntil).toBe(1_234_567);
  expect(written.showTipJar).toBe(true);
});

it('survives a relaunch, and drops junk', async () => {
  storage.readJson.mockResolvedValue({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    tipJarHiddenUntil: 9_000_000,
  });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().tipJarHiddenUntil).toBe(9_000_000);

  storage.readJson.mockResolvedValue({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    tipJarHiddenUntil: 'soon',
  });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().tipJarHiddenUntil).toBe(0);
});
