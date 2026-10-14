import { XMLBuilder } from 'fast-xml-parser';

import type { Area, Waypoint } from '@core/models';

/**
 * The GPX a shared set of waypoints and areas goes out as (#711): one file,
 * `Waypoints.gpx` in a zip. Waypoints are plain GPX 1.1 `<wpt>`s (name, note
 * as `<desc>`, time), which every app reads. GPX has no polygon, so areas
 * travel in the document's `<extensions>` as `inukshuk:area` elements, each
 * with its name, colour, note, tags and closed ring of points. An app that
 * does not know the namespace skips them; Inukshuk can read them back.
 *
 * Pure.
 */

/** The namespace of the area extension (same `urn:inukshuk:` family as the GNSS one). */
export const INUKSHUK_AREA_NS = 'urn:inukshuk:area:1';

const GPX_NS = 'http://www.topografix.com/GPX/1/1';
const A = '@_';

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: A,
  format: true,
  suppressEmptyNode: true,
});

const round = (n: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

const iso = (ms: number) => new Date(ms).toISOString();

type Node = Record<string, unknown>;

export function waypointsGpx(
  waypoints: readonly Waypoint[],
  areas: readonly Area[],
  name = 'Waypoints',
): string {
  const gpx: Node = {
    [`${A}version`]: '1.1',
    [`${A}creator`]: 'Inukshuk',
    [`${A}xmlns`]: GPX_NS,
  };
  if (areas.length > 0) gpx[`${A}xmlns:inukshuk`] = INUKSHUK_AREA_NS;
  gpx['metadata'] = { name };
  if (waypoints.length > 0) {
    gpx['wpt'] = waypoints.map((w) => {
      const node: Node = {
        [`${A}lat`]: round(w.latitude, 7),
        [`${A}lon`]: round(w.longitude, 7),
      };
      // GPX 1.1 wptType order: ele, time, …, name, cmt, desc.
      if (Number.isFinite(w.createdAt) && w.createdAt > 0) node['time'] = iso(w.createdAt);
      node['name'] = w.label;
      if (w.note !== undefined && w.note.trim() !== '') node['desc'] = w.note;
      return node;
    });
  }
  if (areas.length > 0) {
    gpx['extensions'] = {
      'inukshuk:area': areas.map((a) => {
        const node: Node = { 'inukshuk:name': a.name, 'inukshuk:color': a.color };
        if (a.note !== undefined && a.note.trim() !== '') node['inukshuk:note'] = a.note;
        if (a.tags && a.tags.length > 0) node['inukshuk:tag'] = [...a.tags];
        // The stored ring is open; a polygon in a file reads best closed.
        const first = a.ring[0];
        const ring = first ? [...a.ring, first] : [];
        node['inukshuk:polygon'] = {
          'inukshuk:pt': ring.map(([lon, lat]) => ({
            [`${A}lat`]: round(lat, 7),
            [`${A}lon`]: round(lon, 7),
          })),
        };
        return node;
      }),
    };
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({ gpx })}`;
}
