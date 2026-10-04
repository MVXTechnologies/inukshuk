/**
 * Contour lines drawn AS GEOMETRY on the 3D terrain (owner, #551: "the
 * contour lines added as 3D geometry so it doesn't look painted").
 *
 * Technique (a) of the brief, chosen over (b) extracted polylines: each
 * fragment of the terrain knows its interpolated height, and the line is
 * evaluated analytically from it — distance to the nearest contour level in
 * SCREEN pixels via the height's screen-space derivative (`fwidth`). Lines are
 * therefore exactly on the surface (no depth bias, no z-fighting), a constant
 * screen width, anti-aliased by coverage, never stretched like a texture, and
 * they can't swim: they are a function of the geometry itself. (b) would need
 * per-tile marching squares on every bake, a depth bias that either floats
 * lines off ridges or lets the surface eat them, and ~10× the vertices.
 *
 * The interval adapts like the 2D map: the camera zoom picks the finest level
 * (`contourLevels`, the Worker's ladder), and per fragment the level steps up
 * where lines would crowd closer than {@link MIN_SPACING_PX} — so far and
 * steep slopes coarsen smoothly instead of turning into moiré.
 */

/** [minor, major] interval (m) — the Worker's `LEVEL_LADDER`, finest first. */
export const LEVEL_LADDER: readonly (readonly [number, number])[] = [
  [10, 50],
  [20, 100],
  [25, 100],
  [50, 250],
  [100, 500],
  [200, 1000],
  [500, 2500],
];

/** Minor/major lines closer than this (px) step to a coarser level. */
export const MIN_SPACING_PX = 8;
/** …fully switched when the coarser level would be this far apart. */
export const FULL_SPACING_PX = 12;
/** Line widths in px (logical): minor and index (major) lines. */
export const MINOR_WIDTH_PX = 1.1;
export const MAJOR_WIDTH_PX = 2.0;

/** The 2D map's [minor, major] interval for a zoom (the Worker's `contourLevels`). */
export function contourLevelsForZoom(zoom: number): readonly [number, number] {
  const z = Math.floor(zoom);
  if (z <= 9) return [100, 500];
  if (z === 10) return [50, 250];
  if (z === 11) return [25, 100];
  if (z === 12) return [20, 100];
  return [10, 50];
}

/** Ladder index of the zoom's own level. */
export function baseLevelIndex(zoom: number): number {
  const [minor] = contourLevelsForZoom(zoom);
  const i = LEVEL_LADDER.findIndex(([m]) => m === minor);
  return i < 0 ? 0 : i;
}

/**
 * The level a fragment draws: the first at or above `base` whose minor lines
 * are at least {@link MIN_SPACING_PX} apart, given the height change per
 * screen pixel `dhPerPx` (m/px). `blend` (0–1) fades the finer level out as
 * spacing approaches the threshold, so stepping is a crossfade.
 */
export function levelForDensity(
  base: number,
  dhPerPx: number,
): { index: number; finerWeight: number } {
  const d = Math.max(Math.abs(dhPerPx), 1e-6);
  for (let i = Math.max(0, base); i < LEVEL_LADDER.length; i++) {
    const spacing = LEVEL_LADDER[i]![0] / d;
    if (spacing >= MIN_SPACING_PX) {
      // How much of the next-finer level still shows (0 when i === base).
      if (i === Math.max(0, base)) return { index: i, finerWeight: 0 };
      const finerSpacing = LEVEL_LADDER[i - 1]![0] / d;
      const t = Math.min(Math.max((finerSpacing - (MIN_SPACING_PX - 2)) / 2, 0), 1);
      return { index: i, finerWeight: t };
    }
  }
  return { index: LEVEL_LADDER.length - 1, finerWeight: 0 };
}

/** Distance (px) from a height to the nearest multiple of `interval`. */
export function distanceToLevelPx(h: number, interval: number, dhPerPx: number): number {
  const v = h / interval;
  const f = Math.abs(v - Math.round(v)); // 0 on a level, 0.5 midway
  return (f * interval) / Math.max(Math.abs(dhPerPx), 1e-6);
}

/** Anti-aliased coverage (0–1) of a line `widthPx` wide at `distPx` from its centre. */
export function lineCoverage(distPx: number, widthPx: number): number {
  return Math.min(Math.max(widthPx / 2 + 0.5 - distPx, 0), 1);
}

/** Is the level nearest to `h` an index (major) line of `[minor, major]`? */
export function isMajorLevel(h: number, minor: number, major: number): boolean {
  const k = Math.round(h / minor);
  const every = Math.round(major / minor);
  return ((k % every) + every) % every === 0;
}

export interface ContourSample {
  /** Minor-line coverage 0–1. */
  minor: number;
  /** Index-line coverage 0–1. */
  major: number;
}

/**
 * Everything the fragment shader computes, for one height sample: which
 * level, and the minor and major line coverages (the major includes its own
 * wider stroke; a major level is not double-counted as minor).
 */
export function contourAt(h: number, dhPerPx: number, zoom: number): ContourSample {
  const { index, finerWeight } = levelForDensity(baseLevelIndex(zoom), dhPerPx);
  const sample = (i: number) => {
    const [minor, major] = LEVEL_LADDER[i]!;
    const dMinor = distanceToLevelPx(h, minor, dhPerPx);
    const dMajor = distanceToLevelPx(h, major, dhPerPx);
    const maj = lineCoverage(dMajor, MAJOR_WIDTH_PX);
    const min = isMajorLevel(h, minor, major) ? 0 : lineCoverage(dMinor, MINOR_WIDTH_PX);
    return { minor: min, major: maj };
  };
  const coarse = sample(index);
  if (finerWeight <= 0 || index === 0) return coarse;
  const fine = sample(index - 1);
  return {
    minor: Math.max(coarse.minor, fine.minor * finerWeight),
    major: Math.max(coarse.major, fine.major * finerWeight),
  };
}
