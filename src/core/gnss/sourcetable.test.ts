import { BASELINE_WARN_KM, isRtcm3, parseSourcetable, rankMountpoints } from './sourcetable';
import { loadText } from './testUtils';

const SAPOS = loadText('gpsd/ntrip_sourcetable.log')
  .split('\n')
  .filter((l) => !l.startsWith('#'))
  .join('\n');

describe('parseSourcetable', () => {
  it('reads the real SAPOS sourcetable (CAS, NET, STR)', () => {
    const t = parseSourcetable(SAPOS);
    expect(t.complete).toBe(true);
    expect(t.casters).toHaveLength(15);
    expect(t.networks).toHaveLength(1);
    expect(t.streams).toHaveLength(4);
    // the HTTP-ish header lines before the records count as bad lines, nothing throws
    expect(t.badLines).toBe(6);
    expect(t.casters[0]).toMatchObject({
      host: 'www.sapos.geonord.de',
      port: 2101,
      identifier: 'SAPOS-HH-SH',
      nmea: true,
      country: 'DEU',
      lat: 53.55,
      lon: 10.0,
    });
    expect(t.networks[0]).toMatchObject({
      identifier: 'SAPOS-AdV',
      authentication: 'B',
      fee: true,
      webNet: 'www.sapos.de',
    });
    expect(t.streams[0]).toMatchObject({
      mountpoint: 'VRS_3_2G',
      format: 'RTCM3.1',
      carrier: 2,
      navSystem: 'GPS+GLO',
      lat: 52.48,
      lon: 13.3,
      nmea: true,
      networkSolution: true,
      authentication: 'basic',
      fee: true,
      bitrate: 2000,
    });
    expect(t.streams[0]?.formatDetails).toContain('1021, 1023, 1025');
  });

  it('handles odd values: 0;0 positions, 0–360 longitudes, unknown auth, misc with ";"', () => {
    const t = parseSourcetable(
      [
        'STR;A;id;RTCM 3.2;1005;2;GPS;NET;CAN;0;0;0;0;gen;none;N;N;;',
        'STR;B;id;RTCM 3.2;1005;;GPS;NET;CAN;46.8;288.8;1;0;gen;none;X;N;9600;a;b',
        'STR;;missing-mountpoint;RTCM 3;;;;;;;;;;;;;;',
        'STR;C;id;CMR+;;2;GPS;NET;CAN;95;10;0;0;gen;none;D;N;abc',
        'CAS;caster.example;x;id;op;0;CAN;;;',
        'NET;N;op;N;N;;;;',
        'STR;SHORT;id;RTCM 3.2;;2;GPS;N;CAN;46.8;-71.2',
        'NET;ONLY',
        'STR;TOO;SHORT',
        'garbage',
        '',
        'ENDSOURCETABLE',
        'STR;after-end;;;;;;;;;;;;;;;;;',
      ].join('\r\n'),
    );
    expect(t.streams.map((s) => s.mountpoint)).toEqual(['A', 'B', 'C', 'SHORT']);
    expect(t.streams[3]).toMatchObject({
      lat: 46.8,
      nmea: false,
      authentication: '',
      bitrate: null,
      misc: '',
    });
    expect(t.networks[1]).toMatchObject({ identifier: 'ONLY', fee: false, webReg: '' });
    expect(t.streams[0]).toMatchObject({
      lat: null,
      lon: null,
      nmea: false,
      authentication: 'none',
      bitrate: null,
    });
    expect(t.streams[1]).toMatchObject({
      lon: expect.closeTo(-71.2, 9),
      carrier: null,
      authentication: 'X',
      misc: 'a;b',
    });
    expect(t.streams[2]).toMatchObject({ lat: null, authentication: 'digest', bitrate: null });
    expect(t.casters[0]).toMatchObject({ port: null, lat: null, nmea: false });
    expect(t.networks[0]).toMatchObject({ fee: false });
    expect(t.badLines).toBe(3);
    expect(t.complete).toBe(true);
    expect(parseSourcetable('').complete).toBe(false);
  });
});

describe('rankMountpoints', () => {
  const t = parseSourcetable(
    [
      'STR;FAR;x;RTCM 3.2;;2;GPS;N;CAN;48.0;-71.0;0;0;g;none;B;N;;',
      'STR;NEAR;x;RTCM 3.2;;2;GPS;N;CAN;46.81;-71.22;0;0;g;none;B;N;;',
      'STR;OLD;x;RTCM 2.3;;2;GPS;N;CAN;46.80;-71.21;0;0;g;none;B;N;;',
      'STR;NOPOS2;x;RTCM 3.3;;2;GPS;N;CAN;0;0;1;1;g;none;B;N;;',
      'STR;NOPOS1;x;RTCM 3.3;;2;GPS;N;CAN;0;0;1;1;g;none;B;N;;',
      'STR;TIE;x;RTCM 3.2;;2;GPS;N;CAN;46.81;-71.22;0;0;g;none;B;N;;',
    ].join('\n'),
  );

  it('usable RTCM 3 first, nearest first, positionless last, ties by name', () => {
    const r = rankMountpoints(t.streams, 46.803, -71.217);
    expect(r.map((x) => x.stream.mountpoint)).toEqual([
      'NEAR',
      'TIE',
      'FAR',
      'NOPOS1',
      'NOPOS2',
      'OLD',
    ]);
    expect(r[0]?.distanceKm).toBeCloseTo(0.81, 2);
    expect(r[0]?.usable).toBe(true);
    expect(r[5]?.usable).toBe(false);
    expect(rankMountpoints(t.streams, 46.803, -71.217, 2)).toHaveLength(2);
    expect(isRtcm3(t.streams[2] as never)).toBe(false);
    expect(BASELINE_WARN_KM).toBeGreaterThan(10);
  });

  it('a positioned stream sorts before a positionless one in either order', () => {
    const a = t.streams[3];
    const b = t.streams[1];
    if (!a || !b) throw new Error('fixture');
    expect(rankMountpoints([a, b], 46.8, -71.2).map((x) => x.stream.mountpoint)).toEqual([
      'NEAR',
      'NOPOS2',
    ]);
    expect(rankMountpoints([b, a], 46.8, -71.2).map((x) => x.stream.mountpoint)).toEqual([
      'NEAR',
      'NOPOS2',
    ]);
  });
});
