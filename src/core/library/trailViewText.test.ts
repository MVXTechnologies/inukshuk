import type { Split, TimelineEvent, TrailTiming } from '@core/geo/track';
import {
  cursorReadout,
  formatGradePct,
  overviewTiles,
  splitRows,
  splitUnit,
  timelineEventText,
  trailSubtitle,
} from './trailViewText';

const timing: TrailTiming = {
  elapsedS: 4 * 3600 + 28 * 60,
  movingTimeS: 3 * 3600 + 42 * 60,
  display: 'pace',
  elapsedSpeedMps: 0.77,
  movingSpeedMps: 0.93,
};
const stats = { distanceM: 12_400, ascentM: 640, descentM: 630 };
const extremes = { highIndex: 1, lowIndex: 0, highM: 885, lowM: 230 };

describe('overviewTiles', () => {
  it('lists the six recorded-trail tiles', () => {
    const tiles = overviewTiles(stats, timing, extremes, 'metric');
    expect(tiles.map((t) => t.label)).toEqual([
      'Distance',
      'Climb / descent',
      'Moving time',
      'Moving pace',
      'Highest point',
      'Total time',
    ]);
    expect(tiles[0]!.value).toBe('12.40 km');
    expect(tiles[1]).toMatchObject({ value: '↑ 640 m', sub: '↓ 630 m' });
    expect(tiles[2]).toMatchObject({ value: '3:42:00', sub: 'of 4:28:00 total' });
    expect(tiles[3]!.value).toMatch(/\/km$/);
    expect(tiles[4]!.value).toBe('885 m');
  });

  it('gives the last slot to the average heart rate when there is one', () => {
    const tiles = overviewTiles(stats, timing, extremes, 'metric', 142);
    expect(tiles[5]).toEqual({ label: 'Avg heart rate', value: '142 bpm' });
    expect(overviewTiles(stats, null, extremes, 'metric', 120).map((t) => t.label)).toContain(
      'Avg heart rate',
    );
  });

  it('shows speed for a ride and imperial units', () => {
    const tiles = overviewTiles(stats, { ...timing, display: 'speed' }, extremes, 'imperial');
    expect(tiles[3]!.label).toBe('Moving speed');
    expect(tiles[3]!.value).toMatch(/mph$/);
    expect(tiles[4]!.value).toBe('2904 ft');
  });

  it('has no times for an untimed route', () => {
    const tiles = overviewTiles(stats, null, null, 'metric');
    expect(tiles.map((t) => t.label)).toEqual([
      'Distance',
      'Climb / descent',
      'Highest point',
      'Lowest point',
    ]);
    expect(tiles[2]!.value).toBe('—');
  });
});

const split = (over: Partial<Split>): Split => ({
  index: 0,
  distanceM: 1000,
  elapsedS: 600,
  movingS: 600,
  speedMps: 1,
  ascentM: 0,
  descentM: 0,
  partial: false,
  ...over,
});

describe('splitRows', () => {
  it('numbers whole splits, sizes the bar against the fastest, labels the partial one', () => {
    const rows = splitRows(
      [
        split({ index: 0, speedMps: 2, ascentM: 40 }),
        split({ index: 1, speedMps: 1, ascentM: 160 }),
        split({ index: 2, speedMps: 1.5, distanceM: 450, partial: true, descentM: 120 }),
      ],
      'metric',
      'pace',
    );
    expect(rows.map((r) => r.label)).toEqual(['1', '2', '0.45']);
    expect(rows[0]!.ratio).toBe(1);
    expect(rows[1]!.ratio).toBe(0.5);
    expect(rows[0]!.pace).toBe('8:20/km');
    expect(rows[1]!.climb).toBe('↑ 160 m');
    expect(rows[2]!.descent).toBe('↓ 120 m');
    expect(rows[2]!.net).toBe('↓ 120 m');
    expect(rows[1]!.net).toBe('↑ 160 m');
    expect(rows[1]!.a11y).toBe('Kilometre 2: 16:40/km, up 160 m, down 0 m');
    expect(rows[2]!.a11y).toMatch(/^Last 0.45 km/);
  });

  it('shows speed per mile for an imperial ride', () => {
    const rows = splitRows([split({ distanceM: 1609.344, speedMps: 5 })], 'imperial', 'speed');
    expect(rows[0]!.pace).toMatch(/mph$/);
    expect(rows[0]!.a11y).toMatch(/^Mile 1/);
  });

  it('gives an untimed route climb bars and no pace', () => {
    const rows = splitRows(
      [
        split({ speedMps: null, elapsedS: null, movingS: null, ascentM: 100 }),
        split({ index: 1, speedMps: null, elapsedS: null, movingS: null, ascentM: 0 }),
      ],
      'metric',
      'pace',
    );
    expect(rows[0]!.pace).toBeNull();
    expect(rows[0]!.ratio).toBe(1);
    expect(rows[1]!.ratio).toBe(0.06);
  });

  it('knows its units', () => {
    expect(splitUnit('metric')).toEqual({ unitM: 1000, label: 'km' });
    expect(splitUnit('imperial').label).toBe('mi');
  });
});

const at = (d: number, over: Partial<TimelineEvent['at']> = {}): TimelineEvent['at'] => ({
  latitude: 46.81234,
  longitude: -71.20567,
  distanceM: d,
  elevation: 230,
  time: new Date(2026, 8, 28, 9, 12).getTime(),
  ...over,
});
const totals = { distanceM: 12_400, timing };

describe('timelineEventText', () => {
  it('describes start, stops merged in, and the finish totals', () => {
    expect(timelineEventText({ kind: 'start', at: at(0) }, 'metric', totals)).toEqual({
      title: 'Start',
      sub: '230 m',
      time: expect.stringMatching(/9:12/),
    });
    const fin = timelineEventText(
      { kind: 'finish', at: at(12_400), stoppedS: 300, highPointM: 885 },
      'metric',
      totals,
    );
    expect(fin.title).toBe('Finish · high point 885 m');
    expect(fin.sub).toBe('12.40 km · moving 3:42:00 of 4:28:00 · Stopped 5 min');
  });

  it('falls back to coordinates for a start without elevation', () => {
    const t = timelineEventText(
      { kind: 'start', at: at(0, { elevation: undefined }) },
      'metric',
      totals,
    );
    expect(t.sub).toBe('46.8123, -71.2057');
  });

  it('titles a note with its first line and quotes the rest', () => {
    const t = timelineEventText(
      {
        kind: 'note',
        at: at(4100),
        noteNum: 2,
        noteText: 'Spring\nWater is good after rain',
        stoppedS: 360,
      },
      'metric',
      totals,
    );
    expect(t.title).toBe('Spring');
    expect(t.sub).toBe('Note 2 · 4.10 km · “Water is good after rain” · Stopped 6 min');
    const long = timelineEventText(
      { kind: 'note', at: at(10), noteNum: 1, noteText: 'x'.repeat(80) + '\n' + 'y'.repeat(90) },
      'metric',
      totals,
    );
    expect(long.title).toHaveLength(40);
    expect(long.sub).toMatch(/…”$/);
    const empty = timelineEventText(
      { kind: 'note', at: at(10), noteNum: 3, noteText: ' ' },
      'metric',
      totals,
    );
    expect(empty.title).toBe('Note 3');
  });

  it('describes stops, pauses, the steepest stretch and the summit', () => {
    expect(
      timelineEventText({ kind: 'stop', at: at(5000), stoppedS: 1080 }, 'metric', totals).title,
    ).toBe('Stopped 18 min');
    expect(
      timelineEventText({ kind: 'pause', at: at(5000), pausedS: 900 }, 'metric', totals).title,
    ).toBe('Paused 15 min');
    expect(
      timelineEventText(
        { kind: 'steep', at: at(4100), gradePct: 24.4, lengthM: 400 },
        'metric',
        totals,
      ),
    ).toMatchObject({ title: 'Steepest climb', sub: '+24 % over 400 m · 4.10 km' });
    expect(
      timelineEventText(
        { kind: 'steep', at: at(5000), gradePct: -18, lengthM: 300 },
        'metric',
        totals,
      ).title,
    ).toBe('Steepest descent');
    const summit = timelineEventText(
      { kind: 'summit', at: at(6300), highPointM: 885, stoppedS: 1080 },
      'metric',
      totals,
    );
    expect(summit).toMatchObject({ title: 'Summit · 885 m', sub: 'Stopped 18 min · 6.30 km' });
  });

  it('has no clock time on an untimed route', () => {
    const t = timelineEventText({ kind: 'finish', at: at(2000, { time: undefined }) }, 'metric', {
      distanceM: 2000,
      timing: null,
    });
    expect(t).toEqual({ title: 'Finish', sub: '2.00 km', time: null });
  });
});

describe('formatGradePct', () => {
  it('signs and rounds', () => {
    expect(formatGradePct(23.6)).toBe('+24 %');
    expect(formatGradePct(-8.2)).toBe('−8 %');
    expect(formatGradePct(0.3)).toBe('0 %');
    expect(formatGradePct(Number.NaN)).toBe('0 %');
  });
});

describe('trailSubtitle', () => {
  it('reads activity, day and start → end time', () => {
    const s = new Date(2026, 8, 26, 9, 12).getTime();
    const e = new Date(2026, 8, 26, 13, 40).getTime();
    const out = trailSubtitle('Hike', s, e, true);
    expect(out).toMatch(
      /^Hike · .*September.* · 9:12.* → 1:40|^Hike · .*September.* · 9:12.* → 13:40/,
    );
    expect(trailSubtitle(null, s, undefined, true)).toMatch(/9:12/);
  });

  it('calls an untimed trail a route', () => {
    expect(trailSubtitle('Hike', 0, undefined, false)).toBe('Hike · Route');
    expect(trailSubtitle(null, undefined, undefined, true)).toBe('');
  });
});

describe('cursorReadout', () => {
  it('reads distance, elevation and grade, or summit', () => {
    expect(cursorReadout({ distanceM: 2730, elevation: 800 }, 4.2, false, 'metric')).toBe(
      '2.73 km · 800 m · +4 %',
    );
    expect(cursorReadout({ distanceM: 2730, elevation: 800 }, 4.2, true, 'metric')).toBe(
      '2.73 km · 800 m · summit',
    );
    expect(cursorReadout({ distanceM: 50 }, null, false, 'imperial')).toBe('164 ft');
  });
});
