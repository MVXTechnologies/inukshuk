import type { PhotoOnAxis } from './axis';
import { LANE_CIRCLE, laneCircleAt, layoutLane, photoOrdinal } from './lane';
import type { TrackPhoto } from './model';

const at = (id: string, distanceM: number, takenAt: number): PhotoOnAxis => ({
  photo: { id, takenAt, distanceM } as TrackPhoto,
  distanceM,
});

describe('layoutLane', () => {
  it('stacks colliding photos under the first in time', () => {
    const circles = layoutLane(
      [at('a', 1000, 3), at('b', 1050, 1), at('c', 5000, 2), at('d', 9000, 4)],
      300,
      9000,
    );
    expect(circles.map((c) => c.members.map((m) => m.id))).toEqual([['b', 'a'], ['c'], ['d']]);
    expect(circles[0]!.cover.id).toBe('b');
    expect(circles[0]!.distanceM).toBe(1050);
    expect(circles[0]!.anchorXs).toEqual([35, expect.closeTo(33.33, 1)]);
  });

  it('keeps circles inside the lane', () => {
    const [first, last] = layoutLane([at('a', 0, 1), at('z', 9000, 2)], 300, 9000);
    expect(first!.x).toBe(LANE_CIRCLE / 2);
    expect(last!.x).toBe(300 - LANE_CIRCLE / 2);
  });

  it('is empty before layout or without photos', () => {
    expect(layoutLane([at('a', 1, 1)], 0, 100)).toEqual([]);
    expect(layoutLane([at('a', 1, 1)], 100, 0)).toEqual([]);
    expect(layoutLane([], 100, 100)).toEqual([]);
  });
});

describe('laneCircleAt', () => {
  const circles = layoutLane([at('a', 1000, 1), at('c', 5000, 2)], 300, 9000);

  it('catches the circle within 12 pt of the cursor', () => {
    expect(laneCircleAt(circles, 40)?.cover.id).toBe('a');
    expect(laneCircleAt(circles, 160)?.cover.id).toBe('c');
    expect(laneCircleAt(circles, 100)).toBeUndefined();
  });
});

it('numbers a photo in the viewer order', () => {
  expect(photoOrdinal([{ id: 'a' }, { id: 'b' }], 'b')).toEqual({ n: 2, of: 2 });
  expect(photoOrdinal([{ id: 'a' }], 'x')).toBeNull();
});
