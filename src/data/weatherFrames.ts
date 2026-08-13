import {
  frameFileName,
  isPngHeader,
  selectEvictions,
  type FrameCacheEntry,
} from '@core/weather/framePrefetch';
import { Directory, File, FileMode, Paths } from 'expo-file-system';

import { isNetworkAllowed } from './storage';

/**
 * Disk cache for weather drape frames (perf work 2026-08-11).
 *
 * Each frame is ONE GeoMet GetMap PNG (`@core/weather/weatherDrape`), stored
 * under a hash of its URL. This exists because a plain `fetch` cannot warm
 * MapLibre's cache: on both platforms MapLibre Native runs its own HTTP stack
 * and its own SQLite ambient cache, entirely separate from React Native's
 * `fetch`/NSURLSession cache. Downloading the frame ourselves and handing
 * MapLibre a `file://` URI is therefore the only way a prefetch can be relied
 * on to make the next tick free — and it also makes the second loop of an
 * animation cost nothing at all, which no amount of HTTP hygiene could have
 * bought here (GeoMet sends no ETag and no Last-Modified, so a conditional
 * request could never come back 304; verified live 2026-08-11).
 *
 * Everything degrades silently: a failed or non-PNG download resolves to
 * null and the caller simply keeps the frame already on screen.
 *
 * THE BUDGET IS ENFORCED AGAINST THE DIRECTORY, not against this session's
 * downloads. Frame URLs never recur across launches — TIME advances and every
 * re-anchor rewrites every URL — so an in-memory ledger would see 0 bytes at
 * startup and happily add a fresh budget's worth on top of whatever previous
 * launches left behind. Listing the directory is the only way the cap means
 * anything, so the sweep below reads real file sizes and modification times
 * (throttled: a full scan is not worth doing on every frame).
 *
 * The cache dir sits under `Paths.cache`, so iOS/Android may reclaim it under
 * pressure — correct for data that is a network convenience, never user
 * content. That reclaim is not something to rely on, though: Android only
 * does it under critical pressure, which on a nearly-full phone arrives long
 * after the user has noticed.
 */

const FRAMES_DIR = 'weather-frames';

/**
 * Byte budget. A radar frame is ~8 KB and a temperature frame ~180 KB, so
 * this holds several full animation loops — enough that replaying a loop is
 * free — while staying small next to the offline map packs.
 */
export const WEATHER_FRAME_BUDGET_BYTES = 32 * 1024 * 1024;

/**
 * Downloads between directory sweeps. A sweep stats every file, so running it
 * per frame would cost more than it saves; 32 frames of overshoot is at most
 * ~6 MB on the heaviest layer. The FIRST sweep is not throttled — that is the
 * one that adopts everything previous launches left behind.
 */
const SWEEP_EVERY = 32;

/** GeoMet's usage policy asks for a meaningful User-Agent on every request. */
const USER_AGENT = 'Inukshuk trail app (github.com/MVXTechnologies/inukshuk)';

interface CachedFrame {
  uri: string;
  bytes: number;
  usedAt: number;
}

const memo = new Map<string, CachedFrame>();
const inflight = new Map<string, Promise<string | null>>();
/** URLs the drape is showing right now — never evicted (see selectEvictions). */
let pinned: readonly string[] = [];
let sweptOnce = false;
let downloadsSinceSweep = 0;

function framesDir(): Directory {
  return new Directory(Paths.cache, FRAMES_DIR);
}

/** First bytes of a file, without pulling a 180 KB PNG through the bridge. */
function headBytes(file: File, n: number): Uint8Array | null {
  let handle: ReturnType<File['open']> | null = null;
  try {
    handle = file.open(FileMode.ReadOnly);
    return handle.readBytes(n);
  } catch {
    return null;
  } finally {
    handle?.close();
  }
}

function looksLikePng(file: File): boolean {
  const head = headBytes(file, 8);
  return head !== null && isPngHeader(head);
}

/**
 * Bring the whole directory — this session's downloads AND every earlier
 * session's — inside {@link WEATHER_FRAME_BUDGET_BYTES}, least-recently-used
 * first. The LRU key is the FILE NAME, because that is the only identity an
 * orphan from a previous launch still has (the name is a hash of a URL and
 * cannot be reversed). Recency is the newer of the file's modification time
 * and this session's last read of it.
 *
 * Best-effort throughout: a cache sweep must never break a fetch.
 */
function sweep(): void {
  try {
    const dir = framesDir();
    if (!dir.exists) return;
    const files = dir.list().filter((e): e is File => e instanceof File);
    const sessionUsedAt = new Map<string, number>();
    for (const [url, hit] of memo) sessionUsedAt.set(frameFileName(url), hit.usedAt);
    const entries: FrameCacheEntry[] = files.map((f) => ({
      key: f.name,
      bytes: f.size,
      usedAt: Math.max(f.modificationTime ?? 0, sessionUsedAt.get(f.name) ?? 0),
    }));
    const doomed = new Set(
      selectEvictions(entries, WEATHER_FRAME_BUDGET_BYTES, pinned.map(frameFileName)),
    );
    if (doomed.size === 0) return;
    for (const f of files) {
      if (!doomed.has(f.name)) continue;
      try {
        f.delete();
      } catch {
        // Already gone, or the OS reclaimed the dir under us.
      }
    }
    // Anything just deleted must stop being reported as a cache hit.
    for (const url of [...memo.keys()]) {
      if (doomed.has(frameFileName(url))) memo.delete(url);
    }
  } catch {
    // No dir, no permission, OS reclaim mid-scan: nothing to enforce.
  }
}

/** Sweep on first use (adopting previous launches), then every SWEEP_EVERY. */
function maybeSweep(): void {
  if (!sweptOnce) {
    sweptOnce = true;
    downloadsSinceSweep = 0;
    sweep();
    return;
  }
  downloadsSinceSweep += 1;
  if (downloadsSinceSweep < SWEEP_EVERY) return;
  downloadsSinceSweep = 0;
  sweep();
}

/**
 * Tell the cache which frame URLs are on screen. They are exempt from
 * eviction: deleting the file under a live ImageSource would blank the drape,
 * which is precisely the guarantee the crossfade exists to hold.
 */
export function pinWeatherFrames(urls: readonly string[]): void {
  pinned = urls.filter((u) => u.length > 0);
}

/**
 * The local file for an already-cached frame, or null. Synchronous — the
 * playback tick uses it to tell "already warm" from "must wait".
 */
export function peekWeatherFrame(url: string): string | null {
  const hit = memo.get(url);
  if (hit === undefined) return null;
  hit.usedAt = Date.now();
  return hit.uri;
}

/**
 * Ensure a frame is on disk and return its `file://` URI, or null on any
 * failure (offline, aborted, HTTP error, or GeoMet answering an out-of-range
 * TIME with its HTTP-200 XML ServiceException — which would otherwise be
 * cached as an undecodable .png and blank that frame forever).
 *
 * Concurrent callers for the same URL share one download. A frame already on
 * disk is served with the radio off; DOWNLOADING one obeys the app's single
 * network switch ({@link isNetworkAllowed}), so turning "Locally downloaded
 * only" on mid-playback stops the prefetch queue dead instead of quietly
 * finishing it on the user's data plan.
 */
export async function ensureWeatherFrame(url: string): Promise<string | null> {
  const warm = peekWeatherFrame(url);
  if (warm !== null) return warm;
  const running = inflight.get(url);
  if (running !== undefined) return running;

  const task = (async (): Promise<string | null> => {
    try {
      const dir = framesDir();
      if (!dir.exists) dir.create({ intermediates: true });
      const file = new File(dir, frameFileName(url));
      // A previous session's file is a legitimate hit — the frame's URL pins
      // its layer, time, bbox and size, so identical URL means identical PNG.
      if (file.exists && file.size > 0 && looksLikePng(file)) {
        memo.set(url, { uri: file.uri, bytes: file.size, usedAt: Date.now() });
        maybeSweep();
        return file.uri;
      }
      if (file.exists) file.delete();
      if (!isNetworkAllowed()) return null;
      const downloaded = await File.downloadFileAsync(url, file, {
        headers: { 'User-Agent': USER_AGENT },
        idempotent: true,
      });
      if (!downloaded.exists || downloaded.size === 0 || !looksLikePng(downloaded)) {
        if (downloaded.exists) downloaded.delete();
        return null;
      }
      memo.set(url, { uri: downloaded.uri, bytes: downloaded.size, usedAt: Date.now() });
      maybeSweep();
      return downloaded.uri;
    } catch {
      // Offline, aborted, disk full, HTTP error: the caller keeps the frame
      // already on screen.
      return null;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, task);
  return task;
}

/**
 * Drop every cached frame. Called when the user turns "Locally downloaded
 * only" ON (`@data/offline`): the drape cannot draw at all in that mode, the
 * frames are pure network convenience, and a URL never recurs once TIME has
 * moved on — so this is the one moment the app knows the cache is worth
 * nothing to the user and disk is worth something.
 */
export function clearWeatherFrames(): void {
  memo.clear();
  pinned = [];
  // The next call re-adopts whatever survives, so the budget stays enforced.
  sweptOnce = false;
  downloadsSinceSweep = 0;
  try {
    const dir = framesDir();
    if (dir.exists) dir.delete();
  } catch {
    // Nothing cached, or the OS already reclaimed it.
  }
}
