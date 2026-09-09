import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const numberFor = (config, platform) =>
  String(platform === 'ios' ? config.ios.buildNumber : config.android.versionCode);
export function validateReleaseConfig(config, packageVersion, ref) {
  assert.equal(config.version, packageVersion, 'Expo and package versions must match.');
  assert.equal(
    config.runtimeVersion?.policy,
    'appVersion',
    'Review release runtime policy before building.',
  );
  if (ref.startsWith('refs/tags/'))
    assert.equal(ref, `refs/tags/v${config.version}`, 'Tag must match the Expo app version.');
}
export function collectBuildHistory(fetchPage) {
  const result = new Map();
  for (let offset = 0; offset < 5000; offset += 50) {
    const page = fetchPage(offset);
    assert(Array.isArray(page), 'Invalid EAS build history.');
    for (const build of page) result.set(build.id, build);
    if (page.length < 50) return [...result.values()];
  }
  throw new Error('Build history exceeds the verification limit; no build was started.');
}
export function assertNewBuildNumber(builds, config, platform) {
  const current = numberFor(config, platform);
  assert.match(current, /^[1-9]\d*$/, 'Use an incrementing integer native build number.');
  for (const build of builds) {
    if (build.platform !== platform.toUpperCase()) continue;
    if (build.appBuildVersion == null && build.status !== 'FINISHED') continue;
    assert.match(
      String(build.appBuildVersion),
      /^[1-9]\d*$/,
      'Cannot verify previous native build number.',
    );
    assert(
      BigInt(current) > BigInt(build.appBuildVersion),
      `Build ${current} is not newer than ${build.appBuildVersion}. Bump the native build number or retry the existing build ID.`,
    );
  }
}
export function validateBuild(result, config, platform, sha) {
  const builds = Array.isArray(result) ? result : [result];
  assert.equal(builds.length, 1, 'Expected exactly one build for this platform.');
  const build = builds[0];
  assert.match(build.id, /^[a-f0-9-]{36}$/i, 'Invalid build ID.');
  for (const [field, expected] of Object.entries({
    status: 'FINISHED',
    platform: platform.toUpperCase(),
    distribution: 'STORE',
    buildProfile: 'production',
    appVersion: config.version,
    appBuildVersion: numberFor(config, platform),
    runtimeVersion: config.version,
    gitCommitHash: sha,
  })) {
    assert.equal(build[field], expected, `Build ${field} does not match this release candidate.`);
  }
  return build;
}
export function nativeInputsChanged(paths) {
  return paths.some(
    (path) =>
      /^(modules|plugins|patches|ios|android|assets)\//.test(path) ||
      /^(package(?:-lock)?\.json|app\.config\.[^/]+|app\.json|eas\.json|babel\.config\.[^/]+|metro\.config\.[^/]+|\.npmrc|\.easignore|scripts\/eas-pre-install\.sh)$/.test(
        path,
      ),
  );
}
function output(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}
function main() {
  const [command, file, configFile, platform, sha] = process.argv.slice(2);
  if (command === 'history') {
    const builds = collectBuildHistory((offset) =>
      JSON.parse(
        execFileSync(
          'eas',
          [
            'build:list',
            '--platform',
            configFile,
            '--distribution',
            'store',
            '--limit',
            '50',
            '--offset',
            String(offset),
            ...(platform ? ['--runtime-version', platform, '--channel', 'production'] : []),
            '--json',
            '--non-interactive',
          ],
          { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
        ),
      ),
    );
    fs.writeFileSync(file, JSON.stringify(builds));
  } else if (command === 'check-config')
    validateReleaseConfig(read(file), read(configFile).version, platform);
  else if (command === 'check-number') assertNewBuildNumber(read(file), read(configFile), platform);
  else if (command === 'validate-build')
    output('build_id', validateBuild(read(file), read(configFile), platform, sha).id);
  else if (command === 'submit-profile') {
    const config = read(file);
    const track = process.env.ANDROID_TRACK;
    assert(
      track && track.length <= 100 && !/[\r\n]/.test(track),
      'An explicit Android track ID is required.',
    );
    config.submit.ci = {
      extends: 'production',
      android: { ...config.submit.production.android, track },
    };
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  } else if (command === 'ota-compatible') {
    execFileSync('git', ['diff', '--exit-code', 'HEAD'], { stdio: 'pipe' });
    const builds = read(file);
    const config = read(configFile);
    assert.equal(
      config.runtimeVersion?.policy,
      'appVersion',
      'Review OTA compatibility policy before publishing.',
    );
    const matching = builds.filter(
      (b) =>
        b.status === 'FINISHED' &&
        b.distribution === 'STORE' &&
        b.channel === 'production' &&
        b.runtimeVersion === config.version,
    );
    const missing = ['IOS', 'ANDROID'].filter((p) => !matching.some((b) => b.platform === p));
    const reasons = missing.map(
      (p) => `No finished ${p} production binary for runtime ${config.version}`,
    );
    for (const build of matching) {
      assert.match(
        build.gitCommitHash ?? '',
        /^[a-f0-9]{40}$/i,
        'Build has no verifiable source commit.',
      );
      const paths = execFileSync(
        'git',
        ['diff', '--no-renames', '--name-only', '-z', build.gitCommitHash, 'HEAD'],
        { encoding: 'utf8' },
      )
        .split('\0')
        .filter(Boolean);
      if (nativeInputsChanged(paths))
        reasons.push(`Native inputs differ from ${build.platform} build ${build.id}`);
    }
    output('compatible', String(reasons.length === 0));
    const summary = reasons.length
      ? `OTA not published:\n${reasons.map((r) => `- ${r}`).join('\n')}\nBuild new store binaries with a new app version.\n`
      : `OTA native inputs match every returned production build for runtime ${config.version}.\n`;
    if (process.env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    console.log(summary);
  } else throw new Error(`Unknown release policy command: ${command}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
