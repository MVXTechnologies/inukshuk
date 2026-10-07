import { defaultExtensionPrefs, withExtensionPrefs } from './prefs';
import {
  extensionShown,
  extensionsRowHint,
  extensionsRowTarget,
  installedExtensions,
  packExtensions,
  shownExtensions,
  type ExtensionsState,
} from './state';
import type { ExtensionKey } from './keys';
import type { ExtensionPrefs } from './types';

const none: ExtensionsState = {
  available: ['geodetic', 'tides'],
  prefs: withExtensionPrefs(defaultExtensionPrefs(), 'tides', { show: false }),
};

const withPrefs = (
  s: ExtensionsState,
  key: ExtensionKey,
  patch: Partial<ExtensionPrefs>,
): ExtensionsState => ({ ...s, prefs: withExtensionPrefs(s.prefs, key, patch) });

describe('map extensions', () => {
  it('with nothing installed, the Extensions row leads to Settings', () => {
    expect(installedExtensions(none)).toEqual([]);
    expect(shownExtensions(none)).toEqual([]);
    expect(extensionsRowTarget(none)).toBe('settings');
    expect(extensionsRowHint(none)).toBe('Get survey marks, tide stations…');
  });

  it('with something installed, it opens the panel', () => {
    const geo = withPrefs(none, 'geodetic', { installedAt: 1 });
    expect(extensionsRowTarget(geo)).toBe('panel');
    expect(extensionsRowHint(geo)).toBe('Geodetic points');
    const both = withPrefs(geo, 'tides', { installedAt: 2, show: true });
    expect(installedExtensions(both)).toEqual(['geodetic', 'tides']);
    expect(shownExtensions(both)).toEqual(['geodetic', 'tides']);
    expect(extensionsRowHint(both)).toBe('Geodetic points · Tide stations');
    const off = withPrefs(withPrefs(both, 'geodetic', { show: false }), 'tides', { show: false });
    expect(extensionsRowHint(off)).toBe('All off');
    expect(shownExtensions(off)).toEqual([]);
  });

  it('an extension is shown only when installed and switched on', () => {
    expect(extensionShown(withPrefs(none, 'tides', { show: true }), 'tides')).toBe(false);
    expect(extensionShown(withPrefs(none, 'tides', { installedAt: 1, show: true }), 'tides')).toBe(
      true,
    );
    expect(
      extensionShown(withPrefs(none, 'geodetic', { installedAt: 1, show: false }), 'geodetic'),
    ).toBe(false);
  });

  it('offers only published extensions, and no row when none is', () => {
    const tides = withPrefs({ ...none, available: ['geodetic'] }, 'tides', { installedAt: 5 });
    expect(installedExtensions(tides)).toEqual([]);
    expect(extensionsRowTarget({ ...none, available: [] })).toBeNull();
  });
});

describe('packExtensions: which extensions ride in a new offline pack', () => {
  const both = withPrefs(withPrefs(none, 'geodetic', { installedAt: 1 }), 'tides', {
    installedAt: 1,
  });

  it('settings: tides once installed; geodetic only with "Offline in your regions" on', () => {
    expect(packExtensions(none, 'settings')).toEqual([]);
    expect(packExtensions(both, 'settings')).toEqual(['geodetic', 'tides']);
    expect(packExtensions(withPrefs(both, 'geodetic', { offline: false }), 'settings')).toEqual([
      'tides',
    ]);
    // The layer switch has nothing to do with it.
    expect(packExtensions(withPrefs(both, 'tides', { show: false }), 'settings')).toEqual([
      'geodetic',
      'tides',
    ]);
  });

  it('all: every published one, installed or not; none: nothing', () => {
    expect(packExtensions(none, 'all')).toEqual(['geodetic', 'tides']);
    expect(packExtensions({ ...none, available: ['tides'] }, 'all')).toEqual(['tides']);
    expect(packExtensions(both, 'none')).toEqual([]);
  });
});
