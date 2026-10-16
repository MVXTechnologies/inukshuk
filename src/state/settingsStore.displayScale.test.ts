// src/state/settingsStore.displayScale.test.ts
//
// #760: Settings › Display › Display size, persisted and normalised.
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
  expect(useSettingsStore.getState().displayScale).toBe(100);
});

it('set("displayScale") persists', () => {
  useSettingsStore.getState().set('displayScale', 60);
  expect(storage.writeJson).toHaveBeenCalledWith(
    'settings.json',
    expect.objectContaining({ displayScale: 60 }),
  );
});

it('hydrates a persisted step', async () => {
  storage.readJson.mockResolvedValue({ displayScale: 130 });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().displayScale).toBe(130);
});

it.each([[105], [0], [-120], [0.8], ['120'], [null], [{}]])(
  'normalises a junk persisted value (%p) to 100 %%',
  async (junk) => {
    storage.readJson.mockResolvedValue({ displayScale: junk });
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().displayScale).toBe(100);
  },
);

it.each([60, 70, 80, 90, 110, 120, 130, 140, 150] as const)(
  'round-trips %p %% through the file',
  async (v) => {
    useSettingsStore.getState().set('displayScale', v);
    const written = storage.writeJson.mock.calls.at(-1)?.[1] as { displayScale: number };
    expect(written.displayScale).toBe(v);
    useSettingsStore.getState().reset();
    storage.readJson.mockResolvedValue(written);
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().displayScale).toBe(v);
  },
);

it('a file from before #760 keeps the default', async () => {
  storage.readJson.mockResolvedValue({ units: 'imperial' });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().displayScale).toBe(100);
});
