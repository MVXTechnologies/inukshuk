import {
  extensionShown,
  extensionsRowHint,
  extensionsRowTarget,
  installedExtensions,
  type ExtensionsState,
} from './extensions';

const none: ExtensionsState = {
  available: ['geodetic', 'tides'],
  geodeticInstalledAt: 0,
  showGeodetic: true,
  tidesInstalledAt: 0,
  showTideStations: false,
};

describe('map extensions', () => {
  it('with nothing installed, the Extensions row leads to Settings', () => {
    expect(installedExtensions(none)).toEqual([]);
    expect(extensionsRowTarget(none)).toBe('settings');
    expect(extensionsRowHint(none)).toBe('Get survey marks, tide stations…');
  });

  it('with something installed, it opens the panel', () => {
    const geo = { ...none, geodeticInstalledAt: 1 };
    expect(extensionsRowTarget(geo)).toBe('panel');
    expect(extensionsRowHint(geo)).toBe('Geodetic points');
    const both = { ...geo, tidesInstalledAt: 2, showTideStations: true };
    expect(installedExtensions(both)).toEqual(['geodetic', 'tides']);
    expect(extensionsRowHint(both)).toBe('Geodetic points · Tide stations');
    expect(extensionsRowHint({ ...both, showGeodetic: false, showTideStations: false })).toBe(
      'All off',
    );
  });

  it('an extension is shown only when installed and switched on', () => {
    expect(extensionShown({ ...none, showTideStations: true }, 'tides')).toBe(false);
    expect(extensionShown({ ...none, tidesInstalledAt: 1, showTideStations: true }, 'tides')).toBe(
      true,
    );
    expect(
      extensionShown({ ...none, geodeticInstalledAt: 1, showGeodetic: false }, 'geodetic'),
    ).toBe(false);
  });

  it('offers only published extensions, and no row when none is', () => {
    expect(installedExtensions({ ...none, available: ['geodetic'], tidesInstalledAt: 5 })).toEqual(
      [],
    );
    expect(extensionsRowTarget({ ...none, available: [] })).toBeNull();
  });

  it('carries a geodetic install over unchanged (settings from before Extensions)', () => {
    // A file written by 2.2.x: geodetic installed and on, no tide fields → defaults.
    const before = { ...none, geodeticInstalledAt: 1_759_600_000_000, showGeodetic: true };
    expect(installedExtensions(before)).toEqual(['geodetic']);
    expect(extensionShown(before, 'geodetic')).toBe(true);
    expect(extensionShown(before, 'tides')).toBe(false);
  });
});

describe('climbing crags', () => {
  const base: ExtensionsState = {
    available: ['geodetic', 'tides', 'climbing'],
    geodeticInstalledAt: 0,
    showGeodetic: true,
    tidesInstalledAt: 0,
    showTideStations: true,
  };

  it('is installed by its own timestamp and shown by its own switch', () => {
    expect(installedExtensions(base)).toEqual([]);
    const on = { ...base, climbingInstalledAt: 1, showClimbing: true };
    expect(installedExtensions(on)).toEqual(['climbing']);
    expect(extensionShown(on, 'climbing')).toBe(true);
    expect(extensionShown({ ...on, showClimbing: false }, 'climbing')).toBe(false);
    expect(extensionsRowHint(on)).toBe('Climbing crags');
    expect(extensionsRowTarget(on)).toBe('panel');
  });
});
