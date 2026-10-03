import { centerPx, projectionMatrix } from './camera';
import { aabbOutside, distanceToAabb, frustumPlanes, pointInside, type Aabb } from './frustum';
import { camera, PLACES } from './testUtils';

const box = (cx: number, cy: number, r: number, z0 = 0, z1 = 0): Aabb => ({
  minX: cx - r,
  minY: cy - r,
  minZ: z0,
  maxX: cx + r,
  maxY: cy + r,
  maxZ: z1,
});

describe('frustum planes', () => {
  const c = camera(PLACES.zermatt, 45, 20);
  const P = projectionMatrix(c);
  const planes = frustumPlanes(P);
  const [cx, cy] = centerPx(c);

  it('has five unit-normal planes', () => {
    expect(planes).toHaveLength(5);
    for (const p of planes) expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(1, 12);
  });

  it('the view centre is inside', () => {
    expect(pointInside(planes, cx, cy, 0)).toBe(true);
    expect(aabbOutside(planes, box(cx, cy, 10))).toBe(false);
  });

  it('a box far to the side is outside', () => {
    expect(aabbOutside(planes, box(cx + 1e6, cy, 10))).toBe(true);
    expect(aabbOutside(planes, box(cx - 1e6, cy, 10))).toBe(true);
  });

  it('a box behind the camera is outside', () => {
    // bearing 20: "behind" is toward the south-south-west.
    const b = (20 * Math.PI) / 180;
    expect(aabbOutside(planes, box(cx - Math.sin(b) * 1e5, cy + Math.cos(b) * 1e5, 10))).toBe(true);
  });

  it('a huge box around the view is inside (straddles every plane)', () => {
    expect(aabbOutside(planes, box(cx, cy, 1e7, -1000, 9000))).toBe(false);
  });

  it('a mountain just off the top edge is kept when its height brings it into view', () => {
    const top = frustumPlanes(projectionMatrix(camera(PLACES.zermatt, 0, 0)));
    const offTop = box(cx, cy - 700, 20); // just above a 892-px-tall view
    expect(aabbOutside(top, offTop)).toBe(true);
  });
});

describe('distanceToAabb', () => {
  const b: Aabb = { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 100 };
  it.each([
    [5, 5, 50, 1, 0],
    [15, 5, 50, 1, 5],
    [-3, -4, 50, 1, 5],
    [5, 5, 200, 1, 100],
    [5, 5, 200, 0.5, 50],
    [5, 5, -10, 2, 20],
    [13, 14, 100, 1, 5],
  ])('point (%p, %p, %p) zScale %p → %p', (x, y, z, k, d) => {
    expect(distanceToAabb(x, y, z, b, k)).toBeCloseTo(d, 12);
  });
});
