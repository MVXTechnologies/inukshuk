/**
 * @jest-environment node
 */
const { describe, expect, it } = require('@jest/globals');

const artifact = require('./artifact.json');
const build = require('./build.json');
const { buildInputsHash, plan } = require('./inputs');

describe('build inputs fingerprint', () => {
  // build.json or a patch changed without a new build: hermes-android.yml
  // would refuse it anyway, but say so here first.
  it('artifact.json was built from the current build.json + patches', () => {
    expect(artifact.releaseTag).toBe(build.releaseTag);
    expect(artifact.inputsSha256).toBe(buildInputsHash());
  });
});

describe('plan', () => {
  const base = {
    releaseTag: 'r.1',
    current: 'aaa',
    artifact: { releaseTag: 'r.1', inputsSha256: 'aaa' },
    forceRebuild: false,
  };

  it('builds what is not published yet', () => {
    expect(plan({ ...base, releaseExists: false }).build).toBe(true);
  });

  it('skips the build when the tag is published from the same inputs', () => {
    expect(plan({ ...base, releaseExists: true }).build).toBe(false);
  });

  it('rebuilds on request (publishing never replaces)', () => {
    expect(plan({ ...base, releaseExists: true, forceRebuild: true }).build).toBe(true);
  });

  it('refuses changed inputs under a published tag', () => {
    expect(() => plan({ ...base, releaseExists: true, current: 'bbb' })).toThrow(
      'set a new releaseTag',
    );
  });

  it('skips when the tag is published but artifact.json does not pin it yet', () => {
    const r = plan({ ...base, releaseExists: true, artifact: { releaseTag: 'r.0' } });
    expect(r.build).toBe(false);
  });
});
