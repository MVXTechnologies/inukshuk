import { TcxParseError, looksLikeTcx, parseTcx } from './index';

const tp = (time: string, lat?: number, lon?: number, extra = ''): string => `
  <Trackpoint>
    <Time>${time}</Time>
    ${lat === undefined ? '' : `<Position><LatitudeDegrees>${lat}</LatitudeDegrees><LongitudeDegrees>${lon}</LongitudeDegrees></Position>`}
    ${extra}
  </Trackpoint>`;

const ACTIVITY = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="Running">
      <Id>2026-09-12T13:00:00Z</Id>
      <Lap StartTime="2026-09-12T13:00:00Z">
        <Track>
          ${tp(
            '2026-09-12T13:00:00Z',
            46.8139,
            -71.208,
            `<AltitudeMeters>100.5</AltitudeMeters><HeartRateBpm><Value>121</Value></HeartRateBpm>
             <Extensions><ns3:TPX><ns3:Speed>2.75</ns3:Speed></ns3:TPX></Extensions>`,
          )}
          ${tp('2026-09-12T13:00:05Z')}
          ${tp('2026-09-12T13:00:10Z', 46.8141, -71.2078, '<AltitudeMeters>101</AltitudeMeters>')}
        </Track>
        <Track>
          ${tp('2026-09-12T13:05:00Z', 46.8143, -71.2076)}
        </Track>
      </Lap>
      <Lap StartTime="2026-09-12T13:10:00Z">
        <Track>
          ${tp('2026-09-12T13:10:00Z', 46.8145, -71.2074)}
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

describe('parseTcx', () => {
  it('reads positioned trackpoints across laps and tracks', () => {
    expect(looksLikeTcx(ACTIVITY)).toBe(true);
    const [act, ...rest] = parseTcx(ACTIVITY);
    expect(rest).toHaveLength(0);
    expect(act!.sport).toBe('running');
    expect(act!.startTime).toBe(Date.UTC(2026, 8, 12, 13, 0, 0));
    // The position-less sample is skipped.
    expect(act!.points).toHaveLength(4);
    expect(act!.points[0]).toMatchObject({
      latitude: 46.8139,
      longitude: -71.208,
      altitude: 100.5,
      heartRateBpm: 121,
      speed: 2.75,
      hasTime: true,
      time: Date.UTC(2026, 8, 12, 13, 0, 0),
    });
    expect(act!.points[1]!.altitude).toBe(101);
    expect(act!.points[1]!.heartRateBpm).toBeUndefined();
    // A second Track inside a Lap is a pause; a new Lap is not.
    expect(act!.segmentStarts).toEqual([2]);
  });

  it('maps Biking to cycling and keeps unknown sports lowercased', () => {
    const xml = (sport: string) =>
      `<TrainingCenterDatabase><Activities><Activity Sport="${sport}"><Id>x</Id><Lap><Track>${tp(
        'bad-time',
        45,
        -73,
      )}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    const [bike] = parseTcx(xml('Biking'));
    expect(bike!.sport).toBe('cycling');
    expect(bike!.startTime).toBeUndefined();
    expect(bike!.points[0]).toMatchObject({ time: 0, hasTime: false });
    expect(parseTcx(xml('Swim'))[0]!.sport).toBe('swim');
  });

  it('reads named courses and drops empty activities', () => {
    const xml = `<TrainingCenterDatabase>
      <Activities><Activity Sport="Other"><Lap><Track>${tp('2026-01-01T00:00:00Z')}</Track></Lap></Activity></Activities>
      <Courses><Course><Name> Loop </Name><Track>${tp('', 45, -73)}${tp('', 45.001, -73)}</Track></Course>
      <Course><Name>Empty</Name></Course></Courses>
    </TrainingCenterDatabase>`;
    const acts = parseTcx(xml);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.name).toBe('Loop');
    expect(acts[0]!.points).toHaveLength(2);
  });

  it('skips out-of-range coordinates', () => {
    const xml = `<TrainingCenterDatabase><Activities><Activity Sport="Running"><Lap><Track>
      ${tp('2026-01-01T00:00:00Z', 95, -73)}${tp('2026-01-01T00:00:01Z', 45, -73)}
    </Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    expect(parseTcx(xml)[0]!.points).toHaveLength(1);
  });

  it('throws a typed error for non-TCX input', () => {
    expect(looksLikeTcx('<gpx></gpx>')).toBe(false);
    expect(() => parseTcx('<gpx></gpx>')).toThrow(TcxParseError);
    expect(() => parseTcx('<a><b></a>')).toThrow(TcxParseError);
  });
});
