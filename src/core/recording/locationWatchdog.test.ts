import {
  FIX_STALE_MS,
  autoPauseMessage,
  classifyLocationProbe,
  isDeviceSettingsRejection,
  isFreshFix,
  isWatchSilent,
  locationLossMessage,
  needsSignalProbe,
} from './locationWatchdog';

describe('isWatchSilent', () => {
  it('is false while no watch is live', () => {
    expect(isWatchSilent(null, 1_000_000)).toBe(false);
  });

  it('turns true once the watch has been silent for the stale window', () => {
    expect(isWatchSilent(0, FIX_STALE_MS - 1)).toBe(false);
    expect(isWatchSilent(0, FIX_STALE_MS)).toBe(true);
    expect(isWatchSilent(0, 100, 100)).toBe(true);
  });
});

describe('needsSignalProbe', () => {
  it('probes for a fix while recording', () => {
    expect(needsSignalProbe(true, null)).toBe(true);
  });

  it('leaves an idle, silent watch alone: the distance filter withholds a still user', () => {
    expect(needsSignalProbe(false, null)).toBe(false);
    expect(needsSignalProbe(false, 'off')).toBe(false);
  });

  it('keeps probing to clear a standing no-signal, so a resume is not re-paused', () => {
    expect(needsSignalProbe(false, 'no-signal')).toBe(true);
  });
});

describe('classifyLocationProbe', () => {
  it('reports location off before anything else', () => {
    expect(classifyLocationProbe({ servicesEnabled: false, freshFix: null })).toBe('off');
    expect(classifyLocationProbe({ servicesEnabled: false, freshFix: true })).toBe('off');
  });

  it('reports no signal when location is on but no fresh fix came back', () => {
    expect(classifyLocationProbe({ servicesEnabled: true, freshFix: false })).toBe('no-signal');
  });

  it('is fine with a fresh fix, or when the fix probe was not needed', () => {
    expect(classifyLocationProbe({ servicesEnabled: true, freshFix: true })).toBeNull();
    expect(classifyLocationProbe({ servicesEnabled: true, freshFix: null })).toBeNull();
  });
});

describe('isFreshFix', () => {
  it('accepts a recent fix and rejects a cached one', () => {
    expect(isFreshFix(1_000, 1_000 + FIX_STALE_MS - 1)).toBe(true);
    expect(isFreshFix(1_000, 1_000 + FIX_STALE_MS)).toBe(false);
    expect(isFreshFix(Number.NaN, 0)).toBe(false);
  });
});

describe('isDeviceSettingsRejection', () => {
  it("matches expo-location's settings refusal only", () => {
    expect(
      isDeviceSettingsRejection(
        new Error('Location request failed due to unsatisfied device settings'),
      ),
    ).toBe(true);
    expect(isDeviceSettingsRejection(new Error('Not authorized'))).toBe(false);
    expect(isDeviceSettingsRejection('device settings')).toBe(false);
  });
});

describe('messages', () => {
  it('words the banner for every loss', () => {
    expect(locationLossMessage('off')).toMatch(/turned off/);
    expect(locationLossMessage('no-signal')).toMatch(/No GPS signal/);
    expect(locationLossMessage('error')).toMatch(/Couldn't start/);
  });

  it('tells the user what to do after an auto-pause', () => {
    expect(autoPauseMessage('no-signal')).toMatch(/recording paused.*signal/);
    expect(autoPauseMessage('off')).toMatch(/recording paused.*Re-enable location/);
    expect(autoPauseMessage('denied')).toMatch(/Re-enable location/);
  });
});
