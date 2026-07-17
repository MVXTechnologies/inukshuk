/**
 * Pure helpers for the Library's Waypoints section: display ordering and the
 * one-line note preview shown under a waypoint's label.
 */

/** Longest note preview shown in a Library row before it is ellipsized. */
export const NOTE_PREVIEW_MAX_CHARS = 80;

/**
 * Waypoints ordered for the Library list: newest first (the store appends, so
 * persisted order is oldest-first). Ties keep their stored relative order.
 */
export function sortWaypointsNewestFirst<T extends { createdAt: number }>(
  waypoints: readonly T[],
): T[] {
  return [...waypoints].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * One-line preview of a waypoint note: whitespace (including newlines) is
 * collapsed to single spaces, and anything longer than `maxChars` is cut at
 * the limit with an ellipsis. Returns `null` for a missing or blank note so
 * the row can omit the preview line entirely.
 */
export function notePreview(
  note: string | undefined,
  maxChars: number = NOTE_PREVIEW_MAX_CHARS,
): string | null {
  if (!note) return null;
  const flat = note.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars).trimEnd()}…`;
}
