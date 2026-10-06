import type { LngLat } from '@core/models';
import { rasterCropGeometry, type PdfCrop } from './pdfDetail';

/**
 * Rendering detail tiles in blocks.
 *
 * A detail tile is one cell of the dyadic page grid (`planPdfDetailTiles`).
 * Rendering each visible cell on its own costs one renderer call per cell,
 * and a renderer call has a large fixed cost that does not depend on the
 * crop's size: Android's `PdfRenderer` opens and parses the whole page each
 * time (~170 ms for a US Topo sheet on the emulator, against 3-25 ms to
 * paint a 480 px tile), and pdf.js walks every operator of the page on each
 * paint. A 15-tile view paid that 15 times.
 *
 * A block is a rectangle of cells of the same level rendered as ONE crop at
 * the same scale the cells would have had (so the same pixels per page
 * point: no quality change), and shown as one image. The cells the camera
 * still needs are grouped into as few blocks as the renderer's crop limits
 * allow (3072 px per edge, 3 Mi px).
 *
 * One geometric constraint: MapLibre draws an image as two triangles split
 * along its top-right/bottom-left diagonal, and the page overview is placed
 * the same way, so the page's own mapping is affine on each side of its
 * diagonal u + v = 1. A block lying on one side is affine and exact. A block
 * crossing it would be drawn with the wrong split; that is accepted only
 * where the resulting misplacement stays under `diagonalTolerancePx` raster
 * pixels (true for the near-parallelogram sheets real maps are), otherwise
 * the block is split further. Single cells are always exact (#287 geometry).
 */

/** A rectangle of grid cells `[x, x + cols) x [y, y + rows)` at one level. */
export interface CellRect {
  x: number;
  y: number;
  cols: number;
  rows: number;
}

export interface DetailBlock extends CellRect {
  divisions: number;
  /** Raster width of ONE cell; the block's raster is `cols` times as wide. */
  cellWidthPx: number;
  crop: PdfCrop;
  /** The block's raster width (what the renderer is asked for). */
  targetWidthPx: number;
  /** MapLibre ImageSource order: top-left, top-right, bottom-right, bottom-left. */
  coordinates: [LngLat, LngLat, LngLat, LngLat];
}

export interface PlanBlocksInput {
  /** The rendered page box's corners (the overview's coordinates). */
  corners: [LngLat, LngLat, LngLat, LngLat];
  page: { width: number; height: number };
  divisions: number;
  cellWidthPx: number;
  /** Cells to render. Duplicates are ignored. */
  cells: readonly { x: number; y: number }[];
  /** Cell-space point the blocks are ordered around (nearest first); default the cells' centre. */
  focus?: { x: number; y: number };
  maxEdgePx?: number;
  maxPixels?: number;
  diagonalTolerancePx?: number;
}

const project = ([lng, lat]: LngLat): LngLat => [
  (lng * Math.PI) / 180,
  Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
];
const unproject = ([x, y]: LngLat): LngLat => [
  (x * 180) / Math.PI,
  ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI,
];

/**
 * The page's own placement, in Mercator: unit page coordinates (u right,
 * v down) to projected metres-ish, affine on each side of u + v = 1. The
 * planner's tile corners are this mapping, unprojected.
 */
export function pageToMercator(corners: [LngLat, LngLat, LngLat, LngLat]) {
  const [tl, tr, br, bl] = corners.map(project) as [LngLat, LngLat, LngLat, LngLat];
  const ax = tr[0] - tl[0],
    ay = tr[1] - tl[1],
    bx = bl[0] - tl[0],
    by = bl[1] - tl[1];
  const rx = br[0] - tr[0] - bl[0] + tl[0],
    ry = br[1] - tr[1] - bl[1] + tl[1];
  return (u: number, v: number): LngLat => {
    const diagonal = Math.max(0, u + v - 1);
    return [tl[0] + ax * u + bx * v + rx * diagonal, tl[1] + ay * u + by * v + ry * diagonal];
  };
}

/** Where MapLibre puts block-local point (s, t) of an image with these Mercator corners. */
function imagePoint(c: [LngLat, LngLat, LngLat, LngLat], s: number, t: number): LngLat {
  const [tl, tr, br, bl] = c;
  // Two triangles split along TR-BL: (TL, TR, BL) for s + t <= 1, else (TR, BR, BL).
  if (s + t <= 1) {
    return [
      tl[0] + s * (tr[0] - tl[0]) + t * (bl[0] - tl[0]),
      tl[1] + s * (tr[1] - tl[1]) + t * (bl[1] - tl[1]),
    ];
  }
  const a = 1 - t,
    b = 1 - s;
  return [
    br[0] + a * (tr[0] - br[0]) + b * (bl[0] - br[0]),
    br[1] + a * (tr[1] - br[1]) + b * (bl[1] - br[1]),
  ];
}

/**
 * Largest misplacement, in raster pixels of a block drawn at `cellWidthPx`
 * per cell, between where MapLibre would draw the block's content and where
 * the page mapping puts it. Zero for a block on one side of the diagonal.
 */
export function blockDiagonalErrorPx(
  corners: [LngLat, LngLat, LngLat, LngLat],
  divisions: number,
  cellWidthPx: number,
  rect: CellRect,
): number {
  const u0 = rect.x / divisions,
    v0 = rect.y / divisions,
    u1 = (rect.x + rect.cols) / divisions,
    v1 = (rect.y + rect.rows) / divisions;
  if (u1 + v1 <= 1 || u0 + v0 >= 1) return 0;
  const map = pageToMercator(corners);
  const quad: [LngLat, LngLat, LngLat, LngLat] = [
    map(u0, v0),
    map(u1, v0),
    map(u1, v1),
    map(u0, v1),
  ];
  // Mercator units per raster pixel along the block's top edge.
  const top = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]);
  const perPx = top / (rect.cols * cellWidthPx);
  if (!(perPx > 0)) return Infinity;
  let worst = 0;
  const n = 16;
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++) {
      const s = i / n,
        t = j / n;
      const want = map(u0 + s * (u1 - u0), v0 + t * (v1 - v0));
      const got = imagePoint(quad, s, t);
      worst = Math.max(worst, Math.hypot(want[0] - got[0], want[1] - got[1]) / perPx);
    }
  return worst;
}

/** Raster size of a block, exactly as the renderer will size it. */
function blockRaster(
  page: { width: number; height: number },
  divisions: number,
  cellWidthPx: number,
  r: CellRect,
) {
  const crop = {
    x0: r.x / divisions,
    y0: r.y / divisions,
    x1: (r.x + r.cols) / divisions,
    y1: (r.y + r.rows) / divisions,
  };
  return { crop, targetWidthPx: r.cols * cellWidthPx };
}

/**
 * Group `cells` into blocks, each rendered at exactly the cells' own scale.
 * Every input cell is in exactly one block; a block may include cells that
 * were not asked for only where they fall inside the bounding rectangle of
 * asked-for cells (never outside it). Nearest-to-focus first.
 */
export function planDetailBlocks(input: PlanBlocksInput): DetailBlock[] {
  const {
    corners,
    page,
    divisions,
    cellWidthPx,
    maxEdgePx = 3072,
    maxPixels = 3 * 1024 * 1024,
    diagonalTolerancePx = 0.25,
  } = input;
  if (!(divisions >= 1) || !(cellWidthPx >= 1) || !(page.width > 0) || !(page.height > 0))
    return [];
  const wanted = new Set<string>();
  const list: { x: number; y: number }[] = [];
  for (const c of input.cells) {
    if (!Number.isInteger(c.x) || !Number.isInteger(c.y)) continue;
    if (c.x < 0 || c.y < 0 || c.x >= divisions || c.y >= divisions) continue;
    const k = `${c.x}:${c.y}`;
    if (wanted.has(k)) continue;
    wanted.add(k);
    list.push(c);
  }
  if (list.length === 0) return [];

  // A cell at this scale; a block's raster is cols x rows of these (the
  // renderer floors each edge, so a block is never larger than this bound).
  const cellGeometry = rasterCropGeometry(page.width, page.height, cellWidthPx, {
    x0: 0,
    y0: 0,
    x1: 1 / divisions,
    y1: 1 / divisions,
  });
  const scale = cellGeometry.scale;
  const cellW = (page.width / divisions) * scale;
  const cellH = (page.height / divisions) * scale;

  const fits = (r: CellRect) => {
    const w = Math.ceil(r.cols * cellW),
      h = Math.ceil(r.rows * cellH);
    if (w > maxEdgePx || h > maxEdgePx || w * h > maxPixels) return false;
    // The renderer must draw it at the cells' scale, not shrink it.
    const { crop, targetWidthPx } = blockRaster(page, divisions, cellWidthPx, r);
    const g = rasterCropGeometry(page.width, page.height, targetWidthPx, crop);
    return Math.abs(g.scale - scale) <= scale * 1e-9;
  };
  const bound = (cells: { x: number; y: number }[]): CellRect => {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const c of cells) {
      x0 = Math.min(x0, c.x);
      y0 = Math.min(y0, c.y);
      x1 = Math.max(x1, c.x);
      y1 = Math.max(y1, c.y);
    }
    return { x: x0, y: y0, cols: x1 - x0 + 1, rows: y1 - y0 + 1 };
  };

  const out: CellRect[] = [];
  const split = (cells: { x: number; y: number }[]) => {
    const r = bound(cells);
    if (
      (r.cols === 1 && r.rows === 1) ||
      (fits(r) && blockDiagonalErrorPx(corners, divisions, cellWidthPx, r) <= diagonalTolerancePx)
    ) {
      out.push(r);
      return;
    }
    // Cut at a cell boundary. Where the cells fill their rectangle the cut
    // halves the longer raster edge; where they do not (a ring of
    // neighbours around a view already drawn), the cut that leaves the least
    // area to render wins, so a block rarely repaints cells it did not need.
    const cuts: [{ x: number; y: number }[], { x: number; y: number }[]][] = [];
    for (let k = 1; k < r.cols; k++) {
      const mid = r.x + k;
      cuts.push([cells.filter((c) => c.x < mid), cells.filter((c) => c.x >= mid)]);
    }
    for (let k = 1; k < r.rows; k++) {
      const mid = r.y + k;
      cuts.push([cells.filter((c) => c.y < mid), cells.filter((c) => c.y >= mid)]);
    }
    const areaOf = (part: { x: number; y: number }[]) => {
      if (part.length === 0) return 0;
      const b = bound(part);
      return b.cols * cellW * b.rows * cellH;
    };
    const halves = (part: [unknown[], unknown[]]) => Math.abs(part[0].length - part[1].length);
    let best: [{ x: number; y: number }[], { x: number; y: number }[]] | null = null;
    let bestArea = Infinity;
    let bestBalance = Infinity;
    for (const cut of cuts) {
      if (cut[0].length === 0 || cut[1].length === 0) continue;
      const a = Math.round(areaOf(cut[0]) + areaOf(cut[1]));
      const balance = halves(cut);
      if (a < bestArea || (a === bestArea && balance < bestBalance)) {
        best = cut;
        bestArea = a;
        bestBalance = balance;
      }
    }
    if (!best) {
      out.push(r);
      return;
    }
    split(best[0]);
    split(best[1]);
  };
  split(list);

  const focus =
    input.focus ??
    (() => {
      const b = bound(list);
      return { x: b.x + b.cols / 2, y: b.y + b.rows / 2 };
    })();
  const map = pageToMercator(corners);
  const geo = (u: number, v: number) => unproject(map(u, v));
  const blocks = out.map((r): DetailBlock => {
    const { crop, targetWidthPx } = blockRaster(page, divisions, cellWidthPx, r);
    return {
      ...r,
      divisions,
      cellWidthPx,
      crop,
      targetWidthPx,
      coordinates: [
        geo(crop.x0, crop.y0),
        geo(crop.x1, crop.y0),
        geo(crop.x1, crop.y1),
        geo(crop.x0, crop.y1),
      ],
    };
  });
  const distance = (b: CellRect) => {
    // Distance from the focus to the nearest point of the block.
    const dx = Math.max(b.x - focus.x, 0, focus.x - (b.x + b.cols));
    const dy = Math.max(b.y - focus.y, 0, focus.y - (b.y + b.rows));
    return dx * dx + dy * dy;
  };
  blocks.sort((a, b) => distance(a) - distance(b) || b.cols * b.rows - a.cols * a.rows);
  return blocks;
}
