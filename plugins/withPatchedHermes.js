// @ts-check
/**
 * Android ships a patched Hermes (#648).
 *
 * GWP-ASan (on by default on Android 14+, and in CI's emulator) samples
 * allocations and records a frame-pointer backtrace when it does. Hermes's
 * fibers start on stacks set up by boost.context's make_fcontext, which leaves
 * a code address (x86_64) or garbage (arm64) where the frame-pointer chain
 * should end, so the walk runs off the fiber stack: SIGSEGV in
 * android_unsafe_frame_pointer_chase, about one full E2E run in four.
 * facebook/hermes 73f9af39b1 fixes it, but no 250829098.0.x release (the
 * Hermes line React Native 0.85 pins) contains it, so we build
 * com.facebook.hermes:hermes-android ourselves: the exact commit RN pins,
 * plus that patch (.github/workflows/hermes-android.yml), published once as
 * release assets and pinned by SHA-256 in plugins/patched-hermes/artifact.json.
 * GWP-ASan stays on.
 *
 * At prebuild (Android only) this plugin:
 * 1. refuses to run unless React Native still pins the Hermes version the
 *    patch was built for (a React Native bump must decide: rebuild the patch,
 *    or drop it once upstream ships the fix);
 * 2. fetches the pinned files (cached per release, checksum-verified) into a
 *    local Maven repository, android/patched-hermes/m2;
 * 3. makes that repository the ONLY source of com.facebook.hermes:hermes-android
 *    for every project (Gradle exclusiveContent), same coordinates, so React
 *    Native's own version pin still applies;
 * 4. adds verifyPatchedHermes<Variant>, which every APK/AAB packaging task
 *    depends on: each libhermesvm.so about to be packaged must have a pinned
 *    build-id and the patched make_fcontext, or the build fails.
 *
 * iOS is untouched: it has no GWP-ASan, and keeps React Native's prebuilt
 * hermes-engine. See docs/CI.md › Patched Hermes, which also says how to
 * remove all this once a React Native release brings the upstream fix.
 */
const {
  withAppBuildGradle,
  withDangerousMod,
  withProjectBuildGradle,
} = require('@expo/config-plugins');
const { readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const artifact = require('./patched-hermes/artifact.json');
const build = require('./patched-hermes/build.json');
const { materializeArtifact } = require('./patched-hermes/fetchArtifact');

const TAG = 'inukshuk-patched-hermes';
const BEGIN = `// @generated begin ${TAG} - plugins/withPatchedHermes.js (#648)`;
const END = `// @generated end ${TAG}`;
/** Relative to android/. */
const REPO_DIR = 'patched-hermes/m2';

/**
 * The Hermes V1 version React Native pins (sdks/hermes-engine/version.properties).
 * @param {string} versionProperties
 */
function pinnedHermesV1Version(versionProperties) {
  const m = /^HERMES_V1_VERSION_NAME=(.+)$/m.exec(versionProperties);
  return m?.[1]?.trim();
}

/**
 * @param {string | undefined} rnHermes  what React Native pins
 * @param {string} patched              what build.json built
 */
function assertSameHermes(rnHermes, patched) {
  if (rnHermes !== patched) {
    throw new Error(
      `withPatchedHermes: React Native now pins Hermes ${rnHermes ?? '(unknown)'}, but the patched ` +
        `Hermes in plugins/patched-hermes was built from ${patched} (#648). If the new Hermes ` +
        'contains facebook/hermes 73f9af39b1, delete the patched Hermes (docs/CI.md › Patched ' +
        'Hermes); otherwise rebuild it for the new version (build.json, new releaseTag).',
    );
  }
}

/**
 * Replaces a previous generated block, if any, with `block` (idempotent).
 * @param {string} src
 */
function stripBlock(src) {
  const start = src.indexOf(BEGIN);
  if (start === -1) return src;
  const end = src.indexOf(END, start);
  if (end === -1) throw new Error(`withPatchedHermes: unterminated ${TAG} block`);
  const lineStart = src.lastIndexOf('\n', start) + 1;
  const lineEnd = src.indexOf('\n', end);
  return src.slice(0, lineStart) + src.slice(lineEnd === -1 ? src.length : lineEnd + 1);
}

/**
 * android/build.gradle: the exclusive repository, first in allprojects { repositories { } }.
 * @param {string} src
 */
function addExclusiveHermesRepository(src) {
  const clean = stripBlock(src);
  const all = /allprojects\s*\{/.exec(clean);
  const repos = all ? /repositories\s*\{[^\n]*\n/.exec(clean.slice(all.index)) : null;
  if (!all || !repos) {
    throw new Error(
      'withPatchedHermes: no `allprojects { repositories { … } }` in android/build.gradle — the template changed; update plugins/withPatchedHermes.js',
    );
  }
  const at = all.index + repos.index + repos[0].length;
  const block = [
    `    ${BEGIN}`,
    '    // Patched Hermes (GWP-ASan fiber fix): hermes-android comes ONLY from here.',
    '    exclusiveContent {',
    '      forRepository {',
    '        maven {',
    '          name = "inukshukPatchedHermes"',
    `          url = uri("\${rootDir}/${REPO_DIR}")`,
    '        }',
    '      }',
    '      filter { includeModule("com.facebook.hermes", "hermes-android") }',
    '    }',
    `    ${END}`,
    '',
  ].join('\n');
  return clean.slice(0, at) + block + clean.slice(at);
}

/**
 * android/app/build.gradle: verifyPatchedHermes<Variant>, a dependency of
 * every APK and AAB packaging task.
 * @param {string} src
 */
function addPackagedHermesCheck(src) {
  const clean = stripBlock(src).replace(/\s*$/, '\n');
  const block = [
    BEGIN,
    '// Every libhermesvm.so about to be packaged must be the patched Hermes pinned in',
    '// plugins/patched-hermes/artifact.json (build-id + the patched make_fcontext), or the',
    '// build fails here: it can never quietly fall back to the prebuilt Hermes.',
    'def inukshukHermesCheck = new File(rootDir, "../plugins/patched-hermes/verify-hermes.js").canonicalPath',
    'androidComponents {',
    '  onVariants(selector().all()) { variant ->',
    '    def v = variant.name.substring(0, 1).toUpperCase() + variant.name.substring(1)',
    '    def merged = layout.buildDirectory.dir("intermediates/merged_native_libs/${variant.name}").get().asFile',
    '    def check = tasks.register("verifyPatchedHermes${v}", Exec) {',
    '      group = "verification"',
    '      description = "Fails unless the packaged libhermesvm.so is the patched Hermes (#648)."',
    '      dependsOn("merge${v}NativeLibs")',
    '      commandLine("node", inukshukHermesCheck, "packaged", merged.absolutePath)',
    '    }',
    '    tasks.matching { it.name == "package${v}" || it.name == "package${v}Bundle" }.configureEach {',
    '      dependsOn(check)',
    '    }',
    '  }',
    '}',
    END,
    '',
  ].join('\n');
  return `${clean}\n${block}`;
}

/** @type {import('@expo/config-plugins').ConfigPlugin} */
const withPatchedHermes = (config) => {
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const { projectRoot, platformProjectRoot } = cfg.modRequest;
      const rnDir = dirname(require.resolve('react-native/package.json', { paths: [projectRoot] }));
      const props = readFileSync(join(rnDir, 'sdks/hermes-engine/version.properties'), 'utf8');
      assertSameHermes(pinnedHermesV1Version(props), build.version);
      await materializeArtifact(artifact, join(platformProjectRoot, REPO_DIR));
      return cfg;
    },
  ]);
  config = withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withPatchedHermes: android/build.gradle is not Groovy');
    }
    cfg.modResults.contents = addExclusiveHermesRepository(cfg.modResults.contents);
    return cfg;
  });
  config = withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withPatchedHermes: android/app/build.gradle is not Groovy');
    }
    cfg.modResults.contents = addPackagedHermesCheck(cfg.modResults.contents);
    return cfg;
  });
  return config;
};

module.exports = withPatchedHermes;
module.exports.addExclusiveHermesRepository = addExclusiveHermesRepository;
module.exports.addPackagedHermesCheck = addPackagedHermesCheck;
module.exports.assertSameHermes = assertSameHermes;
module.exports.pinnedHermesV1Version = pinnedHermesV1Version;
