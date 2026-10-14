import { ageText, durationText, lifeText, navTarget, SHAPE_NAMES, whereText } from './card';
import type { Pt } from './geo';
import { NEAR, QC } from './testUtils';

const MIN = 60_000;

describe('a shape’s card', () => {
  it('names every kind', () => {
    expect(Object.values(SHAPE_NAMES)).toEqual(['pencil line', 'arrow', 'circle', 'rectangle']);
  });

  it('navigates to an arrow’s head, a circle’s or rectangle’s centre, a line’s end', () => {
    expect(navTarget({ sh: 'arrow', pts: [QC, NEAR] })).toEqual(NEAR);
    expect(navTarget({ sh: 'circle', pts: [QC] })).toEqual(QC);
    expect(navTarget({ sh: 'rect', pts: [QC] })).toBeNull();
    expect(navTarget({ sh: 'free', pts: [] })).toBeNull();
    expect(navTarget({ sh: 'free', pts: [QC, NEAR] })).toEqual(NEAR);
    const rect: Pt[] = [
      [0, 0],
      [2, 0],
      [2, 4],
      [0, 4],
    ];
    expect(navTarget({ sh: 'rect', pts: rect })).toEqual([1, 2]);
  });

  it('says durations short, or exact for the menu', () => {
    expect(durationText(-5)).toBe('0 s');
    expect(durationText(45_000)).toBe('45 s');
    expect(durationText(28 * MIN)).toBe('28 min');
    expect(durationText(4 * MIN + 10_000, true)).toBe('4 min 10 s');
    expect(durationText(4 * MIN, true)).toBe('4 min');
    expect(durationText(130 * MIN)).toBe('2 h 10 min');
    expect(durationText(240 * MIN)).toBe('4 h');
  });

  it('says how old it is', () => {
    expect(ageText(1000, 1000 + 30_000)).toBe('Drawn just now');
    expect(ageText(0, 2 * MIN)).toBe('Drawn 2 min ago');
  });

  it('gives the life bar and the time left', () => {
    expect(lifeText({ created: 0, expires: null }, 5)).toEqual({
      left: null,
      text: 'Never fades',
      of: null,
    });
    expect(lifeText({ created: 0, expires: 30 * MIN }, 2 * MIN)).toEqual({
      left: 28 / 30,
      text: 'Fades in 28 min',
      of: 'of 30 min',
    });
    expect(lifeText({ created: 0, expires: 30 * MIN }, 40 * MIN).left).toBe(0);
    expect(lifeText({ created: 0, expires: 5 * MIN }, 50_000, true).text).toBe(
      'Fades in 4 min 10 s',
    );
  });

  it('says where the target is from me', () => {
    expect(whereText({ sh: 'arrow', pts: [QC, NEAR] }, null, 'metric')).toBeNull();
    expect(whereText({ sh: 'arrow', pts: [QC, NEAR] }, QC, 'metric')).toBe(
      'head 1.01 km NE of you',
    );
    expect(whereText({ sh: 'circle', pts: [QC] }, QC, 'metric')).toBe('centre here');
  });
});

describe('navTarget without the points it needs', () => {
  it('is null', () => {
    expect(navTarget({ sh: 'arrow', pts: [QC] })).toBeNull();
    expect(navTarget({ sh: 'circle', pts: [] })).toBeNull();
    expect(navTarget({ sh: 'rect', pts: [] })).toBeNull();
  });
});
