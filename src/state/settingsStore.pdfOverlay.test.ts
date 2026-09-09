// src/state/settingsStore.pdfOverlay.test.ts — the "PDF maps" master switch
// (#233): it must persist, because "I hid the sheets" has to survive a restart
// — the whole reason it moved out of the in-memory map store.
import { useSettingsStore } from './settingsStore';

let mockSaved: unknown = null;
const mockWriteJson = jest.fn();
jest.mock('@data/storage', () => ({
  writeJson: (...args: unknown[]) => mockWriteJson(...args),
  readJson: async () => mockSaved,
}));

beforeEach(() => {
  mockSaved = null;
  useSettingsStore.getState().reset();
  mockWriteJson.mockClear();
});

it('defaults to drawing PDF maps', () => {
  expect(useSettingsStore.getState().showPdfOverlay).toBe(true);
});

it('persists the switch so a hidden-maps choice survives a restart', async () => {
  useSettingsStore.getState().set('showPdfOverlay', false);
  expect(useSettingsStore.getState().showPdfOverlay).toBe(false);
  expect(mockWriteJson).toHaveBeenLastCalledWith(
    'settings.json',
    expect.objectContaining({ showPdfOverlay: false }),
  );

  mockSaved = { schemaVersion: 2, showPdfOverlay: false };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().showPdfOverlay).toBe(false);
});

it('hydrates a settings file written before the switch existed to ON', async () => {
  mockSaved = { schemaVersion: 2, showHeatmap: false };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().showPdfOverlay).toBe(true);

  // Wrong-typed junk falls back too — never a map that can't be un-hidden.
  mockSaved = { schemaVersion: 2, showPdfOverlay: 'no' };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().showPdfOverlay).toBe(true);
});
