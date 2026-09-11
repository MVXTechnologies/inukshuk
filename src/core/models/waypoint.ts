/**
 * A standalone waypoint dropped at a GPS position from the map's "+" speed-dial,
 * outside any recording. Persisted in the library index (`library.json`).
 *
 * Waypoints dropped *during* a recording are `PendingWaypoint`s in the recorder
 * store instead — those are materialized as distance-anchored trail notes when
 * the recording stops. A standalone waypoint has no trail to anchor to, so it
 * keeps its coordinate for good.
 */
/**
 * The pin icon a waypoint is drawn with (#350). The value space lives here,
 * with the model, because it is what `library.json` persists and what GPX
 * `<sym>` round-trips; everything an icon *looks* like — its label, its
 * MaterialCommunityIcons glyph, its `<sym>` spelling — is in the catalogue at
 * `@core/library/waypointIcons`, which is keyed by this union and so cannot
 * fall out of step with it.
 *
 * Absent on a waypoint means the default inukshuk pin, which is why the field
 * is optional and why nothing had to be migrated when it arrived.
 */
export type WaypointIcon =
  | 'camp'
  | 'shelter'
  | 'water'
  | 'food'
  | 'trailhead'
  | 'parking'
  | 'summit'
  | 'viewpoint'
  | 'ford'
  | 'gate'
  | 'cache'
  | 'hazard';

export interface Waypoint {
  id: string;
  latitude: number;
  longitude: number;
  /** Auto label ("Waypoint N"); shown as the marker/editor title. */
  label: string;
  note?: string;
  /** Chosen pin icon; absent = the default inukshuk pin. */
  icon?: WaypointIcon;
  /** Absolute file:// uri of an attached photo stored in app storage, if any. */
  photoUri?: string;
  /** Owning folder, like maps/trails; absent = Ungrouped. */
  folderId?: string;
  createdAt: number;
}
