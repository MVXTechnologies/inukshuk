import StaticServer, { ERROR_LOG_FILE } from '@dr.pogodin/react-native-static-server';
import { Directory, File, Paths } from 'expo-file-system';

import { refCounted, type RefCountedLease } from '@core/storage/refCounted';
import { SERVED_DOCUMENT_PREFIXES, lighttpdAccessConfig } from '@core/storage/servedPaths';
import { describeServerStartFailure, logTail } from '@core/storage/serverStartFailure';

import { documentDirUri } from './storage';

/**
 * The app's ONE loopback HTTP server (#269).
 *
 * `@dr.pogodin/react-native-static-server` permits a single active server per
 * app — its native `stop()` takes no id — so every subsystem that needs a
 * local `http://` origin shares this instance through a ref-counted lease:
 *
 * - the PDF rasterizer holds a lease for the app's lifetime: its WebView page
 *   and the imported PDFs are served from here, same-origin, so pdf.js can
 *   range-fetch a 200 MB GeoPDF instead of the file crossing the bridge as
 *   base64 (the OOM / timeout in #218, #264, #265);
 * - the offline-map downloader holds one per download: MapLibre's native
 *   downloader accepts only http(s) style URLs.
 *
 * Root = the document directory, bound to 127.0.0.1 on a free port. Only the
 * folders in {@link SERVED_DOCUMENT_PREFIXES} are reachable — lighttpd's
 * mod_access denies the rest, so the user's index, trails and photos are not
 * one guessed URL away from any process on the device. Loopback cleartext is
 * allowed by the withLocalhostCleartext plugin (Android) and
 * NSAllowsLocalNetworking (iOS).
 *
 * ## Start failures (#290)
 *
 * On one Android 11 phone lighttpd exited with status -1 twice in a row
 * (#276, #277) and the library's error carries nothing else. So a failed
 * start is retried once on a FRESH instance (the library forbids restarting
 * a crashed one), and if that fails too the thrown error carries the tail of
 * lighttpd's own error log — the only place the real reason is written.
 */

/** Starts attempted before giving up: the first, plus one on a fresh instance. */
export const START_ATTEMPTS = 2;

// The native server wants a plain filesystem path; expo-file-system gives file:// URIs.
function fsPath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

// The single instance. Created lazily and kept while it works: the lib's
// start() is idempotent while ACTIVE and permitted again from INACTIVE, so one
// object serves every lease. A crashed instance is dropped (see startServer).
let server: StaticServer | null = null;

function sharedServer(): StaticServer {
  server ??= new StaticServer({
    fileDir: fsPath(documentDirUri()),
    port: 0,
    hostname: '127.0.0.1',
    extraConfig: lighttpdAccessConfig(SERVED_DOCUMENT_PREFIXES),
  });
  return server;
}

/** The tail of lighttpd's error log, or null when it cannot be read. */
async function readErrorLogTail(): Promise<string | null> {
  try {
    const file = new File(ERROR_LOG_FILE);
    if (!file.exists) return null;
    return logTail(await file.text());
  } catch {
    return null;
  }
}

async function startServer(): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    try {
      return await sharedServer().start();
    } catch (err) {
      lastError = err;
      // Never reuse an instance that crashed: the library's own contract, and
      // the second failure on #276/#277 was exactly such a reuse.
      server = null;
    }
  }
  throw new Error(describeServerStartFailure(lastError, await readErrorLogTail(), START_ATTEMPTS));
}

const pool = refCounted<string>(startServer, () =>
  server === null
    ? Promise.resolve()
    : server.stop().then(
        () => undefined,
        () => undefined,
      ),
);

/** A held reference to the running server; `value` is its origin (`http://127.0.0.1:<port>`). */
export type LocalServerLease = RefCountedLease<string>;

/**
 * Start the server (or join the running one) and return a lease on it. The
 * server stops once every lease is released. Rejects if it cannot start —
 * callers decide what to do without it (the rasterizer falls back to the
 * bridge for small files; a download simply fails).
 */
export function acquireLocalServer(): Promise<LocalServerLease> {
  return pool.acquire();
}

/** Outstanding leases — for diagnostics and tests. */
export function localServerLeases(): number {
  return pool.leases;
}

/**
 * Write a text file into the document directory at `documentPath`
 * (creating parent folders), overwriting any previous version, and return
 * its `file://` uri. The rasterizer page is written this way on every mount.
 */
export function writeServedText(documentPath: string, text: string): string {
  const slash = documentPath.lastIndexOf('/');
  const dir =
    slash === -1
      ? new Directory(Paths.document)
      : new Directory(Paths.document, documentPath.slice(0, slash));
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, documentPath.slice(slash + 1));
  if (file.exists) file.delete();
  file.create();
  file.write(text);
  return file.uri;
}
