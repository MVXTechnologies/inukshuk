/**
 * Playback prefetch + frame-cache bookkeeping (perf work 2026-08-11).
 *
 * Weather playback is deterministic: at frame N the URLs of N+1, N+2 … are
 * already known. Since a GeoMet frame costs a ~0.3–0.8 s round trip and
 * essentially nothing to transfer (see `weatherDrape.ts`), fetching the next
 * frames WHILE the current one is on screen hides the whole latency behind
 * the {@link WEATHER_FRAME_INTERVAL_MS} tick — the tick then finds the frame
 * already on disk and playback runs at its natural cadence instead of at the
 * network's.
 *
 * Two deliberate bounds:
 * - the lookahead is small ({@link FRAME_LOOKAHEAD}). Warming a whole 31–48
 *   frame loop would burst 48 requests at a host whose usage policy asks for
 *   ~1 req/s, and on the continuous fields that is ~8.6 MB on someone's data
 *   plan for a loop they may not finish. A short lookahead keeps the request
 *   rate at roughly one per tick — 15x LESS than the tile grid it replaces —
 *   and the LRU below still makes the SECOND loop free, which was the point.
 * - the cache is byte-budgeted, not entry-counted: a radar frame is ~8 KB and
 *   a temperature frame ~180 KB, so counting entries would either starve
 *   radar or blow the disk on temperature.
 *
 * Pure; the file I/O lives in `@data/weatherFrames`.
 */

/** Frames warmed ahead of the one on screen. */
export const FRAME_LOOKAHEAD = 3;

/** Parallel warm downloads. Two keeps GeoMet's per-connection queueing happy
 * (measured: past ~8 concurrent, per-request latency starts climbing) while
 * still covering a tick. */
export const FRAME_PREFETCH_CONCURRENCY = 2;

/**
 * Frames to have on disk, most urgent first: the one being shown, then the
 * next `lookahead` in playback order, wrapping at the end of the loop.
 * Deduplicated and never longer than the timeline.
 */
export function prefetchFrameOrder(
  selectedIdx: number,
  frameCount: number,
  lookahead: number,
): number[] {
  if (!Number.isFinite(frameCount) || frameCount <= 0) return [];
  if (!Number.isFinite(selectedIdx)) return [];
  const start = ((Math.trunc(selectedIdx) % frameCount) + frameCount) % frameCount;
  const want = Math.min(frameCount, Math.max(0, Math.trunc(lookahead)) + 1);
  const out: number[] = [];
  for (let i = 0; i < want; i++) out.push((start + i) % frameCount);
  return out;
}

/** One cached frame, as the LRU sees it. */
export interface FrameCacheEntry {
  /** The frame's remote GetMap URL — the cache key. */
  key: string;
  bytes: number;
  /** Epoch ms of the last use (read or write). */
  usedAt: number;
}

/**
 * Which entries to drop so the cache fits `budgetBytes`, least-recently-used
 * first. `keep` is never evicted — those are the URLs the crossfade slots are
 * showing right now, and deleting one out from under MapLibre would blank the
 * drape, which is exactly the guarantee this work must not regress.
 */
export function selectEvictions(
  entries: readonly FrameCacheEntry[],
  budgetBytes: number,
  keep: readonly string[],
): string[] {
  let total = 0;
  for (const e of entries) total += e.bytes;
  if (total <= budgetBytes) return [];
  const pinned = new Set(keep);
  const victims = entries
    .filter((e) => !pinned.has(e.key))
    .slice()
    .sort((a, b) => a.usedAt - b.usedAt);
  const out: string[] = [];
  for (const v of victims) {
    if (total <= budgetBytes) break;
    out.push(v.key);
    total -= v.bytes;
  }
  return out;
}

/**
 * Which RESOLVED frames to forget so at most `max` stay addressable, oldest
 * first. This is the in-memory sibling of {@link selectEvictions}: the disk
 * cache holds the bitmaps, this map only holds the handful of them a slot may
 * still reference.
 *
 * `keep` is absolute — a key a crossfade slot is currently showing is NEVER
 * dropped, even if that leaves the map over `max`. Dropping one unmounts that
 * slot's ImageSource, which is a VISIBLE BLANK, and unpins the disk file so
 * the next sweep may delete it too. The window is real: the scrub throttle
 * lets four frames be published while the commit gate is still waiting out
 * its 4 s cap on the first one.
 */
export function selectResolvedEvictions(
  keys: readonly string[],
  keep: readonly string[],
  max: number,
): string[] {
  const protectedKeys = new Set(keep);
  const out: string[] = [];
  let remaining = keys.length;
  for (const key of keys) {
    if (remaining <= max) break;
    if (protectedKeys.has(key)) continue;
    out.push(key);
    remaining -= 1;
  }
  return out;
}

/** PNG magic — GeoMet answers a bad TIME or layer with HTTP 200 + an XML
 * ServiceException, which would otherwise land in the cache as a .png that
 * MapLibre silently fails to decode (a permanently blank frame). */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True when `head` starts with the PNG signature. */
export function isPngHeader(head: Uint8Array): boolean {
  if (head.length < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((b, i) => head[i] === b);
}

/**
 * Stable, filesystem-safe name for a frame URL. djb2 — short, deterministic,
 * only ever compared for equality.
 */
export function frameFileName(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = (Math.imul(h, 33) ^ url.charCodeAt(i)) >>> 0;
  // The hash alone would collide across layers only astronomically rarely,
  // but the length is free extra entropy and costs nothing to compare.
  return `f${h.toString(36)}_${url.length.toString(36)}.png`;
}
