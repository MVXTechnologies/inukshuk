import {
  describeRunningUpdate,
  formatUpdateTime,
  shortUpdateId,
  type UpdateFacts,
} from './updateInfo';

const facts = (over: Partial<UpdateFacts> = {}): UpdateFacts => ({
  isEmbeddedLaunch: false,
  updateId: '01a07e99-6558-78f8-acc9-09ffa53e1e2c',
  createdAt: new Date('2026-09-10T18:05:00Z'),
  isEmergencyLaunch: false,
  isEnabled: true,
  ...over,
});

const NOW = new Date('2026-09-10T20:00:00Z');

describe('shortUpdateId', () => {
  it('takes the first eight hex characters, ignoring the dashes', () => {
    expect(shortUpdateId('01a07e99-6558-78f8-acc9-09ffa53e1e2c')).toBe('01a07e99');
  });

  it('is null when there is no id, or too little of one to be worth showing', () => {
    expect(shortUpdateId(null)).toBeNull();
    expect(shortUpdateId('abc')).toBeNull();
  });
});

describe('formatUpdateTime', () => {
  it('omits the year within the current year', () => {
    expect(formatUpdateTime(new Date('2026-09-10T18:05:00Z'), NOW)).not.toMatch(/2026/);
  });

  it('includes the year for an older update', () => {
    expect(formatUpdateTime(new Date('2025-12-30T18:05:00Z'), NOW)).toMatch(/2025/);
  });
});

describe('describeRunningUpdate', () => {
  it('names the publish time and a short id for a downloaded update', () => {
    const line = describeRunningUpdate(facts(), NOW);
    expect(line).toMatch(/^Updated /);
    expect(line).toContain('01a07e99');
  });

  // The whole point of the row: the version string alone said "1.5.2" whether
  // the phone had today's bundle or a three-day-old one (#341).
  it('distinguishes the binary’s own bundle from a downloaded one', () => {
    expect(describeRunningUpdate(facts({ isEmbeddedLaunch: true }), NOW)).toBe(
      'Running the version built into the app',
    );
  });

  it('treats a missing publish time as the embedded bundle rather than guessing', () => {
    expect(describeRunningUpdate(facts({ createdAt: null }), NOW)).toBe(
      'Running the version built into the app',
    );
  });

  // "Up to date" would be a lie here: the downloaded update did not load.
  it('says so when an update failed to load and the binary’s copy ran', () => {
    expect(describeRunningUpdate(facts({ isEmergencyLaunch: true }), NOW)).toContain(
      'Update failed to load',
    );
  });

  it('says nothing at all in a build where updates are off', () => {
    expect(describeRunningUpdate(facts({ isEnabled: false }), NOW)).toBeNull();
  });

  it('still gives the time when the id is unusable', () => {
    const line = describeRunningUpdate(facts({ updateId: null }), NOW);
    expect(line).toMatch(/^Updated /);
    expect(line).not.toContain('·');
  });
});
