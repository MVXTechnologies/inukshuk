/** SOS and rally on the live map: MapView children (the map module only). */
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { FeatureCollection } from 'geojson';
import { useMemo, type ReactElement } from 'react';

import { teamLabelFont } from './TeamMapLayers';
import { useTrailEdit } from './TrailEditor';

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

/** Team trails: their lines; the edited one's points; "editing" cues. */
export function useTeamTrailLayers(glyphs: string | undefined): ReactElement[] {
  const t = useSchemeTokens();
  const trails = useTeamStore((s) => s.teamTrails);
  const editors = useTeamStore((s) => s.editors);
  const view = useTeamStore((s) => s.view);
  const edit = useTrailEdit();
  const font = teamLabelFont(glyphs);
  const json = useMemo(() => {
    if (view === null) return '';
    const byId = new Map(view.members.map((m) => [m.id, m]));
    const features: FeatureCollection['features'] = [];
    for (const tr of trails) {
      const key = `${tr.owner}:${tr.id}`;
      const color = tr.color ?? byId.get(tr.owner)?.color ?? t.team.bubbleNew;
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: tr.vertices.map((v) => [v.lng, v.lat]) },
        properties: { kind: 'line', owner: tr.owner, trail: tr.id, name: tr.name, color },
      });
      const who = [...editors]
        .filter(([m, k]) => k === key && m !== view.me)
        .map(([m]) => byId.get(m)?.name.split(' ')[0] ?? 'Someone');
      const first = tr.vertices[0];
      if (who.length > 0 && first)
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [first.lng, first.lat] },
          properties: { kind: 'who', label: `✎ ${who.join(', ')} editing` },
        });
      if (edit.trail && edit.trail.owner === tr.owner && edit.trail.id === tr.id)
        for (const v of tr.vertices)
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [v.lng, v.lat] },
            properties: {
              kind: 'vertex',
              sel: v.id === edit.selected ? 1 : 0,
              ins: v.inserted ? 1 : 0,
            },
          });
    }
    return JSON.stringify({ type: 'FeatureCollection', features });
  }, [trails, editors, view, edit.trail, edit.selected, t.team.bubbleNew]);
  const data = useMemo(() => (json ? (JSON.parse(json) as FeatureCollection) : null), [json]);
  if (data === null || data.features.length === 0) return [];
  return [
    <GeoJSONSource key="team-trl" id="team-trl" data={data}>
      <Layer
        id="team-trl-casing"
        type="line"
        filter={['==', ['get', 'kind'], 'line'] as never}
        layout={{ 'line-join': 'round', 'line-cap': 'round' }}
        paint={{ 'line-color': t.team.mapPaper, 'line-width': 7 }}
      />
      <Layer
        id={TEAM_TRAIL_LINE}
        type="line"
        filter={['==', ['get', 'kind'], 'line'] as never}
        layout={{ 'line-join': 'round', 'line-cap': 'round' }}
        paint={{ 'line-color': ['get', 'color'] as never, 'line-width': 4 }}
      />
      <Layer
        id="team-trl-vertex"
        type="circle"
        filter={['==', ['get', 'kind'], 'vertex'] as never}
        paint={{
          'circle-radius': ['case', ['==', ['get', 'sel'], 1], 13, 7] as never,
          'circle-color': [
            'case',
            ['==', ['get', 'ins'], 1],
            t.team.bubbleNew,
            t.team.mapPaper,
          ] as never,
          'circle-stroke-width': 3,
          'circle-stroke-color': [
            'case',
            ['==', ['get', 'sel'], 1],
            t.team.mapInk,
            t.team.bubbleNew,
          ] as never,
        }}
      />
      {font ? (
        <Layer
          id="team-trl-who"
          type="symbol"
          filter={['==', ['get', 'kind'], 'who'] as never}
          layout={{
            'text-field': ['get', 'label'] as never,
            'text-font': font,
            'text-size': 12,
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
        <Layer id="team-trl-who" type="circle" paint={{ 'circle-radius': 0 }} />
      )}
    </GeoJSONSource>,
  ];
}

/** The team trail line layer (tap hit test). */
export const TEAM_TRAIL_LINE = 'team-trl-line';

/** The team trail under a tap, or null. */
export async function hitTestTeamTrail(
  map: {
    queryRenderedFeatures: (
      box: [[number, number], [number, number]],
      options: { layers: string[] },
    ) => Promise<unknown[]>;
  },
  px: number,
  py: number,
): Promise<{ owner: string; id: string; name: string } | null> {
  try {
    const found = await map.queryRenderedFeatures(
      [
        [px - 16, py - 16],
        [px + 16, py + 16],
      ],
      { layers: [TEAM_TRAIL_LINE] },
    );
    for (const f of found) {
      const p = (f as { properties?: Record<string, unknown> }).properties ?? {};
      if (typeof p['owner'] === 'string' && typeof p['trail'] === 'string')
        return {
          owner: p['owner'],
          id: p['trail'],
          name: typeof p['name'] === 'string' ? p['name'] : 'Trail',
        };
    }
  } catch {
    // Absent layer or mid-teardown.
  }
  return null;
}
