import {
  constellationOf,
  constellationOfSystemId,
  formatNmea,
  nmeaChecksum,
  parseLatLon,
  parseNmea,
  parseTod,
  type NmeaMessage,
} from './nmea';
import { loadText } from './testUtils';

function ok(line: string): NmeaMessage {
  const r = parseNmea(line);
  if (!r.ok) throw new Error(`rejected (${r.reason}): ${line}`);
  return r.msg;
}

describe('checksum and framing', () => {
  it('computes the XOR checksum and formats a sentence', () => {
    // The textbook GGA example (NMEA 0183 / gpsd docs): *47.
    const body = 'GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,';
    expect(nmeaChecksum(body)).toBe(0x47);
    expect(formatNmea(body)).toBe(`$${body}*47\r\n`);
    expect(formatNmea('X').endsWith('*58\r\n')).toBe(true);
    // checksums below 0x10 are zero-padded: 'A' ^ 'B' = 0x03
    expect(formatNmea('AB')).toBe('$AB*03\r\n');
  });

  it('rejects bad checksums, bad framing and missing checksums', () => {
    const good = '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47';
    expect(parseNmea(good).ok).toBe(true);
    expect(parseNmea(good.replace('*47', '*48'))).toEqual({ ok: false, reason: 'checksum' });
    expect(parseNmea(good.replace('*47', '*4G'))).toEqual({ ok: false, reason: 'format' });
    expect(parseNmea(good.replace('*47', ''))).toEqual({ ok: false, reason: 'no-checksum' });
    expect(parseNmea(good.replace('*47', ''), { requireChecksum: false }).ok).toBe(true);
    expect(parseNmea('GPGGA,1*00')).toEqual({ ok: false, reason: 'format' });
    expect(parseNmea('$GP')).toEqual({ ok: false, reason: 'format' });
    expect(parseNmea(formatNmea('GPGGA,é').replace('é', 'é'))).toEqual({
      ok: false,
      reason: 'format',
    });
    expect(parseNmea(formatNmea('GPGGA,1$2'))).toEqual({ ok: false, reason: 'format' });
    expect(parseNmea(formatNmea('gpgga,1'))).toEqual({ ok: false, reason: 'format' });
  });

  it('tells unsupported sentences apart from bad ones', () => {
    expect(parseNmea(formatNmea('GPGLL,4916.45,N,12311.12,W,225444,A'))).toEqual({
      ok: false,
      reason: 'unsupported',
      sentence: 'GPGLL',
    });
    expect(parseNmea(formatNmea('PUBX,00,1'))).toEqual({
      ok: false,
      reason: 'unsupported',
      sentence: 'PUBX',
    });
    expect(parseNmea(formatNmea('GPGGAX,1'))).toEqual({
      ok: false,
      reason: 'unsupported',
      sentence: 'GPGGAX',
    });
  });
});

describe('field parsers', () => {
  it('parses times of day', () => {
    expect(parseTod('123519')).toBe(12 * 3600 + 35 * 60 + 19);
    expect(parseTod('132819.60')).toBeCloseTo(13 * 3600 + 28 * 60 + 19.6, 9);
    expect(parseTod('235960')).toBe(23 * 3600 + 59 * 60 + 60); // leap second
    expect(parseTod('240000')).toBeNull();
    expect(parseTod('126000')).toBeNull();
    expect(parseTod('12')).toBeNull();
    expect(parseTod(undefined)).toBeNull();
  });

  it('parses ddmm.mmmm coordinates with hemispheres', () => {
    expect(parseLatLon('4134.49795459', 'N', false)).toBeCloseTo(41 + 34.49795459 / 60, 12);
    expect(parseLatLon('09345.03431408', 'W', true)).toBeCloseTo(-(93 + 45.03431408 / 60), 12);
    expect(parseLatLon('4807.038', 'S', false)).toBeCloseTo(-(48 + 7.038 / 60), 12);
    expect(parseLatLon('01131.000', 'e', true)).toBeCloseTo(11 + 31 / 60, 12);
    expect(parseLatLon('4860.000', 'N', false)).toBeNull(); // 60 minutes
    expect(parseLatLon('9100.000', 'N', false)).toBeNull();
    expect(parseLatLon('18100.000', 'E', true)).toBeNull();
    expect(parseLatLon('4807.038', 'E', false)).toBeNull(); // wrong hemisphere letter
    expect(parseLatLon('4807.038', 'N', true)).toBeNull(); // lon needs 3 degree digits
    expect(parseLatLon('', 'N', false)).toBeNull();
    expect(parseLatLon('4807.038', '', false)).toBeNull();
  });

  it('maps talkers and system ids to constellations', () => {
    expect(constellationOf('GP')).toBe('gps');
    expect(constellationOf('GL')).toBe('glonass');
    expect(constellationOf('GA')).toBe('galileo');
    expect(constellationOf('GB')).toBe('beidou');
    expect(constellationOf('BD')).toBe('beidou');
    expect(constellationOf('GQ')).toBe('qzss');
    expect(constellationOf('GI')).toBe('navic');
    expect(constellationOf('GN')).toBe('multi');
    expect(constellationOf('II')).toBe('other');
    expect(constellationOfSystemId(3)).toBe('galileo');
    expect(constellationOfSystemId(9)).toBe('other');
    expect(constellationOfSystemId(null)).toBeNull();
  });
});

describe('sentences', () => {
  it('GGA: RTK fixed, geoid separation, correction age and base id (Trimble capture)', () => {
    const m = ok(
      '$GNGGA,133859.80,4134.50180205,N,09345.03586649,W,4,19,0.7,280.827,M,-31.442,M,5.8,0002*6D',
    );
    expect(m).toMatchObject({
      type: 'GGA',
      talker: 'GN',
      quality: 4,
      satsUsed: 19,
      hdop: 0.7,
      altMsl: 280.827,
      geoidSep: -31.442,
      ageS: 5.8,
      baseId: '0002',
    });
    if (m.type !== 'GGA') throw new Error();
    expect(m.tod).toBeCloseTo(13 * 3600 + 38 * 60 + 59.8, 9);
    expect(m.lat).toBeCloseTo(41 + 34.50180205 / 60, 12);
  });

  it('GGA: empty fields are null, not zero', () => {
    const m = ok(formatNmea('GNGGA,,,,,,0,00,99.99,,,,,,'));
    expect(m).toMatchObject({
      tod: null,
      lat: null,
      lon: null,
      quality: 0,
      hdop: 99.99,
      altMsl: null,
      geoidSep: null,
      ageS: null,
      baseId: null,
    });
    expect(parseNmea(formatNmea('GNGGA,1,2'))).toEqual({ ok: false, reason: 'format' });
    expect(parseNmea(formatNmea('GNGGA,,,,,,x,,,,,,,,'))).toEqual({ ok: false, reason: 'format' });
    expect(parseNmea(formatNmea('GNGGA,,,,,,12,,,,,,,,'))).toEqual({ ok: false, reason: 'format' });
    // a non-decimal number field is null
    expect(ok(formatNmea('GNGGA,,,,,,1,0x1A,1e3,,,,,,'))).toMatchObject({
      satsUsed: null,
      hdop: null,
    });
  });

  it('RMC: date, speed in m/s, mode letter', () => {
    const m = ok(
      '$GNRMC,132819.60,A,4134.49795459,N,09345.03431408,W,0.148,124.888,180320,11.5985,E,D*3F',
    );
    expect(m).toMatchObject({
      type: 'RMC',
      valid: true,
      courseDeg: 124.888,
      date: { y: 2020, m: 3, d: 18 },
      mode: 'D',
    });
    if (m.type !== 'RMC') throw new Error();
    expect(m.speedMps).toBeCloseTo((0.148 * 1852) / 3600, 9);
    const v = ok(formatNmea('GPRMC,,V,,,,,,,,,,N'));
    expect(v).toMatchObject({ valid: false, speedMps: null, date: null, mode: 'N' });
    expect(ok(formatNmea('GPRMC,,V,,,,,,,321399,,'))).toMatchObject({ date: null, mode: null });
    expect(ok(formatNmea('GPRMC,,V,,,,,,,001399,,'))).toMatchObject({ date: null });
    expect(parseNmea(formatNmea('GPRMC,1,2,3'))).toEqual({ ok: false, reason: 'format' });
  });

  it('GSA: PRNs, DOPs and the NMEA 4.10 system id', () => {
    const m = ok('$GNGSA,A,3,21,05,29,25,12,10,26,02,,,,,1.2,0.7,1.0*27');
    expect(m).toMatchObject({
      type: 'GSA',
      fixType: 3,
      prns: [21, 5, 29, 25, 12, 10, 26, 2],
      pdop: 1.2,
      hdop: 0.7,
      vdop: 1.0,
      systemId: null,
    });
    expect(ok(formatNmea('GNGSA,A,3,01,,,,,,,,,,,,1.5,0.9,1.2,3'))).toMatchObject({
      systemId: 3,
      prns: [1],
    });
    expect(parseNmea(formatNmea('GNGSA,A,3'))).toEqual({ ok: false, reason: 'format' });
  });

  it('GSV: satellites, empty SNR, and the signal id variant', () => {
    const m = ok('$GPGSV,3,1,11,03,03,111,00,04,15,270,00,06,01,010,00,13,06,292,00*74');
    expect(m).toMatchObject({ type: 'GSV', total: 3, index: 1, inView: 11, signalId: null });
    if (m.type !== 'GSV') throw new Error();
    expect(m.sats).toHaveLength(4);
    expect(m.sats[0]).toEqual({ prn: 3, elevDeg: 3, azDeg: 111, snr: 0 });
    const s = ok(formatNmea('GAGSV,2,2,04,102,,,40,103,,,29,1'));
    expect(s).toMatchObject({ signalId: '1', inView: 4 });
    if (s.type !== 'GSV') throw new Error();
    expect(s.sats[0]).toEqual({ prn: 102, elevDeg: null, azDeg: null, snr: 40 });
    expect(ok(formatNmea('GAGSV,1,1,00,'))).toMatchObject({ sats: [], signalId: null });
    expect(ok(formatNmea('GAGSV,1,1,01,,10,20,30'))).toMatchObject({ sats: [] });
    expect(parseNmea(formatNmea('GPGSV,1,2,04'))).toEqual({ ok: false, reason: 'format' });
    expect(parseNmea(formatNmea('GPGSV,x,1,04'))).toEqual({ ok: false, reason: 'format' });
  });

  it('GST: per-axis 1σ (Septentrio capture)', () => {
    const m = ok('$GPGST,112257.00,0.387,317.719,3.872,1.791,317.563,10.659,180.746*61');
    expect(m).toMatchObject({
      type: 'GST',
      rms: 0.387,
      semiMajor: 317.719,
      semiMinor: 3.872,
      orientDeg: 1.791,
      sigmaLat: 317.563,
      sigmaLon: 10.659,
      sigmaAlt: 180.746,
    });
    expect(parseNmea(formatNmea('GPGST,1,2'))).toEqual({ ok: false, reason: 'format' });
  });

  it('VTG: km/h preferred, knots fallback, mode', () => {
    const m = ok('$GNVTG,,T,,M,0.117,N,0.216,K,A*3F');
    expect(m).toMatchObject({ type: 'VTG', courseTrue: null, mode: 'A' });
    if (m.type !== 'VTG') throw new Error();
    expect(m.speedMps).toBeCloseTo(0.216 / 3.6, 9);
    const k = ok(formatNmea('GPVTG,054.7,T,034.4,M,005.5,N,,K'));
    if (k.type !== 'VTG') throw new Error();
    expect(k.speedMps).toBeCloseTo((5.5 * 1852) / 3600, 9);
    expect(k.mode).toBeNull();
    expect(ok(formatNmea('GPVTG,,T,,M,,N,,K'))).toMatchObject({ speedMps: null });
    expect(parseNmea(formatNmea('GPVTG,1'))).toEqual({ ok: false, reason: 'format' });
  });

  it('ZDA: four-digit year', () => {
    expect(ok('$GPZDA,112257.00,22,03,2012,,*66')).toMatchObject({
      type: 'ZDA',
      date: { y: 2012, m: 3, d: 22 },
    });
    expect(ok(formatNmea('GPZDA,112257.00,00,03,2012,,'))).toMatchObject({ date: null });
    expect(ok(formatNmea('GPZDA,112257.00,01,13,2012,,'))).toMatchObject({ date: null });
    expect(ok(formatNmea('GPZDA,112257.00,01,12,1970,,'))).toMatchObject({ date: null });
    expect(ok(formatNmea('GPZDA,,,,,,'))).toMatchObject({ tod: null, date: null });
    expect(parseNmea(formatNmea('GPZDA,1'))).toEqual({ ok: false, reason: 'format' });
  });
});

describe('real captures (gpsd regression logs, BSD-2-Clause)', () => {
  function sweep(rel: string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const raw of loadText(rel).split('\n')) {
      if (!raw.startsWith('$')) continue;
      const r = parseNmea(raw);
      const k = r.ok ? `${r.msg.talker}${r.msg.type}` : r.reason;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return counts;
  }

  it('Trimble RTK log: every GGA/RMC parses (GP and GN talkers)', () => {
    expect(sweep('gpsd/nmea-rtk.log')).toEqual({ GNGGA: 50, GNRMC: 50, GPGGA: 72, GPRMC: 72 });
  });

  it('u-blox NEO-M8N log: GLONASS + GPS GSV, GN GSA; GLL is "unsupported", not "bad"', () => {
    expect(sweep('gpsd/neo-m8n.log')).toEqual({
      GLGSV: 69,
      GPGSV: 88,
      GNRMC: 23,
      GNVTG: 23,
      GNGGA: 23,
      GNGSA: 44,
      unsupported: 23,
    });
  });

  it('Septentrio PolarRx2: GST and ZDA', () => {
    const c = sweep('gpsd/polarx2.log');
    expect(c.GPGST).toBe(5);
    expect(c.GPZDA).toBe(5);
    expect(c.GPGSA).toBe(5);
  });

  it('SkyTraq PX1172RH (RTK board): GA/GB GSV and GN ZDA', () => {
    const c = sweep('gpsd/skytraq-PX1172RH_DS.log');
    expect(c.GAGSV).toBe(15);
    expect(c.GBGSV).toBe(9);
    expect(c.GNZDA).toBe(9);
    expect(c.checksum ?? 0).toBe(0);
  });
});
