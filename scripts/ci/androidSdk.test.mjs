import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RETRY_DELAYS_S,
  componentMarker,
  parseVersionCatalog,
  requiredComponents,
} from './androidSdk.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CATALOG = `[versions]
# Android versions
minSdk = "24"
compileSdk = "36"
buildTools = "36.0.0"
ndkVersion = "27.1.12297006"
agp = "8.12.0" # trailing comment

[libraries]
agp = "should-not-be-read"
`;
const PINS = { agpDefaults: { '8.12.0': { ndk: '27.0.12077973', cmake: '3.22.1' } } };

describe('parseVersionCatalog', () => {
  it('reads only the [versions] table, ignoring comments', () => {
    const v = parseVersionCatalog(CATALOG);
    assert.equal(v.compileSdk, '36');
    assert.equal(v.ndkVersion, '27.1.12297006');
    assert.equal(v.agp, '8.12.0');
  });
});

describe('requiredComponents', () => {
  it('lists the catalog components plus the AGP defaults', () => {
    assert.deepEqual(requiredComponents(parseVersionCatalog(CATALOG), PINS), [
      'platforms;android-36',
      'build-tools;36.0.0',
      'ndk;27.1.12297006',
      'ndk;27.0.12077973',
      'cmake;3.22.1',
    ]);
  });

  it('deduplicates when the catalog NDK is the AGP default', () => {
    const catalog = { ...parseVersionCatalog(CATALOG), ndkVersion: '27.0.12077973' };
    const list = requiredComponents(catalog, PINS);
    assert.equal(list.filter((c) => c.startsWith('ndk;')).length, 1);
  });

  it('fails with the remedy on an AGP version without pinned defaults', () => {
    const catalog = { ...parseVersionCatalog(CATALOG), agp: '9.0.0' };
    assert.throws(() => requiredComponents(catalog, PINS), /AGP 9\.0\.0.*android-sdk\.json/);
  });

  it('fails on a catalog missing a version', () => {
    const { ndkVersion: _drop, ...catalog } = parseVersionCatalog(CATALOG);
    assert.throws(() => requiredComponents(catalog, PINS), /ndkVersion/);
  });
});

describe('componentMarker', () => {
  it('points at the source.properties sdkmanager writes last', () => {
    assert.equal(componentMarker('ndk;27.1.12297006'), 'ndk/27.1.12297006/source.properties');
    assert.equal(componentMarker('platforms;android-36'), 'platforms/android-36/source.properties');
  });

  it('rejects a name that is not a versioned package', () => {
    assert.throws(() => componentMarker('platform-tools'), /not an sdkmanager package/);
  });
});

describe('the retry budget', () => {
  it('is bounded (download step only, never tests)', () => {
    assert.ok(RETRY_DELAYS_S.length <= 3);
  });
});

describe('the real inputs', () => {
  it("has pinned AGP defaults for the AGP in react-native's catalog", () => {
    const toml = readFileSync(
      join(repoRoot, 'node_modules/react-native/gradle/libs.versions.toml'),
      'utf8',
    );
    const pins = JSON.parse(readFileSync(join(repoRoot, 'scripts/ci/android-sdk.json'), 'utf8'));
    const list = requiredComponents(parseVersionCatalog(toml), pins);
    assert.ok(list.some((c) => c.startsWith('cmake;')));
  });
});
