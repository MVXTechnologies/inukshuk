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
 * installed (sdkmanager writes source.properties last).
 */
export function componentMarker(component) {
  const [kind, version] = component.split(';');
  if (!kind || !version) throw new Error(`not an sdkmanager package name: ${component}`);
  return `${kind}/${version}/source.properties`;
}

/**
 * Retry schedule for the download step: attempt i (0-based) waits
 * delays[i - 1] seconds first. Bounded on purpose — a mirror that is down for
 * minutes should fail the job loudly, not stall it.
 */
export const RETRY_DELAYS_S = [15, 45];
