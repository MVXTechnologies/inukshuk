import { MARINE_ENABLED, WEATHER_ENABLED } from '@core/features/flags';
import { MARINE_DISCLAIMER, OPENSEAMAP_ATTRIBUTION } from '@core/geo/marineLayers';
import { MARINE_SOURCES, NOAA_ENC_ATTRIBUTION } from '@core/geo/marineSources';
import { ECCC_ATTRIBUTION } from '@core/geo/weatherLayers';
import { CHS_TIDES_ATTRIBUTION } from '@core/weather/tides';

/**
 * The one place data credits live (the map hides MapLibre's own attribution
 * button — owner call, it crowded the map), assembled from the real
 * attribution constants rather than a hand-copied literal so a new source
 * can never ship uncredited.
 *
 * That matters most for bathymetry: the worldwide coverage ladder (wave D
 * §D3) draws from four providers depending on where the boat is, and GEBCO's
 * citation line is a LICENCE REQUIREMENT, not a courtesy. Each source's own
 * "Not for navigation." sentence is folded into the single closing notice so
 * the roll stays readable while the condition stays stated.
 */

/** Strip a source's trailing non-navigational sentence (stated once below). */
function withoutDisclaimer(line: string): string {
  return line.replace(new RegExp(`\\s*${MARINE_DISCLAIMER}\\.?$`, 'i'), '');
}

/**
 * Credits follow the FEATURES, not the codebase (see `@core/features/flags`).
 * Attribution is owed for data the app actually fetches and shows; a parked
 * feature fetches nothing, so crediting ECCC or CHS while weather and marine
 * are greyed out would list sources this build never contacts — and would
 * leave the reader hunting a map layer that isn't there. The lines come back
 * with the features, from the same attribution constants as before, so no
 * source can ship uncredited once it is live again.
 */
const PARTS: readonly string[] = [
  '© OpenStreetMap contributors',
  'Esri/ArcGIS basemaps',
  'AWS Terrain Tiles',
  'MapLibre',
  ...(WEATHER_ENABLED
    ? [`Weather: ${ECCC_ATTRIBUTION}`, 'Weather-mode labels: OpenFreeMap (© OpenMapTiles)']
    : []),
  ...(MARINE_ENABLED
    ? [
        ...MARINE_SOURCES.map((s) => withoutDisclaimer(s.attribution)),
        withoutDisclaimer(NOAA_ENC_ATTRIBUTION),
        OPENSEAMAP_ATTRIBUTION,
      ]
    : []),
  // Tides ride the forecast card, which is gated on weather OR marine.
  ...(WEATHER_ENABLED || MARINE_ENABLED ? [`Tides: ${CHS_TIDES_ATTRIBUTION}`] : []),
];

/** The closing non-navigational notice only applies when depth data ships. */
const DEPTH_NOTICE = MARINE_ENABLED
  ? ` · All depth data is for reference only — ${MARINE_DISCLAIMER.toLowerCase()}.`
  : '';

export const MAP_DATA_CREDITS = `${PARTS.join(' · ')}${DEPTH_NOTICE}`;
