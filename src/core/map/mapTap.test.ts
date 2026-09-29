/**
 * Map tap ownership (owner report 2026-09-28: "the bubble just stays open but
 * isn't clickable"). The point chip draws above the waypoint pins, so it must
 * be asked first; asking the pins first made a pin under the chip swallow
 * every tap on it.
 */
import { chipSurvivesHit, pointChipAfterBareTap, routeMapTap } from './mapTap';

const PIN = { id: 'wp-1' };

describe('routeMapTap', () => {
  it.each(['navigate', 'waypoint', 'copy'] as const)(
    'gives a %s hit on the open chip to the chip even with a pin under it',
    (hit) => {
      expect(routeMapTap(hit, PIN)).toEqual({ kind: 'chip', hit });
    },
  );

  it('gives the tap to the pin when it misses the chip', () => {
    expect(routeMapTap(null, PIN)).toEqual({ kind: 'pin', pin: PIN });
  });

  it('leaves a tap that hits neither to the rest of the map', () => {
    expect(routeMapTap(null, null)).toEqual({ kind: 'map' });
  });
});

describe('chipSurvivesHit', () => {
  it('keeps the chip for Navigate only', () => {
    expect(chipSurvivesHit('navigate')).toBe(true);
    expect(chipSurvivesHit('copy')).toBe(false);
  });

  // The new pin lands on the chip's own coordinate — leaving the chip there
  // is exactly the stale bubble of the report.
  it('closes the chip when it adds a waypoint', () => {
    expect(chipSurvivesHit('waypoint')).toBe(false);
  });
});

describe('pointChipAfterBareTap (#258)', () => {
  it('drops a chip on a clean map', () => {
    expect(pointChipAfterBareTap(null, 'here')).toBe('here');
  });

  it('closes an open chip rather than moving it', () => {
    expect(pointChipAfterBareTap('there', 'here')).toBeNull();
  });
});
