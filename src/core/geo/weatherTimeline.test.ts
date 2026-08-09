import type { WmsTimeDimension } from './weatherLayers';
import {
  clampFrameIndex,
  daySegments,
  defaultTimeline,
  FORECAST_HORIZON_MS,
  FORECAST_STEP_MS,
  floorToStep,
  formatTimelineLabel,
  isHourMark,
  MAX_TIMELINE_FRAMES,
  nearestFrameIndex,
  RADAR_PUBLISH_LAG_MS,
  RADAR_STEP_MS,
  RADAR_WINDOW_MS,
  SCRUB_THROTTLE_MS,
  throttleGate,
  timelineFromDimension,
  WEEKDAY_LABELS,
  wmsTimeParam,
  type WeatherTimeline,
} from './weatherTimeline';

// The dimensions verified live against GeoMet on 2026-08-09:
// HRDPS.CONTINENTAL_TT/UU  2026-08-09T00:00Z → 2026-08-11T00:00Z / PT1H
// RADAR_1KM_RRAI/RSNO      2026-08-09T01:48Z → 2026-08-09T04:48Z / PT6M
const NOW = Date.parse('2026-08-09T04:53:21Z');

const HRDPS_DIM: WmsTimeDimension = {
  startMs: Date.parse('2026-08-09T00:00:00Z'),
  endMs: Date.parse('2026-08-11T00:00:00Z'),
  stepMs: FORECAST_STEP_MS,
  defaultTime: '2026-08-09T04:00:00Z',
};

const RADAR_DIM: WmsTimeDimension = {
  startMs: Date.parse('2026-08-09T01:48:00Z'),
  endMs: Date.parse('2026-08-09T04:48:00Z'),
  stepMs: RADAR_STEP_MS,
  defaultTime: '2026-08-09T04:48:00Z',
};

describe('floorToStep', () => {
  it('floors to epoch-anchored steps', () => {
    expect(floorToStep(Date.parse('2026-08-09T04:53:21Z'), FORECAST_STEP_MS)).toBe(
      Date.parse('2026-08-09T04:00:00Z'),
    );
    expect(floorToStep(Date.parse('2026-08-09T04:53:21Z'), RADAR_STEP_MS)).toBe(
      Date.parse('2026-08-09T04:48:00Z'),
    );
    // Radar's real frame times (…T01:48Z etc.) sit on the epoch-anchored grid.
    expect(floorToStep(RADAR_DIM.startMs, RADAR_STEP_MS)).toBe(RADAR_DIM.startMs);
  });
});

describe('defaultTimeline (the zero-network clock guess)', () => {
  it('builds a past radar window ending behind the publish lag', () => {
    const tl = defaultTimeline('past', NOW);
    expect(tl.kind).toBe('past');
    expect(tl.fromCapabilities).toBe(false);
    const last = tl.framesMs[tl.framesMs.length - 1];
    expect(last).toBe(floorToStep(NOW - RADAR_PUBLISH_LAG_MS, RADAR_STEP_MS));
    expect((last ?? 0) - (tl.framesMs[0] ?? 0)).toBe(RADAR_WINDOW_MS);
    expect(tl.framesMs).toHaveLength(RADAR_WINDOW_MS / RADAR_STEP_MS + 1); // 31
  });

  it('builds a forecast window from the floored now to the horizon', () => {
    const tl = defaultTimeline('forecast', NOW);
    expect(tl.kind).toBe('forecast');
    expect(tl.framesMs[0]).toBe(Date.parse('2026-08-09T04:00:00Z'));
    expect(tl.framesMs[tl.framesMs.length - 1]).toBe(
      Date.parse('2026-08-09T04:00:00Z') + FORECAST_HORIZON_MS,
    );
    expect(tl.framesMs).toHaveLength(FORECAST_HORIZON_MS / FORECAST_STEP_MS + 1); // 49
  });

  it('spaces frames exactly one step apart, ascending', () => {
    for (const tl of [defaultTimeline('past', NOW), defaultTimeline('forecast', NOW)]) {
      const step = tl.kind === 'past' ? RADAR_STEP_MS : FORECAST_STEP_MS;
      for (let i = 1; i < tl.framesMs.length; i++) {
        expect((tl.framesMs[i] ?? 0) - (tl.framesMs[i - 1] ?? 0)).toBe(step);
      }
    }
  });
});

describe('timelineFromDimension', () => {
  it('keeps the full past window for radar', () => {
    const frames = timelineFromDimension(RADAR_DIM, 'past', NOW)?.framesMs ?? [];
    expect(timelineFromDimension(RADAR_DIM, 'past', NOW)?.fromCapabilities).toBe(true);
    expect(frames[0]).toBe(RADAR_DIM.startMs);
    expect(frames[frames.length - 1]).toBe(RADAR_DIM.endMs);
    expect(frames).toHaveLength(31);
  });

  it('clamps a forecast start to "now" — run hours already lived through are not forecast', () => {
    const frames = timelineFromDimension(HRDPS_DIM, 'forecast', NOW)?.framesMs ?? [];
    expect(frames[0]).toBe(Date.parse('2026-08-09T04:00:00Z'));
    expect(frames[frames.length - 1]).toBe(HRDPS_DIM.endMs);
    expect(frames).toHaveLength(45); // 04:00Z → next-day 00:00Z, hourly
  });

  it('keeps the full window when now precedes the run start', () => {
    const tl = timelineFromDimension(HRDPS_DIM, 'forecast', HRDPS_DIM.startMs - 3_600_000);
    expect(tl?.framesMs[0]).toBe(HRDPS_DIM.startMs);
  });

  it('keeps what the server offers when the run has gone stale (now past the horizon)', () => {
    const frames =
      timelineFromDimension(HRDPS_DIM, 'forecast', HRDPS_DIM.endMs + 3_600_000)?.framesMs ?? [];
    expect(frames[0]).toBe(HRDPS_DIM.startMs);
    expect(frames[frames.length - 1]).toBe(HRDPS_DIM.endMs);
  });

  it('caps a junk dimension at MAX_TIMELINE_FRAMES', () => {
    const junk: WmsTimeDimension = { ...RADAR_DIM, stepMs: 1_000 };
    const tl = timelineFromDimension(junk, 'past', NOW);
    expect(tl?.framesMs.length).toBe(MAX_TIMELINE_FRAMES);
  });

  it.each([
    ['zero step', { ...RADAR_DIM, stepMs: 0 }],
    ['end before start', { ...RADAR_DIM, endMs: RADAR_DIM.startMs - 1 }],
    ['a single-frame window', { ...RADAR_DIM, startMs: RADAR_DIM.endMs }],
  ])('returns null on %s (caller stays on the clock guess)', (_name, dim) => {
    expect(timelineFromDimension(dim, 'past', NOW)).toBeNull();
  });
});

describe('frame selection', () => {
  const tl = timelineFromDimension(RADAR_DIM, 'past', NOW) as WeatherTimeline;

  it('finds the nearest frame index', () => {
    expect(nearestFrameIndex(tl, RADAR_DIM.startMs)).toBe(0);
    expect(nearestFrameIndex(tl, RADAR_DIM.endMs)).toBe(30);
    expect(nearestFrameIndex(tl, RADAR_DIM.startMs + RADAR_STEP_MS + 60_000)).toBe(1);
    // Far outside the window clamps to the nearest edge.
    expect(nearestFrameIndex(tl, 0)).toBe(0);
    expect(nearestFrameIndex(tl, RADAR_DIM.endMs + 86_400_000)).toBe(30);
  });

  it('clamps and rounds raw indices', () => {
    expect(clampFrameIndex(tl, -3)).toBe(0);
    expect(clampFrameIndex(tl, 12.6)).toBe(13);
    expect(clampFrameIndex(tl, 999)).toBe(30);
  });
});

describe('wmsTimeParam', () => {
  it('pins explicit frames for capabilities-backed timelines', () => {
    const tl = timelineFromDimension(RADAR_DIM, 'past', NOW) as WeatherTimeline;
    expect(wmsTimeParam(tl, 30)).toBe('2026-08-09T04:48:00Z');
    expect(wmsTimeParam(tl, 0)).toBe('2026-08-09T01:48:00Z');
  });

  it('hands the newest tick of a clock-GUESSED radar timeline to the server default', () => {
    const tl = defaultTimeline('past', NOW);
    expect(wmsTimeParam(tl, tl.framesMs.length - 1)).toBeUndefined();
    expect(wmsTimeParam(tl, tl.framesMs.length - 2)).toBeDefined();
  });

  it('always pins guessed FORECAST frames (the hour grid is safe to name)', () => {
    const tl = defaultTimeline('forecast', NOW);
    expect(wmsTimeParam(tl, 0)).toBe('2026-08-09T04:00:00Z');
    expect(wmsTimeParam(tl, tl.framesMs.length - 1)).toBeDefined();
  });

  it('clamps out-of-range indices instead of throwing', () => {
    const tl = defaultTimeline('forecast', NOW);
    expect(wmsTimeParam(tl, -5)).toBe(wmsTimeParam(tl, 0));
    expect(wmsTimeParam(tl, 999)).toBe(wmsTimeParam(tl, tl.framesMs.length - 1));
  });
});

describe('throttleGate', () => {
  it('emits immediately when never emitted', () => {
    expect(throttleGate(null, 1_000, SCRUB_THROTTLE_MS)).toEqual({ emit: true, waitMs: 0 });
  });

  it('emits once the interval has passed', () => {
    expect(throttleGate(1_000, 1_300, 300)).toEqual({ emit: true, waitMs: 0 });
    expect(throttleGate(1_000, 2_000, 300)).toEqual({ emit: true, waitMs: 0 });
  });

  it('reports the trailing-edge wait inside the interval', () => {
    expect(throttleGate(1_000, 1_100, 300)).toEqual({ emit: false, waitMs: 200 });
    expect(throttleGate(1_000, 1_299, 300)).toEqual({ emit: false, waitMs: 1 });
  });
});

describe('formatTimelineLabel / day ticks (device-local time)', () => {
  // Build times via the LOCAL Date constructor so expectations hold in any TZ.
  const localMs = (y: number, mo: number, d: number, h: number, min = 0): number =>
    new Date(y, mo, d, h, min).getTime();

  it('reads "Sat 14:00" style labels', () => {
    const ms = localMs(2026, 7, 8, 14, 0); // 2026-08-08 is a Saturday
    expect(formatTimelineLabel(ms)).toBe('Sat 14:00');
    expect(formatTimelineLabel(localMs(2026, 7, 9, 6, 5))).toBe('Sun 06:05');
  });

  it('exposes seven weekday labels', () => {
    expect(WEEKDAY_LABELS).toHaveLength(7);
  });

  it('groups frames into local calendar-day segments', () => {
    const frames = [
      localMs(2026, 7, 8, 22),
      localMs(2026, 7, 8, 23),
      localMs(2026, 7, 9, 0),
      localMs(2026, 7, 9, 1),
      localMs(2026, 7, 9, 2),
    ];
    expect(daySegments(frames)).toEqual([
      { startIdx: 0, endIdx: 1, label: 'Sat' },
      { startIdx: 2, endIdx: 4, label: 'Sun' },
    ]);
  });

  it('yields a single segment when nothing crosses midnight', () => {
    const frames = [localMs(2026, 7, 8, 10), localMs(2026, 7, 8, 11)];
    expect(daySegments(frames)).toHaveLength(1);
    expect(daySegments([])).toEqual([]);
  });

  it('marks whole local hours', () => {
    expect(isHourMark(localMs(2026, 7, 8, 14, 0))).toBe(true);
    expect(isHourMark(localMs(2026, 7, 8, 14, 6))).toBe(false);
  });
});
