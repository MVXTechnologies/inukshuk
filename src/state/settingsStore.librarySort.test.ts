// src/state/settingsStore.librarySort.test.ts
import { useSettingsStore } from './settingsStore';

// One shared fake settings.json: each test writes what hydration should read.
// `mock`-prefixed so jest's module factory may close over it.
let mockSaved: unknown = null;
jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: async () => mockSaved,
}));

beforeEach(() => {
  mockSaved = null;
  useSettingsStore.getState().reset();
});

it('defaults the Library sort to the order the list has always had', () => {
  expect(useSettingsStore.getState().librarySortKey).toBe('recent');
});

it('persists a chosen sort so it survives a restart', async () => {
  useSettingsStore.getState().set('librarySortKey', 'distance');
  expect(useSettingsStore.getState().librarySortKey).toBe('distance');

  mockSaved = { schemaVersion: 2, librarySortKey: 'distance' };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().librarySortKey).toBe('distance');
});

it('falls back to the default for a retired or junk persisted key', async () => {
  // migrateSettings only type-checks against the default, so any string —
  // a key a later build removed, or hand-edited junk — reaches the store.
  mockSaved = { schemaVersion: 2, librarySortKey: 'longest-ever' };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().librarySortKey).toBe('recent');

  mockSaved = { schemaVersion: 2, librarySortKey: 42 };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().librarySortKey).toBe('recent');
});
