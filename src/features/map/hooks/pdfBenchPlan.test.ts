import { planSteps, type Bounds, type StepPlan } from './pdfBenchPlan';

// Beau Lake, ME (2024 US Topo) as the bench measured it on an iPhone 17
// (402 x 874 pt): the whole page, collar included, and its 7.5' map frame.
const PAGE: Bounds = {
  west: -69.15886706649916,
  south: 47.228982246585474,
  east: -68.96528533738623,
  north: 47.388060311329355,
};
const FRAME: Bounds = { west: -69.125, south: 47.25, east: -69.0, north: 47.375 };
const W = 402;
const H = 874;

const plan: StepPlan = {
  zoomOffsets: [1.4, 3, 4, 4.5, 5],
  jumpsPerZoom: 20,
  walk: false,
  jumps: true,
  seed: 23,
};

const inside = (b: Bounds, [lng, lat]: [number, number]) =>
  lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north;

describe('planSteps', () => {
  it('lands every jump inside the map frame, never in the blank collar (#637)', () => {
    const jumps = planSteps(plan, PAGE, W, H, FRAME).filter((s) => s.kind === 'jump');
    expect(jumps).toHaveLength(100);
    for (const s of jumps) expect(inside(FRAME, s.center)).toBe(true);
  });

  it('without the frame, jumps did land in the collar (the old behaviour)', () => {
    const jumps = planSteps(plan, PAGE, W, H).filter((s) => s.kind === 'jump');
    expect(jumps.some((s) => !inside(FRAME, s.center))).toBe(true);
  });

  it('keeps zoom levels relative to the whole page, so runs stay comparable', () => {
    const withFrame = planSteps(plan, PAGE, W, H, FRAME);
    const without = planSteps(plan, PAGE, W, H);
    expect(withFrame.map((s) => [s.name, s.zoom, s.level])).toEqual(
      without.map((s) => [s.name, s.zoom, s.level]),
    );
    const open = withFrame[0];
    expect(open?.kind).toBe('open');
    expect(open && inside(PAGE, open.center)).toBe(true);
  });

  it('keeps a whole view inside the frame when the frame is big enough', () => {
    // At the page fit + 1.4, half a view is narrower than half the frame.
    const [jump] = planSteps(
      { ...plan, zoomOffsets: [1.4], jumpsPerZoom: 1 },
      PAGE,
      W,
      H,
      FRAME,
    ).filter((s) => s.kind === 'jump');
    const world = 512 * 2 ** (jump?.zoom ?? 0);
    const halfLng = (W / world) * 180;
    expect(jump).toBeDefined();
    expect((jump?.center[0] ?? 0) - halfLng).toBeGreaterThanOrEqual(FRAME.west);
    expect((jump?.center[0] ?? 0) + halfLng).toBeLessThanOrEqual(FRAME.east);
  });

  it('falls back to the page when the frame does not overlap it', () => {
    const far: Bounds = { west: 10, south: 10, east: 11, north: 11 };
    const jumps = planSteps(plan, PAGE, W, H, far).filter((s) => s.kind === 'jump');
    for (const s of jumps) expect(inside(PAGE, s.center)).toBe(true);
  });
});
