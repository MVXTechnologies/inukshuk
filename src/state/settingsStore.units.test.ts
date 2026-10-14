// src/state/settingsStore.units.test.ts
import { IMPERIAL, METRIC, NAUTICAL } from '@core/format';
import { SETTINGS_SCHEMA_VERSION } from '@core/library/migrations';
import { formatDistance, formatSpeed } from '@state/formatters';
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

it('defaults units to the device default (pinned to metric under Jest)', () => {
  expect(useSettingsStore.getState().units).toEqual(METRIC);
  expect(formatDistance(1609.344)).toBe('1.61 km');
});

it('set("units") switches the formatters and persists the object', () => {
  useSettingsStore.getState().set('units', IMPERIAL);
  expect(useSettingsStore.getState().units).toEqual(IMPERIAL);
  expect(formatDistance(1609.344)).toBe('1.00 mi');
  expect(storage.writeJson).toHaveBeenCalledWith(
    'settings.json',
    expect.objectContaining({ units: { distance: 'mi', elevation: 'ft' } }),
  );
});

it('distance and elevation are independent (#702)', () => {
  useSettingsStore.getState().set('units', NAUTICAL);
  expect(formatDistance(3704)).toBe('2.00 NM');
  expect(formatSpeed(1852 / 3600)).toBe('1.0 kn');
  // NM short distances follow the elevation unit.
  expect(formatDistance(100)).toBe('100 m');
  useSettingsStore.getState().set('units', { distance: 'nmi', elevation: 'ft' });
  expect(formatDistance(100)).toBe('328 ft');
});

it('hydrate applies persisted units to the formatters', async () => {
  storage.readJson.mockResolvedValue({ units: { distance: 'mi', elevation: 'ft' } });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().units).toEqual(IMPERIAL);
  expect(formatDistance(100)).toBe('328 ft');
});

it.each([
  ['imperial', IMPERIAL],
  ['metric', METRIC],
])('migrates a pre-2.6.1 %s switch', async (legacy, expected) => {
  storage.readJson.mockResolvedValue({ schemaVersion: SETTINGS_SCHEMA_VERSION, units: legacy });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().units).toEqual(expected);
});

it.each([
  ['junk string', 'furlongs'],
  ['half an object', { distance: 'mi' }],
  ['unknown unit', { distance: 'league', elevation: 'm' }],
  ['null', null],
])('falls back to the device default for %s', async (_label, raw) => {
  useSettingsStore.getState().set('units', IMPERIAL);
  storage.readJson.mockResolvedValue({ schemaVersion: SETTINGS_SCHEMA_VERSION, units: raw });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().units).toEqual(METRIC);
});

it('hydrates a legacy unversioned file (junk dropped) and writes back versioned', async () => {
  storage.readJson.mockResolvedValue({ units: 'imperial', junkField: 'dropped' });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().units).toEqual(IMPERIAL);
  expect(useSettingsStore.getState()).not.toHaveProperty('junkField');
  useSettingsStore.getState().set('units', METRIC);
  expect(storage.writeJson).toHaveBeenLastCalledWith(
    'settings.json',
    expect.objectContaining({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      units: { distance: 'km', elevation: 'm' },
    }),
  );
});

it('reset restores metric formatting', () => {
  useSettingsStore.getState().set('units', IMPERIAL);
  useSettingsStore.getState().reset();
  expect(useSettingsStore.getState().units).toEqual(METRIC);
  expect(formatDistance(100)).toBe('100 m');
});
