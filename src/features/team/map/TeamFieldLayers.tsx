/** SOS and rally on the live map: MapView children (the map module only). */
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { FeatureCollection } from 'geojson';
import { useMemo, type ReactElement } from 'react';

import { teamLabelFont } from './TeamMapLayers';

/**
 * The SOS marker (at the raiser's live position, else where it was raised;
 * never clustered, shown whether or not signal mode is on) and the rally
 * point's flag and circle, as MapView children.
 */
export function useTeamFieldLayers(glyphs: string | undefined): ReactElement[] {
  const t = useSchemeTokens();
  const soses = useTeamStore((s) => s.soses);
  const rally = useTeamStore((s) => s.rally);
  const positions = useTeamStore((s) => s.positions);
  const active = useTeamStore((s) => s.view !== null && s.view.active);
  const font = teamLabelFont(glyphs);
  const sosJson = JSON.stringify({
    type: 'FeatureCollection',
    features: soses
      .filter((s) => !s.resolved)
      .map((s) => {
        const live = positions.find((p) => p.id === s.owner);
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: live ? [live.lon, live.lat] : [s.lng, s.lat] },
          properties: { id: s.id },
        };
      }),
  });
  const sosData = useMemo(() => JSON.parse(sosJson) as FeatureCollection, [sosJson]);
  const rallyData = useMemo((): FeatureCollection | null => {
    if (rally === null) return null;
    const ring = Array.from({ length: 41 }, (_, i) => {
      const a = (i / 40) * 2 * Math.PI;
      return [
        rally.lng +
          ((rally.radius / 111_320) * Math.cos(a)) / Math.cos((rally.lat * Math.PI) / 180),
        rally.lat + (rally.radius / 111_320) * Math.sin(a),
      ];
    });
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [ring] },
          properties: { k: 'area' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [rally.lng, rally.lat] },
          properties: { k: 'flag', label: rally.text ? `⚑ ${rally.text}` : '⚑ Meet here' },
        },
      ],
    };
  }, [rally]);
  if (!active) return [];
  const out: ReactElement[] = [];
  if (rallyData) {
    out.push(
      <GeoJSONSource key="team-rally" id="team-rally" data={rallyData}>
        <Layer
          id="team-rally-area"
          type="fill"
          filter={['==', ['get', 'k'], 'area'] as never}
          paint={{ 'fill-color': t.team.bubbleNew, 'fill-opacity': 0.16 }}
        />
        <Layer
          id="team-rally-edge"
          type="line"
          filter={['==', ['get', 'k'], 'area'] as never}
          paint={{ 'line-color': t.team.bubbleNew, 'line-width': 2, 'line-dasharray': [2, 1] }}
        />
        <Layer
          id="team-rally-dot"
          type="circle"
          filter={['==', ['get', 'k'], 'flag'] as never}
          paint={{
            'circle-radius': 9,
            'circle-color': t.team.bubbleNew,
            'circle-stroke-width': 3,
            'circle-stroke-color': t.team.mapPaper,
          }}
        />
        {font ? (
          <Layer
            id="team-rally-label"
            type="symbol"
            filter={['==', ['get', 'k'], 'flag'] as never}
            layout={{
              'text-field': ['get', 'label'] as never,
              'text-font': font,
              'text-size': 13,
              'text-anchor': 'bottom',
              'text-offset': [0, -1],
              'text-allow-overlap': true,
            }}
            paint={{
              'text-color': t.team.mapInk,
              'text-halo-color': t.team.mapHalo,
              'text-halo-width': 2,
            }}
          />
        ) : (
          <Layer id="team-rally-label" type="circle" paint={{ 'circle-radius': 0 }} />
        )}
      </GeoJSONSource>,
    );
  }
  if (sosData.features.length > 0) {
    out.push(
      <GeoJSONSource key="team-sos" id="team-sos" data={sosData}>
        <Layer
          id="team-sos-halo"
          type="circle"
          paint={{ 'circle-radius': 30, 'circle-color': t.team.sos, 'circle-opacity': 0.25 }}
        />
        <Layer
          id="team-sos-dot"
          type="circle"
          paint={{
            'circle-radius': 18,
            'circle-color': t.team.sos,
            'circle-stroke-width': 3,
            'circle-stroke-color': t.team.sosInk,
          }}
        />
        {font ? (
          <Layer
            id="team-sos-label"
            type="symbol"
            layout={{
              'text-field': 'SOS',
              'text-font': font,
              'text-size': 12,
              'text-allow-overlap': true,
              'text-ignore-placement': true,
            }}
            paint={{ 'text-color': t.team.sosInk }}
          />
        ) : (
          <Layer id="team-sos-label" type="circle" paint={{ 'circle-radius': 0 }} />
        )}
      </GeoJSONSource>,
    );
  }
  return out;
}
