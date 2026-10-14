import type { WaypointIconId } from '@core/library/waypointIconCatalog';

/**
 * The pin icon a waypoint is drawn with (#350, widened by #675). The value
 * space is the catalogue's id column (`@core/library/waypointIconCatalog`), so
 * an id is what `library.json` persists and what the GPX extension and team
 * shares carry; everything an icon *looks* like — its label, glyph, group and
 * `<sym>` — is in that same row and cannot fall out of step with it. The twelve
 * #350 ids (camp … hazard) are unchanged, `<sym>` spellings included.
 *
 * Absent on a waypoint means the default inukshuk pin, which is why the field
 * is optional and why nothing had to be migrated when it arrived.
 */
export type WaypointIcon = WaypointIconId;

/**
 * What a saved waypoint's `icon` field may hold: an icon this build knows, or
 * the id of one only a NEWER build knows. The latter is kept, not dropped, so
 * a rollback and a later upgrade give the pin its icon back; until then it
 * draws as the default pin (every icon lookup returns null for it). Narrow
 * with `isWaypointIcon` before treating it as a known icon.
 */
export type StoredWaypointIcon = WaypointIcon | (string & Record<never, never>);

/**
 * Pin size (#675): S/M/L/XL. Absent = M, the size every pin had before sizes
 * existed — so, like the icon and colour, nothing had to be migrated.
 */
export type WaypointSize = 'S' | 'M' | 'L' | 'XL';

/**
 * A standalone waypoint dropped at a GPS position from the map's "+" speed-dial,
 * outside any recording. Persisted in the library index (`library.json`).
 *
 * Waypoints dropped *during* a recording are `PendingWaypoint`s in the recorder
 * store instead — those are materialized as distance-anchored trail notes when
 * the recording stops. A standalone waypoint has no trail to anchor to, so it
 * keeps its coordinate for good.
 */
export interface Waypoint {
  id: string;
  latitude: number;
  longitude: number;
  /** Auto label ("Waypoint N"); shown as the marker/editor title. */
  label: string;
  note?: string;
  /** Chosen pin icon; absent (or unknown to this build) = the default inukshuk pin. */
  icon?: StoredWaypointIcon;
  /** Pin colour, `#RRGGBB` (#675); absent = the default sage pin. */
  color?: string;
  /** Pin size (#675); absent = M. */
  size?: WaypointSize;
  /** Absolute file:// uri of an attached photo stored in app storage, if any. */
  photoUri?: string;
  /** Owning folder, like maps/trails; absent = Ungrouped. */
  folderId?: string;
  createdAt: number;
}
