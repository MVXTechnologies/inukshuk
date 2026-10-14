import { liveLayerAnchor } from '@core/map/liveLayerOrder';
import type { LineLayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useMemo } from 'react';

type LinePaint = NonNullable<LineLayerSpecification['paint']>;
type LineLayout = NonNullable<LineLayerSpecification['layout']>;

const LAYOUT: LineLayout = { 'line-cap': 'round', 'line-join': 'round' };

/**
 * The trail being followed (#678), drawn on its own above the other trails
 * (2.5.1 QA: drawn only as an ordinary trail in its category colour, it was
 * a dim brown on the dark map). A bright line over a casing
 * (`map.followedTrail*`, per scheme), always on the map — even when the
 * Library hides that trail. Visual only; `path` is built once per trail
 * (`useFollowTrail`), so this re-renders only when the theme or trail changes.
 */
export function FollowedTrailLine({ path }: { path: [number, number][][] }) {
  const { followedTrail, followedTrailCasing } = useSchemeTokens().map;
  const data = useMemo(
    () => ({
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'MultiLineString' as const, coordinates: path },
    }),
    [path],
  );
  const casing = useMemo<LinePaint>(
    () => ({ 'line-color': followedTrailCasing, 'line-width': 8, 'line-opacity': 0.85 }),
    [followedTrailCasing],
  );
  const line = useMemo<LinePaint>(
    () => ({ 'line-color': followedTrail, 'line-width': 4.5 }),
    [followedTrail],
  );
  return (
    <GeoJSONSource id="followed-trail" data={data}>
      <Layer
        id="followed-trail-casing"
        beforeId={liveLayerAnchor('followed-trail-casing')}
        type="line"
        layout={LAYOUT}
        paint={casing}
      />
      <Layer
        id="followed-trail-line"
        beforeId={liveLayerAnchor('followed-trail-line')}
        type="line"
        layout={LAYOUT}
        paint={line}
      />
    </GeoJSONSource>
  );
}
