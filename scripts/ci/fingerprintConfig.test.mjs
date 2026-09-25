import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * fingerprint.config.js decides which runtime every OTA update targets. Two
 * of its failure modes are silent: @expo/fingerprint ignores a misspelt
 * source-skip name, and it falls back to defaults if the file fails to load.
 * Either one would make the runtime depend on the environment again (see the
 * file's own comment) with nothing to say so.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(resolve(repoRoot, 'package.json'));
const { SourceSkips, createFingerprintAsync } = require('@expo/fingerprint');
const config = require(resolve(repoRoot, 'fingerprint.config.js'));

describe('fingerprint.config.js', () => {
  it('names only real SourceSkips', () => {
    for (const name of config.sourceSkips) {
      assert.equal(typeof SourceSkips[name], 'number', `${name} is not a SourceSkips member`);
    }
  });

  it('keeps the environment-filled `extra` and the version labels out of the hash', () => {
    for (const name of ['ExpoConfigExtraSection', 'ExpoConfigVersions']) {
      assert.ok(config.sourceSkips.includes(name), `${name} must stay skipped`);
    }
  });

  // The property that matters, end to end: the EAS worker has the Strava and
  // error-report credentials, a local checkout does not, and both must land
  // on the same runtime.
  it(
    'gives the same runtime with and without the credentials in the environment',
    { timeout: 120_000 },
    async () => {
      const KEYS = ['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'ERROR_REPORT_TOKEN'];
      const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
      const hash = async () =>
        (await createFingerprintAsync(repoRoot, { platforms: ['android'], silent: true })).hash;
      try {
        for (const k of KEYS) delete process.env[k];
        const without = await hash();
        for (const k of KEYS) process.env[k] = `value-of-${k}`;
        const withCredentials = await hash();
        assert.equal(withCredentials, without);
      } finally {
        for (const k of KEYS) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
      }
    },
  );
});
