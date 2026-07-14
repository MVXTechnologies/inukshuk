import type { TrackPoint } from '@core/models';
import { mergeTrackPoints } from './mergePoints';

const pt = (time: number, over: Partial<TrackPoint> = {}): TrackPoint => ({
  latitude: 46.8,
  longitude: -71.2,
  time,
  ...over,
});

const times = (points: TrackPoint[]) => points.map((p) => p.time);

describe('mergeTrackPoints', () => {
  it('returns base by reference when incoming is empty', () => {
    const base = [pt(1000), pt(2000)];
    expect(mergeTrackPoints(base, [])).toBe(base);
  });

  it('returns base by reference when every incoming timestamp is already recorded', () => {
    const base = [pt(1000), pt(2000)];
    expect(mergeTrackPoints(base, [pt(2000), pt(1000)])).toBe(base);
  });

  it('appends newer incoming points in time order', () => {
    const base = [pt(1000), pt(2000)];
    const merged = mergeTrackPoints(base, [pt(4000), pt(3000)]);
    expect(times(merged)).toEqual([1000, 2000, 3000, 4000]);
  });

  it('interleaves incoming points that fall between base points', () => {
    const base = [pt(1000), pt(4000)];
    const merged = mergeTrackPoints(base, [pt(3000), pt(2000)]);
    expect(times(merged)).toEqual([1000, 2000, 3000, 4000]);
  });

  it('handles an empty base (pure background segment)', () => {
    const merged = mergeTrackPoints([], [pt(2000), pt(1000)]);
    expect(times(merged)).toEqual([1000, 2000]);
  });

  it('base wins timestamp ties over incoming', () => {
    const base = [pt(1000, { altitude: 100 })];
    const merged = mergeTrackPoints(base, [pt(1000, { altitude: 999 })]);
    expect(merged).toBe(base);
    expect(merged[0]?.altitude).toBe(100);
  });

  it('dedupes duplicate timestamps within incoming, first occurrence wins', () => {
    const merged = mergeTrackPoints(
      [],
      [pt(1000, { altitude: 1 }), pt(1000, { altitude: 2 }), pt(2000)],
    );
    expect(times(merged)).toEqual([1000, 2000]);
    expect(merged[0]?.altitude).toBe(1);
  });

  it('does not mutate its inputs', () => {
    const base = [pt(1000), pt(3000)];
    const incoming = [pt(4000), pt(2000)];
    mergeTrackPoints(base, incoming);
    expect(times(base)).toEqual([1000, 3000]);
    expect(times(incoming)).toEqual([4000, 2000]);
  });

  describe('accept gate', () => {
    it('applies the gate to incoming points only, never to base points', () => {
      const base = [pt(1000), pt(2000)];
      const rejectAll = jest.fn(() => false);
      const merged = mergeTrackPoints(base, [pt(3000)], { accept: rejectAll });
      expect(merged).toBe(base); // base untouched, novel point rejected
      expect(rejectAll).toHaveBeenCalledTimes(1);
    });

    it('passes the actual predecessor in the merged output to the gate', () => {
      const seenPrev: (number | undefined)[] = [];
      const accept = (prev: TrackPoint | undefined, _next: TrackPoint) => {
        seenPrev.push(prev?.time);
        return true;
      };
      // 1500 lands after base 1000; 2500 lands after base 2000; 3000 lands
      // after the just-accepted 2500.
      mergeTrackPoints([pt(1000), pt(2000)], [pt(3000), pt(1500), pt(2500)], { accept });
      expect(seenPrev).toEqual([1000, 2000, 2500]);
    });

    it('sees undefined prev for the first point of an empty base', () => {
      const seenPrev: (number | undefined)[] = [];
      const accept = (prev: TrackPoint | undefined) => {
        seenPrev.push(prev?.time);
        return true;
      };
      mergeTrackPoints([], [pt(1000)], { accept });
      expect(seenPrev).toEqual([undefined]);
    });

    it('a rejected point is not the predecessor of the next candidate', () => {
      // Reject 2000; 3000 must then be gated against 1000, not 2000.
      const seenPrev: (number | undefined)[] = [];
      const accept = (prev: TrackPoint | undefined, next: TrackPoint) => {
        seenPrev.push(prev?.time);
        return next.time !== 2000;
      };
      const merged = mergeTrackPoints([pt(1000)], [pt(2000), pt(3000)], { accept });
      expect(times(merged)).toEqual([1000, 3000]);
      expect(seenPrev).toEqual([1000, 1000]);
    });
  });
});
