import {
  AUTO_IMPORT_INTERVAL_MS,
  quietImportMessage,
  shouldAutoImport,
  type AutoImportInput,
} from './auto';

const ready: AutoImportInput = {
  enabled: true,
  canImport: true,
  networkAllowed: true,
  hydrated: true,
  hasJob: false,
  lastImportAt: 1_000,
  lastAttemptAt: null,
  now: 10_000_000,
};

describe('shouldAutoImport', () => {
  it('imports when everything lines up', () => {
    expect(shouldAutoImport(ready)).toBe(true);
  });

  it.each<[string, Partial<AutoImportInput>]>([
    ['the switch is off', { enabled: false }],
    ['Strava cannot be read', { canImport: false }],
    ['the network is off', { networkAllowed: false }],
    ['stores are still loading', { hydrated: false }],
    ['a job is on screen', { hasJob: true }],
    ['no import has happened yet', { lastImportAt: null }],
  ])('waits when %s', (_why, over) => {
    expect(shouldAutoImport({ ...ready, ...over })).toBe(false);
  });

  it('checks at most once per 15 minutes', () => {
    const at = ready.now;
    expect(shouldAutoImport({ ...ready, lastAttemptAt: at - AUTO_IMPORT_INTERVAL_MS + 1 })).toBe(
      false,
    );
    expect(shouldAutoImport({ ...ready, lastAttemptAt: at - AUTO_IMPORT_INTERVAL_MS })).toBe(true);
  });
});

it('words the quiet summary', () => {
  expect(quietImportMessage(2, 'Strava')).toBe('2 new activities from Strava');
  expect(quietImportMessage(1, 'Strava')).toBe('1 new activity from Strava');
});
