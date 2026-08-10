import {
  NONNA10_CELL_M,
  depthCoverageUrl,
  depthPointUrl,
  latToMercY,
  lonToMercX,
  mercXToLon,
  mercYToLat,
  type GeoBbox,
} from './marineDepth';

/**
 * Worldwide bathymetry coverage ladder (marine wave D §D3) — the marine twin
 * of the weather model fallback in `weatherModels.ts`/`windCoverage.ts`: a
 * pure catalog of depth sources, each with a coverage predicate, a nominal
 * ground resolution and its own attribution, plus the pick logic that says
 * WHICH source a viewport gets and, just as importantly, lets the UI say so
 * out loud.
 *
 * Priority: CHS NONNA (Canada, 10 m) → NOAA NCEI (US waters, 1–3 m coastal
 * DEMs) → EMODnet (European seas, ~115 m) → GEBCO (global, ~450 m). Every
 * endpoint below was re-probed live 2026-08-10 (the earlier plan's NOAA
 * `NOAAChartDisplay` WMTS had already died — it is deliberately absent):
 *
 * | source  | probe                                                        | result                          |
 * | ------- | ------------------------------------------------------------ | ------------------------------- |
 * | NONNA   | WCS GetCoverage, 3×3 cells @46.8N −71.2W                      | 200, image/tiff, 1442 B, 0.54 s |
 * | NCEI    | ImageServer `exportImage` F32 GeoTIFF, 200×100 @Québec        | 200, image/tiff, 131894 B, 0.62 s |
 * | NCEI    | ImageServer `identify` @42.33N −70.90W                        | 200, `value:"-0.290487"`, 0.50 s |
 * | NOAA ENC| MaritimeChartService `export` png32, 256×256                  | 200, image/png, 26409 B, 0.29 s |
 * | EMODnet | WCS GetCoverage `emodnet__mean`, 192×192 North Sea            | 200, image/tiff, 147840 B, 1.53 s |
 * | EMODnet | REST `depth_sample` @54N 2E                                   | 200, `{"avg":-71.69,…}`, 0.66 s |
 * | GEBCO   | WMS GetMap `GEBCO_LATEST_2`, 256×256                          | 200, image/png, 55839 B, 0.93 s |
 *
 * LICENCE NOTE — the "Not for navigation" chip is a condition of NONNA
 * (OGL-Canada + a non-navigational supplement), of GEBCO ("should NOT be
 * used for navigation") and even of redistributed NOAA ENCs ("NOT considered
 * official"). It stays on for EVERY source; nothing in this ladder relaxes
 * it. GEBCO's credit line is a licence requirement, not a courtesy.
 */

/** Grid CRS of a source's raw depth response. */
export type MarineGridCrs = 'EPSG:3857' | 'EPSG:4326';

export type MarineSourceId = 'nonna' | 'noaa' | 'emodnet' | 'gebco';

/** How a source answers a raw float32 depth grid (null = it can't). */
export interface MarineGridAccess {
  /** CRS the returned grid's georeference is expressed in. */
  crs: MarineGridCrs;
  /**
   * Values at or above this many metres above chart datum are LAND, not
   * water, and are masked out before rendering. Null for sources that mask
   * land themselves with a nodata value (NONNA's float32-max, EMODnet's
   * NaN); the elevation-model sources (NCEI) need it or every hill renders
   * as a drying flat.
   */
  landCutoffM: number | null;
  /**
   * The source's native cell size in its own CRS units — mercator metres for
   * NONNA (19.0986, from DescribeCoverage), degrees for the EPSG:4326 grids
   * (EMODnet 1/960°; NCEI's finest published CUDEM 1/9″). Drives the offline
   * pack's exact byte estimate.
   */
  nativeCell: number;
  /** Cells the pack downloader may request per axis in one call. */
  maxPackDim: number;
}

/** How a source answers a single point depth (tap-for-depth). */
export interface MarinePointAccess {
  /** Response shape the fetcher must parse. */
  kind: 'wcs-grid' | 'emodnet-json' | 'arcgis-identify';
  /** Who to credit for THIS number when it differs from the drape's source. */
  attribution: string;
}

export interface MarineSource {
  id: MarineSourceId;
  /** Short name for the legend/attribution pill. */
  label: string;
  /** Where it applies, in words ("Canada", "Worldwide"). */
  regionLabel: string;
  /** Nominal ground resolution, metres — the ladder's quality ordering. */
  cellSizeM: number;
  /** Human resolution tag for the legend ("10 m", "~450 m"). */
  resolutionLabel: string;
  /**
   * Boxes the source covers; empty = worldwide. Deliberately generous
   * (national EEZ scale) — a source that turns out to hold no survey there
   * simply returns an empty grid and the ladder steps to the next one.
   */
  coverage: readonly GeoBbox[];
  /** Raw-grid access, or null when the source is imagery-only (GEBCO). */
  grid: MarineGridAccess | null;
  /** Point-depth access, or null. */
  point: MarinePointAccess | null;
  /** Pre-rendered raster fallback drape (a tile-URL template), or null. */
  raster: string | null;
  /** Can offline packs be built from it? (needs `grid`.) */
  packable: boolean;
  /** Full credit line — Settings → System info → Maps & data. */
  attribution: string;
}

export const NCEI_IMAGESERVER =
  'https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_global_mosaic/ImageServer';
export const NOAA_ENC_ENDPOINT =
  'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService/MapServer/export';
export const EMODNET_WCS_ENDPOINT = 'https://ows.emodnet-bathymetry.eu/wcs';
export const EMODNET_COVERAGE_ID = 'emodnet__mean';
export const EMODNET_DEPTH_SAMPLE = 'https://rest.emodnet-bathymetry.eu/depth_sample';
export const EMODNET_TILE_URL =
  'https://tiles.emodnet-bathymetry.eu/2020/baselayer/web_mercator/{z}/{x}/{y}.png';
export const GEBCO_WMS_ENDPOINT = 'https://wms.gebco.net/mapserv';

/** EMODnet cell size in degrees (1/960° ≈ 115 m — from DescribeCoverage). */
export const EMODNET_CELL_DEG = 1 / 960;

/** NCEI's finest published cell in US waters (1/9″ CUDEM), degrees. */
export const NCEI_CELL_DEG = 1 / 9 / 3600;

/**
 * The live GEBCO release is **GEBCO_2025**, not the 2026 the design package
 * assumed — read straight off the WMS capabilities abstract 2026-08-10
 * ("It currently provides access to the GEBCO_2025 Grid"). The WMS layer id
 * is version-agnostic (`GEBCO_LATEST`), so the endpoint keeps working across
 * releases; only this credit string needs a yearly touch.
 */
export const GEBCO_ATTRIBUTION =
  'Bathymetry: GEBCO Compilation Group (2025) GEBCO 2025 Grid (doi:10.5285/37c52e96-24ea-67ce-e063-7086abc05f29). Not for navigation.';
export const NCEI_ATTRIBUTION =
  'Bathymetry: NOAA NCEI DEM global mosaic (CUDEM / Coastal Relief Model / ETOPO 2022), U.S. Government work. Not for navigation.';
export const NOAA_ENC_ATTRIBUTION =
  'Chart imagery: NOAA ENC Online — redistributed copies are NOT official NOAA ENCs. Not for navigation.';
export const EMODNET_ATTRIBUTION =
  'Bathymetry: EMODnet Bathymetry Consortium, Digital Terrain Model (CC BY 4.0). Not for navigation.';

/**
 * NONNA's survey area is Canadian waters; a bbox can't trace the border, so
 * these three boxes stay just inside it — the 49th parallel on the prairies,
 * 48.3° for the Vancouver Island dip, 43.3° across the lower Great Lakes.
 * A viewport that slips over the line simply gets an all-nodata grid and the
 * ladder steps to NOAA, so being a little generous costs one request, never
 * a wrong chart.
 */
const CANADA: readonly GeoBbox[] = [
  // Pacific coast + BC interior.
  { west: -141.5, south: 48.3, east: -122, north: 61 },
  // Prairies, Hudson Bay and the Arctic archipelago.
  { west: -141.5, south: 49, east: -60, north: 83.5 },
  // Great Lakes, the St. Lawrence and Atlantic Canada.
  { west: -95, south: 43.3, east: -52, north: 62 },
];
const US_WATERS: readonly GeoBbox[] = [
  // Contiguous US + its coastal shelf.
  { west: -128, south: 23, east: -64, north: 50 },
  // Alaska, plus the Aleutian tail on the far side of the antimeridian.
  { west: -180, south: 50, east: -128, north: 73 },
  { west: 172, south: 50, east: 180, north: 56 },
  // Hawai'i.
  { west: -179, south: 17, east: -153, north: 29 },
  // Puerto Rico / US Virgin Islands.
  { west: -68.5, south: 16.5, east: -63.5, north: 19.5 },
  // Guam / Northern Marianas.
  { west: 143, south: 12, east: 147, north: 21 },
  // American Samoa.
  { west: -172, south: -15.5, east: -168, north: -12.5 },
];
/**
 * The EMODnet DTM's served envelope is far wider than its survey coverage
 * (the WCS advertises lat 11–90, lon −70.5–43); this is the European-seas
 * box the product actually documents — Macaronesia and the Atlantic margin
 * through the Baltic, Mediterranean, Black Sea and Barents Sea.
 */
const EUROPEAN_SEAS: GeoBbox = { west: -36, south: 24, east: 43, north: 90 };

/**
 * The ladder, best first. Order IS priority: `marineSourceLadder` keeps this
 * order and drops the entries whose coverage misses the viewport, so the
 * global entry is always last and always present.
 */
export const MARINE_SOURCES: readonly MarineSource[] = [
  {
    id: 'nonna',
    label: 'CHS NONNA',
    regionLabel: 'Canada',
    cellSizeM: 13,
    resolutionLabel: '10 m',
    coverage: CANADA,
    grid: { crs: 'EPSG:3857', landCutoffM: null, nativeCell: NONNA10_CELL_M, maxPackDim: 1024 },
    point: { kind: 'wcs-grid', attribution: 'CHS NONNA' },
    raster: null, // built by `marineLayers.marineTileUrl` (the legacy WMS pair)
    packable: true,
    attribution: 'Bathymetry: CHS NONNA, Open Government Licence – Canada. Not for navigation.',
  },
  {
    id: 'noaa',
    label: 'NOAA NCEI',
    regionLabel: 'US waters',
    // CUDEM reaches 1/9″ (~3 m) inshore and the Coastal Relief Model 1″
    // (~30 m) on the shelf; 10 m is the honest headline for US waters.
    cellSizeM: 10,
    resolutionLabel: '3–30 m',
    coverage: US_WATERS,
    grid: { crs: 'EPSG:4326', landCutoffM: 0.5, nativeCell: NCEI_CELL_DEG, maxPackDim: 1024 },
    point: { kind: 'arcgis-identify', attribution: 'NOAA NCEI' },
    raster: null, // NOAA ENC Online is bbox-templated, see `marineRasterUrl`
    packable: true,
    attribution: NCEI_ATTRIBUTION,
  },
  {
    id: 'emodnet',
    label: 'EMODnet',
    regionLabel: 'European seas',
    cellSizeM: 115,
    resolutionLabel: '~115 m',
    coverage: [EUROPEAN_SEAS],
    grid: { crs: 'EPSG:4326', landCutoffM: null, nativeCell: EMODNET_CELL_DEG, maxPackDim: 1024 },
    point: { kind: 'emodnet-json', attribution: 'EMODnet Bathymetry' },
    raster: EMODNET_TILE_URL,
    packable: true,
    attribution: EMODNET_ATTRIBUTION,
  },
  {
    id: 'gebco',
    label: 'GEBCO 2025',
    regionLabel: 'Worldwide',
    cellSizeM: 450,
    resolutionLabel: '~450 m',
    coverage: [],
    // GEBCO publishes imagery, not a grid API — so the global tier drapes
    // the WMS render instead of our own band renderer, and can't be packed.
    grid: null,
    point: { kind: 'arcgis-identify', attribution: 'NOAA NCEI (ETOPO)' },
    raster: null, // bbox-templated WMS, see `marineRasterUrl`
    packable: false,
    attribution: GEBCO_ATTRIBUTION,
  },
];

export const MARINE_SOURCE_IDS: readonly MarineSourceId[] = MARINE_SOURCES.map((s) => s.id);

export function isMarineSourceId(v: unknown): v is MarineSourceId {
  return typeof v === 'string' && (MARINE_SOURCE_IDS as readonly string[]).includes(v);
}

export function marineSourceById(id: MarineSourceId): MarineSource {
  // Ids are derived from the catalog, so this can't actually miss; the
  // fallback keeps noUncheckedIndexedAccess honest without a cast.
  return MARINE_SOURCES.find((s) => s.id === id) ?? MARINE_SOURCES[MARINE_SOURCES.length - 1]!;
}

/** Do two geographic boxes overlap at all? */
export function bboxIntersects(a: GeoBbox, b: GeoBbox): boolean {
  return a.west < b.east && b.west < a.east && a.south < b.north && b.south < a.north;
}

/** Does `outer` fully contain `inner`? */
export function bboxContains(outer: GeoBbox, inner: GeoBbox): boolean {
  return (
    outer.west <= inner.west &&
    outer.east >= inner.east &&
    outer.south <= inner.south &&
    outer.north >= inner.north
  );
}

/** Does a source claim any part of this viewport? (empty coverage = global) */
export function sourceCovers(source: MarineSource, view: GeoBbox): boolean {
  if (source.coverage.length === 0) return true;
  return source.coverage.some((box) => bboxIntersects(box, view));
}

/**
 * The ordered fallback ladder for a viewport: every source that claims it,
 * best-resolution first, always ending in the global entry. The chart hook
 * walks this list and stops at the first source that actually answers with
 * surveyed cells — a dead host, an XML error body or an all-nodata region
 * silently steps to the next rung.
 */
export function marineSourceLadder(view: GeoBbox): readonly MarineSource[] {
  return MARINE_SOURCES.filter((s) => sourceCovers(s, view));
}

/** The best source claiming this viewport (never null — GEBCO is global). */
export function pickMarineSource(view: GeoBbox): MarineSource {
  const ladder = marineSourceLadder(view);
  return ladder[0] ?? marineSourceById('gebco');
}

/** The best PACKABLE source claiming this viewport, or null (open ocean). */
export function bestPackableSource(view: GeoBbox): MarineSource | null {
  return marineSourceLadder(view).find((s) => s.packable && s.grid !== null) ?? null;
}

/**
 * Grid-request URLs for a source over a bbox, in composite order (finest
 * first). NONNA answers two coverages — the dense 10 m grid with the coarse
 * 100 m grid under its fringe; every other source answers one.
 */
export function marineGridUrls(source: MarineSource, bbox: GeoBbox, maxDim: number): string[] {
  if (source.grid === null) return [];
  switch (source.id) {
    case 'nonna':
      return [
        depthCoverageUrl('nonna10', bbox, maxDim),
        depthCoverageUrl('nonna100', bbox, maxDim),
      ];
    case 'emodnet':
      return [emodnetCoverageUrl(bbox, maxDim)];
    case 'noaa':
      return [nceiCoverageUrl(bbox, maxDim)];
    default:
      return [];
  }
}

/**
 * EMODnet WCS GetCoverage over a geographic bbox. The coverage is EPSG:4326
 * with `Lat`/`Long` axis labels (verified against DescribeCoverage), and it
 * is a GeoServer, so the same `scalesize` reduction the NONNA builder uses
 * applies here too.
 */
export function emodnetCoverageUrl(bbox: GeoBbox, maxDim: number): string {
  const nativeW = Math.max(1, Math.round((bbox.east - bbox.west) / EMODNET_CELL_DEG));
  const nativeH = Math.max(1, Math.round((bbox.north - bbox.south) / EMODNET_CELL_DEG));
  const scale = Math.min(1, maxDim / Math.max(nativeW, nativeH));
  const params = [
    'service=WCS',
    'version=2.0.1',
    'request=GetCoverage',
    `coverageId=${EMODNET_COVERAGE_ID}`,
    `subset=Lat(${bbox.south.toFixed(5)},${bbox.north.toFixed(5)})`,
    `subset=Long(${bbox.west.toFixed(5)},${bbox.east.toFixed(5)})`,
    'format=image/tiff',
    ...(scale < 1
      ? [
          `scalesize=i(${Math.max(1, Math.round(nativeW * scale))}),j(${Math.max(
            1,
            Math.round(nativeH * scale),
          )})`,
        ]
      : []),
  ];
  return `${EMODNET_WCS_ENDPOINT}?${params.join('&')}`;
}

/**
 * NOAA NCEI DEM-mosaic `exportImage` as a float32 GeoTIFF. Unlike WCS this
 * takes the output size directly, so the cap is applied to `size` rather
 * than through a scaling extension. Elevations are positive up, so the
 * source's `landCutoffM` masks the dry parts before rendering.
 */
export function nceiCoverageUrl(bbox: GeoBbox, maxDim: number): string {
  const nativeW = Math.max(1, Math.round((bbox.east - bbox.west) / NCEI_CELL_DEG));
  const nativeH = Math.max(1, Math.round((bbox.north - bbox.south) / NCEI_CELL_DEG));
  const scale = Math.min(1, maxDim / Math.max(nativeW, nativeH));
  const w = Math.max(1, Math.round(nativeW * scale));
  const h = Math.max(1, Math.round(nativeH * scale));
  const params = [
    `bbox=${bbox.west.toFixed(5)},${bbox.south.toFixed(5)},${bbox.east.toFixed(5)},${bbox.north.toFixed(5)}`,
    'bboxSR=4326',
    'imageSR=4326',
    `size=${w},${h}`,
    'format=tiff',
    'pixelType=F32',
    'f=image',
  ];
  return `${NCEI_IMAGESERVER}/exportImage?${params.join('&')}`;
}

/**
 * Point-depth request URL for a source, or null when it has none. The
 * response shape is `source.point.kind` — feed it to
 * {@link parseMarinePointDepth} (JSON kinds) or the float-grid parser.
 */
export function marinePointUrl(source: MarineSource, lat: number, lon: number): string | null {
  const point = source.point;
  if (point === null) return null;
  switch (point.kind) {
    case 'wcs-grid':
      return depthPointUrl('nonna10', lat, lon);
    case 'emodnet-json':
      return `${EMODNET_DEPTH_SAMPLE}?geom=${encodeURIComponent(`POINT(${lon} ${lat})`)}`;
    case 'arcgis-identify': {
      const geometry = encodeURIComponent(
        JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
      );
      return (
        `${NCEI_IMAGESERVER}/identify?geometry=${geometry}&geometryType=esriGeometryPoint` +
        '&returnGeometry=false&returnCatalogItems=false&f=json'
      );
    }
  }
}

/**
 * Metres below chart datum (negative, the NONNA convention) parsed out of a
 * JSON point response, or null when the point is dry/unknown. Handles both
 * live shapes: EMODnet `{"avg":-71.69,…}` and the ArcGIS ImageServer
 * `identify` `{"value":"-0.290487"}` (a STRING, and `"NoData"` over gaps).
 */
export function parseMarinePointDepth(
  kind: MarinePointAccess['kind'],
  body: unknown,
): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  if (kind === 'emodnet-json') {
    const avg = record.avg;
    return typeof avg === 'number' && Number.isFinite(avg) ? avg : null;
  }
  if (kind === 'arcgis-identify') {
    const raw = record.value;
    if (typeof raw !== 'string') return null;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * The raster drape URL template for a source when the client-rendered chart
 * can't run (no grid, or every grid rung failed) — MapLibre `{bbox-epsg-3857}`
 * templating, the same mechanism the weather drapes use. Null when the
 * source has no imagery of its own (the caller then keeps the legacy CHS WMS
 * pair from `marineLayers.marineTileUrl`).
 */
export function marineRasterUrl(source: MarineSource): string | null {
  if (source.raster !== null) return source.raster;
  if (source.id === 'gebco') {
    const params = [
      'service=WMS',
      'version=1.3.0',
      'request=GetMap',
      // `GEBCO_LATEST_2` is the flat colour-shaded elevation layer; the
      // default `GEBCO_LATEST` adds a shaded relief that fights our contours.
      'layers=GEBCO_LATEST_2',
      'crs=EPSG:3857',
      'bbox={bbox-epsg-3857}',
      'width=256',
      'height=256',
      'format=image/png',
      'transparent=true',
    ];
    return `${GEBCO_WMS_ENDPOINT}?${params.join('&')}`;
  }
  if (source.id === 'noaa') {
    const params = [
      'bbox={bbox-epsg-3857}',
      'bboxSR=3857',
      'imageSR=3857',
      'size=256,256',
      'format=png32',
      'transparent=true',
      'f=image',
    ];
    return `${NOAA_ENC_ENDPOINT}?${params.join('&')}`;
  }
  return null;
}

/**
 * Geographic corners of a grid in MapLibre ImageSource order (top-left,
 * top-right, bottom-right, bottom-left), CRS-aware — mercator metres for
 * NONNA, plain degrees for the EMODnet/NCEI grids.
 */
export function gridCornersFor(
  crs: MarineGridCrs,
  grid: { x0: number; y0: number; dx: number; dy: number; width: number; height: number },
): [[number, number], [number, number], [number, number], [number, number]] {
  const toLon = crs === 'EPSG:3857' ? mercXToLon : (v: number): number => v;
  const toLat = crs === 'EPSG:3857' ? mercYToLat : (v: number): number => v;
  const west = toLon(grid.x0);
  const east = toLon(grid.x0 + grid.dx * grid.width);
  const north = toLat(grid.y0);
  const south = toLat(grid.y0 - grid.dy * grid.height);
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}

/** Grid-CRS x for a longitude (identity for the 4326 sources). */
export function lonToGridX(crs: MarineGridCrs, lon: number): number {
  return crs === 'EPSG:3857' ? lonToMercX(lon) : lon;
}

/** Grid-CRS y for a latitude (identity for the 4326 sources). */
export function latToGridY(crs: MarineGridCrs, lat: number): number {
  return crs === 'EPSG:3857' ? latToMercY(lat) : lat;
}

/** Grid-CRS x → longitude. */
export function gridXToLon(crs: MarineGridCrs, x: number): number {
  return crs === 'EPSG:3857' ? mercXToLon(x) : x;
}

/** Grid-CRS y → latitude. */
export function gridYToLat(crs: MarineGridCrs, y: number): number {
  return crs === 'EPSG:3857' ? mercYToLat(y) : y;
}

/**
 * Sample a stored depth grid at a geographic point — the OFFLINE half of
 * tap-for-depth (§D4): once a pack is on disk the answer is a local array
 * read, no network at all. Walks outward from the containing cell up to
 * `radius` cells so a nodata seam (NONNA's 0.01° granule hairlines) or a
 * single dropped sample doesn't turn into "no depth here". Null when the
 * point is off the grid or nothing valid is within reach.
 */
export function sampleGridDepth(
  grid: {
    width: number;
    height: number;
    data: Float32Array;
    x0: number;
    y0: number;
    dx: number;
    dy: number;
  },
  crs: MarineGridCrs,
  lat: number,
  lon: number,
  radius = 2,
): number | null {
  const col = Math.floor((lonToGridX(crs, lon) - grid.x0) / grid.dx);
  const row = Math.floor((grid.y0 - latToGridY(crs, lat)) / grid.dy);
  if (col < -radius || row < -radius) return null;
  if (col >= grid.width + radius || row >= grid.height + radius) return null;
  let best: number | null = null;
  let bestD = Infinity;
  for (let r = row - radius; r <= row + radius; r++) {
    if (r < 0 || r >= grid.height) continue;
    for (let c = col - radius; c <= col + radius; c++) {
      if (c < 0 || c >= grid.width) continue;
      const v = grid.data[r * grid.width + c];
      if (v === undefined || !Number.isFinite(v) || Math.abs(v) >= 3e38) continue;
      const d = Math.hypot(c - col, r - row);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
  }
  return best;
}

/**
 * The legend/attribution line for the source actually on screen — the
 * honesty requirement: "GEBCO 2025 · ~450 m · Worldwide" reads very
 * differently from "CHS NONNA · 10 m · Canada", and the user is entitled to
 * know which one they're looking at.
 */
export function marineSourceCaption(source: MarineSource): string {
  return `${source.label} · ${source.resolutionLabel}`;
}
