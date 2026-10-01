import { createGesturePause, GESTURE_PAUSE_MAX_MS } from './gesturePause';

describe('createGesturePause (fake timers)', () => {
  let changes: boolean[];
  beforeEach(() => {
    jest.useFakeTimers();
    changes = [];
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  const make = () => createGesturePause((p) => changes.push(p));

  it('never pauses for a plain tap', () => {
    const g = make();
    g.tap();
    jest.advanceTimersByTime(10_000);
    expect(g.isPaused()).toBe(false);
    expect(changes).toEqual([]);
  });

  it('never pauses for programmatic camera moves (follow-my-location)', () => {
    const g = make();
    g.willChange(false);
    g.didChange();
    expect(changes).toEqual([]);
  });

  it('pauses for a pan while it lasts, and resumes when the map settles', () => {
    const g = make();
    g.willChange(true);
    expect(g.isPaused()).toBe(true);
    jest.advanceTimersByTime(1_000);
    g.isChanging();
    jest.advanceTimersByTime(1_000);
    expect(g.isPaused()).toBe(true);
    g.didChange();
    expect(g.isPaused()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('resumes by itself after 3 s when the map never sends its "did change"', () => {
    const g = make();
    g.willChange(true);
    jest.advanceTimersByTime(GESTURE_PAUSE_MAX_MS - 1);
    expect(g.isPaused()).toBe(true);
    jest.advanceTimersByTime(1);
    expect(g.isPaused()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('ends at once on a tap that cancelled a camera animation (iOS: will, no did)', () => {
    const g = make();
    g.willChange(true); // the tap's transition-cancel reads as a user move
    g.tap(); // …and then the map reports the tap
    expect(g.isPaused()).toBe(false);
    jest.advanceTimersByTime(GESTURE_PAUSE_MAX_MS);
    expect(changes).toEqual([true, false]);
  });

  it('keeps a long gesture paused while move events keep coming', () => {
    const g = make();
    g.willChange(true);
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(2_000);
      g.isChanging();
    }
    expect(g.isPaused()).toBe(true);
    jest.advanceTimersByTime(GESTURE_PAUSE_MAX_MS);
    expect(g.isPaused()).toBe(false);
  });

  it('stops its timer when disposed', () => {
    const g = make();
    g.willChange(true);
    g.dispose();
    jest.advanceTimersByTime(GESTURE_PAUSE_MAX_MS * 2);
    expect(changes).toEqual([true]);
  });
});
