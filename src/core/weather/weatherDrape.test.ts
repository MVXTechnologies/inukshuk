import {
  DRAPE_MAX_AREA_PX,
  DRAPE_MAX_PX,
  DRAPE_MIN_PX,
  drapeNeedsReanchor,
  weatherDrapeAnchor,
  weatherDrapeUrl,
  type DrapeView,
} from './weatherDrape';

const QUEBEC: DrapeView = { west: -71.6, south: 46.6, east: -70.8, north: 47.0 };
const PHONE = { width: 390, height: 844 };

describe('weatherDrapeAnchor', () => {
  it('pads the viewport so short pans stay covered', () => {
    const a = weatherDrapeAnchor(QUEBEC, PHONE);
    expect(a).not.toBeNull();
    if (a === null) return;
    expect(a.bbox.west).toBeLessThan(QUEBEC.west);
    expect(a.bbox.east).toBeGreaterThan(QUEBEC.east);
    expect(a.bbox.south).toBeLessThan(QUEBEC.south);
    expect(a.bbox.north).toBeGreaterThan(QUEBEC.north);
  });

  it('gives ImageSource corners in TL, TR, BR, BL order', () => {
    const a = weatherDrapeAnchor(QUEBEC, PHONE);
    if (a === null) throw new Error('anchor');
    const [tl, tr, br, bl] = a.coordinates;
    expect(tl).toEqual([a.bbox.west, a.bbox.north]);
    expect(tr).toEqual([a.bbox.east, a.bbox.north]);
    expect(br).toEqual([a.bbox.east, a.bbox.south]);
    expect(bl).toEqual([a.bbox.west, a.bbox.south]);
  });

  it('keeps pixels square in mercator (no aspect distortion)', () => {
    const a = weatherDrapeAnchor(QUEBEC, PHONE);
    if (a === null) throw new Error('anchor');
    const mercAspect = (a.merc[2] - a.merc[0]) / (a.merc[3] - a.merc[1]);
    const pxAspect = a.widthPx / a.heightPx;
    // Both axes are snapped to a 32 px grid, so allow that much slack.
    expect(Math.abs(mercAspect - pxAspect)).toBeLessThan(0.12);
  });

  it('is stable under camera jitter — the warmed cache must not churn', () => {
    const base = weatherDrapeAnchor(QUEBEC, PHONE);
    const nudged = weatherDrapeAnchor(
      { west: -71.605, south: 46.598, east: -70.803, north: 47.004 },
      PHONE,
    );
    expect(nudged).toEqual(base);
  });

  it('re-anchors once the camera moves a real distance', () => {
    const base = weatherDrapeAnchor(QUEBEC, PHONE);
    const moved = weatherDrapeAnchor({ west: -70.6, south: 46.6, east: -69.8, north: 47.0 }, PHONE);
    expect(moved).not.toEqual(base);
  });

  it('honours the pixel caps at every zoom', () => {
    for (const span of [0.02, 0.2, 2, 20, 120]) {
      const a = weatherDrapeAnchor(
        { west: -71 - span / 2, south: 46 - span / 4, east: -71 + span / 2, north: 46 + span / 4 },
        PHONE,
      );
      if (a === null) continue;
      expect(Math.max(a.widthPx, a.heightPx)).toBeLessThanOrEqual(DRAPE_MAX_PX);
      expect(Math.min(a.widthPx, a.heightPx)).toBeGreaterThanOrEqual(DRAPE_MIN_PX);
      expect(a.widthPx % 32).toBe(0);
      expect(a.heightPx % 32).toBe(0);
    }
  });

  it('never resolves coarser than the 256 px tile grid it replaces', () => {
    // A tileSize-256 raster source draws one tile pixel per CSS point. The
    // single image has to clear that over the VIEWPORT part of its box, or
    // the drape would ship blurrier than before.
    for (const [w, h] of [
      [390, 844],
      [430, 932],
      [768, 1024],
    ] as const) {
      const a = weatherDrapeAnchor(QUEBEC, { width: w, height: h });
      if (a === null) throw new Error('anchor');
      const viewFraction = (QUEBEC.east - QUEBEC.west) / (a.bbox.east - a.bbox.west);
      expect((a.widthPx * viewFraction) / w).toBeGreaterThanOrEqual(1);
    }
  });

  it('caps total pixels on a big near-square viewport (tablet)', () => {
    const a = weatherDrapeAnchor(
      { west: -72, south: 46, east: -70, north: 48 },
      {
        width: 1024,
        height: 1024,
      },
    );
    if (a === null) throw new Error('anchor');
    expect(a.widthPx * a.heightPx).toBeLessThanOrEqual(DRAPE_MAX_AREA_PX);
  });

  it('is a fixed point — re-anchoring on its own box never loops', () => {
    const a = weatherDrapeAnchor(QUEBEC, PHONE);
    if (a === null) throw new Error('anchor');
    expect(drapeNeedsReanchor(a, QUEBEC)).toBe(false);
    // And the anchor taken FOR its own bbox must not immediately want another.
    const b = weatherDrapeAnchor(a.bbox, PHONE);
    if (b === null) throw new Error('anchor');
    expect(drapeNeedsReanchor(b, a.bbox)).toBe(false);
  });

  it('clamps inside the mercator latitude limit', () => {
    const a = weatherDrapeAnchor({ west: -30, south: 78, east: -20, north: 89 }, PHONE);
    if (a === null) throw new Error('anchor');
    expect(a.bbox.north).toBeLessThanOrEqual(84);
    expect(Number.isFinite(a.merc[3])).toBe(true);
  });

  it('degrades to null on a degenerate viewport instead of a bad URL', () => {
    expect(weatherDrapeAnchor({ west: -71, south: 46, east: -71, north: 47 }, PHONE)).toBeNull();
    expect(weatherDrapeAnchor({ west: -70, south: 46, east: -71, north: 47 }, PHONE)).toBeNull();
    expect(weatherDrapeAnchor(QUEBEC, { width: 0, height: 0 })).toBeNull();
    expect(weatherDrapeAnchor({ west: NaN, south: 46, east: -71, north: 47 }, PHONE)).toBeNull();
  });
});

describe('drapeNeedsReanchor', () => {
  const anchor = weatherDrapeAnchor(QUEBEC, PHONE);

  it('holds while the viewport stays inside the padding', () => {
    if (anchor === null) throw new Error('anchor');
    expect(drapeNeedsReanchor(anchor, QUEBEC)).toBe(false);
  });

  it('fires when the viewport escapes the box', () => {
    if (anchor === null) throw new Error('anchor');
    expect(drapeNeedsReanchor(anchor, { west: -73, south: 46.6, east: -72.2, north: 47.0 })).toBe(
      true,
    );
  });

  it('fires on a deep zoom-in, where a tighter GetMap buys resolution', () => {
    if (anchor === null) throw new Error('anchor');
    expect(
      drapeNeedsReanchor(anchor, { west: -71.21, south: 46.8, east: -71.19, north: 46.81 }),
    ).toBe(true);
  });
});

describe('weatherDrapeUrl', () => {
  const anchor = weatherDrapeAnchor(QUEBEC, PHONE);

  it('asks for one PNG GetMap over the anchored bbox', () => {
    if (anchor === null) throw new Error('anchor');
    const url = weatherDrapeUrl('RADAR_1KM_RRAI', anchor);
    expect(url).toContain('request=GetMap');
    expect(url).toContain('crs=EPSG:3857');
    expect(url).toContain('format=image/png');
    expect(url).toContain('transparent=true');
    expect(url).toContain(`width=${anchor.widthPx}`);
    expect(url).toContain(`height=${anchor.heightPx}`);
    expect(url).not.toContain('{bbox');
    expect(url).not.toContain('time=');
  });

  it('pins one frame when a TIME is given', () => {
    if (anchor === null) throw new Error('anchor');
    const url = weatherDrapeUrl('HRDPS.CONTINENTAL_TT', anchor, '2026-08-11T13:00:00Z');
    expect(url).toContain('time=2026-08-11T13%3A00%3A00Z');
  });

  it('writes the bbox as minX,minY,maxX,maxY', () => {
    if (anchor === null) throw new Error('anchor');
    const bbox = /bbox=([^&]+)/.exec(weatherDrapeUrl('X', anchor))?.[1] ?? '';
    const [minX, minY, maxX, maxY] = bbox.split(',').map(Number);
    expect(minX).toBeLessThan(maxX ?? 0);
    expect(minY).toBeLessThan(maxY ?? 0);
  });
});
