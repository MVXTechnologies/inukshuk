// src/state/settingsStore.trailmode.test.ts
import { useSettingsStore } from './settingsStore';
jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: async () => null }));

it('defaults new installations to the 2D trail viewer', () => {
  expect(useSettingsStore.getState().trailViewMode).toBe('2d');
});
