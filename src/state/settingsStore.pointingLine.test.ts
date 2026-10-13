import { DEFAULT_POINTING_LINE } from '@core/map/pointingLineSettings';
import * as storage from '@data/storage';
import { useSettingsStore } from './settingsStore';

// #681 — the pointing line's switch and options, one settings key.
let mockSaved: unknown = null;
jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: async () => mockSaved,
}));

it('starts off, with the defaults', () => {
  expect(useSettingsStore.getState().pointingLine).toEqual(DEFAULT_POINTING_LINE);
  expect(useSettingsStore.getState().pointingLine.enabled).toBe(false);
});

it('a file from before the key (or an older build) hydrates to the defaults', async () => {
  mockSaved = { schemaVersion: 2, showParks: false };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().pointingLine).toEqual(DEFAULT_POINTING_LINE);
});

it('keeps it across a restart, repairing bad fields one by one', async () => {
  mockSaved = {
    schemaVersion: 2,
    pointingLine: {
      enabled: true,
      direction: 'fixed',
      fixedBearingDeg: 62,
      length: 'edge',
      color: '#7E57C2',
      width: 'thick', // not a width
      ticks: 'auto',
      labelEvery5th: true,
    },
  };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().pointingLine).toEqual({
    ...DEFAULT_POINTING_LINE,
    enabled: true,
    direction: 'fixed',
    fixedBearingDeg: 62,
    length: 'edge',
    color: '#7E57C2',
    ticks: 'auto',
    labelEvery5th: true,
  });
  mockSaved = { schemaVersion: 2, pointingLine: 'on' };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().pointingLine).toEqual(DEFAULT_POINTING_LINE);
});

it('is written with the rest of the settings', async () => {
  mockSaved = { schemaVersion: 2 };
  await useSettingsStore.getState().hydrate();
  const next = { ...DEFAULT_POINTING_LINE, enabled: true };
  useSettingsStore.getState().set('pointingLine', next);
  const written = (storage.writeJson as jest.Mock).mock.calls.at(-1)?.[1] as {
    pointingLine?: unknown;
  };
  expect(written.pointingLine).toEqual(next);
});
