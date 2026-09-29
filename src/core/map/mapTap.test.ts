/**
 * Map tap ownership (owner report 2026-09-28: "the bubble just stays open but
 * isn't clickable"). The point chip draws above the waypoint pins, so it must
 * be asked first; asking the pins first made a pin under the chip swallow
 * every tap on it.
 */
import {
  chipSurvivesHit,
  pointChipAfterBareTap,
  readMapPress,
  routeMapTap,
  type MapPress,
  type MapPressEvent,
} from './mapTap';

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

/**
 * Second report of 2026-09-28 ("I can't click elsewhere to make the bubble
 * disappear … when the waypoint is made I cannot click anywhere to make the
 * bubble reappear"): React Native recycles the press event as soon as the
 * handler yields, and onMapPress read `lngLat` after awaiting the projection
 * of the open chip / the visible pins. These model that recycling exactly:
 * the event's `nativeEvent` is nulled the moment the wrapper returns.
 */
describe('readMapPress', () => {
  /** An RN-style synthetic event: released (nativeEvent -> null) after dispatch. */
  function dispatch(
    handler: (e: MapPressEvent) => void,
    point: [number, number],
    lngLat: [number, number],
  ) {
    const e: MapPressEvent = { nativeEvent: { point, lngLat } };
    handler(e);
    e.nativeEvent = null;
  }

  /** Stands in for `await map.project(...)` — resolves after the release. */
  const project = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('keeps the tapped coordinate for a body that awaits the projection', async () => {
    let seen: MapPress['lngLat'] | undefined;
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const body = async (press: MapPress) => {
      await project();
      seen = press.lngLat;
      done();
    };
    // MapScreen's onMapPress shape: copy first, then hand off.
    const onPress = (e: MapPressEvent) => {
      const press = readMapPress(e);
      if (press) void body(press);
    };

    dispatch(onPress, [120, 480], [-71.21, 46.81]);
    await finished;

    expect(seen).toEqual([-71.21, 46.81]);
  });

  it('is exactly the bug when the body reads the event after an await', async () => {
    // The pre-fix shape, kept as a witness that the fixture recycles events
    // the way the emulator showed: this read comes back empty.
    let lngLat: unknown = 'unset';
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const legacy = (e: MapPressEvent) => {
      void (async () => {
        await project();
        lngLat = e.nativeEvent?.lngLat;
        done();
      })();
    };

    dispatch(legacy, [120, 480], [-71.21, 46.81]);
    await finished;

    expect(lngLat).toBeUndefined();
  });

  it('copies the point, and has nothing for a press without one', () => {
    expect(readMapPress({ nativeEvent: { point: [1, 2] } })).toEqual({
      point: [1, 2],
      lngLat: null,
    });
    expect(readMapPress({ nativeEvent: {} })).toBeNull();
    expect(readMapPress({ nativeEvent: null })).toBeNull();
    expect(readMapPress({})).toBeNull();
  });
});
