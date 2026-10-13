import type { WaypointIcon } from '@core/models';

import { isWaypointIcon } from './waypointIcons';

/**
 * The editor's remembered icons (#675): the ones the user starred
 * (favourites, owner addition) and the last few they picked (recents).
 * Persisted in settings as `waypointIcons`; pure list logic here.
 */
export interface WaypointIconPrefs {
  /** Starred icons, most recently starred first. */
  favorites: WaypointIcon[];
  /** Last picked icons, newest first, at most {@link MAX_RECENT_ICONS}. */
  recents: WaypointIcon[];
}

export const MAX_RECENT_ICONS = 5;
/** A ceiling, not a design target: the picker lists every favourite. */
export const MAX_FAVORITE_ICONS = 60;

export const EMPTY_WAYPOINT_ICON_PREFS: WaypointIconPrefs = { favorites: [], recents: [] };

function sanitizeList(raw: unknown, max: number): WaypointIcon[] {
  if (!Array.isArray(raw)) return [];
  const out: WaypointIcon[] = [];
  for (const v of raw) {
    // An id a later build added (or junk) is dropped, not kept as a tofu tile.
    if (isWaypointIcon(v) && !out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** Settings-file value → prefs; anything malformed falls back to empty lists. */
export function sanitizeWaypointIconPrefs(raw: unknown): WaypointIconPrefs {
  if (typeof raw !== 'object' || raw === null) return EMPTY_WAYPOINT_ICON_PREFS;
  const r = raw as { favorites?: unknown; recents?: unknown };
  return {
    favorites: sanitizeList(r.favorites, MAX_FAVORITE_ICONS),
    recents: sanitizeList(r.recents, MAX_RECENT_ICONS),
  };
}

/** Record a pick: it moves to the front of the recents. */
export function withRecentIcon(prefs: WaypointIconPrefs, icon: WaypointIcon): WaypointIconPrefs {
  if (prefs.recents[0] === icon) return prefs;
  return {
    ...prefs,
    recents: [icon, ...prefs.recents.filter((i) => i !== icon)].slice(0, MAX_RECENT_ICONS),
  };
}

/** Star or unstar an icon; a new star goes first. */
export function withFavoriteToggled(
  prefs: WaypointIconPrefs,
  icon: WaypointIcon,
): WaypointIconPrefs {
  const starred = prefs.favorites.includes(icon);
  return {
    ...prefs,
    favorites: starred
      ? prefs.favorites.filter((i) => i !== icon)
      : [icon, ...prefs.favorites].slice(0, MAX_FAVORITE_ICONS),
  };
}

/** What a new user's quick row starts with (the mockup's Tent, Water, Parking, Summit). */
export const SUGGESTED_ICONS: readonly WaypointIcon[] = ['camp', 'water', 'parking', 'summit'];

/**
 * The editor's quick row: the waypoint's own icon when it is in neither list
 * (so the current choice is always visible and selected), then favourites,
 * then recents, without repeats, at most `limit`. A short row is topped up
 * with {@link SUGGESTED_ICONS} so a new user is not shown an empty strip.
 */
export function quickRowIcons(
  current: WaypointIcon | undefined,
  prefs: WaypointIconPrefs,
  limit = 12,
): WaypointIcon[] {
  const out: WaypointIcon[] = [];
  const add = (i: WaypointIcon) => {
    if (!out.includes(i) && out.length < limit) out.push(i);
  };
  if (
    current !== undefined &&
    !prefs.favorites.includes(current) &&
    !prefs.recents.includes(current)
  ) {
    add(current);
  }
  prefs.favorites.forEach(add);
  prefs.recents.forEach(add);
  for (const i of SUGGESTED_ICONS) if (out.length < SUGGESTED_ICONS.length) add(i);
  return out;
}
