// src/state/settingsStore.pinScale.test.ts
//
// #686: Settings › Display › Pin size, persisted and normalised.
import { useSettingsStore } from './settingsStore';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));

const storage = jest.requireMock('@data/storage') as {
  writeJson: jest.Mock;
  readJson: jest.Mock;
};

beforeAll(async () => {
  await useSettingsStore.getState().hydrate();
});

afterEach(() => {
  useSettingsStore.getState().reset();
  storage.readJson.mockResolvedValue(null);
});

it('defaults to 100 %', () => {
  expect(useSettingsStore.getState().pinScale).toBe(100);
});

it('set("pinScale") persists', () => {
  useSettingsStore.getState().set('pinScale', 150);
  expect(storage.writeJson).toHaveBeenCalledWith(
    'settings.json',
    expect.objectContaining({ pinScale: 150 }),
  );
});

it('hydrates a persisted step', async () => {
  storage.readJson.mockResolvedValue({ pinScale: 75 });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().pinScale).toBe(75);
});

it.each([[110], [0], [-125], [1.5], ['125'], [null], [{}]])(
  'normalises a junk persisted value (%p) to 100 %%',
  async (junk) => {
    storage.readJson.mockResolvedValue({ pinScale: junk });
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().pinScale).toBe(100);
  },
);

it('a file from before #686 keeps the default', async () => {
  storage.readJson.mockResolvedValue({ units: 'imperial' });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().pinScale).toBe(100);
});
