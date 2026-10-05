import { MARINE_DISCLAIMER, OPENSEAMAP_ATTRIBUTION } from '@core/geo/marineLayers';
import { ECCC_ATTRIBUTION } from '@core/geo/weatherLayers';

/**
 * What the map's ⓘ credits sheet lists (2.1.1, owner request): one line per
 * data source CURRENTLY on screen, each with its © line and a link, plus the
 * "Report a map error" link OpenStreetMap (and FOSSGIS, for the routing
 * engines) ask apps to carry.
 *
 * Built from what the map is drawing, not from the codebase: the full,
 * always-complete roll stays in Settings › System info › "Maps & data"
 * (`MAP_DATA_CREDITS`), and the sheet links to it.
 */

export interface MapCreditLine {
  /** Stable key (tests, React keys). */
  id:
    | 'base'
    | 'labels'
    | 'imagery'
    | 'terrain'
    | 'peaks'
    | 'regions'
    | 'pdf'
    | 'routing'
    | 'weather'
    | 'marine'
    | 'geodetic'
    | 'tides';
  /** The section label ("Base map", "Routing"). */
  label: string;
  /** The © line itself. */
  credit: string;
  /** Where the licence / copyright page is. */
  link?: { label: string; url: string };
}

export interface MapCreditsInput {
  basemap: 'map' | 'satellite';
  /** The Map base is the vector (Protomaps) build, not the raster tiles. */
  vector: boolean;
  /** OSM roads, trails and names drawn over the imagery ("Labels on satellite"). */
  osmLabels: boolean;
  /** Contour lines or shaded relief drawn from the elevation tiles. */
  terrain: boolean;
  /** Names of the PDF maps drawn over the base. */
  pdfMaps: readonly string[];
  /** Routing engines behind the routed legs on screen; null = no routed leg. */
  routingEngines: readonly string[] | null;
  weather?: boolean;
  marine?: boolean;
  /** Geodetic points (Settings → Extensions) drawn on the map. */
  geodetic?: boolean;
  /** Tide stations (Overlays → Tide stations) drawn on the map. */
  tides?: boolean;
}

export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
/** OpenStreetMap's "report a problem" page, the link the routing engines' terms ask for. */
export const FIX_THE_MAP_URL = 'https://www.openstreetmap.org/fixthemap';
const PROTOMAPS_URL = 'https://protomaps.com';
const NATURAL_EARTH_URL = 'https://www.naturalearthdata.com/about/terms-of-use/';
const ESRI_IMAGERY_URL =
  'https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9';
/** Tilezen's attribution page for the Terrain Tiles' underlying DEMs. */
const TERRAIN_TILES_URL = 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md';

const ENGINE_URLS: Readonly<Record<string, string>> = {
  brouter: 'https://brouter.de',
  valhalla: 'https://github.com/valhalla/valhalla',
  osrm: 'https://project-osrm.org',
  graphhopper: 'https://www.graphhopper.com',
};

const OSM_LINK = { label: 'openstreetmap.org/copyright', url: OSM_COPYRIGHT_URL };

/** One line per source on screen, in the order a reader scans the map: ground up. */
export function mapCredits(input: MapCreditsInput): MapCreditLine[] {
  const lines: MapCreditLine[] = [];
  if (input.basemap === 'satellite') {
    lines.push({
      id: 'imagery',
      label: 'Satellite imagery',
      credit: '© Esri, Maxar, Earthstar Geographics',
      link: { label: 'Esri World Imagery', url: ESRI_IMAGERY_URL },
    });
    if (input.osmLabels) {
      lines.push({
        id: 'labels',
        label: 'Roads, trails & names',
        credit: '© OpenStreetMap contributors · Protomaps',
        link: OSM_LINK,
      });
    }
  } else {
    lines.push({
      id: 'base',
      label: 'Base map',
      credit: input.vector
        ? '© OpenStreetMap contributors · Protomaps'
        : '© OpenStreetMap contributors',
      link: OSM_LINK,
    });
  }
  if (input.terrain) {
    lines.push({
      id: 'terrain',
      label: 'Contours & relief',
      credit: 'Elevation: Mapzen / AWS Terrain Tiles (SRTM, GMTED, ETOPO1, NRCan CDEM and others)',
      link: { label: 'Terrain Tiles sources', url: TERRAIN_TILES_URL },
    });
  }
  // Summits ride the vector tiles: OpenStreetMap peaks, Protomaps' build.
  if ((input.basemap === 'map' && input.vector) || input.osmLabels) {
    lines.push({
      id: 'peaks',
      label: 'Peaks',
      credit: '© OpenStreetMap contributors',
      link: { label: 'protomaps.com', url: PROTOMAPS_URL },
    });
    // Province and state names worldwide ride the same labels (Natural Earth).
    lines.push({
      id: 'regions',
      label: 'Province & state names',
      credit: 'Natural Earth (public domain)',
      link: { label: 'naturalearthdata.com', url: NATURAL_EARTH_URL },
    });
  }
  if (input.pdfMaps.length > 0) {
    const names = input.pdfMaps.slice(0, 3).join(', ');
    const more = input.pdfMaps.length > 3 ? ` and ${input.pdfMaps.length - 3} more` : '';
    lines.push({
      id: 'pdf',
      label: input.pdfMaps.length === 1 ? 'PDF map' : 'PDF maps',
      credit: `${names}${more} — © each map's publisher`,
    });
  }
  // Routed legs on screen. An empty list = routed, engine unnamed (a saved
  // route reopened from its line): still OSM data, still credited.
  const engines = input.routingEngines;
  if (engines !== null) {
    const known = engines.find((e) => ENGINE_URLS[e.toLowerCase()] !== undefined);
    const url = known !== undefined ? ENGINE_URLS[known.toLowerCase()] : undefined;
    lines.push({
      id: 'routing',
      label: 'Routing',
      credit:
        engines.length > 0
          ? `${engines.join(' + ')} · © OpenStreetMap contributors`
          : '© OpenStreetMap contributors',
      ...(known !== undefined && url !== undefined ? { link: { label: known, url } } : {}),
    });
  }
  if (input.weather) {
    lines.push({ id: 'weather', label: 'Weather', credit: ECCC_ATTRIBUTION });
  }
  if (input.geodetic) {
    lines.push({
      id: 'geodetic',
      label: 'Geodetic points',
      credit:
        "Survey agencies' published data (each mark's card names its source and licence) · " +
        'survey points © OpenStreetMap contributors',
      link: OSM_LINK,
    });
  }
  if (input.tides) {
    lines.push({
      id: 'tides',
      label: 'Tide stations',
      credit:
        'NOAA/NOS/CO-OPS · Shom, 2025. Références Altimétriques Maritimes, ' +
        'doi:10.17183/MAREE_COURANTS_RAM (Licence Ouverte 2.0) · © Kartverket (CC BY 4.0) · ' +
        '出典：気象庁 (JMA) · Canada: contains data of the Canadian Hydrographic Service (DFO), ' +
        'fetched live by this device · Not for navigation',
    });
  }
  if (input.marine) {
    lines.push({
      id: 'marine',
      label: 'Marine',
      credit: `${OPENSEAMAP_ATTRIBUTION} · depths per region (see all credits) · ${MARINE_DISCLAIMER}`,
    });
  }
  return lines;
}
