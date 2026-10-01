import { analyzeOuting } from '@core/geo/track';
import { walk } from '@core/geo/track/__fixtures__/walk';
import { jumpMarks } from './TrailScrubber';

describe('jumpMarks', () => {
  it('offers Start · Steepest · Summit · End on a climb', () => {
    const pts = walk(
      [
        { m: 1000, s: 1000, rise: 200 },
        { m: 1000, s: 1000, rise: -200 },
      ],
      { stepS: 10 },
    );
    const marks = jumpMarks(analyzeOuting(pts, { splitUnitM: 1000 }));
    expect(marks.map((m) => m.label)).toEqual(['Start', 'Steepest', 'Summit', 'End']);
    expect(marks[2]!.distanceM).toBeCloseTo(1000, -1);
    expect(marks[3]!.distanceM).toBeCloseTo(2000, 0);
  });

  it('offers only Start and End on a flat walk, nothing before the analysis', () => {
    const pts = walk([{ m: 2000, s: 2000, rise: 5 }]);
    expect(jumpMarks(analyzeOuting(pts, { splitUnitM: 1000 })).map((m) => m.id)).toEqual([
      'start',
      'end',
    ]);
    expect(jumpMarks(null)).toEqual([]);
  });
});
