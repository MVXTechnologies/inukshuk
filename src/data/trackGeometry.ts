import { parseGpx } from '@core/geo/gpx';
import { scanGpxTrack } from '@core/geo/gpx/scan';
import { parseTrackGeometry, simplifyTrack, type TrackGeometry } from '@core/geo/track/simplify';
import type { TrackPoint, TrackSummary } from '@core/models';

import * as storage from './storage';

/**
 * The one place a library trail's drawable geometry comes from (#465): the
 * map's trail lines, the personal heatmap, the 3D drape and the Library's
 * route thumbnails all read the SAME simplified geometry, so a 400-trail
 * library parses each GPX at most once — and, thanks to a small JSON cache
 * next to it, usually never (the importers prime it with the points already
 * in hand, and later launches read the cache).
 *
 * - In memory: one geometry per trail revision for the session.
 * - On disk: `cache/track-geometry/<id>.json`, `{ key, parts }`; a key
 *   mismatch (the trail was trimmed/merged/overwritten) or a corrupt file is
 *   recomputed from the GPX.
 * - One trail at a time: a cold library never parses several GPX files at
 *   once on the JS thread, and every loader yields between trails.
 *
 * `null` means the trail has nothing drawable (or its GPX could not be read).
 */

/** Revision key: everything an edit of the trail changes. */
export function trackGeometryKey(
  t: Pick<TrackSummary, 'id' | 'endedAt'> & {
    stats: Pick<TrackSummary['stats'], 'pointCount' | 'distanceM'>;
  },
): string {
  return `${t.id}|${t.stats.pointCount}|${t.stats.distanceM}|${t.endedAt ?? ''}`;
}

const memory = new Map<string, TrackGeometry | null>();
/** Trail id → the revision key held in `memory` (one revision per trail). */
const revisionOf = new Map<string, string>();
const inflight = new Map<string, Promise<TrackGeometry | null>>();
/** One-off reads in progress (see {@link readTrackGeometryOnce}), shared with loads. */
const transient = new Map<string, Promise<TrackGeometry | null>>();
let queue: Promise<unknown> = Promise.resolve();

/** Already-loaded geometry: the value, `null` (nothing drawable), or `undefined` (not loaded). */
export function peekTrackGeometry(t: TrackSummary): TrackGeometry | null | undefined {
  return memory.get(trackGeometryKey(t));
}

function remember(id: string, key: string, geometry: TrackGeometry | null): void {
  // One revision per trail in memory: an edited trail's old geometry goes.
  const previous = revisionOf.get(id);
  if (previous !== undefined && previous !== key) memory.delete(previous);
  revisionOf.set(id, key);
  memory.set(key, geometry);
}

function persist(id: string, key: string, geometry: TrackGeometry): void {
  try {
    storage.writeTrackGeometryCache(id, JSON.stringify({ key, parts: geometry.parts }));
  } catch {
    // A cache, never an error: a failed write only costs a re-parse later.
  }
}

async function readCached(id: string, key: string): Promise<TrackGeometry | null | undefined> {
  try {
    const text = await storage.readTrackGeometryCache(id);
    if (text === null) return undefined;
    const doc = JSON.parse(text) as { key?: unknown };
    if (doc.key !== key) return undefined;
    return parseTrackGeometry(doc) ?? undefined;
  } catch {
    return undefined;
  }
}

async function compute(t: TrackSummary, key: string): Promise<TrackGeometry | null> {
  const cached = await readCached(t.id, key);
  if (cached !== undefined) return cached;
  try {
    const text = await storage.readFileText(t.fileUri);
    // Positions only, by a tag scan: several times faster than the full XML
    // parse; anything that isn't a plain track goes through parseGpx.
    const { points, segmentStarts } = scanGpxTrack(text) ?? parseGpx(text);
    const geometry = simplifyTrack(points, segmentStarts);
    if (geometry.parts.length === 0) return null;
    persist(t.id, key, geometry);
    return geometry;
  } catch {
    return null;
  }
}

/**
 * The trail's simplified geometry, loading it (cache file, else GPX) when it
 * is not in memory yet. Loads are serialized and deduplicated.
 */
export function loadTrackGeometry(t: TrackSummary): Promise<TrackGeometry | null> {
  const key = trackGeometryKey(t);
  if (memory.has(key)) return Promise.resolve(memory.get(key) ?? null);
  const pending = inflight.get(key);
  if (pending) return pending;
  const next = queue
    .then(() =>
      memory.has(key) ? (memory.get(key) ?? null) : (transient.get(key) ?? compute(t, key)),
    )
    .catch(() => null)
    .then((geometry) => {
      remember(t.id, key, geometry);
      inflight.delete(key);
      return geometry;
    });
  queue = next;
  inflight.set(key, next);
  return next;
}

/**
 * The trail's simplified geometry for a one-off pass (the stored heatmap's
 * build, #500): the in-memory copy when there is one, else read (cache file,
 * else GPX) WITHOUT keeping it in memory — walking a whole library once must
 * not pin every trail's geometry for the session. Never throws.
 */
export async function readTrackGeometryOnce(t: TrackSummary): Promise<TrackGeometry | null> {
  const key = trackGeometryKey(t);
  if (memory.has(key)) return memory.get(key) ?? null;
  const pending = inflight.get(key) ?? transient.get(key);
  if (pending) return pending;
  const read = compute(t, key).catch(() => null);
  transient.set(key, read);
  try {
    return await read;
  } finally {
    transient.delete(key);
  }
}

/**
 * Seed the geometry of a trail whose points are already in hand (an import
 * or a finished recording), so nothing ever has to parse its GPX to draw it.
 * Best-effort: never throws.
 */
export function primeTrackGeometry(
  t: Pick<TrackSummary, 'id' | 'endedAt'> & {
    stats: Pick<TrackSummary['stats'], 'pointCount' | 'distanceM'>;
  },
  points: readonly TrackPoint[],
  segmentStarts: readonly number[] = [],
): void {
  try {
    const key = trackGeometryKey(t);
    const geometry = simplifyTrack(points, segmentStarts);
    if (geometry.parts.length === 0) return;
    remember(t.id, key, geometry);
    persist(t.id, key, geometry);
  } catch {
    // Priming is an optimisation; the lazy load still works.
  }
}

/** Test hook: forget every loaded geometry. */
export function clearTrackGeometryMemory(): void {
  memory.clear();
  revisionOf.clear();
  inflight.clear();
  transient.clear();
  queue = Promise.resolve();
}
