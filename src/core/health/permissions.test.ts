import { hasHealthConnectPermission, healthConnectOutcome } from './permissions';

const EX = { accessType: 'read', recordType: 'ExerciseSession' };
const DIST = { accessType: 'read', recordType: 'Distance' };
const HIST = { accessType: 'read', recordType: 'ReadHealthDataHistory' };
const ALL = [EX, DIST, HIST];

describe('healthConnectOutcome', () => {
  it('is granted when everything was granted', () => {
    expect(healthConnectOutcome(ALL, [HIST, DIST, EX], EX)).toBe('granted');
  });

  it('is partial with the essential permission but not all', () => {
    expect(healthConnectOutcome(ALL, [EX], EX)).toBe('partial');
  });

  it('is denied without the essential permission', () => {
    expect(healthConnectOutcome(ALL, [DIST, HIST], EX)).toBe('denied');
    expect(healthConnectOutcome(ALL, [], EX)).toBe('denied');
  });

  it('does not confuse read with write', () => {
    expect(healthConnectOutcome(ALL, [{ ...EX, accessType: 'write' }], EX)).toBe('denied');
  });
});

describe('hasHealthConnectPermission', () => {
  it('matches access type and record type', () => {
    expect(hasHealthConnectPermission([EX, DIST], DIST)).toBe(true);
    expect(hasHealthConnectPermission([EX], DIST)).toBe(false);
  });
});
