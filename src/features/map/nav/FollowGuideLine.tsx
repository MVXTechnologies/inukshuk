import { liveLayerAnchor } from '@core/map/liveLayerOrder';
import { groupLines } from '@core/terrain3d/lineGroups';
import type { LatLng } from '@core/models';
import type { LineLayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useMemo } from 'react';
import { useTerrainLineGroup, useTerrainView } from '../hooks/useTerrainLines';

type LineLayout = NonNullable<LineLayerSpecification['layout']>;
type LinePaint = NonNullable<LineLayerSpecification['paint']>;

/** Fixed, so the native layer is not re-diffed on every fix. */
const LAYOUT: LineLayout = { 'line-cap': 'round' };

/**
 * Off the followed trail (#678): a dashed amber line from you to the nearest
 * point of the trail, so "which way back" is on the map as well as on the
 * compass. Visual only. Render inside <Map>; one tiny GeoJSON line, rebuilt
 * per fix only while off the trail.
 */
export function FollowGuideLine({ from, to }: { from: LatLng; to: LatLng }) {
  const t = useSchemeTokens();
  const color = t.map.gnssWarn;
  // Changes with the theme only, never per fix.
  const paint = useMemo<LinePaint>(
    () => ({ 'line-color': color, 'line-width': 2, 'line-dasharray': [2, 2] }),
    [color],
  );
  const data = useMemo(
    () => ({
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [from.longitude, from.latitude],
          [to.longitude, to.latitude],
        ],
      },
    }),
    [from.latitude, from.longitude, to.latitude, to.longitude],
  );
  // #735: the same guide on the 3D terrain (solid there: the scene draws no dashes).
  const view = useTerrainView();
  const terrainLines = useMemo(
    () =>
      view === null
        ? null
        : groupLines('followGuide', [{ geometry: data.geometry }], {
            color,
            halo: color,
            haloOpacity: 0,
            width: 2,
            haloAdd: 0,
            order: 0,
          }),
    [view, data, color],
  );
  useTerrainLineGroup('followGuide', terrainLines);
  return (
    <GeoJSONSource id="follow-guide" data={data}>
      <Layer
        id="follow-guide-line"
        beforeId={liveLayerAnchor('follow-guide-line')}
        type="line"
        layout={LAYOUT}
        paint={paint}
      />
    </GeoJSONSource>
  );
}
