import { refreshClimbStats, refreshMovingStats } from '@core/geo/track';
import type { TrackPoint, TrackSummary } from '@core/models';
import { useLibraryStore } from '@state/libraryStore';
import { useEffect } from 'react';

/**
 * Persist up-to-date moving time / moving speed for an open trail (#504).
 *
 * Stats saved before the moving-time algorithm — or computed for a category
 * the trail has since left — carry a stale `movingModel` stamp. Once the
 * viewer has the trail's points loaded, recompute just the moving fields and
 * write them to the library index, so the Library, Logbook and dashboard pick
 * up the corrected value too. Current stamps (and a point list that doesn't
 * match the stored stats, e.g. mid-trim reload) are a no-op, so this settles
 * after one write and never runs a library-wide pass.
 *
 * The same visit upgrades the climb (`refreshClimbStats`): trails saved
 * before the saved-trail climb rule — notably Garmin Connect courses whose
 * terrain-lookup elevations read as thousands of metres of extra D+ — get
 * their ascent/descent recomputed in the same single write. Drawn routes keep
 * the drawing tool's climb.
 */
export function useLazyMovingStats(
  track: TrackSummary | undefined,
  points: readonly TrackPoint[] | null,
  segmentStarts: readonly number[],
): void {
  const updateTrack = useLibraryStore((s) => s.updateTrack);
  const id = track?.id;
  const stats = track?.stats;
  const category = track?.category;
  const planned = track?.plan !== undefined;
  useEffect(() => {
    if (id === undefined || stats === undefined || points === null) return;
    const moving = refreshMovingStats(stats, category, points, segmentStarts);
    const climb = planned ? null : refreshClimbStats(moving ?? stats, points, segmentStarts);
    const next = climb ?? moving;
    if (next) updateTrack(id, { stats: next });
  }, [id, stats, category, planned, points, segmentStarts, updateTrack]);
}
