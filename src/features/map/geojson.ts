import { splitSegments, type SegmentStarts } from '@core/geo/track/segments';
import type { BoundingBox, LngLat, TrackPoint } from '@core/models';
import type { LngLatBounds } from '@maplibre/maplibre-react-native';
import type { Feature, LineString, MultiLineString } from 'geojson';

/** A trail trace: one LineString, or one MultiLineString when pauses cut it. */
export type TrailLineFeature = Feature<LineString | MultiLineString>;

/**
 * Build a GeoJSON line feature from recorded points, one part per recording
 * segment (`segmentStarts`, see `@core/geo/track/segments`) so the trace is
 * never drawn across a pause. Segments of fewer than 2 points draw nothing;
 * null when no segment can be drawn.
 */
export function toLineFeature(
  points: readonly TrackPoint[],
  segmentStarts: SegmentStarts = [],
): TrailLineFeature | null {
  const parts = splitSegments(points, segmentStarts)
    .map((segment) => segment.map((p): LngLat => [p.longitude, p.latitude]))
    .filter((part) => part.length >= 2);
  const [only] = parts;
  if (only === undefined) return null;
  return {
    type: 'Feature',
    geometry:
      parts.length === 1
        ? { type: 'LineString', coordinates: only }
        : { type: 'MultiLineString', coordinates: parts },
    properties: {},
  };
}

/** The polylines of a trail feature, one per segment. */
export function lineStringsOf(feature: TrailLineFeature): LngLat[][] {
  const g = feature.geometry;
  return g.type === 'LineString' ? [g.coordinates as LngLat[]] : (g.coordinates as LngLat[][]);
}

/** Convert our WGS84 bbox to MapLibre's [west, south, east, north] bounds. */
export function toLngLatBounds(b: BoundingBox): LngLatBounds {
  return [b.minLng, b.minLat, b.maxLng, b.maxLat];
}
