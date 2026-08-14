import { SOUNDING_INK, SOUNDING_SHALLOW_INK, type SoundingProperties } from '@core/geo/depthChart';
import { MARINE_DRAPE_ANCHOR, MARINE_SOUNDINGS_ANCHOR } from '@core/geo/mapLayerStack';
import { GeoJSONSource, ImageSource, Layer } from '@maplibre/maplibre-react-native';
import type { FeatureCollection, Point } from 'geojson';

import type { MarineChartDrape } from './useMarineChart';

/**
 * The client-rendered nautical chart — depth bands + contours as a
 * georeferenced image, spot soundings as a symbol layer — mounted as MapView
 * CHILDREN rather than style-JSON layers (perf fix 2026-08-10, owner: "map
 * loading for the marine charts is very slow").
 *
 * Two measured reasons this had to leave the style (see
 * `@core/geo/mapLayerStack` for the mechanism):
 *
 * 1. every chart render changed the style object, and a changed style object
 *    reloads the WHOLE native style — basemap, vector labels and all;
 * 2. worse, the reload fired `onWillStartLoadingMap`, which cleared
 *    `mapLoaded`, which switched `useMarineChart` off, which changed the
 *    style again… a self-sustaining storm measured at ~15 style reloads per
 *    second for as long as chart mode was on.
 *
 * As children the image source's url/coordinates and the geojson source's
 * data update IN PLACE (`MLRNImageSource.setUrl`, `MLRNGeoJSONSource.setShape`),
 * so a re-anchored chart swaps without the map ever blanking — the previous
 * drape simply stays on screen until the new bitmap is written.
 *
 * Soundings need the glyph endpoint that wave B's labels overlay adds to the
 * style, so the caller only renders them when that overlay resolved — the
 * same condition the style-JSON version carried. They are a SEPARATE
 * component with its OWN anchor: mount order is NOT z-order (a child is
 * inserted immediately below the layer it names, so the last insert below a
 * shared anchor wins the top slot), so the drape naming
 * {@link MARINE_DRAPE_ANCHOR} and the numbers naming
 * {@link MARINE_SOUNDINGS_ANCHOR} is what actually keeps the numbers over
 * the colour — in either toggle order, and after every style reload. See
 * `@core/geo/mapLayerStack`.
 */
export function MarineDrapeLayer({ drape }: { drape: MarineChartDrape | null }) {
  if (drape === null) return null;
  return (
    <ImageSource id="marine-depth-chart" url={drape.uri} coordinates={drape.coordinates}>
      <Layer
        id="marine-depth-chart"
        type="raster"
        beforeId={MARINE_DRAPE_ANCHOR}
        // Near-opaque: the bands ARE the chart; a hint of basemap texture
        // ghosts through. fade 0 — re-anchored drapes must swap crisply.
        paint={{ 'raster-opacity': 0.92, 'raster-fade-duration': 0 }}
      />
    </ImageSource>
  );
}

/**
 * The spot soundings, anchored ABOVE the weather field's anchor so the
 * numbers stay readable when both modes are on — the stacking the style JSON
 * gave, and wave B's rule that ink beats colour.
 */
export function MarineSoundingsLayer({
  soundings,
}: {
  /** Null while the labels overlay (and therefore glyphs) is unavailable. */
  soundings: FeatureCollection<Point, SoundingProperties> | null;
}) {
  if (soundings === null) return null;
  return (
    <GeoJSONSource id="marine-soundings" data={soundings}>
      <Layer
        id="marine-soundings"
        type="symbol"
        minzoom={9}
        beforeId={MARINE_SOUNDINGS_ANCHOR}
        layout={{
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 9.5, 13, 11, 16, 12.5],
          'text-allow-overlap': false,
          'symbol-sort-key': ['get', 'sort'],
        }}
        paint={{
          'text-color': ['case', ['==', ['get', 'shallow'], 1], SOUNDING_SHALLOW_INK, SOUNDING_INK],
          'text-halo-color': 'rgba(255, 255, 255, 0.85)',
          'text-halo-width': 1,
        }}
      />
    </GeoJSONSource>
  );
}
