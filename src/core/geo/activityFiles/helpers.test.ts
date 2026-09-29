import { DuplicateIndex, isSameActivity } from './dedupe';
import { ByteBudget, ImportLimitError, boundedCollector, gunzipBounded } from './limits';
import {
  activityTrackName,
  baseNameOf,
  categoryForSport,
  localDate,
  sportLabel,
  stravaTypeToSport,
} from './naming';
import { csvFileKey, parseCsv, parseStravaActivitiesCsv } from './stravaCsv';
import { gzipSync } from 'fflate';

const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

describe('dedupe', () => {
  const base = { startedAt: 1_000_000_000_000, distanceM: 10_000 };

  it('matches the same start (±60 s) and distance (±2 %)', () => {
    expect(isSameActivity(base, { startedAt: base.startedAt + 59_000, distanceM: 10_150 })).toBe(
      true,
    );
    expect(isSameActivity(base, { startedAt: base.startedAt - 60_000, distanceM: 9_800 })).toBe(
      true,
    );
    expect(isSameActivity(base, { startedAt: base.startedAt + 61_000, distanceM: 10_000 })).toBe(
      false,
    );
    expect(isSameActivity(base, { startedAt: base.startedAt, distanceM: 10_300 })).toBe(false);
    expect(isSameActivity({ ...base, distanceM: 0 }, { ...base, distanceM: 0 })).toBe(true);
  });

  it('indexes by minute and checks neighbouring buckets', () => {
    const index = new DuplicateIndex([base]);
    expect(index.has({ startedAt: base.startedAt + 45_000, distanceM: 10_010 })).toBe(true);
    expect(index.has({ startedAt: base.startedAt - 45_000, distanceM: 10_010 })).toBe(true);
    expect(index.has({ startedAt: base.startedAt + 3_600_000, distanceM: 10_000 })).toBe(false);
    const later = { startedAt: base.startedAt + 3_600_000, distanceM: 5_000 };
    index.add(later);
    index.add(later); // same bucket twice
    expect(index.has(later)).toBe(true);
    index.add({ startedAt: Number.NaN, distanceM: 1 });
    expect(index.has({ startedAt: Number.NaN, distanceM: 1 })).toBe(false);
  });
});

describe('naming', () => {
  it('maps sports to built-in categories', () => {
    expect(categoryForSport('running')).toBe('run');
    expect(categoryForSport('trail_running')).toBe('trail-run');
    expect(categoryForSport('mountain_biking')).toBe('bike');
    expect(categoryForSport('hiking')).toBe('hike');
    expect(categoryForSport('walking')).toBe('walk');
    expect(categoryForSport('alpine_skiing')).toBe('ski');
    expect(categoryForSport('snowshoeing')).toBe('snowshoe');
    expect(categoryForSport('swimming')).toBeUndefined();
    expect(categoryForSport(undefined)).toBeUndefined();
  });

  it('normalizes Strava activity types', () => {
    expect(stravaTypeToSport('Trail Run')).toBe('trail_running');
    expect(stravaTypeToSport(' Ride ')).toBe('cycling');
    expect(stravaTypeToSport('Snowshoe')).toBe('snowshoeing');
    expect(stravaTypeToSport('Stand Up Paddling')).toBe('stand_up_paddling');
    expect(stravaTypeToSport('Roller-Ski')).toBe('roller_ski');
  });

  it('names tracks: explicit, then "<Sport> <date>", then the file', () => {
    const t = noon(2026, 9, 12);
    expect(localDate(t)).toBe('2026-09-12');
    expect(activityTrackName({ name: '  Lunch Run ', sport: 'running', startTime: t })).toBe(
      'Lunch Run',
    );
    expect(activityTrackName({ sport: 'running', startTime: t })).toBe('Run 2026-09-12');
    expect(activityTrackName({ sport: 'cycling', fileName: 'activities/99.fit.gz' })).toBe('99');
    expect(activityTrackName({ sport: 'sport_99', startTime: t, fileName: 'x/Morning.tcx' })).toBe(
      'Morning',
    );
    expect(activityTrackName({ sport: 'hiking' })).toBe('Hike');
    expect(activityTrackName({})).toBe('Imported activity');
    expect(baseNameOf('a\\b\\c.gpx')).toBe('c');
    expect(baseNameOf('d.gz')).toBe('d');
    expect(sportLabel(undefined)).toBeUndefined();
  });
});

describe('Strava activities.csv', () => {
  it('parses RFC 4180 quoting, BOM and CRLF', () => {
    expect(parseCsv('﻿a,"b,c","d ""q"""\r\n"multi\nline",x')).toEqual([
      ['a', 'b,c', 'd "q"'],
      ['multi\nline', 'x'],
    ]);
    expect(parseCsv('a,b\n')).toEqual([['a', 'b']]);
  });

  it('maps filenames to names and types', () => {
    const csv = [
      'Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Filename,Elapsed Time',
      '1,"Sep 12, 2026",Lunch Run,Run,"great, fast",1800,activities/1.fit.gz,1800',
      '2,"Sep 13, 2026",,Hike,,3600,activities/2.GPX,3600',
      '3,"Sep 14, 2026",Manual,Run,,100,,100',
    ].join('\n');
    const map = parseStravaActivitiesCsv(csv);
    expect(map.get('1.fit.gz')).toEqual({ name: 'Lunch Run', type: 'Run' });
    expect(map.get('2.gpx')).toEqual({ type: 'Hike' });
    expect(map.size).toBe(2);
    expect(csvFileKey('activities/ABC.FIT')).toBe('abc.fit');
  });

  it('returns an empty map without a Filename column or rows', () => {
    expect(parseStravaActivitiesCsv('').size).toBe(0);
    expect(parseStravaActivitiesCsv('Activity Name\nx').size).toBe(0);
    expect(parseStravaActivitiesCsv('Filename\na.fit').get('a.fit')).toEqual({});
  });
});

describe('limits', () => {
  it('caps collected bytes and the running budget', () => {
    const budget = new ByteBudget(10);
    const c = boundedCollector(8, budget);
    c.push(new Uint8Array([1, 2, 3]));
    c.push(new Uint8Array([4]));
    expect([...c.result()]).toEqual([1, 2, 3, 4]);
    expect(() => c.push(new Uint8Array(5))).toThrow(ImportLimitError);
    expect(() => budget.take(7)).toThrow(ImportLimitError);
    expect(budget.exhausted).toBe(true);
  });

  it('gunzips within bounds', () => {
    const data = new Uint8Array(100).fill(7);
    expect(gunzipBounded(gzipSync(data), 100)).toEqual(data);
    expect(() => gunzipBounded(gzipSync(data), 99)).toThrow(ImportLimitError);
  });
});
