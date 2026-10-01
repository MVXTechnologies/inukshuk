/**
 * The map's draw order, bottom → top, for BOTH base maps (#492).
 *
 * The owner, after the vector Map base shipped: "the contour lines in
 * satellite mode go over the PDF maps". On the Map base the contours were
 * part of the vector style, under every overlay; on Satellite they were
 * computed on the device and mounted at the terrain-overlay anchor, which sat
 * ABOVE the PDF maps. Two stacks, defined in two places, drifted apart.
 *
 * Now there is one stack, defined here, and both base maps fill it:
 *
 * | slot        | Map (vector Stone & Paper)            | Satellite                          |
 * |-------------|---------------------------------------|------------------------------------|
 * | `base`      | paper, land cover, water, contours, roads and trails (the stone body, in its own order) | the imagery |
 * | `contours`  | — (inside `base`) · on-device contours on the raster fallback | served contour tiles · on-device contours on the raster fallback |
 * | `linework`  | — (inside `base`)                     | roads and trails ("Labels on satellite") |
 * | `chart`     | marine chart: land dim, water fill, depth drape, WMS | same |
 * | `relief`    | shaded relief + the tilted-map pass   | the tilted-map pass only, lighter (no flat shading: imagery carries real shadows) |
 * | `terrain`   | slope-angle raster                    | slope-angle raster                 |
 * | `labels`    | names, peaks, contour heights         | names, peaks, contour heights      |
 * | `weather`   | weather dim + drape                   | same                               |
 * | `soundings` | marine spot soundings                 | same                               |
 * | `mask`      | "locally downloaded only" mask        | same                               |
 * | `pdf`       | PDF maps                              | PDF maps                           |
 * | `trails`    | heat, trail lines, highlights, markers | same                              |
 * | `reference` | weather/marine reference labels       | same                               |
 *
 * so the visible order — ground, contours, roads and trails, relief, slope,
 * names, PDF maps, your trails — is the same on both, and PDF maps always
 * cover the contours, the relief and the slope shading under them.
 *
 * The offline-only mask hides undownloaded BASE MAP; it sits under the PDF
 * maps and the user's own trails, which live on the device and must stay
 * visible offline (owner, #492 — they used to vanish under it).
 *
 * Slots that hold layers mounted at runtime (MapView children: PDF maps,
 * slope, on-device contours, drapes, trails) carry an invisible ANCHOR
 * layer — see `@core/geo/mapLayerStack` for why anchors and not mount
 * order. A runtime overlay names its anchor through {@link overlayAnchor},
 * so its height comes from this table and nowhere else.
 *
 * PURE: no React Native / Expo imports; the style JSON lives in
 * `src/features/map/mapStyle.ts`, which builds each slot's layers and
 * flattens them with {@link stackLayers}.
 */
import {
  CONTOURS_ANCHOR,
  MARINE_DRAPE_ANCHOR,
  MARINE_SOUNDINGS_ANCHOR,
  PDF_MAPS_ANCHOR,
  TERRAIN_OVERLAY_ANCHOR,
  TRAILS_ANCHOR,
  WEATHER_DRAPE_ANCHOR,
  type DrapeAnchorId,
} from '@core/geo/mapLayerStack';

/** The slots, bottom first. See the module doc for what each holds. */
export const MAP_LAYER_SLOTS = [
  'base',
  'contours',
  'linework',
  'chart',
  'relief',
  'terrain',
  'labels',
  'weather',
  'soundings',
  'mask',
  'pdf',
  'trails',
  'reference',
] as const;

export type MapLayerSlot = (typeof MAP_LAYER_SLOTS)[number];

/** A slot's height: 0 at the bottom. */
export function slotRank(slot: MapLayerSlot): number {
  return MAP_LAYER_SLOTS.indexOf(slot);
}

/**
 * Flatten per-slot layer lists into one bottom → top list. Within a slot the
 * caller's order is kept; across slots {@link MAP_LAYER_SLOTS} wins, however
 * the record was filled.
 */
export function stackLayers<L>(slots: Partial<Record<MapLayerSlot, readonly L[]>>): L[] {
  return MAP_LAYER_SLOTS.flatMap((slot) => slots[slot] ?? []);
}

/** The anchor each runtime slot carries (its top: children insert just below it). */
export const SLOT_ANCHOR = {
  contours: CONTOURS_ANCHOR,
  chart: MARINE_DRAPE_ANCHOR,
  terrain: TERRAIN_OVERLAY_ANCHOR,
  weather: WEATHER_DRAPE_ANCHOR,
  soundings: MARINE_SOUNDINGS_ANCHOR,
  pdf: PDF_MAPS_ANCHOR,
  trails: TRAILS_ANCHOR,
} as const satisfies Partial<Record<MapLayerSlot, DrapeAnchorId>>;

/** Every overlay the map mounts at runtime, and the slot it draws in. */
export const OVERLAY_SLOT = {
  /** On-device DEM contours (raster fallback / map maker). */
  demContours: 'contours',
  /** The marine depth-band drape. */
  marineDrape: 'chart',
  /** The slope-angle raster. */
  slope: 'terrain',
  /** The weather crossfade slots. */
  weatherDrape: 'weather',
  /** Marine spot soundings. */
  soundings: 'soundings',
  /** PDF map overviews and detail tiles. */
  pdfMap: 'pdf',
  /** Personal heatmap (glow + pass-count lines). */
  heat: 'trails',
  /** Library trail lines, the focused trail, the live recording. */
  trailLines: 'trails',
  /** A long-distance trail shown from Explore. */
  longTrail: 'trails',
  /** The inspect dot and the heat-tap ring. */
  markers: 'trails',
} as const satisfies Record<string, keyof typeof SLOT_ANCHOR>;

export type MapOverlay = keyof typeof OVERLAY_SLOT;

/** The `beforeId` a runtime overlay mounts with. */
export function overlayAnchor(overlay: MapOverlay): DrapeAnchorId {
  return SLOT_ANCHOR[OVERLAY_SLOT[overlay]];
}

// ---------------------------------------------------------------------------
// What is drawn, for a given set of toggles
// ---------------------------------------------------------------------------

export type BaseMapKind = 'map' | 'satellite';

/** The toggles that decide what the main map draws. */
export interface MapStackInput {
  basemap: BaseMapKind;
  /**
   * Our vector tiles are in use: the Stone & Paper body on the Map base, and
   * served contours / labels on Satellite. False = the raster fallback (map
   * maker open, or the vector flag off).
   */
  vector: boolean;
  /** App theme. Changes colours only, never the order — kept so tests prove it. */
  dark: boolean;
  shadedRelief: boolean;
  tiltRelief: boolean;
  contours: boolean;
  slope: boolean;
  /** "Labels on satellite" (the Map base always has its own). */
  satelliteLabels: boolean;
  pdf: boolean;
  heat: boolean;
  trails: boolean;
  weather: boolean;
  marine: boolean;
  offlineMask: boolean;
}

/** One visible thing on the map, as the owner would name it. */
export type MapElement =
  | 'ground'
  | 'contours'
  | 'linework'
  | 'chart'
  | 'relief'
  | 'tiltRelief'
  | 'slope'
  | 'labels'
  | 'weather'
  | 'pdf'
  | 'heat'
  | 'trails'
  | 'reference'
  | 'mask';

/** Bottom → top within a slot that holds several elements. */
const ELEMENT_ORDER: readonly MapElement[] = [
  'ground',
  'contours',
  'linework',
  'chart',
  'relief',
  'tiltRelief',
  'slope',
  'labels',
  'weather',
  'mask',
  'pdf',
  'heat',
  'trails',
  'reference',
];

/**
 * The shaded relief: Map base only. Satellite imagery is a photograph with
 * the sun's real shadows in it; a synthetic light from the north-west on top
 * would contradict them. Weather and the marine chart suppress it too.
 */
export function drawsShadedRelief(
  i: Pick<MapStackInput, 'basemap' | 'shadedRelief' | 'weather' | 'marine'>,
): boolean {
  return i.basemap === 'map' && i.shadedRelief && !i.weather && !i.marine;
}

/**
 * The tilted-map relief pass: wherever the shaded relief is drawn (Map), and
 * on its own over satellite imagery (#492) — no flat shading there, the pass
 * only fades in as the map tilts. Same drape gates as the relief.
 */
export function drawsTiltRelief(
  i: Pick<MapStackInput, 'basemap' | 'shadedRelief' | 'tiltRelief' | 'weather' | 'marine'>,
): boolean {
  if (!i.tiltRelief || i.weather || i.marine) return false;
  return i.basemap === 'satellite' || drawsShadedRelief(i);
}

/**
 * Names and trails over the imagery: the toggle, and not under a weather or
 * marine drape, whose reference overlay carries the names there.
 */
export function drawsImageryLabels(
  i: Pick<MapStackInput, 'basemap' | 'vector' | 'satelliteLabels' | 'weather' | 'marine'>,
): boolean {
  return i.basemap === 'satellite' && i.vector && i.satelliteLabels && !i.weather && !i.marine;
}

/** The slot an element lands in on a given base map. */
export function elementSlot(
  element: MapElement,
  i: Pick<MapStackInput, 'basemap' | 'vector'>,
): MapLayerSlot {
  // The vector Map base draws its own contours, roads and trails inside the
  // stone body; everywhere else they are layers of their own.
  const inStoneBody = i.basemap === 'map' && i.vector;
  switch (element) {
    case 'ground':
      return 'base';
    case 'contours':
      return inStoneBody ? 'base' : 'contours';
    case 'linework':
      return inStoneBody ? 'base' : 'linework';
    case 'chart':
      return 'chart';
    case 'relief':
    case 'tiltRelief':
      return 'relief';
    case 'slope':
      return 'terrain';
    case 'labels':
      return 'labels';
    case 'weather':
      return 'weather';
    case 'pdf':
      return 'pdf';
    case 'heat':
    case 'trails':
      return 'trails';
    case 'reference':
      return 'reference';
    case 'mask':
      return 'mask';
  }
}

/**
 * What the map draws for these toggles, bottom → top. The same function
 * answers for both base maps; the tests hold the two to the same order.
 */
export function mapDrawOrder(i: MapStackInput): MapElement[] {
  const stoneMap = i.basemap === 'map' && i.vector;
  const imageryLabels = drawsImageryLabels(i);
  const relief = drawsShadedRelief(i);
  const present: Record<MapElement, boolean> = {
    ground: true,
    // Served tiles on both vector bases; on-device on the raster fallback.
    // On-device contours stay off under the offline-only mask (they would
    // draw over its void); served ones come from the packs.
    contours: i.contours && (i.vector || !i.offlineMask),
    linework: stoneMap || imageryLabels,
    chart: i.marine,
    relief,
    tiltRelief: drawsTiltRelief(i),
    slope: i.slope && !i.offlineMask,
    labels: stoneMap || imageryLabels,
    weather: i.weather,
    pdf: i.pdf,
    heat: i.heat,
    trails: i.trails,
    reference: i.weather || i.marine,
    mask: i.offlineMask,
  };
  return ELEMENT_ORDER.filter((e) => present[e])
    .map((e, n) => ({ e, n, rank: slotRank(elementSlot(e, i)) }))
    .sort((a, b) => a.rank - b.rank || a.n - b.n)
    .map((x) => x.e);
}
