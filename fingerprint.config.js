/**
 * What the runtime fingerprint (app.config.ts `runtimeVersion.policy:
 * 'fingerprint'`) deliberately does NOT hash.
 *
 * The fingerprint must come out identical in two places: on the EAS build
 * worker, where it is stamped into the binary, and on the GitHub runner that
 * publishes an OTA update (ota-update.yml). Anything that differs between
 * those two without changing the native app would give the update a runtime
 * no binary has — it would publish fine and reach nobody. So:
 *
 * - `ExpoConfigExtraSection`: `extra` is read by JS at run time from the
 *   update's own manifest, never compiled into native code, and it is filled
 *   from the environment (STRAVA_*, ERROR_REPORT_*). A secret present on one
 *   machine and not the other must not move the runtime.
 * - `ExpoConfigVersions`: `version`, `ios.buildNumber` and
 *   `android.versionCode` label a binary; they do not change what JS can call
 *   in it. Hashed, every release — even a JS-only one, even an iOS-only
 *   build-number bump — would cut both platforms' installs off from OTA fixes
 *   until they updated from the store.
 * - `PackageJsonScriptsAll`: npm scripts (`release:bump`, `test:ci`, …) are
 *   tooling. The one build hook, `eas-build-pre-install`, only installs CMake
 *   on the worker (scripts/eas-pre-install.sh); what it builds is hashed
 *   through the dependency itself.
 * - `GitIgnore`: a new scratch-folder entry must not orphan the runtime.
 *   Whether `ios/` and `android/` are generated is still read from it; it is
 *   just not hashed.
 *
 * - `ignorePaths`: the Convert module's build OUTPUTS (PROJ static libs,
 *   proj.db, the two bundled grids) exist only where a native build ran
 *   (`modules/inukshuk-proj/scripts/prepare.sh`), never on the OTA runner.
 *   What they are is pinned by the build script itself (versions + sha256),
 *   which IS hashed with the rest of modules/.
 *
 * Everything else stays in: native packages, autolinking, config plugins
 * (plugins/*), modules/, eas.json, the icon and splash assets, and every
 * other key of the Expo config. `.fingerprintignore` is not needed — docs/,
 * playground/, store/, .maestro/ and scripts/ are never fingerprint sources.
 *
 * Check what is hashed with
 * `npx expo-updates fingerprint:generate --platform ios` (or android).
 * Entries are SourceSkips names; a misspelt one is silently ignored by
 * @expo/fingerprint, which is why scripts/ci/fingerprintConfig.test.mjs
 * checks them.
 *
 * @type {import('expo/fingerprint').Config}
 */
const config = {
  sourceSkips: [
    'ExpoConfigExtraSection',
    'ExpoConfigVersions',
    'PackageJsonScriptsAll',
    'GitIgnore',
  ],
  ignorePaths: ['modules/inukshuk-proj/prebuilt/**', 'modules/inukshuk-proj/assets/**'],
};

module.exports = config;
