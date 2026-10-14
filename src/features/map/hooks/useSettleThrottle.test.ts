/**
 * Camera settles while the compass turns the map (heading-up streams one per
 * frame) reach the screen at most every 400 ms plus the last one; a person's
 * gesture, or any settle at rest, at once. Measured in handler calls.
 */
import { act, renderHook } from '@testing-library/react-native';
import { HEADING_SETTLE_INTERVAL_MS, useSettleThrottle } from './useSettleThrottle';

const mockMotion = { moving: false };
jest.mock('../headingMotion', () => ({ isHeadingMoving: () => mockMotion.moving }));

jest.useFakeTimers();

type E = { nativeEvent: { userInteraction?: boolean; n: number } };
const ev = (n: number, userInteraction = false): E => ({ nativeEvent: { userInteraction, n } });

beforeEach(() => {
  mockMotion.moving = false;
});

describe('useSettleThrottle', () => {
  it('at rest every settle is handled at once', async () => {
    const seen: number[] = [];
    const { result } = await renderHook(() =>
      useSettleThrottle((e: E) => seen.push(e.nativeEvent.n)),
    );
    for (let i = 0; i < 5; i++) result.current(ev(i));
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it('while the heading turns the camera: a 60 Hz stream becomes ≤ 2.5 a second, and the last one lands', async () => {
    const seen: number[] = [];
    const { result } = await renderHook(() =>
      useSettleThrottle((e: E) => seen.push(e.nativeEvent.n)),
    );
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
    const { result } = await renderHook(() =>
      useSettleThrottle((e: E) => seen.push(e.nativeEvent.n)),
    );
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
      ({ tag }: { tag: string }) =>
        useSettleThrottle((e: E) => calls.push(`${tag}${e.nativeEvent.n}`)),
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
