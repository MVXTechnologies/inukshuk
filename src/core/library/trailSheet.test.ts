import { IMPERIAL, METRIC } from '@core/format';

import {
  peekStats,
  SHEET_FLICK_V,
  SHEET_SWIPE_DP,
  sheetAfterDrag,
  sheetDragOffset,
} from './trailSheet';

describe('the trail view sheet (#740)', () => {
  it('folds on a drag down past the threshold, or a flick', () => {
    expect(sheetAfterDrag('full', SHEET_SWIPE_DP + 1)).toBe('peek');
    expect(sheetAfterDrag('full', 10, SHEET_FLICK_V + 0.1)).toBe('peek');
    expect(sheetAfterDrag('full', SHEET_SWIPE_DP - 1)).toBe('full');
    expect(sheetAfterDrag('full', -200)).toBe('full');
  });

  it('unfolds on a drag up past the threshold, or a flick', () => {
    expect(sheetAfterDrag('peek', -SHEET_SWIPE_DP - 1)).toBe('full');
    expect(sheetAfterDrag('peek', -10, -SHEET_FLICK_V - 0.1)).toBe('full');
    expect(sheetAfterDrag('peek', -SHEET_SWIPE_DP + 1)).toBe('peek');
    expect(sheetAfterDrag('peek', 300)).toBe('peek');
  });

  it('follows the finger only the way it can go, damped past the threshold', () => {
    expect(sheetDragOffset('full', -50)).toBe(0);
    expect(sheetDragOffset('full', 20)).toBe(20);
    expect(sheetDragOffset('full', SHEET_SWIPE_DP + 100)).toBeCloseTo(SHEET_SWIPE_DP + 35);
    expect(sheetDragOffset('peek', 50)).toBe(0);
    expect(sheetDragOffset('peek', -20)).toBe(-20);
  });

  it('peeks distance, climb and moving time', () => {
    expect(
      peekStats({ distanceM: 12_400, ascentM: 640 }, { movingTimeS: 3 * 3600 + 42 * 60 }, METRIC),
    ).toEqual(['12.4 km', '+640 m', '3:42']);
  });

  it('leaves out the time of an untimed trail, and follows the units', () => {
    expect(peekStats({ distanceM: 12_400, ascentM: 640 }, null, METRIC)).toEqual([
      '12.4 km',
      '+640 m',
    ]);
    const imperial = peekStats({ distanceM: 1609.344, ascentM: 304.8 }, null, IMPERIAL);
    expect(imperial[0]).toMatch(/mi$/);
    expect(imperial[1]).toMatch(/^\+1,?000 ft$/);
  });
});
