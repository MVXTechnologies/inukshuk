import { layoutMadeMap } from './layout';
import { pageProjector, projectLines } from './pageSpace';
import type { BoundingBox } from '@core/models';

const BBOX: BoundingBox = { minLng: -71.35, minLat: 46.75, maxLng: -71.2, maxLat: 46.8 };
const layout = layoutMadeMap(BBOX, 'a4');
const { mapRect, drawBbox } = layout;

describe('pageProjector', () => {
  it('maps drawBbox corners to mapRect corners (y up)', () => {
    const p = pageProjector(layout);
    const bl = p([drawBbox.minLng, drawBbox.minLat]);
    expect(bl.x).toBeCloseTo(mapRect.x, 6);
    expect(bl.y).toBeCloseTo(mapRect.y, 6);
    const tr = p([drawBbox.maxLng, drawBbox.maxLat]);
    expect(tr.x).toBeCloseTo(mapRect.x + mapRect.w, 6);
    expect(tr.y).toBeCloseTo(mapRect.y + mapRect.h, 6);
  });

  it('is mercator in latitude: equal Δlat spans are not equal on the page', () => {
    const p = pageProjector(layout);
    const latSpan = drawBbox.maxLat - drawBbox.minLat;
    const low = p([drawBbox.minLng, drawBbox.minLat + latSpan * 0.25]);
    const mid = p([drawBbox.minLng, drawBbox.minLat + latSpan * 0.5]);
    const high = p([drawBbox.minLng, drawBbox.minLat + latSpan * 0.75]);
    // Northern quarter is stretched relative to the southern one at 46°N.
    expect(high.y - mid.y).toBeGreaterThan(mid.y - low.y);
  });
});

describe('projectLines', () => {
  const lngAt = (t: number) => drawBbox.minLng + (drawBbox.maxLng - drawBbox.minLng) * t;
  const latAt = (t: number) => drawBbox.minLat + (drawBbox.maxLat - drawBbox.minLat) * t;

  it('keeps an inside line intact', () => {
    const lines = projectLines(layout, [
      [
        [lngAt(0.25), latAt(0.25)],
        [lngAt(0.75), latAt(0.75)],
      ],
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(2);
  });

  it('clips a crossing segment to the frame border', () => {
    // Horizontal line entering from far west, exiting far east at mid height.
    const lines = projectLines(layout, [
      [
        [lngAt(-1), latAt(0.5)],
        [lngAt(2), latAt(0.5)],
      ],
    ]);
    expect(lines).toHaveLength(1);
    const [a, b] = [lines[0]![0]!, lines[0]![lines[0]!.length - 1]!];
    expect(Math.min(a.x, b.x)).toBeCloseTo(mapRect.x, 4);
    expect(Math.max(a.x, b.x)).toBeCloseTo(mapRect.x + mapRect.w, 4);
  });

  it('drops fully-outside lines and splits re-entering ones', () => {
    expect(
      projectLines(layout, [
        [
          [lngAt(-0.5), latAt(-0.5)],
          [lngAt(-0.6), latAt(-0.2)],
        ],
      ]),
    ).toHaveLength(0);
    // In → out → in again: two separate clipped pieces.
    const zigzag = projectLines(layout, [
      [
        [lngAt(0.4), latAt(0.5)],
        [lngAt(1.5), latAt(0.5)],
        [lngAt(1.5), latAt(0.6)],
        [lngAt(0.4), latAt(0.6)],
      ],
    ]);
    expect(zigzag.length).toBe(2);
  });
});
