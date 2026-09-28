import { gzipSync, strToU8, zipSync } from 'fflate';

import { parseGpx } from '@core/geo/gpx';

import {
  ActivityDecodeError,
  activityGpxText,
  decodeActivityFile,
  sniffActivityFormat,
} from './decode';
import { ImportLimitError } from './limits';

import { GPX, T0, TCX, fitBytes } from './testFixtures';

describe('sniffActivityFormat', () => {
  it('classifies by content, not by name', () => {
    expect(sniffActivityFormat(fitBytes(), 'content://123')).toBe('fit');
    expect(sniffActivityFormat(gzipSync(fitBytes()))).toBe('gzip');
    expect(sniffActivityFormat(zipSync({ 'a.fit': fitBytes() }))).toBe('zip');
    expect(sniffActivityFormat(strToU8(TCX), 'x.gpx')).toBe('tcx');
    expect(sniffActivityFormat(strToU8(GPX))).toBe('gpx');
    expect(sniffActivityFormat(strToU8('<ns:gpx xmlns:ns="x">'))).toBe('gpx');
  });

  it('falls back to the extension, else unknown', () => {
    const junk = strToU8('hello');
    expect(sniffActivityFormat(junk, 'a.FIT')).toBe('fit');
    expect(sniffActivityFormat(junk, 'a.tcx')).toBe('tcx');
    expect(sniffActivityFormat(junk, 'a.gz')).toBe('gzip');
    expect(sniffActivityFormat(junk, 'a.zip')).toBe('zip');
    expect(sniffActivityFormat(junk, 'a.jpg')).toBe('unknown');
    expect(sniffActivityFormat(junk)).toBe('unknown');
  });
});

describe('decodeActivityFile', () => {
  it('decodes FIT, and FIT inside gzip', () => {
    const [plain] = decodeActivityFile(fitBytes(1), 'a.fit');
    expect(plain).toMatchObject({ format: 'fit', sport: 'running', startTime: T0 });
    expect(plain!.points).toHaveLength(2);
    const [gz] = decodeActivityFile(gzipSync(fitBytes(1)), 'activities/1.fit.gz');
    expect(gz!.points).toEqual(plain!.points);
    expect(gz!.sourceName).toBe('activities/1.fit.gz');
  });

  it('decodes GPX keeping the original text, name, sport and waypoints', () => {
    const [a] = decodeActivityFile(gzipSync(strToU8(GPX)), '2.gpx.gz');
    expect(a).toMatchObject({ format: 'gpx', name: 'Morning Run', sport: 'running' });
    expect(a!.gpxText).toBe(GPX);
    expect(a!.waypoints).toHaveLength(1);
    expect(a!.hasTrackOrRoutePoints).toBe(true);
    expect(activityGpxText(a!, 'ignored')).toBe(GPX);
  });

  it('maps GPX <type>biking</type> and handles GPX without a type', () => {
    const bike = GPX.replace('running', 'biking');
    expect(decodeActivityFile(strToU8(bike), 'b.gpx')[0]!.sport).toBe('cycling');
    const none = GPX.replace('<type>running</type>', '');
    expect(decodeActivityFile(strToU8(none), 'c.gpx')[0]!.sport).toBeUndefined();
  });

  it('decodes TCX', () => {
    const [a] = decodeActivityFile(strToU8(TCX), '3.tcx');
    expect(a).toMatchObject({ format: 'tcx', sport: 'cycling', startTime: T0 });
  });

  it('serializes FIT/TCX points to GPX that round-trips', () => {
    const [a] = decodeActivityFile(fitBytes(1), 'a.fit');
    const doc = parseGpx(activityGpxText(a!, 'Run 2026-09-12'));
    expect(doc.metadata).toMatchObject({ name: 'Run 2026-09-12', time: T0 });
    expect(doc.points.map((p) => p.time)).toEqual(a!.points.map((p) => p.time));
    const untimed = { ...a!, startTime: undefined };
    expect(parseGpx(activityGpxText(untimed, 'x')).metadata.time).toBeUndefined();
  });

  it('rejects unsupported, empty and oversized inputs', () => {
    expect(() => decodeActivityFile(strToU8('hello'), 'a.txt')).toThrow(ActivityDecodeError);
    expect(() => decodeActivityFile(zipSync({}), 'a.zip')).toThrow(/walked/);
    expect(() => decodeActivityFile(gzipSync(gzipSync(fitBytes())), 'a.gz')).toThrow(/nested/);
    expect(() => decodeActivityFile(strToU8('<gpx><trk></trk></gpx>'), 'a.gpx')).toThrow(
      /No track points/,
    );
    const bomb = gzipSync(new Uint8Array(5000));
    expect(() => decodeActivityFile(bomb, 'a.fit.gz', { maxBytes: 1000 })).toThrow(
      ImportLimitError,
    );
  });
});
