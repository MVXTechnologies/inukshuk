/**
 * The team-drawing layers' style (#683): a fixed six layers on the one
 * `team-draw` source that `drawFeatures` fills, however many shapes there are.
 *
 * - `fill` — circles and rectangles at 14 % of their colour;
 * - `casing` — a halo under every line (the selected shape's is the wide
 *   selection colour), then `line` (solid) and `dash` (dashed:
 *   `line-dasharray` is not data-driven in MapLibre Native, hence its own layer);
 * - `head` — arrowheads and compact pointers, SDF sprites tinted with
 *   `icon-color` and turned with the map (`icon-rotation-alignment: map`);
 * - `sym` — author badges, the pen tip, notes and collapsed notes, upright.
 *   Rotation alignment is a layout property that cannot vary per feature, so
 *   upright labels and map-turned heads cannot share one layer.
 *
 * No `["zoom"]` anywhere (the compact-pointer switch is decided in the
 * features, on camera idle) and the sort key is the recency band (0–5).
 * PURE: plain style objects, no React Native.
 */
export const DRAW_SOURCE = 'team-draw';
export const DRAW_LAYERS = {
  fill: 'team-draw-fill',
  casing: 'team-draw-casing',
  line: 'team-draw-line',
  dash: 'team-draw-dash',
  head: 'team-draw-head',
  sym: 'team-draw-sym',
} as const;
/** The layers a tap is tested against. */
export const DRAW_TAP_LAYERS = [
  DRAW_LAYERS.fill,
  DRAW_LAYERS.line,
  DRAW_LAYERS.dash,
  DRAW_LAYERS.head,
  DRAW_LAYERS.sym,
];

/** Sprite density (px per dp) of `assets/map/draw` (scripts/map/build-draw-icons.mjs). */
export const DRAW_SPRITE_DENSITY = 2;
/** The head sprites are drawn at the L size (30 dp); S and M are 16 and 22 dp. */
export const HEAD_DP = { 1: 16, 2: 22, 3: 30 } as const;
export const LINE_DP = { 1: 3, 2: 5, 3: 8 } as const;
export const CASING_DP = 4;
export const SELECTED_CASING_DP = 14;
export const FILL_OPACITY = 0.14;

export interface DrawColors {
  /** The halo round lines, heads and badges (the map's paper). */
  halo: string;
  /** The selected shape's wide halo. */
  selection: string;
  /** A note's ink. */
  ink: string;
  /** Text on a badge or the pen tip (on the author's colour). */
  onBadge: string;
}

type Expr = unknown[];
const k = ['get', 'k'];
const width: Expr = ['match', ['get', 'w'], 1, LINE_DP[1], 2, LINE_DP[2], LINE_DP[3]];
const dashed: Expr = ['coalesce', ['get', 'd'], false];
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const headSize = (s: 1 | 2 | 3) => round3(HEAD_DP[s] / HEAD_DP[3] / DRAW_SPRITE_DENSITY);

export interface LayerStyle {
  filter: Expr;
  layout?: Record<string, unknown>;
  paint: Record<string, unknown>;
}

/** Every layer's filter, layout and paint, for the selected shape (`owner:id`) and the label font. */
export function drawLayerStyles(
  c: DrawColors,
  selected: string | null,
  font: string[],
): Record<keyof typeof DRAW_LAYERS, LayerStyle> {
  const isSelected: Expr = ['==', ['get', 'drw'], selected ?? ''];
  const lineLayout = { 'line-join': 'round', 'line-cap': 'round' };
  return {
    fill: {
      filter: ['==', k, 'fill'],
      paint: {
        'fill-color': ['get', 'c'],
        'fill-opacity': ['*', FILL_OPACITY, ['get', 'op']],
      },
    },
    casing: {
      filter: ['==', k, 'line'],
      layout: lineLayout,
      paint: {
        'line-color': ['case', isSelected, c.selection, c.halo],
        'line-width': ['+', width, ['case', isSelected, SELECTED_CASING_DP, CASING_DP]],
        'line-opacity': ['get', 'op'],
      },
    },
    line: {
      filter: ['all', ['==', k, 'line'], ['!', dashed]],
      layout: lineLayout,
      paint: { 'line-color': ['get', 'c'], 'line-width': width, 'line-opacity': ['get', 'op'] },
    },
    dash: {
      filter: ['all', ['==', k, 'line'], dashed],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'c'],
        'line-width': width,
        'line-opacity': ['get', 'op'],
        'line-dasharray': [2.2, 1.8],
      },
    },
    head: {
      filter: ['match', k, ['head', 'pointer'], true, false],
      layout: {
        'icon-image': ['match', k, 'pointer', 'draw-pointer', ['concat', 'draw-', ['get', 'icon']]],
        'icon-rotate': ['coalesce', ['get', 'rot'], 0],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-anchor': ['match', k, 'head', 'top', 'center'],
        'icon-size': [
          'match',
          k,
          'pointer',
          round3(1 / DRAW_SPRITE_DENSITY),
          ['match', ['get', 's'], 1, headSize(1), 2, headSize(2), headSize(3)],
        ],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['get', 'z'],
      },
      paint: {
        'icon-color': ['get', 'c'],
        'icon-opacity': ['get', 'op'],
        'icon-halo-color': c.halo,
        'icon-halo-width': 1.5,
      },
    },
    sym: {
      filter: ['match', k, ['badge', 'tip', 'note', 'noteGlyph'], true, false],
      layout: {
        'icon-image': ['match', k, 'note', '', 'draw-pill'],
        'icon-text-fit': 'both',
        'icon-text-fit-padding': [3, 7, 3, 7],
        'text-field': ['match', k, 'noteGlyph', '…', ['coalesce', ['get', 't'], '']],
        'text-font': font,
        'text-size': ['match', k, 'note', 12.5, 'tip', 12, 11],
        'text-offset': [
          'match',
          k,
          'note',
          ['literal', [0, 1.7]],
          'noteGlyph',
          ['literal', [0, -1.8]],
          ['literal', [0, 0]],
        ],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['get', 'z'],
      },
      paint: {
        'icon-color': ['get', 'c'],
        'icon-opacity': ['get', 'op'],
        'icon-halo-color': ['match', k, 'tip', ['get', 'c'], c.halo],
        'icon-halo-width': ['match', k, 'tip', 3, 1.5],
        'text-color': ['match', k, 'note', c.ink, c.onBadge],
        'text-opacity': ['get', 'op'],
        'text-halo-color': c.halo,
        'text-halo-width': ['match', k, 'note', 2, 0],
      },
    },
  };
}
