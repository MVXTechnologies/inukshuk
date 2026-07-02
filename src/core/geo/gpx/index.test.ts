import type { TrackPoint } from '@core/models';

import { buildGpx, parseGpx } from './index';

const pt = (latitude: number, longitude: number, time: number, altitude?: number): TrackPoint => ({
  latitude,
  longitude,
  time,
  altitude,
});

describe('buildGpx / parseGpx round trip', () => {
  it('round-trips points within tolerance', () => {
    const points: TrackPoint[] = [
      pt(45.1234567, -73.7654321, Date.parse('2024-01-01T10:00:00.000Z'), 123.456),
      pt(45.1235, -73.7655, Date.parse('2024-01-01T10:01:00.000Z'), 130.0),
      pt(45.1236, -73.7656, Date.parse('2024-01-01T10:02:00.000Z'), 128.99),
    ];
    const xml = buildGpx({ points });
    const back = parseGpx(xml).points;
    expect(back).toHaveLength(points.length);
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!;
      const b = back[i]!;
      expect(Math.abs(a.latitude - b.latitude)).toBeLessThanOrEqual(1e-7);
      expect(Math.abs(a.longitude - b.longitude)).toBeLessThanOrEqual(1e-7);
      expect(Math.abs((a.altitude ?? 0) - (b.altitude ?? 0))).toBeLessThanOrEqual(0.01);
      expect(b.time).toBe(a.time); // exact ISO round-trip
    }
  });

  it('emits valid version, creator and xmlns', () => {
    const xml = buildGpx({ points: [pt(1, 2, 0)] });
    expect(xml).toContain('version="1.1"');
    expect(xml).toContain('creator="Inukshuk"');
    expect(xml).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
    expect(xml.startsWith('<?xml')).toBe(true);
  });

  it('omits ele when altitude is undefined', () => {
    const xml = buildGpx({ points: [pt(1, 2, Date.parse('2024-01-01T00:00:00Z'))] });
    expect(xml).not.toContain('<ele>');
    expect(xml).toContain('<time>');
  });

  it('omits time when point time is 0/undefined', () => {
    const xml = buildGpx({ points: [pt(1, 2, 0, 50)] });
    expect(xml).not.toContain('<time>');
    expect(xml).toContain('<ele>');
  });

  it('writes metadata', () => {
    const xml = buildGpx({
      points: [pt(1, 2, 0)],
      metadata: {
        name: 'My Hike',
        description: 'A test',
        time: Date.parse('2024-06-01T08:00:00Z'),
      },
    });
    const doc = parseGpx(xml);
    expect(doc.metadata.name).toBe('My Hike');
    expect(doc.metadata.description).toBe('A test');
    expect(doc.metadata.time).toBe(Date.parse('2024-06-01T08:00:00Z'));
    expect(doc.metadata.creator).toBe('Inukshuk');
  });
});

describe('parseGpx hand-written input', () => {
  it('flattens multiple <trk> and <trkseg> segments in order', () => {
    const xml = `<?xml version="1.0"?>
<gpx version="1.1" creator="TestApp" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <trkseg>
      <trkpt lat="45.0" lon="-73.0"><ele>100</ele><time>2024-01-01T00:00:00Z</time></trkpt>
      <trkpt lat="45.1" lon="-73.1"><ele>110</ele><time>2024-01-01T00:01:00Z</time></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="45.2" lon="-73.2"><ele>120</ele></trkpt>
    </trkseg>
  </trk>
  <trk>
    <trkseg>
      <trkpt lat="45.3" lon="-73.3"></trkpt>
    </trkseg>
  </trk>
</gpx>`;
    const doc = parseGpx(xml);
    expect(doc.metadata.creator).toBe('TestApp');
    expect(doc.points).toHaveLength(4);
    expect(doc.points[0]!.latitude).toBe(45.0);
    expect(doc.points[3]!.latitude).toBe(45.3);
    expect(doc.points.map((p) => p.longitude)).toEqual([-73.0, -73.1, -73.2, -73.3]);
  });

  it('tolerates missing ele and time', () => {
    const xml = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <trk><trkseg><trkpt lat="10" lon="20"/></trkseg></trk></gpx>`;
    const doc = parseGpx(xml);
    expect(doc.points).toHaveLength(1);
    expect(doc.points[0]!.altitude).toBeUndefined();
    expect(doc.points[0]!.time).toBe(0);
  });

  it('handles a single trkpt (object, not array)', () => {
    const xml = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <trk><trkseg><trkpt lat="1.5" lon="2.5"><ele>5</ele></trkpt></trkseg></trk></gpx>`;
    const doc = parseGpx(xml);
    expect(doc.points).toHaveLength(1);
    expect(doc.points[0]!.altitude).toBe(5);
  });

  it('falls back to <rtept> when there are no track points', () => {
    const xml = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <rte><rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte></gpx>`;
    const doc = parseGpx(xml);
    expect(doc.points).toHaveLength(2);
    expect(doc.points[1]!.latitude).toBe(3);
  });

  it('falls back to <wpt> when there are no track or route points', () => {
    const xml = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <wpt lat="7" lon="8"><ele>9</ele></wpt></gpx>`;
    const doc = parseGpx(xml);
    expect(doc.points).toHaveLength(1);
    expect(doc.points[0]!.latitude).toBe(7);
    expect(doc.points[0]!.altitude).toBe(9);
  });

  it('reads metadata name/desc/time', () => {
    const xml = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <metadata><name>Trip</name><desc>Nice</desc><time>2024-03-03T12:00:00Z</time></metadata>
      <trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`;
    const doc = parseGpx(xml);
    expect(doc.metadata.name).toBe('Trip');
    expect(doc.metadata.description).toBe('Nice');
    expect(doc.metadata.time).toBe(Date.parse('2024-03-03T12:00:00Z'));
  });

  it('reads a direct <speed> child of trkpt', () => {
    const xml = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <trk><trkseg>
        <trkpt lat="1" lon="2"><speed>3.5</speed></trkpt>
        <trkpt lat="1" lon="2"><speed>-1</speed></trkpt>
        <trkpt lat="1" lon="2"/>
      </trkseg></trk></gpx>`;
    const pts = parseGpx(xml).points;
    expect(pts[0]!.speed).toBe(3.5);
    expect(pts[1]!.speed).toBeUndefined(); // negative speed is dropped
    expect(pts[2]!.speed).toBeUndefined();
  });

  it('reads gpxtpx:speed from a Garmin TrackPointExtension', () => {
    const xml = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <trk><trkseg>
        <trkpt lat="1" lon="2"><extensions>
          <gpxtpx:TrackPointExtension><gpxtpx:speed>2.25</gpxtpx:speed></gpxtpx:TrackPointExtension>
        </extensions></trkpt>
      </trkseg></trk></gpx>`;
    expect(parseGpx(xml).points[0]!.speed).toBe(2.25);
  });

  it('round-trips speed via buildGpx', () => {
    const points: TrackPoint[] = [{ latitude: 1, longitude: 2, time: 0, speed: 4.125 }];
    const back = parseGpx(buildGpx({ points })).points;
    expect(back[0]!.speed).toBe(4.125);
  });
});

describe('parseGpx waypoints', () => {
  it('extracts <wpt> name/desc/sym separately from track points', () => {
    const xml = `<?xml version="1.0"?>
      <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
        <wpt lat="46.81" lon="-71.21"><name>Lookout</name><desc>great view</desc><sym>Summit</sym></wpt>
        <trk><trkseg>
          <trkpt lat="46.80" lon="-71.20"></trkpt>
          <trkpt lat="46.82" lon="-71.22"></trkpt>
        </trkseg></trk>
      </gpx>`;
    const doc = parseGpx(xml);
    expect(doc.points).toHaveLength(2);
    expect(doc.hasTrackOrRoutePoints).toBe(true);
    expect(doc.waypoints).toEqual([
      {
        latitude: 46.81,
        longitude: -71.21,
        name: 'Lookout',
        description: 'great view',
        symbol: 'Summit',
      },
    ]);
  });

  it('reports hasTrackOrRoutePoints=false for a waypoint-only file', () => {
    const xml = `<?xml version="1.0"?>
      <gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
        <wpt lat="46.81" lon="-71.21"><name>Car</name></wpt>
      </gpx>`;
    const doc = parseGpx(xml);
    expect(doc.hasTrackOrRoutePoints).toBe(false);
    expect(doc.waypoints).toHaveLength(1);
  });
});

describe('parseGpx error handling', () => {
  it('throws on empty input', () => {
    expect(() => parseGpx('')).toThrow();
  });

  it('throws on non-GPX XML', () => {
    expect(() => parseGpx('<html><body>hi</body></html>')).toThrow(/gpx/i);
  });

  it('throws on non-XML garbage', () => {
    expect(() => parseGpx('this is not xml at all <<<')).toThrow();
  });
});

describe('parseGpx multiple routes', () => {
  it('keeps the points of every <rte>, not just the first', () => {
    const xml = `<?xml version="1.0"?><gpx version="1.1" creator="t">
      <rte><rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte>
      <rte><rtept lat="5" lon="6"/><rtept lat="7" lon="8"/></rte></gpx>`;
    const back = parseGpx(xml).points;
    expect(back.map((p) => p.latitude)).toEqual([1, 3, 5, 7]);
  });

  it('still ignores routes when track points exist', () => {
    const xml = `<?xml version="1.0"?><gpx version="1.1" creator="t">
      <trk><trkseg><trkpt lat="9" lon="9"/></trkseg></trk>
      <rte><rtept lat="1" lon="2"/></rte></gpx>`;
    const back = parseGpx(xml).points;
    expect(back.map((p) => p.latitude)).toEqual([9]);
  });
});
