/**
 * 3D pin labels (owner, #551): peaks, places and POIs as upright billboards
 * anchored at their real 3D position — a small dot on the ground, a thin
 * stem, and the name on a paper plate above. Pure placement: projection,
 * priority declutter by screen-space collision, fades (no popping), distance
 * attenuation, and occlusion by the terrain (a ray march against the
 * displayed heights). The native engines run the C++ twin every frame; the
 * platforms only draw the quads it returns.
 */
import { projectToNdc } from './camera';
import type { Mat4, Vec3 } from './mat4';

export type LabelKind = 'peak' | 'place' | 'poi' | 'water';

export interface LabelInput {
  id: number;
  /** World pixels at the camera zoom (x east, y south), wrap applied by the caller. */
  x: number;
  y: number;
  /** Ground height (m), absolute. */
  h: number;
  kind: LabelKind;
  /** Lower = more important (rank / min_zoom / class). */
  priority: number;
  /** Plate size in logical px at scale 1. */
  w: number;
  ph: number;
}

export interface LabelState {
  opacity: number;
  /** Last frame it was wanted visible (ms). */
  shownAt: number;
  /** Round 3: the current show/hide decision (with hysteresis). */
  shown?: boolean;
  /** When a shown pin first lost its place (ms); undefined while it has one. */
  blockedAt?: number;
}

export interface PlacedLabel {
  id: number;
  /** Anchor (ground) in NDC and its view depth (w). */
  ax: number;
  ay: number;
  depth: number;
  /** Plate centre in logical px (origin top-left). */
  cx: number;
  cy: number;
  /** Ground dot in logical px. */
  gx: number;
  gy: number;
  scale: number;
  opacity: number;
}

export interface PlaceOptions {
  P: Mat4;
  width: number;
  height: number;
  /** Camera-to-centre distance (px). */
  ctc: number;
  hRef: number;
  /** exaggeration × ramp */
  heightScale: number;
  /** Stem length in px at scale 1. */
  stemPx?: number;
  /** Extra clearance between plates (px). */
  padPx?: number;
  /** Fade time (ms) and frame delta (ms). */
  fadeMs?: number;
  dtMs: number;
  nowMs: number;
  /** Labels farther than this many ctc fade out. */
  fadeFromCtc?: number;
  fadeToCtc?: number;
  maxLabels?: number;
  /** True when the terrain hides the anchor (see {@link occludedByTerrain}). */
  occluded?: (l: LabelInput, eye: Vec3 | null) => boolean;
  eye?: Vec3 | null;
  /** Show/hide decision flips are added here (round 3 counter). */
  stats?: { toggles: number };
  /**
   * UI bands (px) a plate must stay clear of entirely: the search/status bar
   * at the top and the bottom bar. 0 = the plain screen edge.
   */
  topPx?: number;
  bottomPx?: number;
}

export const DEFAULT_STEM_PX = 26;
export const DEFAULT_PAD_PX = 4;
export const DEFAULT_FADE_MS = 220;
/** A shown pin stays shown this long after losing its place (collision, band, occlusion). */
export const LABEL_HOLD_MS = 350;
/** Ranking bonus of a shown pin: only a pin a full priority band better displaces it. */
export const LABEL_STICKY = 1;
/** A shown pin may sit this far (px) past the UI bands / screen edges before it counts as out. */
export const LABEL_EDGE_SLACK_PX = 8;

/** Distance attenuation of the plate size: full near, never below 60 %. */
export function labelScale(distance: number, ctc: number): number {
  if (!(distance > 0)) return 1;
  return Math.min(1, Math.max(0.6, (1.25 * ctc) / distance));
}

/** Screen rect of a plate (px) whose bottom-centre sits `stem` px above the ground point. */
export function plateRect(
  gx: number,
  gy: number,
  w: number,
  h: number,
  stem: number,
): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: gx - w / 2, x1: gx + w / 2, y1: gy - stem, y0: gy - stem - h };
}

export function rectsOverlap(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number },
  pad: number,
): boolean {
  return a.x0 - pad < b.x1 && b.x0 - pad < a.x1 && a.y0 - pad < b.y1 && b.y0 - pad < a.y1;
}

/** Step an opacity toward its target over `fadeMs`. */
export function stepOpacity(current: number, target: number, dtMs: number, fadeMs: number): number {
  if (fadeMs <= 0) return target;
  const step = Math.max(0, dtMs) / fadeMs;
  return current < target ? Math.min(target, current + step) : Math.max(target, current - step);
}

/**
 * Terrain occlusion: march the segment eye → anchor (lifted a little so a
 * label on a summit isn't hidden by the summit itself) and report whether
 * the displayed terrain rises above it anywhere. `terrainZ(x, y)` returns the
 * displayed z (m) of the ground at world px (x, y).
 */
export function occludedByTerrain(
  eye: Vec3,
  anchor: Vec3,
  terrainZ: (x: number, y: number) => number | null,
  steps = 24,
  clearanceM = 25,
): boolean {
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    // Skip the last few percent next to the anchor (its own slope).
    if (t > 0.97) break;
    const x = eye[0] + (anchor[0] - eye[0]) * t;
    const y = eye[1] + (anchor[1] - eye[1]) * t;
    const z = eye[2] + (anchor[2] + clearanceM - eye[2]) * t;
    const g = terrainZ(x, y);
    if (g !== null && g > z) return true;
  }
  return false;
}

/**
 * Place the labels for a frame. Deterministic given its inputs; `states`
 * carries the fades across frames (mutated: entries for labels seen this
 * frame are updated, unseen ones decay).
 */
export function placeLabels(
  inputs: readonly LabelInput[],
  states: Map<number, LabelState>,
  o: PlaceOptions,
): PlacedLabel[] {
  const stem = o.stemPx ?? DEFAULT_STEM_PX;
  const pad = o.padPx ?? DEFAULT_PAD_PX;
  const fadeMs = o.fadeMs ?? DEFAULT_FADE_MS;
  const fadeFrom = (o.fadeFromCtc ?? 7) * o.ctc;
  const fadeTo = (o.fadeToCtc ?? 10) * o.ctc;
  const maxLabels = o.maxLabels ?? 64;

  type Cand = {
    l: LabelInput;
    ndc: [number, number, number];
    w: number;
    gx: number;
    gy: number;
    scale: number;
    distFade: number;
  };
  const cands: Cand[] = [];
  for (const l of inputs) {
    const z = (l.h - o.hRef) * o.heightScale;
    const ndc = projectToNdc(o.P, l.x, l.y, z);
    if (!ndc) continue;
    if (Math.abs(ndc[0]) > 1.15 || ndc[1] < -1.15 || ndc[1] > 1.4) continue;
    // View depth for attenuation: w of the anchor.
    const P = o.P;
    const w = P[3]! * l.x + P[7]! * l.y + P[11]! * z + P[15]!;
    const scale = labelScale(w, o.ctc);
    const distFade = 1 - Math.min(Math.max((w - fadeFrom) / Math.max(fadeTo - fadeFrom, 1), 0), 1);
    if (distFade <= 0) continue;
    const gx = (ndc[0] * 0.5 + 0.5) * o.width;
    const gy = (0.5 - ndc[1] * 0.5) * o.height;
    cands.push({ l, ndc, w, gx, gy, scale, distFade });
  }
  // Stable ranking (round 3): priority, a shown pin's stickiness, then id —
  // never the camera distance, which changes every frame and made two
  // colliding pins of equal rank trade places while moving.
  const rank = (c: Cand) => c.l.priority - (states.get(c.l.id)?.shown ? LABEL_STICKY : 0);
  cands.sort((a, b) => rank(a) - rank(b) || a.l.id - b.l.id);

  const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const out: PlacedLabel[] = [];
  const seen = new Set<number>();
  for (const c of cands) {
    seen.add(c.l.id);
    const st = states.get(c.l.id) ?? { opacity: 0, shownAt: -Infinity };
    const r = plateRect(c.gx, c.gy, c.l.w * c.scale, c.l.ph * c.scale, stem * c.scale);
    const top = o.topPx ?? 0;
    const bottom = o.bottomPx ?? 0;
    const slack = st.shown ? LABEL_EDGE_SLACK_PX : 0;
    const clearTop = top > 0 ? r.y0 >= top - slack : r.y1 > 0;
    const clearBottom = bottom > 0 ? r.y1 <= o.height - bottom + slack : r.y0 < o.height;
    const onScreen = r.x1 > -slack && r.x0 < o.width + slack && clearTop && clearBottom;
    let fits = onScreen && taken.length < maxLabels && !taken.some((t) => rectsOverlap(r, t, pad));
    if (fits && o.occluded && o.occluded(c.l, o.eye ?? null)) fits = false;
    // Hysteresis: a shown pin keeps its place through a brief loss of it.
    let want = fits;
    if (fits) {
      st.blockedAt = undefined;
    } else if (st.shown && onScreen) {
      st.blockedAt ??= o.nowMs;
      want = o.nowMs - st.blockedAt < LABEL_HOLD_MS;
    }
    if (want !== (st.shown ?? false) && o.stats) o.stats.toggles++;
    st.shown = want;
    if (!want) st.blockedAt = undefined;
    if (want) {
      taken.push(r);
      st.shownAt = o.nowMs;
    }
    st.opacity = stepOpacity(st.opacity, want ? 1 : 0, o.dtMs, fadeMs);
    states.set(c.l.id, st);
    if (st.opacity > 0) {
      out.push({
        id: c.l.id,
        ax: c.ndc[0],
        ay: c.ndc[1],
        depth: c.w,
        cx: (r.x0 + r.x1) / 2,
        cy: (r.y0 + r.y1) / 2,
        gx: c.gx,
        gy: c.gy,
        scale: c.scale,
        opacity: st.opacity * c.distFade,
      });
    }
  }
  // Labels not in view this frame fade out (and are forgotten once gone).
  for (const [id, st] of states) {
    if (seen.has(id)) continue;
    if (st.shown && o.stats) o.stats.toggles++;
    st.shown = false;
    st.blockedAt = undefined;
    st.opacity = stepOpacity(st.opacity, 0, o.dtMs, fadeMs);
    if (st.opacity <= 0) states.delete(id);
  }
  // Far first so near plates draw on top.
  out.sort((a, b) => b.depth - a.depth);
  return out;
}

/** Priority of a summit: our tiles' banded rank (lower = more important), else by height. */
export function peakPriority(rank: number | null, ele: number | null): number {
  if (rank !== null && Number.isFinite(rank)) {
    const e = ele ?? 0;
    // The top of the ladder keeps finer steps (as peakSortKey in 2D).
    if (e >= 5000) return -15 - Math.floor(e / 1000);
    if (e >= 4000) return -Math.floor(e / 250);
    return rank;
  }
  return 12 - Math.floor((ele ?? 0) / 500) / 10;
}

/** Priority of a place: its `min_zoom` (cities first), towns ahead of villages on ties. */
export function placePriority(minZoom: number | null, kindDetail: string | null): number {
  const base = minZoom ?? 14;
  const bonus = kindDetail === 'city' ? -1 : kindDetail === 'town' ? -0.5 : 0;
  // Places sort with summits: a town (min_zoom ~8) beats a 2000 m peak (rank ~9).
  return base + bonus;
}

/** Priority of a POI (huts, passes…): after the places and the main summits. */
export function poiPriority(minZoom: number | null): number {
  return 14 + (minZoom ?? 15) / 10;
}
