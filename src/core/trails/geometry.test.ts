import {
  bboxOfLine,
  distanceToBboxM,
  distanceToLineM,
  haversineM,
  lineLengthM,
  nearestOnLine,
  resampleLine,
  thumbnailPath,
  toBoundingBox,
} from './geometry';
import type { LngLat } from '@core/models';

const EQ: LngLat[] = [
  [0, 0],
  [1, 0],
];

describe('trail geometry', () => {
  it('measures lines', () => {
    expect(haversineM([0, 0], [1, 0])).toBeCloseTo(111_195, -1);
    expect(lineLengthM([EQ, EQ])).toBeCloseTo(2 * 111_195, -1);
    expect(lineLengthM([])).toBe(0);
  });

  it('finds the nearest point on a line', () => {
    const hit = nearestOnLine([0.5, 0.1], [EQ]);
    expect(hit?.point[0]).toBeCloseTo(0.5);
    expect(hit?.point[1]).toBeCloseTo(0);
    expect(hit?.distanceM).toBeCloseTo(11_120, -2);
    // Beyond the end clamps to the endpoint.
    expect(nearestOnLine([2, 0], [EQ])?.point).toEqual([1, 0]);
    // A single-point part and a degenerate segment.
    expect(nearestOnLine([0, 1], [[[0, 1]]])?.distanceM).toBe(0);
    expect(
      nearestOnLine(
        [0, 0],
        [
          [
            [0, 0.1],
            [0, 0.1],
          ],
        ],
      )?.distanceM,
    ).toBeCloseTo(11_120, -2);
    expect(nearestOnLine([0, 0], [])).toBeNull();
    expect(distanceToLineM([0, 0], [])).toBe(Infinity);
    expect(distanceToLineM([0.5, 0], [EQ])).toBeCloseTo(0);
  });

  it('bounds distance by the bbox', () => {
    expect(distanceToBboxM([0.5, 0.5], [0, 0, 1, 1])).toBe(0);
    expect(distanceToBboxM([2, 0.5], [0, 0, 1, 1])).toBeCloseTo(111_178, -2);
  });

  it('converts boxes', () => {
    expect(toBoundingBox([1, 2, 3, 4])).toEqual({ minLng: 1, minLat: 2, maxLng: 3, maxLat: 4 });
    expect(bboxOfLine([EQ, [[0.5, 2]]])).toEqual([0, 0, 1, 2]);
    expect(bboxOfLine([])).toBeNull();
  });

  it('resamples at an even spacing and keeps the end', () => {
    const [samples] = resampleLine([EQ], 10_000);
    expect(samples).toHaveLength(13); // 0, 10…110 km, then the 111 km end
    expect(samples![1]![0]).toBeCloseTo(10_000 / 111_195, 4);
    expect(samples![12]).toEqual([1, 0]);
    // Spacing carries across vertices.
    const bent: LngLat[] = [
      [0, 0],
      [0.05, 0],
      [0.1, 0],
    ];
    expect(resampleLine([bent], 3000)[0]).toHaveLength(5);
    expect(resampleLine([[]], 10)).toEqual([]);
  });

  it('draws a fitted thumbnail path', () => {
    const { d, start, end } = thumbnailPath([EQ], 64, 64, 8);
    expect(d.startsWith('M8 32')).toBe(true);
    expect(start).toEqual([8, 32]);
    expect(end).toEqual([56, 32]);
    expect(thumbnailPath([], 64, 64, 8).d).toBe('');
    const two = thumbnailPath(
      [
        EQ,
        [
          [0, 1],
          [1, 1],
        ],
      ],
      100,
      50,
      0,
    );
    expect(two.d.split('M')).toHaveLength(3);
  });
});
