import { buildGpx, parseGpx } from './index';
import { scanGpxTrack } from './scan';

const positions = (xml: string) => {
  const doc = parseGpx(xml);
  return {
    points: doc.points.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
    segmentStarts: doc.segmentStarts,
  };
};

const gpx = (body: string) =>
  `<?xml version="1.0"?><gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;

describe('scanGpxTrack', () => {
  it('matches parseGpx on a written multi-segment recording', () => {
    const points = Array.from({ length: 50 }, (_, i) => ({
      latitude: 46.8 + i * 1e-4,
      longitude: -71.2 - i * 1e-4,
      altitude: 50 + i,
      time: 1_700_000_000_000 + i * 1000,
    }));
    const xml = buildGpx({ points, segmentStarts: [20, 35], metadata: { name: 'Run' } });
    expect(scanGpxTrack(xml)).toEqual(positions(xml));
  });

  it('matches parseGpx on hand-written variants', () => {
    const xml = gpx(`
      <metadata><name>trk trkpt trkseg</name></metadata>
      <trk><name>A</name>
        <trkseg/>
        <trkseg>
          <trkpt lon='-71.1' lat='46.1'><ele>3</ele></trkpt>
          <trkpt lat="46.2"   lon="-71.2"/>
          <trkpt lat="" lon="-71.3"></trkpt>
          <trkpt lat="95" lon="-71.3"></trkpt>
          <trkpt
            lat="46.3" lon="-71.3"><extensions><gpxtpx:hr>120</gpxtpx:hr></extensions></trkpt>
        </trkseg>
        <trkseg></trkseg>
        <trkseg><trkpt lat="bad" lon="1"/></trkseg>
      </trk>
      <trk><trkseg><trkpt lat="46.4" lon="-71.4"/></trkseg></trk>`);
    const scanned = scanGpxTrack(xml);
    expect(scanned).toEqual(positions(xml));
    expect(scanned?.points).toHaveLength(4);
    expect(scanned?.segmentStarts).toEqual([3]);
  });

  it('defers routes, waypoint-only files and empty tracks to parseGpx', () => {
    expect(scanGpxTrack(gpx('<rte><rtept lat="1" lon="2"/></rte>'))).toBeNull();
    expect(scanGpxTrack(gpx('<wpt lat="1" lon="2"><name>x</name></wpt>'))).toBeNull();
    expect(scanGpxTrack(gpx('<trk><trkseg></trkseg></trk>'))).toBeNull();
    expect(scanGpxTrack(gpx('<trk><trkseg><trkpt lat="x" lon="y"/></trkseg></trk>'))).toBeNull();
    expect(scanGpxTrack('')).toBeNull();
  });

  it('stops cleanly on a truncated file', () => {
    const xml = gpx('<trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"').slice(0, -6);
    expect(scanGpxTrack(xml)?.points).toEqual([{ latitude: 1, longitude: 2 }]);
  });
});
