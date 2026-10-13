// #682: "Show phone navigation buttons" (Android). Off by default, so nothing
// changes for current users; files from before it hydrate to off, a saved
// choice survives a relaunch, and junk falls back to off.
import { SETTINGS_SCHEMA_VERSION } from '@core/library/migrations';
import { selectShowNavigationBar, useSettingsStore } from './settingsStore';

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
  expect(useSettingsStore.getState().showNavigationButtons).toBe(false);
});

it('hydrates a file from before the setting (no key) to off, keeping its other choices', async () => {
  storage.readJson.mockResolvedValue({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    compactMapChrome: true,
  });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().showNavigationButtons).toBe(false);
  expect(useSettingsStore.getState().compactMapChrome).toBe(true);
});

it('keeps a saved "on" across a relaunch', async () => {
  storage.readJson.mockResolvedValue({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    showNavigationButtons: true,
  });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().showNavigationButtons).toBe(true);
});

it.each([['yes'], [1], [null], [{}], [['true']]])('normalises junk %p to off', async (junk) => {
  storage.readJson.mockResolvedValue({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    showNavigationButtons: junk,
  });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().showNavigationButtons).toBe(false);
});

it('set("showNavigationButtons") writes the file', () => {
  storage.writeJson.mockClear();
  useSettingsStore.getState().set('showNavigationButtons', true);
  expect(storage.writeJson).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ showNavigationButtons: true }),
  );
});

describe('selectShowNavigationBar', () => {
  const state = useSettingsStore.getState();

  it('is false until settings have hydrated, whatever the value', () => {
    expect(
      selectShowNavigationBar({ ...state, hydrated: false, showNavigationButtons: true }),
    ).toBe(false);
  });

  it('follows the setting once hydrated', () => {
    expect(selectShowNavigationBar({ ...state, hydrated: true, showNavigationButtons: true })).toBe(
      true,
    );
    expect(
      selectShowNavigationBar({ ...state, hydrated: true, showNavigationButtons: false }),
    ).toBe(false);
  });
});
