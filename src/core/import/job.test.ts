import {
  isResumable,
  jobProgress,
  newImportJob,
  sanitizeImportDoc,
  sanitizeImportJob,
  type ImportJob,
} from './job';

const base = (over: Partial<ImportJob> = {}): ImportJob => ({
  ...newImportJob({ source: 'strava', range: { kind: 'everything' }, since: 0, now: 100 }),
  ...over,
});

describe('newImportJob', () => {
  it('starts running and listing, with empty counters', () => {
    const job = base();
    expect(job).toMatchObject({ status: 'running', listing: true, total: 0, startedAt: 100 });
    expect(jobProgress(job)).toBe(0);
    expect(isResumable(job)).toBe(false);
  });

  it('reports progress and resumability', () => {
    expect(jobProgress(base({ total: 4, done: 1 }))).toBe(0.25);
    expect(jobProgress(base({ total: 4, done: 9 }))).toBe(1);
    expect(isResumable(base({ status: 'paused' }))).toBe(true);
    expect(isResumable(base({ status: 'stopped' }))).toBe(true);
    expect(isResumable(base({ status: 'done' }))).toBe(false);
  });
});

describe('sanitizeImportJob', () => {
  it('round-trips a finished job', () => {
    const job = base({
      quiet: true,
      status: 'done',
      listing: false,
      total: 3,
      done: 3,
      imported: 2,
      noGps: 1,
      distanceM: 1234.5,
      ascentM: 50,
      importedTrackIds: ['x', 'y'],
    });
    expect(sanitizeImportJob(JSON.parse(JSON.stringify(job)))).toEqual(job);
  });

  it('keeps ranges of every kind', () => {
    for (const range of [
      { kind: 'since', after: 5 },
      { kind: 'last-days', days: 30 },
      { kind: 'everything' },
    ] as const) {
      expect(sanitizeImportJob({ ...base({ status: 'done' }), range })?.range).toEqual(range);
    }
  });

  it('turns a job that was running when the app died into an interrupted pause', () => {
    const job = sanitizeImportJob({ ...base(), pause: { kind: 'rate-limit', resumeAt: 5 } });
    expect(job).toMatchObject({ status: 'paused', pausedReason: 'interrupted', pause: null });
    expect(sanitizeImportJob(base({ status: 'paused', pausedReason: 'background' }))).toMatchObject(
      { pausedReason: 'interrupted' },
    );
    expect(sanitizeImportJob({ ...base(), status: 'paused', pausedReason: 'junk' })).toMatchObject({
      pausedReason: 'interrupted',
    });
  });

  it('keeps a daily-limit pause and its resume time', () => {
    expect(
      sanitizeImportJob(base({ status: 'paused', pausedReason: 'daily-limit', resumeAt: 999 })),
    ).toMatchObject({ status: 'paused', pausedReason: 'daily-limit', resumeAt: 999 });
  });

  it('clamps junk counters', () => {
    const job = sanitizeImportJob({
      ...base({ status: 'stopped' }),
      total: 2,
      done: 7,
      imported: -1,
      failed: 'x',
      distanceM: Number.NaN,
      remaining: ['a', 3, 'b'],
      message: 4,
      errorKind: 'nope',
    });
    expect(job).toMatchObject({
      total: 2,
      done: 2,
      imported: 0,
      failed: 0,
      distanceM: 0,
      remaining: ['a', 'b'],
      message: null,
      errorKind: null,
    });
  });

  it.each([
    null,
    'job',
    {},
    { ...base(), source: 'garmin' },
    { ...base(), range: { kind: 'since' } },
    { ...base(), range: { kind: 'last-days', days: 0 } },
    { ...base(), range: 'all' },
    { ...base(), range: { kind: 'forever' } },
    { ...base(), status: 'weird' },
  ])('drops junk %#', (raw) => {
    expect(sanitizeImportJob(raw)).toBeNull();
  });
});

describe('sanitizeImportDoc', () => {
  it('round-trips a document', () => {
    const doc = {
      schemaVersion: 1,
      job: base({ status: 'done' }),
      lastImportAt: { strava: 10, 'apple-health': 20 },
      healthAllowed: true,
      autoImportStrava: false,
    };
    expect(sanitizeImportDoc(JSON.parse(JSON.stringify(doc)))).toEqual({
      job: doc.job,
      lastImportAt: doc.lastImportAt,
      healthAllowed: true,
      autoImportStrava: false,
    });
  });

  it('defaults junk', () => {
    expect(sanitizeImportDoc(null)).toEqual({
      job: null,
      lastImportAt: {},
      healthAllowed: false,
      autoImportStrava: true,
    });
    expect(
      sanitizeImportDoc({ lastImportAt: { strava: -1, garmin: 5, 'health-connect': 7 } })
        .lastImportAt,
    ).toEqual({ 'health-connect': 7 });
  });
});
