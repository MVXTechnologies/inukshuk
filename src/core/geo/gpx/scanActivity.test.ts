import { buildGpx, parseGpx } from './index';
import { scanGpxActivity } from './scanActivity';

const GARMIN = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Garmin Connect" xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
  xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk><name>Morning Run</name>
    <trkseg>
      <trkpt lat="46.81" lon="-71.21">
        <ele>12.4</ele>
        <time>2026-09-20T11:00:00Z</time>
        <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>121</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>
      </trkpt>
      <trkpt lat='46.8101' lon='-71.2101'><ele> 13 </ele><time>2026-09-20T11:00:01Z</time>
        <extensions><ns3:TrackPointExtension><ns3:HR>125</ns3:HR></ns3:TrackPointExtension></extensions></trkpt>
      <trkpt lat="999" lon="0"><time>2026-09-20T11:00:02Z</time></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="46.8102" lon="-71.2102"><time>2026-09-20T11:05:00Z</time><extensions><heartrate>0</heartrate></extensions></trkpt>
      <trkpt lat="46.8103" lon="-71.2103"/>
      <trkptx lat="1" lon="1"></trkptx>
    </trkseg>
  </trk>
</gpx>`;

describe('scanGpxActivity', () => {
  it('reads positions, elevation, time and heart rate like parseGpx', () => {
    const scanned = scanGpxActivity(GARMIN);
    const parsed = parseGpx(GARMIN);
    expect(scanned).not.toBeNull();
    expect(scanned!.segmentStarts).toEqual(parsed.segmentStarts);
    expect(scanned!.points).toEqual(parsed.points);
    expect(scanned!.points[0]).toMatchObject({ altitude: 12.4, heartRateBpm: 121, hasTime: true });
    expect(scanned!.points[1]).toMatchObject({ altitude: 13, heartRateBpm: 125 });
    expect(scanned!.points[3]).toEqual({
      latitude: 46.8103,
      longitude: -71.2103,
      time: 0,
      hasTime: false,
    });
  });

  it('round-trips what the app writes', () => {
    const xml = buildGpx({
      points: [
        { latitude: 1, longitude: 2, altitude: 3, time: Date.UTC(2026, 0, 1), heartRateBpm: 140 },
        { latitude: 1.001, longitude: 2, time: Date.UTC(2026, 0, 1, 0, 0, 1) },
      ],
      metadata: { name: 'x' },
    });
    expect(scanGpxActivity(xml)?.points).toEqual(parseGpx(xml).points);
  });

  it('returns null for what it cannot read as a plain track', () => {
    expect(scanGpxActivity('<gpx><rte><rtept lat="1" lon="2"/></rte></gpx>')).toBeNull();
    expect(scanGpxActivity('<gpx><trk><trkseg><trkpt lat="1" lon="2"><ele>1</ele>')).toBeNull();
  });
});
