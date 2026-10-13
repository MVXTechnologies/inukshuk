import type { LatLng } from '@core/models';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useMemo } from 'react';

/**
 * Off the followed trail (#678): a dashed amber line from you to the nearest
 * point of the trail, so "which way back" is on the map as well as on the
 * compass. Visual only. Render inside <Map>; one tiny GeoJSON line, rebuilt
 * per fix only while off the trail.
 */
export function FollowGuideLine({ from, to }: { from: LatLng; to: LatLng }) {
  const t = useSchemeTokens();
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
  return (
    <GeoJSONSource id="follow-guide" data={data}>
      <Layer
        id="follow-guide-line"
        type="line"
        layout={{ 'line-cap': 'round' }}
        paint={{ 'line-color': t.map.gnssWarn, 'line-width': 2, 'line-dasharray': [2, 2] }}
      />
    </GeoJSONSource>
  );
}
