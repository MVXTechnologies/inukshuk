import { T0, MIN, HOUR } from '@core/team/testing/fixtures';
import { encodePolyline } from '@core/trails/polyline';

import { destination, type Pt } from './geo';
import {
  finishStroke,
  liveStrokes,
  MAX_PEN_BODY_BYTES,
  parsePenBody,
  PEN_INTERVAL_MS,
  penBody,
  PenThrottle,
  stampWall,
  toleranceM,
  type Stroke,
} from './pen';
import { drawWrite, MAX_FREE_POINTS } from './record';
import { crew, NEAR, QC } from './testUtils';

const tol = toleranceM(16, QC[1]);
const style = { c: 3, w: 2 as const, d: false };
const line = (n: number, stepM = 3): Pt[] =>
  Array.from({ length: n }, (_, k) => destination(QC, (k * 53) % 360, stepM * (k % 11)));

describe('pen bodies', () => {
  it('carries the whole stroke so far, simplified, with the style', () => {
    const straight = Array.from({ length: 50 }, (_, k) => destination(QC, 90, k));
    const body = penBody({ id: 'a1', sh: 'free', pts: straight, style }, tol)!;
    expect(body).toMatchObject({ id: 'a1', sh: 'free', c: 3, w: 2, d: false });
    expect(parsePenBody(body)).toEqual(body);
    // A straight line simplifies to its ends.
    expect(body.g).toBe(encodePolyline([straight[0]!, straight[49]!]));
    expect(toleranceM(16, 0)).toBeCloseTo(1.5 * (78271.51696 / 65536), 6);
    expect(toleranceM(16, 0, 3)).toBeCloseTo(2 * toleranceM(16, 0), 9);
  });

  it('builds arrows (default head), circles (rounded radius) and rects', () => {
    const arrow = penBody({ id: 'a', sh: 'arrow', pts: [QC, NEAR], style }, tol)!;
    expect(arrow).toMatchObject({ ht: 'fill', hs: 2 });
    const open = penBody(
      { id: 'a', sh: 'arrow', pts: [QC, NEAR], style: { ...style, ht: 'open', hs: 3 } },
      tol,
    )!;
    expect(open).toMatchObject({ ht: 'open', hs: 3 });
    const circle = penBody({ id: 'c', sh: 'circle', pts: [QC], r: 85.234, style }, tol)!;
    expect(circle.r).toBe(85.2);
    expect(penBody({ id: 'c', sh: 'circle', pts: [QC], style }, tol)).toBeNull(); // no radius yet
    const rect = penBody({ id: 'r', sh: 'rect', pts: [QC, NEAR, QC, NEAR], style }, tol)!;
    expect(rect.sh).toBe('rect');
    // One point of a fresh stroke is a valid live stroke.
    expect(penBody({ id: 'f', sh: 'free', pts: [QC], style }, tol)).not.toBeNull();
  });

  it('stops growing past the cap', () => {
    const big = line(3000, 40);
    expect(penBody({ id: 'big', sh: 'free', pts: big, style }, 0.01)).toBeNull();
    expect(MAX_PEN_BODY_BYTES).toBe(4096);
  });

  it('refuses malformed bodies', () => {
    const ok = penBody({ id: 'a', sh: 'arrow', pts: [QC, NEAR], style }, tol)!;
    expect(parsePenBody(null)).toBeNull();
    expect(parsePenBody({ ...ok, zz: 1 })).toBeNull();
    expect(parsePenBody({ ...ok, id: 'bad id' })).toBeNull();
    expect(parsePenBody({ ...ok, g: '' })).toBeNull();
    expect(parsePenBody({ ...ok, c: 12 })).toBeNull();
  });
});

describe('finishing a stroke', () => {
  const wall = T0 + MIN;

  it('writes every field with the expiry from the op’s own wall', () => {
    const s: Stroke = { id: 'a1', sh: 'arrow', pts: [QC, NEAR], style };
    const f = finishStroke(s, tol, wall, 30_000, 'Go')!;
    expect(f).toMatchObject({ sh: 'arrow', x: wall + 30_000, tx: 'Go', ht: 'fill', hs: 2 });
    expect(drawWrite(f, wall)).toBe('full');
    expect(finishStroke(s, tol, wall, null)!['x']).toBeNull();
    expect(finishStroke(s, tol, wall, 30_000, '')!['tx']).toBeUndefined();
    // Too long a life, or not a shape: nothing.
    expect(finishStroke(s, tol, wall, 5 * HOUR)).toBeNull();
    expect(finishStroke({ ...s, pts: [QC] }, tol, wall, 30_000)).toBeNull();
  });

  it('coarsens a very long stroke until it fits 500 points', () => {
    const pts = line(5000, 4);
    const f = finishStroke({ id: 'f', sh: 'free', pts, style }, 0.0001, wall, 60_000)!;
    expect(f).not.toBeNull();
    expect(drawWrite(f, wall)).toBe('full');
    // A non-positive tolerance falls back to half a metre.
    const g = finishStroke({ id: 'f', sh: 'free', pts: line(20), style }, 0, wall, 60_000)!;
    expect(drawWrite(g, wall)).toBe('full');
    expect(MAX_FREE_POINTS).toBe(500);
  });

  it('stamps against the writer’s clock, which may lead the phone', () => {
    expect(stampWall(T0 + 5000, T0)).toBe(T0 + 5000);
    expect(stampWall(T0, T0 + 1.7)).toBe(T0 + 1);
  });
});

describe('PenThrottle', () => {
  const body = (n: number) => penBody({ id: 's', sh: 'free', pts: line(n + 2), style }, 0)!;

  it('sends at most every 250 ms, only changes, and the latest pending one', () => {
    const th = new PenThrottle();
    expect(th.offer(body(1), 0)).toEqual(body(1));
    expect(th.offer(body(1), 10)).toBeNull(); // unchanged
    expect(th.nextAt()).toBeNull();
    expect(th.offer(body(2), 100)).toBeNull(); // too soon: kept
    expect(th.offer(body(3), 200)).toBeNull(); // replaced by the newer stroke
    expect(th.nextAt()).toBe(PEN_INTERVAL_MS);
    expect(th.due(249)).toBeNull();
    expect(th.due(250)).toEqual(body(3));
    expect(th.due(600)).toBeNull(); // nothing waits
    expect(th.offer(null, 700)).toBeNull(); // past the cap: no growth
    expect(th.sent).toBe(2);
  });

  it('≤ 4 per second however fast the finger moves, and resets at pen-up', () => {
    const th = new PenThrottle();
    let sent = 0;
    for (let t = 0; t < 10_000; t += 16) {
      if (th.offer(body((t / 16) % 100), t)) sent++;
    }
    expect(sent).toBeLessThanOrEqual(41);
    expect(sent).toBeGreaterThanOrEqual(39);
    th.reset();
    expect(th.nextAt()).toBeNull();
    expect(th.offer(body(1), 20_000)).toEqual(body(1));
  });
});

describe('live strokes', () => {
  it('a long drawing session does not grow the replica: bodies are never cached', () => {
    const { w, rb, sync } = crew();
    sync(T0 + MIN);
    const cache = (w.root as unknown as { decoded: Map<string, unknown> }).decoded;
    const before = cache.size;
    for (let i = 0; i < 200; i++) {
      const t = T0 + 2 * MIN + i * 250;
      const op = rb.stroke(t, penBody({ id: 's', sh: 'free', pts: line(i + 2), style }, tol)!)!;
      w.root.ingest([op.env], t);
      const live = liveStrokes(
        w.root.liveEphemeral(t),
        w.root.state,
        (o) => w.root.decode(o),
        () => false,
        t,
      );
      expect(live).toHaveLength(1);
      expect(w.root.data(t).positions.size).toBe(0);
    }
    expect(cache.size).toBe(before);
  });

  it('shows members’ strokes in progress until their shape lands; never a guest’s', () => {
    const { w, bob, rb, rg, sync } = crew();
    sync(T0 + MIN);
    const now = T0 + 2 * MIN;
    const b = rb.stroke(now, penBody({ id: 'a1', sh: 'free', pts: line(5), style }, tol) as never)!;
    const g = rg.stroke(now, penBody({ id: 'g1', sh: 'free', pts: line(5), style }, tol) as never)!;
    const junk = rb.stroke(now + 1, { id: 'zz' } as never)!;
    w.root.ingest([b.env, g.env], now);
    const pos = w.root.position(now, { la: 46.8, lo: -71.2, at: now })!;
    const ops = [b, g, junk, pos];
    const decode = (op: (typeof ops)[number]) => w.root.decode(op);
    const live = liveStrokes(ops, w.root.state, decode, () => false, now);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ author: bob.id, id: 'a1', at: now, until: now + 30_000 });
    expect(live[0]!.pts.length).toBeGreaterThanOrEqual(1);
    expect(
      liveStrokes(ops, w.root.state, decode, (a, id) => a === bob.id && id === 'a1', now),
    ).toEqual([]);
  });
});
