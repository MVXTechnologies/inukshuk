/**
 * The Inukshuk figure as pure vector data: Marc's five faceted granite stones
 * (the "compact" set), copied verbatim from assets/brand/stone-compact-*.svg
 * and placed by assets/brand/stones-compact.json. Each stone draws its base
 * fill, then flat facet polygons clipped to the stone's outline (facets
 * deliberately overshoot the outline; the clip defines the silhouette).
 *
 * Geometry only — no React. Rendered by InukshukLoader.
 */
import type { Rect, StoneId } from '@core/anim/inukshukTimeline';

/** The figure frame all stone rects live in. */
export const FIGURE_W = 784;
export const FIGURE_H = 870;

export interface StoneFacet {
  /** SVG path data in the stone's own box (0 0 w h). */
  d: string;
  fill: string;
}

export interface StoneShape extends Rect {
  id: StoneId;
  /** Outline path (clip + base fill), in the stone's own box. */
  outline: string;
  base: string;
  /** Drawn in order over the base, each stroked 0.9 in its own fill (bevel joins). */
  facets: readonly StoneFacet[];
}

/** Back to front: leg-left, leg-right, torso, arm, head. */
export const STONES: readonly StoneShape[] = [
  {
    id: 'leg-left',
    x: 99,
    y: 549,
    w: 248,
    h: 317,
    outline:
      'M228.75 10.00 242.75 29.75 244.50 38.75 225.50 235.25 217.00 289.00 207.00 306.25 197.25 313.25 153.25 314.50 21.50 310.25 2.50 283.50 27.75 174.25 69.50 43.00 101.50 3.50 193.50 5.75Z',
    base: '#273038',
    facets: [
      { d: 'M202.75 -12.00 197.50 3.50 189.25 5.50 183.00 -12.00Z', fill: '#343d44' },
      {
        d: 'M221.75 -12.00 88.00 -12.00 101.00 5.00 102.75 47.00 60.00 47.00 -12.00 13.00 -12.00 234.75 19.50 234.50 74.50 168.50 106.00 69.50 124.50 63.50 221.00 10.75Z',
        fill: '#404850',
      },
      {
        d: 'M-12.00 -12.00 -12.00 21.75 10.50 22.00 98.25 67.50 105.50 67.25 100.75 5.00 91.00 -5.50 90.75 -12.00Z',
        fill: '#555c65',
      },
    ],
  },
  {
    id: 'leg-right',
    x: 428,
    y: 548,
    w: 255,
    h: 318,
    outline:
      'M146.50 2.75 29.00 7.50 4.75 35.50 21.25 136.50 26.25 194.50 28.25 287.00 50.75 313.25 229.25 312.25 250.25 287.50 242.50 240.75 210.00 126.75 191.00 99.75 170.75 24.25Z',
    base: '#273037',
    facets: [
      { d: 'M266.75 322.00 266.75 329.75 241.00 329.75 242.00 322.00Z', fill: '#343c44' },
      {
        d: 'M266.75 106.00 266.75 329.75 249.00 329.75 174.25 221.50 173.00 214.00 208.25 128.50ZM132.75 -12.00 31.00 -12.00 32.00 12.75 42.75 30.25 42.75 37.25 -12.00 38.00 -12.00 196.75 28.50 194.25 56.00 53.50 134.00 11.75Z',
        fill: '#404850',
      },
      { d: 'M-12.00 24.00 2.50 32.25 1.50 39.50 -12.00 41.75Z', fill: '#495764' },
      {
        d: 'M-12.00 -12.00 -12.00 36.75 9.75 36.75 49.25 49.50 46.50 37.25 30.00 11.50 28.75 -12.00Z',
        fill: '#575e67',
      },
    ],
  },
  {
    id: 'torso',
    x: 177,
    y: 374,
    w: 438,
    h: 174,
    outline:
      'M8.50 36.00 21.75 18.50 38.75 4.50 57.25 2.50 408.75 8.25 432.00 28.75 434.25 39.75 423.25 128.50 404.00 163.25 325.75 169.25 90.75 170.75 33.25 166.00 3.00 132.50Z',
    base: '#273138',
    facets: [
      {
        d: 'M449.75 79.00 449.75 185.75 217.00 185.75 217.75 165.00 326.25 114.25 424.00 79.00ZM176.75 -12.00 172.50 2.50 164.50 5.50 164.00 -12.00Z',
        fill: '#414850',
      },
      { d: 'M220.75 -12.00 220.00 10.75 78.75 61.75 -12.00 30.75 -12.00 -12.00Z', fill: '#4f565f' },
      {
        d: 'M13.00 -12.00 22.25 6.50 33.50 11.50 34.75 4.00 26.00 -5.50 25.75 -12.00Z',
        fill: '#536674',
      },
    ],
  },
  {
    id: 'arm',
    x: 2,
    y: 182,
    w: 780,
    h: 186,
    outline:
      'M3.25 130.25 19.50 80.00 41.00 51.50 146.50 31.25 292.25 26.00 549.75 27.50 739.25 34.50 765.25 59.00 777.25 119.50 755.00 151.00 729.00 179.00 589.25 182.25 37.75 181.25 18.25 166.25Z',
    base: '#273138',
    facets: [
      {
        d: 'M257.00 -12.00 259.25 24.25 286.50 29.50 281.50 9.50 267.75 7.75 267.75 -12.00Z',
        fill: '#3a434c',
      },
      {
        d: 'M-12.00 -12.00 -12.00 71.75 9.75 71.75 23.00 78.75 100.75 74.75 145.00 92.75 268.00 38.75 312.75 38.75 545.75 77.75 629.75 31.75 629.75 -12.00Z',
        fill: '#4e565f',
      },
    ],
  },
  {
    id: 'head',
    x: 271,
    y: 4,
    w: 229,
    h: 201,
    outline:
      'M202.00 4.25 225.50 36.00 228.25 170.50 214.75 190.25 206.50 196.25 28.50 198.50 22.25 195.25 2.25 169.50 5.75 31.00 38.25 2.25Z',
    base: '#273037',
    facets: [
      {
        d: 'M-12.00 165.75 4.75 165.00 69.25 38.00 162.50 26.50 195.50 4.25 195.75 -12.00 -12.00 -12.00 -12.00 -8.25 38.00 -6.00 37.75 3.50 29.50 7.25 11.50 27.75 -12.00 28.00Z',
        fill: '#4e555e',
      },
      {
        d: 'M-12.00 33.75 1.75 33.75 3.50 25.00 16.50 22.75 20.50 4.00 37.50 3.25 37.75 -12.00 -12.00 -12.00Z',
        fill: '#516371',
      },
    ],
  },
];

export const FACET_STROKE_WIDTH = 0.9;

/**
 * Night tone for dark surfaces: each channel c -> 60 + 1.05 c, so the base
 * granite #273037 becomes #656E76 (~3.5:1 on the dark theme) and the facets
 * keep their relative contrast. Same transform as assets/splash-icon-dark.png
 * (scripts/brand/build-icons.py, NIGHT_A / NIGHT_B).
 */
export function nightTone(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => {
    const c = (n >> shift) & 0xff;
    return Math.min(255, Math.round(60 + 1.05 * c))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

/** Stone rects by id, in figure-frame units. */
export const STONE_RECTS: Readonly<Record<StoneId, Rect>> = (() => {
  const byId: Partial<Record<StoneId, Rect>> = {};
  for (const s of STONES) byId[s.id] = { x: s.x, y: s.y, w: s.w, h: s.h };
  const get = (id: StoneId): Rect => {
    const r = byId[id];
    if (!r) throw new Error(`inukshukStones: missing stone ${id}`);
    return r;
  };
  return {
    'leg-left': get('leg-left'),
    'leg-right': get('leg-right'),
    torso: get('torso'),
    arm: get('arm'),
    head: get('head'),
  };
})();
