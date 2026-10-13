import { isWaypointIcon } from '@core/library/waypointIcons';
import {
  WAYPOINT_PIN_DIAMETER,
  pinGeometry,
  waypointFill,
  waypointInk,
  waypointRing,
  waypointSize,
} from '@core/library/waypointStyle';
import type { WaypointSize } from '@core/models';
import type {
  FilterSpecification,
  SymbolLayerSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import type { Feature, FeatureCollection, Point } from 'geojson';

type SymbolLayout = NonNullable<SymbolLayerSpecification['layout']>;
type SymbolPaint = NonNullable<SymbolLayerSpecification['paint']>;

/**
 * The main map's waypoint pins as GL symbols (#675): every pin of every
 * colour, size and icon in ONE GeoJSON source and a fixed handful of symbol
 * layers — never one React view per pin (the RN `<Marker>` per waypoint this
 * replaces cost a native view, a layout pass and a bridge round-trip each).
 *
 * Why SDF sprites, not pre-tinted ones: 350 icons × 18 colours × 4 sizes
 * would be 25 200 images. An SDF image is tinted per feature (`icon-color`),
 * scaled without blur (`icon-size`) and ringed (`icon-halo-*`) by the GPU, so
 * the whole set is one pin body plus one glyph per icon
 * (`scripts/map/build-waypoint-icons.mjs`), and only the glyphs in use are
 * registered.
 *
 * Layers, bottom to top, all from the one source and all `allow-overlap` /
 * `ignore-placement` so a pin is never culled (it is a thing the user put
 * there, not a basemap label):
 * 1. body — the pin, tinted with its colour, ringed with its halo;
 * 2. glyph — its icon in the ink that keeps 3:1 on that colour;
 * 3. photo — the camera badge, only for pins with a photo;
 * 4. label — the name under the tip, only when the style has glyphs, and
 *    collision-culled like any label.
 * Drawing cost is per layer per tile, not per pin: 500 pins are the same
 * 3–4 draw calls as 5. The JS cost is building the FeatureCollection, once
 * per change of the pins or the selection — never per camera move.
 *
 * The one compromise of a body layer under a glyph layer: where two pins
 * overlap on screen, the glyph of the one behind can show over the one in
 * front. A single layer cannot draw two colours from one SDF image.
 *
 * Keep the sprite numbers in step with the generator script;
 * `waypointPinImages.test.ts` reads the PNG headers.
 *
 * PURE: no React Native / Expo imports.
 */

// ---------------------------------------------------------------- sprites

/** px of distance field around every SDF shape (the halo can reach 6 px). */
export const PIN_SDF_BUFFER = 6;
/** The pin body sprite is drawn at the XL diameter, 1 px per dp. */
export const PIN_SPRITE_BASE_D = WAYPOINT_PIN_DIAMETER.XL;
export const PIN_SPRITE_DENSITY = 1;
/** Glyph sprites: a 28 dp em box at XL (0.56 of the diameter), 2 px per dp. */
export const GLYPH_SPRITE_BOX = 28;
export const GLYPH_SPRITE_DENSITY = 2;
/** Photo badge: a 15 dp disc, plain RGBA at 3 px per dp. */
export const PHOTO_SPRITE_D = 15;
export const PHOTO_SPRITE_DENSITY = 3;

/** The pin body sprite's pixel size, and how far its tip sits above its bottom edge. */
export function pinSpriteSize(): { width: number; height: number; tipGap: number } {
  const g = pinGeometry(PIN_SPRITE_BASE_D * PIN_SPRITE_DENSITY);
  const height = Math.ceil(g.height + 2 * PIN_SDF_BUFFER);
  return {
    width: Math.ceil(g.width + 2 * PIN_SDF_BUFFER),
    height,
    tipGap: height - (PIN_SDF_BUFFER + g.height),
  };
}

/** A glyph sprite's pixel size (square). */
export function glyphSpriteSize(): number {
  return GLYPH_SPRITE_BOX * GLYPH_SPRITE_DENSITY + 2 * PIN_SDF_BUFFER;
}

export const PIN_IMAGE = 'wp-pin';
export const PHOTO_IMAGE = 'wp-photo';
export const DEFAULT_GLYPH_IMAGE = 'wpg-default';

/** The glyph sprite for an icon; an unknown or absent icon draws the inukshuk. */
export function glyphImageName(icon: string | undefined): string {
  return icon !== undefined && isWaypointIcon(icon) ? `wpg-${icon}` : DEFAULT_GLYPH_IMAGE;
}

// ---------------------------------------------------------------- features

/** A pin as the layer needs it. */
export interface PinInput {
  /** Unique across the drawn pins (`saved-<id>` / `live-<id>`). */
  key: string;
  latitude: number;
  longitude: number;
  label: string;
  icon?: string;
  color?: string;
  size?: WaypointSize;
  hasPhoto?: boolean;
}

/** The selected pin grows by this much (the card is open on it). */
export const SELECTED_SCALE = 1.2;
/** Selection ring: amber, unmistakable on any basemap (as the old marker's). */
export const SELECTED_RING = '#FFD54F';

export interface PinFeatureProps {
  key: string;
  label: string;
  /** Body `icon-size`: head diameter over the sprite's, selection included. */
  s: number;
  /** Glyph `icon-size`. */
  gs: number;
  /** Photo badge `icon-size`. */
  ps: number;
  fill: string;
  ink: string;
  ring: string;
  glyph: string;
  photo: boolean;
  /** Banded draw order: 1 for the selected pin, so it is on top. */
  z: number;
}

/**
 * The drawn pins as one FeatureCollection. `hiddenKey` (the pin being moved,
 * #676) is left out: the move overlay draws it at the centre instead.
 */
export function pinFeatureCollection(
  pins: readonly PinInput[],
  selectedKey: string | null,
  hiddenKey: string | null = null,
): FeatureCollection<Point, PinFeatureProps> {
  const features: Feature<Point, PinFeatureProps>[] = [];
  for (const p of pins) {
    if (p.key === hiddenKey) continue;
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    const selected = p.key === selectedKey;
    const d = WAYPOINT_PIN_DIAMETER[waypointSize(p.size)] * (selected ? SELECTED_SCALE : 1);
    const k = d / PIN_SPRITE_BASE_D;
    features.push({
      type: 'Feature',
      id: p.key,
      geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
      properties: {
        key: p.key,
        label: p.label,
        s: round3(k / PIN_SPRITE_DENSITY),
        gs: round3(k / GLYPH_SPRITE_DENSITY),
        ps: round3(k / PHOTO_SPRITE_DENSITY),
        fill: waypointFill(p.color),
        ink: waypointInk(p.color),
        ring: selected ? SELECTED_RING : waypointRing(p.color),
        glyph: glyphImageName(p.icon),
        photo: p.hasPhoto === true,
        z: selected ? 1 : 0,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** The glyph sprites a set of pins needs registered (always the inukshuk). */
export function glyphImagesInUse(pins: readonly PinInput[]): string[] {
  const names = new Set<string>([DEFAULT_GLYPH_IMAGE]);
  for (const p of pins) names.add(glyphImageName(p.icon));
  return [...names].sort();
}

// ---------------------------------------------------------------- layers
// Offsets are in sprite pixels, multiplied by icon-size by MapLibre.

/** Down by the gap under the tip, so the tip (not the sprite's edge) is on the point. */
const BODY_OFFSET: [number, number] = [0, Math.round(pinSpriteSize().tipGap * 100) / 100];
/** The glyph's centre on the head's centre, √2/2 of the XL diameter above the tip (glyph px). */
const GLYPH_OFFSET: [number, number] = [
  0,
  -Math.round(PIN_SPRITE_BASE_D * Math.SQRT1_2 * GLYPH_SPRITE_DENSITY * 100) / 100,
];
/** The photo badge on the head's upper-right edge (badge px). */
const PHOTO_OFFSET: [number, number] = (() => {
  const r = PIN_SPRITE_BASE_D / 2;
  const k = PHOTO_SPRITE_DENSITY;
  return [
    Math.round(r * 0.72 * k * 100) / 100,
    -Math.round((PIN_SPRITE_BASE_D * Math.SQRT1_2 + r * 0.72) * k * 100) / 100,
  ];
})();

/** Ring width, dp: within the 6 px field even at S (6 × 0.52 ≈ 3.1 dp). */
export const PIN_RING_WIDTH = 2;

const ALWAYS: SymbolLayout = {
  'icon-allow-overlap': true,
  'icon-ignore-placement': true,
  'icon-pitch-alignment': 'viewport',
  'icon-rotation-alignment': 'viewport',
};

export const pinBodyLayout: SymbolLayout = {
  ...ALWAYS,
  'icon-image': PIN_IMAGE,
  'icon-size': ['get', 's'],
  'icon-anchor': 'bottom',
  'icon-offset': BODY_OFFSET,
  'symbol-sort-key': ['get', 'z'],
};

export const pinBodyPaint: SymbolPaint = {
  'icon-color': ['get', 'fill'],
  'icon-halo-color': ['get', 'ring'],
  'icon-halo-width': PIN_RING_WIDTH,
};

export const pinGlyphLayout: SymbolLayout = {
  ...ALWAYS,
  'icon-image': ['get', 'glyph'],
  'icon-size': ['get', 'gs'],
  'icon-anchor': 'center',
  'icon-offset': GLYPH_OFFSET,
  'symbol-sort-key': ['get', 'z'],
};

export const pinGlyphPaint: SymbolPaint = {
  'icon-color': ['get', 'ink'],
};

export const pinPhotoFilter: FilterSpecification = ['==', ['get', 'photo'], true];

export const pinPhotoLayout: SymbolLayout = {
  ...ALWAYS,
  'icon-image': PHOTO_IMAGE,
  'icon-size': ['get', 'ps'],
  'icon-anchor': 'center',
  'icon-offset': PHOTO_OFFSET,
  'symbol-sort-key': ['get', 'z'],
};

/** Labels from z13: under the tip, culled by collision like the basemap's names. */
export const PIN_LABEL_MIN_ZOOM = 13;

export function pinLabelLayout(font: string[]): SymbolLayout {
  return {
    'text-field': ['get', 'label'],
    'text-font': font,
    'text-size': 11.5,
    'text-anchor': 'top',
    'text-offset': [0, 0.3],
    'text-max-width': 10,
    'text-optional': true,
    'symbol-sort-key': ['-', 1, ['get', 'z']],
  };
}

export function pinLabelPaint(ink: string, halo: string): SymbolPaint {
  return { 'text-color': ink, 'text-halo-color': halo, 'text-halo-width': 1.5 };
}
