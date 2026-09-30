// src/state/settingsStore.pdfWhiteKey.test.ts — "See-through white" for PDF
// maps: defaults to Off (no change for anyone until they pick a level),
// persists, and hydrates junk or pre-feature files back to Off.
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

it('defaults to off', () => {
  expect(useSettingsStore.getState().pdfWhiteKey).toBe('off');
});

it('persists a chosen level and reads it back', async () => {
  useSettingsStore.getState().set('pdfWhiteKey', 'full');
  expect(mockWriteJson).toHaveBeenLastCalledWith(
    'settings.json',
    expect.objectContaining({ pdfWhiteKey: 'full' }),
  );

  mockSaved = { schemaVersion: 3, pdfWhiteKey: 'some' };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().pdfWhiteKey).toBe('some');
});

it('hydrates a file written before the setting existed to off', async () => {
  mockSaved = { schemaVersion: 3, showPdfOverlay: false };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().pdfWhiteKey).toBe('off');
});

it('drops an unknown level (a string the ladder would keep) back to off', async () => {
  mockSaved = { schemaVersion: 3, pdfWhiteKey: 'half' };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().pdfWhiteKey).toBe('off');

  mockSaved = { schemaVersion: 3, pdfWhiteKey: 1 };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().pdfWhiteKey).toBe('off');
});

it('migrates a legacy unversioned file without the key', async () => {
  mockSaved = { units: 'imperial' };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().pdfWhiteKey).toBe('off');
  expect(useSettingsStore.getState().units).toBe('imperial');
});
