/**
 * Marine reference layers the map can drape as raster overlays (marine M3).
 * Two open sources, both legal to ship for the St. Lawrence today:
 *
 * - CHS NONNA non-navigational bathymetry (10 m grid with the 100 m grid
 *   underneath for coverage), served by the CHS GeoServer. Licence: Open
 *   Government Licence – Canada + a NON-NAVIGATIONAL USE ONLY supplement —
 *   which is why {@link MARINE_DISCLAIMER} must be visible whenever a marine
 *   layer is active. Served as WMS GetMap via MapLibre's `{bbox-epsg-3857}`
 *   templating — the exact GeoMet weather-drape mechanism. (The host's WMTS
 *   was probed live 2026-08-08 and its tile cache returns empty tiles above
 *   ~z10, while WMS renders the full depth tint at every zoom — so WMS it is.)
 * - OpenSeaMap seamarks (buoys, lights, harbours; OSM data, ODbL) as plain
 *   transparent XYZ tiles.
 *
 * Same catalog discipline as `trailNetworks.ts` / `weatherLayers.ts`: a
 * small const list, an id type derived from it, and a sanitize helper for
 * settings hydration. Every layer carries its attribution and a source
 * maxzoom (the offline downloader must obey it if charts ever join packs).
 */

export const NONNA_WMS_ENDPOINT = 'https://nonna-geoserver.data.chs-shc.ca/geoserver/nonna/wms';

export const OPENSEAMAP_SEAMARK_TILE_URL = 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png';

/** Credit lines (also shown in Settings → System info → Maps & data). */
export const CHS_NONNA_ATTRIBUTION =
  'Bathymetry: CHS NONNA, Open Government Licence – Canada. Not for navigation.';
export const OPENSEAMAP_ATTRIBUTION = 'Seamarks © OpenSeaMap contributors (ODbL)';

/** The mandatory notice shown whenever any marine layer is active. */
export const MARINE_DISCLAIMER = 'Not for navigation';

export const MARINE_LAYERS = [
  // Labels double as Maestro/a11y match targets — keep them free of regex
  // metacharacters (Maestro treats text matchers as regexes). Catalog order
  // is also draw order: depth tint below, seamark symbols on top.
  {
    id: 'bathymetry',
    label: 'Water depths',
    attribution: CHS_NONNA_ATTRIBUTION,
    // The WMS renders at any scale; past this the map overscales instead of
    // re-fetching sub-metre renders of a 10 m grid.
    maxzoom: 17,
    opacity: 0.7,
  },
  {
    id: 'seamarks',
    label: 'Seamarks',
    attribution: OPENSEAMAP_ATTRIBUTION,
    maxzoom: 18,
    opacity: 1,
  },
] as const;

export type MarineLayerId = (typeof MARINE_LAYERS)[number]['id'];
export type MarineLayer = (typeof MARINE_LAYERS)[number];

export const MARINE_LAYER_IDS: readonly MarineLayerId[] = MARINE_LAYERS.map((l) => l.id);

export function isMarineLayerId(v: unknown): v is MarineLayerId {
  return typeof v === 'string' && (MARINE_LAYER_IDS as readonly string[]).includes(v);
}

/** Drop junk from a persisted marine-layer list (settings hydration). */
export function sanitizeMarineLayers(v: unknown): MarineLayerId[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isMarineLayerId);
}

export function marineLayerById(id: MarineLayerId): MarineLayer {
  // The ids are derived from the catalog, so the lookup can't actually miss;
  // the fallback keeps noUncheckedIndexedAccess honest without a cast.
  return MARINE_LAYERS.find((l) => l.id === id) ?? MARINE_LAYERS[0];
}

/**
 * Raster tile-URL template for a marine layer. Bathymetry is a WMS GetMap
 * with MapLibre's `{bbox-epsg-3857}` templating (verified live: NONNA 100
 * drawn under NONNA 10 in one request, so the dense 10 m grid wins wherever
 * it exists and the 100 m grid fills the rest); seamarks are plain XYZ.
 */
export function marineTileUrl(id: MarineLayerId): string {
  if (id === 'seamarks') return OPENSEAMAP_SEAMARK_TILE_URL;
  const params = [
    'service=WMS',
    'version=1.3.0',
    'request=GetMap',
    `layers=${encodeURIComponent('nonna:NONNA 100,nonna:NONNA 10')}`,
    'crs=EPSG:3857',
    'bbox={bbox-epsg-3857}',
    'width=256',
    'height=256',
    'format=image/png',
    'transparent=true',
  ];
  return `${NONNA_WMS_ENDPOINT}?${params.join('&')}`;
}
