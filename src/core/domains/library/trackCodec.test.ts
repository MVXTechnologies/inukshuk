import { mulberry32 } from '@core/team/testing/prop';

import {
  decodeTrack,
  encodeTrack,
  MAX_TRACK_PARTS,
  MAX_TRACK_POINTS,
  PART_CHARS,
  partId,
  splitParts,
  trackRevision,
  type CodecPoint,
} from './trackCodec';

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** A 1 Hz recorded run as a GPX holds it: 7-decimal coordinates, 2-decimal elevation, ms times. */
function run(n: number, seed = 7): CodecPoint[] {
  const rnd = mulberry32(seed);
  let lat = 46.8139;
  let lon = -71.208;
  let ele = 52.3;
  let t = Date.UTC(2026, 8, 12, 6, 30);
  const out: CodecPoint[] = [];
  for (let i = 0; i < n; i++) {
    lat += (rnd() - 0.3) * 0.00003;
    lon += (rnd() - 0.4) * 0.00004;
    ele += (rnd() - 0.48) * 0.6;
    t += 1000 + Math.floor(rnd() * 3) * 7;
    out.push({
      latitude: round(lat, 7),
      longitude: round(lon, 7),
      altitude: round(ele, 2),
      time: t,
    });
  }
  return out;
}

describe('trackCodec', () => {
  it('round-trips a long recorded run exactly, and measures its size', () => {
    const points = run(20_000);
    const s = encodeTrack({ points, segmentStarts: [7_000, 12_345] })!;
    const back = decodeTrack(s)!;
    expect(back.segmentStarts).toEqual([7_000, 12_345]);
    expect(back.points).toHaveLength(points.length);
    const cols = (ps: readonly CodecPoint[]) =>
      ps.map((p) => `${p.latitude},${p.longitude},${p.altitude},${p.time},${p.hasTime}`);
    expect(cols(back.points)).toEqual(cols(points));
    const perPoint = s.length / points.length;
    // The documented measurement: 8.3 characters per 1 Hz point (this seed).
    expect(perPoint).toBeGreaterThan(7);
    expect(perPoint).toBeLessThan(10);
    const parts = splitParts(s);
    expect(parts.every((p) => p.length <= PART_CHARS)).toBe(true);
    expect(parts.join('')).toBe(s);
    // The cap holds at least a 50-hour 1 Hz recording at this density.
    expect((MAX_TRACK_PARTS * PART_CHARS) / perPoint).toBeGreaterThan(50 * 3600);
  });

  it('keeps missing elevations and times missing', () => {
    const points: CodecPoint[] = [
      { latitude: 46.1, longitude: -71.1, time: 0, hasTime: false },
      { latitude: 46.1000001, longitude: -71.1000001, altitude: -12.5, time: 1_000, hasTime: true },
      { latitude: 46.2, longitude: -71.2, time: 0, hasTime: false },
    ];
    const back = decodeTrack(encodeTrack({ points, segmentStarts: [] })!)!;
    expect(back.points[0]).toEqual({ latitude: 46.1, longitude: -71.1, time: 0, hasTime: false });
    expect(back.points[1]).toEqual({
      latitude: 46.1000001,
      longitude: -71.1000001,
      altitude: -12.5,
      time: 1_000,
    });
    expect(back.points[2]!.altitude).toBeUndefined();
  });

  it('refuses what it cannot carry, and never throws on garbage', () => {
    expect(encodeTrack({ points: [], segmentStarts: [] })).toBeUndefined();
    expect(
      encodeTrack({ points: [{ latitude: 95, longitude: 0, time: 0 }], segmentStarts: [] }),
    ).toBeUndefined();
    expect(
      encodeTrack({
        points: Array.from({ length: MAX_TRACK_POINTS + 1 }, () => ({
          latitude: 0,
          longitude: 0,
          time: 0,
        })),
        segmentStarts: [],
      }),
    ).toBeUndefined();
    const s = encodeTrack({ points: run(50), segmentStarts: [] })!;
    expect(decodeTrack(s.slice(0, -3))).toBeUndefined();
    expect(decodeTrack(`${s}?`)).toBeUndefined();
    expect(decodeTrack('Z' + s.slice(1))).toBeUndefined();
    expect(decodeTrack('')).toBeUndefined();
    const rnd = mulberry32(3);
    for (let k = 0; k < 300; k++) {
      const junk = Array.from({ length: Math.floor(rnd() * 80) }, () =>
        String.fromCharCode(32 + Math.floor(rnd() * 100)),
      ).join('');
      expect(() => decodeTrack(`A${junk}`)).not.toThrow();
    }
  });

  it('names revisions and parts with short ids', () => {
    const r = trackRevision('t1', 'Aabc');
    expect(r).toMatch(/^[a-z0-9]{2,16}$/);
    expect(trackRevision('t1', 'Aabd')).not.toBe(r);
    expect(trackRevision('t2', 'Aabc')).not.toBe(r);
    expect(partId(r, 37)).toBe(`${r}_11`);
  });
});
