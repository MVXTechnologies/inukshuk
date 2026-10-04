import { cameraToCenterDistance, centerPx, eyeFromProjection, projectionMatrix } from './camera';
import {
  labelScale,
  occludedByTerrain,
  peakPriority,
  placeLabels,
  placePriority,
  plateRect,
  poiPriority,
  rectsOverlap,
  stepOpacity,
  type LabelInput,
  type LabelState,
} from './labels';
import { pixelsPerMeter } from './mercator';
import { camera, PLACES } from './testUtils';

const cam = camera(PLACES.zermatt, 60, 0);
const P = projectionMatrix(cam);
const [cx, cy] = centerPx(cam);
const ctc = cameraToCenterDistance(cam.height);
const base = {
  P,
  width: cam.width,
  height: cam.height,
  ctc,
  hRef: 0,
  heightScale: 0,
  dtMs: 1000,
  nowMs: 0,
};
const lbl = (
  id: number,
  dx: number,
  dy: number,
  priority: number,
  w = 80,
  ph = 24,
): LabelInput => ({
  id,
  x: cx + dx,
  y: cy + dy,
  h: 0,
  kind: 'peak',
  priority,
  w,
  ph,
});

describe('geometry helpers', () => {
  it('plate rect sits above the ground point by the stem', () => {
    expect(plateRect(100, 200, 60, 20, 30)).toEqual({ x0: 70, x1: 130, y1: 170, y0: 150 });
  });
  it.each([
    [{ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 5, y0: 5, x1: 15, y1: 15 }, 0, true],
    [{ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 11, y0: 0, x1: 20, y1: 10 }, 0, false],
    [{ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 11, y0: 0, x1: 20, y1: 10 }, 2, true],
  ])('overlap %j %j pad %p → %p', (a, b, pad, yes) => {
    expect(rectsOverlap(a, b, pad)).toBe(yes);
  });
  it('scale: full up close, shrinks with distance, floors at 60 %', () => {
    expect(labelScale(ctc, ctc)).toBe(1);
    expect(labelScale(2 * ctc, ctc)).toBeCloseTo(0.625, 9);
    expect(labelScale(100 * ctc, ctc)).toBe(0.6);
    expect(labelScale(0, ctc)).toBe(1);
  });
  it('opacity steps toward its target at the fade rate', () => {
    expect(stepOpacity(0, 1, 110, 220)).toBeCloseTo(0.5, 9);
    expect(stepOpacity(0.5, 1, 1000, 220)).toBe(1);
    expect(stepOpacity(1, 0, 22, 220)).toBeCloseTo(0.9, 9);
    expect(stepOpacity(0.3, 1, 10, 0)).toBe(1);
  });
});

describe('placeLabels', () => {
  it('two labels in the same spot: the more important wins, the other is hidden', () => {
    const states = new Map<number, LabelState>();
    const out = placeLabels([lbl(1, 0, 0, 5), lbl(2, 3, 0, 1)], states, base);
    expect(out.map((p) => p.id)).toEqual([2]);
    expect(states.get(1)!.opacity).toBe(0);
  });
  it('labels far apart both show', () => {
    const out = placeLabels([lbl(1, -150, 0, 5), lbl(2, 150, 0, 1)], new Map(), base);
    expect(out.map((p) => p.id).sort()).toEqual([1, 2]);
  });
  it('fades in over frames instead of popping', () => {
    const states = new Map<number, LabelState>();
    const o = { ...base, dtMs: 55 };
    const a = placeLabels([lbl(1, 0, 0, 1)], states, o);
    expect(a[0]!.opacity).toBeCloseTo(0.25, 6);
    const b = placeLabels([lbl(1, 0, 0, 1)], states, o);
    expect(b[0]!.opacity).toBeCloseTo(0.5, 6);
  });
  it('a label that loses its spot fades out (stays drawn meanwhile)', () => {
    const states = new Map<number, LabelState>();
    placeLabels([lbl(1, 0, 0, 5)], states, base); // fully shown
    const o = { ...base, dtMs: 55 };
    const out = placeLabels([lbl(1, 0, 0, 5), lbl(2, 3, 0, 1)], states, o);
    const one = out.find((p) => p.id === 1)!;
    expect(one.opacity).toBeCloseTo(0.75, 6);
  });
  it('labels leaving the view fade and are forgotten', () => {
    const states = new Map<number, LabelState>();
    placeLabels([lbl(1, 0, 0, 1)], states, base);
    placeLabels([], states, { ...base, dtMs: 110 });
    expect(states.get(1)!.opacity).toBeCloseTo(0.5, 6);
    placeLabels([], states, base);
    expect(states.has(1)).toBe(false);
  });
  it('occluded labels are hidden', () => {
    const out = placeLabels([lbl(1, 0, 0, 1)], new Map(), { ...base, occluded: () => true });
    expect(out).toEqual([]);
  });
  it('anchors project where the camera puts them; nearer plates draw last', () => {
    const out = placeLabels([lbl(1, 0, -300, 1), lbl(2, 0, 200, 2)], new Map(), base);
    const centre = out.find((p) => p.id === 1)!;
    expect(out[out.length - 1]!.id).toBe(2); // nearer (south, toward the camera) last
    expect(centre.gy).toBeLessThan(out.find((p) => p.id === 2)!.gy);
  });
  it('raising a label (3D) lifts its anchor on screen', () => {
    const flat = placeLabels([lbl(1, 0, 0, 1)], new Map(), base)[0]!;
    const lifted = placeLabels([{ ...lbl(1, 0, 0, 1), h: 2000 }], new Map(), {
      ...base,
      heightScale: 1,
    })[0]!;
    expect(lifted.gy).toBeLessThan(flat.gy);
  });
  it('respects the label cap', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      lbl(i, (i % 8) * 120 - 420, Math.floor(i / 8) * 120 - 300, i, 20, 10),
    );
    const out = placeLabels(many, new Map(), { ...base, maxLabels: 5 });
    expect(out.length).toBeLessThanOrEqual(5);
  });
  it('is deterministic', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      lbl(i, ((i * 37) % 400) - 200, ((i * 53) % 400) - 200, i % 7),
    );
    const a = placeLabels(many, new Map(), base).map((p) => p.id);
    const b = placeLabels(many, new Map(), base).map((p) => p.id);
    expect(a).toEqual(b);
  });
  it('very distant labels fade with distance', () => {
    const far = placeLabels([lbl(1, 0, -9 * ctc, 1)], new Map(), {
      ...base,
      P: projectionMatrix(camera(PLACES.zermatt, 80, 0)),
    });
    for (const p of far) expect(p.opacity).toBeLessThan(1);
  });
});

describe('occlusion by terrain', () => {
  const eye = eyeFromProjection(P)!;
  const ppm = pixelsPerMeter(cam.lat, cam.zoom);
  it('a clear line of sight is not occluded', () => {
    expect(occludedByTerrain(eye, [cx, cy, 0], () => 0)).toBe(false);
  });
  it('a ridge between the eye and the anchor hides it', () => {
    // A wall 5 km tall halfway: everything there is higher than the sight line.
    const midX = (eye[0] + cx) / 2;
    const midY = (eye[1] + cy) / 2;
    const ridge = (x: number, y: number) =>
      Math.hypot(x - midX, y - midY) < 200 ? eye[2] + 1000 : 0;
    expect(occludedByTerrain(eye, [cx, cy, 0], ridge)).toBe(true);
    expect(ppm).toBeGreaterThan(0);
  });
  it('the anchor’s own slope does not hide it', () => {
    const own = (x: number, y: number) => (Math.hypot(x - cx, y - cy) < 5 ? 500 : 0);
    expect(occludedByTerrain(eye, [cx, cy, 0], own)).toBe(false);
  });
  it('unknown ground never occludes', () => {
    expect(occludedByTerrain(eye, [cx, cy, 0], () => null)).toBe(false);
  });
});

describe('priorities', () => {
  it('summits: the top of the ladder beats ranks; higher ranks win', () => {
    expect(peakPriority(5, 4478)).toBeLessThan(peakPriority(5, 3900));
    expect(peakPriority(6, 3000)).toBeLessThan(peakPriority(9, 2000));
    expect(peakPriority(null, 3000)).toBeLessThan(peakPriority(null, 1000));
  });
  it('places: cities first, then towns, then villages', () => {
    expect(placePriority(4, 'city')).toBeLessThan(placePriority(8, 'town'));
    expect(placePriority(10, 'town')).toBeLessThan(placePriority(10, 'village'));
    expect(placePriority(null, null)).toBe(14);
  });
  it('POIs come after places and main summits', () => {
    expect(poiPriority(14)).toBeGreaterThan(placePriority(12, 'village'));
    expect(poiPriority(null)).toBeGreaterThan(peakPriority(9, 2000));
  });
});

describe('placeLabels UI bands', () => {
  it('keeps plates out of the top and bottom bands', () => {
    // The base camera puts label (0,0) at the screen centre; a tall top band
    // covering it and a bottom band each hide it, no band shows it.
    const states = new Map<number, LabelState>();
    const shown = placeLabels([lbl(1, 0, 0, 5)], states, { ...base, dtMs: 1000 });
    expect(shown.length).toBe(1);
    const p = shown[0];
    if (!p) throw new Error('placed');
    const plateTop = p.cy - 11;
    const hidTop = placeLabels([lbl(1, 0, 0, 5)], new Map(), {
      ...base,
      dtMs: 1000,
      topPx: plateTop + 5,
    });
    expect(hidTop.length).toBe(0);
    const hidBottom = placeLabels([lbl(1, 0, 0, 5)], new Map(), {
      ...base,
      dtMs: 1000,
      bottomPx: base.height - p.cy,
    });
    expect(hidBottom.length).toBe(0);
    const clear = placeLabels([lbl(1, 0, 0, 5)], new Map(), {
      ...base,
      dtMs: 1000,
      topPx: 10,
      bottomPx: 10,
    });
    expect(clear.length).toBe(1);
  });
});
