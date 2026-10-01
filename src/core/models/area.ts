import type { LngLat } from './geo';

/**
 * A user-drawn area (#503): a polygon on the map with a name, a note,
 * photos, a colour and optional tags — "the blueberry slope", "the deer
 * stand's field of view", "private land, keep out". Persisted in the library
 * index (`library.json`) like standalone waypoints.
 *
 * The ring is stored OPEN (first vertex not repeated) and holds at least
 * three vertices; GeoJSON export closes it. Coordinates are `[lng, lat]`.
 */
export interface Area {
  id: string;
  name: string;
  /** The polygon's vertices, open ring, ≥ 3 (see the model note). */
  ring: LngLat[];
  /** `#RRGGBB` from `AREA_COLORS` (`@core/library/areas`). */
  color: string;
  note?: string;
  /** Absolute file:// uris of photos copied into app storage, in display order. */
  photoUris?: string[];
  /** Free-form labels ("Berries", "Private"), trimmed and de-duplicated. */
  tags?: string[];
  /** Owning folder, like the other library items; absent = Ungrouped. */
  folderId?: string;
  createdAt: number;
  updatedAt?: number;
}
