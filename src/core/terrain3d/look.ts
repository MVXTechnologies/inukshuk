/**
 * How the 3D terrain looks: exaggeration per "3D relief" setting, the light
 * (the 2D hillshade's own), and the fog/sky colours — derived from the map's
 * theme tokens so the 3D horizon dissolves into the same paper (light), the
 * same stone-night (dark), or a daylight sky with atmospheric perspective
 * (satellite). Pure numbers for the native shaders.
 */
import { clamp01 } from './morph';
import type { SurfacePalette } from './surface';

export type Rgb = [number, number, number];
export type TerrainBasemap = 'map' | 'satellite';
export type TerrainRelief = 'natural' | 'dramatic';

/** Vertical exaggeration per "3D relief" setting. */
export const RELIEF_EXAGGERATION: Readonly<Record<TerrainRelief, number>> = {
  natural: 1,
  dramatic: 1.6,
};

/** The 2D hillshade's light: from the NNW (`HILLSHADE_ILLUMINATION_DIRECTION`). */
export const LIGHT_AZIMUTH_DEG = 335;
export const LIGHT_ALTITUDE_DEG = 45;

/** Parse `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` into 0–1 RGB, or null. */
export function parseColor(css: string): Rgb | null {
  const s = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255,
    ];
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*[\d.]+\s*)?\)$/.exec(s);
  if (fn) {
    const c = [fn[1], fn[2], fn[3]].map((v) => clamp01(Number(v) / 255));
    if (c.some((v) => !Number.isFinite(v))) return null;
    return c as Rgb;
  }
  return null;
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export function scale(a: Rgb, k: number): Rgb {
  return [clamp01(a[0] * k), clamp01(a[1] * k), clamp01(a[2] * k)];
}

/** Relative luminance (sRGB coefficients on the encoded values — a ranking, not a colorimetric value). */
export function luma(c: Rgb): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

const WHITE: Rgb = [1, 1, 1];
const BLACK: Rgb = [0, 0, 0];
/** Fallback paper when a token can't be parsed (the light map's land). */
export const FALLBACK_PAPER: Rgb = [0xf2 / 255, 0xec / 255, 0xe0 / 255];
const SAT_HORIZON: Rgb = [0xc9 / 255, 0xd6 / 255, 0xe2 / 255];
const SAT_ZENITH: Rgb = [0x5f / 255, 0x8f / 255, 0xcb / 255];
const SAT_HAZE: Rgb = [0xbf / 255, 0xcc / 255, 0xd8 / 255];

export interface TerrainLookInput {
  basemap: TerrainBasemap;
  /** App theme (stone-night vs paper). */
  dark: boolean;
  /** The map's land/background token (CSS colour). */
  land: string;
  /** Bare ground / rock token (the map's `landAlt`). */
  landAlt?: string;
  /** Water token (washed over the land like the 2D map). */
  water?: string;
  /** Contour line token. */
  contour?: string;
  /** Ink token (index contours lean toward it). */
  ink?: string;
  /** Optional cool tint for the light map's zenith (e.g. the river token). */
  skyTint?: string;
  relief: TerrainRelief;
  /** Draw contour lines on the surface (follows the map's contour setting). */
  contours?: boolean;
}

export interface TerrainLook {
  exaggeration: number;
  fogColor: Rgb;
  skyHorizon: Rgb;
  skyZenith: Rgb;
  /** Strength of the 3D form term over satellite imagery, 0–1. */
  formStrength: number;
  /** Fog starts this many camera-to-centre distances away… */
  fogStartCtc: number;
  /** …thickens with this exponential density per ctc… */
  fogDensity: number;
  /** …and is total here (also the LOD's far cut). */
  fogEndCtc: number;
  /** The relief model's materials and light tints (map style). */
  surface: SurfacePalette;
  contourColor: Rgb;
  contourMajorColor: Rgb;
  /** 0 hides the contours. */
  contourOpacity: number;
  /** 1 = the surface is satellite imagery tiles, 0 = the shaded relief model. */
  imagery: number;
}

const UMBER: Rgb = [74 / 255, 62 / 255, 45 / 255];
const WARM_WHITE: Rgb = [1, 250 / 255, 240 / 255];
const NIGHT_HIGHLIGHT: Rgb = [235 / 255, 228 / 255, 214 / 255];
const RIVER_FALLBACK: Rgb = [0x5c / 255, 0x93 / 255, 0xb7 / 255];
const OCHRE_FALLBACK: Rgb = [0xb0 / 255, 0x7a / 255, 0x3a / 255];
const ICE: Rgb = [0xee / 255, 0xf3 / 255, 0xf7 / 255];

/**
 * Where the 3D view ends in haze (camera-to-centre distances; round 3: 12 →
 * 8). Nothing past it is drawn, fetched or rendered, and the LOD coarsens
 * toward it (lod.ts fogLodFactor) — the far band was most of the tiles and
 * drape renders while adding little but haze. The haze curve thickens
 * (density) so the fog still builds naturally rather than ending in a wall.
 */
export const TERRAIN_FOG_END_CTC = 8;

/** The look for a theme/basemap/setting. */
export function terrainLook(i: TerrainLookInput): TerrainLook {
  const exaggeration = RELIEF_EXAGGERATION[i.relief];
  const land = parseColor(i.land) ?? FALLBACK_PAPER;
  const landAlt = (i.landAlt ? parseColor(i.landAlt) : null) ?? mix(land, BLACK, 0.06);
  const river = (i.water ? parseColor(i.water) : null) ?? RIVER_FALLBACK;
  const contour = (i.contour ? parseColor(i.contour) : null) ?? OCHRE_FALLBACK;
  const ink = (i.ink ? parseColor(i.ink) : null) ?? (i.dark ? WHITE : BLACK);
  const contoursOn = i.contours ?? true;
  if (i.basemap === 'satellite') {
    const k = i.dark ? 0.86 : 1;
    return {
      exaggeration,
      fogColor: scale(SAT_HAZE, k),
      skyHorizon: scale(SAT_HORIZON, k),
      skyZenith: scale(SAT_ZENITH, k),
      formStrength: 0.18,
      fogStartCtc: 0.6,
      fogDensity: 0.16,
      fogEndCtc: TERRAIN_FOG_END_CTC,
      surface: {
        land,
        rock: landAlt,
        water: river,
        glacier: ICE,
        shadow: BLACK,
        highlight: WHITE,
      },
      // Imagery: paper lines, as the 2D map draws contours over satellite.
      contourColor: FALLBACK_PAPER,
      contourMajorColor: WHITE,
      contourOpacity: contoursOn ? 0.5 : 0,
      imagery: 1,
    };
  }
  if (i.dark) {
    return {
      exaggeration,
      fogColor: land,
      skyHorizon: mix(land, WHITE, 0.07),
      skyZenith: mix(land, BLACK, 0.35),
      formStrength: 0.2,
      fogStartCtc: 2,
      fogDensity: 0.22,
      fogEndCtc: TERRAIN_FOG_END_CTC,
      surface: {
        // A touch above the 2D ground so the shadows have somewhere to go.
        land: mix(land, NIGHT_HIGHLIGHT, 0.06),
        rock: mix(land, landAlt, 0.8),
        water: mix(land, river, 0.3),
        glacier: mix(land, mix(ICE, river, 0.2), 0.38),
        // Night relief needs its light: a softer shadow, a brighter lit face.
        shadow: mix(land, BLACK, 0.7),
        highlight: mix(land, NIGHT_HIGHLIGHT, 0.68),
      },
      // Sunk into the stone, as the 2D night map draws them: bright ochre on
      // near-black reads as a wireframe.
      contourColor: mix(land, contour, 0.42),
      contourMajorColor: mix(land, contour, 0.62),
      contourOpacity: contoursOn ? 0.7 : 0,
      imagery: 0,
    };
  }
  const tint = (i.skyTint ? parseColor(i.skyTint) : null) ?? land;
  return {
    exaggeration,
    fogColor: land,
    skyHorizon: mix(land, WHITE, 0.25),
    skyZenith: mix(mix(land, tint, 0.22), WHITE, 0.15),
    formStrength: 0.22,
    fogStartCtc: 2,
    fogDensity: 0.22,
    fogEndCtc: TERRAIN_FOG_END_CTC,
    surface: {
      land,
      rock: landAlt,
      water: mix(land, river, 0.45),
      // Ice reads cooler and brighter than the paper (the two are near-twins).
      glacier: mix(WHITE, river, 0.16),
      shadow: mix(land, UMBER, 0.78),
      highlight: mix(land, WARM_WHITE, 0.9),
    },
    contourColor: mix(land, contour, 0.68),
    contourMajorColor: mix(contour, ink, 0.25),
    contourOpacity: contoursOn ? 0.95 : 0,
    imagery: 0,
  };
}

/** Fog amount (0–1) at `distanceCtc` camera-to-centre distances. */
export function fogAmount(
  look: Pick<TerrainLook, 'fogStartCtc' | 'fogDensity' | 'fogEndCtc'>,
  distanceCtc: number,
): number {
  if (!Number.isFinite(distanceCtc) || distanceCtc <= look.fogStartCtc) return 0;
  const exp = 1 - Math.exp(-look.fogDensity * (distanceCtc - look.fogStartCtc));
  const end = look.fogEndCtc;
  const t = clamp01((distanceCtc - end * 0.85) / (end * 0.15));
  const wall = t * t * (3 - 2 * t);
  return clamp01(Math.max(exp, wall));
}

/**
 * Unit vector TOWARD the light in the terrain's frame (x east, y SOUTH,
 * z up). The 2D hillshade's light is anchored to the viewport, so it turns
 * with the map: azimuth = bearing + 335°.
 */
export function lightDirection(
  bearingDeg: number,
  azimuthDeg = LIGHT_AZIMUTH_DEG,
  altitudeDeg = LIGHT_ALTITUDE_DEG,
): [number, number, number] {
  const az = ((bearingDeg + azimuthDeg) * Math.PI) / 180;
  const alt = (altitudeDeg * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(alt), -Math.cos(az) * Math.cos(alt), Math.sin(alt)];
}

/**
 * The form term multiplier for a surface slope (m/m, x east / y south):
 * 1 on flat ground, brighter facing the light, darker away, scaled by
 * `strength` and the pitch ramp so the flat map is untouched at t = 0.
 */
export function formShade(
  slopeX: number,
  slopeY: number,
  exaggeration: number,
  light: readonly [number, number, number],
  strength: number,
  ramp: number,
): number {
  const nx = -slopeX * exaggeration;
  const ny = -slopeY * exaggeration;
  const len = Math.hypot(nx, ny, 1);
  const lambert = Math.max(0, (nx * light[0] + ny * light[1] + light[2]) / len);
  const flat = light[2];
  return 1 + (lambert - flat) * strength * 2 * ramp;
}

/** Pack an RGB for a uniform: three floats. */
export function rgbArray(c: Rgb): [number, number, number] {
  return [c[0], c[1], c[2]];
}

/** Floats the native layer takes (TerrainNative.nativeSetLook / the iOS twin). */
export const PACKED_LOOK_LENGTH = 40;

/**
 * `[exaggeration, fog rgb, horizon rgb, zenith rgb, form, fogStart,
 * fogDensity, fogEnd, land rgb, rock rgb, water rgb, glacier rgb, shadow rgb,
 * highlight rgb, contour rgb, contourMajor rgb, contourOpacity, imagery]` —
 * the order both native modules unpack.
 */
export function packLook(l: TerrainLook): number[] {
  return [
    l.exaggeration,
    ...l.fogColor,
    ...l.skyHorizon,
    ...l.skyZenith,
    l.formStrength,
    l.fogStartCtc,
    l.fogDensity,
    l.fogEndCtc,
    ...l.surface.land,
    ...l.surface.rock,
    ...l.surface.water,
    ...l.surface.glacier,
    ...l.surface.shadow,
    ...l.surface.highlight,
    ...l.contourColor,
    ...l.contourMajorColor,
    l.contourOpacity,
    l.imagery,
  ];
}
