import { useSettingsStore } from './settingsStore';

// Settings → Photos (#587): defaults, persistence, junk.
let mockSaved: unknown = null;
jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: async () => mockSaved,
}));

it('defaults to the owner-approved answers', () => {
  const s = useSettingsStore.getState();
  expect(s.photosOnMainMap).toBe(true);
  expect(s.photoCirclesAppear).toBe('zoomed');
  expect(s.photoCopySize).toBe('optimized');
  expect(s.includePhotosWhenSharing).toBe(false);
  expect(s.photoPromptAfterSaveShown).toBe(false);
});

it('keeps the choices across a restart', async () => {
  mockSaved = {
    schemaVersion: 2,
    photosOnMainMap: false,
    photoCirclesAppear: 'always',
    photoCopySize: 'full',
    includePhotosWhenSharing: true,
    photoPromptAfterSaveShown: true,
  };
  await useSettingsStore.getState().hydrate();
  const s = useSettingsStore.getState();
  expect(s.photosOnMainMap).toBe(false);
  expect(s.photoCirclesAppear).toBe('always');
  expect(s.photoCopySize).toBe('full');
  expect(s.includePhotosWhenSharing).toBe(true);
  expect(s.photoPromptAfterSaveShown).toBe(true);
});

it('drops junk values', async () => {
  mockSaved = { schemaVersion: 2, photoCirclesAppear: 'sometimes', photoCopySize: 'huge' };
  await useSettingsStore.getState().hydrate();
  const s = useSettingsStore.getState();
  expect(s.photoCirclesAppear).toBe('zoomed');
  expect(s.photoCopySize).toBe('optimized');
});
