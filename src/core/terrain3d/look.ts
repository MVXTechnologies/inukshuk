/**
 * How the 3D terrain looks: exaggeration per "3D relief" setting, the light
 * (the 2D hillshade's own), and the fog/sky colours — derived from the map's
 * theme tokens so the 3D horizon dissolves into the same paper (light), the
 * same stone-night (dark), or a daylight sky with atmospheric perspective
 * (satellite). Pure numbers for the native shaders.
 */
import { clamp01 } from './morph';

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
  /** Optional cool tint for the light map's zenith (e.g. the river token). */
  skyTint?: string;
  relief: TerrainRelief;
}

export interface TerrainLook {
  exaggeration: number;
  fogColor: Rgb;
  skyHorizon: Rgb;
  skyZenith: Rgb;
  /** Strength of the 3D form (Lambert) term over the draped map, 0–1. */
  formStrength: number;
  /** Fog starts this many camera-to-centre distances away… */
  fogStartCtc: number;
  /** …thickens with this exponential density per ctc… */
  fogDensity: number;
  /** …and is total here (also the LOD's far cut). */
  fogEndCtc: number;
}

/** The look for a theme/basemap/setting. */
export function terrainLook(i: TerrainLookInput): TerrainLook {
  const exaggeration = RELIEF_EXAGGERATION[i.relief];
  if (i.basemap === 'satellite') {
    const k = i.dark ? 0.86 : 1;
    return {
      exaggeration,
      fogColor: scale(SAT_HAZE, k),
      skyHorizon: scale(SAT_HORIZON, k),
      skyZenith: scale(SAT_ZENITH, k),
      formStrength: 0.18,
      fogStartCtc: 0.6,
      fogDensity: 0.1,
      fogEndCtc: 12,
    };
  }
  const land = parseColor(i.land) ?? FALLBACK_PAPER;
  if (i.dark) {
    return {
      exaggeration,
      fogColor: land,
      skyHorizon: mix(land, WHITE, 0.07),
      skyZenith: mix(land, BLACK, 0.35),
      formStrength: 0.2,
      fogStartCtc: 2.5,
      fogDensity: 0.12,
      fogEndCtc: 12,
    };
  }
  const tint = (i.skyTint ? parseColor(i.skyTint) : null) ?? land;
  return {
    exaggeration,
    fogColor: land,
    skyHorizon: mix(land, WHITE, 0.25),
    skyZenith: mix(mix(land, tint, 0.22), WHITE, 0.15),
    formStrength: 0.22,
    fogStartCtc: 2.5,
    fogDensity: 0.12,
    fogEndCtc: 12,
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
export const PACKED_LOOK_LENGTH = 14;

/**
 * `[exaggeration, fog rgb, horizon rgb, zenith rgb, form, fogStart,
 * fogDensity, fogEnd]` — the order both native modules unpack.
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
  ];
}
