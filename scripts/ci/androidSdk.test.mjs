import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DOWNLOAD_DELAYS_S,
  RETRY_DELAYS_S,
  componentMarker,
  emulatorCacheKey,
  parseVersionCatalog,
  renderPackageXml,
  repositoryLocation,
  requiredComponents,
  resolveRemotePackage,
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

  it('maps unversioned and nested packages onto their directories', () => {
    assert.equal(componentMarker('emulator'), 'emulator/source.properties');
    assert.equal(
      componentMarker('system-images;android-34;google_apis;x86_64'),
      'system-images/android-34/google_apis/x86_64/source.properties',
    );
  });

  it('rejects a name that is not an sdkmanager package', () => {
    assert.throws(() => componentMarker('ndk;'), /not an sdkmanager package/);
    assert.throws(() => componentMarker('../etc;x'), /not an sdkmanager package/);
  });
});

describe('the retry budget', () => {
  it('is bounded (download step only, never tests)', () => {
    assert.ok(RETRY_DELAYS_S.length <= 3);
    assert.ok(DOWNLOAD_DELAYS_S.length <= 3);
  });
});

const sha = (c) => c.repeat(40);
const remote = (rev, channel, osList) => `
  <remotePackage path="emulator">
    <type-details xsi:type="generic:genericDetailsType"/>
    <revision><major>${rev[0]}</major><minor>${rev[1]}</minor><micro>${rev[2]}</micro></revision>
    <display-name>Android Emulator</display-name>
    <uses-license ref="android-sdk-license"/>
    <channelRef ref="${channel}"/>
    <archives>${osList
      .map(
        (os) => `<archive><complete><size>${os === 'linux' ? 1000 : 2000}</size>
      <checksum type="sha1">${os === 'linux' ? sha('a') : sha('b')}</checksum>
      <url>emulator-${os}-${rev.join('')}.zip</url></complete>
      <host-os>${os}</host-os></archive>`,
      )
      .join('')}</archives>
  </remotePackage>`;
const XML = `<repo:repository xmlns:generic="http://schemas.android.com/repository/android/generic/02">
  <license id="android-sdk-license" type="text">Terms &amp; Conditions</license>
  ${remote([37, 3, 3], 'channel-2', ['linux'])}
  ${remote([37, 2, 9], 'channel-0', ['linux', 'macosx'])}
  ${remote([37, 2, 12], 'channel-0', ['macosx', 'linux'])}
</repo:repository>`;

describe('resolveRemotePackage', () => {
  it('picks the highest STABLE revision and its linux archive facts', () => {
    const info = resolveRemotePackage(XML, 'emulator');
    assert.equal(info.revisionText, '37.2.12');
    assert.equal(info.size, 1000);
    assert.equal(info.sha1, sha('a'));
    assert.equal(info.url, 'emulator-linux-37212.zip');
    assert.equal(info.prefix, 'generic');
    assert.equal(resolveRemotePackage(XML, 'emulator', 'macosx').size, 2000);
  });

  it('fails loudly when the package, a stable channel or the archive is missing', () => {
    assert.throws(() => resolveRemotePackage(XML, 'platform-tools'), /no stable/);
    assert.throws(
      () => resolveRemotePackage(remote([1, 0, 0], 'channel-2', ['linux']), 'emulator'),
      /no stable/,
    );
    assert.throws(() => resolveRemotePackage(XML, 'emulator', 'windows'), /no complete windows/);
  });
});

describe('renderPackageXml', () => {
  it('writes the record sdkmanager reads: path, revision, license, namespaced details', () => {
    const xml = renderPackageXml(resolveRemotePackage(XML, 'emulator'));
    assert.match(xml, /<localPackage path="emulator" obsolete="false">/);
    assert.match(xml, /<major>37<\/major><minor>2<\/minor><micro>12<\/micro>/);
    assert.match(
      xml,
      /xmlns:generic="http:\/\/schemas.android.com\/repository\/android\/generic\/02"/,
    );
    assert.match(xml, /xsi:type="generic:genericDetailsType"/);
    assert.match(xml, /<uses-license ref="android-sdk-license"\/>/);
    assert.match(xml, /Terms &amp; Conditions/);
  });
});

describe('repositoryLocation', () => {
  it('sends system images to their tag directory and everything else to the main repository', () => {
    assert.equal(
      repositoryLocation('system-images;android-34;google_apis;x86_64').xml,
      'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml',
    );
    assert.equal(repositoryLocation('emulator').base, 'https://dl.google.com/android/repository/');
  });
});

describe('emulatorCacheKey', () => {
  const base = {
    os: 'Linux',
    imageOs: 'ubuntu24',
    salt: '1',
    packages: ['emulator', 'platform-tools'],
    cached: ['emulator'],
    resolved: { emulator: { revisionText: '37.2.12', sha1: sha('a') } },
  };
  it('is stable for identical inputs and names the runner image', () => {
    assert.equal(emulatorCacheKey(base), emulatorCacheKey({ ...base }));
    assert.match(emulatorCacheKey(base), /^android-emulator-Linux-ubuntu24-[0-9a-f]{16}$/);
  });
  it('changes with the package list, the salt, the image and a new upstream archive', () => {
    const k = emulatorCacheKey(base);
    assert.notEqual(k, emulatorCacheKey({ ...base, packages: ['emulator'] }));
    assert.notEqual(k, emulatorCacheKey({ ...base, salt: '2' }));
    assert.notEqual(k, emulatorCacheKey({ ...base, imageOs: 'ubuntu26' }));
    assert.notEqual(
      k,
      emulatorCacheKey({
        ...base,
        resolved: { emulator: { revisionText: '37.2.13', sha1: sha('c') } },
      }),
    );
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

  it('keeps the cached E2E packages within the installed list, in step with e2e.yml', () => {
    const { e2eEmulator } = JSON.parse(
      readFileSync(join(repoRoot, 'scripts/ci/android-sdk.json'), 'utf8'),
    );
    for (const p of e2eEmulator.cached) assert.ok(e2eEmulator.packages.includes(p), p);
    const workflow = readFileSync(join(repoRoot, '.github/workflows/e2e.yml'), 'utf8');
    const image = e2eEmulator.cached.find((p) => p.startsWith('system-images;'));
    const [, api, , abi] = image.split(';');
    assert.ok(workflow.includes(`api-level: ${api?.replace('android-', '')}`));
    assert.ok(workflow.includes(`arch: ${abi}`));
  });
});
