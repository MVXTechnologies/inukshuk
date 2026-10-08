/**
 * The Android SDK components a Gradle build of the app needs, worked out
 * BEFORE Gradle runs so CI can install them in one logged, retried step
 * (android-sdk.mjs) and then build with AGP's implicit downloads turned off
 * (-Pandroid.builder.sdkDownload=false).
 *
 * Why: left to itself, AGP downloads a missing NDK or CMake in the middle of
 * the build, without retrying. A truncated download ("Error on ZipFile
 * unknown archive", ndk;27.0.12077973, 2026-10-07) or a refused one (cmake;
 * 3.22.1) then failed a 20-minute build with no second chance.
 *
 * Two sources:
 * - React Native's version catalog (node_modules/react-native/gradle/
 *   libs.versions.toml): compileSdk, buildTools, ndkVersion — what the app and
 *   every library that reads rootProject.ext ask for.
 * - AGP's own defaults, for libraries that set no ndkVersion / CMake version
 *   (@dr.pogodin/react-native-static-server, react-native-nitro-modules'
 *   CMake). These are not readable from any file we have, so they are pinned
 *   per AGP version in android-sdk.json; an AGP bump without a matching entry
 *   fails here, in seconds, with the remedy.
 */

import { createHash } from 'node:crypto';

/** Reads `key = "value"` pairs from the [versions] table of a Gradle version catalog. */
export function parseVersionCatalog(toml) {
  const versions = {};
  let inVersions = false;
  for (const raw of toml.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      inVersions = table[1] === 'versions';
      continue;
    }
    if (!inVersions) continue;
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (pair && pair[1] !== undefined && pair[2] !== undefined) versions[pair[1]] = pair[2];
  }
  return versions;
}

/**
 * sdkmanager package names, deduplicated, in a stable order.
 * Throws when the catalog lacks a needed key or the AGP version has no
 * pinned defaults.
 */
export function requiredComponents(catalog, pins) {
  for (const key of ['compileSdk', 'buildTools', 'ndkVersion', 'agp']) {
    if (!catalog[key]) {
      throw new Error(`react-native's libs.versions.toml has no "${key}" version`);
    }
  }
  const defaults = pins.agpDefaults?.[catalog.agp];
  if (!defaults?.ndk || !defaults?.cmake) {
    const known = Object.keys(pins.agpDefaults ?? {}).join(', ') || 'none';
    throw new Error(
      `no pinned NDK/CMake defaults for AGP ${catalog.agp} (pinned: ${known}). ` +
        `Add an entry to scripts/ci/android-sdk.json: AGP's default NDK is ` +
        `SdkConstants.NDK_DEFAULT_VERSION and its default CMake is 3.22.1 unless ` +
        `its release notes say otherwise.`,
    );
  }
  const components = [
    `platforms;android-${catalog.compileSdk}`,
    `build-tools;${catalog.buildTools}`,
    `ndk;${catalog.ndkVersion}`,
    `ndk;${defaults.ndk}`,
    `cmake;${defaults.cmake}`,
  ];
  return [...new Set(components)];
}

/**
 * The directory, relative to the SDK root, that proves a component is
 * installed (sdkmanager writes source.properties last). Package paths map
 * one-to-one onto directories: `ndk;27.1.x` → ndk/27.1.x, `emulator` →
 * emulator, `system-images;android-34;google_apis;x86_64` →
 * system-images/android-34/google_apis/x86_64.
 */
export function componentMarker(component) {
  const parts = component.split(';');
  if (parts.some((p) => !/^[A-Za-z0-9._-]+$/.test(p))) {
    throw new Error(`not an sdkmanager package name: ${component}`);
  }
  return `${parts.join('/')}/source.properties`;
}

/**
 * Retry schedule for the download step: attempt i (0-based) waits
 * delays[i - 1] seconds first. Bounded on purpose — a mirror that is down for
 * minutes should fail the job loudly, not stall it.
 */
export const RETRY_DELAYS_S = [15, 45];

/**
 * Backoff between attempts to fetch ONE file (a repository XML or an SDK zip),
 * which resumes where the last attempt stopped. Bounded: 4 attempts in all.
 */
export const DOWNLOAD_DELAYS_S = [10, 30, 60];

const REPOSITORY = 'https://dl.google.com/android/repository/';

/**
 * Where Google publishes the metadata (and, relative to `base`, the zip) for a
 * package: the main repository for the emulator, `sys-img/<tag>/` for system
 * images (`system-images;android-34;google_apis;x86_64`).
 */
export function repositoryLocation(pkg) {
  const parts = pkg.split(';');
  if (parts[0] === 'system-images') {
    const imageTag = parts[2];
    if (!imageTag) throw new Error(`not a system-image package: ${pkg}`);
    const base = `${REPOSITORY}sys-img/${imageTag}/`;
    return { xml: `${base}sys-img2-3.xml`, base };
  }
  return { xml: `${REPOSITORY}repository2-3.xml`, base: REPOSITORY };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tag = (xml, name) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1];

function revisionOf(block) {
  const rev = /<revision>([\s\S]*?)<\/revision>/.exec(block)?.[1] ?? '';
  const parts = ['major', 'minor', 'micro']
    .map((n) => tag(rev, n))
    .filter((v) => v !== undefined)
    .map(Number);
  return parts.length > 0 && parts.every(Number.isInteger) ? parts : null;
}

function compareRevisions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * What the SDK repository XML says about the STABLE (channel-0, the channel
 * sdkmanager uses by default) archive of `pkg` for `hostOs`: its revision,
 * size, sha1 and zip URL — the facts a download is verified against — plus the
 * pieces needed to write the package.xml sdkmanager expects beside an unzipped
 * package. Where several revisions are published, the highest wins. Throws if
 * the XML has no such package or archive.
 */
export function resolveRemotePackage(xml, pkg, hostOs = 'linux') {
  const re = new RegExp(
    `<remotePackage path="${escapeRe(pkg)}"[^>]*>([\\s\\S]*?)</remotePackage>`,
    'g',
  );
  let best = null;
  for (const m of xml.matchAll(re)) {
    const block = m[1] ?? '';
    if (!/<channelRef ref="channel-0"\s*\/>/.test(block)) continue;
    const revision = revisionOf(block);
    if (revision && (!best || compareRevisions(revision, best.revision) > 0)) {
      best = { block, revision };
    }
  }
  if (!best) throw new Error(`${pkg}: no stable (channel-0) package in the repository XML`);

  const archive = [...best.block.matchAll(/<archive>([\s\S]*?)<\/archive>/g)]
    .map((a) => a[1] ?? '')
    .find((a) => (tag(a, 'host-os') ?? hostOs) === hostOs);
  const complete = /<complete>([\s\S]*?)<\/complete>/.exec(archive ?? '')?.[1] ?? '';
  const size = Number(tag(complete, 'size'));
  const sha1 = /<checksum type="sha1">\s*([0-9a-f]{40})\s*<\/checksum>/i.exec(complete)?.[1];
  const url = tag(complete, 'url');
  if (!Number.isInteger(size) || size <= 0 || !sha1 || !url) {
    throw new Error(`${pkg}: no complete ${hostOs} archive with size + sha1 + url in the XML`);
  }

  const licenseId = /<uses-license ref="([^"]+)"/.exec(best.block)?.[1];
  const license = licenseId
    ? new RegExp(`<license id="${escapeRe(licenseId)}"[^>]*>[\\s\\S]*?</license>`).exec(xml)?.[0]
    : undefined;
  if (!licenseId || !license) throw new Error(`${pkg}: license element not found in the XML`);

  const details = /<type-details[\s\S]*?(?:\/>|<\/type-details>)/.exec(best.block)?.[0];
  const prefix = /xsi:type="([^":]+):/.exec(details ?? '')?.[1];
  const namespace = prefix
    ? new RegExp(`xmlns:${escapeRe(prefix)}="([^"]+)"`).exec(xml)?.[1]
    : undefined;
  if (!details || (prefix && !namespace)) {
    throw new Error(`${pkg}: type-details (or its namespace) not found in the XML`);
  }

  return {
    path: pkg,
    revision: best.revision,
    revisionText: best.revision.join('.'),
    displayName: tag(best.block, 'display-name') ?? pkg,
    size,
    sha1: sha1.toLowerCase(),
    url,
    licenseId,
    license,
    details,
    prefix,
    namespace,
  };
}

/**
 * The package.xml sdkmanager writes next to every package it installs. Without
 * it a package unzipped by hand is "not installed" to sdkmanager, so the
 * emulator-runner action would download it again; the direct-download path
 * writes the same record: path, revision, display name, license, details.
 */
export function renderPackageXml(info) {
  const [major, minor, micro] = info.revision;
  const rev =
    `<major>${major}</major>` +
    (minor === undefined ? '' : `<minor>${minor}</minor>`) +
    (micro === undefined ? '' : `<micro>${micro}</micro>`);
  const ns = info.prefix ? ` xmlns:${info.prefix}="${info.namespace}"` : '';
  const details = info.details.replace(
    /^<type-details/,
    `<type-details xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"${ns}`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<ns2:repository xmlns:ns2="http://schemas.android.com/repository/android/common/02">',
    `    ${info.license}`,
    `    <localPackage path="${info.path}" obsolete="false">`,
    `        ${details}`,
    `        <revision>${rev}</revision>`,
    `        <display-name>${info.displayName}</display-name>`,
    `        <uses-license ref="${info.licenseId}"/>`,
    '    </localPackage>',
    '</ns2:repository>',
    '',
  ].join('\n');
}

/**
 * The actions/cache key for the cached emulator packages: the exact package
 * list, the runner image OS, a hand-bumped salt and the repository's current
 * revision + sha1 of each cached package. A new emulator release is therefore
 * a new key (a miss that downloads the new one, verified) rather than a stale
 * copy that the emulator-runner action would try to update through sdkmanager.
 */
export function emulatorCacheKey({ os, imageOs, salt, packages, cached, resolved }) {
  const material = [
    `salt=${salt}`,
    `packages=${packages.join(',')}`,
    ...cached.map((p) => `${p}=${resolved[p]?.revisionText}:${resolved[p]?.sha1}`),
  ].join('\n');
  const digest = createHash('sha256').update(material).digest('hex').slice(0, 16);
  return `android-emulator-${os}-${imageOs}-${digest}`;
}
