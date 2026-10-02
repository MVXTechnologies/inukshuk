// src/state/settingsStore.pdfWhiteKey.test.ts — "See-through white" for PDF
// maps: a 5-stop slider (0 = Off … 4 = 100 %). Defaults to Off (no change for
// anyone until they pick a level), persists, migrates the first cut's named
// levels onto the slider, and hydrates junk or pre-feature files back to Off.
import { useSettingsStore } from './settingsStore';

let mockSaved: unknown = null;
const mockWriteJson = jest.fn();
jest.mock('@data/storage', () => ({
  writeJson: (...args: unknown[]) => mockWriteJson(...args),
  readJson: async () => mockSaved,
}));

beforeAll(async () => {
  await useSettingsStore.getState().hydrate();
});

beforeEach(() => {
  mockSaved = null;
  useSettingsStore.getState().reset();
  mockWriteJson.mockClear();
});

it('defaults to Off (stop 0)', () => {
  expect(useSettingsStore.getState().pdfWhiteKey).toBe(0);
});

it('persists a chosen stop and reads it back', async () => {
  useSettingsStore.getState().set('pdfWhiteKey', 4);
  expect(mockWriteJson).toHaveBeenLastCalledWith(
    'settings.json',
    expect.objectContaining({ pdfWhiteKey: 4 }),
  );

  for (const level of [0, 1, 2, 3, 4]) {
    mockSaved = { schemaVersion: 3, pdfWhiteKey: level };
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().pdfWhiteKey).toBe(level);
  }
});

it.each([
  ['off', 0],
  ['some', 2],
  ['full', 4],
])('migrates the saved named level %s to stop %d', async (named, stop) => {
  mockSaved = { schemaVersion: 3, pdfWhiteKey: named };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().pdfWhiteKey).toBe(stop);
});

it('hydrates a file written before the setting existed to Off', async () => {
  mockSaved = { schemaVersion: 3, showPdfOverlay: false };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().pdfWhiteKey).toBe(0);
});

it('drops an unknown level back to Off', async () => {
  for (const junk of ['half', 5, -1, 2.5, null]) {
    useSettingsStore.getState().set('pdfWhiteKey', 3);
    mockSaved = { schemaVersion: 3, pdfWhiteKey: junk };
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().pdfWhiteKey).toBe(0);
  }
});

it('migrates a legacy unversioned file without the key', async () => {
  mockSaved = { units: 'imperial' };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().pdfWhiteKey).toBe(0);
  expect(useSettingsStore.getState().units).toBe('imperial');
});
