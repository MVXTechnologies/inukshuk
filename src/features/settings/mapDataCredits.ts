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

const PARTS: readonly string[] = [
  '© OpenStreetMap contributors',
  'Esri/ArcGIS basemaps',
  'AWS Terrain Tiles',
  'MapLibre',
  `Weather: ${ECCC_ATTRIBUTION}`,
  'Weather-mode labels: OpenFreeMap (© OpenMapTiles)',
  ...MARINE_SOURCES.map((s) => withoutDisclaimer(s.attribution)),
  withoutDisclaimer(NOAA_ENC_ATTRIBUTION),
  OPENSEAMAP_ATTRIBUTION,
  `Tides: ${CHS_TIDES_ATTRIBUTION}`,
];

export const MAP_DATA_CREDITS = `${PARTS.join(' · ')} · All depth data is for reference only — ${MARINE_DISCLAIMER.toLowerCase()}.`;
