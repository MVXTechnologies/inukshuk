// #673: the info strip's settings key, its migration from 2.5.1 and its
// rollback mirror (`showCenterCursor`).
import { applyPreset, DEFAULT_STRIP, presetById } from '@core/infoStrip/presets';
import { INFO_STRIP_SCHEMA, type InfoStripSettings } from '@core/infoStrip/settings';

import { useSettingsStore } from './settingsStore';

let mockSaved: unknown = null;
jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: async () => mockSaved,
}));
const storage = jest.requireMock('@data/storage') as { writeJson: jest.Mock };

const hydrate = async (saved: unknown) => {
  mockSaved = saved;
  useSettingsStore.setState({ hydrated: false });
  await useSettingsStore.getState().hydrate();
};

const lastWrite = () =>
  storage.writeJson.mock.calls[storage.writeJson.mock.calls.length - 1]![1] as Record<
    string,
    unknown
  >;

const navigation = (): InfoStripSettings => ({
  schema: INFO_STRIP_SCHEMA,
  current: applyPreset(presetById('navigation')!, new Set()),
  saved: [],
});

beforeEach(() => {
  storage.writeJson.mockClear();
  useSettingsStore.getState().reset();
});

it('starts on the default strip (2.5.1 chip + dot), mirror on', () => {
  expect(useSettingsStore.getState().infoStrip.current).toEqual(DEFAULT_STRIP);
  expect(useSettingsStore.getState().showCenterCursor).toBe(true);
});

it('an upgrade from 2.5.1 (no key) keeps what the user saw', async () => {
  await hydrate({ schemaVersion: 2, showCenterCursor: true });
  expect(useSettingsStore.getState().infoStrip.current).toEqual(DEFAULT_STRIP);

  await hydrate({ schemaVersion: 2, showCenterCursor: false });
  const s = useSettingsStore.getState();
  expect(s.infoStrip.current.rows).toEqual([]);
  expect(s.infoStrip.current.aids.cursor.enabled).toBe(false);
  expect(s.showCenterCursor).toBe(false);
});

it('the key wins over the 2.5.1 switch once it exists', async () => {
  await hydrate({ schemaVersion: 2, showCenterCursor: false, infoStrip: navigation() });
  const s = useSettingsStore.getState();
  expect(s.infoStrip.current.name).toBe('Navigation');
  // The mirror follows the strip, not the stale switch.
  expect(s.showCenterCursor).toBe(true);
});

it('junk is the default; unknown fields of a newer build are kept', async () => {
  await hydrate({ schemaVersion: 2, infoStrip: 'junk' });
  expect(useSettingsStore.getState().infoStrip.current).toEqual(DEFAULT_STRIP);

  const newer = { field: 'weather:wind', params: { gusts: true } };
  await hydrate({
    schemaVersion: 2,
    infoStrip: { schema: 1, current: { ...DEFAULT_STRIP, rows: [[newer]] }, saved: [] },
  });
  expect(useSettingsStore.getState().infoStrip.current.rows).toEqual([[newer]]);
});

it('setInfoStrip writes the strip and its mirror in ONE write', async () => {
  await hydrate(null);
  storage.writeJson.mockClear();
  const empty: InfoStripSettings = {
    ...navigation(),
    current: {
      ...DEFAULT_STRIP,
      rows: [],
      aids: { cursor: { ...DEFAULT_STRIP.aids.cursor, enabled: false } },
    },
  };
  useSettingsStore.getState().setInfoStrip(empty);
  expect(storage.writeJson).toHaveBeenCalledTimes(1);
  expect(lastWrite()).toEqual(
    expect.objectContaining({ infoStrip: empty, showCenterCursor: false }),
  );
  // And it reads back as written.
  await hydrate(JSON.parse(JSON.stringify(lastWrite())));
  expect(useSettingsStore.getState().infoStrip).toEqual(empty);
});

it('a change made before the file is read survives hydration', async () => {
  useSettingsStore.setState({ hydrated: false });
  storage.writeJson.mockClear();
  useSettingsStore.getState().setInfoStrip(navigation());
  expect(storage.writeJson).not.toHaveBeenCalled();
  mockSaved = { schemaVersion: 2, showCenterCursor: false };
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().infoStrip.current.name).toBe('Navigation');
  expect(lastWrite()).toEqual(expect.objectContaining({ showCenterCursor: true }));
});
