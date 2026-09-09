import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNewBuildNumber,
  validateReleaseConfig,
  collectBuildHistory,
  validateBuild,
  nativeInputsChanged,
} from './release-policy.mjs';
const config = { version: '1.5.2', ios: { buildNumber: '7' }, android: { versionCode: 53 } };
const build = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'FINISHED',
  platform: 'IOS',
  distribution: 'STORE',
  buildProfile: 'production',
  channel: 'production',
  appVersion: '1.5.2',
  appBuildVersion: '7',
  gitCommitHash: 'a'.repeat(40),
  runtimeVersion: '1.5.2',
};
test('requires a finished store binary for the exact source, version, and platform', () => {
  assert.equal(validateBuild([build], config, 'ios', build.gitCommitHash).id, build.id);
  for (const patch of [
    { status: 'IN_PROGRESS' },
    { status: 'ERRORED' },
    { platform: 'ANDROID' },
    { distribution: 'INTERNAL' },
    { buildProfile: 'preview' },
    { appVersion: '1.5.1' },
    { appBuildVersion: '6' },
    { gitCommitHash: 'b'.repeat(40) },
    { runtimeVersion: '1.5.1' },
  ]) {
    assert.throws(() =>
      validateBuild([{ ...build, ...patch }], config, 'ios', build.gitCommitHash),
    );
  }
  assert.throws(() => validateBuild([], config, 'ios', build.gitCommitHash));
});
test('prevents duplicate or regressed build numbers even when the marketing version changes', () => {
  assert.doesNotThrow(() =>
    assertNewBuildNumber([{ ...build, appBuildVersion: '6' }], config, 'ios'),
  );
  assert.throws(() => assertNewBuildNumber([build], config, 'ios'));
  assert.throws(() =>
    assertNewBuildNumber([{ ...build, appBuildVersion: '8', appVersion: '1.5.0' }], config, 'ios'),
  );
  assert.throws(() =>
    assertNewBuildNumber(
      [{ ...build, platform: 'ANDROID', appBuildVersion: '53' }],
      config,
      'android',
    ),
  );
});
test('native changes cannot be sent as an OTA, while ordinary JS remains eligible', () => {
  for (const path of [
    'modules/inukshuk-pdf/ios/Crop.swift',
    'plugins/map.js',
    'package-lock.json',
    'app.config.ts',
    'eas.json',
    'scripts/eas-pre-install.sh',
    'assets/icon.png',
    'android/app/build.gradle',
  ])
    assert.equal(nativeInputsChanged([path]), true, path);
  assert.equal(nativeInputsChanged(['src/features/map/usePdfDetails.ts', 'docs/CI.md']), false);
});

test('rejects a package-only version bump or mismatched release tag', () => {
  const expo = { ...config, runtimeVersion: { policy: 'appVersion' } };
  assert.doesNotThrow(() => validateReleaseConfig(expo, '1.5.2', 'refs/tags/v1.5.2'));
  assert.throws(() => validateReleaseConfig(expo, '1.5.3', 'refs/tags/v1.5.3'));
  assert.throws(() => validateReleaseConfig(expo, '1.5.2', 'refs/tags/v1.5.3'));
});
test('checks older store builds beyond the first page and from other profiles', () => {
  const first = Array.from({ length: 50 }, (_, i) => ({
    ...build,
    id: String(i),
    appBuildVersion: '1',
  }));
  const offsets = [];
  const history = collectBuildHistory((offset) => {
    offsets.push(offset);
    return offset === 0
      ? first
      : [{ ...build, id: 'old-high', buildProfile: 'other-store-profile', appBuildVersion: '99' }];
  });
  assert.deepEqual(offsets, [0, 50]);
  assert.throws(() => assertNewBuildNumber(history, config, 'ios'));
});

test('OTA command verifies actual Git history, both platforms, and a clean checkout', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inukshuk-ota-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const script = fileURLToPath(new URL('./release-policy.mjs', import.meta.url));
  try {
    git('init', '-q');
    git('config', 'user.name', 'CI test');
    git('config', 'user.email', 'ci@example.invalid');
    fs.mkdirSync(path.join(dir, 'modules'));
    fs.writeFileSync(path.join(dir, 'modules/native.swift'), 'native baseline');
    fs.writeFileSync(path.join(dir, 'ui.ts'), 'before');
    git('add', '.');
    git('commit', '-qm', 'baseline');
    const baseline = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'ui.ts'), 'after');
    git('add', '.');
    git('commit', '-qm', 'JS-only update');
    const file = path.join(dir, 'builds.json');
    const cfg = path.join(dir, 'config.json');
    const out = path.join(dir, 'output');
    fs.writeFileSync(cfg, JSON.stringify({ ...config, runtimeVersion: { policy: 'appVersion' } }));
    const binary = { ...build, gitCommitHash: baseline };
    const run = (builds) => {
      fs.writeFileSync(file, JSON.stringify(builds));
      fs.writeFileSync(out, '');
      const result = spawnSync(process.execPath, [script, 'ota-compatible', file, cfg], {
        cwd: dir,
        env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: '' },
        encoding: 'utf8',
      });
      return { code: result.status, output: fs.readFileSync(out, 'utf8') };
    };
    const both = [binary, { ...binary, id: 'android', platform: 'ANDROID' }];
    assert.deepEqual(run(both), { code: 0, output: 'compatible=true\n' });
    assert.deepEqual(run(both.map((b) => ({ ...b, buildProfile: 'alternate-store-profile' }))), {
      code: 0,
      output: 'compatible=true\n',
    });
    assert.deepEqual(run(both.map((b) => ({ ...b, channel: 'preview' }))), {
      code: 0,
      output: 'compatible=false\n',
    });
    assert.deepEqual(run([binary]), { code: 0, output: 'compatible=false\n' });
    fs.writeFileSync(path.join(dir, 'modules/native.swift'), 'uncommitted native change');
    assert.notEqual(run(both).code, 0);
    git('add', 'modules/native.swift');
    git('commit', '-qm', 'native change');
    assert.deepEqual(run(both), { code: 0, output: 'compatible=false\n' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
