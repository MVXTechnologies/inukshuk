import { migrateSettings } from '@core/library/migrations';

import beforeExtensions from './__fixtures__/settings-before-extensions.json';
import geodeticOnly from './__fixtures__/settings-geodetic-only-3dc166ff.json';
import mainShaped from './__fixtures__/settings-main-39dd7848.json';
import {
  defaultExtensionPrefs,
  legacyExtensionFields,
  migrateExtensionPrefs,
  withExtensionPrefs,
} from './prefs';
import type { ExtensionPrefsMap } from './types';

/**
 * The fixtures are settings.json files as the builds before the registry
 * wrote them (every key of their `Settings`, in their order): before any
 * extension, at the geodetic extension's first cut (3dc166ff, no tides), and
 * on main just before the registry (39dd7848, both extensions).
 */
describe('migrateExtensionPrefs: settings files from before the registry', () => {
  it('a file from before any extension: nothing installed, default switches', () => {
    expect(migrateExtensionPrefs(beforeExtensions)).toEqual({
      geodetic: { installedAt: 0, show: true, offline: true },
      tides: { installedAt: 0, show: true, offline: false },
    });
  });

  it('geodetic installed with its switches off (3dc166ff): kept as they were', () => {
    expect(migrateExtensionPrefs(geodeticOnly)).toEqual({
      geodetic: { installedAt: 1_759_683_600_000, show: false, offline: false },
      tides: { installedAt: 0, show: true, offline: false },
    });
  });

  it('both installed (main, 39dd7848): every install and switch kept', () => {
    expect(migrateExtensionPrefs(mainShaped)).toEqual({
      geodetic: { installedAt: 1_759_683_600_000, show: true, offline: true },
      tides: { installedAt: 1_759_770_000_000, show: false, offline: false },
    });
  });

  it('junk files and junk values fall back to the defaults, never throw', () => {
    const d = defaultExtensionPrefs();
    for (const junk of [null, undefined, 42, 'settings', [], { extensions: 'x' }]) {
      expect(migrateExtensionPrefs(junk)).toEqual(d);
    }
    expect(
      migrateExtensionPrefs({
        geodeticInstalledAt: -5,
        showGeodetic: 'yes',
        geodeticOffline: null,
        tidesInstalledAt: '1759770000000',
        showTideStations: 0,
      }),
    ).toEqual(d);
  });
});

describe('the registry format and its legacy mirror', () => {
  const prefs: ExtensionPrefsMap = {
    geodetic: { installedAt: 1_759_683_600_000, show: false, offline: true },
    tides: { installedAt: 1_759_770_000_000, show: true, offline: false },
  };

  it('writes the pre-registry flat keys next to `extensions`', () => {
    expect(legacyExtensionFields(prefs)).toEqual({
      geodeticInstalledAt: 1_759_683_600_000,
      showGeodetic: false,
      geodeticOffline: true,
      tidesInstalledAt: 1_759_770_000_000,
      showTideStations: true,
    });
  });

  it('reads back what it writes', () => {
    const file = { schemaVersion: 3, extensions: prefs, ...legacyExtensionFields(prefs) };
    expect(migrateExtensionPrefs(JSON.parse(JSON.stringify(file)))).toEqual(prefs);
  });

  it('the `extensions` entry wins over the flat keys, field by field', () => {
    expect(
      migrateExtensionPrefs({
        extensions: { geodetic: { installedAt: 0, show: 'junk' } },
        geodeticInstalledAt: 1,
        showGeodetic: false,
        geodeticOffline: false,
      }).geodetic,
    ).toEqual({ installedAt: 0, show: false, offline: false });
  });

  it('an older build (OTA rollback) reads the same state from the new file, and back', () => {
    // What a pre-registry build does with settings.json: copy the keys its
    // DEFAULTS know (`migrateSettings`) — the flat keys, not `extensions`.
    const oldDefaults = { ...mainShaped, schemaVersion: undefined };
    const written = JSON.parse(
      JSON.stringify({ ...mainShaped, extensions: prefs, ...legacyExtensionFields(prefs) }),
    ) as unknown;
    const oldBuild = migrateSettings(written, oldDefaults);
    expect(oldBuild).toMatchObject({
      geodeticInstalledAt: 1_759_683_600_000,
      showGeodetic: false,
      geodeticOffline: true,
      tidesInstalledAt: 1_759_770_000_000,
      showTideStations: true,
    });
    expect(oldBuild).not.toHaveProperty('extensions');
    // ... and what the old build saves, the new one reads unchanged.
    expect(migrateExtensionPrefs(oldBuild)).toEqual(prefs);
  });
});

it('withExtensionPrefs replaces one extension, immutably', () => {
  const d = defaultExtensionPrefs();
  const next = withExtensionPrefs(d, 'tides', { installedAt: 7 });
  expect(next.tides).toEqual({ installedAt: 7, show: true, offline: false });
  expect(next.geodetic).toBe(d.geodetic);
  expect(d.tides.installedAt).toBe(0);
  expect(next).not.toBe(d);
});
