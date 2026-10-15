/**
 * Camera settles while the compass turns the map reach the screen at most
 * every 400 ms plus the last one; a person's gesture, or any settle at rest,
 * at once. Measured in handler calls. And (2.6.1 QA white screen) the held
 * settle survives React Native nulling the pooled event's payload.
 */
import type { RegionPayload } from '@core/map/regionPayload';
import { act, renderHook } from '@testing-library/react-native';
import {
  HEADING_SETTLE_INTERVAL_MS,
  useRegionSettle,
  useSettleThrottle,
} from './useSettleThrottle';

const mockMotion = { moving: false };
jest.mock('../headingMotion', () => ({ isHeadingMoving: () => mockMotion.moving }));

jest.useFakeTimers();

type E = { userInteraction: boolean; n: number };
const ev = (n: number, userInteraction = false): E => ({ userInteraction, n });

beforeEach(() => {
  mockMotion.moving = false;
});

describe('useSettleThrottle', () => {
  it('at rest every settle is handled at once', async () => {
    const seen: number[] = [];
    const { result } = await renderHook(() => useSettleThrottle((e: E) => seen.push(e.n)));
    for (let i = 0; i < 5; i++) result.current(ev(i));
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it('while the heading turns the camera: a 60 Hz stream becomes ≤ 2.5 a second, and the last one lands', async () => {
    const seen: number[] = [];
    const { result } = await renderHook(() => useSettleThrottle((e: E) => seen.push(e.n)));
    mockMotion.moving = true;
    for (let i = 0; i < 120; i++) {
      await act(async () => {
        result.current(ev(i));
        jest.advanceTimersByTime(1000 / 60);
      });
    }
    mockMotion.moving = false;
    await act(async () => {
      jest.advanceTimersByTime(HEADING_SETTLE_INTERVAL_MS);
    });
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(seen.length).toBeLessThanOrEqual(7);
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(119);
  });

  it('a gesture runs at once and drops the held settle (the newer view wins)', async () => {
    const seen: number[] = [];
    const { result } = await renderHook(() => useSettleThrottle((e: E) => seen.push(e.n)));
    mockMotion.moving = true;
    result.current(ev(1));
    result.current(ev(2)); // held
    result.current(ev(3, true)); // a person's pan
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(seen).toEqual([1, 3]);
  });

  it('the held settle goes to the latest handler, not the one of its render', async () => {
    const calls: string[] = [];
    const { result, rerender } = await renderHook(
      ({ tag }: { tag: string }) => useSettleThrottle((e: E) => calls.push(`${tag}${e.n}`)),
      { initialProps: { tag: 'a' } },
    );
    mockMotion.moving = true;
    result.current(ev(1));
    result.current(ev(2));
    await rerender({ tag: 'b' });
    await act(async () => {
      jest.advanceTimersByTime(HEADING_SETTLE_INTERVAL_MS);
    });
    expect(calls).toEqual(['a1', 'b2']);
  });
});

describe('useRegionSettle (the map’s onRegionDidChange)', () => {
  const payload = (n: number) => ({
    center: [-71.2 + n * 1e-4, 46.8],
    zoom: 15,
    bearing: n,
    pitch: 0,
    bounds: [-71.3, 46.7, -71.1, 46.9],
    animated: false,
    userInteraction: false,
  });

  /**
   * React Native's renderer pools synthetic events: once the handler
   * returns, `destructor()` sets `nativeEvent` to null and the object is
   * reused (ReactFabric-prod.js, releasePooledEvent).
   */
  function pooledDispatch(handler: (e: { nativeEvent: unknown }) => unknown, nativeEvent: unknown) {
    const e: { nativeEvent: unknown } = { nativeEvent };
    const out = handler(e);
    e.nativeEvent = null;
    return out;
  }

  it('REGRESSION (2.6.1 QA): a held settle still has its view after RN nulls the pooled event', async () => {
    const seen: RegionPayload[] = [];
    const { result } = await renderHook(() =>
      // Reads bounds like MapScreen's settle handler (wind / marine boxes).
      useRegionSettle((view) => {
        if (view.bounds === null) throw new Error('no bounds');
        seen.push(view);
      }),
    );
    // Heading-up with Locate: the native compass follow streams settles.
    mockMotion.moving = true;
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        pooledDispatch(result.current, payload(i));
        jest.advanceTimersByTime(1000 / 60);
      });
    }
    await act(async () => {
      jest.advanceTimersByTime(HEADING_SETTLE_INTERVAL_MS * 2);
    });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    // The trailing one is the stream's last view, whole.
    expect(seen.at(-1)?.bearing).toBe(29);
    expect(seen.at(-1)?.bounds).toEqual([-71.3, 46.7, -71.1, 46.9]);
  });

  it('a null or empty payload is dropped without a throw; a bounds-less one goes through', async () => {
    const seen: RegionPayload[] = [];
    const { result } = await renderHook(() => useRegionSettle((view) => seen.push(view)));
    expect(pooledDispatch(result.current, null)).toBeNull();
    expect(pooledDispatch(result.current, {})).toBeNull();
    const { bounds: _b, ...noBounds } = payload(1);
    expect(pooledDispatch(result.current, noBounds)).toMatchObject({ bounds: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.bounds).toBeNull();
  });
});
