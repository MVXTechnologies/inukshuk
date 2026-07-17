// src/state/settingsStore.lastPosition.test.ts — persisted last known map
// position: the cold-start camera seed (see @core/geo/lastKnownPosition).
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

it('defaults to null (never saved)', () => {
  expect(useSettingsStore.getState().lastKnownPosition).toBeNull();
});

it('hydrates to null from an old settings.json without the field', async () => {
  storage.readJson.mockResolvedValue({ schemaVersion: 2, units: 'imperial' });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().lastKnownPosition).toBeNull();
  expect(useSettingsStore.getState().units).toBe('imperial');
});

it('hydrates to null from a legacy unversioned settings.json', async () => {
  storage.readJson.mockResolvedValue({ units: 'metric' });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().lastKnownPosition).toBeNull();
});

it('hydrates a valid persisted position, dropping extra fields', async () => {
  storage.readJson.mockResolvedValue({
    schemaVersion: 2,
    lastKnownPosition: { latitude: 46.81, longitude: -71.21, junk: true },
  });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().lastKnownPosition).toEqual({
    latitude: 46.81,
    longitude: -71.21,
  });
});

it.each([
  ['a string', 'null island'],
  ['a number', 7],
  ['an array', [46.81, -71.21]],
  ['an empty object', {}],
  ['string coordinates', { latitude: '46.81', longitude: '-71.21' }],
  ['non-finite coordinates', { latitude: NaN, longitude: Infinity }],
  ['out-of-range coordinates', { latitude: 123.4, longitude: 567.8 }],
])('hydrates junk (%s) to null without crashing', async (_label, junk) => {
  storage.readJson.mockResolvedValue({ schemaVersion: 2, lastKnownPosition: junk });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().lastKnownPosition).toBeNull();
});

it('set() persists the position inside the versioned settings envelope', () => {
  useSettingsStore.getState().set('lastKnownPosition', { latitude: 1.5, longitude: -2.5 });
  expect(useSettingsStore.getState().lastKnownPosition).toEqual({ latitude: 1.5, longitude: -2.5 });
  expect(storage.writeJson).toHaveBeenLastCalledWith(
    'settings.json',
    expect.objectContaining({
      schemaVersion: 2,
      lastKnownPosition: { latitude: 1.5, longitude: -2.5 },
    }),
  );
});

it('a persisted position round-trips through hydrate', async () => {
  useSettingsStore.getState().set('lastKnownPosition', { latitude: 60, longitude: 10 });
  const [, written] = storage.writeJson.mock.calls.at(-1) as [string, unknown];
  storage.readJson.mockResolvedValue(written);
  useSettingsStore.getState().reset();
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().lastKnownPosition).toEqual({ latitude: 60, longitude: 10 });
});
