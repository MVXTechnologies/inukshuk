import { useSettingsStore } from './settingsStore';

// The trail view's remembered tab (#511) survives a restart; junk falls back.
let mockSaved: unknown = null;
jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: async () => mockSaved,
}));

// No reset() between tests: before hydration it marks every key as an early
// write, which hydrate() would then (rightly) keep over the file.

it('opens trails on Overview by default', () => {
  expect(useSettingsStore.getState().trailViewTab).toBe('overview');
});

it('keeps the tab picked across a restart', async () => {
  mockSaved = { schemaVersion: 2, trailViewTab: 'timeline' };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().trailViewTab).toBe('timeline');
});

it('drops a retired or junk tab', async () => {
  mockSaved = { schemaVersion: 2, trailViewTab: 'points' };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().trailViewTab).toBe('overview');
});
