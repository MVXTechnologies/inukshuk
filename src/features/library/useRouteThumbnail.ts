import { geometryPoints } from '@core/geo/track/simplify';
import { buildRouteThumbnail, type RouteThumbnail } from '@core/library/routeThumbnail';
import type { TrackSummary } from '@core/models';
import { loadTrackGeometry } from '@data/trackGeometry';
import { useEffect, useState } from 'react';

/**
 * Route thumbnails for Library rows, drawn from each trail's shared
 * simplified geometry (`@data/trackGeometry` — the same one the map uses,
 * cached on disk, so a 400-trail Library no longer parses 400 GPX files every
 * time it opens, #465) and memoized per trail id + revision for the session.
 *
 * - One GPX at a time: a long library must not parse 20 recordings at once
 *   on the JS thread the moment the tab opens.
 * - The revision is everything a trim/merge/overwrite changes in the summary
 *   (file, point count, distance, end), so an edited trail redraws while an
 *   unchanged one never re-reads its file.
 * - A failed read caches `null` (the row shows the empty paper tile) — a
 *   thumbnail is decoration, never an error.
 */

const MAX_CACHED = 400;
const cache = new Map<string, RouteThumbnail | null>();
const inflight = new Map<string, Promise<RouteThumbnail | null>>();
let queue: Promise<unknown> = Promise.resolve();

export function thumbnailKey(track: TrackSummary): string {
  return [
    track.id,
    track.fileUri,
    track.stats.pointCount,
    Math.round(track.stats.distanceM),
    track.endedAt ?? '',
  ].join('|');
}

function remember(key: string, thumb: RouteThumbnail | null) {
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, thumb);
}

function load(track: TrackSummary, key: string): Promise<RouteThumbnail | null> {
  const pending = inflight.get(key);
  if (pending) return pending;
  const next = queue
    .then(async () => {
      const geometry = await loadTrackGeometry(track);
      return geometry ? buildRouteThumbnail(geometryPoints(geometry)) : null;
    })
    .catch(() => null)
    .then((thumb) => {
      remember(key, thumb);
      inflight.delete(key);
      return thumb;
    });
  queue = next;
  inflight.set(key, next);
  return next;
}

/** Test hook: forget every cached thumbnail. */
export function clearRouteThumbnailCache() {
  cache.clear();
  inflight.clear();
  queue = Promise.resolve();
}

/**
 * The trail's thumbnail: `undefined` while loading, `null` when the GPX has
 * nothing drawable (or could not be read).
 */
export function useRouteThumbnail(track: TrackSummary): RouteThumbnail | null | undefined {
  const key = thumbnailKey(track);
  const [loaded, setLoaded] = useState<{ key: string; thumb: RouteThumbnail | null }>();

  useEffect(() => {
    if (cache.has(key)) return;
    let cancelled = false;
    void load(track, key).then((thumb) => {
      if (!cancelled) setLoaded({ key, thumb });
    });
    return () => {
      cancelled = true;
    };
  }, [key, track]);

  if (cache.has(key)) return cache.get(key);
  return loaded?.key === key ? loaded.thumb : undefined;
}
