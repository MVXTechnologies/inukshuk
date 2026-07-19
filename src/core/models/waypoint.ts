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
  /** Absolute file:// uri of an attached photo stored in app storage, if any. */
  photoUri?: string;
  /** Owning folder, like maps/trails; absent = Ungrouped. */
  folderId?: string;
  createdAt: number;
}
