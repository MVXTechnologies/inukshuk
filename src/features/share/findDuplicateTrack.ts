import type { TrackSummary } from '@core/models';
import * as storage from '@data/storage';
import type { ImportedTrack } from '@features/library/importGpx';

/** Summary similarity only narrows candidates; deletion requires matching content. */
export async function findDuplicateTrack(
  incoming: ImportedTrack,
  candidates: readonly TrackSummary[],
): Promise<TrackSummary | undefined> {
  const possible = candidates.filter(
    (saved) =>
      saved.name === incoming.track.name &&
      saved.stats.pointCount === incoming.track.stats.pointCount &&
      Math.abs(saved.stats.distanceM - incoming.track.stats.distanceM) < 1,
  );
  if (possible.length === 0) return undefined;
  // Imports retain the original XML, including extensions our parser ignores.
  // Require the full text to match rather than discard unrecognized user data.
  // Formatting-only variants can be imported twice; that is safer than data loss.
  const content = await storage.readFileText(incoming.fileUri);
  for (const saved of possible) {
    // Library notes can differ from the GPX after editing. Never discard an
    // incoming note that the surviving library record would not retain.
    const notes = saved.notes ?? [];
    if (
      !incoming.notes.every((note) =>
        notes.some((old) => old.distanceM === note.distanceM && old.text === note.text),
      )
    ) {
      continue;
    }
    try {
      const existing = await storage.readFileText(saved.fileUri);
      if (existing === content) return saved;
    } catch {
      // Missing/unreadable/corrupt candidates cannot establish duplication.
    }
  }
  return undefined;
}
