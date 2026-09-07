// src/state/settingsStore.hillshade.test.ts
//
// #230 — the shaded-relief switch and its TEMPORARY per-platform default.
// iOS opens with the under-map hillshade off (the reported zoom-out stutter is
// unmeasured on a device); Android keeps it on. The switch itself persists like
// any other setting, so a decision the owner makes on the phone survives a
// relaunch — which is what makes the 60-second A/B in
// `docs/plans/ios-hillshade-230.md` possible at all.
import { useSettingsStore } from './settingsStore';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

const storage = jest.requireMock('@data/storage') as {
  writeJson: jest.Mock;
  readJson: jest.Mock;
};

afterEach(() => {
  useSettingsStore.getState().reset();
  storage.readJson.mockResolvedValue(null);
});

/**
 * Re-import the store against a mocked `Platform.OS`. The module is only ever
 * asked for `Platform`, so a bare stub is a complete mock of what it uses.
 */
function defaultFor(os: 'ios' | 'android'): boolean {
  let value = false;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: os } }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./settingsStore') as typeof import('./settingsStore');
    expect(mod.DEFAULT_SHOW_HILLSHADE).toBe(mod.useSettingsStore.getState().showHillshade);
    value = mod.DEFAULT_SHOW_HILLSHADE;
  });
  return value;
}

it('defaults the hillshade OFF on iOS and ON on Android', () => {
  expect(defaultFor('ios')).toBe(false);
  expect(defaultFor('android')).toBe(true);
});

it('resolves the running platform default into the live store', () => {
  const { Platform } = jest.requireActual('react-native') as { Platform: { OS: string } };
  expect(useSettingsStore.getState().showHillshade).toBe(Platform.OS !== 'ios');
});

it('set("showHillshade") persists like showScaleBar', () => {
  const before = useSettingsStore.getState().showHillshade;
  useSettingsStore.getState().set('showHillshade', !before);
  expect(useSettingsStore.getState().showHillshade).toBe(!before);
  expect(storage.writeJson).toHaveBeenLastCalledWith(
    'settings.json',
    expect.objectContaining({ showHillshade: !before }),
  );
});

it('hydrates a persisted value over the platform default', async () => {
  const flipped = !useSettingsStore.getState().showHillshade;
  storage.readJson.mockResolvedValue({ schemaVersion: 2, showHillshade: flipped });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().showHillshade).toBe(flipped);
});

it('falls back to the platform default for a settings file written before #230', async () => {
  const platformDefault = useSettingsStore.getState().showHillshade;
  storage.readJson.mockResolvedValue({ schemaVersion: 2, showScaleBar: true });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().showHillshade).toBe(platformDefault);
});

it('reset restores the platform default', () => {
  const platformDefault = useSettingsStore.getState().showHillshade;
  useSettingsStore.getState().set('showHillshade', !platformDefault);
  useSettingsStore.getState().reset();
  expect(useSettingsStore.getState().showHillshade).toBe(platformDefault);
});
