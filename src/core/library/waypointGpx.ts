import type { GpxWaypoint } from '@core/geo/gpx';
import type { WaypointIcon, WaypointSize } from '@core/models';

import { gpxSymForWaypointIcon, isWaypointIcon, waypointIconForGpxSym } from './waypointIcons';
import { normalizeWaypointStyle } from './waypointStyle';

/**
 * A standalone waypoint ↔ a GPX `<wpt>` (#350, #675).
 *
 * Written: `<name>`, `<desc>` (the note), the canonical `<sym>` every GPX
 * reader understands, and — when the pin has any style — Inukshuk's
 * `<extensions><pin:style>` with the exact icon id, colour and size.
 *
 * Read: the extension wins when it names an icon this build knows (it is
 * exact, where `<sym>` is a lossy shared vocabulary); otherwise the `<sym>`
 * is looked up, so files from Garmin, OsmAnd or a 2.5.0 export still get
 * their icon. Junk colour or size is dropped: the default pin, never a
 * failed import.
 */

/** The waypoint fields a `<wpt>` carries. */
export interface GpxWaypointFields {
  latitude: number;
  longitude: number;
  label: string;
  note?: string;
  icon?: WaypointIcon;
  color?: string;
  size?: WaypointSize;
}

export function waypointToGpx(w: GpxWaypointFields): GpxWaypoint {
  const symbol = gpxSymForWaypointIcon(w.icon);
  const style = normalizeWaypointStyle({ color: w.color, size: w.size });
  const icon = w.icon !== undefined && isWaypointIcon(w.icon) ? w.icon : undefined;
  const pinStyle = {
    ...(icon !== undefined ? { icon } : {}),
    ...(style.color !== undefined ? { color: style.color } : {}),
    ...(style.size !== undefined ? { size: style.size } : {}),
  };
  const note = w.note?.trim();
  return {
    latitude: w.latitude,
    longitude: w.longitude,
    name: w.label,
    ...(note ? { description: note } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    ...(Object.keys(pinStyle).length > 0 ? { pinStyle } : {}),
  };
}

/** A parsed `<wpt>` → waypoint fields (label falls back to `fallbackLabel`). */
export function waypointFromGpx(g: GpxWaypoint, fallbackLabel: string): GpxWaypointFields {
  const extIcon = g.pinStyle?.icon;
  const icon = isWaypointIcon(extIcon) ? extIcon : waypointIconForGpxSym(g.symbol);
  const style = normalizeWaypointStyle({ color: g.pinStyle?.color, size: g.pinStyle?.size });
  const label = g.name?.trim() || fallbackLabel;
  const note = g.description?.trim();
  return {
    latitude: g.latitude,
    longitude: g.longitude,
    label,
    ...(note ? { note } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...style,
  };
}
