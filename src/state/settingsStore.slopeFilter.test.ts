import { DEFAULT_SLOPE_FILTER } from '@core/map/slopeSettings';
import * as storage from '@data/storage';
import { useSettingsStore } from './settingsStore';

// #723 — the slope layer's aspect sectors and altitude bounds, one settings key.
let mockSaved: unknown = null;
jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: async () => mockSaved,
}));

it('starts with no filter: all 8 aspects, no altitude bounds', () => {
  expect(useSettingsStore.getState().terrainSlopeFilter).toEqual({
    aspectMask: 0xff,
    minAltM: null,
    maxAltM: null,
  });
});

it('a file from before the key hydrates to the default, the slope window untouched', async () => {
  mockSaved = { schemaVersion: 2, terrainSlope: true, terrainSlopeMinDeg: 30 };
  await useSettingsStore.getState().hydrate();
  const s = useSettingsStore.getState();
  expect(s.terrainSlopeFilter).toEqual(DEFAULT_SLOPE_FILTER);
  expect(s.terrainSlopeMinDeg).toBe(30);
  expect(s.terrainSlopeMaxDeg).toBe(90);
});

it('keeps it across a restart (metres; null = no limit), repairing bad fields', async () => {
  mockSaved = {
    schemaVersion: 2,
    terrainSlopeFilter: { aspectMask: 0b10000011, minAltM: 800, maxAltM: null },
  };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().terrainSlopeFilter).toEqual({
    aspectMask: 0b10000011,
    minAltM: 800,
    maxAltM: null,
  });
  mockSaved = {
    schemaVersion: 2,
    terrainSlopeFilter: { aspectMask: 'NW', minAltM: 800, maxAltM: 1e9 },
  };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().terrainSlopeFilter).toEqual({
    aspectMask: 0xff,
    minAltM: 800,
    maxAltM: null,
  });
  mockSaved = { schemaVersion: 2, terrainSlopeFilter: 'on' };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().terrainSlopeFilter).toEqual(DEFAULT_SLOPE_FILTER);
});

it('is written with the rest of the settings', async () => {
  mockSaved = { schemaVersion: 2 };
  await useSettingsStore.getState().hydrate();
  const next = { aspectMask: 1, minAltM: null, maxAltM: 1150 };
  useSettingsStore.getState().set('terrainSlopeFilter', next);
  const written = (storage.writeJson as jest.Mock).mock.calls.at(-1)?.[1] as {
    terrainSlopeFilter?: unknown;
  };
  expect(written.terrainSlopeFilter).toEqual(next);
});
