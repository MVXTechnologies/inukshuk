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

it('defaults to 1 (Default)', () => {
  expect(useSettingsStore.getState().displayScale).toBe(1);
});

it('set("displayScale") persists', () => {
  useSettingsStore.getState().set('displayScale', 0.85);
  expect(storage.writeJson).toHaveBeenCalledWith(
    'settings.json',
    expect.objectContaining({ displayScale: 0.85 }),
  );
});

it('hydrates a persisted step', async () => {
  storage.readJson.mockResolvedValue({ displayScale: 1.15 });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().displayScale).toBe(1.15);
});

it.each([[100], [85], [0.9], [1.1], [0], [-1], ['0.85'], [null], [{}]])(
  'reads a junk or older persisted value (%p) as 1',
  async (junk) => {
    storage.readJson.mockResolvedValue({ displayScale: junk });
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().displayScale).toBe(1);
  },
);

it.each([0.85, 1.15] as const)('round-trips %p through the file', async (v) => {
  useSettingsStore.getState().set('displayScale', v);
  const written = storage.writeJson.mock.calls.at(-1)?.[1] as { displayScale: number };
  expect(written.displayScale).toBe(v);
  useSettingsStore.getState().reset();
  storage.readJson.mockResolvedValue(written);
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().displayScale).toBe(v);
});

it('a file from before #760 keeps the default', async () => {
  storage.readJson.mockResolvedValue({ units: 'imperial' });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().displayScale).toBe(1);
});
