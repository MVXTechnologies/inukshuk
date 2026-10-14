import { bearingDeg, haversineM, type Pt } from './geo';
import { penStyle, defaultPrefs } from './style';
import {
  buildStroke,
  cardinal16,
  chipText,
  frameCamera,
  fromWorld,
  gestureLengthDp,
  MAX_ZOOM,
  MIN_STROKE_DP,
  pinchCamera,
  project,
  startPinch,
  menuSide,
  screenSpan,
  StrokeBuilder,
  toWorld,
  unproject,
  type ScreenPt,
  type Viewport,
} from './screen';
import { QC } from './testUtils';

const VIEW: Viewport = { center: QC, zoom: 15, bearing: 0, width: 400, height: 800 };
const style = penStyle(defaultPrefs(1));
const close = (a: readonly number[], b: readonly number[], eps = 1e-6) =>
  a.every((v, i) => Math.abs(v - b[i]!) < eps);

describe('projection', () => {
  it('round-trips world pixels and wraps longitudes', () => {
    const w = toWorld(QC, 12);
    expect(close(fromWorld(w, 12), QC)).toBe(true);
    expect(fromWorld([0, 0], 0)[0]).toBeCloseTo(-180);
    expect(fromWorld([512 * 1.25, 256], 0)[0]).toBeCloseTo(-90);
    expect(fromWorld([512 * 1.5, 256], 0)[0]).toBeCloseTo(0);
    // Beyond Mercator's edge the latitude is clamped.
    expect(toWorld([0, 89], 0)[1]).toBeCloseTo(toWorld([0, 85.051129], 0)[1]);
  });

  it('puts the centre in the middle, north up, and back again', () => {
    expect(close(project(QC, VIEW), [200, 400])).toBe(true);
    const north = project([QC[0], QC[1] + 0.001], VIEW);
    expect(north[1]).toBeLessThan(400);
    expect(north[0]).toBeCloseTo(200);
    const p: ScreenPt = [123, 456];
    expect(close(project(unproject(p, VIEW), VIEW), p, 1e-6)).toBe(true);
  });

  it('turns with the bearing: east is up when the map heads east', () => {
    const v = { ...VIEW, bearing: 90 };
    const east = project([QC[0] + 0.001, QC[1]], v);
    expect(east[1]).toBeLessThan(400);
    expect(east[0]).toBeCloseTo(200);
    const p: ScreenPt = [30, 700];
    expect(close(project(unproject(p, v), v), p, 1e-6)).toBe(true);
  });

  it('is antimeridian-safe', () => {
    const v = { ...VIEW, center: [179.9999, 0] as Pt };
    const across = project([-179.9999, 0], v);
    expect(across[0]).toBeGreaterThan(200);
    expect(across[0]).toBeLessThan(260);
  });
});

describe('two fingers', () => {
  it('pans: the point under the fingers follows them', () => {
    const p = startPinch([100, 400], [300, 400], VIEW);
    const cam = pinchCamera(p, [150, 450], [350, 450]);
    expect(cam.zoom).toBeCloseTo(15);
    expect(cam.bearing).toBeCloseTo(0);
    const after = { ...VIEW, ...cam };
    expect(close(project(p.anchor, after), [250, 450], 1e-6)).toBe(true);
  });

  it('zooms by the spread, clamped', () => {
    const p = startPinch([150, 400], [250, 400], VIEW);
    expect(pinchCamera(p, [100, 400], [300, 400]).zoom).toBeCloseTo(16);
    expect(pinchCamera(p, [175, 400], [225, 400]).zoom).toBeCloseTo(14);
    expect(pinchCamera(p, [0, 400], [400 * 1000, 400]).zoom).toBe(MAX_ZOOM);
    // Fingers on the same spot never divide by zero.
    const same = startPinch([200, 400], [200, 400], VIEW);
    expect(Number.isFinite(pinchCamera(same, [200, 400], [200, 400]).zoom)).toBe(true);
  });

  it('rotates with the fingers: turned clockwise, the bearing goes down', () => {
    const p = startPinch([100, 400], [300, 400], VIEW);
    const cam = pinchCamera(p, [200, 300], [200, 500]);
    expect(cam.bearing).toBeCloseTo(270);
    const after = { ...VIEW, ...cam };
    expect(close(project(p.anchor, after), [200, 400], 1e-6)).toBe(true);
  });
});

describe('what a gesture becomes', () => {
  const line: ScreenPt[] = [
    [100, 400],
    [110, 400],
    [120, 410],
    [200, 300],
  ];

  it('measures the pencil along its path, the others end to end', () => {
    expect(gestureLengthDp('free', [])).toBe(0);
    expect(gestureLengthDp('free', line)).toBeCloseTo(
      10 + Math.hypot(10, 10) + Math.hypot(80, 110),
    );
    expect(gestureLengthDp('arrow', line)).toBeCloseTo(Math.hypot(100, 100));
  });

  it('drops anything shorter than 12 dp', () => {
    expect(buildStroke('free', [[0, 0]], VIEW, 'a', style)).toBeNull();
    expect(
      buildStroke(
        'arrow',
        [
          [0, 0],
          [MIN_STROKE_DP - 1, 0],
        ],
        VIEW,
        'a',
        style,
      ),
    ).toBeNull();
  });

  it('draws each shape in map coordinates', () => {
    const free = buildStroke('free', line, VIEW, 'f', style)!;
    expect(free.pts).toHaveLength(4);
    const arrow = buildStroke('arrow', line, VIEW, 'a', style)!;
    expect(arrow.pts).toHaveLength(2);
    expect(close(arrow.pts[0]!, unproject([100, 400], VIEW))).toBe(true);
    const circle = buildStroke('circle', line, VIEW, 'c', style)!;
    expect(circle.pts).toHaveLength(1);
    expect(circle.r).toBeCloseTo(haversineM(circle.pts[0]!, unproject([200, 300], VIEW)));
  });

  it('keeps a rectangle square to the screen, so it follows the map’s rotation', () => {
    const v = { ...VIEW, bearing: 30 };
    const rect = buildStroke(
      'rect',
      [
        [100, 400],
        [300, 500],
      ],
      v,
      'r',
      style,
    )!;
    expect(rect.pts).toHaveLength(4);
    const corners = rect.pts.map((p) => project(p, v));
    expect(close(corners[1]!, [300, 400], 1e-6)).toBe(true);
    expect(close(corners[3]!, [100, 500], 1e-6)).toBe(true);
    // Its top edge is 30° off north on the ground.
    expect(bearingDeg(rect.pts[0]!, rect.pts[1]!)).toBeCloseTo(120, 0);
  });
});

describe('the readout chip', () => {
  it('names 16 compass points', () => {
    expect(cardinal16(0)).toBe('N');
    expect(cardinal16(334)).toBe('NNW');
    expect(cardinal16(-90)).toBe('W');
    expect(cardinal16(359)).toBe('N');
  });

  it('says length, distance and bearing, radius, or sides', () => {
    const a: Pt = QC;
    const b: Pt = [QC[0], QC[1] + 0.001];
    const c: Pt = [QC[0] + 0.001, QC[1] + 0.001];
    expect(chipText({ id: 'f', sh: 'free', pts: [a, b], style }, 'metric')).toBe('Pencil · 111 m');
    expect(chipText({ id: 'a', sh: 'arrow', pts: [a, b], style }, 'metric')).toBe('111 m · 0° N');
    expect(chipText({ id: 'c', sh: 'circle', pts: [a], r: 85, style }, 'metric')).toBe(
      'Circle · 85 m radius',
    );
    expect(chipText({ id: 'c', sh: 'circle', pts: [a], style }, 'metric')).toBe(
      'Circle · 0 m radius',
    );
    expect(chipText({ id: 'r', sh: 'rect', pts: [a, b, c, a], style }, 'imperial')).toBe(
      'Rectangle · 365 ft × 250 ft',
    );
  });
});

describe('framing', () => {
  it('fits the points (circles with their radius), north up', () => {
    expect(frameCamera([], 400, 800)).toBeNull();
    const cam = frameCamera(
      [{ pts: [QC, [QC[0] + 0.01, QC[1] + 0.01]] }, { pts: [QC], r: 200 }],
      400,
      800,
    )!;
    expect(cam.bearing).toBe(0);
    expect(cam.zoom).toBeGreaterThan(12);
    expect(cam.zoom).toBeLessThan(16);
    const v = { ...cam, width: 400, height: 800 };
    for (const p of [QC, [QC[0] + 0.01, QC[1] + 0.01] as Pt]) {
      const s = project(p, v);
      expect(s[0]).toBeGreaterThanOrEqual(0);
      expect(s[0]).toBeLessThanOrEqual(400);
    }
    // One point: as close as allowed.
    expect(frameCamera([{ pts: [QC] }], 400, 800)!.zoom).toBe(17);
    // A tiny view still frames (never a negative room).
    expect(frameCamera([{ pts: [QC, [QC[0] + 1, QC[1]]] }], 10, 10)!.zoom).toBeGreaterThanOrEqual(
      3,
    );
  });
});

describe('StrokeBuilder (one gesture, move by move)', () => {
  const style = penStyle(defaultPrefs(0));
  const scribble = (n: number): ScreenPt[] =>
    Array.from({ length: n }, (_, i) => [100 + i * 3, 300 + ((i * 7) % 11)] as ScreenPt);

  it('gives what buildStroke and chipText give, for every tool and length', () => {
    for (const tool of ['free', 'arrow', 'circle', 'rect'] as const) {
      const pts = scribble(40);
      const b = new StrokeBuilder(tool, 's1');
      for (let n = 1; n <= pts.length; n++) {
        const so = pts.slice(0, n);
        const want = buildStroke(tool, so, VIEW, 's1', style);
        const got = b.stroke(so, VIEW, style);
        if (want === null) expect(got).toBeNull();
        else {
          expect(got).not.toBeNull();
          expect(got!.pts.length).toBe(want.pts.length);
          got!.pts.forEach((p, k) => {
            expect(p[0]).toBeCloseTo(want.pts[k]![0], 9);
            expect(p[1]).toBeCloseTo(want.pts[k]![1], 9);
          });
          expect(got!.r ?? 0).toBeCloseTo(want.r ?? 0, 6);
        }
        const one = buildStroke(tool, so, VIEW, 's1', style, 1);
        expect(b.chip(so, VIEW, 'metric')).toBe(one === null ? null : chipText(one, 'metric'));
      }
    }
  });

  it('a pencil stroke of n moves unprojects n points, not n²/2 (and once more per new camera)', () => {
    const pts = scribble(600);
    const b = new StrokeBuilder('free', 's2');
    for (let n = 1; n <= pts.length; n++) b.chip(pts.slice(0, n), VIEW, 'metric');
    expect(b.unprojected).toBe(600);
    // Built whole (the throttle let one go): nothing unprojected again.
    expect(b.stroke(pts, VIEW, style)!.pts).toHaveLength(600);
    expect(b.unprojected).toBe(600);
    // The camera was re-read (a new viewport object): one full pass, then incremental again.
    const moved = { ...VIEW, zoom: 16 };
    b.chip(pts, moved, 'metric');
    expect(b.unprojected).toBe(1200);
    b.chip([...pts, [2000, 300]], moved, 'metric');
    expect(b.unprojected).toBe(1201);
  });

  it('a stroke copy is the caller’s: later moves never change it', () => {
    const pts = scribble(30);
    const b = new StrokeBuilder('free', 's3');
    const first = b.stroke(pts.slice(0, 20), VIEW, style)!;
    b.stroke(pts, VIEW, style);
    expect(first.pts).toHaveLength(20);
  });
});

describe('readouts for strokes missing points', () => {
  const style = penStyle(defaultPrefs(0));
  it('say zero rather than throw; a bearing that is not a number reads N', () => {
    expect(chipText({ id: 'a', sh: 'arrow', pts: [QC], style }, 'metric')).toBe('Arrow · 0 m');
    expect(chipText({ id: 'r', sh: 'rect', pts: [QC], style }, 'metric')).toBe('Rectangle · 0 m');
    expect(cardinal16(Number.NaN)).toBe('N');
  });
});

describe('where a shape’s menu goes (2.5.2 QA: it covered the shape)', () => {
  const TOP: [number, number] = [70, 370];
  const BOTTOM: [number, number] = [430, 730];
  const at = (y: number): Pt => unproject([200, y], VIEW);

  it('a shape under the top band sends the menu to the bottom, and back', () => {
    const high = screenSpan({ sh: 'rect', pts: [at(150), at(150), at(250), at(250)] }, VIEW);
    expect(high?.top).toBeCloseTo(150, 6);
    expect(high?.bottom).toBeCloseTo(250, 6);
    expect(menuSide(high, TOP, BOTTOM)).toBe('bottom');
    const low = screenSpan({ sh: 'free', pts: [at(600), at(700)] }, VIEW);
    expect(menuSide(low, TOP, BOTTOM)).toBe('top');
  });

  it('a circle counts its radius; no points, or a tie, keep the top', () => {
    const circle = screenSpan({ sh: 'circle', pts: [at(400)], r: 100 }, VIEW);
    expect(circle!.bottom - circle!.top).toBeGreaterThan(0);
    expect(screenSpan({ sh: 'circle', pts: [at(400)] }, VIEW)).toEqual({
      top: expect.closeTo(400, 6),
      bottom: expect.closeTo(400, 6),
    });
    expect(screenSpan({ sh: 'free', pts: [] }, VIEW)).toBeNull();
    expect(menuSide(null, TOP, BOTTOM)).toBe('top');
    expect(menuSide({ top: 380, bottom: 420 }, TOP, BOTTOM)).toBe('top');
  });
});
