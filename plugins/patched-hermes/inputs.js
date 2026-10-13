#!/usr/bin/env node
// @ts-check
/**
 * The fingerprint of a patched Hermes build's inputs: build.json plus every
 * patch it lists, byte for byte. artifact.json records the fingerprint it was
 * built from, so hermes-android.yml can tell "already published from these
 * inputs" (skip the hour-long build, only re-check the published assets) from
 * "inputs changed under a published tag" (an error: bump releaseTag).
 *
 *   inputs.js plan <release-exists: true|false> [force-rebuild: true|false]
 *       prints `build=true|false` for $GITHUB_OUTPUT, or fails.
 */
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

/** @param {string} [dir] the plugins/patched-hermes directory */
function buildInputsHash(dir = join(require.resolve('./build.json'), '..')) {
  const hash = createHash('sha256');
  const buildJson = readFileSync(join(dir, 'build.json'));
  hash.update(buildJson);
  /** @type {{ patches: Array<{ file: string }> }} */
  const build = JSON.parse(buildJson.toString('utf8'));
  for (const p of build.patches) hash.update(readFileSync(join(dir, p.file)));
  return hash.digest('hex');
}

/**
 * @param {{ releaseExists: boolean, forceRebuild: boolean, current: string,
 *   artifact: { releaseTag: string, inputsSha256?: string }, releaseTag: string }} o
 * @returns {{ build: boolean, why: string }}
 */
function plan(o) {
  if (!o.releaseExists) return { build: true, why: `${o.releaseTag} is not published yet` };
  if (o.artifact.releaseTag === o.releaseTag && o.artifact.inputsSha256 !== o.current) {
    throw new Error(
      `${o.releaseTag} is published from other inputs than build.json + patches now describe; ` +
        'a published release is never replaced: set a new releaseTag in build.json',
    );
  }
  if (o.forceRebuild) return { build: true, why: 'rebuild requested (publishing is skipped)' };
  return {
    build: false,
    why: `${o.releaseTag} is already published from these inputs; only its assets are re-checked`,
  };
}

if (require.main === module) {
  const [cmd, exists, force] = process.argv.slice(2);
  if (cmd !== 'plan' || (exists !== 'true' && exists !== 'false')) {
    console.error('usage: inputs.js plan <true|false> [true|false]');
    process.exitCode = 2;
  } else {
    try {
      const build = require('./build.json');
      const r = plan({
        releaseExists: exists === 'true',
        forceRebuild: force === 'true',
        current: buildInputsHash(),
        artifact: require('./artifact.json'),
        releaseTag: build.releaseTag,
      });
      console.error(r.why);
      console.log(`build=${r.build}`);
    } catch (e) {
      console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  }
}

module.exports = { buildInputsHash, plan };
