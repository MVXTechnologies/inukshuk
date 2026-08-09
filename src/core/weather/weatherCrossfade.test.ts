import {
  crossfadeCommit,
  crossfadeInit,
  crossfadeTarget,
  WEATHER_PRELOAD_MS,
  type WeatherCrossfadeState,
} from './weatherCrossfade';

describe('weatherCrossfade', () => {
  const A = 'https://example.test/wms?time=A';
  const B = 'https://example.test/wms?time=B';
  const C = 'https://example.test/wms?time=C';

  it('init shows the URL immediately in slot 0 with nothing pending', () => {
    expect(crossfadeInit(A)).toEqual({ slots: [A, null], activeSlot: 0, pendingSlot: null });
    expect(crossfadeInit(null)).toEqual({ slots: [null, null], activeSlot: 0, pendingSlot: null });
  });

  it('activation (nothing shown yet) takes the active slot directly — no preload wait', () => {
    const s = crossfadeTarget(crossfadeInit(null), A);
    expect(s).toEqual({ slots: [A, null], activeSlot: 0, pendingSlot: null });
  });

  it('a frame change stages the incoming URL in the inactive slot, keeping the outgoing frame shown', () => {
    const s = crossfadeTarget(crossfadeInit(A), B);
    expect(s.slots).toEqual([A, B]);
    expect(s.activeSlot).toBe(0); // outgoing frame still on screen
    expect(s.pendingSlot).toBe(1); // incoming frame prefetching at opacity 0
  });

  it('commit flips the active slot to the preloaded frame', () => {
    const s = crossfadeCommit(crossfadeTarget(crossfadeInit(A), B));
    expect(s).toEqual({ slots: [A, B], activeSlot: 1, pendingSlot: null });
  });

  it('commit is a no-op when settled', () => {
    const s = crossfadeInit(A);
    expect(crossfadeCommit(s)).toBe(s);
  });

  it('re-targeting the shown frame is a no-op / cancels a pending swap', () => {
    const settled = crossfadeInit(A);
    expect(crossfadeTarget(settled, A)).toBe(settled);
    const pending = crossfadeTarget(settled, B);
    expect(crossfadeTarget(pending, A)).toEqual({
      slots: [A, B],
      activeSlot: 0,
      pendingSlot: null,
    });
  });

  it('re-targeting the already-pending frame keeps state identity (no timer churn upstream)', () => {
    const pending = crossfadeTarget(crossfadeInit(A), B);
    expect(crossfadeTarget(pending, B)).toBe(pending);
  });

  it('a newer frame before commit replaces the pending slot URL', () => {
    const s = crossfadeTarget(crossfadeTarget(crossfadeInit(A), B), C);
    expect(s).toEqual({ slots: [A, C], activeSlot: 0, pendingSlot: 1 });
  });

  it('alternates slots across successive committed swaps', () => {
    let s: WeatherCrossfadeState = crossfadeInit(A);
    s = crossfadeCommit(crossfadeTarget(s, B));
    expect(s.activeSlot).toBe(1);
    s = crossfadeCommit(crossfadeTarget(s, C));
    expect(s).toEqual({ slots: [C, B], activeSlot: 0, pendingSlot: null });
  });

  it('preload window sits inside the scrub throttle and playback tick', () => {
    expect(WEATHER_PRELOAD_MS).toBeLessThan(300);
    expect(WEATHER_PRELOAD_MS).toBeLessThan(700);
  });
});
