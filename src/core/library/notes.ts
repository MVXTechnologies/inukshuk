import { interpolateTrackAtDistance } from '@core/geo/track';
import type { TrackNote, TrackPoint } from '@core/models';

/**
 * Pure helpers for trail annotations. No platform deps — the Zustand store and
 * the GPX editor are thin wrappers over these. Notes are anchored by distance
 * along the trail so their order (and numbering) is independent of insertion.
 */

/** Notes ordered along the trail (by distance, then creation) for stable numbering. */
export function orderNotes(notes: readonly TrackNote[]): TrackNote[] {
  return [...notes].sort((a, b) => a.distanceM - b.distanceM || a.createdAt - b.createdAt);
}

/** A note resolved to its on-trail coordinates, numbered in trail order. */
export interface NumberedTrailNote {
  note: TrackNote;
  /** 1-based number in trail order — the same number shown beside it in note lists. */
  num: number;
  latitude: number;
  longitude: number;
}

/**
 * Number the notes 1..N in trail order (orderNotes) and anchor each to its
 * position on the track, so map pins and list rows share one numbering. Notes
 * whose distance can't be resolved (empty track) are dropped.
 */
export function numberNotesOnTrack(
  points: readonly TrackPoint[],
  notes: readonly TrackNote[],
): NumberedTrailNote[] {
  if (points.length === 0) return [];
  return orderNotes(notes).flatMap((note, i) => {
    const at = interpolateTrackAtDistance(points, note.distanceM);
    return at ? [{ note, num: i + 1, latitude: at.latitude, longitude: at.longitude }] : [];
  });
}

/** Remove the note with `id`. */
export function removeNoteById(notes: readonly TrackNote[], id: string): TrackNote[] {
  return notes.filter((n) => n.id !== id);
}

/** Replace the text of the note with `id` (trimmed); other notes untouched. */
export function updateNoteText(notes: readonly TrackNote[], id: string, text: string): TrackNote[] {
  return notes.map((n) => (n.id === id ? { ...n, text: text.trim() } : n));
}
