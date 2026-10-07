import { asciiToBytes, concatBytes } from './bytes';
import { formatNmea } from './nmea';
import { encodeRtcm3 } from './rtcm3';
import { GnssDemuxer, NMEA_MAX_LINE, type StreamEvent } from './stream';
import {
  corrupt,
  loadCapture,
  navPvtFrame,
  prng,
  quebecRtkSession,
  randomChunks,
} from './testUtils';
import { encodeUbx } from './ubx';

function feedAll(chunks: readonly Uint8Array[]): { ev: StreamEvent[]; d: GnssDemuxer } {
  const d = new GnssDemuxer();
  const ev: StreamEvent[] = [];
  for (const c of chunks) ev.push(...d.push(c));
  return { ev, d };
}

function kinds(ev: readonly StreamEvent[]): string[] {
  return ev.map((e) =>
    e.kind === 'nmea'
      ? `nmea:${e.msg.type}`
      : e.kind === 'ubx'
        ? `ubx:${e.frame.cls}/${e.frame.id}`
        : `rtcm3:${e.frame.type}`,
  );
}

const NMEA = asciiToBytes(quebecRtkSession().text);
const MIXED = loadCapture('pyubx2/pygpsdata-MIXED-RTCM3.log');

describe('GnssDemuxer', () => {
  it('frames a mixed UBX + NMEA + RTCM 3 capture (pyubx2, BSD-3-Clause)', () => {
    const { ev, d } = feedAll([MIXED]);
    expect(kinds(ev)).toEqual(
      expect.arrayContaining([
        'ubx:1/7',
        'rtcm3:1005',
        'rtcm3:1077',
        'rtcm3:1087',
        'rtcm3:1097',
        'rtcm3:1127',
        'rtcm3:1230',
        'rtcm3:4072',
      ]),
    );
    expect(d.stats.ubx).toBe(1);
    expect(d.stats.rtcm3).toBe(7);
    expect(d.stats.ubxBad + d.stats.rtcm3Bad).toBe(0);
    // GNGLL is well-formed but unused
    expect(d.stats.nmeaUnsupported).toBeGreaterThanOrEqual(1);
    expect(d.pending).toBe(0);
  });

  it('gives the same frames whatever the chunking (1-byte, BLE-sized, random)', () => {
    const whole = kinds(feedAll([MIXED]).ev);
    const one = kinds(feedAll(randomChunks(MIXED, () => 0, 1)).ev);
    const ble = kinds(feedAll(randomChunks(MIXED, () => 0.99, 20)).ev);
    expect(one).toEqual(whole);
    expect(ble).toEqual(whole);
    const rnd = prng(7);
    for (let k = 0; k < 50; k++)
      expect(kinds(feedAll(randomChunks(MIXED, rnd, 97)).ev)).toEqual(whole);
  });

  it('keeps a partial frame across pushes and reports it pending', () => {
    const f = navPvtFrame({});
    const d = new GnssDemuxer();
    expect(d.push(f.subarray(0, 1))).toEqual([]);
    expect(d.push(f.subarray(1, 5))).toEqual([]);
    expect(d.push(f.subarray(5, 50))).toEqual([]);
    expect(d.pending).toBe(50);
    const ev = d.push(f.subarray(50));
    expect(ev).toHaveLength(1);
    expect(d.pending).toBe(0);
    // reset() drops a partial frame as garbage
    d.push(f.subarray(0, 10));
    d.reset();
    expect(d.pending).toBe(0);
    expect(d.stats.garbageBytes).toBe(10);
  });

  it('skips garbage between frames and counts it', () => {
    const junk = Uint8Array.from([0x00, 0xff, 0x13, 0x37, 0x0a, 0x0d]);
    const s = concatBytes([
      junk,
      asciiToBytes(formatNmea('GPZDA,120000.00,01,10,2026,,')),
      junk,
      navPvtFrame({}),
      junk,
    ]);
    const { ev, d } = feedAll([s]);
    expect(kinds(ev)).toEqual(['nmea:ZDA', 'ubx:1/7']);
    expect(d.stats.garbageBytes).toBe(18);
    expect(d.stats.bytesIn).toBe(s.length);
  });

  it('resynchronises inside a corrupt frame (a real frame starting mid-garbage is kept)', () => {
    const pvt = navPvtFrame({});
    // A UBX header whose length points past the following real frame, then that frame.
    const fake = Uint8Array.from([0xb5, 0x62, 0x01, 0x07, 0x40, 0x00]);
    const { ev, d } = feedAll([concatBytes([fake, pvt, new Uint8Array(80)])]);
    expect(kinds(ev)).toEqual(['ubx:1/7']);
    expect(d.stats.ubxBad).toBe(1);
  });

  it('rejects bad UBX checksums, impossible lengths and a lone sync byte', () => {
    const pvt = navPvtFrame({});
    const bad = pvt.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff;
    const huge = Uint8Array.from([0xb5, 0x62, 0x01, 0x07, 0xff, 0xff]);
    const lone = Uint8Array.from([0xb5, 0x00, 0xb5]);
    const { ev, d } = feedAll([concatBytes([bad, huge, lone, pvt])]);
    expect(kinds(ev)).toEqual(['ubx:1/7']);
    expect(d.stats.ubxBad).toBe(2);
  });

  it('rejects bad RTCM CRCs and reserved-bit violations', () => {
    const good = encodeRtcm3(Uint8Array.from([0x3e, 0xd0, 0x00, 0x01]));
    const bad = good.slice();
    bad[4] = (bad[4] ?? 0) ^ 0x01;
    const reserved = Uint8Array.from([0xd3, 0x40, 0x00]);
    const { ev, d } = feedAll([concatBytes([bad, reserved, good])]);
    expect(kinds(ev)).toEqual(['rtcm3:1005']);
    expect(d.stats.rtcm3Bad).toBe(1);
  });

  it('handles NMEA truncation, binary inside a line, over-long lines and bad checksums', () => {
    const gga = formatNmea('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,');
    const truncated = '$GPGGA,1235';
    const withBinary = concatBytes([
      asciiToBytes('$GPRMC,12'),
      Uint8Array.from([0x01]),
      asciiToBytes('xx\r\n'),
    ]);
    const tooLong = asciiToBytes(`$${'A'.repeat(NMEA_MAX_LINE + 10)}\r\n`);
    const badCk = asciiToBytes(gga.replace('*47', '*00'));
    const { ev, d } = feedAll([
      asciiToBytes(truncated + gga),
      withBinary,
      tooLong,
      badCk,
      asciiToBytes(gga),
    ]);
    expect(kinds(ev)).toEqual(['nmea:GGA', 'nmea:GGA']);
    expect(d.stats.nmeaBad).toBe(2); // the truncated one + the bad checksum
    expect(d.stats.nmea).toBe(2);
  });

  it('waits for the end of a line, then gives up past the maximum line length', () => {
    const d = new GnssDemuxer();
    expect(d.push(asciiToBytes('$GPGGA,1'))).toEqual([]);
    expect(d.pending).toBe(8);
    d.push(asciiToBytes('A'.repeat(NMEA_MAX_LINE)));
    expect(d.pending).toBe(0);
  });

  it('accepts LF-only line endings', () => {
    const { ev } = feedAll([
      asciiToBytes(formatNmea('GPZDA,120000.00,01,10,2026,,').replace('\r\n', '\n')),
    ]);
    expect(kinds(ev)).toEqual(['nmea:ZDA']);
  });

  it('grows and compacts its buffer for large chunk sequences', () => {
    const big = concatBytes(Array.from({ length: 200 }, () => navPvtFrame({})));
    const { ev } = feedAll(randomChunks(big, prng(3), 5000));
    expect(ev).toHaveLength(200);
    // a frame larger than the initial buffer, split in two pushes
    const nav = encodeUbx(0x01, 0x35, new Uint8Array(8 + 12 * 255));
    const { ev: e2 } = feedAll([nav.subarray(0, 4000), nav.subarray(4000)]);
    expect(e2).toHaveLength(1);
  });
});

describe('fuzz: random chunking + corruption never throws; every emitted frame is valid', () => {
  const sources: [string, Uint8Array][] = [
    ['mixed', MIXED],
    ['nmea', NMEA],
    ['ubx-nav', loadCapture('pyubx2/pygpsdata-NAV.log')],
    ['rtcm', loadCapture('gpsd/rtcm3.bndm.log')],
  ];
  for (const [name, src] of sources) {
    it(name, () => {
      const rnd = prng(name.length * 7919);
      const clean = feedAll([src]).ev.length;
      for (let round = 0; round < 60; round++) {
        const data = corrupt(src, rnd, Math.floor(rnd() * 40));
        let ev: StreamEvent[] = [];
        let d = new GnssDemuxer();
        expect(() => {
          const r = feedAll(randomChunks(data, rnd, 1 + Math.floor(rnd() * 300)));
          ev = r.ev;
          d = r.d;
        }).not.toThrow();
        // corruption only ever removes frames, never invents one
        expect(ev.length).toBeLessThanOrEqual(clean + 2);
        const s = d.stats;
        expect(s.bytesIn).toBe(data.length);
        for (const e of ev) {
          if (e.kind === 'rtcm3') expect(e.frame.raw.length).toBe(e.frame.payload.length + 6);
        }
      }
      // pure noise
      const noise = new Uint8Array(20_000).map(() => Math.floor(rnd() * 256));
      expect(() => feedAll(randomChunks(noise, rnd, 512))).not.toThrow();
    });
  }
});
