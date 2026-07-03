// src/state/settingsStore.units.test.ts
import { formatDistance } from '@lib/format';
import { useSettingsStore } from './settingsStore';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

const storage = jest.requireMock('@data/storage') as {
  writeJson: jest.Mock;
  readJson: jest.Mock;
};

afterEach(() => {
  useSettingsStore.getState().reset();
  storage.readJson.mockResolvedValue(null);
});

it('defaults units to metric', () => {
  expect(useSettingsStore.getState().units).toBe('metric');
  expect(formatDistance(1609.344)).toBe('1.61 km');
});

it('set("units") switches the formatters and persists', () => {
  useSettingsStore.getState().set('units', 'imperial');
  expect(useSettingsStore.getState().units).toBe('imperial');
  expect(formatDistance(1609.344)).toBe('1.00 mi');
  expect(storage.writeJson).toHaveBeenCalledWith(
    'settings.json',
    expect.objectContaining({ units: 'imperial' }),
  );
});

it('hydrate applies persisted units to the formatters', async () => {
  storage.readJson.mockResolvedValue({ units: 'imperial' });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().units).toBe('imperial');
  expect(formatDistance(100)).toBe('328 ft');
});

it('reset restores metric formatting', () => {
  useSettingsStore.getState().set('units', 'imperial');
  useSettingsStore.getState().reset();
  expect(useSettingsStore.getState().units).toBe('metric');
  expect(formatDistance(100)).toBe('100 m');
});
