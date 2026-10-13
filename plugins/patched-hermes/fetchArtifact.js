// @ts-check
/**
 * Puts the patched hermes-android Maven files (artifact.json) into a local
 * Maven repository inside android/, each one checked against its pinned size
 * and SHA-256 before use. Downloads go to a per-release cache outside the
 * project (prebuild --clean wipes android/), so a machine fetches them once.
 *
 * Only the download is retried, a bounded number of times, and each retry is
 * logged as a ::warning:: (the android-sdk.mjs rule): a file that arrives but
 * does not match its checksum is never used.
 */
const { createHash } = require('node:crypto');
const {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

/** Seconds to wait before each retry of a failed download. */
const RETRY_DELAYS_S = [10, 30];

/**
 * @typedef {{ name: string, sha256: string, size: number }} PinnedFile
 * @typedef {{ releaseTag: string, baseUrl: string, mavenPath: string, files: PinnedFile[] }} Artifact
 * @typedef {(url: string) => Promise<{ ok: boolean, status: number, body: AsyncIterable<Uint8Array> | null }>} FetchLike
 * @typedef {{ fetch?: FetchLike, sleep?: (ms: number) => Promise<void>, log?: (msg: string) => void }} Io
 */

/** @param {string} path */
async function sha256OfFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * @param {string} path
 * @param {PinnedFile} file
 */
async function matches(path, file) {
  return (
    existsSync(path) &&
    statSync(path).size === file.size &&
    (await sha256OfFile(path)) === file.sha256
  );
}

/**
 * One download attempt into `dest`, verified while it streams.
 * @param {string} url
 * @param {string} dest
 * @param {PinnedFile} file
 * @param {FetchLike} fetchImpl
 */
async function downloadOnce(url, dest, file, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const part = `${dest}.part`;
  const hash = createHash('sha256');
  let size = 0;
  const out = createWriteStream(part);
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      size += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
  } finally {
    await new Promise((resolve, reject) =>
      out.end((/** @type {any} */ e) => (e ? reject(e) : resolve(undefined))),
    );
  }
  const sha = hash.digest('hex');
  if (size !== file.size || sha !== file.sha256) {
    rmSync(part, { force: true });
    throw new Error(
      `checksum mismatch: got ${size} bytes sha256 ${sha}, pinned ${file.size} bytes sha256 ${file.sha256}`,
    );
  }
  renameSync(part, dest);
}

/**
 * The verified cached copy of `file`, downloading it if needed.
 * @param {Artifact} artifact
 * @param {PinnedFile} file
 * @param {string} cacheDir
 * @param {Required<Io>} io
 */
async function ensureCached(artifact, file, cacheDir, io) {
  const cached = join(cacheDir, file.name);
  if (await matches(cached, file)) {
    io.log(`${file.name}: cached, sha256 ok`);
    return cached;
  }
  rmSync(cached, { force: true });
  const url = `${artifact.baseUrl}/${file.name}`;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      await downloadOnce(url, cached, file, io.fetch);
      io.log(
        `${file.name}: downloaded ${(file.size / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s, sha256 ok`,
      );
      return cached;
    } catch (e) {
      const delay = RETRY_DELAYS_S[attempt];
      const why = e instanceof Error ? e.message : String(e);
      if (delay === undefined) {
        throw new Error(`patched Hermes: could not fetch ${url} (${attempt + 1} attempts): ${why}`);
      }
      io.log(
        `::warning title=Patched Hermes download retried::${file.name}: ${why}; retry in ${delay}s`,
      );
      await io.sleep(delay * 1000);
    }
  }
}

/**
 * Fills `<repoDir>/<mavenPath>/` with every pinned file.
 * @param {Artifact} artifact
 * @param {string} repoDir     the local Maven repository (android/patched-hermes/m2)
 * @param {string} [cacheRoot] defaults to $INUKSHUK_HERMES_CACHE or ~/.cache/inukshuk/patched-hermes
 * @param {Io} [io]
 */
async function materializeArtifact(artifact, repoDir, cacheRoot, io = {}) {
  if (!artifact.files?.length) {
    throw new Error(
      'patched Hermes: plugins/patched-hermes/artifact.json pins no files; publish them with .github/workflows/hermes-android.yml first',
    );
  }
  /** @type {Required<Io>} */
  const full = {
    fetch: io.fetch ?? /** @type {FetchLike} */ (/** @type {unknown} */ (globalThis.fetch)),
    sleep: io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    log: io.log ?? ((m) => console.log(`[patched-hermes] ${m}`)),
  };
  const root =
    cacheRoot ??
    process.env.INUKSHUK_HERMES_CACHE ??
    join(homedir(), '.cache', 'inukshuk', 'patched-hermes');
  const cacheDir = join(root, artifact.releaseTag);
  mkdirSync(cacheDir, { recursive: true });
  const target = join(repoDir, artifact.mavenPath);
  mkdirSync(target, { recursive: true });
  for (const file of artifact.files) {
    const cached = await ensureCached(artifact, file, cacheDir, full);
    const dest = join(target, file.name);
    rmSync(dest, { force: true });
    try {
      linkSync(cached, dest);
    } catch {
      copyFileSync(cached, dest);
    }
  }
  return target;
}

module.exports = { RETRY_DELAYS_S, materializeArtifact, sha256OfFile };
