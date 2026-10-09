/**
 * @jest-environment node
 */
const { describe, expect, it } = require('@jest/globals');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const artifact = require('./patched-hermes/artifact.json');
const build = require('./patched-hermes/build.json');
const {
  addExclusiveHermesRepository,
  addPackagedHermesCheck,
  assertSameHermes,
  pinnedHermesV1Version,
} = require('./withPatchedHermes');

/** android/build.gradle as the SDK 56 template (expo-template-bare-minimum 56.0.37) has it. */
const SDK56_ROOT_BUILD_GRADLE = `// Top-level build file where you can add configuration options common to all sub-projects/modules.

buildscript {
  repositories {
    google()
    mavenCentral()
  }
  dependencies {
    classpath('com.android.tools.build:gradle')
    classpath('com.facebook.react:react-native-gradle-plugin')
    classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')
  }
}

allprojects {
  repositories {
    google()
    mavenCentral()
    maven { url 'https://www.jitpack.io' }
  }
}

apply plugin: "expo-root-project"
apply plugin: "com.facebook.react.rootproject"
`;

describe('React Native still pins the Hermes the patch was built for', () => {
  it('reads HERMES_V1_VERSION_NAME', () => {
    expect(
      pinnedHermesV1Version('HERMES_VERSION_NAME=0.16.0\nHERMES_V1_VERSION_NAME=250829098.0.10\n'),
    ).toBe('250829098.0.10');
    expect(pinnedHermesV1Version('HERMES_VERSION_NAME=0.16.0\n')).toBeUndefined();
  });

  // A React Native bump that moves Hermes fails HERE, in npm run check, not
  // only at prebuild: rebuild the patch for the new Hermes, or delete it if
  // that Hermes contains facebook/hermes 73f9af39b1 (docs/CI.md › Patched Hermes).
  it('matches the installed react-native', () => {
    const props = readFileSync(
      join(
        require.resolve('react-native/package.json'),
        '..',
        'sdks/hermes-engine/version.properties',
      ),
      'utf8',
    );
    expect(pinnedHermesV1Version(props)).toBe(build.version);
    expect(() => assertSameHermes(pinnedHermesV1Version(props), build.version)).not.toThrow();
  });

  it('refuses another version, saying what to do', () => {
    expect(() => assertSameHermes('250829098.0.11', '250829098.0.10')).toThrow(
      /pins Hermes 250829098\.0\.11.*built from 250829098\.0\.10.*73f9af39b1/,
    );
    expect(() => assertSameHermes(undefined, '250829098.0.10')).toThrow('(unknown)');
  });
});

describe('pins', () => {
  it('build.json pins the patch file byte for byte', () => {
    for (const p of build.patches) {
      const text = readFileSync(require.resolve(`./patched-hermes/${p.file}`));
      expect(createHash('sha256').update(text).digest('hex')).toBe(p.sha256);
      expect(text.toString('utf8')).toContain(`From ${p.upstreamCommit}`);
    }
  });

  it('artifact.json describes the build in build.json', () => {
    expect(artifact.version).toBe(build.version);
    expect(artifact.releaseTag).toBe(build.releaseTag);
    expect(artifact.mavenPath).toBe(`com/facebook/hermes/hermes-android/${build.version}`);
  });

  it('the app config applies the plugin', () => {
    const appConfig = readFileSync(require.resolve('../app.config.ts'), 'utf8');
    expect(appConfig).toContain("'./plugins/withPatchedHermes'");
  });
});

describe('android/build.gradle', () => {
  it('makes the local repository the only source of hermes-android, for every project', () => {
    const out = addExclusiveHermesRepository(SDK56_ROOT_BUILD_GRADLE);
    const all = out.indexOf('allprojects {');
    const block = out.indexOf('exclusiveContent {');
    expect(block).toBeGreaterThan(all);
    expect(out.indexOf('google()', all)).toBeGreaterThan(block);
    expect(out).toContain('url = uri("${rootDir}/patched-hermes/m2")');
    expect(out).toContain('includeModule("com.facebook.hermes", "hermes-android")');
    // The buildscript repositories are left alone.
    expect(out.slice(0, all)).toBe(SDK56_ROOT_BUILD_GRADLE.slice(0, all));
  });

  it('is idempotent', () => {
    const once = addExclusiveHermesRepository(SDK56_ROOT_BUILD_GRADLE);
    expect(addExclusiveHermesRepository(once)).toBe(once);
  });

  it('fails loudly if the template no longer has allprojects.repositories', () => {
    expect(() => addExclusiveHermesRepository('buildscript {\n  repositories {\n  }\n}\n')).toThrow(
      'template changed',
    );
  });
});

describe('android/app/build.gradle', () => {
  const APP = 'apply plugin: "com.android.application"\nandroid {\n}\n';

  it('makes every APK and AAB packaging task depend on the patched-Hermes check', () => {
    const out = addPackagedHermesCheck(APP);
    expect(out.startsWith(APP)).toBe(true);
    expect(out).toContain('tasks.register("verifyPatchedHermes${v}", Exec)');
    expect(out).toContain('dependsOn("merge${v}NativeLibs")');
    expect(out).toContain('it.name == "package${v}" || it.name == "package${v}Bundle"');
    expect(out).toContain('"../plugins/patched-hermes/verify-hermes.js"');
    expect(out).toContain('"packaged"');
  });

  it('is idempotent', () => {
    const once = addPackagedHermesCheck(APP);
    expect(addPackagedHermesCheck(once)).toBe(once);
  });
});
