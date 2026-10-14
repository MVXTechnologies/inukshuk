import { MEMBER_COLORS } from '@core/teamui/colors';

import {
  anchorOf,
  drawFeatures,
  frameKey,
  isCompact,
  LIVE_OPACITY,
  type DrawFeature,
} from './features';
import { destination, haversineM, type Pt } from './geo';
import type { LiveStroke } from './pen';
import type { DrawShape } from './view';
import { QC } from './testUtils';

const T = 1_800_000_000_000;
const east = (m: number): Pt => destination(QC, 90, m);

function shape(over: Partial<DrawShape>): DrawShape {
  return {
    key: 'me:a',
    owner: 'me',
    id: 'a',
    sh: 'free',
    pts: [QC, east(200)],
    c: 2,
    w: 2,
    d: false,
    tx: '',
    created: T,
    expires: null,
    ...over,
  };
}

const kinds = (fs: DrawFeature[]) => fs.map((f) => f.properties.k);
const initials = (m: string) => (m === 'me' ? 'JT' : 'SB');

describe('drawFeatures', () => {
  it('one collection: fills for areas, lines for every outline, points for the rest', () => {
    const shapes = [
      shape({ key: 'me:f', id: 'f' }),
      shape({ key: 'me:c', id: 'c', sh: 'circle', pts: [QC], r: 85 }),
      shape({ key: 'me:r', id: 'r', sh: 'rect', pts: [QC, east(100), east(200), east(300)] }),
    ];
    const fc = drawFeatures(shapes, [], T, 16, { initials });
    expect(fc.type).toBe('FeatureCollection');
    expect(kinds(fc.features)).toEqual([
      'line',
      'badge',
      'fill',
      'line',
      'badge',
      'fill',
      'line',
      'badge',
    ]);
    const circleFill = fc.features[2]!;
    expect(circleFill.geometry.type).toBe('Polygon');
    const ring = (circleFill.geometry as { coordinates: Pt[][] }).coordinates[0]!;
    expect(ring).toHaveLength(65);
    for (const p of ring) expect(haversineM(QC, p)).toBeCloseTo(85, 3);
    const rectLine = fc.features[6]!.geometry as { coordinates: Pt[] };
    expect(rectLine.coordinates).toHaveLength(5); // closed
    expect(fc.features[0]!.properties).toMatchObject({
      drw: 'me:f',
      c: MEMBER_COLORS[2],
      op: 1,
      w: 2,
      d: false,
    });
    expect(fc.features[1]!.properties.t).toBe('JT');
    // The circle's badge sits on its top edge.
    const badge = fc.features[4]!.geometry as { coordinates: Pt };
    expect(haversineM(QC, badge.coordinates)).toBeCloseTo(85, 3);
  });

  it('arrows: a geographic shaft and screen-sized heads with the bearing; both ends when asked', () => {
    const a = shape({ sh: 'arrow', pts: [QC, east(500)], ht: 'open', hs: 3 });
    const fc = drawFeatures([a], [], T, 16);
    expect(kinds(fc.features)).toEqual(['line', 'head', 'badge']);
    expect(fc.features[1]!.properties).toMatchObject({ icon: 'head-open', s: 3 });
    expect(fc.features[1]!.properties.rot).toBeCloseTo(90, 1);
    const both = drawFeatures([{ ...a, ht: 'both' }], [], T, 16).features;
    expect(kinds(both)).toEqual(['line', 'head', 'head', 'badge']);
    expect(both[2]!.properties.rot).toBeCloseTo(270, 1);
    expect(both[2]!.properties.icon).toBe('head-fill');
    // Initials default to none.
    expect(both[3]!.properties.t).toBe('');
  });

  it('below 32 dp on screen an arrow becomes a fixed pointer at its midpoint', () => {
    const a = shape({ sh: 'arrow', pts: [QC, east(500)], ht: 'fill', hs: 2 });
    // 500 m: ~65 dp at z13 at this latitude, ~16 dp at z11.
    expect(isCompact(QC, east(500), 13)).toBe(false);
    expect(isCompact(QC, east(500), 11)).toBe(true);
    const fc = drawFeatures([a], [], T, 11);
    expect(kinds(fc.features)).toEqual(['pointer', 'badge']);
    const mid = fc.features[0]!.geometry as { coordinates: Pt };
    expect(haversineM(QC, mid.coordinates)).toBeCloseTo(250, 0);
    expect(fc.features[0]!.properties.rot).toBeCloseTo(90, 1);
  });

  it('fades, shows the time left in the badge while fading, and drops expired shapes', () => {
    const s = shape({ expires: T + 5 * 60_000 });
    const early = drawFeatures([s], [], T, 16, { initials });
    expect(early.features[1]!.properties.t).toBe('JT');
    const fading = drawFeatures([s], [], T + 5 * 60_000 - 15_000, 16, { initials });
    expect(fading.features[0]!.properties.op).toBeLessThan(1);
    expect(fading.features[0]!.properties.op).toBeGreaterThanOrEqual(0.3);
    expect(fading.features[1]!.properties.t).toBe('JT · 15 s');
    expect(drawFeatures([s], [], T + 5 * 60_000, 16).features).toEqual([]);
  });

  it('notes in full for the newest three, mine and the selected; a glyph for the others', () => {
    const shapes = Array.from({ length: 6 }, (_, i) =>
      shape({ key: `o:${i}`, id: String(i), owner: 'o', created: T + i, tx: `n${i}` }),
    );
    const fc = drawFeatures(shapes, [], T + 10, 16, { me: 'me', selected: 'o:0' });
    const notes = fc.features.filter((f) => f.properties.k === 'note').map((f) => f.properties.t);
    expect(notes).toEqual(['n0', 'n3', 'n4', 'n5']);
    const glyphs = fc.features.filter((f) => f.properties.k === 'noteGlyph');
    expect(glyphs.map((f) => f.properties.drw)).toEqual(['o:1', 'o:2']);
    expect(glyphs[0]!.properties.t).toBeUndefined();
    // Newest on top: features follow the oldest-first order, with banded sort keys.
    expect(fc.features[0]!.properties.z).toBe(5);
    expect(new Set(fc.features.map((f) => f.properties.z))).toEqual(new Set([5]));
  });

  it('live strokes at 90 %, with a pen tip; a one-point stroke is just its tip', () => {
    const live: LiveStroke[] = [
      {
        id: 'l',
        author: 'sam',
        sh: 'free',
        g: '',
        c: 4,
        w: 1,
        d: true,
        pts: [QC, east(30), east(60)],
        at: T,
        until: T + 30_000,
      },
      {
        id: 'p',
        author: 'sam',
        sh: 'free',
        g: '',
        c: 4,
        w: 1,
        d: false,
        pts: [QC],
        at: T,
        until: T,
      },
      {
        id: 'c',
        author: 'sam',
        sh: 'circle',
        g: '',
        r: 20,
        c: 4,
        w: 1,
        d: false,
        pts: [QC],
        at: T,
        until: T,
      },
    ];
    const fc = drawFeatures([], live, T, 16, { initials });
    expect(kinds(fc.features)).toEqual(['line', 'tip', 'tip', 'fill', 'line', 'tip']);
    expect(fc.features[0]!.properties).toMatchObject({ op: LIVE_OPACITY, live: true, d: true });
    expect((fc.features[1]!.geometry as { coordinates: Pt }).coordinates).toEqual(east(60));
    expect(fc.features[1]!.properties.t).toBe('SB');
    expect(
      haversineM(QC, (fc.features[5]!.geometry as { coordinates: Pt }).coordinates),
    ).toBeCloseTo(20, 3);
  });

  it('anchors: start, tail, top of circle', () => {
    expect(anchorOf({ sh: 'free', pts: [east(5), QC] })).toEqual(east(5));
    const top = anchorOf({ sh: 'circle', pts: [QC], r: 10 });
    expect(top).not.toBeNull();
    if (top !== null) expect(haversineM(QC, top)).toBeCloseTo(10, 3);
    // No points (never from the view): no anchor, no badge, no throw.
    expect(anchorOf({ sh: 'free', pts: [] })).toBeNull();
  });
});

describe('frameKey (rebuild only on change)', () => {
  it('changes with the quantised fade, notes, selection, zoom band and live strokes only', () => {
    const s = shape({ expires: T + 5 * 60_000 });
    const k = (now: number, opts = {}, live: LiveStroke[] = [], z = 16) =>
      frameKey([s], live, now, z, opts);
    expect(k(T)).toBe(k(T + 60_000));
    expect(k(T)).not.toBe(k(T + 5 * 60_000 - 15_000));
    expect(k(T)).not.toBe(k(T, { selected: 'me:a' }));
    expect(k(T)).not.toBe(k(T, {}, [], 15));
    const l = { id: 'l', author: 's', g: 'abc', at: T } as LiveStroke;
    expect(k(T, {}, [l])).not.toBe(k(T, {}, [{ ...l, g: 'abcd' }]));
    expect(frameKey([{ ...s, tx: 'x' }], [], T, 16)).not.toBe(k(T));
  });

  it('60 shapes and a live stroke: one pass builds the collection (work counted)', () => {
    const shapes = Array.from({ length: 60 }, (_, i) =>
      shape({
        key: `m:${i}`,
        id: String(i),
        created: T + i,
        sh: i % 4 === 0 ? 'circle' : i % 4 === 1 ? 'arrow' : 'free',
        pts: i % 4 === 0 ? [QC] : [QC, east(100 + i)],
        r: 50,
        ht: 'fill',
        hs: 2,
        tx: i % 3 === 0 ? 'note' : '',
      }),
    );
    const fc = drawFeatures(shapes, [], T + 100, 16, { me: 'm' });
    // Per shape: its geometry (≤ 2), a badge, and a note when it has one.
    expect(fc.features.length).toBeLessThanOrEqual(60 * 4);
    expect(fc.features.filter((f) => f.properties.k === 'badge')).toHaveLength(60);
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) drawFeatures(shapes, [], T + 100, 16);
    // A generous ceiling only (measure, don't assert): ~20 rebuilds well under a second.
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('shapes missing what the view always gives them (no throw, nothing drawn amiss)', () => {
  it('no points, an arrow with one point, a circle without radius, an arrow without head size', () => {
    const fc = drawFeatures(
      [
        shape({ key: 'me:e', id: 'e', pts: [] }),
        shape({ key: 'me:a1', id: 'a1', sh: 'arrow', pts: [QC] }),
        shape({ key: 'me:c', id: 'c', sh: 'circle', pts: [QC] }),
        shape({ key: 'me:a2', id: 'a2', sh: 'arrow', pts: [QC, east(500)], ht: 'fill' }),
      ],
      [
        {
          id: 'l0',
          author: 'sam',
          sh: 'free',
          g: '',
          c: 4,
          w: 1,
          d: false,
          pts: [],
          at: T,
          until: T + 30_000,
        },
      ],
      T,
      16,
      { initials },
    );
    // The circle without a radius is a ring of one point; the arrow's head defaults to size 2.
    const heads = fc.features.filter((f) => f.properties.k === 'head');
    expect(heads.map((f) => f.properties.s)).toEqual([2]);
    // No badge for the shape without points, no tip for the empty live stroke.
    expect(fc.features.filter((f) => f.properties.drw === 'me:e')).toEqual([]);
    expect(fc.features.filter((f) => f.properties.k === 'tip')).toEqual([]);
    expect(anchorOf({ sh: 'circle', pts: [QC] })).toEqual(destination(QC, 0, 0));
  });
});
