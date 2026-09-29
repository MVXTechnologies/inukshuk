/** `imports.json` round-trip: the job, last-import times and Health access survive a restart. */
import { newImportJob } from '@core/import/job';

import { useImportStore } from './importStore';

const mockFiles = new Map<string, unknown>();
jest.mock('@data/storage', () => ({
  writeJson: jest.fn((name: string, value: unknown) =>
    mockFiles.set(name, JSON.parse(JSON.stringify(value))),
  ),
  readJson: jest.fn(async (name: string) => mockFiles.get(name) ?? null),
}));

const storage = jest.requireMock('@data/storage') as { writeJson: jest.Mock };

const reset = () =>
  useImportStore.setState({
    hydrated: false,
    job: null,
    lastImportAt: {},
    healthAllowed: false,
    sheetRequest: null,
  });

beforeEach(() => {
  mockFiles.clear();
  reset();
});

it('hydrates defaults from nothing', async () => {
  await useImportStore.getState().hydrate();
  expect(useImportStore.getState()).toMatchObject({
    hydrated: true,
    job: null,
    lastImportAt: {},
    healthAllowed: false,
  });
});

it('round-trips a paused job, last imports and Health access', async () => {
  const job = {
    ...newImportJob({ source: 'strava', range: { kind: 'everything' }, since: 0, now: 50 }),
    status: 'paused' as const,
    pausedReason: 'daily-limit' as const,
    resumeAt: 9_999,
    listing: false,
    total: 10,
    done: 4,
    remaining: ['a', 'b'],
  };
  const s = useImportStore.getState();
  s.setJob(job);
  s.markImported('apple-health', 123);
  s.setHealthAllowed(true);

  reset();
  await useImportStore.getState().hydrate();
  expect(useImportStore.getState()).toMatchObject({
    job,
    lastImportAt: { 'apple-health': 123 },
    healthAllowed: true,
  });
});

it('brings a job that was running back as interrupted', async () => {
  useImportStore
    .getState()
    .setJob(newImportJob({ source: 'strava', range: { kind: 'everything' }, since: 0, now: 1 }));
  reset();
  await useImportStore.getState().hydrate();
  expect(useImportStore.getState().job).toMatchObject({
    status: 'paused',
    pausedReason: 'interrupted',
  });
});

it('skips the write for progress ticks', () => {
  const job = newImportJob({ source: 'strava', range: { kind: 'everything' }, since: 0, now: 1 });
  useImportStore.getState().setJob(job, { persist: false });
  expect(useImportStore.getState().job).toBe(job);
  expect(storage.writeJson).not.toHaveBeenCalled();
});

it('keeps a job started before hydration finished', async () => {
  const job = newImportJob({ source: 'strava', range: { kind: 'everything' }, since: 0, now: 1 });
  useImportStore.getState().setJob(job, { persist: false });
  mockFiles.set('imports.json', { job: null, lastImportAt: { strava: 5 } });
  await useImportStore.getState().hydrate();
  expect(useImportStore.getState().job).toBe(job);
  expect(useImportStore.getState().lastImportAt).toEqual({ strava: 5 });
});

it('carries sheet requests for the Library', () => {
  useImportStore.getState().requestSheet('strava');
  expect(useImportStore.getState().sheetRequest).toEqual({ source: 'strava' });
  useImportStore.getState().clearSheetRequest();
  expect(useImportStore.getState().sheetRequest).toBeNull();
});
