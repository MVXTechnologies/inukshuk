#!/usr/bin/env node
/**
 * Installs the Android SDK components a Gradle build of the app needs (see
 * androidSdk.mjs) before Gradle runs, so the build itself can forbid
 * downloads (-Pandroid.builder.sdkDownload=false) and never fetches an NDK
 * mid-build.
 *
 *   node scripts/ci/android-sdk.mjs components    one sdkmanager package per line
 *   node scripts/ci/android-sdk.mjs cache-paths   absolute dirs worth caching (NDKs, CMake)
 *   node scripts/ci/android-sdk.mjs outputs       `paths` + `key` for $GITHUB_OUTPUT
 *   node scripts/ci/android-sdk.mjs install       install what is missing, verify all
 *   node scripts/ci/android-sdk.mjs install <pkg…> the same for exactly these packages
 *
 * `install` retries ONLY the download, a bounded number of times
 * (RETRY_DELAYS_S), and says so with a ::warning:: annotation each time, so a
 * flaky mirror is visible on a green run. It then checks every component's
 * source.properties (written last by sdkmanager) and fails with ::error::
 * naming whatever is still missing — sdkmanager itself can exit 0 after
 * "An error occurred while preparing SDK package".
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RETRY_DELAYS_S,
  componentMarker,
  parseVersionCatalog,
  requiredComponents,
} from './androidSdk.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function components() {
  const toml = readFileSync(
    join(repoRoot, 'node_modules/react-native/gradle/libs.versions.toml'),
    'utf8',
  );
  const pins = JSON.parse(readFileSync(join(repoRoot, 'scripts/ci/android-sdk.json'), 'utf8'));
  return requiredComponents(parseVersionCatalog(toml), pins);
}

function sdkRoot() {
  const root = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!root) throw new Error('ANDROID_HOME is not set (run android-actions/setup-android first)');
  return root;
}

/** The NDK and CMake dirs: the large, slow downloads worth caching. */
const cachePaths = () =>
  components()
    .filter((c) => c.startsWith('ndk;') || c.startsWith('cmake;'))
    .map((c) => join(sdkRoot(), dirname(componentMarker(c))));

const missing = (root, list) => list.filter((c) => !existsSync(join(root, componentMarker(c))));

function sleep(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function install(wanted) {
  const root = sdkRoot();
  process.stdout.write(`Required: ${wanted.join(', ')}\n`);
  let todo = missing(root, wanted);
  for (let attempt = 0; todo.length > 0 && attempt <= RETRY_DELAYS_S.length; attempt++) {
    if (attempt > 0) {
      const wait = RETRY_DELAYS_S[attempt - 1] ?? 0;
      process.stdout.write(
        `::warning title=Android SDK download retried::attempt ${attempt + 1} for ${todo.join(', ')} in ${wait}s\n`,
      );
      sleep(wait);
    }
    process.stdout.write(`sdkmanager --install ${todo.join(' ')} (attempt ${attempt + 1})\n`);
    // sdkmanager is on PATH after android-actions/setup-android. Licenses are
    // accepted there; the `y`s answer any prompt for a new one.
    spawnSync('sdkmanager', ['--install', ...todo], {
      input: 'y\n'.repeat(32),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    todo = missing(root, todo);
  }
  if (todo.length > 0) {
    process.stdout.write(
      `::error title=Android SDK components missing::${todo.join(', ')} could not be installed after ${RETRY_DELAYS_S.length + 1} attempts\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`All ${wanted.length} components present under ${root}.\n`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'components') {
    process.stdout.write(`${components().join('\n')}\n`);
  } else if (command === 'cache-paths') {
    process.stdout.write(`${cachePaths().join('\n')}\n`);
  } else if (command === 'outputs') {
    // For $GITHUB_OUTPUT: `paths` (multi-line) and `key` for actions/cache.
    const list = components();
    const digest = createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 16);
    const os = process.env.RUNNER_OS || process.platform;
    process.stdout.write(`paths<<EOF_PATHS\n${cachePaths().join('\n')}\nEOF_PATHS\n`);
    process.stdout.write(`key=android-sdk-${os}-${digest}\n`);
  } else if (command === 'install') {
    // No arguments: what the Gradle build needs. With arguments: exactly those
    // packages (e2e.yml pre-installs the emulator and its system image this
    // way, so reactivecircus/android-emulator-runner finds them in place).
    install(rest.length > 0 ? rest : components());
  } else {
    process.stderr.write(
      'usage: android-sdk.mjs components | cache-paths | outputs | install [pkg…]\n',
    );
    process.exitCode = 2;
  }
} catch (err) {
  process.stderr.write(`android-sdk: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
