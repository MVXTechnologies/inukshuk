/**
 * Continuity: everything that changes the terrain's shape eases instead of
 * popping — the pitch ramp that grows 3D out of the flat map, and the time
 * morph a tile runs whenever its heights change (a split into finer tiles, a
 * better DEM arriving).
 */

/** Pitch (deg) below which the map is flat 2D — the layer does nothing. */
export const RAMP_START_DEG = 25;
/** Pitch (deg) from which the terrain is at full height. */
export const RAMP_FULL_DEG = 45;
/** How long a tile takes to morph to new heights. */
export const MORPH_MS = 280;
/** Deepest pitch the map allows while 3D terrain is on. */
export const TERRAIN_MAX_PITCH_DEG = 80;

export function clamp01(x: number): number {
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

/** Hermite smoothstep: 0 at e0, 1 at e1, C¹-continuous. Non-finite → 0. */
export function smoothstep(e0: number, e1: number, x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (e1 === e0) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** The 3D ramp `t` for a camera pitch: 0 flat, 1 full relief. */
export function pitchRamp(pitchDeg: number, start = RAMP_START_DEG, full = RAMP_FULL_DEG): number {
  return smoothstep(start, full, pitchDeg);
}

/**
 * A tile's morph weight toward its OLD heights after `elapsedMs`: 1 at the
 * start (exactly what was on screen), 0 when settled.
 */
export function morphFactor(elapsedMs: number, durationMs = MORPH_MS): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1;
  if (durationMs <= 0) return 0;
  return 1 - smoothstep(0, durationMs, elapsedMs);
}

/**
 * The z (m, MapLibre's metres) the shader gives a vertex:
 * `(mix(hTo, hFrom, m) − hRef) · exaggeration · t`, minus the skirt drop.
 * `fromFlat` = the tile was flat before (no DEM): the morph starts from the
 * flat map (Δh = 0) instead of `hFrom`.
 */
export function displayedZ(p: {
  hFrom: number;
  hTo: number;
  morph: number;
  hRef: number;
  exaggeration: number;
  ramp: number;
  fromFlat?: boolean;
  skirt?: number;
}): number {
  const to = p.hTo - p.hRef;
  const from = p.fromFlat ? 0 : p.hFrom - p.hRef;
  const m = clamp01(p.morph);
  const dh = to + (from - to) * m;
  return dh * p.exaggeration * p.ramp - (p.skirt ?? 0) * p.ramp;
}

/** True while any of `startedAt` (ms timestamps) is still morphing at `now`. */
export function anyMorphing(
  startedAt: readonly number[],
  now: number,
  durationMs = MORPH_MS,
): boolean {
  return startedAt.some((s) => now - s < durationMs);
}
