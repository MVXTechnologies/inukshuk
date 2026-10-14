import { DrawGesture, LONG_PRESS_MS, TAP_MS, type Touch } from './gesture';

const t = (id: number, x: number, y: number): Touch => ({ id, x, y });
const types = (a: { type: string }[]) => a.map((x) => x.type);

describe('drawing mode’s touches', () => {
  it('one finger draws: begin, updates, end', () => {
    const g = new DrawGesture();
    expect(g.phase).toBe('idle');
    expect(g.touches([t(1, 10, 10)], 0)).toEqual([{ type: 'begin', at: [10, 10] }]);
    expect(g.longPressAt()).toBe(LONG_PRESS_MS);
    // Under the step: no new point.
    expect(g.touches([t(1, 10.5, 10)], 5)).toEqual([]);
    expect(types(g.touches([t(1, 30, 10)], 10))).toEqual(['update']);
    // Moved: never a long-press now.
    expect(g.longPressAt()).toBeNull();
    // Another finger id while drawing is not ours.
    expect(g.touches([t(9, 50, 50)], 12)).toEqual([]);
    const end = g.touches([], 400);
    expect(end).toEqual([
      {
        type: 'end',
        pts: [
          [10, 10],
          [30, 10],
        ],
      },
    ]);
    expect(g.phase).toBe('idle');
  });

  it('a quick still touch is a tap; a slow one an end of one point', () => {
    const g = new DrawGesture();
    g.touches([t(1, 5, 5)], 0);
    expect(g.touches([], TAP_MS)).toEqual([{ type: 'cancel' }, { type: 'tap', at: [5, 5] }]);
    g.touches([t(1, 5, 5)], 0);
    expect(types(g.touches([], TAP_MS + 1))).toEqual(['end']);
  });

  it('a held still finger is a long-press, then nothing until it lifts', () => {
    const g = new DrawGesture();
    expect(g.longPress(0)).toEqual([]);
    g.touches([t(1, 5, 5)], 0);
    expect(g.longPress(LONG_PRESS_MS - 1)).toEqual([]);
    expect(g.longPress(LONG_PRESS_MS)).toEqual([
      { type: 'cancel' },
      { type: 'long-press', at: [5, 5] },
    ]);
    expect(g.phase).toBe('spent');
    expect(g.touches([t(1, 50, 50)], LONG_PRESS_MS + 10)).toEqual([]);
    expect(g.touches([], LONG_PRESS_MS + 20)).toEqual([]);
    expect(g.phase).toBe('idle');
  });

  it('a second finger cancels the stroke and moves the map', () => {
    const g = new DrawGesture();
    g.touches([t(1, 0, 0)], 0);
    g.touches([t(1, 20, 0)], 10);
    expect(g.touches([t(1, 20, 0), t(2, 100, 0)], 20)).toEqual([
      { type: 'cancel' },
      { type: 'pinch-start', a: [20, 0], b: [100, 0] },
    ]);
    expect(g.touches([t(2, 110, 0), t(1, 30, 0)], 30)).toEqual([
      { type: 'pinch-move', a: [30, 0], b: [110, 0] },
    ]);
    // A finger swap (a third finger replaces one): a fresh pinch.
    expect(types(g.touches([t(1, 30, 0), t(3, 90, 0)], 40))).toEqual(['pinch-end', 'pinch-start']);
    // One lifts: the map stops, and the other never starts a stroke.
    expect(g.touches([t(1, 30, 0)], 50)).toEqual([{ type: 'pinch-end' }]);
    expect(g.touches([t(1, 60, 0)], 60)).toEqual([]);
    expect(g.touches([], 70)).toEqual([]);
  });

  it('two fingers at once never draw; all lifting together ends the pinch', () => {
    const g = new DrawGesture();
    expect(types(g.touches([t(1, 0, 0), t(2, 10, 0)], 0))).toEqual(['pinch-start']);
    expect(g.touches([], 5)).toEqual([{ type: 'pinch-end' }]);
  });

  it('resets from any phase', () => {
    const g = new DrawGesture();
    expect(g.reset()).toEqual([]);
    g.touches([t(1, 0, 0)], 0);
    expect(g.reset()).toEqual([{ type: 'cancel' }]);
    g.touches([t(1, 0, 0), t(2, 1, 1)], 0);
    expect(g.reset()).toEqual([{ type: 'pinch-end' }]);
    expect(g.phase).toBe('idle');
  });
});
