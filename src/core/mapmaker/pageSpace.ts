import type { BoundingBox, LngLat } from '@core/models';
import type { Position } from 'geojson';
import type { MadeMapLayout } from './layout';

/**
 * Geographic → page-point projection for the made-map composer.
 *
 * The basemap raster is stitched from WebMercator tiles and drawn to fill the
 * map frame, so vectors must use the SAME projection: linear in longitude,
 * mercator in latitude, both normalized over `drawBbox` and scaled into
 * `mapRect` (PDF points, y up). Anything else would drift off the raster
 * towards the frame's north/south edges.
 */

export interface PagePoint {
  x: number;
  y: number;
}

const mercY = (latDeg: number) => Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));

export function pageProjector(layout: MadeMapLayout): (p: LngLat) => PagePoint {
  const { drawBbox, mapRect } = layout;
  const y0 = mercY(drawBbox.minLat);
  const ySpan = mercY(drawBbox.maxLat) - y0;
  const lngSpan = drawBbox.maxLng - drawBbox.minLng;
  return ([longitude, latitude]: LngLat) => ({
    x: mapRect.x + ((longitude - drawBbox.minLng) / lngSpan) * mapRect.w,
    y: mapRect.y + ((mercY(latitude) - y0) / ySpan) * mapRect.h,
  });
}

// Cohen–Sutherland outcodes against the map frame.
const INSIDE = 0;
const LEFT = 1;
const RIGHT = 2;
const BOTTOM = 4;
const TOP = 8;

/**
 * Project GeoJSON line coordinates ([lng, lat]) into page points, clipped to
 * the map frame. Segments leaving the frame are cut at the border; a line
 * that exits and re-enters becomes multiple output lines; fully-outside
 * geometry vanishes. Output lines always have ≥ 2 points.
 */
export function projectLines(layout: MadeMapLayout, lines: Position[][]): PagePoint[][] {
  const { mapRect } = layout;
  const xMin = mapRect.x;
  const xMax = mapRect.x + mapRect.w;
  const yMin = mapRect.y;
  const yMax = mapRect.y + mapRect.h;
  const project = pageProjector(layout);

  const outcode = (p: PagePoint) =>
    (p.x < xMin ? LEFT : p.x > xMax ? RIGHT : INSIDE) |
    (p.y < yMin ? BOTTOM : p.y > yMax ? TOP : INSIDE);

  /** Clip one segment to the frame; null when entirely outside. */
  const clipSegment = (a: PagePoint, b: PagePoint): [PagePoint, PagePoint] | null => {
    let p0 = { ...a };
    let p1 = { ...b };
    let c0 = outcode(p0);
    let c1 = outcode(p1);
    for (;;) {
      if ((c0 | c1) === INSIDE) return [p0, p1];
      if ((c0 & c1) !== INSIDE) return null;
      const cOut = c0 !== INSIDE ? c0 : c1;
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      let q: PagePoint;
      if (cOut & TOP) q = { x: p0.x + (dx * (yMax - p0.y)) / dy, y: yMax };
      else if (cOut & BOTTOM) q = { x: p0.x + (dx * (yMin - p0.y)) / dy, y: yMin };
      else if (cOut & RIGHT) q = { x: xMax, y: p0.y + (dy * (xMax - p0.x)) / dx };
      else q = { x: xMin, y: p0.y + (dy * (xMin - p0.x)) / dx };
      if (cOut === c0) {
        p0 = q;
        c0 = outcode(p0);
      } else {
        p1 = q;
        c1 = outcode(p1);
      }
    }
  };

  const out: PagePoint[][] = [];
  for (const line of lines) {
    let current: PagePoint[] = [];
    for (let i = 0; i < line.length - 1; i++) {
      const [lngA, latA] = line[i]!;
      const [lngB, latB] = line[i + 1]!;
      const seg = clipSegment(project([lngA!, latA!]), project([lngB!, latB!]));
      if (!seg) {
        if (current.length >= 2) out.push(current);
        current = [];
        continue;
      }
      const [a, b] = seg;
      if (current.length === 0) current.push(a);
      else {
        const tip = current[current.length - 1]!;
        // The previous segment ended on the border and this one starts
        // elsewhere on it — that's a re-entry, not a continuation.
        if (Math.hypot(tip.x - a.x, tip.y - a.y) > 1e-9) {
          if (current.length >= 2) out.push(current);
          current = [a];
        }
      }
      current.push(b);
    }
    if (current.length >= 2) out.push(current);
  }
  return out;
}
