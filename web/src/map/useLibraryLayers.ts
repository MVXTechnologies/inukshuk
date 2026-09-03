import type { GeoJSONSource, LayerSpecification, Map as MlMap } from 'maplibre-gl';
import { useEffect } from 'react';

import type { TrackPointAt } from '@core/geo/track';
import type { LngLat, Waypoint } from '@core/models';

import type { WebTrack } from '@/library/types';
import type { Theme } from '@/ui/theme';

/**
 * The Library's own map layers: every visible trail, the saved waypoints, and
 * the scrub dot the elevation profile drives.
 *
 * Registered as a SEPARATE stack from `useMapOverlays` and called after it, so
 * these end up above the weather drape and the imported-GPX layers — a trail
 * you have deliberately opened outranks everything under it. Like that hook, it
 * rebuilds on every `style.load`, because `setStyle` throws every layer away.
 *
 * Geometry comes from `WebTrack.preview`, the decimated line kept in the index.
 * Nothing here parses a GPX: at ~90 000 points across the demo library, drawing
 * from the real point lists would mean holding all of them in memory forever to
 * avoid re-parsing on every camera move.
 */

const TRACKS = 'lib-tracks';
const WAYPOINTS = 'lib-waypoints';
const SCRUB = 'lib-scrub';

const LAYER_IDS = [
  'lib-scrub-dot',
  'lib-waypoint-label',
  'lib-waypoint-dot',
  'lib-track-line',
  'lib-track-casing',
] as const;

function layers(theme: Theme): LayerSpecification[] {
  const casing = theme.dark ? 'rgba(6, 11, 16, 0.85)' : 'rgba(255, 255, 255, 0.9)';
  const ink = theme.dark ? '#E9EEF3' : '#16222E';
  const halo = theme.dark ? 'rgba(8, 12, 17, 0.9)' : 'rgba(255, 255, 255, 0.92)';

  // A focused trail is drawn at full strength; everything else drops to 0.42 so
  // the one being read is legible without the rest disappearing (context is
  // the reason to draw them at all).
  const dim = ['case', ['boolean', ['get', 'focus'], false], 1, 0.42] as const;

  return [
    {
      id: 'lib-track-casing',
      type: 'line',
      source: TRACKS,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': casing,
        'line-opacity': dim as unknown as number,
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5,
          ['case', ['boolean', ['get', 'focus'], false], 5.6, 3.6],
          14,
          ['case', ['boolean', ['get', 'focus'], false], 9, 6.2],
        ],
      },
    },
    {
      id: 'lib-track-line',
      type: 'line',
      source: TRACKS,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#F2643C'],
        'line-opacity': dim as unknown as number,
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5,
          ['case', ['boolean', ['get', 'focus'], false], 2.8, 1.7],
          14,
          ['case', ['boolean', ['get', 'focus'], false], 5.2, 3.2],
        ],
      },
    },
    {
      id: 'lib-waypoint-dot',
      type: 'circle',
      source: WAYPOINTS,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.2, 13, 6],
        'circle-color': '#FFC24B',
        'circle-stroke-width': 1.6,
        'circle-stroke-color': casing,
      },
    },
    {
      id: 'lib-waypoint-label',
      type: 'symbol',
      source: WAYPOINTS,
      minzoom: 10.5,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.05],
        'text-anchor': 'top',
        'text-max-width': 10,
        'text-optional': true,
      },
      paint: {
        'text-color': ink,
        'text-halo-color': halo,
        'text-halo-width': 1.4,
      },
    },
    {
      id: 'lib-scrub-dot',
      type: 'circle',
      source: SCRUB,
      paint: {
        'circle-radius': 7,
        'circle-color': '#566B33',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    },
  ];
}

const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

export function useLibraryLayers(
  map: MlMap | null,
  styleEpoch: number,
  theme: Theme,
  tracks: readonly WebTrack[],
  waypoints: readonly Waypoint[],
  focusId: string | null,
  scrub: TrackPointAt | null,
): void {
  useEffect(() => {
    if (map === null || styleEpoch === 0) return;
    for (const id of [TRACKS, WAYPOINTS, SCRUB]) {
      if (map.getSource(id) === undefined) map.addSource(id, { type: 'geojson', data: empty() });
    }
    for (const layer of layers(theme)) {
      if (map.getLayer(layer.id) === undefined) map.addLayer(layer);
    }
    return () => {
      if (!map.getStyle()) return;
      for (const id of LAYER_IDS) {
        if (map.getLayer(id) !== undefined) map.removeLayer(id);
      }
    };
  }, [map, styleEpoch, theme]);

  useEffect(() => {
    if (map === null || styleEpoch === 0) return;
    const source = map.getSource(TRACKS) as GeoJSONSource | undefined;
    source?.setData({
      type: 'FeatureCollection',
      // The focused trail is emitted LAST so it paints over its neighbours;
      // MapLibre draws a source's features in array order within one layer.
      features: [...tracks]
        .sort((a, b) => Number(a.id === focusId) - Number(b.id === focusId))
        .map((t) => ({
          type: 'Feature' as const,
          id: t.id,
          properties: { name: t.name, color: t.color, focus: focusId === null || t.id === focusId },
          geometry: { type: 'LineString' as const, coordinates: t.preview as LngLat[] },
        })),
    });
  }, [map, styleEpoch, tracks, focusId]);

  useEffect(() => {
    if (map === null || styleEpoch === 0) return;
    const source = map.getSource(WAYPOINTS) as GeoJSONSource | undefined;
    source?.setData({
      type: 'FeatureCollection',
      features: waypoints.map((w) => ({
        type: 'Feature' as const,
        id: w.id,
        properties: { label: w.label },
        geometry: { type: 'Point' as const, coordinates: [w.longitude, w.latitude] },
      })),
    });
  }, [map, styleEpoch, waypoints]);

  useEffect(() => {
    if (map === null || styleEpoch === 0) return;
    const source = map.getSource(SCRUB) as GeoJSONSource | undefined;
    source?.setData(
      scrub === null
        ? empty()
        : {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'Point', coordinates: [scrub.longitude, scrub.latitude] },
              },
            ],
          },
    );
  }, [map, styleEpoch, scrub]);
}
