/**
 * @jest-environment node
 */
const { afterEach, beforeEach, describe, expect, it } = require('@jest/globals');
const { Buffer } = require('node:buffer');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { RETRY_DELAYS_S, materializeArtifact } = require('./fetchArtifact');

const sha = (/** @type {Buffer} */ b) => createHash('sha256').update(b).digest('hex');
const AAR = Buffer.from('pretend this is an AAR '.repeat(1000));
const POM = Buffer.from('<project/>');

const artifact = {
  releaseTag: 'hermes-android-1.0.0-test.1',
  baseUrl: 'https://example.test/releases/download/hermes-android-1.0.0-test.1',
  mavenPath: 'com/facebook/hermes/hermes-android/1.0.0',
  files: [
    { name: 'hermes-android-1.0.0-release.aar', sha256: sha(AAR), size: AAR.length },
    { name: 'hermes-android-1.0.0.pom', sha256: sha(POM), size: POM.length },
  ],
};

/** @param {Buffer} body */
const ok = (body) => ({
  ok: true,
  status: 200,
  body: (async function* chunks() {
    for (let i = 0; i < body.length; i += 4096) yield body.subarray(i, i + 4096);
  })(),
});

let root = '';
/** @type {string[]} */
let log = [];
/** @type {number[]} */
let slept = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'patched-hermes-'));
  log = [];
  slept = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const io = (/** @type {(url: string) => any} */ fetch) => ({
  fetch,
  log: (/** @type {string} */ m) => void log.push(m),
  sleep: async (/** @type {number} */ ms) => void slept.push(ms),
});

const BODIES = { 'release.aar': AAR, '.pom': POM };
const serve = (/** @type {string} */ url) =>
  ok(url.endsWith('.aar') ? BODIES['release.aar'] : BODIES['.pom']);

describe('materializeArtifact', () => {
  it('downloads, verifies and places every file in the local Maven repository', async () => {
    /** @type {string[]} */
    const urls = [];
    const target = await materializeArtifact(artifact, join(root, 'm2'), join(root, 'cache'), {
      ...io((url) => {
        urls.push(url);
        return serve(url);
      }),
    });
    expect(target).toBe(join(root, 'm2', artifact.mavenPath));
    expect(urls).toEqual(artifact.files.map((f) => `${artifact.baseUrl}/${f.name}`));
    expect(readFileSync(join(target, 'hermes-android-1.0.0-release.aar'))).toEqual(AAR);
    expect(readFileSync(join(target, 'hermes-android-1.0.0.pom'))).toEqual(POM);
  });

  it('reuses a verified cached copy without fetching', async () => {
    await materializeArtifact(artifact, join(root, 'm2'), join(root, 'cache'), io(serve));
    let fetched = 0;
    await materializeArtifact(artifact, join(root, 'm2b'), join(root, 'cache'), {
      ...io((url) => {
        fetched++;
        return serve(url);
      }),
    });
    expect(fetched).toBe(0);
    expect(log.filter((l) => l.includes('cached, sha256 ok'))).toHaveLength(2);
  });

  it('re-fetches a corrupted cached copy', async () => {
    await materializeArtifact(artifact, join(root, 'm2'), join(root, 'cache'), io(serve));
    const cached = join(root, 'cache', artifact.releaseTag, artifact.files[0]?.name ?? '');
    writeFileSync(cached, Buffer.alloc(AAR.length));
    let fetched = 0;
    await materializeArtifact(artifact, join(root, 'm2'), join(root, 'cache'), {
      ...io((url) => {
        fetched++;
        return serve(url);
      }),
    });
    expect(fetched).toBe(1);
    expect(statSync(cached).size).toBe(AAR.length);
    expect(readFileSync(cached)).toEqual(AAR);
  });

  it('retries a failed download a bounded number of times, with a warning each time', async () => {
    let calls = 0;
    await materializeArtifact(artifact, join(root, 'm2'), join(root, 'cache'), {
      ...io((url) => {
        calls++;
        if (calls === 1) return { ok: false, status: 502, body: null };
        return serve(url);
      }),
    });
    expect(slept).toEqual([RETRY_DELAYS_S[0] * 1000]);
    expect(log.some((l) => l.startsWith('::warning') && l.includes('HTTP 502'))).toBe(true);
  });

  it('never uses a file whose checksum differs, and gives up after the last retry', async () => {
    const wrong = Buffer.from(AAR);
    wrong[0] = 0;
    await expect(
      materializeArtifact(
        artifact,
        join(root, 'm2'),
        join(root, 'cache'),
        io(() => ok(wrong)),
      ),
    ).rejects.toThrow(/could not fetch .*release\.aar \(3 attempts\): checksum mismatch/);
    expect(slept).toHaveLength(RETRY_DELAYS_S.length);
    expect(() =>
      statSync(join(root, 'm2', artifact.mavenPath, artifact.files[0]?.name ?? '')),
    ).toThrow();
  });

  it('refuses an artifact.json that pins nothing', async () => {
    await expect(
      materializeArtifact(
        { ...artifact, files: [] },
        join(root, 'm2'),
        join(root, 'cache'),
        io(serve),
      ),
    ).rejects.toThrow('pins no files');
  });
});
