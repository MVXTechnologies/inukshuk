import { TRAILS_ANCHOR } from '@core/geo/mapLayerStack';
import type { Area } from '@core/models';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useMemo } from 'react';

/**
 * The library's drawn areas on the main map (#503): a translucent fill in
 * each area's colour under a solid outline, the selected one (its card open)
 * outlined heavier. They sit with the user's own content — above the PDF
 * maps and terrain overlays, below the trails and the position puck (the
 * `TRAILS_ANCHOR` slot, see `@core/geo/mapLayerStack`).
 *
 * The source is serialized once per data change (a string `data` passes
 * through `<GeoJSONSource>` untouched), and the selection only flips the
 * layers' filters.
 */

export function areasFeatureCollection(areas: readonly Area[]) {
  return {
    type: 'FeatureCollection',
    features: areas.map((a) => {
      const first = a.ring[0];
      return {
        type: 'Feature',
        id: a.id,
        properties: { id: a.id, color: a.color },
        geometry: {
          type: 'Polygon',
          coordinates: [first ? [...a.ring, first] : []],
        },
      };
    }),
  };
}

export function AreaLayers({
  areas,
  selectedId,
}: {
  areas: readonly Area[];
  selectedId: string | null;
}) {
  const data = useMemo(() => JSON.stringify(areasFeatureCollection(areas)), [areas]);
  if (areas.length === 0) return null;
  const sel = selectedId ?? '';
  return (
    <GeoJSONSource id="library-areas" data={data}>
      {[
        <Layer
          key="fill"
          id="library-areas-fill"
          beforeId={TRAILS_ANCHOR}
          type="fill"
          paint={{
            'fill-color': ['get', 'color'] as never,
            'fill-opacity': ['case', ['==', ['get', 'id'], sel], 0.26, 0.16] as never,
          }}
        />,
        <Layer
          key="line"
          id="library-areas-line"
          beforeId={TRAILS_ANCHOR}
          type="line"
          layout={{ 'line-join': 'round' }}
          paint={{
            'line-color': ['get', 'color'] as never,
            'line-width': ['case', ['==', ['get', 'id'], sel], 4, 2.5] as never,
          }}
        />,
      ]}
    </GeoJSONSource>
  );
}
