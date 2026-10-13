// src/state/settingsStore.coordinates.test.ts
//
// #677: the app-wide coordinate format and the centre cursor switch.
import { useSettingsStore } from './settingsStore';
import { formatCoordinateNow } from './useCoordinateFormatter';

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

it('defaults to decimal degrees, with the centre cursor on', () => {
  expect(useSettingsStore.getState().coordinateFormat).toBe('dd');
  expect(useSettingsStore.getState().showCenterCursor).toBe(true);
  expect(formatCoordinateNow(46.81394, -71.20761)).toBe('46.81394, -71.20761');
});

it('set("coordinateFormat") switches the formatter and persists', () => {
  useSettingsStore.getState().set('coordinateFormat', 'utm');
  expect(formatCoordinateNow(46.81394, -71.20761)).toBe('19T 331586 5186854');
  expect(storage.writeJson).toHaveBeenCalledWith(
    'settings.json',
    expect.objectContaining({ coordinateFormat: 'utm' }),
  );
});

it('set("showCenterCursor") persists', () => {
  useSettingsStore.getState().set('showCenterCursor', false);
  expect(storage.writeJson).toHaveBeenCalledWith(
    'settings.json',
    expect.objectContaining({ showCenterCursor: false }),
  );
});

it('hydrates a persisted format and switch', async () => {
  storage.readJson.mockResolvedValue({ coordinateFormat: 'mgrs', showCenterCursor: false });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().coordinateFormat).toBe('mgrs');
  expect(useSettingsStore.getState().showCenterCursor).toBe(false);
});

it.each([['MGRS'], ['geohash'], ['']])(
  'falls back to decimal degrees for an unknown persisted format (%p)',
  async (junk) => {
    storage.readJson.mockResolvedValue({ coordinateFormat: junk });
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().coordinateFormat).toBe('dd');
  },
);

it('a file from before #677 keeps the defaults', async () => {
  storage.readJson.mockResolvedValue({ units: 'imperial' });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().coordinateFormat).toBe('dd');
  expect(useSettingsStore.getState().showCenterCursor).toBe(true);
});
