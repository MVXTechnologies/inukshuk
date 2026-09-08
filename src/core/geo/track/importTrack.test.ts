import type { TrackPoint } from '@core/models';
import { buildGpx, parseGpx } from '../gpx';
import { computeTrackStats, haversineMeters } from './index';
import { buildImportedTrack } from './importTrack';

const pt = (latitude: number, longitude: number, time: number, altitude?: number): TrackPoint => ({
  latitude,
  longitude,
  time,
  altitude,
});

describe('buildImportedTrack', () => {
  it('derives start/end from point timestamps and computes stats', () => {
    const points = [pt(45.0, -73.0, 1000), pt(45.001, -73.0, 2000), pt(45.002, -73.0, 3000)];
    const t = buildImportedTrack({
      id: 'abc',
      points,
      name: 'Morning loop',
      fallbackName: 'file',
      fallbackTime: 9999,
    });
    expect(t.id).toBe('abc');
    expect(t.name).toBe('Morning loop');
    expect(t.status).toBe('finished');
    expect(t.startedAt).toBe(1000);
    expect(t.endedAt).toBe(3000);
    expect(t.points).toHaveLength(3);
    expect(t.stats.distanceM).toBeGreaterThan(0);
    expect(t.stats.pointCount).toBe(3);
  });

  it('falls back to the file name when GPX has no/blank name', () => {
    const t = buildImportedTrack({
      id: 'x',
      points: [pt(0, 0, 100)],
      name: '   ',
      fallbackName: 'hike-2026',
      fallbackTime: 42,
    });
    expect(t.name).toBe('hike-2026');
  });

  it('uses fallbackTime when the GPX carries no timestamps', () => {
    const t = buildImportedTrack({
      id: 'x',
      points: [pt(45, -73, 0), pt(45.001, -73, 0)],
      fallbackName: 'trail',
      fallbackTime: 1750000000000,
    });
    expect(t.startedAt).toBe(1750000000000);
    expect(t.endedAt).toBeUndefined();
  });
});

describe('imported GPX timing', () => {
  const load = (times: (string | undefined)[]) =>
    parseGpx(
      `<gpx><trk><trkseg>${times
        .map(
          (time, i) =>
            `<trkpt lat="${45 + i / 1000}" lon="-73">${time === undefined ? '' : `<time>${time}</time>`}</trkpt>`,
        )
        .join('')}</trkseg></trk></gpx>`,
    ).points;
  const importPoints = (points: TrackPoint[]) =>
    buildImportedTrack({ id: 'mixed', points, fallbackName: 'mixed', fallbackTime: 9999 });

  it.each([false, true])(
    'keeps untimed geometry without distorting timing (untimed end: %s)',
    (untimedEnd) => {
      const points = load([
        undefined,
        '2024-01-01T00:00:00Z',
        '2024-01-01T00:01:00Z',
        ...(untimedEnd ? [undefined] : []),
      ]);
      const track = importPoints(points);
      expect(track.points).toEqual(points);
      expect(track.stats.pointCount).toBe(points.length);
      expect(track.stats.durationS).toBe(60);
      expect(track.stats.movingTimeS).toBe(60);
      const timedDistance = haversineMeters(points[1]!, points[2]!);
      expect(track.stats.distanceM).toBeGreaterThan(timedDistance * (points.length - 1.1));
      expect(track.stats.avgSpeedMps).toBeCloseTo(timedDistance / 60);
      expect(computeTrackStats(parseGpx(buildGpx({ points })).points)).toEqual(track.stats);
    },
  );

  it('does not invent travel time across an untimed interior fix', () => {
    const points = load(['2024-01-01T00:00:00Z', undefined, '2024-01-01T00:01:00Z']);
    const stats = computeTrackStats(points);
    expect(stats.durationS).toBe(60);
    expect(stats.distanceM).toBeGreaterThan(200);
    expect(stats.movingTimeS).toBe(0);
    expect(stats.avgSpeedMps).toBe(0);
    expect(stats.maxSpeedMps).toBe(0);
  });

  it('preserves explicit epoch zero through import and GPX round trips', () => {
    const points = load(['1970-01-01T00:00:00Z', '1970-01-01T00:01:00Z']);
    const track = importPoints(points);
    expect(track.startedAt).toBe(0);
    expect(track.stats.durationS).toBe(60);
    const loadedAgain = parseGpx(buildGpx({ points })).points;
    expect(importPoints(loadedAgain).startedAt).toBe(0);
    expect(computeTrackStats(loadedAgain)).toEqual(track.stats);
  });
});
