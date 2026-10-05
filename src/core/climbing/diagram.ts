/**
 * The topo viewer's two pictures of a sector (DESIGN §4.2, mockups 03 / 03b):
 *
 * - the WALL DIAGRAM, only for a sector whose left-to-right order is known
 *   (OSM route starts): one vertical line per route, height ∝ length (min
 *   8 m), colour = grade band, dashed = trad, dots = bolts, numbers along the
 *   base matching the list. Generated, not to scale — never a photo, never a
 *   guessed wall;
 * - the GRADE CHART otherwise: how many routes at each grade.
 *
 * Pure geometry for an SVG; the screen only draws it.
 */
import type { CragRoute } from './detail';
import type { Band, GradeKind, GradeSystem } from './grades';
import { bandOf, gradeLabel } from './grades';

export const DIAGRAM_MIN_LENGTH_M = 8;
export const DIAGRAM_MAX_FIT = 14;

export interface DiagramLine {
  /** 1-based number on the base, as in the list. */
  n: number;
  x: number;
  topY: number;
  band: Band | null;
  dashed: boolean;
  /** Bolt dots' y positions (bottom to top). */
  bolts: number[];
  /** Length unknown: drawn at the sector's typical length. */
  guessedLength: boolean;
}

export interface WallDiagram {
  width: number;
  height: number;
  baseY: number;
  /** Wider than the frame: the view scrolls sideways. */
  scrolls: boolean;
  lines: DiagramLine[];
  /** The wall's silhouette behind the lines: polygon points. */
  ridge: [number, number][];
}

export interface DiagramFrame {
  /** Visible width; the diagram grows past it beyond DIAGRAM_MAX_FIT routes. */
  width: number;
  height: number;
  /** Space under the base line for the number discs. */
  footer?: number;
  /** Column width once the diagram scrolls. */
  column?: number;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? null;
}

export function wallDiagram(routes: readonly CragRoute[], frame: DiagramFrame): WallDiagram {
  const footer = frame.footer ?? 34;
  const column = frame.column ?? 30;
  const n = routes.length;
  const scrolls = n > DIAGRAM_MAX_FIT;
  const width = scrolls ? column * n + column : frame.width;
  const baseY = frame.height - footer;
  const topPad = 22;
  const usable = baseY - topPad;
  const known = routes.flatMap((r) => (r.lengthM !== undefined ? [r.lengthM] : []));
  const typical = Math.max(median(known) ?? 15, DIAGRAM_MIN_LENGTH_M);
  const longest = Math.max(typical, ...known, DIAGRAM_MIN_LENGTH_M);
  const step = width / (n + 1);
  const lines = routes.map((r, i): DiagramLine => {
    const length = Math.max(r.lengthM ?? typical, DIAGRAM_MIN_LENGTH_M);
    const h = (length / longest) * usable;
    const topY = baseY - h;
    const bolted = (r.bolts ?? 0) > 0 || r.styles.includes('sport');
    const count = Math.min(r.bolts ?? (bolted ? Math.round(length / 3) : 0), 24);
    const bolts = Array.from({ length: count }, (_, j) => baseY - ((j + 1) / (count + 1)) * h);
    return {
      n: i + 1,
      x: step * (i + 1),
      topY,
      band: r.k !== undefined && r.x !== undefined ? bandOf(r.k, r.x) : null,
      dashed: !bolted && r.styles.includes('trad'),
      bolts,
      guessedLength: r.lengthM === undefined,
    };
  });
  const ridge: [number, number][] = [[0, baseY]];
  ridge.push([0, Math.min(baseY, (lines[0]?.topY ?? baseY) + 10)]);
  for (const l of lines) ridge.push([l.x, Math.max(topPad - 6, l.topY - 12)]);
  ridge.push([width, Math.min(baseY, (lines[lines.length - 1]?.topY ?? baseY) + 10)]);
  ridge.push([width, baseY]);
  return { width, height: frame.height, baseY, scrolls, lines, ridge };
}

export interface ChartBin {
  label: string;
  count: number;
  band: Band;
}

export interface GradeChart {
  kind: GradeKind;
  bins: ChartBin[];
  /** Routes with no grade we can place. */
  ungraded: number;
}

/** The bin a ladder index falls in: "5.10" for 5.10a–d, "6b" for 6b/6b+, "V3", "WI4". */
function binLabel(kind: GradeKind, x: number, system: GradeSystem): string | null {
  const label = gradeLabel(kind, x, system);
  if (label === null) return null;
  if (kind === 'r') return system === 'yds' ? label.replace(/[abcd]$/, '') : label.replace('+', '');
  if (kind === 'b' && system === 'french') return label.replace('+', '');
  return label;
}

/** Routes per grade bin in the sector's main discipline, easiest first. */
export function gradeChart(routes: readonly CragRoute[], system: GradeSystem): GradeChart | null {
  const byKind: Record<GradeKind, number> = { r: 0, b: 0, i: 0 };
  for (const r of routes) if (r.k !== undefined) byKind[r.k] += 1;
  const kind = (Object.entries(byKind) as [GradeKind, number][]).sort((a, b) => b[1] - a[1])[0];
  if (kind === undefined || kind[1] === 0) return null;
  const k = kind[0];
  const bins = new Map<string, { count: number; x: number }>();
  let ungraded = 0;
  for (const r of routes) {
    if (r.k !== k || r.x === undefined) {
      ungraded += 1;
      continue;
    }
    const label = binLabel(k, r.x, system);
    if (label === null) {
      ungraded += 1;
      continue;
    }
    const bin = bins.get(label);
    if (bin) {
      bin.count += 1;
      bin.x = Math.min(bin.x, r.x);
    } else {
      bins.set(label, { count: 1, x: r.x });
    }
  }
  return {
    kind: k,
    bins: [...bins.entries()]
      .sort((a, b) => a[1].x - b[1].x)
      .map(([label, b]) => ({ label, count: b.count, band: bandOf(k, b.x) })),
    ungraded,
  };
}
