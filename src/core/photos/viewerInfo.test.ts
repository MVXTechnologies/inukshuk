import { createFormatters } from '@core/format';

import {
  climbedUpTo,
  directionAt,
  elevationAt,
  photoFacts,
  provenanceText,
  sinceStartText,
  viewerInfoText,
  type ViewerTrail,
} from './viewerInfo';

// An out-and-back: up 0 → 1000 m (500 → 600 m elevation), back down to 2000 m.
const cum = Array.from({ length: 21 }, (_, i) => i * 100);
const ele = cum.map((d) => (d <= 1000 ? 500 + d / 10 : 600 - (d - 1000) / 10));
const trail: ViewerTrail = { axisCumM: cum, elevations: ele, totalM: 2000, startMs: 1_000_000 };

describe('elevationAt', () => {
  it('interpolates and clamps', () => {
    expect(elevationAt(trail, 250)).toBeCloseTo(525);
    expect(elevationAt(trail, -10)).toBe(500);
    expect(elevationAt(trail, 5000)).toBe(500);
  });

  it('copes with missing altitudes and empty trails', () => {
    const gaps: ViewerTrail = { ...trail, elevations: [undefined, 510, undefined] };
    expect(elevationAt(gaps, 50)).toBe(510);
    expect(elevationAt(gaps, 150)).toBe(510);
    expect(elevationAt({ ...trail, axisCumM: [], elevations: [] }, 10)).toBeUndefined();
    expect(elevationAt({ ...trail, axisCumM: [0, 0], elevations: [1, 2] }, 0)).toBe(2);
  });
});

describe('climbedUpTo', () => {
  it('counts the climb so far, not the descent', () => {
    expect(climbedUpTo(trail, 500)).toBeCloseTo(50);
    expect(climbedUpTo(trail, 1500)).toBeCloseTo(100);
  });

  it('ignores noise under the threshold', () => {
    const noisy: ViewerTrail = {
      axisCumM: [0, 1, 2, 3, 4],
      elevations: [500, 502, 500, 502, 500],
      totalM: 4,
    };
    expect(climbedUpTo(noisy, 4)).toBe(0);
  });

  it('counts a rise ending between two points', () => {
    const step: ViewerTrail = { axisCumM: [0, 100], elevations: [500, 520], totalM: 100 };
    expect(climbedUpTo(step, 50)).toBeCloseTo(10);
  });
});

describe('directionAt', () => {
  it('tells the way up from the way down', () => {
    expect(directionAt(trail, 400)).toBe('up');
    expect(directionAt(trail, 1600)).toBe('down');
  });

  it('says nothing on the level or without altitude', () => {
    const flat: ViewerTrail = { ...trail, elevations: cum.map(() => 500) };
    expect(directionAt(flat, 400)).toBeNull();
    expect(directionAt({ ...trail, elevations: [] }, 400)).toBeNull();
  });
});

describe('photoFacts', () => {
  it('measures a photo on the axis', () => {
    // The photo anchor's own axis has a 1000 m pause gap after point 5.
    const indexCum = cum.map((d) => (d > 500 ? d + 1000 : d));
    const facts = photoFacts(
      { distanceM: 1700, takenAt: 1_000_000 + 81 * 60_000 },
      trail,
      indexCum,
    );
    expect(facts.distanceM).toBeCloseTo(700);
    expect(facts.elevationM).toBeCloseTo(570);
    expect(facts.climbedM).toBeCloseTo(70);
    expect(facts.direction).toBe('up');
    expect(facts.sinceStartMs).toBe(81 * 60_000);
  });

  it('leaves out what it cannot know', () => {
    const facts = photoFacts(
      { distanceM: 100, takenAt: 5 },
      { axisCumM: cum, elevations: [], totalM: 2000 },
      cum,
    );
    expect(facts).toEqual({ distanceM: 100, direction: null });
    expect(
      photoFacts({ distanceM: 100, elevationM: 42 }, { ...trail, elevations: [] }, cum),
    ).toMatchObject({ elevationM: 42 });
  });
});

describe('texts', () => {
  it('says how long after the start', () => {
    expect(sinceStartText(20_000)).toBe('at the start');
    expect(sinceStartText(12 * 60_000)).toBe('12 min after the start');
    expect(sinceStartText(81 * 60_000)).toBe('1 h 21 after the start');
    expect(sinceStartText(125 * 60_000)).toBe('2 h 05 after the start');
  });

  it('says how the photo was placed', () => {
    expect(provenanceText('time')).toBe('Placed on the trail by its time');
    expect(provenanceText('gps')).toBe('Placed on the trail by its location');
    expect(provenanceText('capture')).toBe('Taken during the recording');
    expect(provenanceText('manual')).toBe('Placed by hand');
    expect(provenanceText('manual', true)).toBe('From a trail note');
  });

  it('formats the info sheet', () => {
    const fmt = createFormatters('metric');
    const text = viewerInfoText(
      { caption: 'Lac des Cygnes appears', takenAt: 9, placement: 'time' },
      {
        distanceM: 3200,
        elevationM: 830,
        climbedM: 305,
        direction: 'up',
        sinceStartMs: 81 * 60_000,
      },
      { number: 11, totalM: 9020, fmt, formatWhen: () => 'Sun 27 Sep 2026 · 10:32' },
    );
    expect(text).toEqual({
      title: 'Lac des Cygnes appears',
      when: 'Sun 27 Sep 2026 · 10:32 · 1 h 21 after the start',
      distance: '3.20 km',
      distanceSub: 'of 9.02 km · going up',
      elevation: '830 m',
      climbed: '+305 m',
      provenance: 'Placed on the trail by its time',
    });
  });

  it('falls back for a timeless photo without elevation', () => {
    const text = viewerInfoText(
      { placement: 'gps' },
      { distanceM: 3200, direction: 'down' },
      { number: 4, totalM: 9020, fmt: createFormatters('metric'), formatWhen: () => 'x' },
    );
    expect(text).toMatchObject({
      title: 'Photo 4',
      when: '',
      distanceSub: 'of 9.02 km · on the way down',
      elevation: null,
      climbed: null,
    });
    expect(
      viewerInfoText(
        { placement: 'gps', caption: '  ' },
        { distanceM: 0, direction: null },
        { number: 1, totalM: 10, fmt: createFormatters('metric'), formatWhen: () => 'x' },
      ).distanceSub,
    ).toBe('of 10 m');
  });
});
