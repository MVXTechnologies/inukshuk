import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { useEffect } from 'react';

import type { WeatherLayerId } from '@core/geo/weatherLayers';

import { drapeOpacityFor } from '@/weather/useWeather';
import type { Theme } from '@/ui/theme';
import {
  DRAPE_SLOT_IDS,
  drapeLayer,
  referenceOverlayLayers,
  TRACK_SOURCE_ID,
  trackLayers,
  weatherDimLayer,
} from './mapStyle';

/** A 1x1 transparent PNG — the drape slots' placeholder before a frame lands. */
const BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk' +
  'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Somewhere harmless for the placeholder to sit until the first real anchor. */
const BLANK_COORDS: [[number, number], [number, number], [number, number], [number, number]] = [
  [-0.01, 0.01],
  [0.01, 0.01],
  [0.01, -0.01],
  [-0.01, -0.01],
];

export interface TrackFeature {
  id: string;
  name: string;
  color: string;
  coordinates: [number, number][];
}

/**
 * Rebuilds the app's layer stack on top of whichever OpenFreeMap style is
 * loaded, in the app's order:
 *
 *     basemap  ->  weather dim  ->  weather drape (2 crossfade slots)
 *              ->  cased coast/road + place labels  ->  GPX tracks
 *
 * That ordering IS the design: the dim mutes the basemap, the drape owns the
 * colour, and the reference overlay is redrawn ABOVE the drape so a saturated
 * colour field can never swallow the geography (weather wave B). Tracks go
 * last because a route the user imported outranks everything under it.
 *
 * Every style load — including a theme swap — throws the previous style's
 * layers away, so this runs again on each `styleEpoch`.
 */
export function useMapOverlays(
  map: MlMap | null,
  styleEpoch: number,
  theme: Theme,
  weatherLayerId: WeatherLayerId | null,
  tracks: readonly TrackFeature[],
): void {
  const weatherOn = weatherLayerId !== null;

  // The full stack. Depends on the style epoch, the theme (ink polarity) and
  // whether weather is on at all (no drape, no dim, no reference pass).
  useEffect(() => {
    if (map === null || styleEpoch === 0) return;

    if (weatherOn) {
      if (map.getLayer('weather-dim') === undefined) map.addLayer(weatherDimLayer(theme));

      for (const slot of [0, 1] as const) {
        const id = DRAPE_SLOT_IDS[slot];
        if (map.getSource(id) === undefined) {
          map.addSource(id, { type: 'image', url: BLANK_PNG, coordinates: BLANK_COORDS });
        }
        if (map.getLayer(id) === undefined) {
          map.addLayer(drapeLayer(slot, 0));
        }
      }

      // Roads are weather-only on native too: marine chart mode dims land to
      // tan and bright cased road lines fight that, so the pass is opt-in.
      for (const layer of referenceOverlayLayers(theme, true)) {
        if (map.getLayer(layer.id) === undefined) map.addLayer(layer);
      }
    }

    if (map.getSource(TRACK_SOURCE_ID) === undefined) {
      map.addSource(TRACK_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    for (const layer of trackLayers(theme)) {
      if (map.getLayer(layer.id) === undefined) map.addLayer(layer);
    }

    return () => {
      // Only tear down when the *inputs* changed, not when the style did — a
      // style swap has already dropped every layer, and calling removeLayer on
      // a style that no longer has it throws.
      if (!map.getStyle()) return;
      for (const id of [
        'track-line',
        'track-casing',
        'overlay-city-labels',
        'overlay-town-labels',
        'overlay-road-line',
        'overlay-road-casing',
        'overlay-water-line',
        'overlay-water-casing',
        ...DRAPE_SLOT_IDS,
        'weather-dim',
      ]) {
        if (map.getLayer(id) !== undefined) map.removeLayer(id);
      }
    };
  }, [map, styleEpoch, theme, weatherOn]);

  // Keep the drape opacity honest when only the LAYER changed (wind's 0.30 vs
  // everything else's 0.62) without rebuilding the stack.
  useEffect(() => {
    if (map === null || styleEpoch === 0 || weatherLayerId === null) return;
    const active = DRAPE_SLOT_IDS.find(
      (id) =>
        map.getLayer(id) !== undefined &&
        (map.getPaintProperty(id, 'raster-opacity') as number | undefined) !== 0,
    );
    if (active !== undefined) {
      map.setPaintProperty(active, 'raster-opacity', drapeOpacityFor(weatherLayerId));
    }
  }, [map, styleEpoch, weatherLayerId]);

  // Track geometry.
  useEffect(() => {
    if (map === null || styleEpoch === 0) return;
    const source = map.getSource(TRACK_SOURCE_ID) as GeoJSONSource | undefined;
    if (source === undefined) return;
    source.setData({
      type: 'FeatureCollection',
      features: tracks.map((t) => ({
        type: 'Feature' as const,
        id: t.id,
        properties: { name: t.name, color: t.color },
        geometry: { type: 'LineString' as const, coordinates: t.coordinates },
      })),
    });
  }, [map, styleEpoch, tracks]);
}
