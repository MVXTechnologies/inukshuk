import { GnssDemuxer, type StreamEvent } from './stream';
import {
  crc24q,
  decodeDatumCompanion,
  decodeDatumTransform,
  decodeStationArp,
  encodeRtcm3,
  rtcm3Class,
  rtcm3Type,
  stationLatLon,
  type Rtcm3Frame,
} from './rtcm3';
import { loadCapture } from './testUtils';

function frames(rel: string): Rtcm3Frame[] {
  return new GnssDemuxer()
    .push(loadCapture(rel))
    .filter((e): e is Extract<StreamEvent, { kind: 'rtcm3' }> => e.kind === 'rtcm3')
    .map((e) => e.frame);
}

describe('CRC-24Q and framing', () => {
  it('matches the CRC-24Q check value', () => {
    // CRC-24Q ("123456789") = 0xCDE703 (reveng catalogue, CRC-24/LTE-A alias)
    expect(crc24q(Uint8Array.from('123456789', (c) => c.charCodeAt(0)))).toBe(0xcde703);
    expect(crc24q(new Uint8Array(0))).toBe(0);
  });

  it('frames and reads back a payload; refuses an oversized one', () => {
    const f = encodeRtcm3(Uint8Array.from([0x3e, 0xd0, 0x01]));
    expect(f[0]).toBe(0xd3);
    expect(f[2]).toBe(3);
    expect(new GnssDemuxer().push(f)[0]).toMatchObject({ kind: 'rtcm3', frame: { type: 1005 } });
    expect(() => encodeRtcm3(new Uint8Array(1024))).toThrow(RangeError);
    expect(rtcm3Type(new Uint8Array(1))).toBe(0);
  });

  it('classifies message types', () => {
    expect(rtcm3Class(1004)).toBe('observations');
    expect(rtcm3Class(1012)).toBe('observations');
    expect(rtcm3Class(1077)).toBe('msm');
    expect(rtcm3Class(1127)).toBe('msm');
    expect(rtcm3Class(1005)).toBe('station');
    expect(rtcm3Class(1032)).toBe('station');
    expect(rtcm3Class(1033)).toBe('antenna');
    expect(rtcm3Class(1019)).toBe('ephemeris');
    expect(rtcm3Class(1046)).toBe('ephemeris');
    expect(rtcm3Class(1015)).toBe('network');
    expect(rtcm3Class(1030)).toBe('network');
    expect(rtcm3Class(1037)).toBe('network');
    expect(rtcm3Class(1021)).toBe('datum');
    expect(rtcm3Class(1027)).toBe('datum');
    expect(rtcm3Class(1060)).toBe('ssr');
    expect(rtcm3Class(1243)).toBe('ssr');
    expect(rtcm3Class(1029)).toBe('text');
    expect(rtcm3Class(1230)).toBe('biases');
    expect(rtcm3Class(4072)).toBe('proprietary');
    expect(rtcm3Class(63)).toBe('other');
  });
});

describe('station position (gpsd regression logs and their decoded .chk, BSD-2-Clause)', () => {
  it('1005: the RTCM 3.0 standard example (p. 4-3)', () => {
    const f = frames('gpsd/rtcm3.log').find((x) => x.type === 1005);
    const s = f && decodeStationArp(f.payload);
    expect(s).toMatchObject({
      type: 1005,
      stationId: 2003,
      gps: true,
      glonass: false,
      galileo: false,
      referenceStation: false,
      itrfYear: 0,
    });
    expect(s?.x).toBeCloseTo(1114104.5999, 4);
    expect(s?.y).toBeCloseTo(-4850729.7108, 4);
    expect(s?.z).toBeCloseTo(3975521.4643, 4);
    expect(s?.antennaHeight).toBeUndefined();
    const g = s && stationLatLon(s);
    // The standard's example antenna sits near Washington, DC
    expect(g?.lat).toBeCloseTo(38.8, 0);
    expect(g?.lon).toBeCloseTo(-77.07, 1);
  });

  it('1006: ORGN network base (Bend, OR) with antenna height', () => {
    const all = frames('gpsd/rtcm3.bndm.log');
    expect(all.filter((x) => x.type === 1006)).toHaveLength(8);
    const s = decodeStationArp((all.find((x) => x.type === 1006) as Rtcm3Frame).payload);
    expect(s).toMatchObject({
      type: 1006,
      stationId: 278,
      gps: true,
      glonass: true,
      antennaHeight: 0,
    });
    expect(s?.x).toBeCloseTo(-2384764.7077, 4);
    expect(s?.y).toBeCloseTo(-3921089.1738, 4);
    expect(s?.z).toBeCloseTo(4415976.069, 4);
    const g = s && stationLatLon(s);
    expect(g?.lat).toBeCloseTo(44.08, 1); // Bend, OR
    expect(g?.lon).toBeCloseTo(-121.31, 1);
  });

  it('wrong type or truncated payloads decode to null', () => {
    expect(
      stationLatLon({
        type: 1005,
        stationId: 1,
        itrfYear: 0,
        gps: true,
        glonass: false,
        galileo: false,
        referenceStation: false,
        x: NaN,
        y: 0,
        z: 0,
      }),
    ).toBeNull();
    expect(decodeStationArp(Uint8Array.from([0x3f, 0xd0, 0, 0]))).toBeNull(); // 1021
    expect(decodeStationArp(Uint8Array.from([0x3e, 0xd0, 0, 0]))).toBeNull(); // 1005, too short
  });
});

describe('datum messages (BEV Austria capture with 1021 / 1023 / 1025)', () => {
  const all = frames('gpsd/rtcm3_102x135.log');

  it('1021: source / target names, Helmert parameters and ellipsoids, as gpsd decodes them', () => {
    const t = decodeDatumTransform((all.find((x) => x.type === 1021) as Rtcm3Frame).payload);
    expect(t).toMatchObject({
      type: 1021,
      sourceName: '5001',
      targetName: '4001',
      systemId: 9,
      plateNumber: 7,
    });
    if (!t) throw new Error();
    expect(t.area.lat).toBeCloseTo(46.9, 6);
    expect(t.area.lon).toBeCloseTo(13.355556, 6);
    expect(t.area.dLat).toBe(0);
    expect(t.dx).toBeCloseTo(-577.326, 6);
    expect(t.dy).toBeCloseTo(-90.129, 6);
    expect(t.dz).toBeCloseTo(-463.919, 6);
    // gpsd prints rotations in degrees: 0.001427° = 5.137″
    expect(t.rx / 3600).toBeCloseTo(0.001427, 6);
    expect(t.ry / 3600).toBeCloseTo(0.000409, 6);
    expect(t.rz / 3600).toBeCloseTo(0.001471, 6);
    expect(t.ds).toBeCloseTo(-2.4232, 6);
    expect(t.source.a).toBeCloseTo(6378137.0, 3); // GRS80 / WGS 84
    expect(t.source.b).toBeCloseTo(6356752.314, 3);
    expect(t.target.a).toBeCloseTo(6377397.155, 3); // Bessel 1841 (MGI)
    expect(t.target.b).toBeCloseTo(6356078.963, 3);
    expect(t.rotationPoint).toBeUndefined();
  });

  it('1023 and 1025 give the system id that ties them to the 1021', () => {
    expect(decodeDatumCompanion((all.find((x) => x.type === 1023) as Rtcm3Frame).payload)).toEqual({
      type: 1023,
      systemId: 9,
    });
    expect(decodeDatumCompanion((all.find((x) => x.type === 1025) as Rtcm3Frame).payload)).toEqual({
      type: 1025,
      systemId: 9,
      projectionType: 1,
    });
    expect(decodeDatumCompanion(Uint8Array.from([0x3e, 0xd0, 0]))).toBeNull();
    expect(decodeDatumCompanion(Uint8Array.from([0x3f, 0xf0]))).toBeNull(); // 1023, truncated
  });

  it('1022 adds the rotation point; other types and truncation give null', () => {
    // Build a 1022 from the 1021 bits: same fields + 3 × 35-bit rotation point.
    const src = (all.find((x) => x.type === 1021) as Rtcm3Frame).payload;
    const bits: number[] = [];
    for (const b of src) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
    // type field → 1022
    const t = 1022;
    for (let i = 0; i < 12; i++) bits[i] = (t >> (11 - i)) & 1;
    // the Helmert block ends after 12+5+8*4+5+8*4+8+10+5+4+2+19+20+14+14+3*23+3*32+25 bits
    const cut = 12 + 5 + 32 + 5 + 32 + 8 + 10 + 5 + 4 + 2 + 19 + 20 + 14 + 14 + 69 + 96 + 25;
    const rp = [1000, -2000, 3000].flatMap((mm) => {
      const v = mm < 0 ? 2 ** 35 + mm : mm;
      return Array.from({ length: 35 }, (_, i) => Math.floor(v / 2 ** (34 - i)) % 2);
    });
    const all1022 = [...bits.slice(0, cut), ...rp, ...bits.slice(cut)];
    const bytes = new Uint8Array(Math.ceil(all1022.length / 8));
    all1022.forEach((b, i) => {
      bytes[i >> 3] = (bytes[i >> 3] as number) | (b << (7 - (i & 7)));
    });
    const d = decodeDatumTransform(bytes);
    expect(d?.type).toBe(1022);
    expect(d?.rotationPoint).toEqual({ x: 1, y: -2, z: 3 });
    expect(d?.target.a).toBeCloseTo(6377397.155, 3);
    expect(decodeDatumTransform(Uint8Array.from([0x3e, 0xd0]))).toBeNull();
    expect(decodeDatumTransform(src.subarray(0, 20))).toBeNull();
  });

  it('a non-RangeError inside a decoder is not swallowed', () => {
    const evil = new Uint8Array(30);
    evil[0] = 0x3f;
    evil[1] = 0xd0; // 1021
    const spy = jest.spyOn(String, 'fromCharCode').mockImplementation(() => {
      throw new TypeError('boom');
    });
    try {
      // names of length 0 never call fromCharCode; force a 1-char source name
      evil[1] = 0xd0 | 0x00;
      evil[2] = 0x08; // 5-bit counter = 1
      expect(() => decodeDatumTransform(evil)).toThrow(TypeError);
    } finally {
      spy.mockRestore();
    }
  });
});
