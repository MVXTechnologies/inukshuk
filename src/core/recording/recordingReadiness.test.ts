import {
  allClear,
  hasProblem,
  readinessChecks,
  type ReadinessCheck,
  type ReadinessSnapshot,
} from './recordingReadiness';

const ios = (over: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot => ({
  platform: 'ios',
  osVersion: 18,
  manufacturer: '',
  location: 'granted',
  locationCanAskAgain: true,
  precise: true,
  background: 'denied',
  backgroundCanAskAgain: true,
  notifications: null,
  notificationsCanAskAgain: true,
  batteryReviewed: false,
  ...over,
});

const android = (over: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot =>
  ios({
    platform: 'android',
    osVersion: 35,
    manufacturer: 'google',
    background: 'granted',
    notifications: 'granted',
    batteryReviewed: true,
    ...over,
  });

const row = (checks: ReadinessCheck[], id: ReadinessCheck['id']) => checks.find((c) => c.id === id);

describe('readinessChecks — iOS', () => {
  it('While Using + precise is all clear: no "Always" row, no battery row', () => {
    const checks = readinessChecks(ios());
    expect(checks.map((c) => c.id)).toEqual(['location', 'precise']);
    expect(allClear(checks)).toBe(true);
    expect(row(checks, 'location')?.detail).toContain('While Using the App');
  });

  it('Precise: Off is a problem fixed in the app Settings page', () => {
    const checks = readinessChecks(ios({ precise: false }));
    const precise = row(checks, 'precise');
    expect(precise?.status).toBe('problem');
    expect(precise?.fix).toBe('open-app-settings');
    expect(precise?.detail).toContain('Precise Location');
    expect(hasProblem(checks)).toBe(true);
  });

  it('denied location that cannot be re-asked routes to Settings and hides the precision row', () => {
    const checks = readinessChecks(ios({ location: 'denied', locationCanAskAgain: false }));
    expect(checks.map((c) => c.id)).toEqual(['location']);
    expect(checks[0]?.fix).toBe('open-app-settings');
  });

  it('undetermined location is requested in-app', () => {
    expect(readinessChecks(ios({ location: 'undetermined' }))[0]?.fix).toBe('request-location');
  });
});

describe('readinessChecks — Android', () => {
  it('everything granted and battery reviewed is all clear', () => {
    const checks = readinessChecks(android());
    expect(checks.map((c) => c.id)).toEqual([
      'location',
      'precise',
      'background',
      'battery',
      'notifications',
    ]);
    expect(allClear(checks)).toBe(true);
  });

  it('approximate location re-requests precise in-app while it can', () => {
    const p = row(readinessChecks(android({ precise: false })), 'precise');
    expect(p?.status).toBe('problem');
    expect(p?.fix).toBe('request-precise');
  });

  it('approximate location falls back to settings once the dialog is blocked', () => {
    const p = row(
      readinessChecks(android({ precise: false, locationCanAskAgain: false })),
      'precise',
    );
    expect(p?.fix).toBe('open-app-settings');
  });

  it('"While using" is advice, not a blocking problem', () => {
    const checks = readinessChecks(android({ background: 'denied' }));
    expect(row(checks, 'background')?.status).toBe('advice');
    expect(row(checks, 'background')?.fix).toBe('request-background');
    expect(hasProblem(checks)).toBe(false);
    expect(allClear(checks)).toBe(false);
  });

  it('a permanently refused background permission opens settings', () => {
    const b = row(
      readinessChecks(android({ background: 'denied', backgroundCanAskAgain: false })),
      'background',
    );
    expect(b?.fix).toBe('open-app-settings');
  });

  it('battery is advice until reviewed; Samsung gets "Never sleeping apps"', () => {
    const generic = row(readinessChecks(android({ batteryReviewed: false })), 'battery');
    expect(generic?.status).toBe('advice');
    expect(generic?.fix).toBe('open-battery-settings');
    expect(generic?.detail).toContain('Unrestricted');
    expect(generic?.detail).not.toContain('Samsung');
    const samsung = row(
      readinessChecks(android({ batteryReviewed: false, manufacturer: 'samsung' })),
      'battery',
    );
    expect(samsung?.detail).toContain('Never sleeping apps');
  });

  it('pre-Android-12 battery guidance names the optimization list', () => {
    const b = row(readinessChecks(android({ osVersion: 30, batteryReviewed: false })), 'battery');
    expect(b?.detail).toContain('Don’t optimize');
  });

  it('notifications row only exists where the runtime permission does', () => {
    expect(row(readinessChecks(android({ notifications: null })), 'notifications')).toBeUndefined();
    const n = row(readinessChecks(android({ notifications: 'denied' })), 'notifications');
    expect(n?.status).toBe('advice');
    expect(n?.fix).toBe('request-notifications');
    const blocked = row(
      readinessChecks(android({ notifications: 'denied', notificationsCanAskAgain: false })),
      'notifications',
    );
    expect(blocked?.fix).toBe('open-app-settings');
  });

  it('without location the precision and background rows are hidden', () => {
    expect(readinessChecks(android({ location: 'denied' })).map((c) => c.id)).toEqual([
      'location',
      'battery',
      'notifications',
    ]);
  });
});
