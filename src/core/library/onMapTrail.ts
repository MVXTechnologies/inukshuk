/**
 * A trail opened with the trail view's "On map" (#710): a LOOK, not a change
 * to the Library. It is drawn alone on the main map, over whatever the
 * Library's eye toggles show, until its chip's ✕ closes it — and then the
 * map shows exactly what it showed before, because that set was never
 * touched. Session-only (like a shown long-distance trail): a restart puts
 * the map back on the Library's set.
 *
 * Trails switched on in the Library (the eye toggle) stay persistent, as
 * before, and carry no chip. Any deliberate change to that set while a trail
 * is shown this way ends the look (the user has taken the map back).
 *
 * Pure: the store (`@state/onMapTrailStore`) and the map feed it.
 */

export interface OnMapTrailRef {
  id: string;
  name: string;
}

/**
 * The trails the main map draws: the "On map" trail alone while one is shown
 * (and still exists), else the Library's set, in any visibility mode.
 */
export function withOnMapTrail(
  base: readonly string[],
  onMapId: string | null,
  exists: (id: string) => boolean,
): readonly string[] {
  if (onMapId === null || !exists(onMapId)) return base;
  return [onMapId];
}

/**
 * The chip to show on the map, or null: none without an "On map" trail, when
 * that trail is gone, and never while following it (#678: following has its
 * own chip and ✕).
 */
export function onMapChipTrail(
  onMapId: string | null,
  tracks: readonly OnMapTrailRef[],
  followingId: string | null,
): OnMapTrailRef | null {
  if (onMapId === null || onMapId === followingId) return null;
  const track = tracks.find((t) => t.id === onMapId);
  return track === undefined ? null : { id: track.id, name: track.name };
}

/** Same members, in any order (a filter that removed nothing is no change). */
export function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}
