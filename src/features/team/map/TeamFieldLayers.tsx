/** SOS and rally on the live map: MapView children (the map module only). */
import { liveLayerAnchor } from '@core/map/liveLayerOrder';
import { selectionHighlight } from '@core/map/selectionHighlight';
import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import { useMapStore } from '@state/mapStore';
import { useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { FeatureCollection } from 'geojson';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { AppState } from 'react-native';
import { useTheme } from '@ui/paper';
import { useReducedMotion } from 'react-native-reanimated';

import { teamLabelFont } from './TeamMapLayers';
import { useTeamSheet } from './teamMode';
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
          beforeId={liveLayerAnchor('team-rally-area')}
          type="fill"
          filter={['==', ['get', 'k'], 'area'] as never}
          paint={{ 'fill-color': t.team.bubbleNew, 'fill-opacity': 0.16 }}
        />
        <Layer
          id="team-rally-edge"
          beforeId={liveLayerAnchor('team-rally-edge')}
          type="line"
          filter={['==', ['get', 'k'], 'area'] as never}
          paint={{ 'line-color': t.team.bubbleNew, 'line-width': 2, 'line-dasharray': [2, 1] }}
        />
        <Layer
          id="team-rally-dot"
          beforeId={liveLayerAnchor('team-rally-dot')}
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
            beforeId={liveLayerAnchor('team-rally-label')}
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
          <Layer
            id="team-rally-label"
            beforeId={liveLayerAnchor('team-rally-label')}
            type="circle"
            paint={{ 'circle-radius': 0 }}
          />
        )}
      </GeoJSONSource>,
    );
  }
  if (sosData.features.length > 0) {
    out.push(
      <GeoJSONSource key="team-sos" id="team-sos" data={sosData}>
        <Layer
          id="team-sos-halo"
          beforeId={liveLayerAnchor('team-sos-halo')}
          type="circle"
          paint={{ 'circle-radius': 30, 'circle-color': t.team.sos, 'circle-opacity': 0.25 }}
        />
        <Layer
          id="team-sos-dot"
          beforeId={liveLayerAnchor('team-sos-dot')}
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
            beforeId={liveLayerAnchor('team-sos-label')}
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
          <Layer
            id="team-sos-label"
            beforeId={liveLayerAnchor('team-sos-label')}
            type="circle"
            paint={{ 'circle-radius': 0 }}
          />
        )}
      </GeoJSONSource>,
    );
  }
  // #708: while an SOS or gather is active, its marker pulses (a static halo
  // under Reduce motion). Its own component, so only it redraws per frame.
  const pulse: PulsePoint[] = [
    ...soses
      .filter((x) => !x.resolved)
      .map((x) => {
        const live = positions.find((p) => p.id === x.owner);
        return { k: 'sos' as const, lng: live ? live.lon : x.lng, lat: live ? live.lat : x.lat };
      }),
    ...(rally ? [{ k: 'gather' as const, lng: rally.lng, lat: rally.lat }] : []),
  ];
  if (pulse.length > 0)
    out.push(
      <AlertPulse key="team-alert-pulse" points={pulse} sos={t.team.sos} gather={t.team.gather} />,
    );
  return out;
}

interface PulsePoint {
  k: 'sos' | 'gather';
  lng: number;
  lat: number;
}

/** One pulse cycle, ms (two rings, half a cycle apart). */
export const PULSE_MS = 1800;
/** Redraws per second while pulsing (paint updates only; the source is fixed). */
export const PULSE_FPS = 12;

/** A ring's radius (px) and opacity at phase `p` (0…1): grows and fades out. */
export function pulseRing(p: number): { r: number; o: number } {
  const f = ((p % 1) + 1) % 1;
  return { r: 13 + f * 28, o: 0.75 * (1 - f) };
}

/**
 * The pulsing rings under active SOS and gather markers (#708). The source
 * holds two features per marker (phase 0 and ½); a timer moves the phase at
 * {@link PULSE_FPS} — a paint change on two layers, never a source upload —
 * and stops while the app is in the background. Under Reduce motion: a
 * static halo under the gather flag (the SOS keeps its own halo).
 */
function AlertPulse({
  points,
  sos,
  gather,
}: {
  points: readonly PulsePoint[];
  sos: string;
  gather: string;
}) {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState(0);
  const [awake, setAwake] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => setAwake(st === 'active'));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (reduce || !awake) return;
    const start = Date.now();
    const id = setInterval(
      () => setPhase(((Date.now() - start) % PULSE_MS) / PULSE_MS),
      1000 / PULSE_FPS,
    );
    return () => clearInterval(id);
  }, [reduce, awake]);
  const json = JSON.stringify(points);
  const data = useMemo((): FeatureCollection => {
    const list = JSON.parse(json) as PulsePoint[];
    return {
      type: 'FeatureCollection',
      features: list.flatMap((p) =>
        [0, 1].map((ph) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
          properties: { k: p.k, ph },
        })),
      ),
    };
  }, [json]);
  const a = pulseRing(phase);
  const b = pulseRing(phase + 0.5);
  const paint = (color: string) =>
    reduce
      ? {
          'circle-radius': ['match', ['get', 'ph'], 0, 30, 0] as never,
          'circle-color': color,
          'circle-opacity': 0.22,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': color,
          'circle-stroke-opacity': 0.55,
        }
      : {
          'circle-radius': ['match', ['get', 'ph'], 0, a.r, b.r] as never,
          'circle-color': color,
          'circle-opacity': 0,
          'circle-stroke-width': 3,
          'circle-stroke-color': color,
          'circle-stroke-opacity': ['match', ['get', 'ph'], 0, a.o, b.o] as never,
        };
  return (
    <GeoJSONSource id="team-alert-pulse" data={data}>
      <Layer
        id="team-rally-pulse"
        beforeId={liveLayerAnchor('team-rally-pulse')}
        type="circle"
        filter={['==', ['get', 'k'], 'gather'] as never}
        paint={paint(gather)}
      />
      <Layer
        id="team-sos-pulse"
        beforeId={liveLayerAnchor('team-sos-pulse')}
        type="circle"
        filter={(reduce ? ['==', ['get', 'k'], 'none'] : ['==', ['get', 'k'], 'sos']) as never}
        paint={paint(sos)}
      />
    </GeoJSONSource>
  );
}

/**
 * Team trails: their lines; the edited one's points; "editing" cues. The
 * trail whose spot card is up (a tap on it) wears the selection highlight
 * (#747): the same glow and bright casing as a selected trail on the map.
 */
export function useTeamTrailLayers(glyphs: string | undefined): ReactElement[] {
  const t = useSchemeTokens();
  const trails = useTeamStore((s) => s.teamTrails);
  const editors = useTeamStore((s) => s.editors);
  const view = useTeamStore((s) => s.view);
  const edit = useTrailEdit();
  const font = teamLabelFont(glyphs);
  const spotKey = useTeamSheet((s) =>
    s.sheet?.kind === 'spot' && s.sheet.team ? `${s.sheet.team.owner}:${s.sheet.team.id}` : null,
  );
  const { dark } = useTheme();
  const satellite = useMapStore((s) => s.basemap === 'satellite');
  const hl = selectionHighlight(satellite ? 'imagery' : dark ? 'night' : 'paper');
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
        properties: {
          kind: 'line',
          owner: tr.owner,
          trail: tr.id,
          name: tr.name,
          color,
          sel: key === spotKey ? 1 : 0,
        },
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
  }, [trails, editors, view, edit.trail, edit.selected, t.team.bubbleNew, spotKey]);
  const data = useMemo(() => (json ? (JSON.parse(json) as FeatureCollection) : null), [json]);
  if (data === null || data.features.length === 0) return [];
  const sel = ['==', ['get', 'sel'], 1];
  return [
    <GeoJSONSource key="team-trl" id="team-trl" data={data}>
      <Layer
        id="team-trl-glow"
        beforeId={liveLayerAnchor('team-trl-glow')}
        type="line"
        filter={['all', ['==', ['get', 'kind'], 'line'], sel] as never}
        layout={{ 'line-join': 'round', 'line-cap': 'round' }}
        paint={{
          'line-color': hl.glow.color,
          'line-width': hl.glow.width,
          'line-opacity': hl.glow.opacity,
          'line-blur': hl.glow.blur,
        }}
      />
      <Layer
        id="team-trl-casing"
        beforeId={liveLayerAnchor('team-trl-casing')}
        type="line"
        filter={['==', ['get', 'kind'], 'line'] as never}
        layout={{ 'line-join': 'round', 'line-cap': 'round' }}
        paint={{
          'line-color': ['case', sel, hl.casing.color, t.team.mapPaper] as never,
          'line-width': ['case', sel, hl.casing.width, 7] as never,
        }}
      />
      <Layer
        id={TEAM_TRAIL_LINE}
        beforeId={liveLayerAnchor('team-trl-line')}
        type="line"
        filter={['==', ['get', 'kind'], 'line'] as never}
        layout={{ 'line-join': 'round', 'line-cap': 'round' }}
        paint={{
          'line-color': ['get', 'color'] as never,
          'line-width': ['case', sel, hl.line.width, 4] as never,
        }}
      />
      <Layer
        id="team-trl-vertex"
        beforeId={liveLayerAnchor('team-trl-vertex')}
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
          beforeId={liveLayerAnchor('team-trl-who')}
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
        <Layer
          id="team-trl-who"
          beforeId={liveLayerAnchor('team-trl-who')}
          type="circle"
          paint={{ 'circle-radius': 0 }}
        />
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
