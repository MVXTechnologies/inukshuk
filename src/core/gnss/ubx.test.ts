import { LeWriter } from './bytes';
import { GnssDemuxer, type StreamEvent } from './stream';
import { loadCapture, navPvtFrame, navPvtPayload } from './testUtils';
import {
  CFG_NMEA_HIGHPREC,
  CFG_RATE_MEAS,
  cfgValset,
  decodeNavHpposllh,
  decodeNavPvt,
  decodeNavSat,
  decodeNavStatus,
  decodeUbx,
  encodeUbx,
  keySize,
  LAYER,
  minimalKitConfig,
  msgOutKey,
  protKey,
  ubxChecksum,
  type UbxMessage,
} from './ubx';

function ubxMessages(rel: string): UbxMessage[] {
  const d = new GnssDemuxer();
  return d
    .push(loadCapture(rel))
    .filter((e): e is Extract<StreamEvent, { kind: 'ubx' }> => e.kind === 'ubx')
    .map((e) => e.msg)
    .filter((m): m is UbxMessage => m !== null);
}

describe('framing', () => {
  it('reproduces well-known frames byte for byte (Fletcher-8)', () => {
    // UBX-MON-VER poll and UBX-CFG-PRT poll, as printed in every u-blox integration manual.
    expect([...encodeUbx(0x0a, 0x04)]).toEqual([0xb5, 0x62, 0x0a, 0x04, 0x00, 0x00, 0x0e, 0x34]);
    expect([...encodeUbx(0x06, 0x00)]).toEqual([0xb5, 0x62, 0x06, 0x00, 0x00, 0x00, 0x06, 0x18]);
    expect(ubxChecksum(Uint8Array.from([0x0a, 0x04, 0, 0]))).toEqual([0x0e, 0x34]);
  });
});

describe('NAV messages vs pyubx2 (BSD-3-Clause) decoded expectations', () => {
  const nav = ubxMessages('pyubx2/pygpsdata-NAV.log');

  it('NAV-PVT', () => {
    const p = nav.find((m) => m.kind === 'NAV-PVT');
    expect(p).toMatchObject({
      kind: 'NAV-PVT',
      validDate: true,
      validTime: true,
      fullyResolved: true,
      fixType: 3,
      gnssFixOk: true,
      diffSoln: true,
      carrSoln: 0,
      numSV: 26,
      height: 91.184,
      hMSL: 42.701,
      hAcc: 1.491,
      vAcc: 2.065,
      velN: -0.007,
      velE: 0.004,
      velD: 0.009,
      gSpeed: 0.008,
      invalidLlh: false,
      correctionAgeS: null,
    });
    if (p?.kind !== 'NAV-PVT') throw new Error();
    expect(p.lon).toBeCloseTo(-2.2402855, 9);
    expect(p.lat).toBeCloseTo(53.4507228, 9);
    expect(p.pDOP).toBeCloseTo(1.01, 9);
    // 2021-12-04 11:34:59, nano = -361668 ns
    expect(p.utcMs).toBeCloseTo(Date.UTC(2021, 11, 4, 11, 34, 59) - 0.361668, 6);
  });

  it('NAV-SAT', () => {
    const s = nav.find((m) => m.kind === 'NAV-SAT');
    if (s?.kind !== 'NAV-SAT') throw new Error();
    expect(s.svs).toHaveLength(43);
    expect(s.svs[0]).toEqual({
      gnss: 'gps',
      svId: 2,
      cno: 31,
      elevDeg: 18,
      azDeg: 221,
      used: true,
      qualityInd: 7,
      health: 1,
      diffCorr: true,
    });
    expect(s.svs[1]).toMatchObject({ svId: 5, cno: 17, elevDeg: 61, azDeg: 283, qualityInd: 4 });
  });

  it('NAV-STATUS', () => {
    expect(nav.find((m) => m.kind === 'NAV-STATUS')).toEqual({
      kind: 'NAV-STATUS',
      iTOW: expect.any(Number),
      gpsFix: 3,
      gpsFixOk: true,
      diffSoln: true,
      diffCorr: false,
      carrSolnValid: false,
      carrSoln: 0,
      ttff: 23352,
      msss: 10402347,
    });
  });

  it('NAV-HPPOSLLH: standard + high-precision parts', () => {
    const hp = ubxMessages('pyubx2/pygpsdata-NAVHPPOS.log').filter(
      (m) => m.kind === 'NAV-HPPOSLLH',
    );
    expect(hp).toHaveLength(2);
    const a = hp[0];
    if (a?.kind !== 'NAV-HPPOSLLH') throw new Error();
    expect(a.lon).toBeCloseTo(-2.056673696, 9);
    expect(a.lat).toBeCloseTo(53.337816927, 9);
    expect(a.height).toBeCloseTo(281.7858, 7);
    expect(a.hMSL).toBeCloseTo(233.5227, 7);
    expect(a.hAcc).toBeCloseTo(0.335, 7); // pyubx2: hAcc=335.0 mm
    expect(a.vAcc).toBeCloseTo(0.4824, 7);
    expect(a.invalidLlh).toBe(false);
  });
});

describe('NAV-PVT edge cases', () => {
  it('RTK fixed / float, correction age buckets, invalid date', () => {
    const fixed = decodeNavPvt(navPvtPayload({ flags: 0x01 | 0x02 | (2 << 6), flags3: 3 << 1 }));
    expect(fixed).toMatchObject({ carrSoln: 2, diffSoln: true, correctionAgeS: [2, 5] });
    const flt = decodeNavPvt(navPvtPayload({ flags: 0x01 | (1 << 6), flags3: (12 << 1) | 1 }));
    expect(flt).toMatchObject({ carrSoln: 1, correctionAgeS: [120, Infinity], invalidLlh: true });
    expect(decodeNavPvt(navPvtPayload({ flags: 0x01 | (3 << 6) }))?.carrSoln).toBe(0);
    expect(decodeNavPvt(navPvtPayload({ flags3: 15 << 1 }))?.correctionAgeS).toBeNull();
    expect(decodeNavPvt(navPvtPayload({ valid: 0x01 }))?.utcMs).toBeNull();
    expect(decodeNavPvt(navPvtPayload({ fixType: 9 }))).toBeNull();
    expect(decodeNavPvt(new Uint8Array(91))).toBeNull();
  });

  it('short payloads decode to null, never throw', () => {
    expect(decodeNavHpposllh(new Uint8Array(35))).toBeNull();
    expect(decodeNavSat(new Uint8Array(7))).toBeNull();
    const sat = new Uint8Array(8);
    sat[5] = 2; // claims 2 SVs, carries none
    expect(decodeNavSat(sat)).toBeNull();
    expect(decodeNavStatus(new Uint8Array(15))).toBeNull();
    const one = new Uint8Array(20);
    one[5] = 1;
    one[8] = 9; // unknown gnssId
    expect(decodeNavSat(one)?.svs[0]?.gnss).toBe('other');
    const st = new Uint8Array(16);
    st[7] = 3 << 6;
    expect(decodeNavStatus(st)?.carrSoln).toBe(0);
  });

  it('decodeUbx dispatches by class/id and decodes ACKs', () => {
    expect(decodeUbx({ cls: 0x01, id: 0x07, payload: navPvtPayload({}) })?.kind).toBe('NAV-PVT');
    expect(decodeUbx({ cls: 0x01, id: 0x99, payload: new Uint8Array(4) })).toBeNull();
    expect(decodeUbx({ cls: 0x05, id: 0x01, payload: Uint8Array.from([0x06, 0x8a]) })).toEqual({
      kind: 'ACK-ACK',
      cls: 6,
      id: 0x8a,
    });
    expect(decodeUbx({ cls: 0x05, id: 0x00, payload: Uint8Array.from([0x06, 0x8a]) })).toEqual({
      kind: 'ACK-NAK',
      cls: 6,
      id: 0x8a,
    });
    expect(decodeUbx({ cls: 0x05, id: 0x01, payload: new Uint8Array(1) })).toBeNull();
    expect(decodeUbx({ cls: 0x0a, id: 0x04, payload: new Uint8Array(0) })).toBeNull();
    // the helper frame round-trips through the demuxer
    expect(new GnssDemuxer().push(navPvtFrame({ numSV: 31 }))[0]).toMatchObject({
      kind: 'ubx',
      msg: { numSV: 31 },
    });
  });
});

describe('CFG-VALSET', () => {
  it('matches pyubx2 test vector: CFG-UART1-BAUDRATE = 9600 in RAM + BBR', () => {
    const f = cfgValset([[0x40520001, 9600]], LAYER.RAM | LAYER.BBR);
    expect([...f.subarray(6, f.length - 2)]).toEqual([
      0x00, 0x03, 0x00, 0x00, 0x01, 0x00, 0x52, 0x40, 0x80, 0x25, 0x00, 0x00,
    ]);
    expect([...f.subarray(0, 6)]).toEqual([0xb5, 0x62, 0x06, 0x8a, 12, 0]);
  });

  it('encodes every value size from the key id', () => {
    expect(keySize(0x10930006)).toBe(1); // L
    expect(keySize(0x20910007)).toBe(1); // U1
    expect(keySize(0x30210001)).toBe(2); // U2
    expect(keySize(0x40520001)).toBe(4); // U4
    expect(keySize(0x50000001)).toBe(8);
    expect(() => keySize(0x00000001)).toThrow(RangeError);
    const f = cfgValset([
      [0x50000001, 2 ** 40 + 5],
      [0x10930006, true],
      [0x10930007, false],
    ]);
    const p = f.subarray(6, f.length - 2);
    expect([...p.subarray(8, 16)]).toEqual([5, 0, 0, 0, 0, 1, 0, 0]);
    expect(p[20]).toBe(1);
    expect(p[25]).toBe(0);
  });

  it('refuses empty, oversized or invalid configurations', () => {
    expect(() => cfgValset([])).toThrow(RangeError);
    expect(() =>
      cfgValset(Array.from({ length: 65 }, () => [CFG_RATE_MEAS, 100] as const)),
    ).toThrow(RangeError);
    expect(() => cfgValset([[CFG_RATE_MEAS, -1]])).toThrow(RangeError);
    expect(() => cfgValset([[CFG_RATE_MEAS, 1.5]])).toThrow(RangeError);
  });

  it('message-output and protocol keys match the u-blox / pyubx2 configuration database', () => {
    // CFG_MSGOUT_* from pyubx2 ubxtypes_configdb.py
    expect(msgOutKey('UBX_NAV_PVT', 'UART1')).toBe(0x20910007);
    expect(msgOutKey('UBX_NAV_PVT', 'USB')).toBe(0x20910009);
    expect(msgOutKey('UBX_NAV_HPPOSLLH', 'UART2')).toBe(0x20910035);
    expect(msgOutKey('UBX_NAV_SAT', 'SPI')).toBe(0x20910019);
    expect(msgOutKey('UBX_NAV_STATUS', 'I2C')).toBe(0x2091001a);
    expect(msgOutKey('NMEA_GGA', 'UART1')).toBe(0x209100bb);
    expect(msgOutKey('NMEA_GST', 'UART2')).toBe(0x209100d5);
    expect(msgOutKey('NMEA_VTG', 'I2C')).toBe(0x209100b0);
    expect(msgOutKey('NMEA_ZDA', 'USB')).toBe(0x209100db);
    expect(msgOutKey('NMEA_RMC', 'UART1')).toBe(0x209100ac);
    expect(msgOutKey('NMEA_GSA', 'UART1')).toBe(0x209100c0);
    expect(msgOutKey('NMEA_GSV', 'UART1')).toBe(0x209100c5);
    expect(msgOutKey('NMEA_GLL', 'UART1')).toBe(0x209100ca);
    expect(protKey('UART1', 'in', 'RTCM3X')).toBe(0x10730004);
    expect(protKey('UART2', 'out', 'UBX')).toBe(0x10760001);
    expect(protKey('USB', 'out', 'NMEA')).toBe(0x10780002);
    expect(CFG_NMEA_HIGHPREC).toBe(0x10930006);
    expect(CFG_RATE_MEAS).toBe(0x30210001);
  });

  it('builds the minimal DIY-kit setup', () => {
    const [f] = minimalKitConfig({ port: 'UART2', rateHz: 5 });
    if (!f) throw new Error();
    const p = f.subarray(6, f.length - 2);
    expect(p[1]).toBe(LAYER.RAM | LAYER.BBR);
    // walk the key/value list
    const items = new Map<number, number>();
    for (let o = 4; o < p.length;) {
      const key =
        (p[o] as number) |
        ((p[o + 1] as number) << 8) |
        ((p[o + 2] as number) << 16) |
        ((p[o + 3] as number) << 24);
      const k = key >>> 0;
      const n = keySize(k);
      let v = 0;
      for (let i = n - 1; i >= 0; i--) v = v * 256 + (p[o + 4 + i] as number);
      items.set(k, v);
      o += 4 + n;
    }
    expect(items.get(protKey('UART2', 'in', 'RTCM3X'))).toBe(1);
    expect(items.get(CFG_RATE_MEAS)).toBe(200);
    expect(items.get(msgOutKey('UBX_NAV_PVT', 'UART2'))).toBe(1);
    expect(items.get(msgOutKey('UBX_NAV_SAT', 'UART2'))).toBe(5);
    expect(items.get(msgOutKey('NMEA_GGA', 'UART2'))).toBe(1);
    expect(items.get(msgOutKey('NMEA_GSV', 'UART2'))).toBe(0);
    expect(items.get(CFG_NMEA_HIGHPREC)).toBe(1);

    const [g] = minimalKitConfig({
      port: 'USB',
      rateHz: 50,
      nmea: false,
      satEvery: 0,
      layers: LAYER.RAM,
    });
    if (!g) throw new Error();
    expect(g[7]).toBe(LAYER.RAM);
    const [h] = minimalKitConfig({ port: 'UART1' });
    expect(h?.length).toBe(f.length);
    // the rate is clamped to 1..10 Hz
    const w = new LeWriter().u4(CFG_RATE_MEAS).u2(100).bytes();
    expect([...g].join(',')).toContain([...w].join(','));
  });
});
