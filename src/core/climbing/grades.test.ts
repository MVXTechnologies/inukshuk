import {
  autoGradeSystem,
  bandLabels,
  bandOf,
  gradeLabel,
  gradeRangeLabel,
  resolveGradeSystem,
  ROPE_FRENCH,
  ROPE_YDS,
  routeGrade,
} from './grades';

describe('grade ladders', () => {
  it('have one French grade per YDS step, as the NAS build', () => {
    expect(ROPE_YDS).toHaveLength(34);
    expect(ROPE_FRENCH).toHaveLength(34);
    expect(ROPE_YDS[10]).toBe('5.10a');
    expect(ROPE_YDS[33]).toBe('5.15d');
  });

  it('labels each discipline in each system', () => {
    expect(gradeLabel('r', 10, 'yds')).toBe('5.10a');
    expect(gradeLabel('r', 10, 'french')).toBe('6a');
    expect(gradeLabel('r', 17, 'french')).toBe('7a');
    expect(gradeLabel('r', 23, 'french')).toBe('8a');
    expect(gradeLabel('b', -1, 'yds')).toBe('VB');
    expect(gradeLabel('b', 6, 'yds')).toBe('V6');
    expect(gradeLabel('b', 6, 'french')).toBe('7a');
    expect(gradeLabel('i', 4, 'french')).toBe('WI4');
    expect(gradeLabel('r', 40, 'yds')).toBeNull();
    expect(gradeLabel('i', 9, 'yds')).toBeNull();
    expect(gradeLabel('b', 1.5, 'yds')).toBeNull();
  });

  it('bands ropes, boulders and ice', () => {
    expect([7, 8, 13, 14, 17, 18].map((x) => bandOf('r', x))).toEqual([0, 1, 1, 2, 2, 3]);
    expect([-1, 3, 6, 9].map((x) => bandOf('b', x))).toEqual([0, 1, 2, 3]);
    expect([3, 4, 5, 6].map((x) => bandOf('i', x))).toEqual([0, 1, 2, 3]);
    expect(bandLabels('yds')).toEqual(['≤ 5.7', '5.8–5.10', '5.11', '5.12+']);
    expect(bandLabels('french')[0]).toBe('≤ 5a');
  });

  it('formats ranges', () => {
    expect(gradeRangeLabel('r', [4, 22], 'yds')).toBe('5.4 – 5.13a');
    expect(gradeRangeLabel('r', [10, 10], 'french')).toBe('6a');
    expect(gradeRangeLabel('r', [10, 99], 'yds')).toBe('5.10a');
  });
});

describe('routeGrade', () => {
  it('shows the source string when it is the user system', () => {
    expect(routeGrade({ g: '5.10a/b', gs: 'yds', k: 'r', x: 10 }, 'yds')).toEqual({
      text: '5.10a/b',
      band: 1,
      note: null,
    });
    expect(routeGrade({ g: 'V3', gs: 'v', k: 'b', x: 3 }, 'yds')?.text).toBe('V3');
    expect(routeGrade({ g: '6b', gs: 'font', k: 'b', x: 4 }, 'french')?.text).toBe('6b');
  });

  it('converts with a note otherwise (mockup 03: "UIAA 4+ in OSM")', () => {
    expect(routeGrade({ g: '4+', gs: 'uiaa', k: 'r', x: 5 }, 'yds', 'OSM')).toEqual({
      text: '5.5',
      band: 0,
      note: 'UIAA 4+ in OSM',
    });
    expect(routeGrade({ g: '5.11d', gs: 'yds', k: 'r', x: 17 }, 'french')).toEqual({
      text: '7a',
      band: 2,
      note: 'YDS 5.11d',
    });
    expect(routeGrade({ g: 'WI4', gs: 'wi', k: 'i', x: 4 }, 'yds')?.note).toBeNull();
  });

  it('keeps grades it cannot place, and says nothing without one', () => {
    expect(routeGrade({ g: 'VIIb', gs: 'saxon' }, 'yds')).toEqual({
      text: 'VIIb',
      band: null,
      note: 'Saxon grade',
    });
    expect(routeGrade({}, 'yds')).toBeNull();
  });
});

describe('the user system', () => {
  it('is YDS in North America and French elsewhere', () => {
    expect(autoGradeSystem({ latitude: 46.8, longitude: -71.2 })).toBe('yds');
    expect(autoGradeSystem({ latitude: 45.9, longitude: 6.9 })).toBe('french');
    expect(autoGradeSystem(null, 'CA')).toBe('yds');
    expect(autoGradeSystem(null, 'FR')).toBe('french');
    expect(autoGradeSystem(null)).toBe('french');
  });

  it('follows an explicit choice', () => {
    expect(resolveGradeSystem('french', { latitude: 46.8, longitude: -71.2 })).toBe('french');
    expect(resolveGradeSystem('auto', { latitude: 46.8, longitude: -71.2 })).toBe('yds');
  });
});
