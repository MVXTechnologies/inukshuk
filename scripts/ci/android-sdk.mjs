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
 *   node scripts/ci/android-sdk.mjs emulator-outputs  `paths` + `key` of the cached emulator packages
 *   node scripts/ci/android-sdk.mjs install-e2e   install the E2E emulator packages (android-sdk.json)
 *
 * `install` retries ONLY the download, a bounded number of times
 * (RETRY_DELAYS_S), and says so with a ::warning:: annotation each time, so a
 * flaky mirror is visible on a green run. It then checks every component's
 * source.properties (written last by sdkmanager) and fails with ::error::
 * naming whatever is still missing — sdkmanager itself can exit 0 after
 * "An error occurred while preparing SDK package".
 *
 * The emulator and its system image are not left to sdkmanager's downloader
 * (it failed three bounded attempts in a row with a corrupt emulator zip,
 * 2026-10-08, #650). On a cache miss they are fetched straight from Google
 * with curl, resumed across bounded attempts, checked against the size and
 * sha1 in the repository XML BEFORE unzipping, and registered with a
 * package.xml. Anything that goes wrong there is a ::warning:: and falls back
 * to the sdkmanager path above, so this can only add certainty.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

// Logs go to stderr in `emulator-outputs`, whose stdout is $GITHUB_OUTPUT.
let logStream = process.stdout;
const log = (msg) => logStream.write(`${msg}\n`);
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

function e2ePins() {
  const pins = JSON.parse(readFileSync(join(repoRoot, 'scripts/ci/android-sdk.json'), 'utf8'));
  const e2e = pins.e2eEmulator;
  if (!e2e?.packages?.length || !e2e.cached?.length || !e2e.cacheSalt) {
    throw new Error('scripts/ci/android-sdk.json has no complete "e2eEmulator" entry');
  }
  return e2e;
}

/** curl with a bounded, logged retry per file; `-C -` resumes a partial download. */
function curl(label, url, dest, expectedSize = -1) {
  let lastStatus = null;
  for (let attempt = 0; attempt <= DOWNLOAD_DELAYS_S.length; attempt++) {
    if (attempt > 0) {
      const wait = DOWNLOAD_DELAYS_S[attempt - 1] ?? 0;
      log(
        `::warning title=Android SDK download retried::${label}: attempt ${attempt + 1} of ${DOWNLOAD_DELAYS_S.length + 1} in ${wait}s (last curl status ${lastStatus})`,
      );
      sleep(wait);
    }
    const have = existsSync(dest) ? statSync(dest).size : 0;
    if (have === expectedSize) return true; // already complete: curl would get a 416
    log(`curl ${label} (attempt ${attempt + 1}, resuming at ${mb(have)})`);
    const r = spawnSync(
      'curl',
      [
        '-fL',
        '--silent',
        '--show-error',
        '--connect-timeout',
        '20',
        // Abort a stalled transfer (under 100 KB/s for a minute) so the next
        // attempt can resume it, instead of hanging until the job times out.
        '--speed-limit',
        '100000',
        '--speed-time',
        '60',
        '-C',
        '-',
        '-o',
        dest,
        url,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    lastStatus = r.status;
    // 33 = range not satisfiable: the file on disk is already complete.
    if (r.status === 0 || r.status === 33) return true;
  }
  return false;
}

/** sha1 of a file, streamed (the system image is ~1 GB). */
function sha1File(path) {
  const hash = createHash('sha1');
  const buf = Buffer.alloc(8 * 1048576);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

const xmlCache = new Map();

/** The repository XML for a package, fetched once per process with bounded retries. */
function repositoryXml(pkg, workDir) {
  const { xml, base } = repositoryLocation(pkg);
  if (!xmlCache.has(xml)) {
    mkdirSync(workDir, { recursive: true });
    const dest = join(workDir, `${createHash('sha1').update(xml).digest('hex').slice(0, 8)}.xml`);
    rmSync(dest, { force: true });
    if (!curl(`repository XML ${xml}`, xml, dest)) throw new Error(`could not fetch ${xml}`);
    xmlCache.set(xml, readFileSync(dest, 'utf8'));
  }
  return { text: xmlCache.get(xml), base };
}

function resolvePackage(pkg, workDir) {
  const { text, base } = repositoryXml(pkg, workDir);
  return { ...resolveRemotePackage(text, pkg), base };
}

/**
 * Downloads `pkg` straight from Google, verifies it, unzips it and registers
 * it. Throws on any failure, after cleaning up after itself.
 */
function directInstall(root, pkg) {
  const work = join(root, '.temp', 'direct-install');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const info = resolvePackage(pkg, work);
    log(
      `${pkg}: stable revision ${info.revisionText}, ${mb(info.size)}, sha1 ${info.sha1}, ${info.base}${info.url}`,
    );
    const zip = join(work, 'package.zip');
    for (let fetch = 1; ; fetch++) {
      if (!curl(`${pkg} (${mb(info.size)})`, `${info.base}${info.url}`, zip, info.size)) {
        throw new Error(`download failed after ${DOWNLOAD_DELAYS_S.length + 1} attempts`);
      }
      const size = statSync(zip).size;
      const sha1 = size === info.size ? sha1File(zip) : null;
      if (size === info.size && sha1 === info.sha1) {
        log(`${pkg}: size ${size} and sha1 ${sha1} match the repository XML`);
        break;
      }
      // Wrong size or hash: what is on disk is corrupt (a resume cannot fix
      // it), so start the file over, once. Never unzip it.
      log(
        `::warning title=Android SDK archive failed verification::${pkg}: got ${size} bytes sha1 ${sha1 ?? 'n/a (size differs)'}, expected ${info.size} bytes sha1 ${info.sha1}`,
      );
      rmSync(zip, { force: true });
      if (fetch >= 2) throw new Error('archive failed verification twice');
    }
    const test = spawnSync('unzip', ['-tq', zip], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (test.status !== 0) throw new Error(`unzip -t failed (status ${test.status})`);
    const staged = join(work, 'unzipped');
    mkdirSync(staged);
    const unzip = spawnSync('unzip', ['-q', zip, '-d', staged], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (unzip.status !== 0) throw new Error(`unzip failed (status ${unzip.status})`);
    rmSync(zip, { force: true });
    const tops = readdirSync(staged);
    const top = tops[0];
    if (tops.length !== 1 || !top) throw new Error(`expected one top-level dir, got ${tops}`);
    if (!existsSync(join(staged, top, 'source.properties'))) {
      throw new Error(`${top}/source.properties missing from the archive`);
    }
    const dest = join(root, dirname(componentMarker(pkg)));
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(join(staged, top), dest);
    writeFileSync(join(dest, 'package.xml'), renderPackageXml(info));
    // sdkmanager must now see the package as installed, or the emulator-runner
    // action would fetch it again through the very downloader we avoided.
    const listed = spawnSync('sdkmanager', ['--list_installed'], { encoding: 'utf8' });
    if (listed.status !== 0 || !listed.stdout.includes(pkg)) {
      rmSync(dest, { recursive: true, force: true });
      throw new Error(`sdkmanager --list_installed does not list ${pkg} after the direct install`);
    }
    log(`${pkg}: installed ${info.revisionText} into ${dest} and registered with sdkmanager`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Packages worth the direct path: the two big, flaky ones. */
const isDirect = (pkg) => pkg === 'emulator' || pkg.startsWith('system-images;');

function reportPresent(root, list) {
  for (const c of list) {
    const props = join(root, componentMarker(c));
    if (!existsSync(props)) continue;
    const rev = /^Pkg\.Revision=(.*)$/m.exec(readFileSync(props, 'utf8'))?.[1] ?? '?';
    log(`present: ${c} (Pkg.Revision=${rev}), restored from cache or already installed`);
  }
}

function install(wanted) {
  const root = sdkRoot();
  process.stdout.write(`Required: ${wanted.join(', ')}\n`);
  reportPresent(root, wanted);
  for (const pkg of missing(root, wanted).filter(isDirect)) {
    try {
      directInstall(root, pkg);
    } catch (err) {
      log(
        `::warning title=Direct Android SDK download failed::${pkg}: ${err instanceof Error ? err.message : String(err)}; falling back to sdkmanager`,
      );
    }
  }
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
  } else if (command === 'emulator-outputs') {
    // For $GITHUB_OUTPUT: the cached emulator packages' dirs and their key.
    logStream = process.stderr;
    const e2e = e2ePins();
    const work = join(process.env.RUNNER_TEMP || process.env.TMPDIR || '/tmp', 'android-key');
    const resolved = {};
    for (const p of e2e.cached) resolved[p] = resolvePackage(p, work);
    const key = emulatorCacheKey({
      os: process.env.RUNNER_OS || process.platform,
      imageOs: process.env.ImageOS || 'unknown-image',
      salt: e2e.cacheSalt,
      packages: e2e.packages,
      cached: e2e.cached,
      resolved,
    });
    const dirs = e2e.cached.map((p) => join(sdkRoot(), dirname(componentMarker(p))));
    process.stderr.write(
      `Resolved: ${e2e.cached.map((p) => `${p}@${resolved[p]?.revisionText}`).join(', ')}\n`,
    );
    process.stdout.write(`paths<<EOF_PATHS\n${dirs.join('\n')}\nEOF_PATHS\n`);
    process.stdout.write(`key=${key}\n`);
  } else if (command === 'install-e2e') {
    install(e2ePins().packages);
  } else if (command === 'install') {
    // No arguments: what the Gradle build needs. With arguments: exactly those
    // packages (e2e.yml pre-installs the emulator and its system image this
    // way, so reactivecircus/android-emulator-runner finds them in place).
    install(rest.length > 0 ? rest : components());
  } else {
    process.stderr.write(
      'usage: android-sdk.mjs components | cache-paths | outputs | emulator-outputs | install-e2e | install [pkg…]\n',
    );
    process.exitCode = 2;
  }
} catch (err) {
  process.stderr.write(`android-sdk: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
