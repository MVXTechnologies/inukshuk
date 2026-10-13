import { useSettingsStore } from './settingsStore';

// #675 — the editor's favourite and recent icons live in settings.
let mockSaved: unknown = null;
jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: async () => mockSaved,
}));

it('starts with no favourites and no recents', () => {
  expect(useSettingsStore.getState().waypointIcons).toEqual({ favorites: [], recents: [] });
});

it('keeps them across a restart', async () => {
  mockSaved = {
    schemaVersion: 2,
    waypointIcons: { favorites: ['campfire', 'water'], recents: ['bike'] },
  };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().waypointIcons).toEqual({
    favorites: ['campfire', 'water'],
    recents: ['bike'],
  });
});

it('drops junk: unknown ids, wrong types, a non-object', async () => {
  mockSaved = {
    schemaVersion: 2,
    waypointIcons: { favorites: ['from-the-future', 'camp', 3], recents: 'x' },
  };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().waypointIcons).toEqual({ favorites: ['camp'], recents: [] });
  mockSaved = { schemaVersion: 2, waypointIcons: 'nope' };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().waypointIcons).toEqual({ favorites: [], recents: [] });
});
