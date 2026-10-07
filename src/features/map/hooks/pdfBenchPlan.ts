/**
 * The PDF benchmark's camera script (see `usePdfBench`): which views it
 * opens, at which zooms. Pure, so it is unit-tested.
 */
export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface Step {
  name: string;
  zoom: number;
  center: [number, number];
  /** Zoom above the whole-sheet fit. */
  level: number;
  kind: 'open' | 'jump' | 'walk';
}

/** The plan fields the camera script reads. */
export interface StepPlan {
  zoomOffsets: number[];
  jumpsPerZoom: number;
  walk: boolean;
  jumps: boolean;
  seed: number;
}

const MAX_ZOOM = 18;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const unMercY = (y: number) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

/** Zoom at which `b` fits a `w` x `h` (CSS px) map, MapLibre's 512 px world. */
function fitZoom(b: Bounds, w: number, h: number): number {
  const zw = Math.log2((w * 360) / (512 * (b.east - b.west)));
  const zh = Math.log2((h * 2 * Math.PI) / (512 * (mercY(b.north) - mercY(b.south))));
  return Math.min(zw, zh) - 0.15;
}

/** Span of the view at `zoom`, in degrees of longitude and mercator radians. */
function viewSpan(zoom: number, w: number, h: number): { dLng: number; dY: number } {
  const world = 512 * 2 ** zoom;
  return { dLng: (w / world) * 360, dY: (h / world) * 2 * Math.PI };
}

/** The overlap of two boxes, or null when they do not overlap. */
function intersect(a: Bounds, b: Bounds): Bounds | null {
  const out = {
    west: Math.max(a.west, b.west),
    south: Math.max(a.south, b.south),
    east: Math.min(a.east, b.east),
    north: Math.min(a.north, b.north),
  };
  return out.west < out.east && out.south < out.north ? out : null;
}

/**
 * The camera script for one sheet. Zoom levels are relative to fitting the
 * whole page (`sheet`), but jump centres are drawn inside the map frame
 * (`frame`, the georeferenced neatline), never in the collar around it. The
 * collar (title block, legend, margins) is blank paper at deep zoom, so a
 * jump there timed and photographed an empty view (#637).
 */
export function planSteps(
  plan: StepPlan,
  sheet: Bounds,
  w: number,
  h: number,
  frame: Bounds = sheet,
): Step[] {
  const fit = fitZoom(sheet, w, h);
  const cLng = (sheet.west + sheet.east) / 2;
  const cY = (mercY(sheet.south) + mercY(sheet.north)) / 2;
  const center: [number, number] = [cLng, unMercY(cY)];
  const steps: Step[] = [{ name: 'open-fit', zoom: fit, center, level: 0, kind: 'open' }];
  const random = rng(plan.seed);
  const area = intersect(frame, sheet) ?? sheet;
  if (plan.jumps) {
    for (const offset of plan.zoomOffsets) {
      const zoom = Math.min(MAX_ZOOM, fit + offset);
      const level = Math.round((zoom - fit) * 10) / 10;
      const span = viewSpan(zoom, w, h);
      for (let i = 0; i < plan.jumpsPerZoom; i++) {
        // A view centre inside the map frame, at least half a view from its
        // edge when the frame is big enough (else the frame centre).
        const padLng = Math.min(span.dLng / 2, (area.east - area.west) / 2);
        const padY = Math.min(span.dY / 2, (mercY(area.north) - mercY(area.south)) / 2);
        const lng = area.west + padLng + random() * Math.max(0, area.east - area.west - 2 * padLng);
        const y =
          mercY(area.south) +
          padY +
          random() * Math.max(0, mercY(area.north) - mercY(area.south) - 2 * padY);
        steps.push({
          name: `jump-z+${level}-${i}`,
          zoom,
          center: [lng, unMercY(y)],
          level,
          kind: 'jump',
        });
      }
    }
  }
  if (plan.walk) {
    const at = (name: string, offset: number, dx = 0, dy = 0): Step => {
      const zoom = Math.min(MAX_ZOOM, fit + offset);
      const span = viewSpan(zoom, w, h);
      return {
        name,
        zoom,
        center: [center[0] + dx * span.dLng, unMercY(cY + dy * span.dY)],
        level: Math.round((zoom - fit) * 10) / 10,
        kind: 'walk',
      };
    };
    // A person's session: zoom in a level at a time, look around, zoom
    // deeper, come back out. Pans move one view, so the ring was planned for them.
    let x = 0;
    let y = 0;
    steps.push(at('walk-fit', 0));
    steps.push(at('walk-z+1', 1));
    steps.push(at('walk-z+2', 2));
    steps.push(at('walk-z+3', 3));
    steps.push(at('walk-z+3-panE', 3, (x += 1), y));
    steps.push(at('walk-z+3-panS', 3, x, (y -= 1)));
    steps.push(at('walk-z+3-panW', 3, (x -= 1), y));
    steps.push(at('walk-z+4', 4, x / 2, y / 2));
    steps.push(at('walk-z+5', 5, x / 4, y / 4));
    steps.push(at('walk-z+5-panN', 5, x / 4, y / 4 + 1));
    steps.push(at('walk-z+6', 6, x / 8, y / 8 + 0.5));
    steps.push(at('walk-out-z+4', 4, 0, 0));
    steps.push(at('walk-out-z+2', 2, 0, 0));
    steps.push(at('walk-out-fit', 0, 0, 0));
  }
  return steps;
}
