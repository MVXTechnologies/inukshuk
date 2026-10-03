/**
 * "3D relief" on the tilted main map (#480): what the map can do to make
 * mountains read as mountains once the user tilts it with two fingers.
 *
 * The honest limit first. The bundled MapLibre Native (Android 13.6.1 / iOS
 * 6.31.0, via @maplibre/maplibre-react-native 11.4) has NO 3D terrain: its
 * style parser knows `light` but neither `terrain` nor `sky`, so a
 * raster-dem-draped surface is impossible on the main map — tilting only ever
 * leans a flat sheet. What it CAN do is shade harder: a second hillshade pass
 * over the same Terrarium DEM, faded in with the pitch, so the relief's
 * shadows deepen as the view lowers and ridges stand out against the
 * foreshortened slopes. Pure decisions here; `features/map` renders them.
 *
 * Since the native terrain module (docs/plans/native-terrain.md), binaries
 * that ship it draw REAL 3D relief instead (and raise the pitch ceiling to
 * 80° natively); this pass is then switched off and remains the fallback for
 * older binaries running a newer bundle.
 */
import { hillshadeLook, type HillshadeLook } from './terrainOptions';

/**
 * The main map's maximum pitch, in degrees: MapLibre Native's default
 * (`DEFAULT_PITCH_MAX = M_PI / 3` in core, `MapLibreConstants.MAXIMUM_PITCH`
 * on Android, `MLNMapView.maximumPitch` on iOS). The core would accept more
 * — `Transform::setMaxPitch` clamps only to `PITCH_MAX = M_PI` — but the
 * React Native wrapper exposes no max-pitch prop, and a Camera `pitch` above
 * this is clamped natively. Raising it needs native code (a store build) —
 * the native terrain module does (see `TERRAIN_MAX_PITCH_DEG`).
 */
export const MAP_MAX_PITCH_DEG = 60;

/** How much the relief deepens when the map is tilted. */
export type TiltRelief = 'off' | 'natural' | 'dramatic';

export const TILT_RELIEFS: readonly TiltRelief[] = ['off', 'natural', 'dramatic'];

export const DEFAULT_TILT_RELIEF: TiltRelief = 'natural';

export const TILT_RELIEF_LABEL: Readonly<Record<TiltRelief, string>> = {
  off: 'Off',
  natural: 'Natural',
  dramatic: 'Dramatic',
};

export function isTiltRelief(v: unknown): v is TiltRelief {
  return typeof v === 'string' && (TILT_RELIEFS as readonly string[]).includes(v);
}

/** Below this pitch the map counts as flat: no extra relief pass at all. */
export const TILT_RELIEF_START_DEG = 10;
/** At and above this pitch the extra relief is at full strength. */
export const TILT_RELIEF_FULL_DEG = 45;

/**
 * The extra pass's hillshade exaggeration at full tilt. It STACKS on the
 * base shading (Medium = 0.45), so Natural lands near Heavy's depth and
 * Dramatic near the hillshade's ceiling without clipping to black.
 */
export const TILT_RELIEF_EXAGGERATION: Readonly<Record<Exclude<TiltRelief, 'off'>, number>> = {
  natural: 0.3,
  dramatic: 0.6,
};

/**
 * How far into the tilt ramp a pitch is: 0 when flat (below
 * {@link TILT_RELIEF_START_DEG}), 1 from {@link TILT_RELIEF_FULL_DEG}, linear
 * between. Non-finite pitches read as flat.
 */
export function tiltAmount(pitchDeg: number): number {
  if (!Number.isFinite(pitchDeg) || pitchDeg <= TILT_RELIEF_START_DEG) return 0;
  if (pitchDeg >= TILT_RELIEF_FULL_DEG) return 1;
  return (pitchDeg - TILT_RELIEF_START_DEG) / (TILT_RELIEF_FULL_DEG - TILT_RELIEF_START_DEG);
}

/**
 * The settled pitch rounded to a 5° step. The map screen keeps this in React
 * state rather than the raw pitch, so a settle that moved the pitch by a
 * fraction of a degree (follow mode settles on every GPS fix) re-renders
 * nothing.
 */
export function pitchBucket(pitchDeg: number): number {
  if (!Number.isFinite(pitchDeg) || pitchDeg <= 0) return 0;
  return Math.min(MAP_MAX_PITCH_DEG, Math.round(pitchDeg / 5) * 5);
}

/**
 * Satellite imagery's share of the tilt pass (#492): the photo already
 * carries the sun's real shadows, so the pass only deepens them — lighter
 * than on the map, where it stacks on our own shading.
 */
export const IMAGERY_TILT_RELIEF_SCALE = 0.6;

/**
 * The extra hillshade pass for a setting at a pitch, or null when there is
 * none to draw (setting off, or the map flat). Colours come from the base
 * shading's own palette (Medium for Natural, Heavy for Dramatic), so the dark
 * stone-night map deepens toward black and the light maps toward umber.
 *
 * `imagery` (#492): the pass over satellite imagery, which has no flat
 * shading under it — the night palette (near-black shadows, a faint warm
 * highlight: umber would tint the photo) at {@link IMAGERY_TILT_RELIEF_SCALE}
 * of the strength.
 */
export function tiltReliefLook(
  mode: TiltRelief,
  pitchDeg: number,
  dark: boolean,
  imagery = false,
): HillshadeLook | null {
  if (mode === 'off') return null;
  const t = tiltAmount(pitchDeg);
  if (t === 0) return null;
  const palette = hillshadeLook(mode === 'dramatic' ? 'heavy' : 'medium', dark || imagery);
  const scale = imagery ? IMAGERY_TILT_RELIEF_SCALE : 1;
  return {
    ...palette,
    exaggeration: Math.round(TILT_RELIEF_EXAGGERATION[mode] * scale * t * 100) / 100,
  };
}

/**
 * Just the extra pass's exaggeration for a setting at a pitch — 0 means the
 * pass is hidden. The pass's colours live in the style (see
 * `features/map/mapStyle.ts`), so the map screens only need this number.
 */
export function tiltReliefExaggeration(
  mode: TiltRelief,
  pitchDeg: number,
  imagery = false,
): number {
  return tiltReliefLook(mode, pitchDeg, false, imagery)?.exaggeration ?? 0;
}
