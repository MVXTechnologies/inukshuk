import { lineTrack, offset, outAndBack, T0 } from './__fixtures__/tracks';
import {
  adjustedTime,
  clockResidualM,
  describeClock,
  estimateClockOffset,
  formatOffsetMagnitude,
  MAX_CLOCK_OFFSET_MS,
  median,
  stepClockOffset,
  type ClockSample,
} from './clock';
import { indexTrack } from './trackIndex';

const MIN = 60_000;
const HOUR = 60 * MIN;

// A 5-hour walk at 0.5 m/s: long enough for zone mistakes to land inside it.
const idx = indexTrack(lineTrack({ lengthM: 9000, secPerM: 2 }));
const at = (m: number) => T0 + m * 2000;

/** Photos every 700 m with GPS jitter, their EXIF time shifted by `skewMs`. */
function samples(
  skewMs: number,
  jitter = [3, -8, 12, -4, 6, -15, 2, 9, -6, 11, -3, 5],
): ClockSample[] {
  return jitter.map((j, i) => {
    const m = 400 + i * 700;
    return { takenAt: at(m) - skewMs, lngLat: offset(m, j) };
  });
}

describe('estimateClockOffset', () => {
  it('says ok when the clock agrees', () => {
    const e = estimateClockOffset(idx, samples(0));
    expect(e.status).toBe('ok');
    expect(e.offsetMs).toBe(0);
    expect(e.medianResidualM!).toBeLessThan(15);
    expect(e.samples).toBe(12);
  });

  it.each([
    ['an hour behind (camera on standard time)', HOUR],
    ['an hour ahead', -HOUR],
    ['3 h behind (left on Pacific time)', 3 * HOUR],
    ['drifted 7 minutes fast', -7 * MIN],
    ['a zone and a drift at once', 2 * HOUR + 4 * MIN],
  ])('recovers a camera %s', (_label, skew) => {
    const e = estimateClockOffset(idx, samples(skew));
    expect(e.status).toBe('corrected');
    expect(e.offsetMs).toBe(skew);
    expect(e.medianResidualM!).toBeLessThan(75);
  });

  it('needs at least three photos with time and GPS', () => {
    expect(estimateClockOffset(idx, samples(HOUR).slice(0, 2))).toEqual({
      status: 'unknown',
      offsetMs: 0,
      samples: 2,
    });
  });

  it('is unknown on an untimed route', () => {
    const route = indexTrack(lineTrack({ lengthM: 9000, untimed: true }));
    expect(estimateClockOffset(route, samples(0)).status).toBe('unknown');
  });

  it('is unknown when no offset explains the photos (they are elsewhere)', () => {
    const elsewhere = samples(0).map((s) => ({ ...s, lngLat: offset(4000, 5000) }));
    const e = estimateClockOffset(idx, elsewhere);
    expect(e.status).toBe('unknown');
    expect(e.offsetMs).toBe(0);
    expect(e.medianResidualM!).toBeGreaterThan(1000);
  });

  it('prefers the smaller offset when an out-and-back makes two fit', () => {
    // Photos at the turnaround fit "0" and also nearby offsets; 0 must win.
    const oab = indexTrack(outAndBack({ lengthM: 2000, pauseS: 0 }));
    const turn = [-30, -10, 0, 10, 30].map((s) => ({
      takenAt: T0 + 2_000_000 + s * 1000,
      lngLat: offset(2000 - Math.abs(s), 2),
    }));
    expect(estimateClockOffset(oab, turn).offsetMs).toBe(0);
  });
});

describe('clockResidualM', () => {
  it('is Infinity when most photos fall outside the recording at that offset', () => {
    expect(clockResidualM(idx, samples(0), 6 * HOUR)).toBe(Infinity);
  });
});

describe('median', () => {
  it('handles odd, even and empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});

describe('Adjust maths', () => {
  it('steps in minutes and hours, snapping to whole minutes', () => {
    expect(stepClockOffset(0, '+1m')).toBe(MIN);
    expect(stepClockOffset(0, '-1h')).toBe(-HOUR);
    expect(stepClockOffset(30_000, '+1m')).toBe(2 * MIN); // 1.5 min → snaps
    expect(stepClockOffset(HOUR + MIN, '-1m')).toBe(HOUR);
  });

  it('clamps to ±14 h', () => {
    expect(stepClockOffset(MAX_CLOCK_OFFSET_MS, '+1h')).toBe(MAX_CLOCK_OFFSET_MS);
    expect(stepClockOffset(-MAX_CLOCK_OFFSET_MS, '-1m')).toBe(-MAX_CLOCK_OFFSET_MS);
  });

  it('adds the offset to the EXIF time', () => {
    expect(adjustedTime(T0, HOUR)).toBe(T0 + HOUR);
  });
});

describe('describeClock', () => {
  it('reads like the sheet', () => {
    expect(describeClock({ status: 'ok', offsetMs: 0 })).toBe('Camera clock matches your GPS');
    expect(describeClock({ status: 'corrected', offsetMs: HOUR })).toBe(
      'Camera clock is 1 h behind',
    );
    expect(describeClock({ status: 'corrected', offsetMs: -(HOUR + 3 * MIN) })).toBe(
      'Camera clock is 1 h 3 min ahead',
    );
    expect(describeClock({ status: 'corrected', offsetMs: 45 * MIN })).toBe(
      'Camera clock is 45 min behind',
    );
    expect(describeClock({ status: 'unknown', offsetMs: 0 })).toBe('Camera clock not checked');
    expect(describeClock({ status: 'corrected', offsetMs: 10_000 })).toBe(
      'Camera clock matches your GPS',
    );
  });

  it('formats magnitudes', () => {
    expect(formatOffsetMagnitude(2 * HOUR)).toBe('2 h');
    expect(formatOffsetMagnitude(-5 * MIN)).toBe('5 min');
  });
});
