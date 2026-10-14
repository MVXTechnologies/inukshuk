import { liveLayerAnchor } from '@core/map/liveLayerOrder';
import { useMapStore } from '@state/mapStore';
import { useWaypointMoveStore } from '@state/waypointMoveStore';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { FeatureCollection } from 'geojson';
import { useMemo } from 'react';

/**
 * Move mode on the map itself (#676): a dashed line from where the pin was to
 * where it will go (the map's settled centre), and a ring on the old spot.
 * Updated once per settled camera, like the bar's coordinates — never per
 * frame — so during a pan the line keeps its last end until the map settles.
 */
export function MoveWaypointLayers() {
  const target = useWaypointMoveStore((s) => s.moving);
  const center = useMapStore((s) => s.mapCenter);
  const { mapInk, mapHalo } = useSchemeTokens().team;
  const data = useMemo((): FeatureCollection | null => {
    if (target === null) return null;
    const from: [number, number] = [target.from.longitude, target.from.latitude];
    const to: [number, number] = center ? [center.longitude, center.latitude] : from;
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { kind: 'line' },
          geometry: { type: 'LineString', coordinates: [from, to] },
        },
        {
          type: 'Feature',
          properties: { kind: 'from' },
          geometry: { type: 'Point', coordinates: from },
        },
      ],
    };
  }, [target, center]);
  const layers = useMemo(
    () => [
      <Layer
        key="line"
        id="waypoint-move-line"
        beforeId={liveLayerAnchor('waypoint-move-line')}
        type="line"
        filter={['==', ['get', 'kind'], 'line']}
        layout={{ 'line-cap': 'round' }}
        paint={{
          'line-color': mapInk,
          'line-width': 1.5,
          'line-opacity': 0.75,
          'line-dasharray': [3, 3],
        }}
      />,
      <Layer
        key="from"
        id="waypoint-move-from"
        beforeId={liveLayerAnchor('waypoint-move-from')}
        type="circle"
        filter={['==', ['get', 'kind'], 'from']}
        paint={{
          'circle-radius': 6,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': mapInk,
          'circle-stroke-opacity': 0.85,
          'circle-pitch-alignment': 'map',
        }}
      />,
      <Layer
        key="from-halo"
        id="waypoint-move-from-halo"
        beforeId={liveLayerAnchor('waypoint-move-from-halo')}
        type="circle"
        filter={['==', ['get', 'kind'], 'from']}
        paint={{
          'circle-radius': 6,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-width': 3.5,
          'circle-stroke-color': mapHalo,
          'circle-stroke-opacity': 0.6,
          'circle-pitch-alignment': 'map',
        }}
      />,
    ],
    [mapInk, mapHalo],
  );
  if (data === null) return null;
  return (
    <GeoJSONSource id="waypoint-move" data={data}>
      {layers}
    </GeoJSONSource>
  );
}
