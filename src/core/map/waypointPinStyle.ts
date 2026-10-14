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
 * 1. pin — the body AND the glyph of every pin, in ONE layer: each pin is
 *    two features, its body (tinted with its colour, ringed with its halo)
 *    then its glyph (in the ink that keeps 3:1 on that colour). Every paint
 *    and layout property that differs between them is data-driven;
 * 2. photo — the camera badge, only for pins with a photo;
 * 3. label — the name under the tip, only when the style has glyphs, and
 *    collision-culled like any label.
 *
 * Why one layer for body and glyph (2.5.1 QA, overlapping pins): MapLibre
 * draws a whole layer before the next, so with a body layer under a glyph
 * layer EVERY glyph drew above EVERY body, and the icon of a pin behind
 * landed on the pin in front. Sort keys cannot fix that — they order
 * features within a layer, never across layers. In one layer with
 * `symbol-z-order: 'source'` and no sort key, symbols draw in the order of
 * the source data (style spec), so the features go out back to front as
 * body₀, glyph₀, body₁, glyph₁, … (`pinDrawOrder`): a pin in front covers
 * the whole pin behind it, glyph included. A pin's body and glyph share one
 * anchor, so they always fall in the same tile; across tiles, whole tiles
 * stack, which still keeps each pin's two parts together. No sort key also
 * means no per-key draw segments: still one draw call per tile however many
 * pins (memory: maplibre-symbol-sort-key-cost).
 *
 * Drawing cost is per layer per tile, not per pin: 500 pins are the same
 * 2–3 draw calls as 5. The JS cost is building the FeatureCollection, once
 * per change of the pins or the selection — never per camera move.
 *
 * The one thing still drawn above every pin is the photo badge (it is RGBA,
 * and one layer cannot mix SDF and plain images): a badge of a pin behind
 * can show on the edge of the one in front.
 *
 * Since #685 the map's pins come from a CLUSTERED source, one feature per
 * pin with body and glyph in two layers (`@core/map/waypointClusters`, whose
 * header explains why the overlap fix above still holds there). The
 * one-layer, two-features-per-pin drawing here is what the SELECTED pin
 * still uses, in its own source on top. Every `icon-size` takes the Pin size
 * setting (#686) as one multiplier (`scaledSize`).
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

/** Which half of a pin a feature draws. */
export type PinPart = 'body' | 'glyph';

export interface PinFeatureProps {
  key: string;
  label: string;
  part: PinPart;
  /** The sprite: the pin body, or the pin's glyph. */
  img: string;
  /** `icon-size`: head diameter over the sprite's, selection included. */
  sz: number;
  /** Photo badge `icon-size` (body features only use it). */
  ps: number;
  /** `icon-color`: the pin's fill (body) or its ink (glyph). */
  tint: string;
  /** `icon-halo-color`: the ring (the glyph draws no halo). */
  ring: string;
  photo: boolean;
  /** 1 for the selected pin (its label wins the collision), else 0. */
  z: number;
}

/**
 * The order the pins draw in, back to front: north first (a pin lower on
 * the screen stands in front, as markers always stood), the same latitude in
 * input order, and the selected pin last, on top. The tap hit-test breaks
 * ties with the same rule (`@core/geo/pinHitTest`), so a tap on two pins at
 * one spot opens the one you see.
 */
export function pinDrawOrder<T extends { key: string; latitude: number }>(
  pins: readonly T[],
  selectedKey: string | null,
): T[] {
  return pins
    .map((pin, index) => ({ pin, index }))
    .sort(
      (a, b) =>
        Number(a.pin.key === selectedKey) - Number(b.pin.key === selectedKey) ||
        comparePinDraw(a.pin.latitude, a.index, b.pin.latitude, b.index),
    )
    .map((x) => x.pin);
}

/**
 * Negative when the pin at (`latA`, input index `iA`) draws BEHIND the one at
 * (`latB`, `iB`): the northern one is behind; at the same latitude, the
 * earlier one is.
 */
export function comparePinDraw(latA: number, iA: number, latB: number, iB: number): number {
  return latB - latA || iA - iB;
}

/**
 * The drawn pins as one FeatureCollection: two features per pin (body, then
 * glyph), back to front (see `pinDrawOrder`). `hiddenKey` (the pin being
 * moved, #676) is left out: the move overlay draws it at the centre instead.
 */
export function pinFeatureCollection(
  pins: readonly PinInput[],
  selectedKey: string | null,
  hiddenKey: string | null = null,
): FeatureCollection<Point, PinFeatureProps> {
  const features: Feature<Point, PinFeatureProps>[] = [];
  const drawn = pins.filter(
    (p) => p.key !== hiddenKey && Number.isFinite(p.latitude) && Number.isFinite(p.longitude),
  );
  for (const p of pinDrawOrder(drawn, selectedKey)) {
    const selected = p.key === selectedKey;
    const d = WAYPOINT_PIN_DIAMETER[waypointSize(p.size)] * (selected ? SELECTED_SCALE : 1);
    const k = d / PIN_SPRITE_BASE_D;
    const geometry: Point = { type: 'Point', coordinates: [p.longitude, p.latitude] };
    const common = {
      key: p.key,
      label: p.label,
      ps: round3(k / PHOTO_SPRITE_DENSITY),
      ring: selected ? SELECTED_RING : waypointRing(p.color),
      photo: p.hasPhoto === true,
      z: selected ? 1 : 0,
    };
    features.push(
      {
        type: 'Feature',
        id: `${p.key}:body`,
        geometry,
        properties: {
          ...common,
          part: 'body',
          img: PIN_IMAGE,
          sz: round3(k / PIN_SPRITE_DENSITY),
          tint: waypointFill(p.color),
        },
      },
      {
        type: 'Feature',
        id: `${p.key}:glyph`,
        geometry,
        properties: {
          ...common,
          part: 'glyph',
          img: glyphImageName(p.icon),
          sz: round3(k / GLYPH_SPRITE_DENSITY),
          tint: waypointInk(p.color),
        },
      },
    );
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
export const BODY_OFFSET: [number, number] = [0, Math.round(pinSpriteSize().tipGap * 100) / 100];
/** The glyph's centre on the head's centre, √2/2 of the XL diameter above the tip (glyph px). */
export const GLYPH_OFFSET: [number, number] = [
  0,
  -Math.round(PIN_SPRITE_BASE_D * Math.SQRT1_2 * GLYPH_SPRITE_DENSITY * 100) / 100,
];
/** The photo badge on the head's upper-right edge (badge px). */
export const PHOTO_OFFSET: [number, number] = (() => {
  const r = PIN_SPRITE_BASE_D / 2;
  const k = PHOTO_SPRITE_DENSITY;
  return [
    Math.round(r * 0.72 * k * 100) / 100,
    -Math.round((PIN_SPRITE_BASE_D * Math.SQRT1_2 + r * 0.72) * k * 100) / 100,
  ];
})();

/** Ring width, dp: within the 6 px field even at S (6 × 0.52 ≈ 3.1 dp). */
export const PIN_RING_WIDTH = 2;

export const ALWAYS: SymbolLayout = {
  'icon-allow-overlap': true,
  'icon-ignore-placement': true,
  'icon-pitch-alignment': 'viewport',
  'icon-rotation-alignment': 'viewport',
};

/** Per-part value: the glyph's for glyph features, the body's otherwise. No zoom inside. */
export const byPart = <V>(glyph: V, body: V) =>
  ['match', ['get', 'part'], 'glyph', glyph, body] as unknown as V;

/**
 * A feature's `icon-size` property times the Pin size setting (#686): one
 * multiplier in the layer, so changing the setting never rebuilds the data.
 * The offsets are in sprite pixels, which MapLibre multiplies by icon-size:
 * they follow on their own. No zoom inside (iOS: zoom only at the top).
 */
export function scaledSize(prop: string, scale: number): SymbolLayout['icon-size'] {
  return scale === 1
    ? (['get', prop] as unknown as SymbolLayout['icon-size'])
    : (['*', ['get', prop], scale] as unknown as SymbolLayout['icon-size']);
}

/**
 * Body and glyph in one layer, drawn in source order (see the header): the
 * body anchored by its tip, the glyph centred on the head. Since #685 only
 * the SELECTED pin draws this way (its own source, never clustered); the
 * others come from the clustered source (`@core/map/waypointClusters`).
 */
export function pinLayoutScaled(scale: number): SymbolLayout {
  return {
    ...ALWAYS,
    'icon-image': ['get', 'img'],
    'icon-size': scaledSize('sz', scale),
    'icon-anchor': byPart<SymbolLayout['icon-anchor']>('center', 'bottom'),
    'icon-offset': byPart<SymbolLayout['icon-offset']>(
      ['literal', GLYPH_OFFSET] as unknown as [number, number],
      ['literal', BODY_OFFSET] as unknown as [number, number],
    ),
    'symbol-z-order': 'source',
  };
}

export const pinLayout: SymbolLayout = pinLayoutScaled(1);

export const pinPaint: SymbolPaint = {
  'icon-color': ['get', 'tint'],
  'icon-halo-color': ['get', 'ring'],
  'icon-halo-width': byPart<SymbolPaint['icon-halo-width']>(0, PIN_RING_WIDTH),
};

/** Badge and label: once per pin, from its body feature. */
const BODY_ONLY: FilterSpecification = ['==', ['get', 'part'], 'body'];

export const pinPhotoFilter: FilterSpecification = [
  'all',
  BODY_ONLY,
  ['==', ['get', 'photo'], true],
];

export const pinLabelFilter: FilterSpecification = BODY_ONLY;

export function pinPhotoLayoutScaled(scale: number): SymbolLayout {
  return {
    ...ALWAYS,
    'icon-image': PHOTO_IMAGE,
    'icon-size': scaledSize('ps', scale),
    'icon-anchor': 'center',
    'icon-offset': PHOTO_OFFSET,
    'symbol-z-order': 'source',
  };
}

export const pinPhotoLayout: SymbolLayout = pinPhotoLayoutScaled(1);

/** Labels from z13: under the tip, culled by collision like the basemap's names. */
export const PIN_LABEL_MIN_ZOOM = 13;

/** The label's gap under the tip, ems, at 100 % (it grows with the Pin size, #686). */
export const PIN_LABEL_GAP_EM = 0.3;

/**
 * `sortBySelection`: the one-source drawing ranks the selected pin's name
 * first. The clustered source has no selected pin (it draws in its own
 * layer, above, so its label is placed first anyway) and no `z` to sort by.
 */
export function pinLabelLayout(font: string[], scale = 1, sortBySelection = true): SymbolLayout {
  const layout: SymbolLayout = {
    'text-field': ['get', 'label'],
    'text-font': font,
    'text-size': 11.5,
    'text-anchor': 'top',
    'text-offset': [0, Math.round(PIN_LABEL_GAP_EM * scale * 1000) / 1000],
    'text-max-width': 10,
    'text-optional': true,
  };
  // Two values only (banded): the selected pin's name is placed first, so
  // it wins the label collision.
  if (sortBySelection) layout['symbol-sort-key'] = ['-', 1, ['get', 'z']];
  return layout;
}

export function pinLabelPaint(ink: string, halo: string): SymbolPaint {
  return { 'text-color': ink, 'text-halo-color': halo, 'text-halo-width': 1.5 };
}
