// #673: the info strip's own file (`info-strip.json`), its migration from
// 2.5.1 and from a pre-release's settings key, and its rollback mirror
// (`showCenterCursor` in settings.json).
import { applyPreset, DEFAULT_STRIP, presetById } from '@core/infoStrip/presets';
import {
  INFO_STRIP_FILE,
  INFO_STRIP_SCHEMA,
  type InfoStripSettings,
} from '@core/infoStrip/settings';

import { useSettingsStore } from './settingsStore';

/** The app's document folder, as files: what readJson finds and writeJson leaves. */
const mockDisk = new Map<string, unknown>();
jest.mock('@data/storage', () => ({
  writeJson: jest.fn((name: string, value: unknown) =>
    mockDisk.set(name, JSON.parse(JSON.stringify(value))),
  ),
  readJson: async (name: string) => mockDisk.get(name) ?? null,
}));
const storage = jest.requireMock('@data/storage') as { writeJson: jest.Mock };

const SETTINGS = 'settings.json';

const hydrate = async (files: { settings?: unknown; strip?: unknown }) => {
  mockDisk.clear();
  if (files.settings !== undefined) mockDisk.set(SETTINGS, files.settings);
  if (files.strip !== undefined) mockDisk.set(INFO_STRIP_FILE, files.strip);
  await relaunch();
};

/** A cold start on what is on disk now. */
const relaunch = async () => {
  useSettingsStore.setState({ hydrated: false });
  await useSettingsStore.getState().hydrate();
};

const writesTo = (name: string) =>
  storage.writeJson.mock.calls.filter(([file]) => file === name).map(([, v]) => v as unknown);

const navigation = (): InfoStripSettings => ({
  schema: INFO_STRIP_SCHEMA,
  current: applyPreset(presetById('navigation')!, new Set()),
  saved: [],
});

/**
 * What 2.5.1 does to settings.json on any write: it keeps only the keys it
 * knows (here: everything but `infoStrip`, which it has never heard of).
 */
const asIf251Rewrote = () => {
  const file = mockDisk.get(SETTINGS) as Record<string, unknown>;
  const { infoStrip: _dropped, ...known } = file;
  mockDisk.set(SETTINGS, { ...known, showCenterCursor: false });
};

beforeEach(() => {
  mockDisk.clear();
  storage.writeJson.mockClear();
  useSettingsStore.getState().reset();
  storage.writeJson.mockClear();
});

it('starts on the default strip (2.5.1 chip + dot), mirror on', () => {
  expect(useSettingsStore.getState().infoStrip.current).toEqual(DEFAULT_STRIP);
  expect(useSettingsStore.getState().showCenterCursor).toBe(true);
});

it('an upgrade from 2.5.1 (no strip file) keeps what the user saw', async () => {
  await hydrate({ settings: { schemaVersion: 2, showCenterCursor: true } });
  expect(useSettingsStore.getState().infoStrip.current).toEqual(DEFAULT_STRIP);

  await hydrate({ settings: { schemaVersion: 2, showCenterCursor: false } });
  const s = useSettingsStore.getState();
  expect(s.infoStrip.current.rows).toEqual([]);
  expect(s.infoStrip.current.aids.cursor.enabled).toBe(false);
  expect(s.showCenterCursor).toBe(false);
});

it('the strip file wins over the 2.5.1 switch', async () => {
  await hydrate({ settings: { schemaVersion: 2, showCenterCursor: false }, strip: navigation() });
  const s = useSettingsStore.getState();
  expect(s.infoStrip.current.name).toBe('Navigation');
  // The mirror follows the strip, not the stale switch.
  expect(s.showCenterCursor).toBe(true);
});

it('a pre-release kept it in settings.json: read once, moved to its own file', async () => {
  await hydrate({ settings: { schemaVersion: 2, infoStrip: navigation() } });
  expect(useSettingsStore.getState().infoStrip.current.name).toBe('Navigation');
  expect(writesTo(INFO_STRIP_FILE)).toEqual([navigation()]);
});

it('junk is the default; unknown fields of a newer build are kept', async () => {
  await hydrate({ settings: { schemaVersion: 2 }, strip: 'junk' });
  expect(useSettingsStore.getState().infoStrip.current).toEqual(DEFAULT_STRIP);

  const newer = { field: 'weather:wind', params: { gusts: true } };
  await hydrate({
    settings: { schemaVersion: 2 },
    strip: { schema: 1, current: { ...DEFAULT_STRIP, rows: [[newer]] }, saved: [] },
  });
  expect(useSettingsStore.getState().infoStrip.current.rows).toEqual([[newer]]);
});

it('setInfoStrip writes the strip to its own file, and settings.json only for the mirror', async () => {
  await hydrate({});
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
  expect(writesTo(INFO_STRIP_FILE)).toEqual([empty]);
  // The mirror flipped (the strip shows nothing now): one settings write, no strip in it.
  expect(writesTo(SETTINGS)).toHaveLength(1);
  expect(writesTo(SETTINGS)[0]).toEqual(expect.objectContaining({ showCenterCursor: false }));
  expect(writesTo(SETTINGS)[0]).not.toHaveProperty('infoStrip');

  // An edit that leaves the mirror as it is touches settings.json not at all.
  storage.writeJson.mockClear();
  const renamed = { ...empty, current: { ...empty.current, name: 'Mine' } };
  useSettingsStore.getState().setInfoStrip(renamed);
  expect(writesTo(INFO_STRIP_FILE)).toHaveLength(1);
  expect(writesTo(SETTINGS)).toHaveLength(0);

  // And it reads back as written.
  await relaunch();
  expect(useSettingsStore.getState().infoStrip).toEqual(renamed);
});

it('any other setting write leaves the strip out of settings.json', async () => {
  await hydrate({ strip: navigation() });
  storage.writeJson.mockClear();
  useSettingsStore.getState().set('units', 'imperial');
  expect(writesTo(SETTINGS)[0]).not.toHaveProperty('infoStrip');
  expect(writesTo(INFO_STRIP_FILE)).toHaveLength(0);
});

it('a change made before the files are read survives hydration', async () => {
  useSettingsStore.setState({ hydrated: false });
  storage.writeJson.mockClear();
  useSettingsStore.getState().setInfoStrip(navigation());
  expect(storage.writeJson).not.toHaveBeenCalled();
  mockDisk.set(SETTINGS, { schemaVersion: 2, showCenterCursor: false });
  await useSettingsStore.getState().hydrate();
  expect(useSettingsStore.getState().infoStrip.current.name).toBe('Navigation');
  expect(writesTo(INFO_STRIP_FILE)).toEqual([navigation()]);
  expect(writesTo(SETTINGS)[0]).toEqual(expect.objectContaining({ showCenterCursor: true }));
});

it('rolling back to 2.5.1 and forward again loses nothing', async () => {
  // 2.6.0: a strip of your own, saved strips too.
  await hydrate({ settings: { schemaVersion: 2 } });
  const mine: InfoStripSettings = {
    ...navigation(),
    current: { ...navigation().current, name: 'Ridge survey', dock: 'top' },
    saved: [{ ...navigation().current, name: 'Paddle' }],
  };
  useSettingsStore.getState().setInfoStrip(mine);
  useSettingsStore.getState().set('units', 'imperial');
  expect(mockDisk.get(SETTINGS)).toEqual(expect.objectContaining({ showCenterCursor: true }));

  // 2.5.1 runs: it rewrites settings.json with only its keys (and the user
  // flips its chip switch off while there). It never opens info-strip.json.
  asIf251Rewrote();

  // 2.6.0 again: the strip and the saved strips are all there.
  await relaunch();
  const s = useSettingsStore.getState();
  expect(s.infoStrip).toEqual(mine);
  expect(s.units).toBe('imperial');
  // The mirror is re-derived from the strip for the next rollback.
  expect(s.showCenterCursor).toBe(true);
});
