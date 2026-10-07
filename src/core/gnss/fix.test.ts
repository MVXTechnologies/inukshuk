import { asciiToBytes, concatBytes, LeWriter } from './bytes';
import { FixAssembler, UBX_PRIORITY_MS, type GnssFix } from './fix';
import { formatNmea } from './nmea';
import { INITIAL_STATUS, nextStatus, type ExternalStatus } from './quality';
import { GnssDemuxer } from './stream';
import { loadCapture, navPvtFrame, prng, quebecRtkSession, randomChunks } from './testUtils';
import { encodeUbx } from './ubx';

function run(chunks: readonly Uint8Array[], clock = (i: number) => i * 10): GnssFix[] {
  const d = new GnssDemuxer();
  const a = new FixAssembler();
  const out: GnssFix[] = [];
  let i = 0;
  for (const c of chunks) for (const ev of d.push(c)) out.push(...a.push(ev, clock(i++)));
  out.push(...a.flush(clock(i)));
  return out;
}

const nmea = (s: string) => asciiToBytes(formatNmea(s));

describe('NMEA epochs', () => {
  it('assembles GGA + RMC + GST + GSA + VTG into one fix per epoch', () => {
    const fixes = run([
      nmea('GNRMC,120000.00,A,4648.18000,N,07113.02000,W,0.10,45.0,011026,,,R,V'),
      nmea('GNGGA,120000.00,4648.18000,N,07113.02000,W,4,14,0.8,52.123,M,-31.456,M,1.0,0007'),
      nmea('GNGSA,A,3,01,02,03,,,,,,,,,,1.5,0.8,1.2,1'),
      nmea('GNGSA,A,3,65,66,,,,,,,,,,,1.5,0.8,1.2,2'),
      nmea('GPGSV,1,1,03,01,40,083,46,02,17,308,41,03,07,344,39'),
      nmea('GLGSV,1,1,02,65,40,083,46,66,17,308,41'),
      nmea('GNVTG,45.0,T,,M,0.10,N,0.19,K,R'),
      nmea('GNGST,120000.00,0.5,0.015,0.012,0.0,0.014,0.011,0.022'),
      nmea('GNGGA,120001.00,4648.18001,N,07113.02000,W,4,14,0.8,52.124,M,-31.456,M,2.0,0007'),
    ]);
    expect(fixes).toHaveLength(2);
    const f = fixes[0] as GnssFix;
    expect(f).toMatchObject({
      timeMs: Date.UTC(2026, 9, 1, 12, 0, 0),
      kind: 'rtk-fixed',
      hMsl: 52.123,
      geoidSep: -31.456,
      sigmaLat: 0.014,
      sigmaLon: 0.011,
      sigmaV: 0.022,
      hdop: 0.8,
      pdop: 1.5,
      vdop: 1.2,
      satsUsed: 14,
      satsInView: 5,
      correctionAgeS: 1,
      baseId: '0007',
      correctionsInput: null,
      protocol: 'nmea',
      courseDeg: 45,
    });
    expect(f.lat).toBeCloseTo(46.803, 9);
    expect(f.lon).toBeCloseTo(-71.217, 9);
    expect(f.hEll).toBeCloseTo(20.667, 9);
    expect(f.accuracy?.basis).toBe('receiver');
    expect(fixes[1]?.correctionAgeS).toBe(2);
  });

  it('falls back to RMC when there is no GGA, and to GSA for sats and HDOP', () => {
    const [f] = run([
      nmea('GPRMC,120000.00,A,4648.18000,N,07113.02000,W,,,011026,,,A'),
      nmea('GPGSA,A,3,01,02,03,04,,,,,,,,,1.9,1.1,1.5'),
      nmea('GPVTG,90.0,T,,M,1.0,N,1.852,K,A'),
    ]);
    expect(f).toMatchObject({
      kind: 'autonomous',
      hEll: null,
      satsUsed: 4,
      hdop: 1.1,
      speedMps: expect.closeTo(0.5144, 3),
      courseDeg: 90,
    });
    expect(f?.accuracy?.basis).toBe('hdop');
    const [g] = run([nmea('GPRMC,120000.00,V,4648.18000,N,07113.02000,W,,,011026,,,N')]);
    expect(g?.kind).toBe('none');
  });

  it('drops an epoch without a position; no date → null time', () => {
    expect(run([nmea('GNGGA,120000.00,,,,,0,00,99.99,,,,,,')])).toEqual([]);
    const [f] = run([nmea('GNGGA,120000.00,4648.18000,N,07113.02000,W,1,08,1.0,50.0,M,,M,,')]);
    expect(f).toMatchObject({ timeMs: null, hEll: null, geoidSep: null });
  });

  it('ZDA gives the date; a midnight rollover advances it', () => {
    const fixes = run([
      nmea('GPZDA,235959.00,30,09,2026,,'),
      nmea('GPGGA,235959.00,4648.18000,N,07113.02000,W,1,08,1.0,50.0,M,-31.0,M,,'),
      nmea('GPGGA,000000.00,4648.18000,N,07113.02000,W,1,08,1.0,50.0,M,-31.0,M,,'),
    ]);
    expect(fixes.map((f) => f.timeMs)).toEqual([
      Date.UTC(2026, 8, 30, 23, 59, 59),
      Date.UTC(2026, 9, 1, 0, 0, 0),
    ]);
  });

  it('builds the sky view from complete GSV groups per talker', () => {
    const a = new FixAssembler();
    const d = new GnssDemuxer();
    const feed = (s: string) => d.push(nmea(s)).forEach((e) => a.push(e, 0));
    feed('GPGSV,2,1,05,01,40,083,46,02,17,308,41,03,07,344,39,04,10,100,30');
    expect(a.sky).toEqual([]); // group not complete
    feed('GPGSV,2,2,05,05,20,200,35');
    feed('GAGSV,1,1,01,11,50,090,44,7');
    expect(a.sky.map((s) => `${s.system}${s.prn}`)).toEqual([
      'gps1',
      'gps2',
      'gps3',
      'gps4',
      'gps5',
      'galileo11',
    ]);
    expect(a.sky[0]?.used).toBeNull();
    // second page arriving first (no first page): starts an empty list, no throw
    feed('GLGSV,2,2,05,70,20,200,35');
    expect(a.sky.some((s) => s.system === 'glonass')).toBe(true);
  });

  it('an epoch may start with a sentence without time (GSA first); GN GSV is not double-counted', () => {
    const [f] = run([
      nmea('GNGSA,A,3,01,02,,,,,,,,,,,1.5,0.8,1.2'),
      nmea('GPRMC,120000.00,A,4648.18000,N,07113.02000,W,,,,,,A'),
      nmea('GNGSV,1,1,02,01,40,083,46,02,17,308,41'),
      nmea('GPGSV,1,1,02,01,40,083,46,02,17,308,41'),
      nmea('GPGGA,120000.00,4648.18000,N,07113.02000,W,1,02,0.8,50.0,M,-31.0,M,,'),
    ]);
    expect(f).toMatchObject({ pdop: 1.5, satsInView: 2, timeMs: null });
  });

  it('real Trimble capture: DGPS then RTK fixed (gpsd nmea-rtk.log)', () => {
    const fixes = run([loadCapture('gpsd/nmea-rtk.log')]);
    expect(fixes.length).toBeGreaterThan(100);
    const kinds = new Set(fixes.map((f) => f.kind));
    expect(kinds).toEqual(new Set(['dgps', 'rtk-fixed']));
    expect(fixes.every((f) => f.timeMs !== null && f.timeMs >= Date.UTC(2020, 2, 18))).toBe(true);
  });

  it('synthetic Québec RTK session, any chunking: autonomous → float → fixed → stale corrections → float → autonomous', () => {
    const { text, epochs } = quebecRtkSession();
    const bytes = asciiToBytes(text);
    const rnd = prng(42);
    for (let k = 0; k < 10; k++) {
      const fixes = run(randomChunks(bytes, rnd, 64));
      expect(fixes).toHaveLength(epochs.length);
      let st: ExternalStatus = INITIAL_STATUS;
      const states: string[] = [];
      fixes.forEach((f, i) => {
        st = nextStatus(
          st,
          { kind: f.kind, correctionAgeS: f.correctionAgeS, receivedAtMs: i * 1000 },
          i * 1000,
        );
        if (states[states.length - 1] !== st.state) states.push(st.state);
      });
      expect(states).toEqual(['autonomous', 'float', 'fixed', 'float', 'autonomous']);
      expect(fixes[50]?.accuracy?.h95).toBeCloseTo(0.015 * 2.4477, 6);
    }
  });
});

describe('UBX epochs', () => {
  const hp = (iTOW: number, invalid = false) =>
    encodeUbx(
      0x01,
      0x14,
      new LeWriter()
        .u1(0)
        .u1(0)
        .u1(0)
        .u1(invalid ? 1 : 0)
        .u4(iTOW)
        .u4(-712170000 >>> 0)
        .u4(468030000)
        .u4(60000)
        .u4(91500)
        .u1(5)
        .u1(-3 & 0xff)
        .u1(7)
        .u1(0)
        .u4(141)
        .u4(200)
        .bytes(),
    );
  const status = (iTOW: number, diffCorr: boolean) =>
    encodeUbx(
      0x01,
      0x03,
      new LeWriter()
        .u4(iTOW)
        .u1(3)
        .u1(0x0f)
        .u1(diffCorr ? 3 : 0)
        .u1(2 << 6)
        .u4(0)
        .u4(0)
        .bytes(),
    );

  it('merges NAV-PVT + HPPOSLLH + STATUS of one iTOW', () => {
    const fixes = run([
      concatBytes([
        navPvtFrame({ iTOW: 1000, flags: 0x01 | 0x02 | (2 << 6), flags3: 2 << 1, numSV: 28 }),
        hp(1000),
        status(1000, true),
        encodeUbx(0x05, 0x01, Uint8Array.from([6, 0x8a])),
        navPvtFrame({ iTOW: 1200 }),
      ]),
    ]);
    expect(fixes).toHaveLength(2);
    const f = fixes[0] as GnssFix;
    expect(f).toMatchObject({
      kind: 'rtk-fixed',
      protocol: 'ubx',
      satsUsed: 28,
      correctionAgeS: 2,
      correctionsInput: true,
      sigmaLat: 0.0141,
      sigmaV: 0.02,
    });
    expect(f.lat).toBeCloseTo(46.803 - 3e-9, 12);
    expect(f.lon).toBeCloseTo(-71.217 + 5e-9, 12);
    expect(f.hEll).toBeCloseTo(60.0007, 9);
    expect(f.geoidSep).toBeCloseTo(60.0007 - 91.5, 9);
    expect(f.timeMs).toBe(Date.UTC(2026, 9, 1, 12, 0, 0));
    expect(fixes[1]).toMatchObject({
      kind: 'autonomous',
      correctionAgeS: null,
      correctionsInput: null,
      sigmaLat: 1.5,
    });
  });

  it('ignores an invalid HPPOSLLH; drops an epoch with invalid lat/lon; an HP alone makes no fix', () => {
    const [a] = run([concatBytes([navPvtFrame({ iTOW: 1 }), hp(1, true)])]);
    expect(a?.hEll).toBeCloseTo(60, 9);
    expect(run([navPvtFrame({ iTOW: 1, flags3: 1 })])).toEqual([]);
    expect(run([concatBytes([hp(5), status(5, false)])])).toEqual([]);
  });

  it('a new iTOW after an epoch without NAV-PVT makes no fix', () => {
    expect(run([concatBytes([hp(5), navPvtFrame({ iTOW: 6 })])]).map((f) => f.protocol)).toEqual([
      'ubx',
    ]);
  });

  it('NAV-SAT feeds the sky view and satellites in view', () => {
    const sat = new LeWriter().u4(1000).u1(1).u1(2).u2(0);
    sat
      .u1(0)
      .u1(5)
      .u1(40)
      .u1(30)
      .u2(120)
      .u2(0)
      .u4(0x08 | 0x10 | 0x40 | 4);
    sat.u1(6).u1(3).u1(20).u1(10).u2(300).u2(0).u4(0);
    const fixes = run([
      concatBytes([encodeUbx(0x01, 0x35, sat.bytes()), navPvtFrame({ iTOW: 1000 })]),
    ]);
    expect(fixes[0]?.satsInView).toBe(2);
  });

  it('UBX wins over NMEA while NAV-PVT flows, and NMEA comes back after it stops', () => {
    const gga = (t: string) =>
      nmea(`GNGGA,${t},4648.18000,N,07113.02000,W,1,08,1.0,50.0,M,-31.0,M,,`);
    // clock: 10 ms per event; PVT at event 0, NMEA epochs right after are dropped
    const both = run([
      navPvtFrame({ iTOW: 1 }),
      gga('120000.00'),
      gga('120001.00'),
      navPvtFrame({ iTOW: 2 }),
    ]);
    expect(both.map((f) => f.protocol)).toEqual(['ubx', 'ubx']);
    const later = run(
      [navPvtFrame({ iTOW: 1 }), gga('120000.00'), gga('120001.00'), gga('120002.00')],
      (i) => (i === 0 ? 0 : UBX_PRIORITY_MS + i),
    );
    expect(later.map((f) => f.protocol)).toEqual(['ubx', 'nmea', 'nmea', 'nmea']);
  });

  it('pyubx2 NAV capture (BSD-3-Clause): one fix', () => {
    const fixes = run([loadCapture('pyubx2/pygpsdata-NAV.log')]);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({ kind: 'dgps', satsUsed: 26, satsInView: 43, protocol: 'ubx' });
  });

  it('RTCM events produce nothing', () => {
    const a = new FixAssembler();
    expect(
      a.push(
        {
          kind: 'rtcm3',
          frame: { type: 1005, payload: new Uint8Array(0), raw: new Uint8Array(0) },
        },
        0,
      ),
    ).toEqual([]);
    expect(
      a.push({ kind: 'ubx', frame: { cls: 1, id: 99, payload: new Uint8Array(0) }, msg: null }, 0),
    ).toEqual([]);
    expect(a.flush(0)).toEqual([]);
  });
});
