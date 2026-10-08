/**
 * The team's marks on the main map (#589): comment bubbles beside shared
 * photos, pins, and open tasks under their anchors, as native MapLibre layers
 * on one CLUSTERED GeoJSON source (owner 2026-10-07: "when zooming out, put a
 * number"): overlapping marks become one round badge with their count, in the
 * "new" colour when any of them is unread (`clusterProperties` sums the
 * unread flags). Zooming in splits them. No sort keys (the symbol-sort-key
 * cost lesson); three fixed sizes.
 *
 * Taps are routed by MapScreen through {@link hitTestTeamMarks}
 * (`queryRenderedFeatures` on these layers): a mark's action, or a cluster
 * (zoom in to where it splits; at the cluster limit, a list of its marks).
 */
import { photoScaleAt } from '@core/photos/mapStyle';
import { teamMapMarks, type BubbleMark, type PinMark, type TaskMark } from '@core/teamui/mapMarks';
import { useExtensionPrefs } from '@features/extensions/prefs';
import { GeoJSONSource, type GeoJSONSourceRef, Layer } from '@maplibre/maplibre-react-native';
import { useTeamStore } from '@state/teamStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { FeatureCollection } from 'geojson';
import { useEffect, useMemo, useRef, type ReactElement } from 'react';

import { useAnchorLookup } from '../useAnchorLookup';
import { teamLabelFont } from './TeamMapLayers';

export const MARKS_SOURCE = 'team-marks';
export const MARK_LAYERS = [
  'team-mark-cluster',
  'team-mark-pin',
  'team-mark-bubble',
  'team-mark-task',
];
/** A badge's number: 1–99, then "99+" (three characters at most). */
const badgeLabel = (n: number): string => (n > 99 ? '99+' : String(n));

/** Below this zoom tasks only count in clusters (their labels crowd a wide view). */
export const TASK_LABEL_MIN_ZOOM = 12;
export const CLUSTER_RADIUS = 45;
export const CLUSTER_MAX_ZOOM = 17;

export type TeamMarkHit =
  | { kind: 'bubble'; mark: BubbleMark }
  | { kind: 'pin'; mark: PinMark }
  | { kind: 'task'; mark: TaskMark }
  | { kind: 'cluster'; id: number; lngLat: [number, number]; count: number };

/** The marks drawn now, by feature key (the hit test resolves taps through it). */
let byKey = new Map<string, TeamMarkHit>();
let sourceRef: GeoJSONSourceRef | null = null;

/** What a map tap at (px, py) hits among the team's marks, or null. */
export async function hitTestTeamMarks(
  map: {
    queryRenderedFeatures: (
      box: [[number, number], [number, number]],
      options: { layers: string[] },
    ) => Promise<unknown[]>;
  },
  px: number,
  py: number,
): Promise<TeamMarkHit | null> {
  try {
    const found = await map.queryRenderedFeatures(
      [
        [px - 18, py - 18],
        [px + 18, py + 18],
      ],
      { layers: MARK_LAYERS },
    );
    for (const f of found) {
      const feat = f as {
        properties?: Record<string, unknown>;
        geometry?: { coordinates?: unknown };
      };
      const p = feat.properties ?? {};
      if (typeof p['cluster_id'] === 'number') {
        const c = feat.geometry?.coordinates;
        const lngLat: [number, number] =
          Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number'
            ? [c[0], c[1]]
            : [0, 0];
        return {
          kind: 'cluster',
          id: p['cluster_id'],
          lngLat,
          count: typeof p['point_count'] === 'number' ? p['point_count'] : 0,
        };
      }
      const hit = typeof p['key'] === 'string' ? byKey.get(p['key']) : undefined;
      if (hit) return hit;
    }
  } catch {
    // The layers are absent (team off) or the map is mid-teardown.
  }
  return null;
}

/** Where a cluster splits, or null (then: list its marks). */
export async function clusterExpansionZoom(id: number): Promise<number | null> {
  return sourceRef?.getClusterExpansionZoom(id).catch(() => null) ?? null;
}

/** The marks under a cluster (its leaves), resolved to hits. */
export async function clusterMarks(id: number): Promise<TeamMarkHit[]> {
  const leaves = (await sourceRef?.getClusterLeaves(id, 50, 0).catch(() => [])) ?? [];
  const out: TeamMarkHit[] = [];
  for (const l of leaves as { properties?: Record<string, unknown> }[]) {
    const k = l.properties?.['key'];
    const hit = typeof k === 'string' ? byKey.get(k) : undefined;
    if (hit) out.push(hit);
  }
  return out;
}

/** The marks as MapView children (an array), for the map's glyph host. */
export function useTeamMapMarks(glyphs: string | undefined, zoom: number | null): ReactElement[] {
  // The photos' scale, in quarter-zoom steps (the badges beside them follow).
  const photoK = photoScaleAt(Math.round((zoom ?? 15) * 4) / 4);
  const t = useSchemeTokens();
  const { installedAt, show } = useExtensionPrefs('team');
  const view = useTeamStore((s) => s.view);
  const photos = useTeamStore((s) => s.photos);
  const threads = useTeamStore((s) => s.photoThreads);
  const allPins = useTeamStore((s) => s.pins);
  const resolved = useTeamStore((s) => s.resolved);
  const tasks = useTeamStore((s) => s.tasks);
  const seen = useTeamStore((s) => s.record?.seen);
  const look = useAnchorLookup();
  const ref = useRef<GeoJSONSourceRef>(null);
  const font = teamLabelFont(glyphs);

  const pins = useMemo(
    () => allPins.filter((p) => !resolved.has(`${p.owner}:${p.id}`)),
    [allPins, resolved],
  );
  const built = useMemo(() => {
    if (view === null) return null;
    const members = new Map(view.members.map((m) => [m.id, m]));
    const marks = teamMapMarks({
      photos,
      threads,
      pins,
      tasks,
      me: view.me,
      seenAt: (th) => seen?.[th] ?? 0,
      look,
      nameOf: (id) => members.get(id)?.name ?? 'Teammate',
    });
    const keys = new Map<string, TeamMarkHit>();
    const features: FeatureCollection['features'] = [];
    for (const b of marks.bubbles) {
      const key = `b:${b.key}`;
      keys.set(key, { kind: 'bubble', mark: b });
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [b.photo.lng, b.photo.lat] },
        properties: { key, kind: 'bubble', fresh: b.fresh ? 1 : 0, label: badgeLabel(b.count) },
      });
    }
    for (const p of marks.pins) {
      const key = `p:${p.key}`;
      const m = members.get(p.owner);
      keys.set(key, { kind: 'pin', mark: p });
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: {
          key,
          kind: 'pin',
          fresh: p.fresh ? 1 : 0,
          color: m?.color ?? t.inkMuted,
          initials: m?.initials ?? '?',
          label: badgeLabel(p.count),
        },
      });
    }
    for (const k of marks.tasks) {
      const key = `t:${k.key}`;
      keys.set(key, { kind: 'task', mark: k });
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [k.lng, k.lat] },
        properties: { key, kind: 'task', fresh: 0, label: `☐ ${k.label}` },
      });
    }
    return { keys, json: JSON.stringify({ type: 'FeatureCollection', features }) };
  }, [view, photos, threads, pins, tasks, seen, look, t.inkMuted]);

  // The same object while nothing drawn changed (no symbol re-placement).
  const json = built?.json ?? '';
  const data = useMemo(() => (json ? (JSON.parse(json) as FeatureCollection) : null), [json]);
  useEffect(() => {
    byKey = built?.keys ?? new Map();
    sourceRef = ref.current;
  }, [built]);

  const layers = useMemo(() => {
    const isCluster = ['has', 'point_count'];
    const notCluster = ['!', ['has', 'point_count']];
    const ofKind = (k: string) => ['all', notCluster, ['==', ['get', 'kind'], k]];
    const freshColor = ['case', ['==', ['get', 'fresh'], 1], t.team.bubbleNew, t.team.mapPaper];
    const freshInk = ['case', ['==', ['get', 'fresh'], 1], t.team.bubbleNewInk, t.team.mapInk];
    // A badge's circle and its number share one pixel offset (a text-offset in
    // ems drifted off the circle's px translate: the number sat off-centre).
    // Beside its photo, which grows with zoom: a constant per zoom step (the
    // iOS bridge crashes on an expression for circle-translate).
    const bubbleAt = [18 * photoK, -18 * photoK];
    const pinBadgeAt = [14, -14];
    // Wide enough for "99+": the circle grows with the label, not the other way.
    const badgeR = (r: number) => [
      'case',
      ['>', ['length', ['to-string', ['get', 'label']]], 2],
      r + 3,
      r,
    ];
    const out: ReactElement[] = [
      <Layer
        key="cluster"
        id="team-mark-cluster"
        type="circle"
        filter={isCluster as never}
        paint={{
          'circle-radius': ['step', ['get', 'point_count'], 15, 10, 19, 50, 23] as never,
          'circle-color': [
            'case',
            ['>', ['coalesce', ['get', 'unread'], 0], 0],
            t.team.bubbleNew,
            t.team.mapPaper,
          ] as never,
          'circle-stroke-width': 2,
          'circle-stroke-color': t.team.mapInk,
        }}
      />,
      <Layer
        key="pin"
        id="team-mark-pin"
        type="circle"
        filter={ofKind('pin') as never}
        paint={{
          'circle-radius': 14,
          'circle-color': ['get', 'color'] as never,
          'circle-stroke-width': 3,
          'circle-stroke-color': t.team.mapPaper,
        }}
      />,
      <Layer
        key="pin-badge"
        id="team-mark-pin-badge"
        type="circle"
        filter={ofKind('pin') as never}
        paint={{
          'circle-radius': badgeR(8) as never,
          'circle-translate': pinBadgeAt as never,
          'circle-color': freshColor as never,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': t.team.mapInk,
        }}
      />,
      <Layer
        key="bubble"
        id="team-mark-bubble"
        type="circle"
        filter={ofKind('bubble') as never}
        paint={{
          'circle-radius': badgeR(10) as never,
          'circle-translate': bubbleAt as never,
          'circle-color': freshColor as never,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': t.team.mapInk,
        }}
      />,
    ];
    if (font) {
      out.push(
        <Layer
          key="cluster-count"
          id="team-mark-cluster-count"
          type="symbol"
          filter={isCluster as never}
          layout={{
            'text-field': ['get', 'point_count_abbreviated'] as never,
            'text-font': font,
            'text-size': 13,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          }}
          paint={{
            'text-color': [
              'case',
              ['>', ['coalesce', ['get', 'unread'], 0], 0],
              t.team.bubbleNewInk,
              t.team.mapInk,
            ] as never,
          }}
        />,
        <Layer
          key="pin-initials"
          id="team-mark-pin-initials"
          type="symbol"
          filter={ofKind('pin') as never}
          layout={{
            'text-field': ['get', 'initials'] as never,
            'text-font': font,
            'text-size': 11,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          }}
          paint={{ 'text-color': t.team.onAvatar }}
        />,
        <Layer
          key="pin-count"
          id="team-mark-pin-count"
          type="symbol"
          filter={ofKind('pin') as never}
          layout={{
            'text-field': ['get', 'label'] as never,
            'text-font': font,
            'text-size': 10,
            'text-anchor': 'center',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          }}
          paint={{ 'text-color': freshInk as never, 'text-translate': pinBadgeAt as never }}
        />,
        <Layer
          key="bubble-count"
          id="team-mark-bubble-count"
          type="symbol"
          filter={ofKind('bubble') as never}
          layout={{
            'text-field': ['get', 'label'] as never,
            'text-font': font,
            'text-size': 11,
            'text-anchor': 'center',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          }}
          paint={{ 'text-color': freshInk as never, 'text-translate': bubbleAt as never }}
        />,
        <Layer
          key="task"
          id="team-mark-task"
          type="symbol"
          minzoom={TASK_LABEL_MIN_ZOOM}
          filter={ofKind('task') as never}
          layout={{
            'text-field': ['get', 'label'] as never,
            'text-font': font,
            'text-size': 12,
            'text-anchor': 'top',
            'text-offset': [0, 1.6],
            'text-optional': true,
          }}
          paint={{
            'text-color': t.team.mapInk,
            'text-halo-color': t.team.mapHalo,
            'text-halo-width': 2,
          }}
        />,
      );
    }
    return out;
  }, [font, t, photoK]);

  const on = installedAt !== 0 && show && data !== null && data.features.length > 0;
  if (!on) return [];
  return [
    <GeoJSONSource
      key="team-marks"
      ref={ref}
      id={MARKS_SOURCE}
      data={data}
      cluster
      clusterRadius={CLUSTER_RADIUS}
      clusterMaxZoom={CLUSTER_MAX_ZOOM}
      // The explicit [reduce, map] form: iOS reads exactly two expressions
      // (the `['+', map]` shorthand parsed as a constant there, so every
      // cluster's paint failed to black).
      clusterProperties={
        {
          unread: [
            ['+', ['accumulated'], ['get', 'unread']],
            ['get', 'fresh'],
          ],
        } as never
      }
    >
      {layers}
    </GeoJSONSource>,
  ];
}
