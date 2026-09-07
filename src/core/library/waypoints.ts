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

/**
 * The auto-generated waypoint name: `Waypoint 1`, `Waypoint 2`, … Only labels
 * still matching this shape take part in the numbering, so a waypoint the user
 * named ("Camp", "Source") simply stops competing for a number.
 */
const AUTO_LABEL = /^Waypoint (\d+)$/;

/**
 * Next free auto-number for a new waypoint: one past the highest `Waypoint N`
 * currently in the list. Deliberately NOT `length + 1` — deleting "Waypoint 1"
 * and dropping a new one must never mint a duplicate name.
 *
 * Shared by the store (which stamps the label at creation) and by the editor
 * (which pre-fills its Name field with the very same string, so a name the
 * user leaves alone numbers exactly as it always did).
 */
export function nextWaypointNumber(labels: readonly string[]): number {
  return (
    1 +
    labels.reduce((max, label) => {
      const m = AUTO_LABEL.exec(label);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0)
  );
}

/** {@link nextWaypointNumber} as the label itself, e.g. `Waypoint 7`. */
export function nextWaypointLabel(labels: readonly string[]): string {
  return `Waypoint ${nextWaypointNumber(labels)}`;
}
