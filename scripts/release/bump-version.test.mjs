import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bumpAppConfig,
  bumpPackageJson,
  bumpPackageLock,
  compareVersions,
  nextVersion,
  parseArgs,
  planBump,
  readAppConfig,
  staleMentions,
} from './bump-version.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The shapes of the real files, trimmed to what the bump touches. */
const APP_CONFIG = `export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Inukshuk',
  // 1.5.3: the map front.
  version: '1.5.3',
  ios: {
    bundleIdentifier: 'com.inukshuk.app',
    // Increase for every App Store Connect upload.
    buildNumber: '8',
  },
  android: {
    package: 'com.inukshuk.app',
    // Play build 54 ships 1.5.3 (see the version note above).
    versionCode: 54,
    // RECEIVE_BOOT_COMPLETED: its absence in vc44 (1.0.2) crash-looped (see #8).
  },
  runtimeVersion: {
    policy: 'fingerprint',
  },
});
`;
const PACKAGE_JSON = `{
  "name": "inukshuk",
  "version": "1.5.3",
  "main": "expo-router/entry",
  "dependencies": {
    "some-lib": "^1.5.3"
  }
}
`;
const PACKAGE_LOCK = `{
  "name": "inukshuk",
  "version": "1.5.2",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "inukshuk",
      "version": "1.5.2",
      "dependencies": {
        "some-lib": "^1.5.3"
      }
    },
    "node_modules/some-lib": {
      "version": "1.5.3"
    }
  }
}
`;
const files = (over = {}) => ({
  packageJson: PACKAGE_JSON,
  appConfig: APP_CONFIG,
  packageLock: PACKAGE_LOCK,
  ...over,
});

describe('nextVersion', () => {
  it('bumps by keyword', () => {
    assert.equal(nextVersion('1.5.3', 'patch'), '1.5.4');
    assert.equal(nextVersion('1.5.3', 'minor'), '1.6.0');
    assert.equal(nextVersion('1.5.3', 'major'), '2.0.0');
  });

  it('takes an explicit newer version', () => {
    assert.equal(nextVersion('1.5.3', '1.6.0'), '1.6.0');
    assert.equal(nextVersion('1.9.9', '1.10.0'), '1.10.0');
  });

  // Store build numbers only ever climb; a version going backwards is always a mistake.
  it('refuses to go backwards or stay put', () => {
    assert.throws(() => nextVersion('1.5.3', '1.5.2'), /must be newer/);
    assert.throws(() => nextVersion('1.5.3', '1.4.9'), /must be newer/);
    assert.throws(() => nextVersion('1.5.3', '1.5.3'), /must be newer/);
  });

  it('rejects anything that is not a keyword or x.y.z', () => {
    for (const spec of ['1.6', 'v1.6.0', '1.6.0-rc.1', 'next', '']) {
      assert.throws(() => nextVersion('1.5.3', spec), /major, minor, patch or x\.y\.z/);
    }
  });

  it('compares numerically, not as text', () => {
    assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
    assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  });
});

describe('app.config.ts', () => {
  it('reads the three numbers', () => {
    assert.deepEqual(readAppConfig(APP_CONFIG), {
      version: '1.5.3',
      buildNumber: 8,
      versionCode: 54,
    });
  });

  it('bumps the version and both build numbers, and nothing else', () => {
    const out = bumpAppConfig(APP_CONFIG, '1.6.0');
    assert.deepEqual(readAppConfig(out), { version: '1.6.0', buildNumber: 9, versionCode: 55 });
    const changed = out.split('\n').filter((line, i) => line !== APP_CONFIG.split('\n')[i]);
    assert.deepEqual(changed, [
      "  version: '1.6.0',",
      "    buildNumber: '9',",
      '    versionCode: 55,',
    ]);
  });

  it('refuses a file where a field has moved or gone', () => {
    assert.throws(() => readAppConfig(APP_CONFIG.replace("buildNumber: '8'", 'buildNumber: 8')), {
      message: /ios\.buildNumber.*found 0/,
    });
    assert.throws(
      () => readAppConfig(APP_CONFIG.replace('    versionCode: 54,', '    versionCode: CODE,')),
      /android\.versionCode.*found 0/,
    );
    assert.throws(() => readAppConfig(APP_CONFIG.replace("  version: '1.5.3',", '')), /version/);
  });

  it('refuses a file with the field twice', () => {
    const twice = APP_CONFIG.replace(
      "  name: 'Inukshuk',",
      "  name: 'Inukshuk',\n  version: '1.0.0',",
    );
    assert.throws(() => readAppConfig(twice), /exactly one version line.*found 2/);
  });
});

describe('package.json and package-lock.json', () => {
  it('bumps package.json version only — not a dependency range that happens to match', () => {
    const out = JSON.parse(bumpPackageJson(PACKAGE_JSON, '1.6.0'));
    assert.equal(out.version, '1.6.0');
    assert.equal(out.dependencies['some-lib'], '^1.5.3');
  });

  it('sets both root versions in the lock, whatever they had drifted to', () => {
    const lock = JSON.parse(bumpPackageLock(PACKAGE_LOCK, '1.6.0'));
    assert.equal(lock.version, '1.6.0');
    assert.equal(lock.packages[''].version, '1.6.0');
    assert.equal(lock.packages['node_modules/some-lib'].version, '1.5.3');
  });

  it('refuses a lock without the expected root shape', () => {
    assert.throws(() => bumpPackageLock('{\n  "lockfileVersion": 3\n}\n', '1.6.0'), /package-lock/);
  });
});

describe('planBump', () => {
  it('plans the whole release and names the tag', () => {
    const plan = planBump(files(), '1.6.0');
    assert.deepEqual(plan.from, { version: '1.5.3', buildNumber: 8, versionCode: 54 });
    assert.deepEqual(plan.to, { version: '1.6.0', buildNumber: 9, versionCode: 55 });
    assert.equal(plan.tag, 'v1.6.0');
    assert.equal(JSON.parse(plan.files['package.json']).version, '1.6.0');
    assert.equal(readAppConfig(plan.files['app.config.ts']).version, '1.6.0');
    assert.equal(JSON.parse(plan.files['package-lock.json']).version, '1.6.0');
  });

  it('lists the release-note comments that still name the old numbers', () => {
    const lines = planBump(files(), 'minor').stale.map((s) => s.text);
    assert.deepEqual(lines, [
      '// 1.5.3: the map front.',
      '// Play build 54 ships 1.5.3 (see the version note above).',
    ]);
  });

  it('refuses when package.json and app.config.ts disagree', () => {
    const drifted = files({ packageJson: PACKAGE_JSON.replace('"1.5.3"', '"1.5.2"') });
    assert.throws(
      () => planBump(drifted, 'patch'),
      /package\.json says 1\.5\.2 but app\.config\.ts says 1\.5\.3/,
    );
  });

  it('refuses to go backwards before touching anything', () => {
    assert.throws(() => planBump(files(), '1.5.0'), /must be newer/);
  });
});

describe('staleMentions', () => {
  it('ignores bare numbers that are not named as builds', () => {
    const text = '// see #8 and #54\n// UTF-8, 1.5.30, 11.5.3\n// build 8 ships';
    const hits = staleMentions(text, { version: '1.5.3', buildNumber: 8, versionCode: 54 });
    assert.deepEqual(
      hits.map((h) => h.line),
      [3],
    );
  });
});

describe('parseArgs', () => {
  it('reads --version and --dry-run', () => {
    assert.deepEqual(parseArgs(['--version', '1.6.0', '--dry-run']), {
      spec: '1.6.0',
      dryRun: true,
    });
  });

  it('requires --version and rejects strays', () => {
    assert.throws(() => parseArgs([]), /usage/);
    assert.throws(() => parseArgs(['patch']), /unknown argument/);
    assert.throws(() => parseArgs(['--version']), /needs a value/);
  });
});

// The fixtures above are hand-trimmed; the real files must have the same shape,
// or the first real release would find out.
describe('the checked-in files', () => {
  it('plan a patch bump cleanly', () => {
    const read = (name) => readFileSync(resolve(repoRoot, name), 'utf8');
    const plan = planBump(
      {
        packageJson: read('package.json'),
        appConfig: read('app.config.ts'),
        packageLock: read('package-lock.json'),
      },
      'patch',
    );
    assert.equal(plan.to.buildNumber, plan.from.buildNumber + 1);
    assert.equal(plan.to.versionCode, plan.from.versionCode + 1);
  });
});
